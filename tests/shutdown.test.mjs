// One async shutdown path for every exit route. The bug this closes: the TTY
// keypress handler was the ONLY Ctrl-C path (process.stdin.setRawMode(true)
// means the OS never delivers SIGINT) and it called process.exit(0) directly
// - so every live Grok/Codex CLI kept running, and on Windows the terminal
// was left in raw mode too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../src/shutdown.js';
import { wireAutopilot } from '../src/autopilot-wiring.js';

function fakeRegistry(ids) {
  const closed = [];
  return {
    closed,
    list: () => ids.filter((id) => !closed.includes(id)).map((id) => ({ id })),
    closeSession: (id) => { closed.push(id); return true; },
  };
}

function fakeTracker(entries = []) {
  const calls = [];
  let live = [...entries];
  return {
    calls,
    list: () => live,
    killTracked: async ({ signal } = {}) => {
      calls.push(signal);
      const killed = live;
      live = [];
      return killed;
    },
    settled: async () => { calls.push('settled'); },
    persistNow: async () => { calls.push('persist'); },
  };
}

test('shutdown runs hooks, closes every session, then kills survivors - in that order', async () => {
  const order = [];
  const registry = fakeRegistry(['a', 'b']);
  const tracker = fakeTracker([{ pid: 1 }]);
  const shutdown = createShutdown({
    registry,
    tracker,
    graceMs: 5,
    logImpl: () => {},
    sleepImpl: async () => { order.push('grace'); },
  });
  shutdown.onBeforeClose(() => { order.push('hook'); });

  const patchedClose = registry.closeSession;
  registry.closeSession = (id) => { order.push(`close:${id}`); return patchedClose(id); };

  await shutdown.run('test');

  assert.deepEqual(order, ['hook', 'close:a', 'close:b', 'grace']);
  assert.deepEqual(tracker.calls, ['SIGKILL', 'settled', 'persist']);
});

test('shutdown skips the grace period and the kill pass when nothing is tracked', async () => {
  const tracker = fakeTracker([]);
  let slept = false;
  const shutdown = createShutdown({
    registry: fakeRegistry([]),
    tracker,
    logImpl: () => {},
    sleepImpl: async () => { slept = true; },
  });
  await shutdown.run('test');
  assert.equal(slept, false);
  // No grace period and no kill pass, but runtime.json is still flushed -
  // that is what makes "[] after a clean exit" deterministic.
  assert.deepEqual(tracker.calls, ['settled', 'persist']);
});

test('shutdown is idempotent - a second call returns the same promise and does no extra work', async () => {
  const registry = fakeRegistry(['a']);
  const tracker = fakeTracker([{ pid: 1 }]);
  const shutdown = createShutdown({ registry, tracker, logImpl: () => {}, sleepImpl: async () => {} });

  assert.equal(shutdown.isShuttingDown(), false);
  const first = shutdown.run('sigint');
  assert.equal(shutdown.isShuttingDown(), true);
  const second = shutdown.run('sigterm');
  assert.equal(first, second, 'a double Ctrl-C must not start a second teardown');
  await first;
  assert.deepEqual(registry.closed, ['a']);
  assert.deepEqual(tracker.calls, ['SIGKILL', 'settled', 'persist']);
});

test('Task 8 I2: an onAfterClose hook runs after every session is closed, and is awaited before the grace period', async () => {
  const order = [];
  const registry = fakeRegistry(['a', 'b']);
  const tracker = fakeTracker([{ pid: 1 }]);
  const shutdown = createShutdown({
    registry,
    tracker,
    graceMs: 5,
    logImpl: () => {},
    sleepImpl: async () => { order.push('grace'); },
  });
  shutdown.onBeforeClose(() => { order.push('before'); });

  const patchedClose = registry.closeSession;
  registry.closeSession = (id) => { order.push(`close:${id}`); return patchedClose(id); };

  let resolveAfter;
  shutdown.onAfterClose(() => new Promise((resolve) => {
    resolveAfter = () => { order.push('after'); resolve(); };
    // Prove perform() actually awaits this rather than firing it and moving
    // on - if the grace period ran before we resolve, it would show up in
    // `order` ahead of 'after'.
    setTimeout(resolveAfter, 5);
  }));

  await shutdown.run('test');

  assert.deepEqual(order, ['before', 'close:a', 'close:b', 'after', 'grace']);
});

test('a throwing hook or a throwing closeSession does not abort the rest of the shutdown', async () => {
  const registry = fakeRegistry(['a', 'b']);
  registry.closeSession = (id) => {
    if (id === 'a') throw new Error('close blew up');
    registry.closed.push(id);
    return true;
  };
  const tracker = fakeTracker([{ pid: 1 }]);
  const logged = [];
  const shutdown = createShutdown({
    registry,
    tracker,
    logImpl: (m) => logged.push(String(m)),
    sleepImpl: async () => {},
  });
  shutdown.onBeforeClose(() => { throw new Error('hook blew up'); });
  shutdown.onBeforeClose(async () => { throw new Error('async hook blew up'); });
  // Task 8 I2: onAfterClose gets the same per-hook try/catch as onBeforeClose.
  shutdown.onAfterClose(async () => { throw new Error('after hook blew up'); });

  await shutdown.run('test');

  assert.deepEqual(registry.closed, ['b'], 'session b still got closed');
  assert.deepEqual(tracker.calls, ['SIGKILL', 'settled', 'persist'], 'the kill pass and the flush still ran');
  assert.match(logged.join('\n'), /hook blew up/);
  assert.match(logged.join('\n'), /async hook blew up/);
  assert.match(logged.join('\n'), /close blew up/);
  assert.match(logged.join('\n'), /after hook blew up/);
});

// --- Final fix wave, Important-2: wireAutopilot (src/autopilot-wiring.js) --
//
// The three lines it composes - a before-close hook that stops the
// heartbeat, an after-close hook that drains it, and start() chained after
// the orphan reap - could each be deleted from server.js with the rest of
// the suite staying green. Test the extracted function directly against
// fakes, with no real shutdown, registry, or tracker involved.

function fakeShutdownHooks() {
  const before = [];
  const after = [];
  return {
    before,
    after,
    onBeforeClose: (fn) => before.push(fn),
    onAfterClose: (fn) => after.push(fn),
  };
}

function fakeAutopilotLifecycle() {
  const calls = [];
  return {
    calls,
    stop: () => calls.push('stop'),
    drain: () => calls.push('drain'),
    start: () => calls.push('start'),
  };
}

test('wireAutopilot: the before-close hook stops the heartbeat', async () => {
  const shutdown = fakeShutdownHooks();
  const autopilot = fakeAutopilotLifecycle();
  const tracker = { reapOrphans: async () => {} };
  await wireAutopilot({ shutdown, autopilot, tracker });

  assert.equal(shutdown.before.length, 1, 'exactly one before-close hook was registered');
  autopilot.calls.length = 0; // clear the reap-chained start() so only the hook's effect is asserted below
  shutdown.before[0]();
  assert.deepEqual(autopilot.calls, ['stop']);
});

test('wireAutopilot: the after-close hook drains outstanding outcome/spend writes', async () => {
  const shutdown = fakeShutdownHooks();
  const autopilot = fakeAutopilotLifecycle();
  const tracker = { reapOrphans: async () => {} };
  await wireAutopilot({ shutdown, autopilot, tracker });

  assert.equal(shutdown.after.length, 1, 'exactly one after-close hook was registered');
  autopilot.calls.length = 0; // clear the reap-chained start() so only the hook's effect is asserted below
  shutdown.after[0]();
  assert.deepEqual(autopilot.calls, ['drain']);
});

test('wireAutopilot: start() runs only after the orphan reap resolves', async () => {
  const shutdown = fakeShutdownHooks();
  const autopilot = fakeAutopilotLifecycle();
  let resolveReap;
  const tracker = { reapOrphans: () => new Promise((resolve) => { resolveReap = resolve; }) };

  const pending = wireAutopilot({ shutdown, autopilot, tracker });
  assert.deepEqual(autopilot.calls, [], 'start() must not run before the reap settles');
  resolveReap();
  await pending;
  assert.deepEqual(autopilot.calls, ['start']);
});

test('wireAutopilot: start() still runs after the orphan reap rejects, and the error is logged rather than thrown', async () => {
  const shutdown = fakeShutdownHooks();
  const autopilot = fakeAutopilotLifecycle();
  const tracker = { reapOrphans: async () => { throw new Error('reap failed'); } };
  const logged = [];

  await wireAutopilot({ shutdown, autopilot, tracker, logImpl: (m) => logged.push(String(m)) });

  assert.deepEqual(autopilot.calls, ['start'], 'a rejected reap must not skip start()');
  assert.match(logged.join('\n'), /reap failed/);
});

test('wireAutopilot: start waits for cooldowns.load', async () => {
  const shutdown = fakeShutdownHooks();
  const autopilot = fakeAutopilotLifecycle();
  let resolveReap;
  let resolveLoad;
  const tracker = { reapOrphans: () => new Promise((resolve) => { resolveReap = resolve; }) };
  const cooldowns = { load: () => new Promise((resolve) => { resolveLoad = resolve; }), flush: async () => {} };

  const pending = wireAutopilot({ shutdown, autopilot, tracker, cooldowns });
  resolveReap();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(autopilot.calls, [], 'start() must not run before cooldowns.load settles');
  resolveLoad();
  await pending;
  assert.deepEqual(autopilot.calls, ['start']);

  const shutdown2 = fakeShutdownHooks();
  const autopilot2 = fakeAutopilotLifecycle();
  let resolveReap2;
  const tracker2 = { reapOrphans: () => new Promise((resolve) => { resolveReap2 = resolve; }) };
  const cooldowns2 = { load: async () => {}, flush: async () => {} };
  const pending2 = wireAutopilot({ shutdown: shutdown2, autopilot: autopilot2, tracker: tracker2, cooldowns: cooldowns2 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(autopilot2.calls, [], 'start() must not run before the reap settles either');
  resolveReap2();
  await pending2;
  assert.deepEqual(autopilot2.calls, ['start']);

  const logged = [];
  const autopilot3 = fakeAutopilotLifecycle();
  await wireAutopilot({
    shutdown: fakeShutdownHooks(),
    autopilot: autopilot3,
    tracker: { reapOrphans: async () => { throw new Error('reap failed'); } },
    cooldowns: { load: async () => { throw new Error('cooldown load failed'); }, flush: async () => {} },
    logImpl: (m) => logged.push(String(m)),
  });
  assert.deepEqual(autopilot3.calls, ['start'], 'a rejected load must not skip start()');
  assert.match(logged.join('\n'), /cooldown load failed/);
  assert.match(logged.join('\n'), /reap failed/);
});

test('wireAutopilot: the after-close hook flushes cooldowns', async () => {
  const shutdown = fakeShutdownHooks();
  const calls = [];
  let resolveDrain;
  let resolveFlush;
  const autopilot = {
    stop: () => {},
    start: () => {},
    drain: () => { calls.push('drain:start'); return new Promise((resolve) => { resolveDrain = () => { calls.push('drain:end'); resolve(); }; }); },
  };
  const cooldowns = {
    load: async () => {},
    flush: () => { calls.push('flush:start'); return new Promise((resolve) => { resolveFlush = () => { calls.push('flush:end'); resolve(); }; }); },
  };
  await wireAutopilot({ shutdown, autopilot, tracker: { reapOrphans: async () => {} }, cooldowns });

  assert.equal(shutdown.after.length, 2, 'drain and flush are separate after-close hooks');
  // Mirrors shutdown.js's perform(): every after-close hook awaited, in order.
  const run = (async () => { for (const fn of shutdown.after) await fn(); })();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['drain:start'], 'flush must not start before drain settles');
  resolveDrain();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['drain:start', 'drain:end', 'flush:start']);
  let finished = false;
  run.then(() => { finished = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false, 'the hook chain must await flush()');
  resolveFlush();
  await run;
  assert.deepEqual(calls, ['drain:start', 'drain:end', 'flush:start', 'flush:end']);
});
