// Chain-on-rate-limit: the registry's trigger logic (ask / chain / one hop)
// against a stubbed session, and chain.js's session start with stubbed deps.
// No CLI is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../src/session-registry.js';
import { chainSession, normalizeChainTarget, RATE_LIMIT_ACTIONS } from '../src/chain.js';
import { fakeStartSession, fakeWs } from './test-helpers.mjs';

const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
const target = { provider: 'grok', subscription: null };

test('ask: a rate-limit hit raises the chain offer without chaining', () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl, rateLimitAction: 'ask', chainTarget: target });
  let ran = 0;
  registry.setChainRunner(async () => { ran += 1; return { id: 'x', token: 't' }; });
  impl.emitMessage(rejected);
  assert.equal(row.chainOffer, true);
  assert.equal(ran, 0);
  assert.equal(registry.toSummary(row).chainOffer, true);
});

test('chain: a hit chains once, records chainedTo, and tells connected tabs', async () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl, rateLimitAction: 'chain', chainTarget: target });
  const ws = fakeWs();
  registry.attachClient(row.id, ws, 0);
  let ran = 0;
  registry.setChainRunner(async (id, t) => { ran += 1; assert.deepEqual(t, target); return { id: 'new-id', token: 'new-token' }; });
  impl.emitMessage(rejected);
  impl.emitMessage(rejected); // second detection source for the same hit
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ran, 1);
  assert.deepEqual(row.chainedTo, { id: 'new-id' });
  const note = ws.sent.find((m) => m.type === 'cockpit:chained');
  assert.deepEqual(note.session, { id: 'new-id', token: 'new-token' });
});

test('one hop: a session that is itself a chain product never auto-chains', async () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl, rateLimitAction: 'chain', chainTarget: target, chainedFrom: { id: 'orig' } });
  let ran = 0;
  registry.setChainRunner(async () => { ran += 1; return { id: 'x', token: 't' }; });
  impl.emitMessage(rejected);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ran, 0);
  assert.equal(row.chainOffer, false);
});

test('a failed auto-chain surfaces chainError and leaves the session usable', async () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl, rateLimitAction: 'chain', chainTarget: target });
  registry.setChainRunner(async () => { throw new Error('no grok'); });
  impl.emitMessage(rejected);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(row.chainError, 'no grok');
  assert.equal(row.chainedTo, null);
  assert.equal(row.chaining, false);
});

test('setChainPolicy acts at once when the limit was already hit', async () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  registry.setChainRunner(async () => ({ id: 'x', token: 't' }));
  impl.emitMessage(rejected);
  assert.equal(row.chainOffer, false);
  await registry.setChainPolicy(row.id, { rateLimitAction: 'ask', chainTarget: target });
  assert.equal(row.chainOffer, true);
  await registry.setChainPolicy(row.id, { rateLimitAction: 'none', chainTarget: target });
  assert.equal(row.chainOffer, false);
});

test('a lifted limit clears the offer', () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl, rateLimitAction: 'ask', chainTarget: target });
  impl.emitMessage(rejected);
  assert.equal(row.chainOffer, true);
  impl.emitMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.equal(row.chainOffer, false);
});

test('resetSession keeps the chain policy', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession(), rateLimitAction: 'ask', chainTarget: target });
  const replacement = registry.resetSession(row.id, { startSessionImpl: fakeStartSession() });
  assert.equal(replacement.rateLimitAction, 'ask');
  assert.deepEqual(replacement.chainTarget, target);
});

test('chainSession starts the target in the same folder with defaults and sends the summary', async () => {
  const row = { id: 'src', cwd: '/proj', name: 'main', provider: 'claude', providerSessionId: 'sid', subscription: null };
  const created = [];
  const sent = [];
  const result = await chainSession('src', { provider: 'grok' }, {
    get: () => row,
    fetchHistory: async (sid, cwd) => { assert.equal(sid, 'sid'); assert.equal(cwd, '/proj'); return [{ type: 'user', message: { content: 'do the thing' } }]; },
    createSession: (opts) => { created.push(opts); return { id: 'new', token: 'tok' }; },
    seedSessionDefaults: async () => {},
    sendInput: async (id, text) => { sent.push({ id, text }); },
  });
  assert.deepEqual(result, { id: 'new', token: 'tok' });
  assert.equal(created[0].cwd, '/proj');
  assert.equal(created[0].provider, 'grok');
  assert.equal(created[0].permissionMode, 'default');
  assert.equal(created[0].model, undefined);
  assert.equal(created[0].effort, undefined);
  assert.equal(created[0].chainedFrom.id, 'src');
  assert.equal(sent[0].id, 'new');
  assert.match(sent[0].text, /User: do the thing/);
});

test('chainSession refuses a session with no conversation yet', async () => {
  await assert.rejects(
    () => chainSession('s', target, { get: () => ({ id: 's', cwd: '/p', provider: 'claude', providerSessionId: null }) }),
    /no conversation yet/,
  );
});

test('normalizeChainTarget rejects unknown providers and non-objects', () => {
  assert.throws(() => normalizeChainTarget({ provider: 'nope' }), /unknown provider/);
  assert.throws(() => normalizeChainTarget(null), /chain target required/);
  assert.deepEqual(normalizeChainTarget({ provider: 'grok' }), { provider: 'grok', subscription: null });
  assert.deepEqual(RATE_LIMIT_ACTIONS, ['none', 'wait', 'ask', 'chain']);
});

test('a second chain while one is in flight is refused, and the guard clears afterwards', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  let release;
  let ran = 0;
  registry.setChainRunner(() => { ran += 1; return new Promise((resolve) => { release = () => resolve({ id: `n${ran}`, token: 't' }); }); });
  const first = registry.chainSession(row.id, target);
  await assert.rejects(() => registry.chainSession(row.id, target), /already in progress/);
  release();
  await first;
  assert.equal(ran, 1);
  assert.equal(row.chaining, false);
  const again = registry.chainSession(row.id, target); // manual chains may repeat once the first is done
  release();
  await again;
  assert.equal(ran, 2);
});

test('a failed chain clears the in-flight guard so it can be retried', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  registry.setChainRunner(async () => { throw new Error('boom'); });
  await assert.rejects(() => registry.chainSession(row.id, target), /boom/);
  assert.equal(row.chaining, false);
});

test('choosing a new policy clears the previous attempt\'s error', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  row.chainError = 'old failure';
  await registry.setChainPolicy(row.id, { rateLimitAction: 'ask', chainTarget: target });
  assert.equal(row.chainError, null);
});
