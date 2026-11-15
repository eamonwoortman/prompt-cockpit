// Chain-on-rate-limit: the registry's trigger logic (ask / chain / present vs
// away / list order / no revisits / Grok-Codex detection) against a stubbed
// session, and chain.js's session start with stubbed deps. No CLI is spawned.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import * as presence from '../src/presence.js';
import { chainSession, normalizeChainTarget, normalizeChainList, RATE_LIMIT_ACTIONS } from '../src/chain.js';
import { readChainLog } from '../src/chain-log.js';
import { fakeStartSession, fakeWs } from './test-helpers.mjs';

const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
const own = { provider: 'claude', subscription: 'default' };
const B = { provider: 'claude', subscription: 'second' };
const C = { provider: 'claude', subscription: 'third' };
const list = [own, B, C];
const tick = () => new Promise((r) => setTimeout(r, 5));

async function tmpCwd() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chain-'));
}
function away() { presence._reset(); } // no activity recorded = away
function here() { presence._reset(); presence.markActivity(); }

async function chainRow(extra = {}) {
  registry._reset();
  const impl = fakeStartSession();
  const cwd = await tmpCwd();
  const row = registry.createSession({ cwd, startSessionImpl: impl, rateLimitAction: 'chain', chainList: list, ...extra });
  return { row, impl, cwd };
}

test('ask: a rate-limit hit raises the offer, names the next account, and does not chain', async () => {
  const { row, impl } = await chainRow({ rateLimitAction: 'ask' });
  let ran = 0;
  registry.setChainRunner(async () => { ran += 1; return { id: 'x', token: 't' }; });
  impl.emitMessage(rejected);
  assert.equal(row.chainOffer, true);
  assert.equal(ran, 0);
  const summary = registry.toSummary(row);
  assert.equal(summary.chainOffer, true);
  assert.deepEqual(summary.chainNext, B);
});

test('chain while away: a hit chains once to the next account in list order and tells the tabs', async () => {
  away();
  const { row, impl } = await chainRow();
  const ws = fakeWs();
  registry.attachClient(row.id, ws, 0);
  const seen = [];
  registry.setChainRunner(async (source, to) => { seen.push(to); return { id: 'new-id', token: 'new-token', mode: 'default' }; });
  impl.emitMessage(rejected);
  impl.emitMessage(rejected); // second detection source for the same hit
  await tick();
  assert.deepEqual(seen, [B]);
  assert.deepEqual(row.chainedTo, { id: 'new-id' });
  assert.deepEqual(ws.sent.find((m) => m.type === 'cockpit:chained').session, { id: 'new-id', token: 'new-token' });
});

test('chain while present: only an offer, and it chains on its own once the user is away', async () => {
  here();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { row, impl } = await chainRow();
    let ran = 0;
    registry.setChainRunner(async () => { ran += 1; return { id: 'n', token: 't', mode: 'default' }; });
    impl.emitMessage(rejected);
    assert.equal(row.chainOffer, true);
    assert.equal(ran, 0);
    mock.timers.tick(30_000); // still here: nothing
    await tick();
    assert.equal(ran, 0);
    presence.setForcedAway(true); // the user flips the away switch
    mock.timers.tick(30_000);
    await tick();
    assert.equal(ran, 1);
    assert.equal(row.chainOffer, false);
  } finally {
    mock.timers.reset();
    presence._reset();
  }
});

test('askWhenPresent off: chains immediately even while the user is here', async () => {
  here();
  const { row, impl } = await chainRow({ chainOptions: { askWhenPresent: false } });
  let ran = 0;
  registry.setChainRunner(async () => { ran += 1; return { id: 'n', token: 't', mode: 'default' }; });
  impl.emitMessage(rejected);
  await tick();
  assert.equal(ran, 1);
  assert.equal(row.chainOffer, false);
  presence._reset();
});

test('an account that fails to start is skipped and the next one is tried', async () => {
  away();
  const { row, impl, cwd } = await chainRow();
  const tried = [];
  registry.setChainRunner(async (source, to) => {
    tried.push(to.subscription);
    if (to.subscription === 'second') throw new Error('login expired');
    return { id: 'ok', token: 't', mode: 'default' };
  });
  impl.emitMessage(rejected);
  await tick();
  await tick();
  assert.deepEqual(tried, ['second', 'third']);
  assert.deepEqual(row.chainedTo, { id: 'ok' });
  const log = await readChainLog(cwd);
  assert.ok(log.some((e) => e.event === 'chain-failed' && /login expired/.test(e.detail)));
  assert.ok(log.some((e) => e.event === 'chained' && e.to.subscription === 'third' && e.trigger === 'auto'));
});

test('the end of the list stops the chain loudly instead of looping', async () => {
  away();
  const { row, impl, cwd } = await chainRow({ chainList: [own], chainedFrom: { id: 'z', visited: [] } });
  let ran = 0;
  registry.setChainRunner(async () => { ran += 1; return { id: 'x', token: 't', mode: 'default' }; });
  impl.emitMessage(rejected);
  await tick();
  assert.match(row.chainError, /used up/);
  assert.equal(ran, 0);
  const log = await readChainLog(cwd);
  assert.ok(log.some((e) => e.event === 'chain-stopped'));
});

test('an account used earlier in the chain is never used again', async () => {
  away();
  const { row, impl } = await chainRow({ chainList: [own, B, C], chainedFrom: { id: 'a', visited: ['claude::second'] } });
  const tried = [];
  registry.setChainRunner(async (source, to) => { tried.push(to.subscription); return { id: 'n', token: 't', mode: 'default' }; });
  impl.emitMessage(rejected);
  await tick();
  assert.deepEqual(tried, ['third'], 'second was already used');
  assert.deepEqual(row.chainedTo, { id: 'n' });
});

test('Grok/Codex detection: an error result that reads like a limit counts as a hit, a success lifts it', async () => {
  away();
  registry._reset();
  const impl = fakeStartSession();
  const cwd = await tmpCwd();
  const row = registry.createSession({ cwd, provider: 'codex', startSessionImpl: impl, rateLimitAction: 'ask', chainList: [{ provider: 'claude', subscription: 'default' }] });
  registry.setChainRunner(async () => ({ id: 'n', token: 't', mode: 'default' }));
  impl.emitMessage({ type: 'result', subtype: 'error', is_error: true, error: 'ordinary failure: tests failed' });
  assert.equal(row.rateLimitHit, null);
  impl.emitMessage({ type: 'result', subtype: 'error', is_error: true, error: 'You have hit your usage limit. Try again later.' });
  assert.equal(row.rateLimitHit.rateLimitType, 'provider_error_text');
  assert.equal(row.chainOffer, true);
  await tick();
  const log = await readChainLog(cwd);
  assert.ok(log.some((e) => e.event === 'limit-hit' && /usage limit/.test(e.detail)), 'raw text kept for tightening the match later');
  impl.emitMessage({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(row.rateLimitHit, null);
  assert.equal(row.chainOffer, false);
});

test('a Claude error result is never read as a rate limit (it has its own detection)', async () => {
  const { row, impl } = await chainRow({ rateLimitAction: 'ask' });
  impl.emitMessage({ type: 'result', subtype: 'error', is_error: true, error: 'rate limit in some tool output' });
  assert.equal(row.rateLimitHit, null);
});

test('a failed auto-chain surfaces chainError and leaves the session usable', async () => {
  away();
  const { row, impl } = await chainRow({ chainList: [B] });
  registry.setChainRunner(async () => { throw new Error('no grok'); });
  impl.emitMessage(rejected);
  await tick();
  assert.match(row.chainError, /no grok/);
  assert.equal(row.chainedTo, null);
  assert.equal(row.chaining, false);
  assert.equal(row.autoChaining, false);
});

test('setChainPolicy acts at once when the limit was already hit, and none stands the offer down', async () => {
  const { row, impl } = await chainRow({ rateLimitAction: 'none' });
  registry.setChainRunner(async () => ({ id: 'x', token: 't', mode: 'default' }));
  impl.emitMessage(rejected);
  assert.equal(row.chainOffer, false);
  await registry.setChainPolicy(row.id, { rateLimitAction: 'ask', chainList: list });
  assert.equal(row.chainOffer, true);
  await registry.setChainPolicy(row.id, { rateLimitAction: 'none', chainList: list });
  assert.equal(row.chainOffer, false);
});

test('a lifted limit clears the offer', async () => {
  const { row, impl } = await chainRow({ rateLimitAction: 'ask' });
  impl.emitMessage(rejected);
  assert.equal(row.chainOffer, true);
  impl.emitMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.equal(row.chainOffer, false);
});

test('resetSession keeps the chain policy and the accounts already used', async () => {
  const { row } = await chainRow({ rateLimitAction: 'ask', chainOptions: { awayMinutes: 25 }, chainedFrom: { id: 'a', visited: ['claude::second'] } });
  const replacement = registry.resetSession(row.id, { startSessionImpl: fakeStartSession() });
  assert.equal(replacement.rateLimitAction, 'ask');
  assert.deepEqual(replacement.chainList, list);
  assert.equal(replacement.chainOptions.awayMinutes, 25);
  assert.deepEqual(replacement.chainedFrom.visited, ['claude::second']);
});

test('a second chain while one is in flight is refused, and the guard clears afterwards', async () => {
  const { row } = await chainRow();
  let release;
  let ran = 0;
  registry.setChainRunner(() => { ran += 1; return new Promise((resolve) => { release = () => resolve({ id: `n${ran}`, token: 't', mode: 'default' }); }); });
  const first = registry.chainSession(row.id, B);
  await assert.rejects(() => registry.chainSession(row.id, B), /already in progress/);
  release();
  await first;
  assert.equal(ran, 1);
  assert.equal(row.chaining, false);
});

test('the ask-me button chains to the next account when no target is given', async () => {
  const { row } = await chainRow({ rateLimitAction: 'ask' });
  const seen = [];
  registry.setChainRunner(async (source, to) => { seen.push(to); return { id: 'n', token: 't', mode: 'default' }; });
  await registry.chainSession(row.id, undefined, { trigger: 'offer' });
  assert.deepEqual(seen, [B]);
  registry.setChainRunner(async () => ({ id: 'n2', token: 't', mode: 'default' }));
  const { row: lastRow } = await chainRow({ chainList: [own] });
  await assert.rejects(() => registry.chainSession(lastRow.id), /no further account/);
});

test('choosing a new policy clears the previous attempt\'s error', async () => {
  const { row } = await chainRow();
  row.chainError = 'old failure';
  await registry.setChainPolicy(row.id, { rateLimitAction: 'ask', chainList: list });
  assert.equal(row.chainError, null);
});

test('the away switch and activity pings reach every row\'s summary', async () => {
  const { row } = await chainRow();
  here();
  assert.equal(registry.toSummary(row).presence.away, false);
  registry.setAway(true);
  assert.deepEqual(registry.toSummary(row).presence, { forcedAway: true, away: true });
  presence._reset();
});

test('chainSession starts the target in the same folder with defaults, the folder\'s mode, and the summary', async () => {
  const row = { id: 'src', cwd: '/proj', name: 'main', provider: 'claude', subscription: 'default', mode: 'plan', providerSessionId: 'sid', chainOptions: { permissionMode: 'acceptEdits' }, chainedFrom: { visited: ['claude::second'] } };
  const created = [];
  const sent = [];
  const result = await chainSession(row, { provider: 'grok' }, {
    fetchHistory: async (sid, cwd) => { assert.equal(sid, 'sid'); assert.equal(cwd, '/proj'); return [{ type: 'user', message: { content: 'do the thing' } }]; },
    createSession: (opts) => { created.push(opts); return { id: 'new', token: 'tok' }; },
    seedSessionDefaults: async () => {},
    sendInput: async (id, text) => { sent.push({ id, text }); },
  });
  assert.deepEqual(result, { id: 'new', token: 'tok', mode: 'acceptEdits' });
  assert.equal(created[0].cwd, '/proj');
  assert.equal(created[0].provider, 'grok');
  assert.equal(created[0].permissionMode, 'acceptEdits');
  assert.equal(created[0].model, undefined);
  assert.equal(created[0].effort, undefined);
  assert.deepEqual(created[0].chainedFrom.visited, ['claude::second', 'claude::default']);
  assert.match(sent[0].text, /User: do the thing/);
});

test('permission mode "inherit" copies the source session\'s mode', async () => {
  const row = { id: 's', cwd: '/p', provider: 'claude', subscription: 'default', mode: 'plan', providerSessionId: 'sid', chainOptions: { permissionMode: 'inherit' } };
  let mode;
  await chainSession(row, { provider: 'grok' }, {
    fetchHistory: async () => [],
    createSession: (opts) => { mode = opts.permissionMode; return { id: 'n', token: 't' }; },
    seedSessionDefaults: async () => {},
    sendInput: async () => {},
  });
  assert.equal(mode, 'plan');
});

test('chainSession refuses a session with no conversation yet', async () => {
  await assert.rejects(() => chainSession({ id: 's', cwd: '/p', provider: 'claude', providerSessionId: null }, { provider: 'grok' }), /no conversation yet/);
});

test('normalizeChainTarget/List reject unknown providers, and keep each account once', () => {
  assert.throws(() => normalizeChainTarget({ provider: 'nope' }), /unknown provider/);
  assert.throws(() => normalizeChainTarget(null), /chain target required/);
  assert.throws(() => normalizeChainList('x'), /array/);
  assert.deepEqual(normalizeChainTarget({ provider: 'grok' }), { provider: 'grok', subscription: null });
  assert.deepEqual(normalizeChainList([{ provider: 'grok' }, { provider: 'codex' }, { provider: 'grok' }]), [{ provider: 'grok', subscription: null }, { provider: 'codex', subscription: null }]);
  assert.deepEqual(RATE_LIMIT_ACTIONS, ['none', 'wait', 'ask', 'chain']);
});
