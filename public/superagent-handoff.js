// The Superagent tab's half of the retrospective handoff (R2-3). A click opens
// the handoff page (superagent-handoff-page.js) synchronously, so no popup
// blocker applies, and only then POSTs. Once the page says it is ready and the
// session exists, the session goes to it by postMessage; the page stores it in
// its own sessionStorage and loads `/`. The token never goes in a URL.
//
// The session is kept per selector until the page acks. A blocked popup, a
// closed page, a page that could not store it, or no ack within 10 s leaves it
// pending: reopen (or start again) opens a fresh page for the same session and
// never POSTs a second time.
export const HANDOFF_PAGE = '/superagent-handoff.html';
export const ACK_TIMEOUT_MS = 10_000;

export function createHandoff({
  openWindow,
  postJson,
  win = window,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  randomId = () => crypto.randomUUID(),
}) {
  const origin = win.location.origin;
  const sessions = new Map();
  const starting = new Map();
  // nonce -> the page opened with it and what it is waiting for.
  const exchanges = new Map();

  win.addEventListener('message', (event) => {
    if (event.origin !== origin) return;
    const exchange = exchanges.get(event.data?.nonce);
    if (!exchange || event.source !== exchange.page) return;
    if (event.data.type === 'cockpit:handoff-ready') {
      exchange.ready = true;
      send(exchange);
    } else if (event.data.type === 'cockpit:handoff-ack') finish(exchange, 'opened');
    else if (event.data.type === 'cockpit:handoff-failed') finish(exchange, 'pending-open');
  });

  function send(exchange) {
    if (!exchange.ready || !exchange.session || exchange.sent) return;
    exchange.sent = true;
    const { id, token } = exchange.session;
    exchange.page.postMessage({ type: 'cockpit:handoff-session', nonce: exchange.nonce, id, token }, origin);
  }

  function finish(exchange, status) {
    if (!exchanges.delete(exchange.nonce)) return;
    if (exchange.timer != null) clearTimeoutImpl(exchange.timer);
    if (status === 'opened') sessions.delete(exchange.key);
    exchange.resolve({ status, session: exchange.session });
  }

  // Synchronous up to openWindow, so it still runs inside the click.
  function open(key) {
    const nonce = randomId();
    const page = openWindow(`${HANDOFF_PAGE}#${nonce}`) ?? null;
    const exchange = { key, nonce, page, ready: false, sent: false, session: null, timer: null };
    exchange.done = new Promise((resolve) => { exchange.resolve = resolve; });
    if (page) exchanges.set(nonce, exchange);
    return exchange;
  }

  function hand(exchange, session) {
    exchange.session = session;
    if (!exchange.page || exchange.page.closed) {
      exchanges.delete(exchange.nonce);
      return { status: 'pending-open', session };
    }
    exchange.timer = setTimeoutImpl(() => finish(exchange, 'pending-open'), ACK_TIMEOUT_MS);
    send(exchange);
    return exchange.done;
  }

  function reopen(key) {
    const session = sessions.get(key);
    if (!session) return Promise.reject(new Error('no retrospective is waiting to be opened'));
    return Promise.resolve(hand(open(key), session));
  }

  function start(selector) {
    const key = JSON.stringify(selector);
    if (starting.has(key)) return starting.get(key);
    if (sessions.has(key)) return reopen(key);
    const exchange = open(key);
    const run = (async () => {
      let session;
      try {
        session = await postJson(selector);
      } catch (err) {
        exchanges.delete(exchange.nonce);
        exchange.page?.close?.();
        throw err;
      }
      sessions.set(key, session);
      return hand(exchange, session);
    })();
    starting.set(key, run);
    const forget = () => { if (starting.get(key) === run) starting.delete(key); };
    run.then(forget, forget);
    return run;
  }

  return { start, reopen, sessionFor: (key) => sessions.get(key) ?? null };
}
