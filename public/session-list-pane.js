// Server-wide session list: the header's sessionCountBtn shows how many
// cockpit sessions are live across the whole process (every cwd, every
// provider - GET /api/sessions is intentionally not scoped to this tab's own
// session, see session-registry.js's toSummary), and clicking it drops
// #sessionListPane in as a fixed right-docked overlay to show name/model/
// effort per row - works the same on the pre-session launcher screen as
// mid-session (see its markup comment in index.html for why it isn't a
// normal in-flow sibling of #detailPane). The badge itself is kept fresh by
// a 10s poll (below) so it reflects sessions opened/closed in *other* tabs
// too, not just this one's own lifecycle events; the expanded list body is
// still a read-only, one-time snapshot fetched only when the panel opens -
// not worth a websocket fan-in just to keep an open list live too.
// Cross-tab "switch to this session" - BroadcastChannel is same-origin-only
// and every tab (launcher or live session) has this pane wired up, so it
// doubles as both the sender (row click, any tab) and receiver (the one tab
// whose own sessionId matches). No server round-trip needed: this never
// leaves the browser.
//
// Confirmed live: calling window.focus() here does nothing - Chrome and
// Firefox both gate a background tab actually coming to the front on that
// tab having its own recent user activation, which a BroadcastChannel
// message never carries (the activation belongs to whichever tab the click
// happened in). Tried it, watched it silently no-op, removed it rather than
// leave dead "best-effort" code sitting here implying it sometimes works.
// The only honest signal available is onFocusRequested, which app.js wires
// to tab-chrome.js's existing needs-attention treatment (❗ title prefix +
// red favicon dot, already used for "a turn finished while unfocused") so
// the right tab is at least visibly flagged for the human to click.
import { initResizablePanel } from '/resizable-panel.js';

const FOCUS_CHANNEL_NAME = 'cockpit:session-focus';

export function initSessionListPane({ panel, body, closeBtn, countBtn, headerEl, handshakeRow, handshakeValue, handshakeCopyBtn, handshakeRegenBtn, getSelfId, onFocusRequested, resizeHandle, initialWidth, onWidthChange }) {
  let open = false;

  let focusChannel = null;
  try {
    focusChannel = new BroadcastChannel(FOCUS_CHANNEL_NAME);
  } catch {
    // BroadcastChannel unsupported (old Safari) - row clicks below just
    // won't flag the other tab; everything else in this pane still works.
  }
  if (focusChannel) {
    focusChannel.addEventListener('message', (event) => {
      const targetId = event.data && event.data.id;
      if (targetId && getSelfId && targetId === getSelfId()) onFocusRequested?.();
    });
  }

  function label(count) {
    return `${count} session${count === 1 ? '' : 's'}`;
  }

  // Drag-to-resize (resizable-panel.js, shared with detail-pane.js - same
  // .detail-pane-resize-handle CSS). This panel is a `position: fixed`
  // overlay, not an in-flow flex sibling, so unlike detail-pane.js there's no
  // --detail-pane-offset var to keep in sync, just the inline width itself.
  // Bug report this exists for: model/effort/handshake text was getting
  // ellipsis-truncated at the fixed 380px .detail-pane default with no way
  // to see the full row before picking a session to switch to.
  initResizablePanel({
    panel,
    handle: resizeHandle,
    minWidthPx: 280,
    initialWidth,
    onWidthChange,
    isNarrowLayout: () => window.matchMedia('(max-width: 900px)').matches,
  });

  // The per-process delegation handshake secret -
  // shown copyable here so a human can paste it into a sibling session's
  // own row (per-row "fix" button below) to mark that session trusted for
  // delegation, or eventually into a remote/SSH'd cockpit once that exists.
  // Fetched fresh every time the pane opens, same one-time-snapshot
  // reasoning as the session list itself (see module comment above).
  async function refreshHandshake() {
    if (!handshakeRow) return;
    try {
      const res = await fetch('/api/handshake');
      const { secret } = await res.json();
      handshakeValue.textContent = secret;
      handshakeValue.dataset.secret = secret;
    } catch {
      handshakeValue.textContent = '(unavailable)';
    }
  }

  if (handshakeCopyBtn) {
    handshakeCopyBtn.addEventListener('click', async () => {
      const secret = handshakeValue.dataset.secret;
      if (!secret) return;
      try {
        await navigator.clipboard.writeText(secret);
        handshakeCopyBtn.textContent = 'Copied';
        setTimeout(() => { handshakeCopyBtn.textContent = 'Copy'; }, 1200);
      } catch {
        // Clipboard permission denied or unavailable - the value is still
        // selectable/visible in handshakeValue, so this is a soft failure.
      }
    });
  }

  if (handshakeRegenBtn) {
    handshakeRegenBtn.addEventListener('click', async () => {
      // Rotating cuts off every currently-trusted session (see
      // regenerateHandshakeSecret's own comment) - confirm since this is
      // the "something looked wrong" hammer, not a routine action.
      if (!confirm('Regenerate the handshake secret? Every session not re-synced afterward loses delegation trust.')) return;
      const res = await fetch('/api/handshake/regenerate', { method: 'POST' });
      const { secret } = await res.json();
      handshakeValue.textContent = secret;
      handshakeValue.dataset.secret = secret;
      if (open) refreshCount().then(renderList); // trust badges below are now stale otherwise
    });
  }

  async function refreshCount() {
    let sessions = [];
    try {
      const res = await fetch('/api/sessions');
      sessions = await res.json();
    } catch {
      // Best-effort - a failed fetch just leaves the last-known count
      // showing rather than replacing it with an alarming placeholder.
      return sessions;
    }
    countBtn.textContent = label(sessions.length);
    return sessions;
  }

  function renderList(sessions) {
    body.textContent = '';
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'detail-pane-placeholder';
      empty.textContent = 'No sessions running.';
      body.append(empty);
      return;
    }
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'session-list-row';
      const isSelf = getSelfId && s.id === getSelfId();
      if (isSelf) {
        row.classList.add('self');
        row.title = 'This is the current tab.';
      } else if (focusChannel) {
        row.classList.add('clickable');
        row.title = 'Flag the tab with this session (❗ in its title) so you can find it - browsers won\'t let this page switch tabs for you.';
        row.addEventListener('click', () => {
          focusChannel.postMessage({ id: s.id });
          closePane();
        });
      }
      const name = document.createElement('span');
      name.className = 'session-list-name';
      name.textContent = s.name || `(unnamed - ${s.cwd || s.id.slice(0, 8)})`;
      const meta = document.createElement('span');
      meta.className = 'session-list-meta';
      meta.textContent = [s.model, s.effort].filter(Boolean).join(' / ') || '(default model)';
      row.append(name, meta);
      // Read-only here - this pane spans every tab/session server-wide, but
      // only the OWNING tab holds that session's own bearer token, so
      // fixing an untrusted row (pasting a value) has to happen from
      // Settings on that session's own tab, not from here. See
      // registry.isSessionTrusted's comment.
      if (s.handshakeTrusted === false) {
        const untrusted = document.createElement('span');
        untrusted.className = 'session-list-meta';
        untrusted.title = 'This session\'s delegation handshake does not match the server - it can\'t send or receive delegated tasks until re-synced from its own Settings panel.';
        untrusted.textContent = '⚠ handshake mismatch';
        row.append(untrusted);
      }
      body.append(row);
    }
  }

  async function openPane() {
    open = true;
    countBtn.classList.add('on');
    // Measured live, not a fixed CSS constant - the header's height isn't
    // fixed (the rate-limit banner can wrap it onto two lines).
    panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
    panel.classList.add('enabled');
    body.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'detail-pane-placeholder';
    loading.textContent = 'Loading…';
    body.append(loading);
    refreshHandshake();
    const sessions = await refreshCount();
    if (!open) return; // closed again before the fetch resolved
    renderList(sessions);
  }

  function closePane() {
    if (!open) return;
    open = false;
    countBtn.classList.remove('on');
    panel.classList.remove('enabled');
  }

  countBtn.addEventListener('click', () => (open ? closePane() : openPane()));
  closeBtn.addEventListener('click', closePane);
  window.addEventListener('resize', () => {
    if (open) panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
  });

  refreshCount();

  // Poll instead of a live push channel - other tabs' session opens/closes
  // don't reach this tab any other way (its own lifecycle events call
  // refreshCount() directly elsewhere in app.js, but that only covers this
  // tab's own session). 10s keeps the badge close enough to live without
  // adding a connection-less websocket channel just for a number that's
  // rarely stared at - see the module comment for the one-time-snapshot
  // reasoning this is layered on top of.
  setInterval(refreshCount, 10_000);

  return { refreshCount, closePane, isOpen: () => open };
}
