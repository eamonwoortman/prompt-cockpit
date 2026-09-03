// The durable half of auto-pilot: what a pilot IS, and the guarantees around
// editing it. Deliberately knows nothing about scheduling (autopilot-schedule.js)
// or firing (autopilot.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAutopilotStore,
  defaultAutopilotsPath,
  DEFAULT_SETTINGS,
  DEFAULT_MAX_TURN_STALL_MS,
} from '../src/autopilot-store.js';

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-store-'));
  const filePath = path.join(dir, 'autopilots.json');
  let n = 0;
  return { dir, filePath, store: createAutopilotStore({ filePath, idImpl: () => `id-${++n}` }) };
}

function validInput(over = {}) {
  return {
    name: 'Nightly triage',
    cwd: 'C:\\workspace\\git\\prompt-cockpit',
    provider: 'claude',
    mode: 'acceptEdits',
    prompt: '/triage-backlog',
    schedule: { everyMinutes: 30 },
    ...over,
  };
}

test('defaultAutopilotsPath sits beside the operator token', () => {
  assert.equal(defaultAutopilotsPath('/home/x'), path.join('/home/x', '.prompt-cockpit', 'autopilots.json'));
});

test('read on a missing file returns default settings and no pilots, without creating the file', async () => {
  const { dir, filePath, store } = await makeStore();
  try {
    assert.deepEqual(await store.read(), { settings: { ...DEFAULT_SETTINGS }, pilots: [] });
    await assert.rejects(() => readFile(filePath, 'utf-8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createPilot fills every default the spec defines', async () => {
  const { dir, store } = await makeStore();
  try {
    const pilot = await store.createPilot(validInput());
    assert.deepEqual(pilot, {
      id: 'id-1',
      name: 'Nightly triage',
      enabled: true,
      cwd: 'C:\\workspace\\git\\prompt-cockpit',
      provider: 'claude',
      model: null,
      effort: null,
      mode: 'acceptEdits',
      prompt: '/triage-backlog',
      schedule: { everyMinutes: 30, window: null },
      gate: null,
      inputPolicy: 'ask',
      maxTurnStallMs: DEFAULT_MAX_TURN_STALL_MS,
      lastRunAt: null,
      lastOutcome: null,
      consecutiveFailures: 0,
    });
    assert.deepEqual(await store.listPilots(), [pilot]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pilot names are unique case-insensitively across every pilot', async () => {
  const { dir, store } = await makeStore();
  try {
    await store.createPilot(validInput({ name: 'Nightly' }));
    await assert.rejects(
      () => store.createPilot(validInput({ name: 'nightly' })),
      (err) => err.code === 'ERR_NAME_TAKEN',
    );
    // Renaming a pilot to its own current name is not a collision.
    const second = await store.createPilot(validInput({ name: 'Other' }));
    const renamed = await store.updatePilot(second.id, { name: 'Other' });
    assert.equal(renamed.name, 'Other');
    await assert.rejects(
      () => store.updatePilot(second.id, { name: 'NIGHTLY' }),
      (err) => err.code === 'ERR_NAME_TAKEN',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createPilot rejects every invalid field with ERR_INVALID_PILOT', async () => {
  const { dir, store } = await makeStore();
  try {
    const bad = [
      validInput({ name: '   ' }),
      validInput({ cwd: '' }),
      validInput({ provider: '' }),
      validInput({ prompt: '  ' }),
      validInput({ mode: 'nonsense' }),
      validInput({ schedule: { everyMinutes: 0 } }),
      validInput({ schedule: { everyMinutes: 1.5 } }),
      validInput({ schedule: { everyMinutes: 30, window: { fromMinute: -1, toMinute: 60 } } }),
      validInput({ schedule: { everyMinutes: 30, window: { fromMinute: 0, toMinute: 1440 } } }),
      validInput({ schedule: { everyMinutes: 30, window: { fromMinute: 0, toMinute: 60, weekdays: [7] } } }),
      // Explicitly empty, NOT silently widened to all seven days - see
      // normalizeWindow's comment for the misfire that would cause.
      validInput({ schedule: { everyMinutes: 30, window: { fromMinute: 0, toMinute: 60, weekdays: [] } } }),
      validInput({ gate: { command: '', timeoutMs: 5000 } }),
      validInput({ gate: { command: 'git fetch', timeoutMs: 10 } }),
      validInput({ inputPolicy: 'sometimes' }),
      validInput({ maxTurnStallMs: 1000 }),
    ];
    for (const input of bad) {
      await assert.rejects(
        () => store.createPilot(input),
        (err) => err.code === 'ERR_INVALID_PILOT',
        `expected ${JSON.stringify(input)} to be rejected`,
      );
    }
    assert.deepEqual(await store.listPilots(), [], 'nothing partial was written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updatePilot patches only the given fields and cannot change the id', async () => {
  const { dir, store } = await makeStore();
  try {
    const pilot = await store.createPilot(validInput());
    const updated = await store.updatePilot(pilot.id, { id: 'hacked', prompt: 'new prompt', enabled: false });
    assert.equal(updated.id, pilot.id);
    assert.equal(updated.prompt, 'new prompt');
    assert.equal(updated.enabled, false);
    assert.equal(updated.name, 'Nightly triage', 'untouched fields survive');
    assert.equal(updated.schedule.everyMinutes, 30);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordRun stamps run bookkeeping without revalidating the whole pilot', async () => {
  const { dir, store } = await makeStore();
  try {
    const pilot = await store.createPilot(validInput());
    const after = await store.recordRun(pilot.id, { lastRunAt: 1_700_000_000_000, lastOutcome: 'finished', consecutiveFailures: 0 });
    assert.equal(after.lastRunAt, 1_700_000_000_000);
    assert.equal(after.lastOutcome, 'finished');
    assert.equal(after.consecutiveFailures, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deletePilot removes it and reports whether it existed', async () => {
  const { dir, store } = await makeStore();
  try {
    const pilot = await store.createPilot(validInput());
    assert.equal(await store.deletePilot(pilot.id), true);
    assert.equal(await store.deletePilot(pilot.id), false);
    assert.deepEqual(await store.listPilots(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateSettings validates and merges', async () => {
  const { dir, store } = await makeStore();
  try {
    assert.deepEqual(await store.updateSettings({ dailyCostCapUsd: 25 }), { dailyCostCapUsd: 25, maxConcurrentRuns: 2 });
    assert.deepEqual(await store.updateSettings({ dailyCostCapUsd: null }), { dailyCostCapUsd: null, maxConcurrentRuns: 2 });
    await assert.rejects(() => store.updateSettings({ maxConcurrentRuns: 0 }), (err) => err.code === 'ERR_INVALID_PILOT');
    await assert.rejects(() => store.updateSettings({ dailyCostCapUsd: -1 }), (err) => err.code === 'ERR_INVALID_PILOT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt autopilots.json is refused rather than silently replaced', async () => {
  const { dir, filePath, store } = await makeStore();
  try {
    const corrupt = '{ "pilots": [ }';
    await writeFile(filePath, corrupt, 'utf-8');
    // Lenient read still works so the UI can render "couldn't load" instead
    // of 500ing...
    assert.deepEqual(await store.read(), { settings: { ...DEFAULT_SETTINGS }, pilots: [] });
    // ...but a write must not destroy a file a human could fix by hand.
    await assert.rejects(() => store.createPilot(validInput()), /invalid JSON/);
    assert.equal(await readFile(filePath, 'utf-8'), corrupt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
