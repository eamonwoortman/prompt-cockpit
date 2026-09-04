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

test('Round 3 New-2: a null entry in pilots does not crash getPilot, recordRun, setEnabled, updatePilot, deletePilot or name-uniqueness checks, and is never silently dropped by a write', async () => {
  const { dir, filePath, store } = await makeStore();
  try {
    const pilot = await store.createPilot(validInput({ name: 'Good' }));
    const raw = JSON.parse(await readFile(filePath, 'utf-8'));
    raw.pilots.unshift(null);
    await writeFile(filePath, JSON.stringify(raw));

    assert.equal((await store.getPilot(pilot.id)).id, pilot.id, 'getPilot skips the null entry rather than throwing on it');
    assert.equal(await store.getPilot('no-such-id'), null);

    const afterRecord = await store.recordRun(pilot.id, { lastRunAt: 123, lastOutcome: 'finished', consecutiveFailures: 0 });
    assert.equal(afterRecord.lastRunAt, 123, 'recordRun still finds and stamps the well-formed pilot beside the null entry');

    const afterEnable = await store.setEnabled(pilot.id, false);
    assert.equal(afterEnable.enabled, false);

    const afterUpdate = await store.updatePilot(pilot.id, { prompt: 'new prompt' });
    assert.equal(afterUpdate.prompt, 'new prompt');

    // assertNameFree is exercised through createPilot: must not throw
    // reading the null entry's `.name` while checking uniqueness, and must
    // not treat it as a name collision either.
    const second = await store.createPilot(validInput({ name: 'Second' }));
    assert.equal(second.name, 'Second');

    assert.equal(await store.deletePilot(pilot.id), true);
    const rawAfterDelete = JSON.parse(await readFile(filePath, 'utf-8'));
    assert.ok(
      rawAfterDelete.pilots.some((p) => p === null),
      'deletePilot must not silently drop the malformed null row - only hydrate() is allowed to be lenient about READING it, never a write',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an id of null or undefined is rejected outright by every id-taking method, never matched against a null pilots entry', async () => {
  // p?.id === id is what lets getPilot/recordRun/etc. skip a hand-edited
  // null row instead of crashing on it (see the "Round 3 New-2" test above).
  // Its sharp edge: p?.id reads as undefined for that row, so an id of
  // undefined or null would otherwise MATCH it - updatePilot would throw
  // deep inside normalizePilot instead of here, and deletePilot would
  // silently filter the null row out of the file, exactly the "never
  // silently dropped by a write" contract that null-safety exists to
  // uphold. requireId() closes that gap before any of that logic runs.
  const { dir, filePath, store } = await makeStore();
  try {
    const pilot = await store.createPilot(validInput({ name: 'Guarded' }));
    const raw = JSON.parse(await readFile(filePath, 'utf-8'));
    raw.pilots.unshift(null);
    await writeFile(filePath, JSON.stringify(raw));

    for (const badId of [null, undefined]) {
      await assert.rejects(() => store.getPilot(badId), (err) => err.code === 'ERR_INVALID_PILOT');
      await assert.rejects(() => store.updatePilot(badId, { prompt: 'x' }), (err) => err.code === 'ERR_INVALID_PILOT');
      await assert.rejects(() => store.deletePilot(badId), (err) => err.code === 'ERR_INVALID_PILOT');
      await assert.rejects(() => store.setEnabled(badId, false), (err) => err.code === 'ERR_INVALID_PILOT');
      await assert.rejects(() => store.recordRun(badId, { lastOutcome: 'finished' }), (err) => err.code === 'ERR_INVALID_PILOT');
    }

    // None of the rejected calls above touched the file: the null row is
    // still there, and the real pilot is untouched.
    const rawAfter = JSON.parse(await readFile(filePath, 'utf-8'));
    assert.ok(rawAfter.pilots.some((p) => p === null), 'the null row must survive every rejected call');
    assert.equal((await store.getPilot(pilot.id)).prompt, '/triage-backlog', 'the real pilot must be untouched');
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
