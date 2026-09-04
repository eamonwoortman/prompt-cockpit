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
import { buildAutoAnswer } from './autopilot-answer.js';

export const HEARTBEAT_MS = 15_000;
// Five failures in a row is a broken configuration, not bad luck. Disabling
// is actionable - a human must re-enable it - so it also raises a bell entry.
export const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_OUTCOMES = new Set(['timed-out', 'errored']);
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
  // Round 2 review (Important-2): probeAvailability's timeout used the
  // global setTimeout directly, with no clearTimeout on the winning path and
  // no way for a test to drive it without a real delay. Threaded the same
  // way setIntervalImpl/clearIntervalImpl already are.
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  // pilotId -> live run state. This map IS the concurrency lock: `sessionId`
  // checked against registry.get(), because the registry row knows whether a
  // session is running, blocked or idle, where a PID only proves a process
  // exists. The PID exists for killing, not locking.
  const runs = new Map();
  // Pilot records as of the last heartbeat. The approval interceptor has to
  // be synchronous, so it cannot await store.getPilot().
  const pilotCache = new Map();
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
  // Round 2 review (Important-3): the gates spawned by runGate() are
  // recorded here for the DURATION of the run, so stop() can kill any still
  // in flight. Needed because `detached: true` (round 1, I3) took the gate
  // out of the cockpit's own process group so a terminal Ctrl-C no longer
  // reaches it - closing that window without reverting detached means this
  // module has to track and kill its own gates itself.
  const inFlightGates = new Set();
  // Round 1 review (I2, fold-in M9): pilotIds settled - by ANY route, not
  // just reviewRuns' own closeSession calls - during the current evaluate()
  // pass. onSessionRemoved fires synchronously on every removal, including
  // one caused by an SDK error while THIS SAME tick's main loop is still
  // awaiting a gated pilot's blockingReason() (which can run for minutes),
  // so populating it there rather than only in reviewRuns is what covers
  // that path too. Cleared at the top of evaluate(), read by its main loop.
  const settledThisTick = new Set();
  let timer = null;
  let ticking = null;
  // Round 3 review (New-1): set at the top of stop(), before the in-flight
  // gate kill loop. Killing a gate UNBLOCKS the evaluate() await that was
  // stuck on it rather than stopping it, so without this latch the heartbeat
  // would resume and carry on to the next pilot - creating an unattended
  // session, or spawning a fresh detached gate, during shutdown. Reset by
  // start() so a stop()/start() cycle (already covered by I6) fully resumes
  // normal firing, not just the timer.
  let stopping = false;

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
    // pilot can be null here (round 2 review, cheap item 4): a hand-edited
    // store can hold a bare `null` entry in `pilots`, and evaluate()'s catch
    // calls skip(pilot, ...) with that same null to report it. `pilot?.`
    // throughout is what keeps that report itself from throwing - which,
    // before this, meant a null entry re-logged every 15 seconds forever,
    // with no dedupe possible.
    const pilotId = pilot?.id ?? null;
    if (lastSkipReason.get(pilotId) === dedupeKey) return;
    lastSkipReason.set(pilotId, dedupeKey);
    await log.append({ event: 'skipped', pilotId, pilotName: pilot?.name ?? null, reason });
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
  //
  // Round 2 review (Important-2): the timeout handle is now captured and
  // ALWAYS cleared, on both the winning and losing path - the previous
  // version left a live, ref'd global setTimeout behind on every probe that
  // resolved before the timeout, which is every probe in every test that
  // reaches this line, and it also used the real setTimeout rather than the
  // injected setTimeoutImpl, so no test could drive the timeout itself
  // without a real delay.
  function probeAvailability(descriptor) {
    const attempt = Promise.resolve().then(() => descriptor.isAvailable()).catch(() => false);
    if (!providerProbeTimeoutMs) return attempt;
    let timeoutHandle;
    const timedOut = new Promise((resolve) => {
      timeoutHandle = setTimeoutImpl(() => resolve(false), providerProbeTimeoutMs);
    });
    return Promise.race([attempt, timedOut]).finally(() => clearTimeoutImpl(timeoutHandle));
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
    // Round 3 review (cheap item 1): killProcessTree's own POSIX branch
    // guards against a non-positive pid (child-tracker.js:146-147);
    // this one didn't. -0 === 0, and process.kill(0, sig) signals the
    // CALLER's own process group, not a stray target. Unreachable from a
    // real spawn() today, but this module's sibling refuses to guess about
    // pids on principle, and the guard is one line.
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
      killImpl(-n, 'SIGKILL');
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
      // Round 3 review (New-1): refuse to spawn once shutdown is draining.
      // evaluate()'s own loop-level check is what stops it from reaching a
      // later pilot in practice, but runNow() reaches blockingReason (and
      // through it, runGate) directly, bypassing that loop entirely - so the
      // guard has to live here too, not only at the call site.
      if (stopping) {
        resolve({ ok: false, reason: 'run gate skipped: autopilot is stopping' });
        return;
      }
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

      // Tracked from spawn to settle so stop() can reach it (Important-3).
      const inFlight = { pid: proc.pid, finish: null };
      inFlightGates.add(inFlight);

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        inFlightGates.delete(inFlight);
        resolve(result);
      };
      inFlight.finish = finish;
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
  //
  // Round 2 review (M12 label hoist): resolving the provider DESCRIPTOR
  // (as opposed to probing its availability) is synchronous and free, so it
  // moved back above 7/8b - only the actually-expensive
  // `await probeAvailability()` call, and the effort check that depends on
  // its result, stay below. This keeps descriptor.label available for the
  // rate-limit message (every other skip message in this chain already uses
  // it) without reintroducing the every-15-seconds version probe that M12
  // eliminated. Two accepted side effects: an unknown-provider pilot that is
  // also rate-limited reports the unknown provider first (more actionable),
  // and the free `efforts.includes` check effectively moved up alongside it.
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
    // Provider descriptor resolution is synchronous (unlike isAvailable()),
    // so it costs nothing to do here, ahead of the rate-limit/spend-cap
    // checks - see the M12 label hoist comment above.
    let descriptor;
    try {
      descriptor = providers.getProvider(pilot.provider);
    } catch (err) {
      return `unknown provider "${pilot.provider}"`;
    }
    // 7 - rate limit, keyed by provider. Free (in-memory), so it runs before
    // the provider probe.
    if (rateLimited.has(pilot.provider)) return `${descriptor.label} is rate limited`;
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
    // Round 3 review (New-1): refuse to start new work once shutdown is
    // draining - same reasoning as the guard in runGate() above. Checked
    // before the reservation is claimed, so a fire() reached during shutdown
    // costs nothing observable (no session, no lock). Fold-in item 7: a
    // distinct sentinel, same reasoning as 'locked' below - null also means
    // "createSession failed", which is not what happened here.
    if (stopping) return 'stopping';
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
          // Round 3 review (cheap item 3): logImpl itself must never be
          // allowed to throw here either - track()'s own catch already
          // wraps it for exactly this reason, and the back-off write above
          // has already happened, so a throwing logImpl must not undo it.
          try {
            logImpl(`autopilot: failed to log an errored outcome for ${pilot.name}: ${String(logErr?.message || logErr)}`);
          } catch { /* logging must never break the reservation release */ }
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
    if (pid != null) {
      try {
        await tracker.attachPilot(pid, pilot.id);
      } catch (err) {
        // Round 2 review (Important-1): the entry at :294 is still the
        // PLACEHOLDER here (sessionId: null) - letting this throw propagate
        // would leave exactly that placeholder in `runs` forever, wedging
        // this pilot behind a lock nothing can release while a real,
        // never-prompted session sits live and untracked. Release the
        // reservation and close the session we just created rather than
        // leak either one - the invariant this module now holds is that
        // every exit from fire() either records a real run or releases the
        // reservation, with no third state.
        runs.delete(pilot.id);
        try {
          registry.closeSession(row.id);
        } catch { /* best effort - releasing the reservation is what matters */ }
        // Round 3 review (cheap item 3): same reasoning as the errored-outcome
        // logImpl above - the reservation is already released by this point.
        try {
          logImpl(`autopilot: failed to attach ${pilot.name}'s process to the tracker, closing its untracked session: ${String(err?.message || err)}`);
        } catch { /* logging must never break the reservation release */ }
        return null;
      }
    }

    runs.set(pilot.id, {
      pilotId: pilot.id,
      sessionId: row.id,
      trackedPid: pid,
      startedAt: now(),
      lastProgressAt: now(),
      scannedThrough: 0,
      lastSeq: row.eventLog.nextSeq,
      sawResult: false,
      blockedLogged: false,
      intendedOutcome: null,
    });
    pilotCache.set(pilot.id, pilot);
    clearSkip(pilot.id);
    // Round 1 review (I5): the log line is observability, not the safety
    // property - a failure here must not strand a started, billing session
    // that never got its prompt. sendInput below always runs regardless.
    try {
      await log.append({ event: 'fired', pilotId: pilot.id, pilotName: pilot.name, sessionId: row.id, reason });
    } catch (err) {
      // Round 3 review (cheap item 3): same reasoning again - sendInput below
      // must run regardless of whether this logImpl call itself throws.
      try {
        logImpl(`autopilot: failed to log a 'fired' event for ${pilot.name}: ${String(err?.message || err)}`);
      } catch { /* logging must never break the prompt send below */ }
    }
    // One stored prompt, sent verbatim on every firing. It may itself be a
    // slash command.
    registry.sendInput(row.id, pilot.prompt).catch((err) => {
      // Round 3 review (cheap item 3) pattern, applied here too: this is a
      // floating promise, so a throw out of logImpl would become an
      // unhandled rejection - which terminates the process under default
      // Node settings.
      try {
        logImpl(`autopilot: sendInput failed for ${pilot.name}: ${String(err?.message || err)}`);
      } catch { /* logging must never break the floating promise */ }
    });
    return row;
  }

  // The four terminal outcomes and their differing effect on the record.
  // `closed-externally` deliberately resets the failure count: a human
  // closing a pilot's session in an attached tab is intentional.
  async function recordOutcome(pilotId, outcome, at) {
    const pilot = await store.getPilot(pilotId);
    if (!pilot) return null;
    const failures = FAILURE_OUTCOMES.has(outcome) ? (pilot.consecutiveFailures || 0) + 1 : 0;
    const patch = { lastRunAt: at, lastOutcome: outcome, consecutiveFailures: failures };
    if (failures >= MAX_CONSECUTIVE_FAILURES) patch.enabled = false;
    const updated = await store.recordRun(pilotId, patch);
    if (patch.enabled === false) {
      // The store write above already landed - a throwing logImpl here must
      // not be mistaken for the disable itself having failed.
      try {
        logImpl(`autopilot: "${pilot.name}" auto-disabled after ${failures} consecutive failures`);
      } catch { /* logging must never break the caller */ }
    }
    return updated;
  }

  // One pass over every live run, before any new firing. Reads the row's
  // event log for BOTH signals it needs: nextSeq advancing is progress, and a
  // `result` message means the session actually produced something.
  //
  // Why the event log rather than row fields: nextSeq is monotonic and
  // unaffected by byte-cap eviction (src/event-log.js:30-34), and the priming
  // sentinel's own result is swallowed inside session.js
  // (src/session.js:388-397) and never reaches the registry, so any result
  // visible here is real. No row field counts results, which is why sawResult
  // lives on the supervisor's own run state instead.
  async function reviewRuns(pilotsById) {
    // Task 6 own finding: onSessionRemoved (fired synchronously by
    // closeSession below) frees `runs`' lock immediately, but recordOutcome's
    // disk write (stamping lastRunAt) happens after, via a fire-and-forget
    // track()ed promise. evaluate()'s own `pilots` array was already read
    // from disk before this function ran, so a pilot closed HERE still shows
    // lastRunAt: null to that stale array, and isDue() treats a null
    // lastRunAt as always-due - without settledThisTick, evaluate()'s main
    // loop would re-fire the same pilot again in this same tick. Populated by
    // onSessionRemoved itself (below), not here, so it also catches a
    // removal this function did not cause.
    for (const [pilotId, run] of [...runs]) {
      const row = registry.get(run.sessionId);
      if (!row) continue; // onSessionRemoved already classified it
      const pilot = pilotsById.get(pilotId);
      if (!pilot) continue; // deleted mid-run; the DELETE route force-closes it

      // Ruling F1: fire()'s own eager `row.handle?.trackedPid` read is null
      // for every provider at that instant - Grok assigns it inside an async
      // IIFE behind a getter, and Codex freezes a null pid at session start
      // on a cold app-server. Re-read it on every pass until it appears, and
      // attach it to the tracker exactly once: setting run.trackedPid before
      // the await (whether attachPilot resolves or rejects) is what stops a
      // later pass from re-attaching the same pid, and onSessionRemoved's
      // existing `if (run.trackedPid != null) detachPilot(...)` then balances
      // it without any change there.
      if (run.trackedPid == null) {
        const pid = row.handle?.trackedPid ?? null;
        if (pid != null) {
          run.trackedPid = pid;
          try {
            await tracker.attachPilot(pid, pilotId);
          } catch (err) {
            // Defence-in-depth: attachPilot cannot actually reject today
            // (child-tracker.js's persist() swallows its own errors), but a
            // rejection here must not corrupt run state or throw out of
            // reviewRuns and kill the heartbeat.
            try {
              logImpl(`autopilot: failed to attach ${pilot.name}'s process to the tracker: ${String(err?.message || err)}`);
            } catch { /* logging must never break the heartbeat */ }
          }
        }
      }

      // I3: cached on every pass, not just the settle branches below, so
      // finishRun still has a recent figure when the run is removed via a
      // path (an SDK error, a human closing the tab) that never reaches
      // those branches at all - onSessionRemoved fires with the row already
      // deleted from the registry (session-registry.js's removeSession runs
      // before the listener), so there is no usageAcc left to read by then.
      run.lastUsage = row.usageAcc?.snapshot?.() || run.lastUsage || {};

      for (const { seq, message } of row.eventLog.entries) {
        if (seq <= run.scannedThrough) continue;
        run.scannedThrough = seq;
        if (message && message.type === 'result') run.sawResult = true;
      }
      if (row.eventLog.nextSeq !== run.lastSeq) {
        run.lastSeq = row.eventLog.nextSeq;
        run.lastProgressAt = now();
      }

      // Blocked on a human: exempt from the stall backstop entirely, logged
      // once, and it KEEPS the lock. A session waiting on an approval is not
      // a runaway.
      if (row.pendingApprovals.length > 0) {
        if (!run.blockedLogged) {
          run.blockedLogged = true;
          try {
            await log.append({
              event: 'blocked', pilotId, pilotName: pilot.name, sessionId: run.sessionId,
              reason: `waiting on approval for ${row.pendingApprovals[0]?.toolName || 'a tool call'}`,
            });
          } catch (err) {
            // blockedLogged is already latched above - a rejection here must
            // lose only the observability line, not abort review of every
            // remaining run in this pass.
            try {
              logImpl(`autopilot: failed to log a 'blocked' event for ${pilot.name}: ${String(err?.message || err)}`);
            } catch { /* logging must never break review of the remaining runs */ }
          }
        }
        continue;
      }
      // I2: nothing but sdk:message traffic advances nextSeq (line 600-603
      // above), and resolveApproval pushes nothing into the event log when a
      // human answers - so without this, lastProgressAt is still whatever it
      // was when the run first blocked. A pilot answered after sitting
      // blocked for longer than maxTurnStallMs (default 60 minutes; an
      // overnight `inputPolicy: 'ask'` pilot is the intended use case) would
      // otherwise be force-closed as timed-out on the very next heartbeat,
      // discarding the answer and counting a failure against it. Reset only
      // on the blocked -> unblocked transition (blockedLogged was true), so
      // a genuinely stalled, never-blocked run is not exempted.
      if (run.blockedLogged) run.lastProgressAt = now();
      run.blockedLogged = false;

      // Completion. The "at least one result" clause is load-bearing: a
      // freshly created row is idle before the prompt lands.
      const idle = row.state === 'idle';
      const quiet = (row.queue || []).length === 0;
      if (idle && quiet && run.sawResult) {
        const usage = row.usageAcc?.snapshot?.() || {};
        run.costUsd = typeof usage.costUsd === 'number' ? usage.costUsd : null;
        run.costUnpriced = Array.isArray(usage.unpriced) && usage.unpriced.length > 0;
        // Set the intended outcome BEFORE closing: closeSession fires the
        // removal listener synchronously, which would otherwise classify our
        // own completion as closed-externally.
        run.intendedOutcome = 'finished';
        try {
          registry.closeSession(run.sessionId);
        } catch (err) {
          // Unlike fire()'s reservation leak, there is nothing to release
          // here - the run stays locked and intendedOutcome stays 'finished',
          // so the very next pass finds the same idle/quiet/sawResult state
          // and retries the close. What must not happen is this exception
          // aborting review of every OTHER run still left in this pass.
          try {
            logImpl(`autopilot: failed to close ${pilot.name}'s completed session, will retry next heartbeat: ${String(err?.message || err)}`);
          } catch { /* logging must never break review of the remaining runs */ }
        }
        continue;
      }

      // Runaway backstop, NOT a hang detector - with the signals available an
      // in-flight tool call is indistinguishable from a hang, so this is set
      // generously (60 minutes by default) and only exists to stop a pilot
      // burning money forever.
      if (now() - run.lastProgressAt >= pilot.maxTurnStallMs) {
        const usage = row.usageAcc?.snapshot?.() || {};
        run.costUsd = typeof usage.costUsd === 'number' ? usage.costUsd : null;
        run.costUnpriced = Array.isArray(usage.unpriced) && usage.unpriced.length > 0;
        run.reason = `no new events for ${Math.round(pilot.maxTurnStallMs / 60_000)} minutes`;
        run.intendedOutcome = 'timed-out';
        try {
          registry.closeSession(run.sessionId);
        } catch (err) {
          try {
            logImpl(`autopilot: failed to close ${pilot.name}'s stalled session, will retry next heartbeat: ${String(err?.message || err)}`);
          } catch { /* logging must never break review of the remaining runs */ }
        }
      }
    }
  }

  async function evaluate() {
    const { settings, pilots } = await store.read();
    // Round 2 review (cheap item 4): a bare `null` in `pilots` (hand-edited
    // store) must not crash HERE - this line runs before the per-pilot
    // try/catch in the loop below even exists, so an unguarded `p.id` threw
    // out of evaluate() entirely, on every heartbeat, for every pilot, not
    // just the null one.
    const pilotsById = new Map(pilots.filter((p) => p && p.id).map((p) => [p.id, p]));
    pilotCache.clear();
    for (const [id, pilot] of pilotsById) pilotCache.set(id, pilot);
    // Cleared here, not carried over from the previous tick - see the
    // declaration comment by settledThisTick's definition.
    settledThisTick.clear();
    await reviewRuns(pilotsById);

    const { costUsd: dailySpend } = await log.dailyCostUsd(now());
    const rateLimited = rateLimitedProviders();
    const at = now();

    for (const pilot of pilots) {
      // Round 3 review (New-1): bail rather than continue once stop() is
      // draining. Killing an in-flight gate from stop() UNBLOCKS whichever
      // pilot's blockingReason() was awaiting it rather than stopping the
      // heartbeat, so without this check the loop below would carry on to
      // the NEXT pilot - creating an unattended session, or spawning a fresh
      // detached gate, after stop()'s kill loop already ran. Checked at the
      // top of every iteration so it also catches the pilot whose gate was
      // just killed once it falls through to its own skip()+continue below.
      if (stopping) return;
      try {
        // 1 - enabled, and 2 - due (including failure back-off). Neither is
        // logged: "not due" is the normal state of every pilot most of the
        // time.
        if (!pilot.enabled) continue;
        // Just settled by reviewRuns() above, this same tick: the disk write
        // recording its outcome hasn't landed yet, so the `pilots` array
        // above still shows a stale lastRunAt and would otherwise look due.
        if (settledThisTick.has(pilot.id)) continue;
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
        // blockingReason's own probe/gate awaits are exactly where stop()
        // can interleave and flip this pilot's OWN reason to null - recheck
        // right before firing, not just at the top of the next iteration.
        if (stopping) return;
        // Fold-in M9: blockingReason() can await for minutes (a gated
        // pilot), during which THIS pilot's own run can be removed - an SDK
        // error, a human closing the tab - which frees runs' lock via
        // onSessionRemoved. fire()'s own lock check would then see the lock
        // as free and fire a second session for the run that JUST ended.
        // settledThisTick is only checked once at the top of this iteration
        // otherwise, so it must be rechecked here too, same reasoning as the
        // `stopping` recheck immediately above.
        if (settledThisTick.has(pilot.id)) continue;
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

  // Synchronous by contract (see setApprovalInterceptor's comment in
  // session-registry.js). Everything it needs is already in memory: the run
  // map keyed by sessionId, and the pilot record cached each heartbeat.
  function onApprovalRequest({ row, request }) {
    // Scoped to pilot-owned rows: this is ONE process-global hook, and an
    // unscoped interceptor would silently auto-answer questions in
    // hand-driven sessions.
    const run = [...runs.values()].find((r) => r.sessionId === row.id);
    if (!run) return null;
    const pilot = pilotCache.get(run.pilotId);
    if (!pilot) return null;
    // The input policy governs AskUserQuestion ONLY. Tool permissions stay
    // governed by the pilot's permission mode, and end-of-plan approval is
    // never auto-approved.
    if (request.toolName !== 'AskUserQuestion') return null;
    if (pilot.inputPolicy !== 'recommended') return null;
    // Claude-only: AskUserQuestion exists nowhere else. Grok uses ACP
    // permission options (src/grok-session.js:377-387) and Codex uses
    // app-server approval methods (src/codex-session.js:150). The form hides
    // the field for those providers; this is the backstop for a hand-edited
    // autopilots.json.
    if (pilot.provider !== 'claude') return null;

    const answer = buildAutoAnswer(request.input);
    if (!answer) return null;
    track(log.append({
      event: 'answered',
      pilotId: pilot.id,
      pilotName: pilot.name,
      sessionId: row.id,
      answered: answer.chosen,
    }));
    return answer.decision;
  }

  function onSessionRemoved({ id, reason }) {
    for (const [pilotId, run] of runs) {
      if (run.sessionId !== id) continue;
      runs.delete(pilotId);
      // Fold-in M9: every removal populates this, not just the ones
      // reviewRuns() itself causes - see settledThisTick's declaration
      // comment for why that generalisation matters.
      settledThisTick.add(pilotId);
      if (run.trackedPid != null) track(tracker.detachPilot(run.trackedPid, pilotId));
      // 'error' is a genuine failure; a bare 'closed' we did not ask for is a
      // human closing the pilot's session in an attached tab - intentional,
      // not a failure.
      const outcome = run.intendedOutcome || (reason === 'error' ? 'errored' : 'closed-externally');
      track(finishRun(pilotId, run, outcome));
      return;
    }
  }

  async function finishRun(pilotId, run, outcome) {
    const at = now();
    const pilot = await store.getPilot(pilotId);
    const entry = {
      event: outcome,
      pilotId,
      pilotName: pilot?.name ?? null,
      sessionId: run.sessionId,
      durationMs: at - run.startedAt,
    };
    // I3: 'errored' and 'closed-externally' never went through reviewRuns'
    // settle branches, so run.costUsd/costUnpriced are unset - fall back to
    // the snapshot reviewRuns cached on its last pass. That figure is stale
    // by at most one heartbeat, which beats the alternative: onSessionRemoved
    // fires with the row already deleted from the registry (removeSession
    // runs before the listener), so there is no usageAcc left to read here.
    const costUsd = run.costUsd ?? (typeof run.lastUsage?.costUsd === 'number' ? run.lastUsage.costUsd : null);
    const costUnpriced = run.costUnpriced || (Array.isArray(run.lastUsage?.unpriced) && run.lastUsage.unpriced.length > 0);
    if (costUsd != null) entry.costUsd = costUsd;
    if (costUnpriced) entry.costUnpriced = true;
    if (run.reason) entry.reason = run.reason;
    // I1: this same file documents the rule at :407-418 above - the STORE
    // write is the safety property that stops the spawn loop (a rejected
    // log.append must never cost it), so it happens first and unconditionally,
    // exactly like the errored-outcome path in fire() already does.
    await recordOutcome(pilotId, outcome, at);
    try {
      await log.append(entry);
    } catch (err) {
      try {
        logImpl(`autopilot: failed to log a '${outcome}' event for ${pilot?.name ?? pilotId}: ${String(err?.message || err)}`);
      } catch { /* logging must never break the store write already committed above */ }
    }
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
    // Fold-in item 7: distinguish shutdown from an actual createSession
    // failure, rather than misreporting both as "the session could not be
    // created".
    if (row === 'stopping') return { fired: false, reason: 'autopilot is stopping' };
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
    // Round 3 review (New-1): a stop()/start() cycle (already exercised by
    // I6) must fully resume firing, not just re-arm the timer - otherwise a
    // single stop() would permanently latch the supervisor into refusing all
    // future work.
    stopping = false;
    // Unlike the removal listener above (registered once, in the
    // constructor), this one changes how a LIVE session behaves - so it must
    // not outlive a stopped supervisor, and is installed/torn down here
    // rather than once up front.
    registry.setApprovalInterceptor(onApprovalRequest);
    timer = setIntervalImpl(() => { tick(); }, HEARTBEAT_MS);
  }

  async function stop() {
    // Round 3 review (New-1): set BEFORE the kill loop below, and before
    // anything else - fire()/runGate() check this the moment they are
    // reached, and evaluate()'s loop checks it every iteration, so shutdown
    // drains whatever is already committed rather than picking up new work.
    stopping = true;
    // See start()'s own comment: torn down here, unlike the removal listener.
    registry.setApprovalInterceptor(null);
    // The cache is the interceptor's own state - tearing down one without
    // the other leaves a stale pilot record (up to 15s old within a running
    // supervisor, unbounded across a stop()) able to answer a question under
    // a policy an operator may have just revoked by hand while stopped.
    pilotCache.clear();
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    // Round 2 review (Important-3): a gate spawned `detached` (round 1, I3)
    // is its own process-group leader, invisible to a terminal Ctrl-C - the
    // only thing that used to kill it was its own timeoutMs, which a Ctrl-C
    // mid-gate pre-empts. Kill every gate still running through the same
    // path the timeout uses, and resolve its promise directly rather than
    // waiting on the OS to deliver 'exit' - `ticking` below can be awaiting
    // exactly this gate, inside blockingReason(), so this must not depend on
    // an event that a killed/fake process is not guaranteed to emit.
    for (const inFlight of [...inFlightGates]) {
      killGateProcess(inFlight.pid);
      inFlight.finish({ ok: false, reason: 'run gate killed: autopilot is stopping' });
    }
    // Round 1 review (I6): deliberately does NOT unregister the removal
    // listener. The comment above registers it in the constructor precisely
    // because a row can be removed at any time, including between a stop()
    // and the next start() - clearing it here defeated that. A run that
    // finishes while stopped (or across a stop()/start() cycle) still needs
    // its terminal outcome recorded and its lock released, or that pilot
    // never fires again and status() shows it running forever. (The approval
    // interceptor above genuinely does need to be torn down here, because
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

  // Derived, never stored: a projection over live state. There is nothing to
  // persist and nothing to mark read - an entry vanishes when the state it
  // was computed from is gone.
  async function notifications() {
    const { pilots } = await store.read();
    // Fold-in item 1: store.read() does not normalize (see evaluate()'s own
    // guard above, and recordOutcome/reviewRuns's null pilot checks) - a bare
    // `null` in a hand-edited autopilots.json must not throw here, since this
    // is a public surface the next task wires straight into /api/notifications.
    const validPilots = pilots.filter((p) => p && p.id);
    const byId = new Map(validPilots.map((p) => [p.id, p]));
    const entries = [];

    for (const run of runs.values()) {
      const row = registry.get(run.sessionId);
      const pilot = byId.get(run.pilotId);
      if (!row || !pilot) continue;
      for (const request of row.pendingApprovals) {
        entries.push({
          kind: 'needs-input',
          pilotId: pilot.id,
          pilotName: pilot.name,
          sessionId: run.sessionId,
          toolName: request.toolName,
          requestId: request.requestId,
          message: `"${pilot.name}" is waiting on ${request.toolName}`,
        });
      }
    }

    for (const pilot of validPilots) {
      if (pilot.enabled) continue;
      if ((pilot.consecutiveFailures || 0) < MAX_CONSECUTIVE_FAILURES) continue;
      entries.push({
        kind: 'auto-disabled',
        pilotId: pilot.id,
        pilotName: pilot.name,
        message: `"${pilot.name}" was auto-disabled after ${pilot.consecutiveFailures} consecutive failures - fix it, then re-enable it.`,
      });
    }

    return { entries };
  }

  // Forget a run WITHOUT classifying it. Used only by the DELETE route: the
  // pilot record is about to disappear, so there is no outcome to record
  // against it and no failure count to increment.
  async function abandonRun(pilotId) {
    const run = runs.get(pilotId);
    if (!run) return;
    runs.delete(pilotId);
    pilotCache.delete(pilotId);
    if (run.trackedPid != null) await tracker.detachPilot(run.trackedPid, pilotId);
  }

  return { start, stop, tick, runNow, status, notifications, drain, abandonRun, _runs: runs };
}
