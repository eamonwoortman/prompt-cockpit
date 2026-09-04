// The supervisor against an injected clock and a fake registry. Nothing here
// spawns a CLI, opens a socket, or reads the real ~/.prompt-cockpit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAutopilot, HEARTBEAT_MS } from '../src/autopilot.js';
import { createAutopilotStore } from '../src/autopilot-store.js';
import { createAutopilotLog } from '../src/autopilot-log.js';

const MIN = 60_000;

// A registry stand-in with just the surface the supervisor uses.
function fakeRegistry() {
  const rows = new Map();
  let n = 0;
  const api = {
    rows,
    created: [],
    closed: [],
    inputs: [],
    failCreateWith: null,
    createSession(opts) {
      if (api.failCreateWith) {
        const err = api.failCreateWith;
        api.failCreateWith = null;
        throw err;
      }
      if (opts.name && [...rows.values()].some((r) => r.cwd === opts.cwd && r.name === opts.name)) {
        const err = new Error('taken');
        err.code = 'ERR_NAME_TAKEN';
        throw err;
      }
      const row = {
        id: `s-${++n}`,
        name: opts.name || null,
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model || null,
        effort: opts.effort || null,
        mode: opts.permissionMode,
        state: 'starting',
        queue: [],
        pendingApprovals: [],
        rateLimitHit: null,
        eventLog: { nextSeq: 1, entries: [] },
        usageAcc: { snapshot: () => ({ costUsd: 0, unpriced: [] }) },
        handle: { trackedPid: null },
      };
      rows.set(row.id, row);
      api.created.push(opts);
      return row;
    },
    get: (id) => rows.get(id),
    list: () => [...rows.values()].map((r) => ({ id: r.id, provider: r.provider, rateLimitHit: r.rateLimitHit })),
    findByName: (cwd, name) => [...rows.values()].find((r) => r.cwd === cwd && r.name === name) || null,
    closeSession(id) {
      if (!rows.delete(id)) return false;
      api.closed.push(id);
      api.removedListener?.({ id, reason: 'closed' });
      return true;
    },
    async sendInput(id, text) { api.inputs.push({ id, text }); },
    setSessionRemovedListener(fn) { api.removedListener = fn; },
    setApprovalInterceptor() {},
    // Test-side helpers.
    emitRemoved(id, reason) {
      rows.delete(id);
      api.removedListener?.({ id, reason });
    },
    advance(id, { seq, state, result } = {}) {
      const row = rows.get(id);
      if (!row) return;
      if (seq != null) {
        for (let s = row.eventLog.nextSeq; s < seq; s++) {
          row.eventLog.entries.push({ seq: s, message: { type: 'assistant' } });
        }
        row.eventLog.nextSeq = seq;
      }
      if (result) {
        row.eventLog.entries.push({ seq: row.eventLog.nextSeq, message: { type: 'result' } });
        row.eventLog.nextSeq += 1;
      }
      if (state) row.state = state;
    },
  };
  return api;
}

const availableProviders = {
  getProvider: (id) => ({
    id,
    label: id,
    isAvailable: async () => true,
    efforts: ['low', 'medium', 'high'],
  }),
};

async function harness({
  nowMs = 1_000_000, providers = availableProviders, spawnImpl,
  providerProbeTimeoutMs, platform, spawnSyncImpl, killImpl,
  setTimeoutImpl, clearTimeoutImpl,
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-'));
  let clock = nowMs;
  let n = 0;
  const store = createAutopilotStore({ filePath: path.join(dir, 'autopilots.json'), idImpl: () => `p-${++n}` });
  const log = createAutopilotLog({ filePath: path.join(dir, 'autopilot-log.jsonl'), now: () => clock });
  const registry = fakeRegistry();
  const tracker = { orphanPilotIds: () => new Set(), attachPilot: async () => {}, detachPilot: async () => {} };
  const supervisor = createAutopilot({
    registry, store, log, tracker, providers,
    now: () => clock,
    setIntervalImpl: () => 'timer',
    clearIntervalImpl: () => {},
    spawnImpl,
    logImpl: () => {},
    ...(providerProbeTimeoutMs !== undefined ? { providerProbeTimeoutMs } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(spawnSyncImpl !== undefined ? { spawnSyncImpl } : {}),
    ...(killImpl !== undefined ? { killImpl } : {}),
    ...(setTimeoutImpl !== undefined ? { setTimeoutImpl } : {}),
    ...(clearTimeoutImpl !== undefined ? { clearTimeoutImpl } : {}),
  });
  return {
    dir, store, log, registry, tracker, supervisor,
    now: () => clock,
    setNow: (ms) => { clock = ms; },
    advanceClock: (ms) => { clock += ms; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// Round 3 review (cheap item 2): several tests below poll a fake spawn/timer
// call count with `while (...) await new Promise((r) => setTimeout(r, 0))`.
// Unbounded, a regression that stops the spawn/probe from ever arming makes
// the test HANG instead of fail - a much worse debugging experience, and one
// that can look exactly like the watchdog stall that killed an earlier agent
// on this task. Bounded here with a clear failure message instead.
async function pollUntil(predicate, { timeoutMs = 2000, message = 'condition was not met before the poll timeout' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 0));
  }
}

function pilotInput(over = {}) {
  return {
    name: 'Nightly',
    cwd: '/repo',
    provider: 'claude',
    mode: 'acceptEdits',
    prompt: 'do the thing',
    schedule: { everyMinutes: 30 },
    ...over,
  };
}

test('the heartbeat is 15 seconds', () => {
  assert.equal(HEARTBEAT_MS, 15_000);
});

test('a due, enabled pilot fires: a session is created from its OWN model/effort/mode and the prompt is sent', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ model: 'opus', effort: 'high' }));
    await h.supervisor.tick();

    assert.equal(h.registry.created.length, 1);
    assert.deepEqual(h.registry.created[0], {
      cwd: '/repo',
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      name: 'Nightly',
    });
    assert.deepEqual(h.registry.inputs, [{ id: 's-1', text: 'do the thing' }]);
    const entries = await h.log.tail({});
    assert.deepEqual(entries.map((e) => e.event), ['fired']);
    assert.equal(entries[0].sessionId, 's-1');
  } finally {
    await h.cleanup();
  }
});

test('a disabled pilot never fires and logs nothing', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.store.setEnabled(p.id, false);
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    assert.deepEqual(await h.log.tail({}), []);
  } finally {
    await h.cleanup();
  }
});

test('a pilot that is not yet due fires nothing and logs nothing', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.store.recordRun(p.id, { lastRunAt: h.now(), lastOutcome: 'finished', consecutiveFailures: 0 });
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    assert.deepEqual(await h.log.tail({}), [], 'not-due is the normal state, not a skip worth logging');
  } finally {
    await h.cleanup();
  }
});

test('a lock-skip does NOT advance lastRunAt, so the pilot fires on the first heartbeat after the lock frees', async () => {
  const h = await harness();
  try {
    // An explicit backstop well past the clock this test advances: once Task 6
    // adds the stall check, the 60-minute DEFAULT_MAX_TURN_STALL_MS would
    // force-close this run at the 60-minute mark below and let the pilot fire
    // a second time, which is not what this test is about.
    const p = await h.store.createPilot(pilotInput({ maxTurnStallMs: 24 * 60 * MIN }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);
    assert.equal((await h.store.getPilot(p.id)).lastRunAt, null, 'firing alone must not stamp lastRunAt');

    // Five intervals pass with the run still going.
    for (let i = 0; i < 5; i++) {
      h.advanceClock(30 * MIN);
      await h.supervisor.tick();
    }
    assert.equal(h.registry.created.length, 1, 'a session that overran five intervals fires ONCE');

    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.equal(skips.length, 1, 'one skip line per run, not one per heartbeat');
    assert.match(skips[0].reason, /already running/i);
  } finally {
    await h.cleanup();
  }
});

test('at most one overdue pilot fires per heartbeat (startup stagger)', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ name: 'A' }));
    await h.store.createPilot(pilotInput({ name: 'B' }));
    await h.store.createPilot(pilotInput({ name: 'C' }));

    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 2);
  } finally {
    await h.cleanup();
  }
});

test('maxConcurrentRuns caps how many pilots are live at once', async () => {
  const h = await harness();
  try {
    await h.store.updateSettings({ maxConcurrentRuns: 2 });
    await h.store.createPilot(pilotInput({ name: 'A' }));
    await h.store.createPilot(pilotInput({ name: 'B' }));
    await h.store.createPilot(pilotInput({ name: 'C' }));

    await h.supervisor.tick();
    await h.supervisor.tick();
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 2);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.ok(skips.some((e) => /concurrent/i.test(e.reason)));
  } finally {
    await h.cleanup();
  }
});

test('a pilot outside its active window skips, and logs the skip only once', async () => {
  const outside = new Date(2026, 8, 1, 3, 0, 0, 0).getTime(); // 03:00 local
  const h = await harness({ nowMs: outside });
  try {
    await h.store.createPilot(pilotInput({
      schedule: { everyMinutes: 30, window: { fromMinute: 9 * 60, toMinute: 17 * 60, weekdays: [0, 1, 2, 3, 4, 5, 6] } },
    }));
    await h.supervisor.tick();
    h.advanceClock(HEARTBEAT_MS);
    await h.supervisor.tick();

    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.equal(skips.length, 1, 'a windowed pilot is out-of-window for hours - one line, not 240');
    assert.match(skips[0].reason, /window/i);
  } finally {
    await h.cleanup();
  }
});

test('an unavailable provider skips instead of firing straight into an error', async () => {
  const providers = {
    getProvider: (id) => ({ id, label: id, isAvailable: async () => id !== 'grok', efforts: ['low'] }),
  };
  const h = await harness({ providers });
  try {
    await h.store.createPilot(pilotInput({ provider: 'grok', mode: 'default' }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /not available/i);
  } finally {
    await h.cleanup();
  }
});

test('an effort the provider does not support skips rather than firing', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ effort: 'ultra' }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /effort/i);
  } finally {
    await h.cleanup();
  }
});

test('an unreaped orphan blocks its pilot from firing', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    h.tracker.orphanPilotIds = () => new Set([p.id]);
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /orphan/i);
  } finally {
    await h.cleanup();
  }
});

test('rate-limit back-off is keyed by provider - a Claude limit does not stop a Grok pilot', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ name: 'ClaudePilot', provider: 'claude' }));
    await h.store.createPilot(pilotInput({ name: 'GrokPilot', provider: 'grok', effort: 'low' }));

    // A rate-limited Claude row already in the registry, resetting later.
    h.registry.rows.set('other', {
      id: 'other', provider: 'claude',
      rateLimitHit: { resetsAt: h.now() + 60 * MIN, rateLimitType: 'five_hour' },
    });

    await h.supervisor.tick();
    await h.supervisor.tick();

    assert.deepEqual(h.registry.created.map((c) => c.provider), ['grok']);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.ok(skips.some((e) => /rate limit/i.test(e.reason)));
  } finally {
    await h.cleanup();
  }
});

test('a rate-limit hit whose resetsAt has already passed no longer blocks', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput());
    h.registry.rows.set('other', {
      id: 'other', provider: 'claude',
      rateLimitHit: { resetsAt: h.now() - 1, rateLimitType: 'five_hour' },
    });
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('the global daily spend cap is a precondition and counts every cost-bearing event', async () => {
  const h = await harness();
  try {
    await h.store.updateSettings({ dailyCostCapUsd: 1 });
    await h.store.createPilot(pilotInput());
    await h.log.append({ event: 'timed-out', pilotId: 'x', pilotName: 'x', costUsd: 0.9, ts: h.now() });
    await h.log.append({ event: 'errored', pilotId: 'x', pilotName: 'x', costUsd: 0.2, ts: h.now() });

    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /spend cap/i);
  } finally {
    await h.cleanup();
  }
});

test('a null spend cap means no cap', async () => {
  const h = await harness();
  try {
    await h.store.updateSettings({ dailyCostCapUsd: null });
    await h.store.createPilot(pilotInput());
    await h.log.append({ event: 'finished', pilotId: 'x', pilotName: 'x', costUsd: 9999, ts: h.now() });
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('the run gate must exit 0; a non-zero exit skips with the stdout tail as the reason', async () => {
  const spawned = [];
  const spawnImpl = (command, opts) => {
    spawned.push({ command, opts });
    const listeners = {};
    return {
      pid: 4242,
      stdout: { on: (_e, fn) => { fn(Buffer.from('nothing to do\n')); } },
      stderr: { on: () => {} },
      on: (event, fn) => { listeners[event] = fn; setTimeout(() => listeners.exit?.(1), 0); },
      kill: () => {},
    };
  };
  const h = await harness({ spawnImpl });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'git fetch && git log --oneline -1', timeoutMs: 5000 } }));
    await h.supervisor.tick();

    assert.equal(h.registry.created.length, 0);
    assert.equal(spawned[0].opts.cwd, '/repo');
    assert.equal(spawned[0].opts.windowsHide, true);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /nothing to do/);
  } finally {
    await h.cleanup();
  }
});

test('a run gate exiting 0 lets the pilot fire', async () => {
  const spawnImpl = () => {
    const listeners = {};
    return {
      pid: 1,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, fn) => { listeners[event] = fn; setTimeout(() => listeners.exit?.(0), 0); },
      kill: () => {},
    };
  };
  const h = await harness({ spawnImpl });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'exit 0', timeoutMs: 5000 } }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a name collision with a hand-driven session falls back to an unnamed row rather than failing the firing', async () => {
  const h = await harness();
  try {
    // A human already has a session called "Nightly" in this cwd.
    h.registry.createSession({ cwd: '/repo', name: 'Nightly', provider: 'claude', permissionMode: 'default' });
    h.registry.created.length = 0;

    await h.store.createPilot(pilotInput());
    await h.supervisor.tick();

    assert.equal(h.registry.created.length, 1);
    assert.equal(h.registry.created[0].name, null, 'fell back to unnamed');
    assert.equal((await h.log.tail({})).filter((e) => e.event === 'fired').length, 1);
  } finally {
    await h.cleanup();
  }
});

test('runNow bypasses due-ness and the window but still honours the lock', async () => {
  const outside = new Date(2026, 8, 1, 3, 0, 0, 0).getTime();
  const h = await harness({ nowMs: outside });
  try {
    const p = await h.store.createPilot(pilotInput({
      schedule: { everyMinutes: 30, window: { fromMinute: 9 * 60, toMinute: 17 * 60, weekdays: [1] } },
    }));
    await h.store.recordRun(p.id, { lastRunAt: h.now(), lastOutcome: 'finished', consecutiveFailures: 0 });

    const first = await h.supervisor.runNow(p.id);
    assert.equal(first.fired, true);
    assert.equal(h.registry.created.length, 1);

    const second = await h.supervisor.runNow(p.id);
    assert.equal(second.fired, false);
    assert.match(second.reason, /already running/i);
  } finally {
    await h.cleanup();
  }
});

test('runNow on a disabled pilot refuses rather than silently running a pilot the operator turned off', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.store.setEnabled(p.id, false);
    const result = await h.supervisor.runNow(p.id);
    assert.equal(result.fired, false);
    assert.match(result.reason, /disabled/i);
  } finally {
    await h.cleanup();
  }
});

test('a createSession failure records an errored run immediately instead of spawn-looping', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    h.registry.failCreateWith = new Error('no such directory');
    await h.supervisor.tick();
    await h.supervisor.drain();

    const after = await h.store.getPilot(p.id);
    assert.equal(after.lastOutcome, 'errored');
    assert.equal(after.consecutiveFailures, 1);
    assert.equal(after.lastRunAt, h.now(), 'lastRunAt stamped, so the next heartbeat is not another attempt');
    const errored = (await h.log.tail({})).filter((e) => e.event === 'errored');
    assert.match(errored[0].reason, /no such directory/);
    assert.deepEqual(h.supervisor.status(), [], 'the synchronous reservation was released, not left behind as a phantom running entry');
  } finally {
    await h.cleanup();
  }
});

// --- Round 1 findings -------------------------------------------------

test('C1: two overlapping runNow calls for the same pilot fire at most once (the lock is reserved synchronously, not after the provider probe)', async () => {
  const resolvers = [];
  const providers = {
    getProvider: (id) => ({
      id, label: id, efforts: ['low'],
      isAvailable: () => new Promise((resolve) => resolvers.push(resolve)),
    }),
  };
  const h = await harness({ providers });
  try {
    const p = await h.store.createPilot(pilotInput());

    const call1 = h.supervisor.runNow(p.id);
    const call2 = h.supervisor.runNow(p.id);

    // Wait until BOTH calls have reached the provider probe before releasing
    // either one - this is the exact race window C1 closes.
    while (resolvers.length < 2) {
      await new Promise((r) => setTimeout(r, 0));
    }
    resolvers.forEach((resolve) => resolve(true));

    const results = await Promise.all([call1, call2]);
    const fired = results.filter((r) => r.fired);
    const blocked = results.filter((r) => !r.fired);
    assert.equal(fired.length, 1, 'exactly one of the two overlapping calls may fire');
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].reason, /already running/i);
    assert.equal(h.registry.created.length, 1, 'only one session was ever created');
  } finally {
    await h.cleanup();
  }
});

test('I2: a gate whose spawnImpl throws synchronously skips without touching a real process', async () => {
  const spawnImpl = () => { throw new Error('spawn ENOENT'); };
  const h = await harness({ spawnImpl });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'nonexistent-cmd', timeoutMs: 1000 } }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /run gate failed to start/i);
  } finally {
    await h.cleanup();
  }
});

test("I2: a gate process that emits 'error' instead of exiting skips with that error, not a hang", async () => {
  const spawnImpl = () => {
    const listeners = {};
    return {
      pid: 99,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, fn) => {
        listeners[event] = fn;
        if (event === 'error') setTimeout(() => listeners.error?.(new Error('spawn EACCES')), 0);
      },
      kill: () => {},
    };
  };
  const h = await harness({ spawnImpl });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'blocked-cmd', timeoutMs: 1000 } }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /run gate failed:/i);
  } finally {
    await h.cleanup();
  }
});

test('I2/I3: a gate that times out on Windows is killed via the injected killProcessTree dependencies, not the real OS', async () => {
  const spawnSyncCalls = [];
  const spawnOpts = [];
  const spawnImpl = (command, opts) => {
    spawnOpts.push(opts);
    return {
      pid: 555,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {}, // never emits exit/error - this gate hangs forever
      kill: () => {},
    };
  };
  const spawnSyncImpl = (cmd, args, opts) => {
    spawnSyncCalls.push({ cmd, args, opts });
    return { status: 0 };
  };
  const h = await harness({
    spawnImpl, platform: 'win32', spawnSyncImpl, killImpl: () => { throw new Error('must not call the real killImpl on win32'); },
  });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'sleep forever', timeoutMs: 1000 } }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /timed out/i);
    assert.equal(spawnSyncCalls.length, 1, 'the timeout kill went through the injected spawnSyncImpl, not a real taskkill');
    assert.equal(spawnSyncCalls[0].cmd, 'taskkill');
    assert.ok(spawnSyncCalls[0].args.includes('555'));
    assert.notEqual(spawnOpts[0].detached, true, 'on Windows the gate must NOT be detached - taskkill /t already walks the tree');
  } finally {
    await h.cleanup();
  }
});

test('I3: a gate that times out on POSIX is killed as a process GROUP via the injected killImpl, not just the shell pid', async () => {
  const killCalls = [];
  const spawnOpts = [];
  const spawnImpl = (command, opts) => {
    spawnOpts.push(opts);
    return {
      pid: 777,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {}, // never emits exit/error - this gate hangs forever
      kill: () => {},
    };
  };
  const killImpl = (pid, signal) => { killCalls.push({ pid, signal }); };
  const h = await harness({ spawnImpl, platform: 'linux', killImpl });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'sleep forever', timeoutMs: 1000 } }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /timed out/i);
    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].pid, -777, 'a negative pid signals the whole process GROUP, not just the shell');
    assert.equal(killCalls[0].signal, 'SIGKILL');
    assert.equal(spawnOpts[0].detached, true, 'the gate must be spawned detached on POSIX, or killing -pid would not reach it');
  } finally {
    await h.cleanup();
  }
});

test('I4: a malformed pilot record (missing schedule) is skipped without crashing the heartbeat for the pilots after it', async () => {
  const h = await harness();
  try {
    const good = await h.store.createPilot(pilotInput({ name: 'Good' }));
    const raw = JSON.parse(await readFile(h.store.filePath, 'utf8'));
    raw.pilots.unshift({
      id: 'p-bad', name: 'Bad', enabled: true, cwd: '/repo', provider: 'claude',
      mode: 'acceptEdits', prompt: 'do the thing', lastRunAt: null, consecutiveFailures: 0,
      // `schedule` is deliberately absent - a hand-edited or partially-migrated record.
    });
    await writeFile(h.store.filePath, JSON.stringify(raw));

    await h.supervisor.tick();

    assert.equal(h.registry.created.length, 1, 'the well-formed pilot after the malformed one still fires');
    assert.equal(h.registry.created[0].name, 'Good');
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped' && e.pilotId === 'p-bad');
    assert.equal(skips.length, 1, 'the malformed record is logged once, not once per heartbeat');

    h.advanceClock(HEARTBEAT_MS);
    await h.supervisor.tick();
    const skipsAfter = (await h.log.tail({})).filter((e) => e.event === 'skipped' && e.pilotId === 'p-bad');
    assert.equal(skipsAfter.length, 1, 'still deduped on the next heartbeat');
    void good;
  } finally {
    await h.cleanup();
  }
});

test('I5: a createSession failure stamps lastRunAt even when the log append itself fails', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    h.registry.failCreateWith = new Error('no such directory');
    const originalAppend = h.log.append.bind(h.log);
    h.log.append = async (entry) => {
      if (entry.event === 'errored') throw new Error('disk full');
      return originalAppend(entry);
    };

    await h.supervisor.tick();
    await h.supervisor.drain();

    const after = await h.store.getPilot(p.id);
    assert.equal(after.lastOutcome, 'errored');
    assert.equal(after.lastRunAt, h.now(), 'the store write is the safety property and must not depend on the log append succeeding');
  } finally {
    await h.cleanup();
  }
});

test('I5: a fired-event log append failure does not stop the prompt from being sent', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput());
    const originalAppend = h.log.append.bind(h.log);
    h.log.append = async (entry) => {
      if (entry.event === 'fired') throw new Error('disk full');
      return originalAppend(entry);
    };

    await h.supervisor.tick();

    assert.equal(h.registry.created.length, 1, 'the session was still created despite the log write failing');
    assert.deepEqual(h.registry.inputs, [{ id: 's-1', text: 'do the thing' }]);
  } finally {
    await h.cleanup();
  }
});

test('I6: a stop()/start() cycle does not drop the removal listener - a run finishing after restart is still recorded', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);

    await h.supervisor.stop();
    h.supervisor.start();

    h.registry.emitRemoved('s-1', 'closed');
    await h.supervisor.drain();

    assert.deepEqual(h.supervisor.status(), [], 'the in-memory lock was cleared after the session was removed post-restart');
    const after = await h.store.getPilot(p.id);
    assert.equal(after.lastOutcome, 'closed-externally', 'the terminal outcome was recorded even though removal happened after a stop()/start() cycle');
  } finally {
    await h.cleanup();
  }
});

test('I7: drain() awaits a promise added DURING the drain, not just a snapshot taken at call time', async () => {
  const h = await harness();
  try {
    const pilotA = await h.store.createPilot(pilotInput({ name: 'A' }));
    const pilotB = await h.store.createPilot(pilotInput({ name: 'B' }));
    await h.supervisor.tick(); // fires A
    await h.supervisor.tick(); // fires B (default maxConcurrentRuns is 2)
    assert.equal(h.registry.created.length, 2);

    const sessionFor = (name) => [...h.registry.rows.values()].find((r) => r.name === name)?.id;
    const sessionA = sessionFor('A');
    const sessionB = sessionFor('B');

    let chained = false;
    const originalRecordRun = h.store.recordRun.bind(h.store);
    h.store.recordRun = async (pilotId, patch) => {
      const result = await originalRecordRun(pilotId, patch);
      if (pilotId === pilotA.id && !chained) {
        chained = true;
        // While A's outcome is still being recorded, B's session is removed too -
        // this is what adds a NEW promise to `pending` mid-drain.
        h.registry.emitRemoved(sessionB, 'closed');
      }
      return result;
    };

    h.registry.emitRemoved(sessionA, 'closed');
    await h.supervisor.drain();

    const afterB = await h.store.getPilot(pilotB.id);
    assert.equal(afterB.lastOutcome, 'closed-externally', 'drain() must not return before a run added mid-drain also finishes');
  } finally {
    await h.cleanup();
  }
});

test('M8: a gate whose failing output changes on every run still dedupes to one skip line', async () => {
  let n = 0;
  const spawnImpl = () => {
    n += 1;
    const out = `nothing to do - build ${Date.now()}-${n}\n`; // different text every call
    const listeners = {};
    return {
      pid: 4242,
      stdout: { on: (_e, fn) => fn(Buffer.from(out)) },
      stderr: { on: () => {} },
      on: (event, fn) => { listeners[event] = fn; setTimeout(() => listeners.exit?.(1), 0); },
      kill: () => {},
    };
  };
  const h = await harness({ spawnImpl });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'git status', timeoutMs: 5000 } }));
    await h.supervisor.tick();
    await h.supervisor.tick();
    await h.supervisor.tick();

    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.equal(skips.length, 1, 'a gate whose stdout embeds a changing value must dedupe by KIND, not by exact text');
  } finally {
    await h.cleanup();
  }
});

test('M11: a provider probe that never resolves is bounded by a timeout and treated as unavailable', async () => {
  const providers = {
    getProvider: (id) => ({ id, label: id, efforts: ['low'], isAvailable: () => new Promise(() => {}) }),
  };
  const h = await harness({ providers, providerProbeTimeoutMs: 20 });
  try {
    await h.store.createPilot(pilotInput());
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0, 'a probe that never resolves must not wedge the heartbeat');
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /not available/i);
  } finally {
    await h.cleanup();
  }
});

test('M12: a rate-limited pilot never probes provider availability at all (the free checks run first)', async () => {
  let probeCalls = 0;
  const providers = {
    getProvider: (id) => ({ id, label: id, efforts: ['low'], isAvailable: async () => { probeCalls += 1; return true; } }),
  };
  const h = await harness({ providers });
  try {
    await h.store.createPilot(pilotInput());
    h.registry.rows.set('other', {
      id: 'other', provider: 'claude',
      rateLimitHit: { resetsAt: h.now() + 60 * MIN, rateLimitType: 'five_hour' },
    });
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    assert.equal(probeCalls, 0, 'a rate-limited pilot must not probe provider availability at all');
  } finally {
    await h.cleanup();
  }
});

test('M12: a spend-capped pilot never probes provider availability either', async () => {
  let probeCalls = 0;
  const providers = {
    getProvider: (id) => ({ id, label: id, efforts: ['low'], isAvailable: async () => { probeCalls += 1; return true; } }),
  };
  const h = await harness({ providers });
  try {
    await h.store.updateSettings({ dailyCostCapUsd: 1 });
    await h.store.createPilot(pilotInput());
    await h.log.append({ event: 'finished', pilotId: 'x', pilotName: 'x', costUsd: 5, ts: h.now() });
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    assert.equal(probeCalls, 0, 'a spend-capped pilot must not probe provider availability at all');
  } finally {
    await h.cleanup();
  }
});

// --- Round 2 findings ---------------------------------------------------

test('Important-1: an attachPilot rejection releases the reservation instead of leaking it - the pilot fires successfully on the very next heartbeat', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput());
    const originalCreateSession = h.registry.createSession;
    // Force the pid to be non-null so the tracker.attachPilot path is
    // actually reached - the eager `row.handle?.trackedPid` read is inert
    // today (round 1 left it untouched on purpose), and this bug is
    // dormant until the very next task makes that read live.
    h.registry.createSession = (opts) => {
      const row = originalCreateSession(opts);
      row.handle.trackedPid = 4242;
      return row;
    };
    let attachCalls = 0;
    h.tracker.attachPilot = async () => {
      attachCalls += 1;
      if (attachCalls === 1) throw new Error('runtime.json write failed');
    };

    await h.supervisor.tick();
    assert.deepEqual(h.supervisor.status(), [], 'a rejected attachPilot must not leave a permanent reservation');
    assert.equal(h.registry.closed.length, 1, 'the untracked session created before the rejection is closed rather than leaked');
    assert.deepEqual(h.registry.inputs, [], 'no prompt was sent for the abandoned attempt');

    await h.supervisor.tick();
    assert.equal(attachCalls, 2, 'the pilot was able to attempt firing again on the very next heartbeat - it was not wedged');
    assert.deepEqual(h.supervisor.status().map((r) => r.sessionId), ['s-2'], 'the second attempt succeeded and is now tracked as a real run');
    assert.deepEqual(h.registry.inputs, [{ id: 's-2', text: 'do the thing' }]);
  } finally {
    await h.cleanup();
  }
});

test('Important-2: the provider-probe timeout is driven by the injected timer, not a real delay', async () => {
  const timeoutCalls = [];
  const clearedCalls = [];
  let nextId = 1;
  const pendingTimers = new Map();
  const setTimeoutImpl = (fn, ms) => {
    const id = nextId++;
    pendingTimers.set(id, fn);
    timeoutCalls.push({ id, ms });
    return id;
  };
  const clearTimeoutImpl = (id) => { clearedCalls.push(id); pendingTimers.delete(id); };
  const providers = {
    getProvider: (id) => ({ id, label: id, efforts: ['low'], isAvailable: () => new Promise(() => {}) }),
  };
  const h = await harness({ providers, providerProbeTimeoutMs: 5000, setTimeoutImpl, clearTimeoutImpl });
  try {
    await h.store.createPilot(pilotInput());
    const tickPromise = h.supervisor.tick();
    await pollUntil(() => pendingTimers.size > 0, { message: 'the provider-probe timeout was never armed' });
    assert.equal(timeoutCalls.length, 1);
    assert.equal(timeoutCalls[0].ms, 5000, 'the injected timer was armed with providerProbeTimeoutMs, not a real setTimeout');
    // Fire it ourselves - no real delay was ever waited on.
    for (const fn of [...pendingTimers.values()]) fn();
    await tickPromise;

    assert.equal(h.registry.created.length, 0, 'the timed-out probe still resulted in a skip');
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /not available/i);
  } finally {
    await h.cleanup();
  }
});

test('Important-2: a probe that resolves before the timeout clears the injected timer handle rather than leaking it', async () => {
  const clearedCalls = [];
  let nextId = 1;
  const setTimeoutImpl = () => nextId++;
  const clearTimeoutImpl = (id) => clearedCalls.push(id);
  const h = await harness({ providerProbeTimeoutMs: 5000, setTimeoutImpl, clearTimeoutImpl });
  try {
    await h.store.createPilot(pilotInput());
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);
    assert.equal(clearedCalls.length, 1, 'the timeout handle must be cleared once the probe wins the race, not left dangling');
  } finally {
    await h.cleanup();
  }
});

test('Important-3: stop() kills an in-flight gate on POSIX via the injected killImpl and does not hang waiting for it', async () => {
  const killCalls = [];
  const spawnCalls = [];
  const spawnImpl = () => {
    spawnCalls.push(true);
    return {
      pid: 888,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {}, // never emits exit/error on its own - only stop() ends it
      kill: () => {},
    };
  };
  const killImpl = (pid, signal) => { killCalls.push({ pid, signal }); };
  const h = await harness({ spawnImpl, platform: 'linux', killImpl });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'sleep forever', timeoutMs: 60_000 } }));
    const tickPromise = h.supervisor.tick();
    await pollUntil(() => spawnCalls.length > 0, { message: 'the gate was never spawned' });
    await h.supervisor.stop();
    await tickPromise;

    assert.equal(killCalls.length, 1, 'stop() must kill the in-flight gate via the same kill path the timeout uses');
    assert.equal(killCalls[0].pid, -888, 'a negative pid signals the whole process GROUP on POSIX');
    assert.equal(killCalls[0].signal, 'SIGKILL');
    assert.equal(h.registry.created.length, 0, 'the pilot never fired because the gate was killed, not because it exited 0');
  } finally {
    await h.cleanup();
  }
});

test('Important-3: stop() kills an in-flight gate on Windows via the injected killProcessTree dependencies', async () => {
  const spawnSyncCalls = [];
  const spawnCalls = [];
  const spawnImpl = () => {
    spawnCalls.push(true);
    return {
      pid: 999,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    };
  };
  const spawnSyncImpl = (cmd, args, opts) => {
    spawnSyncCalls.push({ cmd, args, opts });
    return { status: 0 };
  };
  const h = await harness({
    spawnImpl, platform: 'win32', spawnSyncImpl, killImpl: () => { throw new Error('must not call the real killImpl on win32'); },
  });
  try {
    await h.store.createPilot(pilotInput({ gate: { command: 'sleep forever', timeoutMs: 60_000 } }));
    const tickPromise = h.supervisor.tick();
    await pollUntil(() => spawnCalls.length > 0, { message: 'the gate was never spawned' });
    await h.supervisor.stop();
    await tickPromise;

    assert.equal(spawnSyncCalls.length, 1, 'the stop()-triggered kill went through the injected spawnSyncImpl, not a real taskkill');
    assert.equal(spawnSyncCalls[0].cmd, 'taskkill');
    assert.ok(spawnSyncCalls[0].args.includes('999'));
    assert.equal(h.registry.created.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('the cross-pilot cap race is closed too: two overlapping runNow calls for DIFFERENT pilots hit maxConcurrentRuns at most once', async () => {
  const resolvers = [];
  const providers = {
    getProvider: (id) => ({
      id, label: id, efforts: ['low'],
      isAvailable: () => new Promise((resolve) => resolvers.push(resolve)),
    }),
  };
  const h = await harness({ providers });
  try {
    await h.store.updateSettings({ maxConcurrentRuns: 1 });
    const pB = await h.store.createPilot(pilotInput({ name: 'B' }));
    const pC = await h.store.createPilot(pilotInput({ name: 'C' }));

    const callB = h.supervisor.runNow(pB.id);
    const callC = h.supervisor.runNow(pC.id);

    while (resolvers.length < 2) {
      await new Promise((r) => setTimeout(r, 0));
    }
    resolvers.forEach((resolve) => resolve(true));

    const results = await Promise.all([callB, callC]);
    const fired = results.filter((r) => r.fired);
    const blocked = results.filter((r) => !r.fired);
    assert.equal(fired.length, 1, 'the concurrency cap allows exactly one of the two overlapping different-pilot calls to fire');
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].reason, /already running/i);
    assert.equal(h.registry.created.length, 1, 'only one session was ever created across two different pilots');
  } finally {
    await h.cleanup();
  }
});

test('a null entry in pilots is skipped without crashing the heartbeat, and dedupes like any other malformed record', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ name: 'Good' }));
    const raw = JSON.parse(await readFile(h.store.filePath, 'utf8'));
    raw.pilots.unshift(null);
    await writeFile(h.store.filePath, JSON.stringify(raw));

    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1, 'the well-formed pilot after the null entry still fires');
    assert.equal(h.registry.created[0].name, 'Good');
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped' && e.pilotId === null);
    assert.equal(skips.length, 1, 'a null pilot record is logged once, not once per heartbeat');

    h.advanceClock(HEARTBEAT_MS);
    await h.supervisor.tick();
    const skipsAfter = (await h.log.tail({})).filter((e) => e.event === 'skipped' && e.pilotId === null);
    assert.equal(skipsAfter.length, 1, 'still deduped on the next heartbeat');
  } finally {
    await h.cleanup();
  }
});

test('M12 label hoist: a rate-limited pilot\'s skip message uses the provider\'s display label, not its raw id', async () => {
  const providers = {
    getProvider: (id) => ({ id, label: 'Grok', efforts: ['low'], isAvailable: async () => true }),
  };
  const h = await harness({ providers });
  try {
    await h.store.createPilot(pilotInput({ provider: 'grok', effort: 'low' }));
    h.registry.rows.set('other', {
      id: 'other', provider: 'grok',
      rateLimitHit: { resetsAt: h.now() + 60 * MIN, rateLimitType: 'five_hour' },
    });
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /Grok is rate limited/, 'uses descriptor.label ("Grok"), not the raw provider id ("grok")');
  } finally {
    await h.cleanup();
  }
});

test('M12 label hoist: a pilot with an unknown provider that is also rate-limited reports the unknown provider first', async () => {
  const providers = {
    getProvider: (id) => { throw new Error(`unknown provider: ${id}`); },
  };
  const h = await harness({ providers });
  try {
    await h.store.createPilot(pilotInput({ provider: 'bogus' }));
    h.registry.rows.set('other', {
      id: 'other', provider: 'bogus',
      rateLimitHit: { resetsAt: h.now() + 60 * MIN, rateLimitType: 'five_hour' },
    });
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 0);
    const skips = (await h.log.tail({})).filter((e) => e.event === 'skipped');
    assert.match(skips[0].reason, /unknown provider/i, 'the more actionable "unknown provider" message wins over the rate-limit one');
  } finally {
    await h.cleanup();
  }
});

// --- Round 3 findings ---------------------------------------------------

test("New-1: stop() during an in-flight heartbeat drains rather than continuing - a later due pilot is not fired once A's killed gate unblocks the loop", async () => {
  const spawnCalls = [];
  const spawnImpl = () => {
    spawnCalls.push(true);
    return {
      pid: 777,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {}, // never emits exit/error - only stop()'s kill loop resolves it
      kill: () => {},
    };
  };
  const h = await harness({ spawnImpl, platform: 'linux', killImpl: () => {} });
  try {
    await h.store.createPilot(pilotInput({ name: 'A', gate: { command: 'sleep forever', timeoutMs: 60_000 } }));
    await h.store.createPilot(pilotInput({ name: 'B' })); // no gate - would fire immediately once evaluate() reached it
    const tickPromise = h.supervisor.tick();
    await pollUntil(() => spawnCalls.length > 0, { message: "pilot A's gate was never spawned" });

    await h.supervisor.stop();
    await tickPromise;

    assert.equal(h.registry.created.length, 0, 'B must not fire during a draining shutdown - before the fix, killing A\'s gate unblocked evaluate() and let it continue to B');
    assert.equal(spawnCalls.length, 1, 'no further gates were spawned either');
  } finally {
    await h.cleanup();
  }
});

test('New-1: stop() does not let the heartbeat spawn a fresh detached gate for the next due pilot either', async () => {
  const spawnCalls = [];
  const spawnImpl = () => {
    const pid = 700 + spawnCalls.length;
    spawnCalls.push(pid);
    return {
      pid,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    };
  };
  const h = await harness({ spawnImpl, platform: 'linux', killImpl: () => {} });
  try {
    await h.store.createPilot(pilotInput({ name: 'A', gate: { command: 'sleep forever', timeoutMs: 60_000 } }));
    await h.store.createPilot(pilotInput({ name: 'B', gate: { command: 'sleep forever', timeoutMs: 60_000 } }));
    const tickPromise = h.supervisor.tick();
    await pollUntil(() => spawnCalls.length > 0, { message: "pilot A's gate was never spawned" });

    await h.supervisor.stop();
    await tickPromise;

    assert.equal(spawnCalls.length, 1, "B's own gate must not spawn once shutdown is draining - stop()'s kill loop already ran and nothing kills a gate spawned after it");
    assert.equal(h.registry.created.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('New-1: fire() and runGate() both refuse new work directly once stopped, independent of the evaluate() loop check (runNow reaches them without going through that loop)', async () => {
  const spawnCalls = [];
  const spawnImpl = () => {
    spawnCalls.push(true);
    return { pid: 555, stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {} };
  };
  const h = await harness({ spawnImpl, platform: 'linux', killImpl: () => {} });
  try {
    const pilot = await h.store.createPilot(pilotInput({ gate: { command: 'sleep forever', timeoutMs: 60_000 } }));
    await h.supervisor.stop(); // no heartbeat ever ran - stop() still latches `stopping` for next callers

    const result = await h.supervisor.runNow(pilot.id);
    assert.equal(result.fired, false, 'runNow must not fire once autopilot is stopped');
    assert.equal(spawnCalls.length, 0, 'runGate must refuse to spawn once stopped, even reached directly through runNow rather than through evaluate()');
    assert.equal(h.registry.created.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('Round 3 New-2 (end-to-end): the well-formed pilot beside a null store entry records its terminal outcome and does not re-fire on the next heartbeat', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ name: 'Good' }));
    const raw = JSON.parse(await readFile(h.store.filePath, 'utf8'));
    raw.pilots.unshift(null);
    await writeFile(h.store.filePath, JSON.stringify(raw));

    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1, 'the well-formed pilot fires despite the null entry beside it');

    h.registry.emitRemoved('s-1', 'closed');
    await h.supervisor.drain();

    const storedGood = JSON.parse(await readFile(h.store.filePath, 'utf8')).pilots.find((p) => p && p.name === 'Good');
    assert.equal(storedGood.lastRunAt, h.now(), 'recordRun must stamp lastRunAt despite the null entry sharing the pilots array - the round-2 guard only covered the READ path, not this write path');
    assert.equal(storedGood.lastOutcome, 'closed-externally');

    h.advanceClock(HEARTBEAT_MS);
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1, 'lastRunAt was recorded, so the pilot is not due again - before the store fix, the swallowed recordRun failure left lastRunAt null and this fired a fresh, billing session every heartbeat instead');
  } finally {
    await h.cleanup();
  }
});
