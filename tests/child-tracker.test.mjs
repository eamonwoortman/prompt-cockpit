// Process ownership for the two providers cockpit spawns itself. Claude is
// deliberately absent: the SDK registers its own process.on('exit') cleanup,
// so its transport is not cockpit's to reap (see the design spec's Decision 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChildTracker, defaultRuntimePath } from '../src/child-tracker.js';
import { readJson } from '../src/json-store.js';

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
    assert.deepEqual(tracker.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
