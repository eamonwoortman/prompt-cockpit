// Final fix wave (Important-2): the three lines that compose every safety
// mechanism this branch adds - Ctrl-C stopping the heartbeat, outcome/spend
// writes draining before process.exit, and a firing pilot waiting for the
// orphan reap - lived inline in server.js, where none of them could be
// exercised without a real server.listen(). Extracted here as one
// injectable function so each wiring can be unit-tested against fakes:
// delete any one line and a test should fail.
export function wireAutopilot({ shutdown, autopilot, tracker, logImpl = console.error }) {
  // The heartbeat has to stop before sessions start disappearing, or it sees
  // its own runs vanish mid-teardown and records them as terminal outcomes.
  shutdown.onBeforeClose(() => autopilot.stop());

  // The removal listener stays registered through shutdown (ruling I6), so
  // each session shutdown.js closes fires a floating track(finishRun(...))
  // write - outcome + spend log - that nothing awaited. drain() here, after
  // every session is closed but before the grace/kill pass and the final
  // runtime.json flush, is what stops those writes racing process.exit().
  shutdown.onAfterClose(() => autopilot.drain());

  // Reaping AFTER a successful listen() is what makes a second `npm start`
  // on the same port harmless: it dies on EADDRINUSE before it can touch
  // another instance's PIDs, rather than relying on the crash beating the
  // kill by a second. Callers must invoke wireAutopilot only from inside
  // that success callback, not at module load. orphanPilotIds()
  // (blockingReason's precondition 4) returns an empty set until
  // reapOrphans() resolves, so start() is chained after it settles - either
  // way, resolved or rejected - so a pilot cannot fire while its own orphan
  // from an unclean exit is still billing.
  return tracker.reapOrphans()
    .catch((err) => logImpl(`orphan reap failed: ${String(err?.message || err)}`))
    .finally(() => autopilot.start());
}
