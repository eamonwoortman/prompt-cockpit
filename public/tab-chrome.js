// Browser tab title + favicon: reflects session activity so an
// unfocused tab is scannable from the tab strip instead of needing a
// terminal-bell substitute, plus a user-settable tab name that stops
// getting overwritten once set (`userNamed`).
const IDLE_COLOR = '#8a8f98';

// Favicon emoji per state, so a tab strip shows what each tab is doing
// without opening it. The title itself stays clean. Idle gets no prefix. Priority in render(): pending
// approval/question > needs-attention > error > running.
const STATE_TO_EMOJI = {
  running: '🔄',
  starting: '🔄',
  error: '❌',
};
const PENDING_EMOJI = '🔔'; // a permission request or question is waiting on the user
const ATTENTION_EMOJI = '❗'; // finished while unfocused / session-list focus request

// An 8-point starburst glyph, alternating outer/inner radius vertices,
// generated once by hand rather than computed at runtime - it's a fixed
// shape, no reason to redo the trig on every render.
function faviconDataUrl(color) {
  const path = 'M8,0.7 L8.99,5.6 L13.16,2.84 L10.4,7.01 L15.3,8 L10.4,8.99 L13.16,13.16 L8.99,10.4 L8,15.3 L7.01,10.4 L2.84,13.16 L5.6,8.99 L0.7,8 L5.6,7.01 L2.84,2.84 L7.01,5.6 Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${path}" fill="${color}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function emojiFaviconUrl(emoji) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="8" y="13" font-size="13" text-anchor="middle">${emoji}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const IDLE_FAVICON = faviconDataUrl(IDLE_COLOR);

export function initTabChrome({ faviconEl = document.getElementById('favicon'), defaultName = 'Prompt Cockpit' } = {}) {
  let autoName = defaultName;
  let userName = null; // set once the user renames the tab; auto-naming stops touching it from then on
  let needsAttention = false;
  let pendingApproval = false; // unlike needsAttention, only cleared when the request is actually resolved - not on focus
  let sessionState = 'idle';

  function render() {
    const name = userName || autoName;
    const emoji = pendingApproval ? PENDING_EMOJI : needsAttention ? ATTENTION_EMOJI : STATE_TO_EMOJI[sessionState] || '';
    document.title = name;
    faviconEl.href = emoji ? emojiFaviconUrl(emoji) : IDLE_FAVICON;
  }

  // Called whenever the session itself has an obvious name (cwd, mostly) -
  // a no-op once the user has renamed the tab, so an unrelated cwd/state
  // change can't stomp on a name they chose deliberately.
  function setAutoName(name) {
    autoName = name || defaultName;
    render();
  }

  function rename(name) {
    userName = name && name.trim() ? name.trim() : null;
    render();
  }

  function setState(state) {
    sessionState = state;
    render();
  }

  function setNeedsAttention(value) {
    needsAttention = value;
    render();
  }

  function setPendingApproval(value) {
    pendingApproval = Boolean(value);
    render();
  }

  window.addEventListener('focus', () => setNeedsAttention(false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setNeedsAttention(false);
  });

  render();

  return { setAutoName, rename, setState, setNeedsAttention, setPendingApproval, isUserNamed: () => userName !== null };
}
