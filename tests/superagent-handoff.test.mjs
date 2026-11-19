// The retrospective's new-tab handoff (R2-3): the Superagent tab's side
// (superagent-handoff.js) and the handoff page (superagent-handoff-page.js)
// over fake windows, each with its own sessionStorage. Messages are delivered
// the way a browser does: later, only to a matching targetOrigin, carrying the
// sender's origin and the receiver's handle on the sender as `source`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACK_TIMEOUT_MS, HANDOFF_PAGE, createHandoff } from '../public/superagent-handoff.js';
import { HANDOFF_FAILED_TEXT, runHandoffPage } from '../public/superagent-handoff-page.js';

const ORIGIN = 'http://127.0.0.1:4317';
const KEY = 'cockpit:activeSession';
const SESSION = { id: 'sess-1', token: 'tok-1', name: 'Retro: Login page · spec' };
const STORED = JSON.stringify({ id: 'sess-1', token: 'tok-1' });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function storage(over = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    ...over,
  };
}

function fakeWindow({ origin = ORIGIN, hash = '' } = {}) {
  const listeners = [];
  const status = { textContent: '' };
  const win = {
    opener: null,
    closed: false,
    replaced: [],
    received: [],
    status,
    location: { origin, hash, replace: (url) => { win.replaced.push(url); } },
    document: { getElementById: (id) => (id === 'handoffStatus' ? status : null) },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => { if (listeners.includes(fn)) listeners.splice(listeners.indexOf(fn), 1); },
    deliver: (event) => {
      win.received.push(event);
      for (const fn of [...listeners]) fn(event);
    },
  };
  return win;
}

function send(to, fromOrigin, source, data, targetOrigin) {
  setImmediate(() => {
    if (targetOrigin === to.location.origin) to.deliver({ origin: fromOrigin, source, data });
  });
}

// The handles each side holds on the other: the opener's window.open result
// and the child's window.opener.
function connect(opener, child) {
  const openerHandle = { postMessage: (data, target) => send(opener, child.location.origin, childHandle, data, target) };
  const childHandle = {
    get closed() { return child.closed; },
    postMessage: (data, target) => send(child, opener.location.origin, openerHandle, data, target),
  };
  child.opener = openerHandle;
  return childHandle;
}

function fakeTimers() {
  const timers = [];
  return { timers, setTimeoutImpl: (fn, ms) => timers.push({ fn, ms }), clearTimeoutImpl: () => {} };
}

// openWindow makes a child that loads the real handoff page a moment later
// (unless runPage is off), or returns null while `blocked`.
function world({ blocked = false, runPage = true, childStorage = () => storage(), timers = {} } = {}) {
  const opener = fakeWindow();
  const w = { opener, children: [], posts: [], blocked, runPage };
  let nonces = 0;
  w.handoff = createHandoff({
    win: opener,
    openWindow: (url) => {
      if (w.blocked) return null;
      const child = fakeWindow({ hash: url.slice(url.indexOf('#')) });
      child.url = url;
      child.storage = childStorage();
      child.handle = connect(opener, child);
      w.children.push(child);
      if (w.runPage) setImmediate(() => runHandoffPage({ win: child, storage: child.storage }));
      return child.handle;
    },
    postJson: async (selector) => {
      w.posts.push(selector);
      return SESSION;
    },
    randomId: () => `nonce-${++nonces}`,
    ...timers,
  });
  return w;
}

test('child acks only after its own storage read-back matches', async () => {
  const w = world();
  const result = await w.handoff.start({ attemptId: 'a1' });
  assert.deepEqual(result, { status: 'opened', session: SESSION });
  const [child] = w.children;
  assert.equal(child.url, `${HANDOFF_PAGE}#nonce-1`);
  assert.ok(!child.url.includes('tok-1'), 'the token never appears in a URL');
  assert.equal(child.storage.getItem(KEY), STORED);
  assert.deepEqual(child.replaced, ['/']);
  assert.equal(child.opener, null, 'the opener relationship is severed');
  assert.deepEqual(child.received.map((e) => e.data), [{ type: 'cockpit:handoff-session', nonce: 'nonce-1', id: 'sess-1', token: 'tok-1' }]);
  assert.deepEqual(w.opener.received.map((e) => e.data), [
    { type: 'cockpit:handoff-ready', nonce: 'nonce-1' },
    { type: 'cockpit:handoff-ack', nonce: 'nonce-1' },
  ]);
  assert.equal(w.handoff.sessionFor(JSON.stringify({ attemptId: 'a1' })), null, 'kept only until the ack');

  // A storage that does not read back what was written: no ack, no navigation.
  const lying = world({ childStorage: () => storage({ getItem: () => '{"id":"other"}' }) });
  const failed = await lying.handoff.start({ attemptId: 'a1' });
  assert.deepEqual(failed, { status: 'pending-open', session: SESSION });
  const [bad] = lying.children;
  assert.deepEqual(bad.replaced, []);
  assert.equal(bad.status.textContent, HANDOFF_FAILED_TEXT);
  assert.deepEqual(lying.opener.received.map((e) => e.data.type), ['cockpit:handoff-ready', 'cockpit:handoff-failed']);

  // A storage write that throws reports failed the same way.
  const throwing = world({ childStorage: () => storage({ setItem: () => { throw new Error('QuotaExceededError'); } }) });
  assert.equal((await throwing.handoff.start({ attemptId: 'a1' })).status, 'pending-open');
  assert.deepEqual(throwing.children[0].replaced, []);
});

test('opener ignores messages from another origin or another window', async () => {
  const { timers, ...impls } = fakeTimers();
  const w = world({ runPage: false, timers: impls });
  let outcome = null;
  const pending = w.handoff.start({ attemptId: 'a1' });
  pending.then((r) => { outcome = r; });
  const [child] = w.children;
  await settle();
  const elsewhere = fakeWindow();
  const ready = { type: 'cockpit:handoff-ready', nonce: 'nonce-1' };
  w.opener.deliver({ origin: 'http://evil.test', source: child.handle, data: ready });
  w.opener.deliver({ origin: ORIGIN, source: elsewhere, data: ready });
  await settle();
  assert.deepEqual(child.received, [], 'no session is sent for a forged ready');

  const ack = { type: 'cockpit:handoff-ack', nonce: 'nonce-1' };
  w.opener.deliver({ origin: 'http://evil.test', source: child.handle, data: ack });
  w.opener.deliver({ origin: ORIGIN, source: elsewhere, data: ack });
  w.opener.deliver({ origin: ORIGIN, source: child.handle, data: { ...ack, nonce: 'nonce-2' } });
  await settle();
  assert.equal(outcome, null, 'a forged ack does not finish the handoff');
  assert.deepEqual(w.handoff.sessionFor(JSON.stringify({ attemptId: 'a1' })), SESSION);

  w.opener.deliver({ origin: ORIGIN, source: child.handle, data: ready });
  await settle();
  assert.deepEqual(child.received.map((e) => [e.origin, e.data]), [[ORIGIN, { type: 'cockpit:handoff-session', nonce: 'nonce-1', id: 'sess-1', token: 'tok-1' }]]);
  w.opener.deliver({ origin: ORIGIN, source: child.handle, data: ack });
  assert.deepEqual(await pending, { status: 'opened', session: SESSION });
});

test('child ignores a session message from a non-opener', async () => {
  const opener = fakeWindow();
  const child = fakeWindow({ hash: '#nonce-9' });
  connect(opener, child);
  const childStorage = storage();
  runHandoffPage({ win: child, storage: childStorage });
  await settle();
  assert.deepEqual(opener.received.map((e) => [e.origin, e.data]), [[ORIGIN, { type: 'cockpit:handoff-ready', nonce: 'nonce-9' }]]);

  const session = { type: 'cockpit:handoff-session', nonce: 'nonce-9', id: 'sess-1', token: 'tok-1' };
  const theOpener = child.opener;
  child.deliver({ origin: ORIGIN, source: fakeWindow(), data: session });
  child.deliver({ origin: 'http://evil.test', source: theOpener, data: session });
  child.deliver({ origin: ORIGIN, source: theOpener, data: { ...session, nonce: 'nonce-8' } });
  assert.equal(childStorage.getItem(KEY), null);
  assert.deepEqual(child.replaced, []);

  child.deliver({ origin: ORIGIN, source: theOpener, data: session });
  assert.equal(childStorage.getItem(KEY), STORED);
  assert.deepEqual(child.replaced, ['/']);
});

test('blocked popup keeps one session and offers Open', async () => {
  const w = world({ blocked: true });
  const result = await w.handoff.start({ phase: 'fix', task: 't1' });
  assert.deepEqual(result, { status: 'pending-open', session: SESSION });
  assert.deepEqual(w.posts, [{ phase: 'fix', task: 't1' }]);
  assert.deepEqual(w.handoff.sessionFor(JSON.stringify({ phase: 'fix', task: 't1' })), SESSION);
});

test('no ack within 10 s offers Open', async () => {
  const { timers, ...impls } = fakeTimers();
  const w = world({ runPage: false, timers: impls });
  const pending = w.handoff.start({ attemptId: 'a1' });
  await settle();
  assert.equal(ACK_TIMEOUT_MS, 10_000);
  assert.deepEqual(timers.map((x) => x.ms), [ACK_TIMEOUT_MS]);
  timers[0].fn();
  assert.deepEqual(await pending, { status: 'pending-open', session: SESSION });
  assert.deepEqual(w.handoff.sessionFor(JSON.stringify({ attemptId: 'a1' })), SESSION);
});

test('reopen does not POST again', async () => {
  const w = world({ blocked: true });
  await w.handoff.start({ attemptId: 'a1' });
  const key = JSON.stringify({ attemptId: 'a1' });
  assert.equal((await w.handoff.reopen(key)).status, 'pending-open', 'still blocked');
  assert.equal((await w.handoff.start({ attemptId: 'a1' })).status, 'pending-open', 'a start reuses the pending session');
  assert.equal(w.posts.length, 1);

  w.blocked = false;
  assert.deepEqual(await w.handoff.reopen(key), { status: 'opened', session: SESSION });
  assert.equal(w.posts.length, 1);
  assert.equal(w.children.length, 1, 'a newly opened handoff page');
  assert.equal(w.children[0].url, `${HANDOFF_PAGE}#nonce-4`);
  assert.equal(w.children[0].storage.getItem(KEY), STORED);
  await assert.rejects(w.handoff.reopen(key), /no retrospective/);
});

test('handoff-failed offers Open', async () => {
  const w = world({ runPage: false });
  const pending = w.handoff.start({ attemptId: 'a1' });
  const [child] = w.children;
  await settle();
  w.opener.deliver({ origin: ORIGIN, source: child.handle, data: { type: 'cockpit:handoff-ready', nonce: 'nonce-1' } });
  await settle();
  w.opener.deliver({ origin: ORIGIN, source: child.handle, data: { type: 'cockpit:handoff-failed', nonce: 'nonce-1' } });
  assert.deepEqual(await pending, { status: 'pending-open', session: SESSION });
  assert.equal(w.posts.length, 1);
});

test('a failed POST closes the opened page and creates nothing to reopen', async () => {
  const opener = fakeWindow();
  const page = { closed: false, close() { this.closed = true; }, postMessage() {} };
  const handoff = createHandoff({
    win: opener,
    openWindow: () => page,
    postJson: async () => { throw Object.assign(new Error('no transcript'), { code: 'ERR_TRANSCRIPT_MISSING' }); },
  });
  await assert.rejects(handoff.start({ attemptId: 'a1' }), { code: 'ERR_TRANSCRIPT_MISSING' });
  assert.equal(page.closed, true);
  assert.equal(handoff.sessionFor(JSON.stringify({ attemptId: 'a1' })), null);
});

test('a page closed before the session arrives offers Open at once', async () => {
  const { timers, ...impls } = fakeTimers();
  const w = world({ runPage: false, timers: impls });
  const pending = w.handoff.start({ attemptId: 'a1' });
  w.children[0].closed = true;
  assert.deepEqual(await pending, { status: 'pending-open', session: SESSION });
  assert.deepEqual(timers, []);
});
