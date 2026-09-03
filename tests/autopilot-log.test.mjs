// Append-only run history. Backs the Logs tab AND the daily spend cap, which
// is why rotation is not just "truncate at 2 MB": rotating resets the day's
// computed total, so the routine carries the day's running cost into the fresh
// file or the cap silently resets mid-day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAutopilotLog, defaultAutopilotLogPath, ROTATE_BYTES } from '../src/autopilot-log.js';

async function makeLog(over = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-log-'));
  const filePath = path.join(dir, 'autopilot-log.jsonl');
  return { dir, filePath, log: createAutopilotLog({ filePath, ...over }) };
}

// A fixed local wall-clock instant, so the local-midnight boundary is
// unambiguous whatever TZ the test runs in.
function localTime(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

test('defaultAutopilotLogPath sits beside the operator token', () => {
  assert.equal(defaultAutopilotLogPath('/home/x'), path.join('/home/x', '.prompt-cockpit', 'autopilot-log.jsonl'));
});

test('append stamps ts, writes one JSON object per line, and tail reads newest-last', async () => {
  const { dir, filePath, log } = await makeLog({ now: () => 1_700_000_000_000 });
  try {
    await log.append({ event: 'fired', pilotId: 'p1', pilotName: 'Nightly', sessionId: 's1' });
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'Nightly', sessionId: 's1', costUsd: 0.42, durationMs: 90_000 });

    const raw = await readFile(filePath, 'utf-8');
    assert.equal(raw.trimEnd().split('\n').length, 2);
    const entries = await log.tail({});
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, 'fired');
    assert.equal(entries[0].ts, 1_700_000_000_000);
    assert.equal(entries[1].costUsd, 0.42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('append rejects an unknown event rather than writing an unreadable log', async () => {
  const { dir, log } = await makeLog();
  try {
    await assert.rejects(() => log.append({ event: 'exploded', pilotId: 'p1' }), /unknown auto-pilot log event/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail filters by pilotId and honours limit, keeping the newest entries', async () => {
  const { dir, log } = await makeLog();
  try {
    for (let i = 0; i < 5; i++) await log.append({ event: 'fired', pilotId: 'p1', pilotName: 'A', reason: `a${i}` });
    for (let i = 0; i < 5; i++) await log.append({ event: 'fired', pilotId: 'p2', pilotName: 'B', reason: `b${i}` });

    const p1 = await log.tail({ pilotId: 'p1' });
    assert.equal(p1.length, 5);
    assert.ok(p1.every((e) => e.pilotId === 'p1'));

    const last2 = await log.tail({ pilotId: 'p1', limit: 2 });
    assert.deepEqual(last2.map((e) => e.reason), ['a3', 'a4']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a torn final line from a crash is skipped, not fatal', async () => {
  const { dir, filePath, log } = await makeLog();
  try {
    await log.append({ event: 'fired', pilotId: 'p1', pilotName: 'A' });
    await appendFile(filePath, '{"event":"finished","pil', 'utf-8');
    const entries = await log.tail({});
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'fired');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dailyCostUsd sums every cost-bearing event since local midnight, not just finished', async () => {
  const noon = localTime(2026, 9, 1, 12, 0);
  const { dir, log } = await makeLog({ now: () => noon });
  try {
    // Yesterday - must not count.
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 99, ts: localTime(2026, 8, 31, 23, 59) });
    // Today. A timed-out run spent real money before it was killed.
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 1.25, ts: localTime(2026, 9, 1, 1, 0) });
    await log.append({ event: 'timed-out', pilotId: 'p1', pilotName: 'A', costUsd: 0.75, ts: localTime(2026, 9, 1, 2, 0) });
    await log.append({ event: 'errored', pilotId: 'p2', pilotName: 'B', costUsd: 0.5, ts: localTime(2026, 9, 1, 3, 0) });
    // No cost at all - contributes nothing but must not throw.
    await log.append({ event: 'skipped', pilotId: 'p2', pilotName: 'B', reason: 'outside window', ts: localTime(2026, 9, 1, 4, 0) });
    // Unpriced model: costForUsage returned null, so the cap can be exceeded.
    await log.append({ event: 'finished', pilotId: 'p3', pilotName: 'C', costUnpriced: true, ts: localTime(2026, 9, 1, 5, 0) });

    assert.deepEqual(await log.dailyCostUsd(noon), { costUsd: 2.5, unpricedRuns: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotate carries the current day total forward instead of truncating it away', async () => {
  const noon = localTime(2026, 9, 1, 12, 0);
  const { dir, filePath, log } = await makeLog({ now: () => noon, rotateBytes: 200 });
  try {
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 3, ts: localTime(2026, 9, 1, 8, 0) });
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 4, costUnpriced: true, ts: localTime(2026, 9, 1, 9, 0) });
    assert.deepEqual(await log.dailyCostUsd(noon), { costUsd: 7, unpricedRuns: 1 });

    assert.equal(await log.rotate(), true);

    // Old entries are gone from the live file...
    const entries = await log.tail({});
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'carry-forward');
    // ...but the day's total survives, which is the whole point.
    assert.deepEqual(await log.dailyCostUsd(noon), { costUsd: 7, unpricedRuns: 1 });
    // And the previous generation is still on disk to read.
    const rotated = await readFile(`${filePath}.1`, 'utf-8');
    assert.match(rotated, /"costUsd":3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('append rotates automatically once the file passes rotateBytes', async () => {
  const noon = localTime(2026, 9, 1, 12, 0);
  const { dir, filePath, log } = await makeLog({ now: () => noon, rotateBytes: 300 });
  try {
    for (let i = 0; i < 20; i++) {
      await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'Nightly triage', costUsd: 0.1, ts: noon });
    }
    const size = (await stat(filePath)).size;
    assert.ok(size <= 300 + 512, `expected the live file to have rotated, got ${size} bytes`);
    // Every dollar still accounted for despite rotating mid-day.
    const { costUsd } = await log.dailyCostUsd(noon);
    assert.ok(Math.abs(costUsd - 2) < 1e-9, `expected 2.0, got ${costUsd}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the default rotate threshold is 2 MB', () => {
  assert.equal(ROTATE_BYTES, 2 * 1024 * 1024);
});

test('rotation failure is logged but does not fail append', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-log-'));
  const filePath = path.join(dir, 'autopilot-log.jsonl');
  const logCalls = [];
  const testLog = createAutopilotLog({
    filePath,
    now: () => 1_700_000_000_000,
    rotateBytes: 50,
    logger: (msg) => logCalls.push(msg),
    renameImpl: async () => {
      throw new Error('rename failed');
    },
  });

  try {
    // First entry is small, doesn't trigger rotation
    await testLog.append({ event: 'fired', pilotId: 'p1', pilotName: 'A' });

    // Now fill the file to trigger rotation, which will fail
    for (let i = 0; i < 5; i++) {
      await testLog.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 0.1 });
    }

    // Verify entries were written despite rotation failure
    const entries = await testLog.tail({});
    assert.ok(entries.length > 0, 'entries were appended despite rotation failure');

    // Verify the rotation failure was logged
    assert.ok(logCalls.length > 0, 'rotation failure was logged');
    assert.ok(logCalls.some((msg) => msg.includes('Failed to rotate')), 'error message mentions rotation failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotation retries rename on Windows when first attempt fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-log-'));
  const filePath = path.join(dir, 'autopilot-log.jsonl');
  let renameCalls = 0;
  const logCalls = [];
  const testLog = createAutopilotLog({
    filePath,
    now: () => 1_700_000_000_000,
    rotateBytes: 50,
    logger: (msg) => logCalls.push(msg),
    renameImpl: async (src, dst) => {
      renameCalls++;
      // First call fails (simulating Windows conflict), second succeeds
      if (renameCalls === 1) {
        const err = new Error('EEXIST: file already exists');
        err.code = 'EEXIST';
        throw err;
      }
      // Second call succeeds
      return rename(src, dst);
    },
  });

  try {
    // First entry is small, doesn't trigger rotation
    await testLog.append({ event: 'fired', pilotId: 'p1', pilotName: 'A' });

    // Now fill the file to trigger rotation
    for (let i = 0; i < 5; i++) {
      await testLog.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 0.1 });
    }

    // Verify the retry path was taken: rename should have been called twice
    // (once failed, once succeeded on the second rotation attempt or retry)
    assert.ok(renameCalls >= 2, `expected rename to be retried, got ${renameCalls} calls`);

    // Verify rotation eventually succeeded: entries should be present
    const entries = await testLog.tail({});
    assert.ok(entries.length > 0, 'entries were appended after rotation retry');

    // Verify no error was logged (the retry should have succeeded)
    const failureLogged = logCalls.some((msg) => msg.includes('Failed to rotate'));
    assert.ok(!failureLogged, 'rotation succeeded after retry, no error logged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
