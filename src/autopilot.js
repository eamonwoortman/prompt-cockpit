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
import { spawn } from 'node:child_process';
import { getProvider } from './provider-registry.js';
import { killProcessTree } from './child-tracker.js';
import { isDue, isInsideWindow } from './autopilot-schedule.js';

export const HEARTBEAT_MS = 15_000;
const GATE_STDOUT_TAIL = 200;

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
}) {
  // pilotId -> live run state. This map IS the concurrency lock: `sessionId`
  // checked against registry.get(), because the registry row knows whether a
  // session is running, blocked or idle, where a PID only proves a process
  // exists. The PID exists for killing, not locking.
  const runs = new Map();
  // pilotId -> the last skip reason logged, so a windowed pilot that is
  // out-of-window for eight hours produces one log line instead of ~1900.
  const lastSkipReason = new Map();
  // Terminal-outcome recording is kicked off from a SYNCHRONOUS registry
  // listener, so the async store/log writes are tracked here for tests and
  // for shutdown to await.
  const pending = new Set();
  let timer = null;
  let ticking = null;

  function track(promise) {
    const p = promise.catch((err) => logImpl(`autopilot: ${String(err?.message || err)}`)).finally(() => pending.delete(p));
    pending.add(p);
    return p;
  }

  function drain() {
    return Promise.all([...pending]).then(() => {});
  }

  async function skip(pilot, reason) {
    if (lastSkipReason.get(pilot.id) === reason) return;
    lastSkipReason.set(pilot.id, reason);
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
        killProcessTree(proc.pid);
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

  // Preconditions 4-8, in the spec's order. Returns null when the pilot may
  // fire, or a skip reason string. Preconditions 1-3 (enabled, due, window)
  // are handled by the caller, because runNow bypasses 2 and 3.
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
    // 5 - provider available and effort valid for it. Without this a Grok
    // pilot on a machine with no Grok CLI fires straight into an error.
    let descriptor;
    try {
      descriptor = providers.getProvider(pilot.provider);
    } catch (err) {
      return `unknown provider "${pilot.provider}"`;
    }
    let available = false;
    try {
      available = await descriptor.isAvailable();
    } catch {
      available = false;
    }
    if (!available) return `${descriptor.label} is not available on this machine`;
    if (pilot.effort && !descriptor.efforts.includes(pilot.effort)) {
      return `effort "${pilot.effort}" is not valid for ${descriptor.label}`;
    }
    // 7 - rate limit, keyed by provider.
    if (rateLimited.has(pilot.provider)) return `${descriptor.label} is rate limited`;
    // 8b - global daily spend cap. A precondition ONLY: it never kills a run
    // in flight, because killing an agent mid-edit to save a few cents trades
    // a small cost for a broken working tree.
    if (settings.dailyCostCapUsd != null && dailySpend >= settings.dailyCostCapUsd) {
      return `global daily spend cap reached ($${dailySpend.toFixed(2)} / $${settings.dailyCostCapUsd.toFixed(2)})`;
    }
    // 6 - run gate, last: it is the only precondition that costs a subprocess.
    if (pilot.gate) {
      const gate = await runGate(pilot);
      if (!gate.ok) return gate.reason;
    }
    return null;
  }

  async function fire(pilot, reason) {
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
        // start) is a real failure. Stamp lastRunAt so the pilot backs off
        // instead of retrying every 15 seconds forever.
        const at = now();
        await log.append({
          event: 'errored', pilotId: pilot.id, pilotName: pilot.name,
          reason: String(err?.message || err),
        });
        await recordOutcome(pilot.id, 'errored', at);
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
    await log.append({ event: 'fired', pilotId: pilot.id, pilotName: pilot.name, sessionId: row.id, reason });
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
      // 1 - enabled, and 2 - due (including failure back-off). Neither is
      // logged: "not due" is the normal state of every pilot most of the time.
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
      await fire(pilot, 'schedule');
      // Startup stagger: at most ONE overdue pilot per heartbeat. Without
      // this, a cockpit restarted after an hour launches every pilot
      // simultaneously.
      return;
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
    const row = await fire(pilot, 'run-now');
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
    registry.setSessionRemovedListener(null);
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
