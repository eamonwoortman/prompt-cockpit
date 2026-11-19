// The handoff page's half (superagent-handoff.html, opened by the Superagent
// tab, see superagent-handoff.js). It tells its opener it is ready, takes the
// session only from that opener on this origin with its own nonce, stores it
// under the key app.js rejoins from (in app.js's own format), and loads `/`
// only once its own read-back matches. Otherwise it says so and the Superagent
// tab offers Open.
export const ACTIVE_SESSION_KEY = 'cockpit:activeSession';
export const HANDOFF_FAILED_TEXT = 'Could not open the retrospective here; use Open in the Superagent tab';

function sessionStorageOf(win) {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

function store(storage, value) {
  try {
    storage.setItem(ACTIVE_SESSION_KEY, value);
    return storage.getItem(ACTIVE_SESSION_KEY) === value;
  } catch {
    return false;
  }
}

export function runHandoffPage({ win = window, storage = sessionStorageOf(win) } = {}) {
  const origin = win.location.origin;
  const nonce = win.location.hash.slice(1);
  const opener = win.opener;
  const say = (text) => {
    const status = win.document?.getElementById('handoffStatus');
    if (status) status.textContent = text;
  };
  if (!opener || !nonce) {
    say(HANDOFF_FAILED_TEXT);
    return;
  }
  let done = false;
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (done || event.origin !== origin || event.source !== opener) return;
    if (data?.type !== 'cockpit:handoff-session' || data.nonce !== nonce) return;
    if (typeof data.id !== 'string' || typeof data.token !== 'string') return;
    done = true;
    if (!storage || !store(storage, JSON.stringify({ id: data.id, token: data.token }))) {
      opener.postMessage({ type: 'cockpit:handoff-failed', nonce }, origin);
      say(HANDOFF_FAILED_TEXT);
      return;
    }
    opener.postMessage({ type: 'cockpit:handoff-ack', nonce }, origin);
    win.opener = null;
    win.location.replace('/');
  });
  opener.postMessage({ type: 'cockpit:handoff-ready', nonce }, origin);
}
