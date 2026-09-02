// The seam between session-registry, child-tracker and shutdown - which is
// where the branch's central promise actually lives, and where every one of
// the criticals in the final review hid. The unit files fake each other's
// boundaries (tests/shutdown.test.mjs models tracker.list() as independent of
// registry.closeSession(), when in production closing a session is exactly
// what used to empty the tracker), so each half passed while the composition
// leaked live, paid CLI processes.
//
// Real session-registry, real createChildTracker, real createShutdown, real
// OS kill. The only injected dependency is the OS start-time probe: the real
// one shells out to PowerShell/ps, which is slow and platform-flaky, and
// nothing here is testing PowerShell. The child processes are bare
// `process.execPath -e ...` - no provider CLI, no network, no cost.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { createChildTracker } from '../src/child-tracker.js';
import { createCodexAppServerManager } from '../src/codex-app-server.js';
import { startCodexSession } from '../src/codex-session.js';
import { createShutdown } from '../src/shutdown.js';
import { readJson, writeJsonAtomic } from '../src/json-store.js';

// Every child this file starts, so a failed assertion cannot leave an idle
// node process behind. Belt and braces: each test also cleans up in a
// finally, and this sweeps whatever a throw skipped.
const spawned = new Set();

function spawnIdleChild() {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  spawned.add(proc);
  proc.once('exit', () => spawned.delete(proc));
  proc.once('error', () => spawned.delete(proc));
  return proc;
}

function killChildren() {
  for (const proc of [...spawned]) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
  spawned.clear();
}

after(killChildren);

function hasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function waitForExit(proc, timeoutMs = 5000) {
  if (hasExited(proc)) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

// The start-time probe, faked but honest: a pid this map knows reports the
// same value every time (so identity verification says 'match'), and one it
// does not know reports nothing (so verification says 'unverifiable'). Pid
// extraction is platform-agnostic because `platform` stays REAL here - that
// is what makes killProcessTree use the actual taskkill/kill for this OS.
function probeSpawnImpl(startTimes) {
  return (command, args) => {
    const joined = args.join(' ');
    const match = joined.match(/-Id (\d+)/) || joined.match(/(\d+)\s*$/);
    const at = startTimes.get(Number(match?.[1]));
    const listeners = {};
    queueMicrotask(() => listeners.exit?.(0));
    return {
      pid: 1,
      stdout: {
        on: (event, fn) => {
          if (event === 'data' && at != null) fn(Buffer.from(new Date(at).toISOString()));
        },
      },
      on: (event, fn) => { listeners[event] = fn; },
      kill: () => {},
    };
  };
}

async function withTracker(run, { ownerPid = process.pid } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-shutdown-int-'));
  const runtimePath = path.join(dir, 'runtime.json');
  const startTimes = new Map();
  const logged = [];
  const tracker = createChildTracker({
    runtimePath,
    ownerPid,
    spawnImpl: probeSpawnImpl(startTimes),
    logImpl: (msg) => logged.push(String(msg)),
  });
  try {
    return await run({ tracker, runtimePath, startTimes, logged });
  } finally {
    registry._reset();
    killChildren();
    // Drain first. The provider modules release fire-and-forget from their
    // process's 'exit' handler, and writeJsonAtomic mkdir -p's its parent -
    // so a persist landing after the rm below silently recreates the temp
    // directory and leaves it behind.
    await new Promise((resolve) => setImmediate(resolve));
    await tracker.settled();
    await tracker.persistNow();
    await removeDir(dir);
  }
}

// Windows hands back ENOTEMPTY when a handle on the directory has not closed
// yet. One retry is enough and beats failing an otherwise-passing test on
// teardown (the same flake that already dogs tests/session-launcher.test.mjs).
async function removeDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// A session handle whose close() does NOT touch the tracker - the production
// Codex shape, where the shared app-server outlives every session on it.
function trackerBlindHandle(trackedPid, closes) {
  return {
    trackedPid,
    close: () => { closes.push(trackedPid); },
    pushInput: () => null,
    interrupt: async () => {},
    listQueue: () => [],
  };
}

test('shutdown kills a tracked child that outlives its grace period, and leaves runtime.json []', async () => {
  await withTracker(async ({ tracker, runtimePath, startTimes }) => {
    const child = spawnIdleChild();
    startTimes.set(child.pid, Date.now());
    startTimes.set(process.pid, Date.now() - 60_000);
    await tracker.retain({ pid: child.pid, provider: 'codex', command: 'codex app-server' });
    await tracker.settled();

    const closes = [];
    const row = registry.createSession({
      cwd: process.cwd(),
      provider: 'codex',
      startSessionImpl: () => trackerBlindHandle(child.pid, closes),
    });

    const shutdown = createShutdown({ registry, tracker, graceMs: 50, logImpl: () => {} });
    await shutdown.run('integration');

    assert.deepEqual(closes, [child.pid], 'the session was closed');
    assert.equal(registry.list().length, 0, 'and its row is gone');
    // The whole point: closing the last session must NOT be what un-tracks a
    // still-running process. If it is, shutdown sees an empty tracker, skips
    // the grace period and the entire force-kill pass, and this child lives.
    assert.equal(await waitForExit(child), true, `pid ${child.pid} survived shutdown`);
    assert.deepEqual(await readJson(runtimePath, []), []);
    assert.deepEqual(tracker.list(), []);
    assert.ok(row.id);
  });
});

test('a child that dies on its own releases its entry instead of lingering for the cockpit\'s life', async () => {
  await withTracker(async ({ tracker, runtimePath, startTimes }) => {
    const child = spawnIdleChild();
    startTimes.set(child.pid, Date.now());
    await tracker.retain({ pid: child.pid, provider: 'grok', command: 'grok agent stdio' });
    await tracker.settled();
    // The provider wiring: release from the process's own 'exit', not only
    // from an explicit close. Mirrors grok-session.js's releaseTracked and
    // codex-app-server.js's.
    const released = new Promise((resolve) => {
      child.once('exit', () => { tracker.release({ pid: child.pid }).then(resolve, resolve); });
    });

    child.kill('SIGKILL');
    await waitForExit(child);
    await released;

    assert.deepEqual(tracker.list(), [], 'no stale entry for a dead pid');
    assert.deepEqual(await readJson(runtimePath, []), [], 'and "runtime.json is [] after a clean exit" holds');

    // ...so a later shutdown has nothing to wait for and nothing to kill.
    let slept = false;
    const shutdown = createShutdown({
      registry,
      tracker,
      logImpl: () => {},
      sleepImpl: async () => { slept = true; },
    });
    await shutdown.run('integration');
    assert.equal(slept, false, 'a dead process must not cost every later exit its grace period');
  });
});

test('reapOrphans leaves an entry owned by a still-live cockpit pid alone, and reaps one whose owner is gone', async () => {
  await withTracker(async ({ tracker, runtimePath, startTimes, logged }) => {
    // Owned by THIS process, which is very much alive - stands in for the
    // first cockpit's live session. A second cockpit booting must not touch
    // it. Before the owner field existed, it was tree-killed about a second
    // into that second cockpit's startup.
    const theirs = spawnIdleChild();
    // Its owner is provably dead: a child we start and wait out, so the pid
    // is real and gone rather than merely unlikely.
    const orphan = spawnIdleChild();
    const deadOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true, shell: false });
    await waitForExit(deadOwner);

    const ownerStartedAt = Date.now() - 60_000;
    startTimes.set(process.pid, ownerStartedAt);
    startTimes.set(theirs.pid, Date.now());
    startTimes.set(orphan.pid, Date.now());
    await writeJsonAtomic(runtimePath, [
      {
        pid: theirs.pid, provider: 'grok', osStartedAt: startTimes.get(theirs.pid),
        command: 'grok agent stdio', pilotIds: ['pilot-theirs'],
        ownerPid: process.pid, ownerStartedAt,
      },
      {
        pid: orphan.pid, provider: 'grok', osStartedAt: startTimes.get(orphan.pid),
        command: 'grok agent stdio', pilotIds: [],
        ownerPid: deadOwner.pid, ownerStartedAt: ownerStartedAt - 1000,
      },
    ]);

    const result = await tracker.reapOrphans();

    assert.deepEqual(result.foreign.map((e) => e.pid), [theirs.pid]);
    assert.equal(hasExited(theirs), false, 'another cockpit\'s live session must survive our boot');
    assert.deepEqual([...tracker.orphanPilotIds()], [], 'and it must not freeze our pilots either');
    assert.match(logged.join('\n'), /still running/);

    assert.deepEqual(result.reaped.map((e) => e.pid), [orphan.pid]);
    assert.equal(await waitForExit(orphan), true, 'a real orphan is still reaped');

    // The foreign entry survives our write - otherwise instance A's real
    // orphans become unreapable the moment we exit.
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid), [theirs.pid]);
  }, { ownerPid: 1 }); // pretend to be a different cockpit than the entries' owner
});

function fakeAppServerClient() {
  return {
    onNotification: () => () => {},
    onServerRequest: () => () => {},
    request: async () => ({}),
    notify: () => {},
    rejectAll: () => {},
  };
}

// The real Codex composition, end to end: the shared app-server's own spawn
// is what holds the tracker entry, so no number of sessions closing can drop
// it while the process is alive. Retaining per session instead is what made
// shutdown see an empty tracker, skip its grace period and its whole kill
// pass, and then write [] over the record of a CLI it had not killed.
test('closing every Codex session does not un-track the live app-server, and shutdown then kills it', async () => {
  await withTracker(async ({ tracker, runtimePath, startTimes }) => {
    const child = spawnIdleChild();
    startTimes.set(child.pid, Date.now());
    const manager = createCodexAppServerManager({
      connectImpl: () => ({ proc: child, client: fakeAppServerClient(), command: 'codex', getStderr: () => '' }),
      tracker,
    });
    await manager.ready();
    await tracker.settled();
    assert.equal(manager.pid(), child.pid);

    const rows = [
      registry.createSession({ cwd: process.cwd(), provider: 'codex', startSessionImpl: (args) => startCodexSession({ ...args, manager }) }),
      registry.createSession({ cwd: process.cwd(), provider: 'codex', startSessionImpl: (args) => startCodexSession({ ...args, manager }) }),
    ];
    assert.deepEqual(rows.map((r) => r.handle.trackedPid), [child.pid, child.pid]);

    for (const row of rows) registry.closeSession(row.id);
    assert.deepEqual(tracker.list().map((e) => e.pid), [child.pid], 'both sessions closed; the process is still running');
    assert.equal(hasExited(child), false);

    const shutdown = createShutdown({ registry, tracker, graceMs: 50, logImpl: () => {} });
    await shutdown.run('integration');

    assert.equal(await waitForExit(child), true, `the shared app-server (pid ${child.pid}) survived shutdown`);
    assert.deepEqual(await readJson(runtimePath, []), []);
  });
});

test('the app-server releases its entry on real process death - covering codex-history\'s session-less spawn', async () => {
  await withTracker(async ({ tracker, runtimePath, startTimes }) => {
    const child = spawnIdleChild();
    startTimes.set(child.pid, Date.now());
    // codex-history.js's listCodexSessions/fetchCodexSessionHistory default
    // to getCodexAppServerManager(), i.e. exactly this constructor - so a
    // cockpit where the user only ever opened the history pane still has a
    // tracked, killable app-server rather than an unreapable stray.
    createCodexAppServerManager({
      connectImpl: () => ({ proc: child, client: fakeAppServerClient(), command: 'codex', getStderr: () => '' }),
      tracker,
    });
    await tracker.settled();
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid), [child.pid]);

    child.kill('SIGKILL');
    await waitForExit(child);
    await tracker.persistNow();

    assert.deepEqual(tracker.list(), []);
    assert.deepEqual(await readJson(runtimePath, []), []);
  });
});
