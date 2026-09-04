// One async teardown for every exit route: the TTY Ctrl-C keypress, SIGINT,
// SIGTERM, SIGBREAK. Before this, server.js's keypress handler called
// process.exit(0) directly (src/server.js:225) and that was the ONLY Ctrl-C
// path on a TTY - process.stdin.setRawMode(true) (src/server.js:221) means
// the OS never delivers SIGINT at all - so every live Grok/Codex CLI cockpit
// had spawned was left running.
//
// Deliberately dependency-injected rather than importing session-registry.js
// and child-tracker.js directly: that is what lets tests drive the ordering,
// the grace period and the idempotence without a real registry or a real
// process to kill.
const DEFAULT_GRACE_MS = 3000;

export function createShutdown({
  registry,
  tracker,
  graceMs = DEFAULT_GRACE_MS,
  logImpl = console.error,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const beforeClose = [];
  const afterClose = [];
  let running = null;

  function onBeforeClose(fn) {
    if (typeof fn === 'function') beforeClose.push(fn);
  }

  // Fix round 1 (I2): symmetric with onBeforeClose - same registration
  // shape, same per-hook try/catch so one bad hook cannot strand teardown.
  // Runs after every session is closed but before the grace/kill pass and
  // the final flush, so a hook that needs the removal listener's own
  // fire-and-forget writes to have been kicked off (autopilot.drain(), which
  // awaits recordRun/log.append for every run this close loop just finished)
  // can be awaited here instead of racing process.exit().
  function onAfterClose(fn) {
    if (typeof fn === 'function') afterClose.push(fn);
  }

  async function perform(reason) {
    logImpl(`shutting down (${reason})…`);

    // Hooks first - the auto-pilot heartbeat has to stop before sessions
    // start disappearing, or it sees its own runs vanish and treats them as
    // terminal outcomes mid-teardown. One bad hook must not strand the CLIs.
    for (const fn of beforeClose) {
      try {
        await fn();
      } catch (err) {
        logImpl(`shutdown hook failed: ${String(err?.message || err)}`);
      }
    }

    // Every live session, pilot-owned or not. closeSession is synchronous and
    // removes the row, so snapshot the ids first rather than iterating a view
    // of the collection we are mutating.
    const ids = registry.list().map(({ id }) => id);
    for (const id of ids) {
      try {
        registry.closeSession(id);
      } catch (err) {
        logImpl(`closing session ${id} failed: ${String(err?.message || err)}`);
      }
    }

    // Fix round 1 (I2): the removal listener stays registered deliberately
    // (ruling I6 elsewhere), so each close above fired onSessionRemoved ->
    // track(finishRun(...)) as a floating promise nothing here awaited -
    // stop() had already returned by the time this loop ran, and
    // process.exit() was one `await` away. Await every after-close hook
    // before reaching for the grace period, so a hook whose job is draining
    // exactly those floating writes (autopilot.drain()) gets the chance to.
    for (const fn of afterClose) {
      try {
        await fn();
      } catch (err) {
        logImpl(`shutdown hook failed: ${String(err?.message || err)}`);
      }
    }

    // Closing a session asks its CLI to exit; give it a moment to actually
    // do so before reaching for taskkill. Nothing tracked means nothing to
    // wait for - don't add three seconds to every clean exit.
    if (tracker.list().length > 0) {
      await sleepImpl(graceMs);
      try {
        const killed = await tracker.killTracked({ signal: 'SIGKILL' });
        if (killed.length) {
          logImpl(`force-killed ${killed.length} CLI process(es) that outlived the ${graceMs}ms grace period: ${killed.map((e) => `${e.provider}/${e.pid}`).join(', ')}`);
        }
      } catch (err) {
        logImpl(`force-kill pass failed: ${String(err?.message || err)}`);
      }
    }

    // UNCONDITIONAL, and the last thing we do. The spec requires shutdown to
    // clear runtime.json, and on the clean path (every session closed, every
    // PID released) neither branch above writes anything. release()'s own
    // persist is fire-and-forget from grok-session/codex-session, and
    // exitVia() calls process.exit(0) immediately afterwards - which aborts an
    // in-flight writeJsonAtomic. Without this await, "runtime.json is [] after
    // a clean exit" is a race, and the next start reaps phantom entries.
    try {
      // Drain outstanding start-time probes first: each one persists when it
      // lands, and a probe resolving AFTER our flush would rewrite
      // runtime.json behind us.
      await tracker.settled();
      await tracker.persistNow();
    } catch (err) {
      logImpl(`could not flush runtime.json on shutdown: ${String(err?.message || err)}`);
    }
  }

  // A second Ctrl-C while the first teardown is still in flight must join it,
  // not start a competing one.
  function run(reason) {
    if (!running) running = perform(reason);
    return running;
  }

  return { run, onBeforeClose, onAfterClose, isShuttingDown: () => running !== null };
}
