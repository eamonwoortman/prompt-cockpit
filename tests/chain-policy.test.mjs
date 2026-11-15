import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTargets, normalizeChainOptions, looksLikeRateLimit, targetKey, DEFAULT_CHAIN_OPTIONS } from '../src/chain-policy.js';
import * as presence from '../src/presence.js';

const A = { provider: 'claude', subscription: 'default' };
const B = { provider: 'claude', subscription: 'gmail' };
const G = { provider: 'grok', subscription: null };
const C = { provider: 'codex', subscription: null };
const list = [A, B, G, C];

test('nextTargets goes forward through the list from the session\'s own place', () => {
  assert.deepEqual(nextTargets(list, A), [B, G, C]);
  assert.deepEqual(nextTargets(list, B), [G, C]);
  assert.deepEqual(nextTargets(list, C), []);
});

test('nextTargets never goes back, and never reuses a visited account', () => {
  assert.deepEqual(nextTargets(list, G, [targetKey(A), targetKey(B)]), [C]);
  assert.deepEqual(nextTargets(list, B, [targetKey(G)]), [C], 'a visited entry later in the list is skipped');
});

test('a session that is not on the list starts from the top', () => {
  const other = { provider: 'claude', subscription: 'work' };
  assert.deepEqual(nextTargets(list, other), [A, B, G, C]);
  assert.deepEqual(nextTargets(list, other, [targetKey(A)]), [B, G, C]);
});

test('normalizeChainOptions applies defaults and validates', () => {
  assert.deepEqual(normalizeChainOptions({}), DEFAULT_CHAIN_OPTIONS);
  assert.deepEqual(normalizeChainOptions({ askWhenPresent: false, awayMinutes: '20', permissionMode: 'acceptEdits' }), { askWhenPresent: false, awayMinutes: 20, permissionMode: 'acceptEdits' });
  assert.equal(normalizeChainOptions({ permissionMode: 'inherit' }).permissionMode, 'inherit');
  assert.throws(() => normalizeChainOptions({ awayMinutes: 0 }), /awayMinutes/);
  assert.throws(() => normalizeChainOptions({ awayMinutes: 'x' }), /awayMinutes/);
  assert.throws(() => normalizeChainOptions({ permissionMode: 'yolo' }), /permissionMode/);
});

test('looksLikeRateLimit matches common limit phrasing and nothing ordinary', () => {
  for (const text of ['You have hit your usage limit', 'Rate limit exceeded', 'rate-limit reached', 'HTTP 429 Too Many Requests', 'quota exceeded for this account']) {
    assert.equal(looksLikeRateLimit(text), true, text);
  }
  for (const text of ['file not found', 'tests failed: 3', 'build took 4290ms', '', null, undefined]) {
    assert.equal(looksLikeRateLimit(text), false, String(text));
  }
});

test('presence: away after the threshold, present just after activity, forced away overrides', () => {
  presence._reset();
  assert.equal(presence.isAway(10, 1_000_000), true, 'no activity ever recorded counts as away');
  presence.markActivity(1_000_000);
  assert.equal(presence.isAway(10, 1_000_000 + 5 * 60_000), false);
  assert.equal(presence.isAway(10, 1_000_000 + 10 * 60_000), true);
  presence.setForcedAway(true);
  assert.equal(presence.isAway(10, 1_000_000 + 1000), true);
  presence.setForcedAway(false);
  assert.equal(presence.isAway(10, 1_000_000 + 1000), false);
  presence._reset();
});

test('isRateLimitFailure trusts Codex\'s structured cause, and ignores causes another account would not fix', async () => {
  const { isRateLimitFailure } = await import('../src/chain-policy.js');
  assert.equal(isRateLimitFailure({ code: 'usageLimitExceeded', text: 'Something went wrong' }), true);
  assert.equal(isRateLimitFailure({ code: 'rateLimitExceeded' }), true);
  for (const code of ['contextWindowExceeded', 'sessionBudgetExceeded', 'unauthorized', 'serverOverloaded', 'other']) {
    assert.equal(isRateLimitFailure({ code, text: 'plain failure' }), false, code);
  }
  assert.equal(isRateLimitFailure({ text: 'You hit your usage limit' }), true, 'no code: fall back to the text');
});
