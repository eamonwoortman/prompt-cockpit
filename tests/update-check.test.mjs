import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNewerVersion,
  createUpdateChecker,
  NOTIFY_INTERVAL_MS,
  CHECK_CACHE_MS,
} from '../src/update-check.js';

test('isNewerVersion compares numerically, not lexically', () => {
  assert.equal(isNewerVersion('0.170.0', '0.169.0'), true);
  assert.equal(isNewerVersion('0.3.327', '0.3.327'), false);
  assert.equal(isNewerVersion('0.3.9', '0.3.10'), false);
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
  assert.equal(isNewerVersion('garbage', '1.0.0'), false);
});

function makeChecker(probe) {
  const clock = { t: 1_000_000 };
  let calls = 0;
  const checker = createUpdateChecker({
    now: () => clock.t,
    probes: { codex: async () => { calls += 1; return probe(); } },
  });
  return { checker, clock, calls: () => calls };
}

const OUTDATED = { current: '0.169.0', latest: '0.170.0', command: 'codex update', label: 'Codex CLI' };

test('up to date shows nothing', async () => {
  const { checker } = makeChecker(() => ({ ...OUTDATED, current: '0.170.0' }));
  assert.equal(await checker.check('codex'), null);
});

test('outdated returns info once, then stays quiet for 4 hours', async () => {
  const { checker, clock } = makeChecker(() => OUTDATED);
  const first = await checker.check('codex');
  assert.equal(first.latest, '0.170.0');
  assert.equal(first.command, 'codex update');
  assert.equal(await checker.check('codex'), null);
  clock.t += NOTIFY_INTERVAL_MS - 1;
  assert.equal(await checker.check('codex'), null);
  clock.t += 2;
  assert.ok(await checker.check('codex'), 'shown again after 4h');
});

test('probe results are cached so repeated starts do not re-probe', async () => {
  const { checker, clock, calls } = makeChecker(() => ({ ...OUTDATED, current: '0.170.0' }));
  await checker.check('codex');
  await checker.check('codex');
  assert.equal(calls(), 1);
  clock.t += CHECK_CACHE_MS + 1;
  await checker.check('codex');
  assert.equal(calls(), 2);
});

test('a failing probe shows nothing, is not cached, and does not start the 4h window', async () => {
  let fail = true;
  const { checker, calls } = makeChecker(() => {
    if (fail) throw new Error('offline');
    return OUTDATED;
  });
  assert.equal(await checker.check('codex'), null);
  fail = false;
  assert.ok(await checker.check('codex'));
  assert.equal(calls(), 2);
});

test('unknown tool shows nothing', async () => {
  const { checker } = makeChecker(() => OUTDATED);
  assert.equal(await checker.check('nope'), null);
});

test('each tool has its own 4h window', async () => {
  const clock = { t: 1 };
  const checker = createUpdateChecker({
    now: () => clock.t,
    probes: {
      codex: async () => OUTDATED,
      claude: async () => ({ ...OUTDATED, label: 'Claude Agent SDK' }),
    },
  });
  assert.ok(await checker.check('codex'));
  assert.ok(await checker.check('claude'), 'claude not suppressed by codex popup');
});
