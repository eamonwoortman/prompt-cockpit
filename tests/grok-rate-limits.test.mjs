import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accountUsageCache } from '../src/account-usage-cache.js';
import { fetchGrokRateLimits, grokBillingToPanel } from '../src/grok-rate-limits.js';

const WEEKLY_END = '2026-11-28T23:08:31.604947+00:00';

beforeEach(() => accountUsageCache.clear());

test('weekly billing becomes the shared 7d window and never a 5h window', () => {
  const panel = grokBillingToPanel({
    config: {
      creditUsagePercent: 1,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: WEEKLY_END },
    },
    subscription_tier: 'SuperGrok',
  });
  assert.deepEqual(panel, {
    seven_day: { utilization: 1, resets_at: Date.parse(WEEKLY_END) },
  });
  assert.equal(Object.hasOwn(panel, 'five_hour'), false);
});

test('an omitted weekly percentage is 0% used, and other shapes stay empty', () => {
  assert.deepEqual(grokBillingToPanel({
    config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: WEEKLY_END } },
  }).seven_day.utilization, 0);
  assert.equal(grokBillingToPanel(null), null);
  assert.equal(grokBillingToPanel({ config: null }), null);
  assert.equal(grokBillingToPanel({
    config: {
      creditUsagePercent: 40,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: WEEKLY_END },
    },
  }), null);
  assert.equal(grokBillingToPanel({
    config: { creditUsagePercent: 'nope', currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: WEEKLY_END } },
  }), null);
  assert.equal(grokBillingToPanel({
    config: { creditUsagePercent: 4, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } },
  }).seven_day.resets_at, null);
});

function fakeConnect(payload, { fail = false, killed } = {}) {
  return () => ({
    client: {
      async request(method) {
        if (fail) throw new Error('billing unavailable');
        if (method === 'initialize') return {};
        assert.equal(method, '_x.ai/billing');
        return payload;
      },
      rejectAll() { killed.push('reject'); },
    },
    proc: { pid: 1 },
  });
}

test('launcher usage reads _x.ai/billing once, shares the cache, and closes the agent', async () => {
  let spawns = 0;
  const killed = [];
  const payload = {
    config: { creditUsagePercent: 37, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: WEEKLY_END } },
  };
  const connectImpl = () => {
    spawns++;
    return fakeConnect(payload, { killed })();
  };
  const killImpl = (proc) => { killed.push(proc.pid); };
  const [first, second] = await Promise.all([
    fetchGrokRateLimits({ connectImpl, killImpl }),
    fetchGrokRateLimits({ connectImpl, killImpl }),
  ]);
  assert.equal(first, second);
  assert.equal(first.rateLimits.seven_day.utilization, 37);
  assert.equal(Object.hasOwn(first.rateLimits, 'five_hour'), false);
  assert.equal(await fetchGrokRateLimits({ connectImpl, killImpl }), first);
  assert.equal(spawns, 1);
  assert.deepEqual(killed, ['reject', 1]);
});

test('a live Grok session supplies the weekly window and a later launcher read reuses it', async (t) => {
  const originalNow = Date.now;
  let time = originalNow();
  Date.now = () => time;
  t.after(() => { Date.now = originalNow; });
  let calls = 0;
  const queryHandle = {
    async grokRateLimits() {
      calls++;
      return { seven_day: { utilization: calls, resets_at: Date.parse(WEEKLY_END) } };
    },
  };
  const first = await fetchGrokRateLimits({ queryHandle, refresh: true });
  time += 59_999;
  assert.equal(await fetchGrokRateLimits({ queryHandle, refresh: true }), first);
  assert.equal(calls, 1);
  time += 1;
  const updated = await fetchGrokRateLimits({ queryHandle, refresh: true });
  assert.equal(updated.rateLimits.seven_day.utilization, 2);
  const fromLauncher = await fetchGrokRateLimits({
    connectImpl: () => { throw new Error('must reuse live cache'); },
  });
  assert.equal(fromLauncher, updated);
});
