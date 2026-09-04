// One async shutdown path for every exit route. The bug this closes: the TTY
// keypress handler was the ONLY Ctrl-C path (process.stdin.setRawMode(true)
// means the OS never delivers SIGINT) and it called process.exit(0) directly
// - so every live Grok/Codex CLI kept running, and on Windows the terminal
// was left in raw mode too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../src/shutdown.js';

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
