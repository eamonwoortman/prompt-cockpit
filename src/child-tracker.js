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
//
// runtime.json is also per USER, not per cockpit - README.md tells you to
// start a second instance on another PORT, and both share this one file. So
// every entry records `ownerPid`/`ownerStartedAt`: which cockpit process
// spawned it, and whether that cockpit is still the process it claims to be.
// A start-time-verified pid proves "this is the CLI that was recorded"; only
// the owner field proves "and nobody is still driving it". Without it a
// second cockpit reaped the first one's live, paid sessions about a second
// into its own boot.
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { readJson, replaceJson } from './json-store.js';

// COCKPIT_RUNTIME_FILE overrides the path, exactly as COCKPIT_OPERATOR_FILE
// does for the operator token (operator-auth.js:16,62), and for the same
// reason: tests must never write into the real home directory. That matters
// more here than there - server.js exports `shutdown` and `tracker` so a test
// can drive teardown directly, and a test taking that invitation against the
// real runtime.json would run killTracked() over the developer's own live
// pids. An explicit `home` argument still wins, so callers that pass one get
// what they asked for.
export function defaultRuntimePath(home) {
  if (home === undefined) {
    const fromEnv = typeof process.env.COCKPIT_RUNTIME_FILE === 'string'
      ? process.env.COCKPIT_RUNTIME_FILE.trim()
      : '';
    if (fromEnv) return fromEnv;
  }
  return path.join(home ?? homedir(), '.prompt-cockpit', 'runtime.json');
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

// How long a shutdown-path identity probe gets. Deliberately much shorter
// than probeProcessStartTime's own 10s default: killTracked runs one of these
// per tracked process on the exit path, where the user is watching a terminal
// that will not come back until we are done. A probe that times out reads as
// 'unverifiable', which killTracked kills anyway (see its comment), so the
// short budget costs safety margin only in the pid-recycling case, never
// coverage.
const KILL_VERIFY_TIMEOUT_MS = 1500;

export function createChildTracker({
  runtimePath = defaultRuntimePath(),
  platform = process.platform,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  killImpl = (p, s) => process.kill(p, s),
  logImpl = console.error,
  ownerPid = process.pid,
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
  // Child pids reapOrphans() has already ruled on this run (killed, dropped,
  // or carried). persist() must not re-adopt them as "some other instance's"
  // just because a recycled owner pid happens to be alive.
  const adjudicated = new Set();
  // This cockpit's own OS-reported start time, filled in by a lazy probe.
  // Null until then, which another instance reads as "owner may still be
  // alive" - the safe direction.
  let ownerStartedAt = null;
  let ownerStartProbe = null;

  function ownedEntries() {
    return [...owned.values()].map(({ entry }) => entry);
  }

  function runtimeEntries() {
    return [...ownedEntries(), ...carried];
  }

  // Is this file entry owned by a DIFFERENT cockpit process, adjudicated by
  // neither of us? Those must survive our writes untouched, regardless of
  // whether that owner is still alive right now. persist() runs on every
  // retain/release and cannot afford reapOrphans()'s async start-time probe,
  // but liveness isn't actually persist()'s call to make: if we dropped a
  // foreign row the moment its owner's pid stopped responding, a cockpit that
  // crashes between our boots would have its still-running, paid CLI erased
  // from runtime.json with nothing having ever killed it - no future boot
  // would even know to look (backlog.md, 2026-09-02). So a foreign row is
  // preserved unconditionally here, exactly like a `carried` one, and left
  // for the next boot's reapOrphans() - which DOES pay for full verification
  // - to adjudicate for good.
  function belongsToAnotherInstance(entry) {
    const child = Number(entry?.pid);
    if (!Number.isInteger(child) || child <= 0) return false;
    if (adjudicated.has(child) || owned.has(child)) return false;
    const owner = Number(entry?.ownerPid);
    // No ownerPid at all means a runtime.json written by an older cockpit
    // build: it must read as reapable, not as somebody's live process.
    if (!Number.isInteger(owner) || owner <= 0 || owner === ownerPid) return false;
    return true;
  }

  // Serialized read-modify-write via json-store, NOT the whole-file rewrite
  // this originally was. The plan rejected updateJson for runtime.json on the
  // premise that "this process is the only writer of its own runtime.json";
  // that premise is false - the file is per user, and a second cockpit on
  // another PORT shares it - so a whole-file rewrite made two instances erase
  // each other's entries, turning instance A's real orphans into unreapable
  // ones the moment B exited. Everything we do not own and cannot prove dead
  // is carried through verbatim.
  //
  // json-store's per-path queue also supplies the two properties the
  // hand-rolled write chain this replaces existed for: writes stay ORDERED
  // (an out-of-order rename cannot leave the file behind the maps), and
  // `await persist()` is a COMPLETE flush of everything queued before it -
  // which is what shutdown.js relies on before process.exit(0).
  async function persist() {
    try {
      await replaceJson(runtimePath, (previous, corrupt) => {
        if (corrupt) {
          logImpl(`child-tracker: ${runtimePath} was not valid JSON - replacing it. Orphans recorded by other cockpit instances are lost.`);
        }
        const before = Array.isArray(previous) ? previous : [];
        return [...before.filter(belongsToAnotherInstance), ...runtimeEntries()];
      }, { fallback: () => [] });
    } catch (err) {
      // Losing runtime.json costs us orphan reaping on the NEXT start, which
      // is not worth failing a session launch over.
      logImpl(`child-tracker: could not write ${runtimePath}: ${String(err?.message || err)}`);
    }
  }

  // Our own start time, so another cockpit can tell "pid 1234 is still the
  // cockpit that recorded this entry" from "pid 1234 was recycled after that
  // cockpit died". Probed lazily on the first retain, never at import: a
  // cockpit (or a test) that spawns no CLI never spawns a probe either.
  function ensureOwnerStartTime() {
    if (ownerStartProbe) return ownerStartProbe;
    ownerStartProbe = probeProcessStartTime(ownerPid, probeDeps).then(async (ms) => {
      if (ms == null) return; // stays null - reads as 'owner may be alive'
      ownerStartedAt = ms;
      for (const slot of owned.values()) slot.entry.ownerStartedAt = ms;
      await persist();
    });
    probes.add(ownerStartProbe);
    ownerStartProbe.finally(() => probes.delete(ownerStartProbe)).catch(() => {});
    return ownerStartProbe;
  }

  async function retain({ pid, provider, command, pilotId = null }) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return null;
    let slot = owned.get(n);
    if (!slot) {
      ensureOwnerStartTime();
      // Recorded with osStartedAt: null RIGHT NOW, filled in when the probe
      // lands. This function is on the session-start path and must not wait
      // on a subprocess - see probeProcessStartTime's comment.
      //
      // The exposure this buys is small and bounded: for the ~500ms the probe
      // is in flight the entry has no start time, so a cockpit crash inside
      // that window leaves one entry the next start's reaper will decline to
      // kill (logged, and it blocks that pilot until killed by hand). That
      // beats stalling every session start.
      slot = {
        entry: { pid: n, provider, osStartedAt: null, command, pilotIds: [], ownerPid, ownerStartedAt },
        refs: 0,
      };
      owned.set(n, slot);
      adjudicated.add(n);
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

  // Called from BOTH the process's own 'exit'/'error' handler and its
  // explicit teardown, whichever happens first - a CLI that dies on its own
  // must not leave its entry behind for the life of the cockpit (that stale
  // entry is what made killTracked's old unverified kill dangerous). Callers
  // guard their own double-release, and an unknown pid is a no-op here, so a
  // second release cannot decrement a ref another holder still needs.
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

  // Is the cockpit process that recorded this entry still running?
  //   'none'       - no ownerPid (a runtime.json from an older build), so the
  //                  entry is reapable, exactly as it was before owners existed.
  //   'dead'       - that cockpit is provably gone; the entry is ours to reap.
  //   'alive'      - confirmed still running. Its CLIs are live sessions,
  //                  not orphans. Hands off.
  //   'maybe-alive'- alive under that pid but unconfirmable. Also hands off,
  //                  but logged differently, since this one may be a recycled
  //                  pid hiding a real orphan.
  async function ownerLiveness(entry) {
    const owner = Number(entry?.ownerPid);
    if (!Number.isInteger(owner) || owner <= 0) return 'none';
    // reapOrphans runs once, at startup, before this process has written
    // anything - so our own pid appearing as an owner means a previous
    // cockpit held the pid the OS has since handed to us. That cockpit is
    // provably gone. (Reading it as 'alive' would also disagree with
    // belongsToAnotherInstance, which drops such an entry, and the two must
    // not skip killing something and then forget it.)
    if (owner === ownerPid) return 'dead';
    const verdict = await verifyEntry({ pid: owner, osStartedAt: entry.ownerStartedAt }, probeDeps);
    if (verdict === 'match') return 'alive';
    if (verdict === 'unverifiable') return 'maybe-alive';
    return 'dead';
  }

  // Called once at startup, before any session exists. Anything still in
  // runtime.json was spawned by a cockpit process that died without running
  // shutdown() - a hard kill, a crash, or a power loss - UNLESS that cockpit
  // is still running, in which case the pid is a live session of another
  // instance and killing it would be the worst possible outcome here.
  async function reapOrphans() {
    const previous = await readJson(runtimePath, []);
    const entries = Array.isArray(previous) ? previous : [];
    const reaped = [];
    const skipped = [];
    const vanished = [];
    const foreign = [];
    for (const entry of entries) {
      // Owner first: start-time verification proves a pid IS the recorded
      // CLI, not that it is an orphan. Only this check tells those apart.
      const owner = await ownerLiveness(entry);
      if (owner === 'alive' || owner === 'maybe-alive') {
        logImpl(owner === 'alive'
          ? `child-tracker: leaving pid ${entry.pid} (${entry.provider}) alone - cockpit process ${entry.ownerPid} is still running and still owns it.`
          : `child-tracker: leaving pid ${entry.pid} (${entry.provider}) alone - something is running under its owning cockpit pid ${entry.ownerPid} and we cannot confirm whether that is still the cockpit. Kill both by hand if that cockpit is gone.`);
        // Deliberately NOT carried: carried entries block their pilots, and a
        // process another live cockpit owns is that cockpit's business, not a
        // reason to freeze our pilots. persist() preserves it in the file.
        foreign.push(entry);
        continue;
      }
      adjudicated.add(Number(entry?.pid));
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
    return { reaped, skipped, vanished, foreign };
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
  //
  // Verifies identity first, unlike the original, which skipped verifyEntry
  // on the grounds that "in THIS process the pid is known-good". That is only
  // true while no entry is stale, and a stale entry plus an OS pid recycle is
  // exactly how a `taskkill /t /f` lands on the operator's editor. The probes
  // run concurrently and on a short budget (KILL_VERIFY_TIMEOUT_MS), so the
  // whole pass costs about one probe on a path that has already slept out its
  // grace period.
  //
  // A 'mismatch' is dropped rather than killed - that pid provably is not ours
  // any more. An 'unverifiable' one is still killed: we recorded it in this
  // process and never saw it exit, and leaving a paid agent running unattended
  // is the worse of the two failures. The residual risk is therefore narrow but
  // real: a CLI that died without firing 'exit'/'error', whose pid the OS then
  // handed to something else, within one cockpit run.
  async function killTracked({ signal = 'SIGKILL', verifyTimeoutMs = KILL_VERIFY_TIMEOUT_MS } = {}) {
    const entries = ownedEntries();
    const verifyDeps = { ...probeDeps, timeoutMs: verifyTimeoutMs };
    const verdicts = await Promise.all(entries.map((entry) => verifyEntry(entry, verifyDeps)));
    const killed = [];
    const dropped = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const verdict = verdicts[i];
      if (verdict === 'gone') {
        dropped.push(entry);
        continue;
      }
      if (verdict === 'mismatch') {
        logImpl(`child-tracker: pid ${entry.pid} (${entry.provider}) is no longer the process we spawned - dropping the entry instead of killing whatever holds that pid now.`);
        dropped.push(entry);
        continue;
      }
      if (verdict === 'unverifiable') {
        logImpl(`child-tracker: could not confirm pid ${entry.pid} (${entry.provider}, ${entry.command}) is still the process we spawned; killing it anyway rather than leaving a possibly-live agent behind.`);
      }
      if (killProcessTree(entry.pid, { ...probeDeps, signal })) {
        killed.push(entry);
      } else {
        logImpl(`child-tracker: kill failed for owned process pid ${entry.pid} (${entry.provider}, ${entry.command}) - it is still running and must be killed by hand.`);
      }
    }
    for (const entry of [...killed, ...dropped]) owned.delete(entry.pid);
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

// One tracker per cockpit process, created on first use. Same shape as
// codex-app-server.js's getCodexAppServerManager/_resetCodexAppServerManager
// pair: a module-level singleton with a test reset, rather than threading a
// tracker instance through every session-creation call site.
let defaultTracker = null;

export function getChildTracker(options) {
  if (!defaultTracker) defaultTracker = createChildTracker(options);
  return defaultTracker;
}

export function _resetChildTracker() {
  defaultTracker = null;
}
