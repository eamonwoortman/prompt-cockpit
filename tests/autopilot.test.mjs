// The supervisor against an injected clock and a fake registry. Nothing here
// spawns a CLI, opens a socket, or reads the real ~/.prompt-cockpit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function harness({ nowMs = 1_000_000, providers = availableProviders, spawnImpl } = {}) {
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
  });
  return {
    dir, store, log, registry, tracker, supervisor,
    now: () => clock,
    setNow: (ms) => { clock = ms; },
    advanceClock: (ms) => { clock += ms; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
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
  } finally {
    await h.cleanup();
  }
});
