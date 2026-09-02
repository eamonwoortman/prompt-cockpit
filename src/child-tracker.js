// Process ownership for the provider CLIs cockpit spawns itself: which PIDs
// they are, whether they are still the process we spawned, and how to kill
// them (including grandchildren behind a Windows .cmd wrapper).
//
// Covers GROK and CODEX only. Claude's transport is spawned by the agent
// SDK, which registers its own process.on('exit') teardown for it
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs), so it is not
// cockpit's to reap. The real orphan exposure is the other two:
// killGrokProcess runs only on explicit teardown paths - a session close
// (grok-session.js:350), the short-lived rewind helper's finally
// (grok-session.js:38), and a CLI timeout (grok-cli.js:57) - never on process
// exit. codex-app-server.js's shared process has no exit-time teardown at all.
//
// runtime.json is keyed by PROCESS, not by session. One Codex app-server
// hosts every Codex session (codex-app-server.js's ref-counted manager), so
// a per-session row would either duplicate one PID N times or - worse - drop
// the entry and kill every other Codex session when any one of them closed.
// `pilotIds` is the set of auto-pilots currently depending on that process;
// ref counts are in-memory only, since after a restart every persisted entry
// is an orphan candidate regardless of how many holders it once had.
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './json-store.js';

export function defaultRuntimePath(home = homedir()) {
  return path.join(home, '.prompt-cockpit', 'runtime.json');
}

// The OS's own start time for a pid, as epoch-ms, or null if it can't be
// read. Two properties matter and they pull in opposite directions:
//
//  - It must be the OS-REPORTED value, not Date.now() at spawn. The reaper
//    compares it against a live `ps -o lstart` / Get-Process reading, and
//    `lstart` has 1-second granularity - a JS millisecond timestamp would
//    never match, so the reaper would refuse every entry and reap nothing.
//  - It must be ASYNC. On Windows this is a cold PowerShell start: 200-800ms
//    typical, 10s worst case. retain() is called from Grok's and Codex's
//    session-start paths, so a spawnSync here would stall the whole cockpit
//    HTTP + WebSocket server on every session start.
//
// Never rejects: an unreadable start time resolves to null, which the reaper
// reads as 'unverifiable' and refuses to act on.
export function probeProcessStartTime(pid, {
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = 10_000,
} = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return Promise.resolve(null);
  // `n` is a validated positive integer by this point, so interpolating it
  // into the PowerShell command below cannot inject anything.
  const [command, args] = platform === 'win32'
    ? ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${n} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
    ]]
    : ['ps', ['-o', 'lstart=', '-p', String(n)]];

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnImpl(command, args, {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    proc.stdout?.on('data', (chunk) => { out += String(chunk); });
    proc.on('error', () => finish(null));
    proc.on('exit', () => {
      const ms = Date.parse(out.trim());
      finish(Number.isFinite(ms) ? ms : null);
    });
  });
}

// Signal 0 is an existence probe - it delivers nothing. EPERM means the
// process exists but belongs to another user, which still counts as "exists"
// (and is itself a reason not to kill it).
export function processExists(pid, { killImpl = (p, s) => process.kill(p, s) } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    killImpl(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

// `ps -o lstart` prints whole seconds and Windows' Get-Process rounds
// differently again, so an exact comparison against the value recorded at
// spawn never matches. A few seconds of slack is enough to confirm identity
// without being wide enough to accept a pid recycled minutes later.
export const START_TIME_TOLERANCE_MS = 3000;

// A Windows .cmd/.bat wrapper survives killing the pid we spawned - the real
// agent keeps running - so taskkill /T walks the tree. Deliberately NOT a
// refactor of grok-acp.js's killGrokProcess: that one takes a live
// ChildProcess handle and calls proc.kill() on POSIX (the in-session
// teardown path, covered by tests/grok-acp.test.mjs:197). This one only ever
// has a bare pid read back out of runtime.json.
export function killProcessTree(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  killImpl = (p, s) => process.kill(p, s),
  signal = 'SIGKILL',
} = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (platform === 'win32') {
    const args = ['/pid', String(n), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    const res = spawnSyncImpl('taskkill', args, { windowsHide: true, shell: false, stdio: 'ignore' });
    return Boolean(res) && res.status === 0;
  }
  try {
    killImpl(n, signal);
    return true;
  } catch {
    return false;
  }
}

// Is the pid in `entry` still the process cockpit spawned?
//   'gone'         - nothing is running under that pid; nothing to do.
//   'match'        - same process, safe to kill.
//   'mismatch'     - pid was recycled; the recorded process is provably gone,
//                    so drop the entry WITHOUT killing the new occupant.
//   'unverifiable' - alive, but identity can't be confirmed. Refuse to kill.
// Async only because the start-time probe is. `processExists` stays sync -
// it is a `process.kill(pid, 0)` existence probe, no subprocess - so the
// cheap rejection still short-circuits before anything is spawned.
export async function verifyEntry(entry, deps = {}) {
  if (!entry) return 'gone';
  const n = Number(entry.pid);
  if (!Number.isInteger(n) || n <= 0) return 'gone';
  if (!processExists(n, deps)) return 'gone';
  if (entry.osStartedAt == null) return 'unverifiable';
  const started = await probeProcessStartTime(n, deps);
  if (started == null) return 'unverifiable';
  return Math.abs(started - entry.osStartedAt) <= START_TIME_TOLERANCE_MS ? 'match' : 'mismatch';
}

export function createChildTracker({
  runtimePath = defaultRuntimePath(),
  platform = process.platform,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  killImpl = (p, s) => process.kill(p, s),
  logImpl = console.error,
} = {}) {
  const probeDeps = { platform, spawnImpl, spawnSyncImpl, killImpl };
  // Outstanding async start-time probes, so settled() and shutdown() have
  // something to await. Never awaited by retain() itself.
  const probes = new Set();
  // pid -> { entry, refs }
  const owned = new Map();
  // Orphans from a previous run that the reaper refused to kill (Task 3).
  // Persisted alongside `owned` so another restart still sees them, but never
  // in list() - shutdown must not kill a process it could not verify.
  let carried = [];
  // Write queue to serialize persists. Both retain() and its async probe call
  // persist() for the same entry, so concurrent renames would race; the one
  // that wins determines what ends up in the file. Serialize them so the
  // final file reflects the final state, not an intermediate snapshot.
  let writeChain = Promise.resolve();

  function ownedEntries() {
    return [...owned.values()].map(({ entry }) => entry);
  }

  function runtimeEntries() {
    return [...ownedEntries(), ...carried];
  }

  // Whole-file rewrite rather than updateJson's read-modify-write: this
  // process is the only writer of its own runtime.json, and the in-memory
  // maps above - not the file - are the source of truth.
  async function persist() {
    // Chain this write after all earlier persists, so even if retain() and
    // its probe both call us, the file ends up with the latest state.
    // runtimeEntries() is evaluated when the write actually starts, not when
    // persist() is called, so we serialize the state snapshots too.
    const prev = writeChain;
    const run = prev.catch(() => {}).then(async () => {
      try {
        await writeJsonAtomic(runtimePath, runtimeEntries());
      } catch (err) {
        // Losing runtime.json costs us orphan reaping on the NEXT start, which
        // is not worth failing a session launch over.
        logImpl(`child-tracker: could not write ${runtimePath}: ${String(err?.message || err)}`);
      }
    });
    writeChain = run;
    // `run.finally(...)` returns a new derived promise that rejects whenever
    // `run` rejects, but nothing awaits that derived promise - prevent an
    // unhandled rejection from killing the process.
    run.finally(() => {}).catch(() => {});
    return run;
  }

  async function retain({ pid, provider, command, pilotId = null }) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return null;
    let slot = owned.get(n);
    if (!slot) {
      // Recorded with osStartedAt: null RIGHT NOW, filled in when the probe
      // lands. This function is on the session-start path and must not wait
      // on a subprocess - see probeProcessStartTime's comment.
      //
      // The exposure this buys is small and bounded: for the ~500ms the probe
      // is in flight the entry has no start time, so a cockpit crash inside
      // that window leaves one entry the next start's reaper will decline to
      // kill (logged, and it blocks that pilot until killed by hand). That
      // beats stalling every session start.
      slot = { entry: { pid: n, provider, osStartedAt: null, command, pilotIds: [] }, refs: 0 };
      owned.set(n, slot);
      const probe = probeProcessStartTime(n, probeDeps).then(async (osStartedAt) => {
        if (owned.get(n) !== slot) return; // released before the probe landed
        slot.entry.osStartedAt = osStartedAt;
        if (osStartedAt == null) {
          logImpl(`child-tracker: could not read the OS start time for pid ${n} (${provider}) - it is still tracked for this process's own shutdown, but an orphan reaper on the next start will refuse to touch it.`);
        }
        await persist();
      });
      probes.add(probe);
      probe.finally(() => probes.delete(probe)).catch(() => {});
    }
    slot.refs += 1;
    if (pilotId && !slot.entry.pilotIds.includes(pilotId)) slot.entry.pilotIds.push(pilotId);
    await persist();
    return slot.entry;
  }

  async function release({ pid, pilotId = null }) {
    const n = Number(pid);
    const slot = owned.get(n);
    if (!slot) return false;
    if (pilotId) slot.entry.pilotIds = slot.entry.pilotIds.filter((id) => id !== pilotId);
    slot.refs -= 1;
    const removed = slot.refs <= 0;
    if (removed) owned.delete(n);
    await persist();
    return removed;
  }

  // Drains every in-flight start-time probe (and the persist each one
  // triggers). Awaited by tests and by shutdown(); never by retain().
  async function settled() {
    while (probes.size) await Promise.all([...probes]);
  }

  async function attachPilot(pid, pilotId) {
    const slot = owned.get(Number(pid));
    if (!slot || !pilotId) return;
    if (!slot.entry.pilotIds.includes(pilotId)) slot.entry.pilotIds.push(pilotId);
    await persist();
  }

  async function detachPilot(pid, pilotId) {
    const slot = owned.get(Number(pid));
    if (!slot || !pilotId) return;
    slot.entry.pilotIds = slot.entry.pilotIds.filter((id) => id !== pilotId);
    await persist();
  }

  // Called once at startup, before any session exists. Anything still in
  // runtime.json was spawned by a cockpit process that died without running
  // shutdown() - a hard kill, a crash, or a power loss.
  async function reapOrphans() {
    const previous = await readJson(runtimePath, []);
    const entries = Array.isArray(previous) ? previous : [];
    const reaped = [];
    const skipped = [];
    const vanished = [];
    for (const entry of entries) {
      const verdict = await verifyEntry(entry, probeDeps);
      if (verdict === 'gone' || verdict === 'mismatch') {
        vanished.push(entry);
        continue;
      }
      if (verdict === 'unverifiable') {
        logImpl(`child-tracker: refusing to reap pid ${entry.pid} (${entry.provider}, ${entry.command}) - could not confirm it is still the process cockpit spawned. Kill it by hand if it is an orphan.${entry.pilotIds?.length ? ` Auto-pilots blocked until then: ${entry.pilotIds.join(', ')}.` : ''}`);
        skipped.push(entry);
        continue;
      }
      if (killProcessTree(entry.pid, probeDeps)) {
        reaped.push(entry);
      } else {
        logImpl(`child-tracker: kill failed for orphan pid ${entry.pid} (${entry.provider})`);
        skipped.push(entry);
      }
    }
    // Whatever we would not or could not kill stays recorded, so another
    // restart sees it again and its pilots stay blocked in the meantime.
    carried = skipped;
    await persist();
    return { reaped, skipped, vanished };
  }

  // Auto-pilots that must not fire because an orphan of theirs is still
  // running. Without this the two safety behaviors combine badly: after a
  // crash the in-memory concurrency lock is empty and the pilot is overdue,
  // so it fires immediately, while the reaper correctly declines to kill the
  // previous run - two unattended agents in one working tree.
  function orphanPilotIds() {
    return new Set(carried.flatMap((entry) => entry.pilotIds || []));
  }

  // Shutdown's last resort. Only touches entries THIS process owns: a
  // carried-forward orphan is by definition one we could not verify, and
  // that verdict does not change just because we are exiting.
  async function killTracked({ signal = 'SIGKILL' } = {}) {
    const killed = [];
    for (const entry of ownedEntries()) {
      if (!processExists(entry.pid, probeDeps)) continue;
      if (killProcessTree(entry.pid, { ...probeDeps, signal })) killed.push(entry);
    }
    for (const entry of killed) owned.delete(entry.pid);
    await persist();
    return killed;
  }

  return {
    runtimePath,
    retain,
    release,
    attachPilot,
    detachPilot,
    list: ownedEntries,
    runtimeEntries,
    settled,
    reapOrphans,
    orphanPilotIds,
    killTracked,
    // Awaitable flush. Every mutator above already persists, but they are all
    // called fire-and-forget from the session modules; shutdown() needs one
    // write it can actually await before process.exit(0).
    persistNow: persist,
  };
}
