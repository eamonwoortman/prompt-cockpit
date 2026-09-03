// The auto-pilot supervisor. ONE ~15s heartbeat evaluates every pilot and
// every live run - not one timer per pilot, which would multiply the same
// bookkeeping N ways and make the concurrency cap impossible to enforce.
//
// Built as createAutopilot({...}) in the dependency-injection shape of
// createDelegation() (src/delegation.js:19): the registry, store, log,
// tracker, clock and spawn all come in as parameters, which is what makes the
// whole schedule testable against an injected clock with no CLI, no socket
// and no real ~/.prompt-cockpit.
//
// This is NOT /loop: nothing iterates inside a single conversation. Each
// firing spawns a fresh session, sends one stored prompt, and is force-closed
// when the work is done.
import { spawn, spawnSync } from 'node:child_process';
import { getProvider } from './provider-registry.js';
import { killProcessTree } from './child-tracker.js';
import { isDue, isInsideWindow } from './autopilot-schedule.js';

export const HEARTBEAT_MS = 15_000;
const GATE_STDOUT_TAIL = 200;
// Bounds precondition 5's `descriptor.isAvailable()` probe, which for grok and
// codex is a real, uncached `--version` subprocess. Round 1 review (M11): an
// unbounded await here means a probe that never settles wedges `ticking`
// forever, silently killing the whole supervisor with no further log line.
// Same order of magnitude as child-tracker.js's own probeProcessStartTime
// default.
const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

export function createAutopilot({
  registry,
  store,
  log,
  tracker,
  providers = { getProvider },
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  spawnImpl = spawn,
  logImpl = console.error,
  // Threaded through exactly like createChildTracker's own options
  // (src/child-tracker.js:191), and for the same reason (round 1 review,
  // I2): killProcessTree defaults to the REAL platform, spawnSync and
  // process.kill, and this module's gate-timeout path is the one caller that
  // was calling it with none of those overridden - a live landmine the day a
  // test finally reaches it.
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  killImpl = (p, s) => process.kill(p, s),
  providerProbeTimeoutMs = PROVIDER_PROBE_TIMEOUT_MS,
}) {
  // pilotId -> live run state. This map IS the concurrency lock: `sessionId`
  // checked against registry.get(), because the registry row knows whether a
  // session is running, blocked or idle, where a PID only proves a process
  // exists. The PID exists for killing, not locking.
  const runs = new Map();
  // pilotId -> the last skip DEDUPE KEY logged, so a windowed pilot that is
  // out-of-window for eight hours produces one log line instead of ~1900.
  // Keyed on a stable kind, not the raw reason text - see dedupeKeyFor (M8):
  // a failing gate's reason embeds up to 200 chars of the command's own
  // stdout, which can carry a timestamp/commit hash/pid that changes every
  // heartbeat and would otherwise defeat this dedup entirely.
  const lastSkipReason = new Map();
  // Terminal-outcome recording is kicked off from a SYNCHRONOUS registry
  // listener, so the async store/log writes are tracked here for tests and
  // for shutdown to await.
  const pending = new Set();
  let timer = null;
  let ticking = null;

  function track(promise) {
    const p = promise
      .catch((err) => {
        // Round 1 review (I7): logImpl itself must never be allowed to
        // throw here - an unhandled rejection under default Node settings
        // terminates the process, and would also poison a concurrent
        // drain()/stop().
        try {
          logImpl(`autopilot: ${String(err?.message || err)}`);
        } catch { /* logging must never break tracking */ }
      })
      .finally(() => pending.delete(p));
    pending.add(p);
    return p;
  }

  // Round 1 review (I7): loops to empty rather than awaiting one snapshot.
  // `onSessionRemoved` is a SYNCHRONOUS registry callback, so a session
  // removed while this is already awaiting adds a new entry to `pending`
  // after that snapshot was taken - the old single `Promise.all([...pending])`
  // never re-checked, so drain()/stop() could return (and shutdown.js reach
  // process.exit) with an outcome write still in flight. Same pattern as
  // child-tracker.js's settled() (src/child-tracker.js:356-358).
  async function drain() {
    while (pending.size) {
      await Promise.all([...pending]);
    }
  }

  function dedupeKeyFor(reason) {
    return reason.startsWith('run gate') ? 'gate' : reason;
  }

  async function skip(pilot, reason, dedupeKey = dedupeKeyFor(reason)) {
    if (lastSkipReason.get(pilot.id) === dedupeKey) return;
    lastSkipReason.set(pilot.id, dedupeKey);
    await log.append({ event: 'skipped', pilotId: pilot.id, pilotName: pilot.name, reason });
  }

  function clearSkip(pilotId) {
    lastSkipReason.delete(pilotId);
  }

  // Providers whose pilots must not fire right now. Keyed by PROVIDER: a
  // Claude plan limit says nothing about a Grok or Codex account.
  //
  // Best-effort by construction, and the spec says so: rateLimitHit is
  // cleared as soon as any non-'rejected' rate-limit event lands
  // (src/session-registry.js:843-846) and the row vanishes entirely if the
  // session then errors (:1426), so a 15-second sample can miss the window.
  //
  // A hit with `resetsAt == null` (a real SDK shape - session-registry.js:873)
  // blocks its provider INDEFINITELY here, deliberately (round 1 review,
  // M13): we cannot tell "still in effect" from "already lifted" without a
  // timestamp, and refusing to fire is the safe direction. A human's idle tab
  // holding such a flag will silently stop every pilot on that provider until
  // that tab's session ends or errors - known, not an oversight.
  function rateLimitedProviders() {
    const blocked = new Set();
    const at = now();
    for (const summary of registry.list()) {
      const hit = summary.rateLimitHit;
      if (!hit) continue;
      // A hit whose reset time has passed is stale - don't block forever on it.
      if (hit.resetsAt != null && hit.resetsAt <= at) continue;
      blocked.add(summary.provider);
    }
    return blocked;
  }

  // Bounds descriptor.isAvailable() (M11). Never rejects: a synchronous
  // throw, a rejected promise, and a probe that outlives the timeout all
  // resolve to `false`, which is already the safe (skip) direction.
  function probeAvailability(descriptor) {
    const attempt = Promise.resolve().then(() => descriptor.isAvailable()).catch(() => false);
    if (!providerProbeTimeoutMs) return attempt;
    return Promise.race([
      attempt,
      new Promise((resolve) => setTimeout(() => resolve(false), providerProbeTimeoutMs)),
    ]);
  }

  // On Windows, defers to killProcessTree's own taskkill /t walk (it already
  // handles the wrapper-process case there). On POSIX, killProcessTree only
  // ever signals the single pid it's given (src/child-tracker.js:154) - fine
  // for a directly-spawned CLI, wrong here, because the gate is spawned with
  // shell:true, so its pid is the SHELL, not the command. Killing just the
  // shell leaves the command running as an orphan, and because a gate
  // timeout does not stamp lastRunAt, the pilot stays due and spawns a fresh
  // gate next heartbeat - one orphan per timeout, forever (round 1 review,
  // I3). Killing the whole process GROUP instead requires the gate to have
  // been spawned `detached` (see runGate) so it is its own group leader.
  function killGateProcess(pid) {
    if (platform === 'win32') return killProcessTree(pid, { platform, spawnSyncImpl, killImpl });
    try {
      killImpl(-pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }

  // Arbitrary shell from the operator's own config file, on a schedule. This
  // is a deliberate, stated risk (spec Risks #2) - precedented by Claude
  // Code's own `hooks` key - which is why it runs with the pilot's cwd, a
  // hard timeout, and windowsHide, and why its output only ever becomes a
  // skip reason.
  function runGate(pilot) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawnImpl(pilot.gate.command, {
          cwd: pilot.cwd,
          shell: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // A new process group on POSIX only, so a timeout can kill the
          // whole group rather than just the shell (see killGateProcess/I3).
          // Windows already gets a full tree walk via taskkill /t.
          detached: platform !== 'win32',
        });
      } catch (err) {
        resolve({ ok: false, reason: `run gate failed to start: ${String(err?.message || err)}` });
        return;
      }
      let out = '';
      const collect = (chunk) => {
        out += String(chunk);
        if (out.length > 8000) out = out.slice(-4000);
      };
      proc.stdout?.on('data', collect);
      proc.stderr?.on('data', collect);

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(result);
      };
      const timeoutHandle = setTimeout(() => {
        killGateProcess(proc.pid);
        finish({ ok: false, reason: `run gate timed out after ${pilot.gate.timeoutMs}ms` });
      }, pilot.gate.timeoutMs);

      proc.on('error', (err) => finish({ ok: false, reason: `run gate failed: ${String(err?.message || err)}` }));
      proc.on('exit', (code) => {
        if (code === 0) return finish({ ok: true });
        const tail = out.trim().slice(-GATE_STDOUT_TAIL);
        finish({ ok: false, reason: `run gate exited ${code}${tail ? `: ${tail}` : ''}` });
      });
    });
  }

  // Preconditions 4, 8a, 7, 8b, 5, 6 - cheapest first, NOT the spec's own
  // numbering (deliberate). Returns null when the pilot may fire, or a skip
  // reason string. Preconditions 1-3 (enabled, due, window) are handled by
  // the caller, because runNow bypasses 2 and 3.
  //
  // Round 1 review (M12) moved 5 (provider availability) after 7 and 8b: the
  // brief's original ordering (4 -> 8a -> 5 -> 7 -> 8b -> 6) claimed the gate
  // was "the only precondition that costs a subprocess", which is false -
  // descriptor.isAvailable() spawns a real uncached `--version` for grok and
  // codex. A due-but-rate-limited-or-capped pilot was probing the CLI's
  // version every 15 seconds to learn something it did not need. Same set,
  // now actually cheapest-first.
  async function blockingReason(pilot, settings, { dailySpend, rateLimited }) {
    // 4 - lock free, and no unreaped orphan for this pilot.
    if (runs.has(pilot.id)) return 'already running';
    if (tracker.orphanPilotIds().has(pilot.id)) {
      return 'an orphaned CLI process from a previous run could not be reaped - kill it by hand, then this pilot resumes';
    }
    // 8a - concurrency (checked before the async provider probe, it's free).
    if (runs.size >= settings.maxConcurrentRuns) {
      return `at the concurrent-run limit (${settings.maxConcurrentRuns})`;
    }
    // 7 - rate limit, keyed by provider. Free (in-memory), so it runs before
    // the provider probe.
    if (rateLimited.has(pilot.provider)) return `${pilot.provider} is rate limited`;
    // 8b - global daily spend cap. A precondition ONLY: it never kills a run
    // in flight, because killing an agent mid-edit to save a few cents trades
    // a small cost for a broken working tree. Also free - dailySpend is
    // computed once per heartbeat in evaluate().
    if (settings.dailyCostCapUsd != null && dailySpend >= settings.dailyCostCapUsd) {
      return `global daily spend cap reached ($${dailySpend.toFixed(2)} / $${settings.dailyCostCapUsd.toFixed(2)})`;
    }
    // 5 - provider available and effort valid for it. Without this a Grok
    // pilot on a machine with no Grok CLI fires straight into an error. Last
    // of the free checks to run, since it is the actually-expensive one.
    let descriptor;
    try {
      descriptor = providers.getProvider(pilot.provider);
    } catch (err) {
      return `unknown provider "${pilot.provider}"`;
    }
    const available = await probeAvailability(descriptor);
    if (!available) return `${descriptor.label} is not available on this machine`;
    if (pilot.effort && !descriptor.efforts.includes(pilot.effort)) {
      return `effort "${pilot.effort}" is not valid for ${descriptor.label}`;
    }
    // 6 - run gate, last: it is the one precondition definitely worth paying
    // for last, since it spawns a whole subprocess and can run for minutes.
    if (pilot.gate) {
      const gate = await runGate(pilot);
      if (!gate.ok) return gate.reason;
    }
    return null;
  }

  async function fire(pilot, reason, settings) {
    // Round 1 review (C1) - THE fix: claim the slot SYNCHRONOUSLY, with no
    // `await` between this check and the mutation that records it.
    // blockingReason's own checks of `runs` are necessarily stale by the
    // time it returns (it awaits a real subprocess - isAvailable(), and for
    // a gated pilot, a gate that can run for up to 10 minutes), so two
    // overlapping calls (two "Run now" clicks, or a runNow racing an
    // in-flight heartbeat) could both read the lock as free and both reach
    // here. Whichever call's synchronous continuation runs first wins the
    // reservation; the other bails on the line below, before it has done
    // anything observable. Returns the 'locked' sentinel (rather than null,
    // which also means "createSession failed") so runNow can report the
    // loser's actual reason instead of the misleading "could not be created".
    if (runs.has(pilot.id)) return 'locked';
    if (settings && runs.size >= settings.maxConcurrentRuns) return 'locked';
    runs.set(pilot.id, {
      pilotId: pilot.id,
      sessionId: null,
      trackedPid: null,
      startedAt: now(),
      lastProgressAt: now(),
      scannedThrough: 0,
      sawResult: false,
      blockedLogged: false,
      intendedOutcome: null,
    });

    let row;
    // The row is named after the pilot so /ask can address it, falling back
    // to unnamed if a hand-driven session already holds that name in that
    // cwd. A name collision must not fail the firing.
    for (const name of [pilot.name, null]) {
      try {
        row = registry.createSession({
          cwd: pilot.cwd,
          provider: pilot.provider,
          model: pilot.model || undefined,
          effort: pilot.effort || undefined,
          permissionMode: pilot.mode,
          name,
        });
        break;
      } catch (err) {
        if (err.code === 'ERR_NAME_TAKEN' && name !== null) continue;
        // Anything else (bad cwd, unknown provider, a CLI that refuses to
        // start) is a real failure. Release the reservation, and stamp
        // lastRunAt so the pilot backs off instead of retrying every 15
        // seconds forever.
        //
        // Round 1 review (I5): the STORE write is the safety property that
        // stops the spawn loop, so it happens first and unconditionally. The
        // log line is observability only - if it fails too (an unwritable or
        // full ~/.prompt-cockpit), that must not undo the back-off that was
        // just recorded.
        runs.delete(pilot.id);
        const at = now();
        await recordOutcome(pilot.id, 'errored', at);
        try {
          await log.append({
            event: 'errored', pilotId: pilot.id, pilotName: pilot.name,
            reason: String(err?.message || err),
          });
        } catch (logErr) {
          logImpl(`autopilot: failed to log an errored outcome for ${pilot.name}: ${String(logErr?.message || logErr)}`);
        }
        return null;
      }
    }

    // Deliberately NOT seedSessionDefaults(): a pilot carries its own
    // model/effort/mode and has no thinking/auto-continue fields, so reading
    // the cwd's persisted session-defaults here would let two pilots in one
    // folder clobber each other - the same reasoning as the rewind route
    // passing explicit defaults (src/routes/sessions.js:21-27).

    const pid = row.handle?.trackedPid ?? null;
    if (pid != null) await tracker.attachPilot(pid, pilot.id);

    runs.set(pilot.id, {
      pilotId: pilot.id,
      sessionId: row.id,
      trackedPid: pid,
      startedAt: now(),
      lastProgressAt: now(),
      scannedThrough: 0,
      sawResult: false,
      blockedLogged: false,
      intendedOutcome: null,
    });
    clearSkip(pilot.id);
    // Round 1 review (I5): the log line is observability, not the safety
    // property - a failure here must not strand a started, billing session
    // that never got its prompt. sendInput below always runs regardless.
    try {
      await log.append({ event: 'fired', pilotId: pilot.id, pilotName: pilot.name, sessionId: row.id, reason });
    } catch (err) {
      logImpl(`autopilot: failed to log a 'fired' event for ${pilot.name}: ${String(err?.message || err)}`);
    }
    // One stored prompt, sent verbatim on every firing. It may itself be a
    // slash command.
    registry.sendInput(row.id, pilot.prompt).catch((err) => {
      logImpl(`autopilot: sendInput failed for ${pilot.name}: ${String(err?.message || err)}`);
    });
    return row;
  }

  // Task 6 replaces this stub with the full terminal-outcome table.
  async function recordOutcome(pilotId, outcome, at) {
    await store.recordRun(pilotId, { lastRunAt: at, lastOutcome: outcome, consecutiveFailures: 1 });
  }

  // Task 6 replaces this stub with completion / stall / blocked handling.
  async function reviewRuns(_pilotsById) {}

  async function evaluate() {
    const { settings, pilots } = await store.read();
    const pilotsById = new Map(pilots.map((p) => [p.id, p]));
    await reviewRuns(pilotsById);

    const { costUsd: dailySpend } = await log.dailyCostUsd(now());
    const rateLimited = rateLimitedProviders();
    const at = now();

    for (const pilot of pilots) {
      try {
        // 1 - enabled, and 2 - due (including failure back-off). Neither is
        // logged: "not due" is the normal state of every pilot most of the
        // time.
        if (!pilot.enabled) continue;
        if (!isDue(pilot, at)) continue;
        // 3 - inside the active window. Logged, but deduped by skip().
        if (!isInsideWindow(pilot.schedule.window, at)) {
          await skip(pilot, 'outside its active window');
          continue;
        }
        const reason = await blockingReason(pilot, settings, { dailySpend, rateLimited });
        if (reason) {
          await skip(pilot, reason);
          continue;
        }
        await fire(pilot, 'schedule', settings);
        // Startup stagger: at most ONE overdue pilot per heartbeat. Without
        // this, a cockpit restarted after an hour launches every pilot
        // simultaneously.
        return;
      } catch (err) {
        // Round 1 review (I4): store.read() deliberately does not normalize
        // records (autopilot-store.js's hydrate() returns raw.pilots
        // verbatim - hand-edited files are an anticipated state), so a
        // malformed record (e.g. missing `schedule`) throwing here must not
        // abandon every pilot ordered after it for the life of the process.
        // One bad record is skipped and logged once; its neighbours are
        // unaffected.
        try {
          await skip(pilot, `could not evaluate this pilot: ${String(err?.message || err)}`, 'malformed-record');
        } catch (logErr) {
          logImpl(`autopilot: failed to log a malformed pilot record (${pilot?.id}): ${String(logErr?.message || logErr)}`);
        }
      }
    }
  }

  function tick() {
    // Never overlap: a heartbeat that runs long (a slow gate command) must
    // not have a second one start firing the same pilot behind it.
    if (ticking) return ticking;
    ticking = evaluate()
      .catch((err) => logImpl(`autopilot heartbeat failed: ${String(err?.message || err)}`))
      .finally(() => { ticking = null; });
    return ticking;
  }

  function onSessionRemoved({ id, reason }) {
    for (const [pilotId, run] of runs) {
      if (run.sessionId !== id) continue;
      runs.delete(pilotId);
      if (run.trackedPid != null) track(tracker.detachPilot(run.trackedPid, pilotId));
      // 'error' is a genuine failure; a bare 'closed' we did not ask for is a
      // human closing the pilot's session in an attached tab - intentional,
      // not a failure.
      const outcome = run.intendedOutcome || (reason === 'error' ? 'errored' : 'closed-externally');
      track(finishRun(pilotId, run, outcome));
      return;
    }
  }

  // Task 6 fills this in.
  async function finishRun(pilotId, run, outcome) {
    await recordOutcome(pilotId, outcome, now());
  }

  async function runNow(pilotId) {
    const { settings } = await store.read();
    const pilot = await store.getPilot(pilotId);
    if (!pilot) return { fired: false, reason: `unknown pilot: ${pilotId}` };
    // run-now bypasses preconditions 2 and 3 (due-ness and the window) but
    // honours 4-8 - the safety ones.
    if (!pilot.enabled) return { fired: false, reason: 'this pilot is disabled' };
    const { costUsd: dailySpend } = await log.dailyCostUsd(now());
    const reason = await blockingReason(pilot, settings, { dailySpend, rateLimited: rateLimitedProviders() });
    if (reason) {
      await skip(pilot, reason);
      return { fired: false, reason };
    }
    const row = await fire(pilot, 'run-now', settings);
    if (row === 'locked') return { fired: false, reason: 'already running' };
    return row ? { fired: true, sessionId: row.id } : { fired: false, reason: 'the session could not be created' };
  }

  // Registered in the CONSTRUCTOR, not in start(): a row can be removed at any
  // time, including between a stop() and the next start(), and a supervisor
  // that only learns about removals while its timer happens to be armed would
  // silently lose the outcome. It also means a test can drive tick() directly
  // without arming a real interval.
  registry.setSessionRemovedListener(onSessionRemoved);

  function start() {
    if (timer) return;
    timer = setIntervalImpl(() => { tick(); }, HEARTBEAT_MS);
  }

  async function stop() {
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    // Round 1 review (I6): deliberately does NOT unregister the removal
    // listener. The comment above registers it in the constructor precisely
    // because a row can be removed at any time, including between a stop()
    // and the next start() - clearing it here defeated that. A run that
    // finishes while stopped (or across a stop()/start() cycle) still needs
    // its terminal outcome recorded and its lock released, or that pilot
    // never fires again and status() shows it running forever. (A future
    // approval interceptor genuinely does need to be torn down here, because
    // it changes live session behaviour - the removal listener does not.)
    if (ticking) await ticking;
    await drain();
  }

  function status() {
    return [...runs.values()].map((run) => ({
      pilotId: run.pilotId,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      sawResult: run.sawResult,
      blocked: run.blockedLogged,
    }));
  }

  return { start, stop, tick, runNow, status, drain, _runs: runs };
}
