// The notifications bell. Every entry is DERIVED server-side from live state
// (GET /api/notifications merges src/autopilot.js's notifications() with
// src/superagent/notifications.js's): a pilot run blocked on a question a
// human has to answer, a pilot auto-disabled after repeated failures, and a
// superagent job that needs you (question, ready to try, stuck). Nothing is
// stored and nothing is marked read - an entry vanishes when the state it was
// computed from is gone.
//
// A POLL, not a socket: each tab's WebSocket is scoped to the one session it
// is attached to, and a pilot's session is by definition one it is NOT
// attached to. Same 10s cadence as the "All sessions" pane
// (public/session-list-pane.js:211-218).
import { claimNotifications } from '/notify-dedupe.js';

const POLL_MS = 10_000;
const SUPERAGENT_TAB = 'cockpit-superagent';

// One named tab for the Superagent view: a second click, or a browser
// notification, re-targets that tab instead of stacking new ones.
export function openSuperagentView(jobId) {
  const url = jobId ? `/?view=superagent&job=${encodeURIComponent(jobId)}` : '/?view=superagent';
  window.open(url, SUPERAGENT_TAB);
}

// Called from the Superagent view's own control, on a click; the poll below
// never asks, it only shows once permission is granted.
export async function requestBrowserNotifications() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

// Every open tab polls, so which tab shows a given entry is decided by
// claimNotifications (src/notify-dedupe.js) under a Web Lock; `tag` makes a
// duplicate replace rather than stack if the lock is unavailable.
async function showBrowserNotifications(superagentEntries, firstPoll) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  let fresh;
  try {
    fresh = await claimNotifications({ entries: superagentEntries, firstPoll, storage: localStorage, locks: navigator.locks });
  } catch {
    return;
  }
  for (const entry of fresh) {
    try {
      const notification = new Notification(entry.message, { tag: entry.key });
      notification.onclick = () => {
        openSuperagentView(entry.jobId);
        notification.close();
      };
    } catch {
      // Some browsers (Android Chrome) refuse the constructor outright.
    }
  }
}

export function initNotificationsPanel({ button, panel, headerEl, onOpenPilots, superagentButton }) {
  let open = false;
  let entries = [];
  let polled = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const superagentBadge = superagentButton ? superagentButton.appendChild(el('span', 'superagent-badge')) : null;
  if (superagentBadge) superagentBadge.hidden = true;

  // Opens a NEW tab attached to a pilot's running session. The token stays out
  // of the URL: `?session=<id>&token=<t>` would put a credential somewhere it
  // gets logged and referred (the leak backlog.md:53 flags for /ws). Instead
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
      } else if (entry.kind === 'superagent') {
        row.classList.add('clickable');
        row.append(el('div', 'notification-hint', 'Click to open this job in the Superagent tab.'));
        row.addEventListener('click', () => {
          openSuperagentView(entry.jobId);
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
      ? `${entries.length} item${entries.length === 1 ? ' needs' : 's need'} your attention`
      : 'Notifications';
    if (superagentBadge) {
      const count = entries.filter((entry) => entry.kind === 'superagent').length;
      superagentBadge.hidden = count === 0;
      superagentBadge.textContent = String(count);
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      entries = (await res.json()).entries || [];
    } catch {
      return; // best-effort; keep showing the last-known list
    }
    const firstPoll = !polled;
    polled = true;
    applyBadge();
    if (open) render();
    showBrowserNotifications(entries.filter((entry) => entry.kind === 'superagent'), firstPoll);
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
