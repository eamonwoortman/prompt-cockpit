// The notifications bell. Two entry kinds, both DERIVED server-side from live
// state (src/autopilot.js's notifications()): a pilot run blocked on a
// question a human has to answer, and a pilot auto-disabled after repeated
// failures. Nothing is stored and nothing is marked read - an entry vanishes
// when the state it was computed from is gone.
//
// A POLL, not a socket: each tab's WebSocket is scoped to the one session it
// is attached to, and a pilot's session is by definition one it is NOT
// attached to. Same 10s cadence as the "All sessions" pane
// (public/session-list-pane.js:211-218).
const POLL_MS = 10_000;

export function initNotificationsPanel({ button, panel, headerEl, onOpenPilots }) {
  let open = false;
  let entries = [];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Opens a NEW tab attached to a pilot's running session. The token stays out
  // of the URL: `?session=<id>&token=<t>` would put a credential somewhere it
  // gets logged and referred (the leak backlog.md:27 flags for /ws). Instead
  // the new tab fetches the token from GET /api/sessions/:id/attach-token.
  //
  // Safe for auth because the OPERATOR token lives in localStorage, not
  // sessionStorage (public/operator-auth.js:6,13,25) - so the new tab clearing
  // its inherited sessionStorage copy does not de-authenticate it.
  function attach(sessionId) {
    window.open(`/?attach=${encodeURIComponent(sessionId)}`, '_blank');
  }

  function render() {
    panel.textContent = '';
    if (!entries.length) {
      panel.append(el('div', 'notification-row notification-hint', 'Nothing needs your attention.'));
      return;
    }
    for (const entry of entries) {
      const row = el('div', 'notification-row');
      row.append(el('div', 'notification-message', entry.message));
      if (entry.kind === 'needs-input') {
        row.classList.add('clickable');
        row.append(el('div', 'notification-hint', 'Click to open this session in a new tab and answer it.'));
        row.addEventListener('click', () => {
          attach(entry.sessionId);
          closePanel();
        });
      } else if (entry.kind === 'auto-disabled') {
        row.classList.add('clickable');
        row.append(el('div', 'notification-hint', 'Click to open the auto-pilot panel and re-enable it.'));
        row.addEventListener('click', () => {
          onOpenPilots?.();
          closePanel();
        });
      }
      panel.append(row);
    }
  }

  function applyBadge() {
    button.hidden = entries.length === 0;
    button.classList.toggle('has-entries', entries.length > 0);
    button.textContent = entries.length ? `🔔 ${entries.length}` : '🔔';
    button.title = entries.length
      ? `${entries.length} auto-pilot item${entries.length === 1 ? '' : 's'} needs your attention`
      : 'Auto-pilot notifications';
  }

  async function refresh() {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      entries = (await res.json()).entries || [];
    } catch {
      return; // best-effort; keep showing the last-known list
    }
    applyBadge();
    if (open) render();
  }

  function openPanel() {
    open = true;
    panel.style.top = `${headerEl.getBoundingClientRect().bottom + 4}px`;
    panel.hidden = false;
    render();
    refresh();
  }

  function closePanel() {
    open = false;
    panel.hidden = true;
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (open) closePanel();
    else openPanel();
  });
  document.addEventListener('click', (event) => {
    if (open && !panel.contains(event.target) && event.target !== button) closePanel();
  });
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') closePanel();
  });

  refresh();
  setInterval(refresh, POLL_MS);

  return { refresh };
}
