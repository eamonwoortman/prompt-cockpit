// Process ownership for the two providers cockpit spawns itself. Claude is
// deliberately absent: the SDK registers its own process.on('exit') cleanup,
// so its transport is not cockpit's to reap (see the design spec's Decision 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  createChildTracker,
  defaultRuntimePath,
  getChildTracker,
  killProcessTree,
  verifyEntry,
  _resetChildTracker,
  START_TIME_TOLERANCE_MS,
} from '../src/child-tracker.js';
import { readJson, writeJsonAtomic } from '../src/json-store.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-child-tracker-'));
}

// Every probe is injected so no test spawns anything. `startTimes` maps a pid
// to the OS-reported start time `ps`/Get-Process would print for it.
//
// The start-time probe is ASYNC (it must not block session start), so its
// fake is a minimal ChildProcess: stdout emits once, then 'exit'. Tests that
// depend on a recorded start time must `await tracker.settled()` first.
function fakeDeps({ startTimes = new Map(), alive = new Set() } = {}) {
  const killed = [];
  return {
    killed,
    platform: 'linux',
    spawnImpl: (cmd, args) => {
      if (cmd !== 'ps') throw new Error(`unexpected spawn: ${cmd}`);
      const pid = Number(args[args.length - 1]);
      const at = startTimes.get(pid);
      const listeners = {};
      const proc = {
        pid: 1,
        stdout: { on: (event, fn) => { if (event === 'data' && at != null) fn(Buffer.from(new Date(at).toUTCString())); } },
        on: (event, fn) => { listeners[event] = fn; },
        kill: () => {},
      };
      // Exit on a later turn of the microtask queue, like a real child.
      queueMicrotask(() => listeners.exit?.(0));
      return proc;
    },
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'taskkill') {
        killed.push(Number(args[1]));
        return { status: 0, stdout: '' };
      }
      throw new Error(`unexpected spawnSync: ${cmd}`);
    },
    killImpl: (pid, signal) => {
      if (signal === 0) {
        if (!alive.has(pid)) {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      }
      killed.push(pid);
      alive.delete(pid);
      return true;
    },
    logImpl: () => {},
  };
}

test('defaultRuntimePath sits beside the operator token under ~/.prompt-cockpit', () => {
  assert.equal(
    defaultRuntimePath('/home/x'),
    path.join('/home/x', '.prompt-cockpit', 'runtime.json'),
  );
});

test('COCKPIT_RUNTIME_FILE overrides the path, so a test can never killTracked() the real home\'s pids', () => {
  const before = process.env.COCKPIT_RUNTIME_FILE;
  try {
    process.env.COCKPIT_RUNTIME_FILE = path.join('/tmp', 'elsewhere.json');
    assert.equal(defaultRuntimePath(), path.join('/tmp', 'elsewhere.json'));
    // An explicit home still wins - same as operator-auth's own override.
    assert.equal(defaultRuntimePath('/home/x'), path.join('/home/x', '.prompt-cockpit', 'runtime.json'));
    process.env.COCKPIT_RUNTIME_FILE = '   ';
    assert.equal(defaultRuntimePath(), defaultRuntimePath(homedir()));
  } finally {
    if (before === undefined) delete process.env.COCKPIT_RUNTIME_FILE;
    else process.env.COCKPIT_RUNTIME_FILE = before;
  }
});

test('retain records the OS-reported start time and persists the entry', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const started = Date.parse('2026-09-01T10:00:00Z');
    const deps = fakeDeps({ startTimes: new Map([[4242, started]]), alive: new Set([4242]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    const retaining = tracker.retain({ pid: 4242, provider: 'grok', command: '/usr/bin/grok' });
    // The entry exists before retain's own promise settles, and long before the
    // start-time probe lands - that is what keeps session start off PowerShell.
    assert.equal(tracker.list()[0].osStartedAt, null, 'recorded immediately, probe still in flight');
    await retaining;
    await tracker.settled();

    assert.deepEqual(tracker.list(), [{
      pid: 4242,
      provider: 'grok',
      osStartedAt: started,
      command: '/usr/bin/grok',
      pilotIds: [],
      // Which cockpit owns this CLI. Another instance sharing the same
      // per-user runtime.json reaps only entries whose owner is provably
      // gone. `ownerStartedAt` is null here because fakeDeps knows no start
      // time for the test runner's own pid.
      ownerPid: process.pid,
      ownerStartedAt: null,
    }]);
    assert.deepEqual(await readJson(runtimePath, []), tracker.list());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release removes the entry only once every holder has let go (Codex shared app-server)', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const deps = fakeDeps({ startTimes: new Map([[99, 1_000]]), alive: new Set([99]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    // One app-server process, three Codex sessions subscribed to it.
    await tracker.retain({ pid: 99, provider: 'codex', command: 'codex' });
    await tracker.retain({ pid: 99, provider: 'codex', command: 'codex' });
    await tracker.retain({ pid: 99, provider: 'codex', command: 'codex' });
    assert.equal(tracker.list().length, 1, 'one PID, not three rows');

    assert.equal(await tracker.release({ pid: 99 }), false);
    assert.equal(await tracker.release({ pid: 99 }), false);
    assert.equal(tracker.list().length, 1, 'still held by the last session');

    assert.equal(await tracker.release({ pid: 99 }), true);
    assert.deepEqual(tracker.list(), []);
    assert.deepEqual(await readJson(runtimePath, []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pilotIds accumulate and drop independently of the ref count', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const deps = fakeDeps({ startTimes: new Map([[7, 1_000]]), alive: new Set([7]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    await tracker.retain({ pid: 7, provider: 'codex', command: 'codex', pilotId: 'pilot-a' });
    await tracker.retain({ pid: 7, provider: 'codex', command: 'codex' }); // a hand-driven session, no pilot
    await tracker.attachPilot(7, 'pilot-b');
    assert.deepEqual(tracker.list()[0].pilotIds, ['pilot-a', 'pilot-b']);

    await tracker.detachPilot(7, 'pilot-a');
    assert.deepEqual(tracker.list()[0].pilotIds, ['pilot-b']);

    // A hand-driven session releasing must not remove a row two other
    // holders still need.
    assert.equal(await tracker.release({ pid: 7 }), false);
    assert.equal(tracker.list().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retain still records a pid whose OS start time it cannot read, and says so', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const logged = [];
    const deps = fakeDeps({ startTimes: new Map(), alive: new Set([5]) });
    const tracker = createChildTracker({ runtimePath, ...deps, logImpl: (msg) => logged.push(msg) });

    const entry = await tracker.retain({ pid: 5, provider: 'grok', command: 'grok' });
    await tracker.settled();

    // Recorded anyway - shutdown still needs to kill it in THIS process,
    // where the pid is known-good. osStartedAt staying null is what makes the
    // reaper refuse to touch it after a restart.
    assert.equal(entry.osStartedAt, null);
    assert.equal(tracker.list().length, 1);
    assert.match(logged.join('\n'), /start time/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retain ignores a pid that is not a positive integer', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const tracker = createChildTracker({ runtimePath, ...fakeDeps() });
    assert.equal(await tracker.retain({ pid: undefined, provider: 'grok', command: 'grok' }), null);
    assert.equal(await tracker.retain({ pid: 0, provider: 'grok', command: 'grok' }), null);
    // A negative pid is `kill(-pgid)` on POSIX - a whole process group.
    assert.equal(await tracker.retain({ pid: -1, provider: 'grok', command: 'grok' }), null);
    assert.deepEqual(tracker.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('overlapping persists leave runtime.json agreeing with the tracker, not with whichever write renamed last', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const deps = fakeDeps({ startTimes: new Map([[11, 1_000], [12, 2_000]]), alive: new Set([11, 12]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    // Both retains, both start-time probes and the release all persist, and
    // they overlap - the file must end up matching the maps.
    await Promise.all([
      tracker.retain({ pid: 11, provider: 'grok', command: 'grok' }),
      tracker.retain({ pid: 12, provider: 'codex', command: 'codex app-server' }),
    ]);
    await tracker.settled();
    await tracker.release({ pid: 11 });
    await tracker.settled();

    assert.deepEqual(tracker.list().map((e) => e.pid), [12]);
    assert.deepEqual(await readJson(runtimePath, []), tracker.list());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('killProcessTree uses taskkill /T /F on Windows and a signal elsewhere', () => {
  const calls = [];
  assert.equal(killProcessTree(1234, {
    platform: 'win32',
    spawnSyncImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; },
  }), true);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '1234', '/t', '/f']);
  assert.equal(calls[0].opts.windowsHide, true);

  // A graceful pass drops /f so the tree gets a chance to exit on its own.
  killProcessTree(1234, {
    platform: 'win32',
    signal: 'SIGTERM',
    spawnSyncImpl: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
  });
  assert.deepEqual(calls[1].args, ['/pid', '1234', '/t']);

  const signalled = [];
  assert.equal(killProcessTree(9, {
    platform: 'linux',
    killImpl: (pid, signal) => { signalled.push([pid, signal]); },
    spawnSyncImpl: () => { throw new Error('should not spawn'); },
  }), true);
  assert.deepEqual(signalled, [[9, 'SIGKILL']]);
});

test('killProcessTree refuses a non-positive-integer pid', () => {
  const spawnSyncImpl = () => { throw new Error('should not spawn'); };
  assert.equal(killProcessTree(0, { platform: 'win32', spawnSyncImpl }), false);
  assert.equal(killProcessTree(-1, { platform: 'win32', spawnSyncImpl }), false);
  assert.equal(killProcessTree(undefined, { platform: 'win32', spawnSyncImpl }), false);
});

test('verifyEntry matches within the tolerance and mismatches outside it', async () => {
  const started = Date.parse('2026-09-01T10:00:00Z');
  const alive = new Set([50]);
  const deps = (osReading) => fakeDeps({ startTimes: new Map([[50, osReading]]), alive });

  // `ps -o lstart` truncates to whole seconds, so an exact match is the
  // exception, not the rule - the tolerance is what makes this work at all.
  assert.equal(await verifyEntry({ pid: 50, osStartedAt: started + 400 }, deps(started)), 'match');
  assert.equal(
    await verifyEntry({ pid: 50, osStartedAt: started + START_TIME_TOLERANCE_MS }, deps(started)),
    'match',
  );
  assert.equal(
    await verifyEntry({ pid: 50, osStartedAt: started + START_TIME_TOLERANCE_MS + 1 }, deps(started)),
    'mismatch',
  );
});

test('verifyEntry reports gone for a dead pid and unverifiable when the start time is unreadable', async () => {
  assert.equal(
    await verifyEntry({ pid: 51, osStartedAt: 1_000 }, fakeDeps({ alive: new Set() })),
    'gone',
  );
  assert.equal(
    await verifyEntry({ pid: 52, osStartedAt: 1_000 }, fakeDeps({ startTimes: new Map(), alive: new Set([52]) })),
    'unverifiable',
  );
  // Recorded with no start time at all - either retain's probe came back
  // empty, or the cockpit died before it landed. Never confirmable, so never
  // killable.
  assert.equal(
    await verifyEntry({ pid: 53, osStartedAt: null }, fakeDeps({ startTimes: new Map([[53, 1_000]]), alive: new Set([53]) })),
    'unverifiable',
  );
});

test('reapOrphans kills a confirmed orphan and clears it from runtime.json', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const started = Date.parse('2026-09-01T10:00:00Z');
    await writeJsonAtomic(runtimePath, [
      { pid: 300, provider: 'grok', osStartedAt: started, command: 'grok', pilotIds: ['pilot-a'] },
    ]);
    const deps = fakeDeps({ startTimes: new Map([[300, started]]), alive: new Set([300]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    const result = await tracker.reapOrphans();

    assert.deepEqual(result.reaped.map((e) => e.pid), [300]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(deps.killed, [300]);
    assert.deepEqual(await readJson(runtimePath, []), []);
    assert.deepEqual([...tracker.orphanPilotIds()], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapOrphans REFUSES to kill an unverifiable pid and blocks that pilot from firing', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    await writeJsonAtomic(runtimePath, [
      { pid: 301, provider: 'codex', osStartedAt: 1_000, command: 'codex', pilotIds: ['pilot-b', 'pilot-c'] },
    ]);
    // Alive, but its start time can't be read - could be anything now.
    const deps = fakeDeps({ startTimes: new Map(), alive: new Set([301]) });
    const logged = [];
    const tracker = createChildTracker({ runtimePath, ...deps, logImpl: (m) => logged.push(m) });

    const result = await tracker.reapOrphans();

    assert.deepEqual(deps.killed, [], 'killing the operator\'s unrelated process is worse than logging an orphan');
    assert.deepEqual(result.skipped.map((e) => e.pid), [301]);
    assert.match(logged.join('\n'), /refus/i);
    // Carried forward, so another restart still sees it.
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid), [301]);
    // And its pilots stay blocked - otherwise the pilot is overdue and
    // lock-free on the next heartbeat, putting a second unattended agent in
    // the same working tree as the one we just declined to kill.
    assert.deepEqual([...tracker.orphanPilotIds()].sort(), ['pilot-b', 'pilot-c']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapOrphans drops a reused pid without killing it and does not block its pilots', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    await writeJsonAtomic(runtimePath, [
      { pid: 302, provider: 'grok', osStartedAt: 1_000, command: 'grok', pilotIds: ['pilot-d'] },
    ]);
    // Same pid, started an hour later - this is somebody else's process now,
    // and the one we recorded is provably gone.
    const deps = fakeDeps({ startTimes: new Map([[302, 3_601_000]]), alive: new Set([302]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    const result = await tracker.reapOrphans();

    assert.deepEqual(deps.killed, []);
    assert.deepEqual(result.vanished.map((e) => e.pid), [302]);
    assert.deepEqual(await readJson(runtimePath, []), []);
    assert.deepEqual([...tracker.orphanPilotIds()], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapOrphans treats a corrupt or non-array runtime.json as empty rather than throwing', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    await writeJsonAtomic(runtimePath, { not: 'an array' });
    const tracker = createChildTracker({ runtimePath, ...fakeDeps() });
    assert.deepEqual(await tracker.reapOrphans(), { reaped: [], skipped: [], vanished: [], foreign: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The three tests below are the owner discriminator. runtime.json is per
// USER, not per cockpit (README tells you to start a second instance on
// another PORT), and start-time verification only proves a pid IS the CLI
// that was recorded - not that nobody is still driving it. Without an owner
// check, a second cockpit tree-killed the first one's live, paid sessions
// about a second into its own boot.
test('reapOrphans leaves a still-running cockpit instance\'s CLIs alone, and does not block their pilots', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const childStart = Date.parse('2026-09-01T10:00:00Z');
    const ownerStart = Date.parse('2026-09-01T09:59:00Z');
    await writeJsonAtomic(runtimePath, [
      {
        pid: 310, provider: 'grok', osStartedAt: childStart, command: 'grok', pilotIds: ['pilot-e'],
        ownerPid: 9000, ownerStartedAt: ownerStart,
      },
    ]);
    const deps = fakeDeps({
      startTimes: new Map([[310, childStart], [9000, ownerStart], [311, 5_000]]),
      alive: new Set([310, 9000, 311]),
    });
    const logged = [];
    const tracker = createChildTracker({ runtimePath, ...deps, ownerPid: 9001, logImpl: (m) => logged.push(m) });

    const result = await tracker.reapOrphans();

    assert.deepEqual(deps.killed, [], 'that is another cockpit\'s live session, not an orphan');
    assert.deepEqual(result.foreign.map((e) => e.pid), [310]);
    assert.deepEqual(result.skipped, [], 'skipped-because-owner-alive is not skipped-because-unverifiable');
    assert.deepEqual([...tracker.orphanPilotIds()], [], 'the other instance owns that pilot; ours must not freeze');
    assert.match(logged.join('\n'), /still running/);

    // ...and our own writes must not erase it, or instance A's real orphans
    // become unreapable the moment we exit.
    await tracker.retain({ pid: 311, provider: 'grok', command: 'grok' });
    await tracker.settled();
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid).sort(), [310, 311]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapOrphans still reaps when the owning cockpit pid has been recycled by something else', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const childStart = Date.parse('2026-09-01T10:00:00Z');
    await writeJsonAtomic(runtimePath, [
      {
        pid: 320, provider: 'grok', osStartedAt: childStart, command: 'grok', pilotIds: [],
        ownerPid: 9100, ownerStartedAt: Date.parse('2026-09-01T09:00:00Z'),
      },
    ]);
    // Something is running as pid 9100, but it started an hour after the
    // cockpit that recorded this entry - so that cockpit is provably gone.
    const deps = fakeDeps({
      startTimes: new Map([[320, childStart], [9100, Date.parse('2026-09-01T10:30:00Z')]]),
      alive: new Set([320, 9100]),
    });
    const tracker = createChildTracker({ runtimePath, ...deps, ownerPid: 9101 });

    const result = await tracker.reapOrphans();

    assert.deepEqual(result.reaped.map((e) => e.pid), [320]);
    assert.deepEqual(deps.killed, [320], 'the recorded cockpit is dead, so this really is an orphan');
    assert.deepEqual(await readJson(runtimePath, []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an entry with no ownerPid reads as reapable, so a runtime.json from an older build still works', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const started = Date.parse('2026-09-01T10:00:00Z');
    await writeJsonAtomic(runtimePath, [
      { pid: 330, provider: 'grok', osStartedAt: started, command: 'grok', pilotIds: [] },
    ]);
    const deps = fakeDeps({ startTimes: new Map([[330, started]]), alive: new Set([330]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    const result = await tracker.reapOrphans();

    assert.deepEqual(result.reaped.map((e) => e.pid), [330]);
    assert.deepEqual(deps.killed, [330]);
    assert.deepEqual(await readJson(runtimePath, []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('killTracked drops a recycled pid instead of tree-killing whatever now holds it', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const startTimes = new Map([[601, 1_000]]);
    const deps = fakeDeps({ startTimes, alive: new Set([601]) });
    const logged = [];
    const tracker = createChildTracker({ runtimePath, ...deps, logImpl: (m) => logged.push(m) });

    await tracker.retain({ pid: 601, provider: 'grok', command: 'grok' });
    await tracker.settled();
    // Our CLI died without us noticing and the OS handed 601 to the
    // operator's editor. `taskkill /t /f` on it is the outcome the design
    // forbids outright.
    startTimes.set(601, 9_999_000);

    const killed = await tracker.killTracked();

    assert.deepEqual(killed, []);
    assert.deepEqual(deps.killed, []);
    assert.deepEqual(tracker.list(), [], 'and the stale entry is gone, not carried into runtime.json');
    assert.deepEqual(await readJson(runtimePath, []), []);
    assert.match(logged.join('\n'), /no longer the process we spawned/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('killTracked kills what this process owns and never a carried-forward orphan', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    // One unverifiable orphan carried forward from a previous run...
    await writeJsonAtomic(runtimePath, [
      { pid: 400, provider: 'grok', osStartedAt: 1_000, command: 'grok', pilotIds: [] },
    ]);
    const deps = fakeDeps({
      startTimes: new Map([[401, 2_000]]),
      alive: new Set([400, 401]),
    });
    const tracker = createChildTracker({ runtimePath, ...deps });
    await tracker.reapOrphans();
    assert.deepEqual(deps.killed, [], 'the carried orphan was refused, not killed');

    // ...and one process we spawned ourselves.
    await tracker.retain({ pid: 401, provider: 'grok', command: 'grok' });
    await tracker.settled();

    const killed = await tracker.killTracked();
    assert.deepEqual(killed.map((e) => e.pid), [401]);
    assert.deepEqual(deps.killed, [401]);
    // The carried orphan is still recorded, so a later start can retry it.
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid), [400]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('killTracked logs and skips an owned entry whose kill fails', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const started = Date.parse('2026-09-01T10:00:00Z');
    const logged = [];
    const alive = new Set([500]);
    // killImpl throws for signal SIGKILL but still reports alive on signal 0 (existence probe)
    const killImpl = (pid, signal) => {
      if (pid === 500 && signal !== 0) throw new Error('kill failed');
      if (signal === 0) {
        if (!alive.has(pid)) {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      }
      throw new Error('unexpected kill');
    };
    const tracker = createChildTracker({
      runtimePath,
      ...fakeDeps({ startTimes: new Map([[500, started]]), alive }),
      killImpl,
      logImpl: (m) => logged.push(m),
    });

    await tracker.retain({ pid: 500, provider: 'grok', command: 'grok' });
    await tracker.settled();

    const killed = await tracker.killTracked();

    // The kill failed, so it doesn't appear in the return value.
    assert.deepEqual(killed.map((e) => e.pid), []);
    // But the entry stays in runtime.json for a later reaper to retry.
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid), [500]);
    // And a log line identifies the failure.
    assert.match(logged.join('\n'), /kill failed.*pid 500.*grok.*grok/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getChildTracker returns one process-wide tracker until reset', async () => {
  const dir = await makeTmpDir();
  try {
    _resetChildTracker();
    const a = getChildTracker({ runtimePath: path.join(dir, 'runtime.json'), ...fakeDeps() });
    const b = getChildTracker();
    assert.equal(a, b, 'options on a later call must not build a second tracker');
    _resetChildTracker();
    const c = getChildTracker({ runtimePath: path.join(dir, 'runtime.json'), ...fakeDeps() });
    assert.notEqual(a, c);
  } finally {
    _resetChildTracker();
    await rm(dir, { recursive: true, force: true });
  }
});
