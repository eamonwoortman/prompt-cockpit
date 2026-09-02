# Auto-pilot Supervisor Implementation Plan (headless)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire new cockpit sessions on a schedule, unattended, with a durable pilot store, a run log, a spend cap, four distinguishable terminal outcomes, and Claude-only auto-answering of `AskUserQuestion` — all driven by HTTP with no UI.

**Architecture:** A single in-process ~15 s heartbeat (`src/autopilot.js`, dependency-injected in the shape of `createDelegation()`) evaluates every pilot and every live run. Pilots and settings persist to `~/.prompt-cockpit/autopilots.json`; run history appends to `~/.prompt-cockpit/autopilot-log.jsonl`, which also backs the daily spend total. Two new generic hooks on `session-registry.js` — `setSessionRemovedListener` and `setApprovalInterceptor` — let the supervisor learn that a row disappeared (and why) and auto-answer a question before the bell ever sees it, without the registry learning what a pilot is.

**Tech Stack:** Plain Node.js ESM, no new dependencies, no cron parser. `node --test`, injected clock, fake registry.

**Spec:** `docs/superpowers/specs/2026-09-01-auto-pilot-design.md` — this plan implements **Sequencing phases 3 and 4** ("Store, log, and supervisor — headless" and "Approval interceptor + `autopilot-answer`"). Phases 1–2 are `2026-09-01-process-ownership.md` and **must be merged first**. Phase 5 is `2026-09-01-auto-pilot-ui.md`.

## Global Constraints

- **No new npm dependencies.** Spec Decision 5: interval plus an active window, "no cron parser, no new dependency."
- **`npm test` spawns no CLI and touches no network.** Every clock, spawn, and registry dependency is injected.
- **Durable files live under `~/.prompt-cockpit/`**, beside the existing `operator-token` (`src/operator-auth.js:17`) and `runtime.json`. Every path overridable for tests.
- **At most one session per pilot runs at a time.** The lock is `activeSessionId` on the supervisor's own in-memory run state, checked against `registry.get()` — not a PID. A PID only proves a process exists; the row knows whether it is *running*, *blocked* or *idle*.
- **The spend cap is a precondition only. It never kills a run in flight.** Killing an agent mid-edit to save a few cents trades a small cost for a broken working tree.
- **`maxTurnStallMs` is a runaway backstop, not a hang detector.** Only `sdk:message` events go through the event log (`src/event-log.js:1-6`), so a single ten-minute tool call freezes `nextSeq` while the session is genuinely working. Default 60 minutes.
- **Auto-answering is Claude-only and governs `AskUserQuestion` only.** Tool permissions stay governed by the pilot's permission mode; end-of-plan approval is never auto-approved.
- **The approval interceptor must be synchronous and must scope itself to pilot-owned rows.** It is one process-global hook; unscoped it would silently auto-answer questions in hand-driven sessions.
- **`/api/*` routes inherit the operator token** (`src/server.js:75-78`). New auto-pilot routes are operator-gated but not session-token-gated, like `/api/browse`.
- **Nothing in this plan touches `public/`.** Phase 5 is a separate plan; this one is driven with `curl`.

## File Structure

| File | Responsibility |
|---|---|
| `src/autopilot-store.js` (create) | `autopilots.json` CRUD and validation over `json-store.js`. Knows the pilot schema and nothing about scheduling. |
| `src/autopilot-log.js` (create) | `autopilot-log.jsonl` append/tail/rotate, plus the local-midnight daily cost sum the cap reads. |
| `src/autopilot-schedule.js` (create) | Pure temporal math: due-ness, midnight-crossing windows, weekday sets, failure back-off, next-run. No Node imports — Phase 5 serves it to the browser via `SHARED_SRC_FILES`. |
| `src/autopilot-answer.js` (create) | Pure `AskUserQuestionInput` → `{ questions, answers }`. No I/O. |
| `src/autopilot.js` (create) | The supervisor: heartbeat, precondition chain, firing, terminal-outcome classification, completion, stall backstop, back-off, auto-disable, notification projection. |
| `src/routes/autopilot.js` (create) | The seven `/api/autopilots*` routes plus `/api/notifications`. |
| `src/session-registry.js` (modify) | `setSessionRemovedListener` + a single `removeSession(id, reason)` used at all three delete sites; `setApprovalInterceptor` consulted at the top of `handleApprovalRequest`. |
| `src/routes/sessions.js` (modify) | `GET /api/sessions/:id/attach-token`, pilot-owned sessions only. |
| `src/server.js` (modify) | Register the routes, construct the supervisor, start the heartbeat, register its stop with `shutdown.onBeforeClose`. |

---

### Task 1: `src/autopilot-store.js` — the pilot record store

**Files:**
- Create: `src/autopilot-store.js`
- Test: `tests/autopilot-store.test.mjs` (create)

**Interfaces:**
- Consumes: `readJson`, `updateJson` from `src/json-store.js`; `PERMISSION_MODES` from `src/permissions.js`.
- Produces:
  - `defaultAutopilotsPath(home?) => string` — `<home>/.prompt-cockpit/autopilots.json`
  - `DEFAULT_SETTINGS = { dailyCostCapUsd: 10, maxConcurrentRuns: 2 }`
  - `DEFAULT_MAX_TURN_STALL_MS = 3_600_000`
  - `createAutopilotStore({ filePath?, idImpl? }) => store` with
    `read()`, `listPilots()`, `getPilot(id)`, `createPilot(input)`, `updatePilot(id, patch)`, `deletePilot(id)`, `setEnabled(id, enabled)`, `recordRun(id, patch)`, `updateSettings(patch)` — all `Promise`-returning.
  - Pilot record shape (exactly the spec's): `{ id, name, enabled, cwd, provider, model, effort, mode, prompt, schedule: { everyMinutes, window }, gate, inputPolicy, maxTurnStallMs, lastRunAt, lastOutcome, consecutiveFailures }`.
  - Validation errors carry `err.code`: `ERR_NAME_TAKEN`, `ERR_INVALID_PILOT`. Routes turn the first into 409 and the second into 400.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-store.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/autopilot-store.test.mjs`
Expected: FAIL — `Cannot find module '.../src/autopilot-store.js'`.

- [ ] **Step 3: Write `src/autopilot-store.js`**

```js
// Durable auto-pilot configuration: ~/.prompt-cockpit/autopilots.json, one
// object with `settings` and `pilots`. Fourth persistent store in the app and
// the first that is genuinely cross-project - the other three
// (session-defaults/plugin-settings/session-titles/permission-rules) all live
// under one target project's .claude/settings.local.json, and a pilot is
// defined by the cwd it targets rather than owned by it.
//
// This module knows the pilot SCHEMA and nothing else: no clock, no
// scheduling (autopilot-schedule.js), no firing (autopilot.js). Provider and
// effort validity are deliberately NOT checked here - that would drag
// provider-registry.js (and through it the agent SDK) into a plain data
// store; routes/autopilot.js validates them with parseProvider instead, the
// same way routes/sessions.js already does for a live session.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { readJson, updateJson } from './json-store.js';
import { PERMISSION_MODES } from './permissions.js';

export const DEFAULT_SETTINGS = Object.freeze({ dailyCostCapUsd: 10, maxConcurrentRuns: 2 });

// A RUNAWAY BACKSTOP, not a hang detector - see the spec's "Stale detection".
// Progress is the event log's nextSeq advancing, and only sdk:message events
// go through that log, so a single long tool call (a build, a test suite, an
// npm install) freezes it while the session is genuinely working. An hour is
// long enough not to guillotine those; anything shorter force-closes healthy
// runs.
export const DEFAULT_MAX_TURN_STALL_MS = 60 * 60 * 1000;
export const MIN_MAX_TURN_STALL_MS = 60 * 1000;
export const INPUT_POLICIES = Object.freeze(['recommended', 'ask']);
const MAX_EVERY_MINUTES = 7 * 24 * 60;
const MINUTES_PER_DAY = 1440;

export function defaultAutopilotsPath(home = homedir()) {
  return path.join(home, '.prompt-cockpit', 'autopilots.json');
}

function invalid(message) {
  const err = new Error(message);
  err.code = 'ERR_INVALID_PILOT';
  return err;
}

function nameTaken(name) {
  const err = new Error(`a pilot named "${name}" already exists`);
  err.code = 'ERR_NAME_TAKEN';
  return err;
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function normalizeWindow(window) {
  if (window == null) return null;
  if (typeof window !== 'object') throw invalid('schedule.window must be an object or null');
  const { fromMinute, toMinute } = window;
  if (!isInt(fromMinute, 0, MINUTES_PER_DAY - 1)) throw invalid('schedule.window.fromMinute must be an integer minute-of-day (0-1439)');
  if (!isInt(toMinute, 0, MINUTES_PER_DAY - 1)) throw invalid('schedule.window.toMinute must be an integer minute-of-day (0-1439)');
  const raw = window.weekdays;
  // ABSENT means every day - a window given without a weekday set plainly
  // means "this time range, daily".
  //
  // An EXPLICITLY EMPTY array is rejected, not silently widened to all seven.
  // autopilot-schedule.js's isInsideWindow reads `[]` as "never" (it is a
  // plain `weekdays.includes(day)`), so widening it here would mean the form
  // warns "this pilot can never fire", the operator saves, and the store
  // quietly turns it into "fires every day" - the exact opposite, on an
  // unattended agent with write permissions.
  if (Array.isArray(raw) && raw.length === 0) {
    throw invalid('schedule.window.weekdays cannot be empty - select at least one day, or omit the field for every day');
  }
  const weekdays = raw == null ? [0, 1, 2, 3, 4, 5, 6] : raw;
  if (!Array.isArray(weekdays) || !weekdays.every((d) => isInt(d, 0, 6))) {
    throw invalid('schedule.window.weekdays must be integers 0-6 (Sunday-Saturday)');
  }
  return { fromMinute, toMinute, weekdays: [...new Set(weekdays)].sort((a, b) => a - b) };
}

function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw invalid('schedule is required');
  if (!isInt(schedule.everyMinutes, 1, MAX_EVERY_MINUTES)) {
    throw invalid(`schedule.everyMinutes must be an integer between 1 and ${MAX_EVERY_MINUTES}`);
  }
  return { everyMinutes: schedule.everyMinutes, window: normalizeWindow(schedule.window ?? null) };
}

function normalizeGate(gate) {
  if (gate == null) return null;
  if (typeof gate !== 'object') throw invalid('gate must be an object or null');
  const command = str(gate.command);
  if (!command) throw invalid('gate.command is required when a gate is set');
  if (!isInt(gate.timeoutMs, 1000, 600_000)) throw invalid('gate.timeoutMs must be an integer between 1000 and 600000');
  return { command, timeoutMs: gate.timeoutMs };
}

// Builds a complete, defaulted pilot record from `input`, merged over `base`
// (the existing record on an update, or an empty object on a create).
function normalizePilot(input, base = {}) {
  const merged = { ...base, ...input };
  const name = str(merged.name);
  if (!name) throw invalid('name is required');
  if (name.length > 80) throw invalid('name must be 80 characters or fewer');
  const cwd = str(merged.cwd);
  if (!cwd) throw invalid('cwd is required');
  const provider = str(merged.provider);
  if (!provider) throw invalid('provider is required');
  const prompt = typeof merged.prompt === 'string' ? merged.prompt.trim() : '';
  if (!prompt) throw invalid('prompt is required and is sent verbatim on every firing');
  const mode = str(merged.mode) || 'default';
  if (!PERMISSION_MODES.includes(mode)) throw invalid(`invalid mode: ${mode}`);
  const inputPolicy = str(merged.inputPolicy) || 'ask';
  if (!INPUT_POLICIES.includes(inputPolicy)) throw invalid(`invalid inputPolicy: ${inputPolicy}`);
  const maxTurnStallMs = merged.maxTurnStallMs ?? DEFAULT_MAX_TURN_STALL_MS;
  if (!isInt(maxTurnStallMs, MIN_MAX_TURN_STALL_MS, 24 * 60 * 60 * 1000)) {
    throw invalid(`maxTurnStallMs must be an integer between ${MIN_MAX_TURN_STALL_MS} and 86400000`);
  }
  return {
    id: base.id,
    name,
    enabled: merged.enabled === undefined ? true : Boolean(merged.enabled),
    cwd,
    provider,
    model: str(merged.model) || null,
    effort: str(merged.effort) || null,
    mode,
    prompt,
    schedule: normalizeSchedule(merged.schedule),
    gate: normalizeGate(merged.gate ?? null),
    inputPolicy,
    maxTurnStallMs,
    lastRunAt: base.lastRunAt ?? null,
    lastOutcome: base.lastOutcome ?? null,
    consecutiveFailures: base.consecutiveFailures ?? 0,
  };
}

function normalizeSettings(patch, base) {
  const merged = { ...base, ...patch };
  const cap = merged.dailyCostCapUsd;
  if (cap !== null && !(typeof cap === 'number' && Number.isFinite(cap) && cap >= 0)) {
    throw invalid('dailyCostCapUsd must be a non-negative number, or null for no cap');
  }
  if (!isInt(merged.maxConcurrentRuns, 1, 10)) throw invalid('maxConcurrentRuns must be an integer between 1 and 10');
  return { dailyCostCapUsd: cap, maxConcurrentRuns: merged.maxConcurrentRuns };
}

function hydrate(raw) {
  const settings = normalizeSettings({}, { ...DEFAULT_SETTINGS, ...(raw?.settings || {}) });
  const pilots = Array.isArray(raw?.pilots) ? raw.pilots : [];
  return { settings, pilots };
}

export function createAutopilotStore({ filePath = defaultAutopilotsPath(), idImpl = randomUUID } = {}) {
  // Lenient: a missing OR corrupt file reads as empty so the panel can render
  // "no pilots" rather than 500. updateJson below is what refuses to WRITE
  // over a corrupt file.
  async function read() {
    try {
      return hydrate(await readJson(filePath, null));
    } catch {
      // A settings block that fails validation (hand-edited) must not make the
      // whole store unreadable.
      return { settings: { ...DEFAULT_SETTINGS }, pilots: [] };
    }
  }

  async function listPilots() {
    return (await read()).pilots;
  }

  async function getPilot(id) {
    return (await listPilots()).find((p) => p.id === id) || null;
  }

  function assertNameFree(pilots, name, exceptId) {
    const target = name.trim().toLowerCase();
    if (pilots.some((p) => p.id !== exceptId && String(p.name || '').trim().toLowerCase() === target)) {
      throw nameTaken(name);
    }
  }

  // Every mutation goes through updateJson, so two tabs editing at once
  // serialize rather than corrupt. Last-write-wins on the record itself is
  // accepted (spec: "Acceptable for a single-operator tool").
  function mutate(fn) {
    return updateJson(filePath, (state) => {
      if (!state.settings) state.settings = { ...DEFAULT_SETTINGS };
      if (!Array.isArray(state.pilots)) state.pilots = [];
      return fn(state);
    }, { fallback: () => ({ settings: { ...DEFAULT_SETTINGS }, pilots: [] }) });
  }

  return {
    filePath,
    read,
    listPilots,
    getPilot,

    createPilot(input) {
      return mutate((state) => {
        const name = str(input?.name);
        if (name) assertNameFree(state.pilots, name, null);
        const pilot = normalizePilot(input, { id: idImpl() });
        state.pilots.push(pilot);
        return pilot;
      });
    },

    updatePilot(id, patch) {
      return mutate((state) => {
        const i = state.pilots.findIndex((p) => p.id === id);
        if (i < 0) throw invalid(`unknown pilot: ${id}`);
        const name = str(patch?.name);
        if (name) assertNameFree(state.pilots, name, id);
        // `id` on the patch is ignored: normalizePilot always takes it from
        // the existing record.
        const { id: _ignored, ...rest } = patch || {};
        const next = normalizePilot(rest, state.pilots[i]);
        state.pilots[i] = next;
        return next;
      });
    },

    deletePilot(id) {
      return mutate((state) => {
        const before = state.pilots.length;
        state.pilots = state.pilots.filter((p) => p.id !== id);
        return state.pilots.length !== before;
      });
    },

    setEnabled(id, enabled) {
      return mutate((state) => {
        const pilot = state.pilots.find((p) => p.id === id);
        if (!pilot) throw invalid(`unknown pilot: ${id}`);
        pilot.enabled = Boolean(enabled);
        return pilot;
      });
    },

    // Run bookkeeping only. Deliberately does NOT revalidate the record: the
    // supervisor writes this on every terminal outcome, and a pilot that was
    // hand-edited into an invalid state should still get its outcome recorded
    // rather than throwing inside the heartbeat.
    recordRun(id, { lastRunAt, lastOutcome, consecutiveFailures, enabled } = {}) {
      return mutate((state) => {
        const pilot = state.pilots.find((p) => p.id === id);
        if (!pilot) return null;
        if (lastRunAt !== undefined) pilot.lastRunAt = lastRunAt;
        if (lastOutcome !== undefined) pilot.lastOutcome = lastOutcome;
        if (consecutiveFailures !== undefined) pilot.consecutiveFailures = consecutiveFailures;
        if (enabled !== undefined) pilot.enabled = Boolean(enabled);
        return pilot;
      });
    },

    updateSettings(patch) {
      return mutate((state) => {
        state.settings = normalizeSettings(patch, { ...DEFAULT_SETTINGS, ...state.settings });
        return state.settings;
      });
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/autopilot-store.test.mjs`
Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot-store.js tests/autopilot-store.test.mjs
git commit -m "feat: autopilot-store for ~/.prompt-cockpit/autopilots.json"
```

---

### Task 2: `src/autopilot-log.js` — run history, rotation, and the daily spend total

**Files:**
- Create: `src/autopilot-log.js`
- Test: `tests/autopilot-log.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (plain `node:fs/promises`; the log is JSONL, not a JSON document, so `json-store.js` does not apply).
- Produces:
  - `defaultAutopilotLogPath(home?) => string`
  - `ROTATE_BYTES = 2 * 1024 * 1024`
  - `LOG_EVENTS` — `['fired','skipped','blocked','finished','timed-out','errored','closed-externally','carry-forward']`
  - `createAutopilotLog({ filePath?, now?, rotateBytes? }) => log` with
    `append(entry) => Promise<entry>`, `tail({ pilotId?, limit? }) => Promise<entry[]>`, `dailyCostUsd(atMs?) => Promise<{ costUsd, unpricedRuns }>`, `rotate() => Promise<boolean>`.
  - Entry shape: `{ ts, pilotId, pilotName, event, sessionId?, reason?, durationMs?, costUsd?, costUnpriced?, answered? }`. `answered` is `[{ question, chosenLabel }]`.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-log.test.mjs`:

```js
// Append-only run history. Backs the Logs tab AND the daily spend cap, which
// is why rotation is not just "truncate at 2 MB": rotating resets the day's
// computed total, so the day's running cost has to be carried into the fresh
// file or the cap silently resets mid-day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAutopilotLog, defaultAutopilotLogPath, ROTATE_BYTES } from '../src/autopilot-log.js';

async function makeLog(over = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-log-'));
  const filePath = path.join(dir, 'autopilot-log.jsonl');
  return { dir, filePath, log: createAutopilotLog({ filePath, ...over }) };
}

// A fixed local wall-clock instant, so the local-midnight boundary is
// unambiguous whatever TZ the test runs in.
function localTime(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

test('defaultAutopilotLogPath sits beside the operator token', () => {
  assert.equal(defaultAutopilotLogPath('/home/x'), path.join('/home/x', '.prompt-cockpit', 'autopilot-log.jsonl'));
});

test('append stamps ts, writes one JSON object per line, and tail reads newest-last', async () => {
  const { dir, filePath, log } = await makeLog({ now: () => 1_700_000_000_000 });
  try {
    await log.append({ event: 'fired', pilotId: 'p1', pilotName: 'Nightly', sessionId: 's1' });
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'Nightly', sessionId: 's1', costUsd: 0.42, durationMs: 90_000 });

    const raw = await readFile(filePath, 'utf-8');
    assert.equal(raw.trimEnd().split('\n').length, 2);
    const entries = await log.tail({});
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, 'fired');
    assert.equal(entries[0].ts, 1_700_000_000_000);
    assert.equal(entries[1].costUsd, 0.42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('append rejects an unknown event rather than writing an unreadable log', async () => {
  const { dir, log } = await makeLog();
  try {
    await assert.rejects(() => log.append({ event: 'exploded', pilotId: 'p1' }), /unknown auto-pilot log event/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail filters by pilotId and honours limit, keeping the newest entries', async () => {
  const { dir, log } = await makeLog();
  try {
    for (let i = 0; i < 5; i++) await log.append({ event: 'fired', pilotId: 'p1', pilotName: 'A', reason: `a${i}` });
    for (let i = 0; i < 5; i++) await log.append({ event: 'fired', pilotId: 'p2', pilotName: 'B', reason: `b${i}` });

    const p1 = await log.tail({ pilotId: 'p1' });
    assert.equal(p1.length, 5);
    assert.ok(p1.every((e) => e.pilotId === 'p1'));

    const last2 = await log.tail({ pilotId: 'p1', limit: 2 });
    assert.deepEqual(last2.map((e) => e.reason), ['a3', 'a4']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a torn final line from a crash is skipped, not fatal', async () => {
  const { dir, filePath, log } = await makeLog();
  try {
    await log.append({ event: 'fired', pilotId: 'p1', pilotName: 'A' });
    await appendFile(filePath, '{"event":"finished","pil', 'utf-8');
    const entries = await log.tail({});
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'fired');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dailyCostUsd sums every cost-bearing event since local midnight, not just finished', async () => {
  const noon = localTime(2026, 9, 1, 12, 0);
  const { dir, log } = await makeLog({ now: () => noon });
  try {
    // Yesterday - must not count.
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 99, ts: localTime(2026, 8, 31, 23, 59) });
    // Today. A timed-out run spent real money before it was killed.
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 1.25, ts: localTime(2026, 9, 1, 1, 0) });
    await log.append({ event: 'timed-out', pilotId: 'p1', pilotName: 'A', costUsd: 0.75, ts: localTime(2026, 9, 1, 2, 0) });
    await log.append({ event: 'errored', pilotId: 'p2', pilotName: 'B', costUsd: 0.5, ts: localTime(2026, 9, 1, 3, 0) });
    // No cost at all - contributes nothing but must not throw.
    await log.append({ event: 'skipped', pilotId: 'p2', pilotName: 'B', reason: 'outside window', ts: localTime(2026, 9, 1, 4, 0) });
    // Unpriced model: costForUsage returned null, so the cap can be exceeded.
    await log.append({ event: 'finished', pilotId: 'p3', pilotName: 'C', costUnpriced: true, ts: localTime(2026, 9, 1, 5, 0) });

    assert.deepEqual(await log.dailyCostUsd(noon), { costUsd: 2.5, unpricedRuns: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotate carries the current day total forward instead of truncating it away', async () => {
  const noon = localTime(2026, 9, 1, 12, 0);
  const { dir, filePath, log } = await makeLog({ now: () => noon, rotateBytes: 200 });
  try {
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 3, ts: localTime(2026, 9, 1, 8, 0) });
    await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'A', costUsd: 4, costUnpriced: true, ts: localTime(2026, 9, 1, 9, 0) });
    assert.deepEqual(await log.dailyCostUsd(noon), { costUsd: 7, unpricedRuns: 1 });

    assert.equal(await log.rotate(), true);

    // Old entries are gone from the live file...
    const entries = await log.tail({});
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'carry-forward');
    // ...but the day's total survives, which is the whole point.
    assert.deepEqual(await log.dailyCostUsd(noon), { costUsd: 7, unpricedRuns: 1 });
    // And the previous generation is still on disk to read.
    const rotated = await readFile(`${filePath}.1`, 'utf-8');
    assert.match(rotated, /"costUsd":3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('append rotates automatically once the file passes rotateBytes', async () => {
  const noon = localTime(2026, 9, 1, 12, 0);
  const { dir, filePath, log } = await makeLog({ now: () => noon, rotateBytes: 300 });
  try {
    for (let i = 0; i < 20; i++) {
      await log.append({ event: 'finished', pilotId: 'p1', pilotName: 'Nightly triage', costUsd: 0.1, ts: noon });
    }
    const size = (await stat(filePath)).size;
    assert.ok(size <= 300 + 512, `expected the live file to have rotated, got ${size} bytes`);
    // Every dollar still accounted for despite rotating mid-day.
    const { costUsd } = await log.dailyCostUsd(noon);
    assert.ok(Math.abs(costUsd - 2) < 1e-9, `expected 2.0, got ${costUsd}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the default rotate threshold is 2 MB', () => {
  assert.equal(ROTATE_BYTES, 2 * 1024 * 1024);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/autopilot-log.test.mjs`
Expected: FAIL — `Cannot find module '.../src/autopilot-log.js'`.

- [ ] **Step 3: Write `src/autopilot-log.js`**

```js
// Append-only auto-pilot run history: ~/.prompt-cockpit/autopilot-log.jsonl.
// One JSON object per line, deliberately NOT a json-store.js document - this
// grows without bound between rotations and is only ever appended to, so
// rewriting the whole file on every run would be wrong twice over.
//
// It backs two things: the panel's Logs tab, and the global daily spend cap.
// That second job is why rotation is not just "truncate at 2 MB" - rotating
// resets the day's computed total, so the routine carries the day's running
// cost into the fresh file as a `carry-forward` entry. At 2 MB rotation is
// unlikely within one day, but "unlikely" is not "never", and the failure
// mode is a spend cap that silently resets mid-day.
import { appendFile, readFile, rename, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const ROTATE_BYTES = 2 * 1024 * 1024;

// `carry-forward` is not one of the spec's outcome events - it is the
// synthetic first line rotate() writes so dailyCostUsd survives a rotation.
// It is excluded from tail()'s default view for the same reason.
// Two events beyond the spec's seven, both deliberate additions rather than
// overloading an existing one:
//   `answered`      - a question the interceptor auto-answered. That run was
//                     never blocked, so logging it as `blocked` would put an
//                     amber BLOCKED chip on a run that never stopped.
//   `carry-forward` - the synthetic first line rotate() writes so
//                     dailyCostUsd survives a rotation. Belongs to no pilot.
export const LOG_EVENTS = Object.freeze([
  'fired', 'skipped', 'blocked', 'answered', 'finished', 'timed-out', 'errored', 'closed-externally', 'carry-forward',
]);

export function defaultAutopilotLogPath(home = homedir()) {
  return path.join(home, '.prompt-cockpit', 'autopilot-log.jsonl');
}

function startOfLocalDay(atMs) {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn final line is what a hard kill mid-append leaves behind.
      // Skipping it beats making the whole log unreadable.
    }
  }
  return out;
}

export function createAutopilotLog({
  filePath = defaultAutopilotLogPath(),
  now = () => Date.now(),
  rotateBytes = ROTATE_BYTES,
} = {}) {
  // Serialize appends: two entries landing in the same tick must not
  // interleave partial lines.
  let chain = Promise.resolve();

  async function readAll() {
    try {
      return parseLines(await readFile(filePath, 'utf-8'));
    } catch {
      return []; // missing file - not an error
    }
  }

  function sumSince(entries, sinceMs) {
    let costUsd = 0;
    let unpricedRuns = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.ts !== 'number' || entry.ts < sinceMs) continue;
      // Every cost-bearing event counts, not just `finished` - a timed-out
      // run spent real money before it was killed.
      if (typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd)) costUsd += entry.costUsd;
      if (entry.costUnpriced) unpricedRuns += 1;
    }
    return { costUsd, unpricedRuns };
  }

  async function writeLine(entry) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  async function rotateNow() {
    let entries;
    try {
      entries = parseLines(await readFile(filePath, 'utf-8'));
    } catch {
      return false; // nothing to rotate
    }
    const at = now();
    const carried = sumSince(entries, startOfLocalDay(at));
    // Windows cannot rename over an existing file, and the SECOND rotation
    // always targets an existing .1 - so a bare rename here would reject the
    // append that triggered it, from inside the heartbeat. Same workaround as
    // json-store.js's writeJsonAtomic; duplicated deliberately, because this
    // file is JSONL and has no json-store helper to reuse.
    const previous = `${filePath}.1`;
    try {
      await rename(filePath, previous);
    } catch (err) {
      if (process.platform !== 'win32') throw err;
      await unlink(previous).catch(() => {});
      await rename(filePath, previous);
    }
    // One generation only. The live file starts with the day's running total
    // so the spend cap does not reset just because the log got long.
    await writeFile(filePath, `${JSON.stringify({
      ts: at,
      event: 'carry-forward',
      pilotId: null,
      pilotName: null,
      costUsd: carried.costUsd,
      costUnpriced: carried.unpricedRuns > 0,
      reason: `carried forward from ${path.basename(filePath)}.1`,
    })}\n`, 'utf-8');
    return true;
  }

  function enqueue(fn) {
    const run = chain.then(fn, fn);
    // Keep the chain alive after a rejection without swallowing it from the
    // caller - same reasoning as json-store.js's own `run.finally(...).catch`.
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    filePath,

    append(entry) {
      const event = entry?.event;
      if (!LOG_EVENTS.includes(event)) {
        return Promise.reject(new Error(`unknown auto-pilot log event: ${String(event)}`));
      }
      return enqueue(async () => {
        const record = { ts: entry.ts ?? now(), ...entry };
        // A rotation check BEFORE the write, so the carry-forward line is
        // never itself the thing that pushes the file over the threshold.
        try {
          const { size } = await stat(filePath);
          if (size >= rotateBytes) await rotateNow();
        } catch {
          // missing file - nothing to rotate
        }
        await writeLine(record);
        return record;
      });
    },

    // Newest last, matching how the Logs tab renders. `carry-forward` is
    // included only when a pilotId filter is absent, since it belongs to no
    // pilot.
    async tail({ pilotId = null, limit = 200 } = {}) {
      const entries = await readAll();
      const filtered = pilotId ? entries.filter((e) => e && e.pilotId === pilotId) : entries;
      return limit > 0 ? filtered.slice(-limit) : filtered;
    },

    async dailyCostUsd(atMs = now()) {
      return sumSince(await readAll(), startOfLocalDay(atMs));
    },

    rotate() {
      return enqueue(rotateNow);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/autopilot-log.test.mjs`
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot-log.js tests/autopilot-log.test.mjs
git commit -m "feat: autopilot run log with rotation that carries the day's spend forward"
```

---

### Task 3: `src/autopilot-schedule.js` — pure temporal math

**Files:**
- Create: `src/autopilot-schedule.js`
- Test: `tests/autopilot-schedule.test.mjs` (create)

**Interfaces:**
- Consumes: nothing. **No imports at all** — Phase 5 serves this file to the browser via `SHARED_SRC_FILES` (`src/static-files.js:13`), exactly like `permissions.js` and `stream-join.js`, so a Node import here would break the browser load.
- Produces:
  - `MAX_BACKOFF_MS = 6 * 60 * 60 * 1000`
  - `backoffMs(everyMinutes, consecutiveFailures) => number`
  - `dueAt(pilot) => number` — epoch-ms the pilot becomes due, `0` if it has never run.
  - `isDue(pilot, atMs) => boolean`
  - `isInsideWindow(window, atMs) => boolean`
  - `nextRunAt(pilot, atMs) => number | null` — the earliest instant it could fire, honouring the window; `null` if unreachable within 8 days.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-schedule.test.mjs`:

```js
// Pure schedule math against an explicit clock. No cron parser: interval plus
// an optional active window is the whole model (spec Decision 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs, dueAt, isDue, isInsideWindow, nextRunAt, MAX_BACKOFF_MS,
} from '../src/autopilot-schedule.js';

// Local wall-clock construction, so window tests mean the same thing in
// every TZ the suite runs in.
function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

const MIN = 60_000;

function pilot(over = {}) {
  return {
    schedule: { everyMinutes: 30, window: null },
    lastRunAt: null,
    consecutiveFailures: 0,
    ...over,
  };
}

test('a pilot that has never run is due immediately', () => {
  assert.equal(dueAt(pilot()), 0);
  assert.equal(isDue(pilot(), 0), true);
});

test('due-ness is lastRunAt plus the interval', () => {
  const p = pilot({ lastRunAt: 1_000_000 });
  assert.equal(dueAt(p), 1_000_000 + 30 * MIN);
  assert.equal(isDue(p, 1_000_000 + 30 * MIN - 1), false);
  assert.equal(isDue(p, 1_000_000 + 30 * MIN), true);
});

test('backoff doubles per consecutive failure and caps at 6 hours', () => {
  assert.equal(backoffMs(30, 0), 0);
  assert.equal(backoffMs(30, 1), 30 * MIN);
  assert.equal(backoffMs(30, 2), 60 * MIN);
  assert.equal(backoffMs(30, 3), 120 * MIN);
  assert.equal(backoffMs(30, 10), MAX_BACKOFF_MS);
  assert.equal(MAX_BACKOFF_MS, 6 * 60 * 60 * 1000);
});

test('back-off is ADDED to the interval, so even the first failure delays', () => {
  // The whole point: a pilot pointed at a broken cwd must not keep retrying
  // at its normal cadence after the first failure.
  assert.equal(dueAt(pilot({ lastRunAt: 0, consecutiveFailures: 0 })), 30 * MIN);
  assert.equal(dueAt(pilot({ lastRunAt: 0, consecutiveFailures: 1 })), 30 * MIN + 30 * MIN);
  assert.equal(dueAt(pilot({ lastRunAt: 0, consecutiveFailures: 2 })), 30 * MIN + 60 * MIN);
  assert.equal(dueAt(pilot({ lastRunAt: 0, consecutiveFailures: 3 })), 30 * MIN + 120 * MIN);
  // And it saturates rather than growing forever.
  assert.equal(dueAt(pilot({ lastRunAt: 0, consecutiveFailures: 20 })), 30 * MIN + MAX_BACKOFF_MS);
});

test('a null window is always open', () => {
  assert.equal(isInsideWindow(null, at(2026, 9, 1, 3, 0)), true);
});

test('a same-day window is half-open: inclusive start, exclusive end', () => {
  const window = { fromMinute: 9 * 60, toMinute: 17 * 60, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(isInsideWindow(window, at(2026, 9, 1, 8, 59)), false);
  assert.equal(isInsideWindow(window, at(2026, 9, 1, 9, 0)), true);
  assert.equal(isInsideWindow(window, at(2026, 9, 1, 16, 59)), true);
  assert.equal(isInsideWindow(window, at(2026, 9, 1, 17, 0)), false);
});

test('a weekday set gates the window (2026-09-01 is a Tuesday)', () => {
  assert.equal(new Date(at(2026, 9, 1, 12, 0)).getDay(), 2, 'sanity: Tuesday');
  const weekdaysOnly = { fromMinute: 0, toMinute: 23 * 60 + 59, weekdays: [1, 2, 3, 4, 5] };
  assert.equal(isInsideWindow(weekdaysOnly, at(2026, 9, 1, 12, 0)), true);   // Tue
  assert.equal(isInsideWindow(weekdaysOnly, at(2026, 9, 5, 12, 0)), false);  // Sat
  assert.equal(isInsideWindow(weekdaysOnly, at(2026, 9, 6, 12, 0)), false);  // Sun
});

test('a midnight-crossing window attributes the small hours to the day it OPENED', () => {
  // 22:00 Fri -> 06:00 Sat is one Friday window, not a Friday half and a
  // Saturday half. Without this, "overnight on weekdays" silently stops at
  // midnight - the single most likely real configuration.
  const overnight = { fromMinute: 22 * 60, toMinute: 6 * 60, weekdays: [5] }; // Friday only
  assert.equal(new Date(at(2026, 9, 4, 23, 0)).getDay(), 5, 'sanity: 2026-09-04 is a Friday');

  assert.equal(isInsideWindow(overnight, at(2026, 9, 4, 21, 59)), false);
  assert.equal(isInsideWindow(overnight, at(2026, 9, 4, 22, 0)), true);
  assert.equal(isInsideWindow(overnight, at(2026, 9, 4, 23, 59)), true);
  assert.equal(isInsideWindow(overnight, at(2026, 9, 5, 0, 0)), true, 'Saturday 00:00 still belongs to Friday night');
  assert.equal(isInsideWindow(overnight, at(2026, 9, 5, 5, 59)), true);
  assert.equal(isInsideWindow(overnight, at(2026, 9, 5, 6, 0)), false);
  // Saturday night is NOT in a Friday-only window.
  assert.equal(isInsideWindow(overnight, at(2026, 9, 5, 23, 0)), false);
});

test('fromMinute === toMinute means all day, not a zero-length window', () => {
  const allDay = { fromMinute: 0, toMinute: 0, weekdays: [2] };
  assert.equal(isInsideWindow(allDay, at(2026, 9, 1, 3, 0)), true);
  assert.equal(isInsideWindow(allDay, at(2026, 9, 2, 3, 0)), false, 'Wednesday is not in the set');
});

test('nextRunAt reports when a windowed pilot can actually fire next', () => {
  const window = { fromMinute: 9 * 60, toMinute: 17 * 60, weekdays: [1, 2, 3, 4, 5] };
  const p = pilot({ schedule: { everyMinutes: 30, window }, lastRunAt: at(2026, 9, 1, 16, 50) });
  // Due at 17:20, but the window shut at 17:00 - next opening is Wednesday 09:00.
  assert.equal(nextRunAt(p, at(2026, 9, 1, 17, 0)), at(2026, 9, 2, 9, 0));

  // Already due and inside the window - it can fire right now.
  const ready = pilot({ schedule: { everyMinutes: 30, window }, lastRunAt: at(2026, 9, 1, 10, 0) });
  assert.equal(nextRunAt(ready, at(2026, 9, 1, 12, 0)), at(2026, 9, 1, 12, 0));
});

test('nextRunAt returns null when no opening exists within 8 days', () => {
  const impossible = pilot({ schedule: { everyMinutes: 30, window: { fromMinute: 0, toMinute: 0, weekdays: [] } } });
  assert.equal(nextRunAt(impossible, at(2026, 9, 1, 12, 0)), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/autopilot-schedule.test.mjs`
Expected: FAIL — `Cannot find module '.../src/autopilot-schedule.js'`.

- [ ] **Step 3: Write `src/autopilot-schedule.js`**

```js
// Pure schedule math for auto-pilot: when is a pilot due, is it inside its
// active window, how long does a failure back-off delay it, and when could it
// next fire. Interval plus an optional window - no cron parser, no dependency
// (spec Decision 5).
//
// NO IMPORTS, deliberately: this file is served verbatim to the browser via
// static-files.js's SHARED_SRC_FILES, the same way permissions.js and
// stream-join.js already are, so the panel's "next run" label and the
// server's own due-ness check can never disagree. A `node:` import here would
// break the browser load.

export const MINUTES_PER_DAY = 1440;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60_000;
const NEXT_RUN_SEARCH_DAYS = 8;

// Repeated failures back the pilot off exponentially rather than retrying a
// broken configuration every interval forever. n = consecutive failures.
export function backoffMs(everyMinutes, consecutiveFailures) {
  const n = Number(consecutiveFailures) || 0;
  if (n < 1) return 0;
  const base = Number(everyMinutes) * MS_PER_MINUTE;
  // 2^(n-1), clamped before the multiply overflows into Infinity for a large n.
  const factor = Math.pow(2, Math.min(n - 1, 32));
  return Math.min(base * factor, MAX_BACKOFF_MS);
}

// Back-off is ADDITIONAL to the interval, per the spec's "delays the next
// firing by min(everyMinutes x 2^(n-1), 6h)".
//
// The tempting alternative - max(interval, backoff) - looks equivalent but
// has a hole: backoffMs(every, 1) === every * 60000 exactly, so the FIRST
// failure would produce no delay at all, and a 2-minute pilot pointed at a
// broken cwd would retry every 2 minutes indefinitely. Adding means n=1
// already doubles the wait.
export function dueAt(pilot) {
  if (!pilot || pilot.lastRunAt == null) return 0;
  const everyMinutes = pilot.schedule?.everyMinutes || 0;
  const interval = everyMinutes * MS_PER_MINUTE;
  return pilot.lastRunAt + interval + backoffMs(everyMinutes, pilot.consecutiveFailures);
}

export function isDue(pilot, atMs) {
  return atMs >= dueAt(pilot);
}

// A window is [fromMinute, toMinute) in local minutes-of-day, restricted to a
// weekday set. Two cases the naive version gets wrong, both real
// configurations rather than edge-case pedantry:
//
//  - fromMinute > toMinute crosses midnight (22:00-06:00). The WEEKDAY is the
//    day the window OPENED, so 01:00 Saturday belongs to Friday's window -
//    otherwise "overnight on weekdays" silently stops at midnight.
//  - fromMinute === toMinute means all day, not a zero-length window nobody
//    could ever have meant.
export function isInsideWindow(window, atMs) {
  if (!window) return true;
  const d = new Date(atMs);
  const minute = d.getHours() * 60 + d.getMinutes();
  const day = d.getDay();
  const weekdays = Array.isArray(window.weekdays) ? window.weekdays : [];
  const { fromMinute, toMinute } = window;

  if (fromMinute === toMinute) return weekdays.includes(day);
  if (fromMinute < toMinute) {
    return weekdays.includes(day) && minute >= fromMinute && minute < toMinute;
  }
  if (minute >= fromMinute) return weekdays.includes(day);
  if (minute < toMinute) return weekdays.includes((day + 6) % 7); // yesterday
  return false;
}

// The earliest instant this pilot could fire: due-ness first, then the next
// minute the window is open. Minute-granular scan rather than closed-form
// arithmetic, because DST transitions make "add 24 hours" wrong twice a year
// and this runs at most a few thousand cheap iterations, on demand, for a
// label.
export function nextRunAt(pilot, atMs) {
  const earliest = Math.max(atMs, dueAt(pilot));
  const window = pilot?.schedule?.window ?? null;
  if (!window) return earliest;
  // Align to the minute so the scan lands on window boundaries exactly.
  let cursor = Math.ceil(earliest / MS_PER_MINUTE) * MS_PER_MINUTE;
  if (isInsideWindow(window, earliest)) return earliest;
  const limit = cursor + NEXT_RUN_SEARCH_DAYS * MINUTES_PER_DAY * MS_PER_MINUTE;
  while (cursor <= limit) {
    if (isInsideWindow(window, cursor)) return cursor;
    cursor += MS_PER_MINUTE;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/autopilot-schedule.test.mjs`
Expected: PASS, 11/11.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot-schedule.js tests/autopilot-schedule.test.mjs
git commit -m "feat: pure autopilot schedule math with midnight-crossing windows"
```

---

### Task 4: `setSessionRemovedListener` on the registry

Rows leave the registry through three paths, only one of which is completion. Without a hook that names the reason, a supervisor can only test "is the row gone?" — and a session dying at startup (missing CLI, bad model, invalid cwd) becomes a 15-second spawn loop.

**Files:**
- Modify: `src/session-registry.js` (the three `sessions.delete(id)` sites at `:343`, `:785`, `:1426`; `_reset` at `:349`)
- Test: `tests/session-registry.test.mjs` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `setSessionRemovedListener(fn | null)` — `fn({ id, reason })` where `reason` is `'closed'` or `'error'`. Synchronous; a throw is caught and logged.
  - `_reset()` additionally clears the listener, so test files cannot leak one into each other.

- [ ] **Step 1: Write the failing test**

Append to `tests/session-registry.test.mjs` (it already imports `registry` and `fakeStartSession` from `./test-helpers.mjs`):

```js
test('setSessionRemovedListener fires with reason "closed" for an explicit close', () => {
  registry._reset();
  const seen = [];
  registry.setSessionRemovedListener((e) => seen.push(e));
  try {
    const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
    registry.closeSession(row.id);
    assert.deepEqual(seen, [{ id: row.id, reason: 'closed' }]);
    // Already gone - a second close must not fire it again.
    registry.closeSession(row.id);
    assert.equal(seen.length, 1);
  } finally {
    registry._reset();
  }
});

test('setSessionRemovedListener fires with reason "closed" when the handle ends on its own', () => {
  registry._reset();
  const seen = [];
  registry.setSessionRemovedListener((e) => seen.push(e));
  try {
    const impl = fakeStartSession();
    const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
    impl.emitState('closed');
    assert.deepEqual(seen, [{ id: row.id, reason: 'closed' }]);
  } finally {
    registry._reset();
  }
});

test('setSessionRemovedListener fires with reason "error" for both error paths', () => {
  registry._reset();
  const seen = [];
  registry.setSessionRemovedListener((e) => seen.push(e));
  try {
    const viaState = fakeStartSession();
    const a = registry.createSession({ cwd: '/tmp', name: 'A', startSessionImpl: viaState });
    viaState.emitState('error');

    const viaError = fakeStartSession();
    const b = registry.createSession({ cwd: '/tmp', name: 'B', startSessionImpl: viaError });
    viaError.emitError(new Error('CLI died'));

    assert.deepEqual(seen, [
      { id: a.id, reason: 'error' },
      { id: b.id, reason: 'error' },
    ]);
  } finally {
    registry._reset();
  }
});

test('a throwing session-removed listener does not break session teardown', () => {
  registry._reset();
  registry.setSessionRemovedListener(() => { throw new Error('listener blew up'); });
  try {
    const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
    assert.equal(registry.closeSession(row.id), true);
    assert.equal(registry.get(row.id), undefined);
  } finally {
    registry._reset();
  }
});

test('_reset clears the session-removed listener so test files cannot leak one', () => {
  registry._reset();
  const seen = [];
  registry.setSessionRemovedListener((e) => seen.push(e));
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  registry.closeSession(row.id);
  assert.deepEqual(seen, []);
  registry._reset();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-registry.test.mjs`
Expected: FAIL — `registry.setSessionRemovedListener is not a function`.

- [ ] **Step 3: Add the hook to `src/session-registry.js`**

Add just below the `const sessions = new Map();` line (`src/session-registry.js:32`):

```js
// Auto-pilot's terminal-outcome classifier (src/autopilot.js). Rows leave
// `sessions` through THREE paths and only one of them is completion:
// setState's 'closed'/'error' reap, handleError's own reap, and closeSession
// (the supervisor's completion path, the DELETE route, and the user's "Close
// session" button). A supervisor that can only test "is the row gone?" cannot
// tell them apart - so on a crash or a human close it never stamps lastRunAt,
// the pilot is due and lock-free on the very next heartbeat, and a session
// dying at startup becomes a 15-second spawn loop.
//
// Like the approval interceptor below, the registry learns only that a
// listener MAY exist - never what a pilot is.
let sessionRemovedListener = null;

export function setSessionRemovedListener(fn) {
  sessionRemovedListener = typeof fn === 'function' ? fn : null;
}

// The single place a row is dropped. `reason` is 'closed' or 'error'.
function removeSession(id, reason) {
  if (!sessions.delete(id)) return false;
  try {
    sessionRemovedListener?.({ id, reason });
  } catch (err) {
    console.error(`session-removed listener failed for ${id}:`, err);
  }
  return true;
}
```

Then replace the three delete sites:

- `src/session-registry.js:343` (in `closeSession`): `sessions.delete(id);` → `removeSession(id, 'closed');`
- `src/session-registry.js:785` (in `setState`): `if (state === 'closed' || state === 'error') sessions.delete(id);` → `if (state === 'closed' || state === 'error') removeSession(id, state === 'error' ? 'error' : 'closed');`
- `src/session-registry.js:1426` (in `handleError`): `sessions.delete(id);` → `removeSession(id, 'error');`

And extend `_reset` (`src/session-registry.js:349-351`):

```js
// Test-only: drop all rows so test files don't leak state into each other
// via this module's singleton map. Also drops the process-global hooks, for
// the same reason - a listener registered by one test file would otherwise
// keep firing for every other file's sessions.
export function _reset() {
  sessions.clear();
  sessionRemovedListener = null;
  approvalInterceptor = null;
}
```

(`approvalInterceptor` is declared in Task 7. If you are running tasks strictly in order, add that line in Task 7 instead and leave `_reset` with just the two statements here.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/session-registry.test.mjs`
Expected: PASS, existing tests plus the 5 new ones.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session-registry.js tests/session-registry.test.mjs
git commit -m "feat: setSessionRemovedListener so a caller can tell a close from a crash"
```

---

### Task 5: `src/autopilot.js` — heartbeat, preconditions, and firing

**Files:**
- Create: `src/autopilot.js`
- Test: `tests/autopilot.test.mjs` (create)

**Interfaces:**
- Consumes: `autopilot-store.js` (Task 1), `autopilot-log.js` (Task 2), `autopilot-schedule.js` (Task 3), `setSessionRemovedListener` (Task 4), `killProcessTree` + `tracker.orphanPilotIds()` + `tracker.attachPilot/detachPilot` (process-ownership plan).
- Produces:
  - `HEARTBEAT_MS = 15_000`
  - `createAutopilot({ registry, store, log, tracker, providers, now, setIntervalImpl, clearIntervalImpl, spawnImpl, logImpl }) => supervisor`
  - `supervisor.start()`, `supervisor.stop()`, `supervisor.tick() => Promise<void>` (one heartbeat, awaited — what tests drive), `supervisor.drain() => Promise<void>` (awaits every in-flight async record started by the synchronous removal listener).
  - `supervisor.runNow(pilotId) => Promise<{ fired: true, sessionId } | { fired: false, reason }>`
  - `supervisor.status() => [{ pilotId, sessionId, startedAt, sawResult, blocked }]` — note `blocked`, not `state`; `public/autopilot-panel.js` reads `blocked` and `startedAt`, and `server.js`'s `isPilotOwned` reads `sessionId`.
  - **Precondition order deviates from the spec's numbering, deliberately:** `blockingReason` runs 4 (lock/orphan) → 8a (concurrency) → 5 (provider) → 7 (rate limit) → 8b (cap) → 6 (gate). Concurrency is hoisted because it is a free in-memory check; the gate is demoted to last because it is the only precondition that costs a subprocess. Same set, cheapest-first.
  - `providers` defaults to `src/provider-registry.js`'s `getProvider`; injected so tests never touch the SDK.
- Task 6 adds terminal-outcome classification to this same module; Task 7 adds the approval interceptor wiring.

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/autopilot.test.mjs`
Expected: FAIL — `Cannot find module '.../src/autopilot.js'`.

- [ ] **Step 3: Write `src/autopilot.js` (firing half)**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/autopilot.test.mjs`
Expected: PASS — all 21 tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot.js tests/autopilot.test.mjs
git commit -m "feat: autopilot supervisor heartbeat, precondition chain and firing"
```

---

### Task 6: Terminal outcomes, completion, and the stall backstop

**Files:**
- Modify: `src/autopilot.js` (replace the `recordOutcome`, `reviewRuns` and `finishRun` stubs from Task 5)
- Test: `tests/autopilot.test.mjs` (append)

**Interfaces:**
- Consumes: Task 5's `runs` map, `log`, `store`.
- Produces: the four-outcome classification table and its effect on `lastRunAt` / `consecutiveFailures`:

| Outcome | Trigger | `lastRunAt` | Failure count |
|---|---|---|---|
| `finished` | supervisor closed it after completion | stamped | reset to 0 |
| `timed-out` | supervisor closed it after a stall | stamped | incremented |
| `errored` | removed with reason `'error'` | stamped | incremented |
| `closed-externally` | removed with reason `'closed'`, not by us | stamped | reset to 0 |

Plus `MAX_CONSECUTIVE_FAILURES = 5` (auto-disable), and `supervisor.notifications() => { entries }` — the derived projection Task 8's `/api/notifications` serves.

- [ ] **Step 1: Write the failing tests**

Append to `tests/autopilot.test.mjs`:

```js
test('completion needs idle AND an empty queue AND no pending approval AND at least one result', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.supervisor.tick();
    const row = h.registry.get('s-1');

    // Freshly created: idle before the prompt even lands. Closing here would
    // be wrong, which is exactly why sawResult is load-bearing.
    row.state = 'idle';
    await h.supervisor.tick();
    assert.deepEqual(h.registry.closed, [], 'no result yet - not complete');

    h.registry.advance('s-1', { result: true, state: 'idle' });
    await h.supervisor.tick();
    await h.supervisor.drain();

    assert.deepEqual(h.registry.closed, ['s-1']);
    const after = await h.store.getPilot(p.id);
    assert.equal(after.lastOutcome, 'finished');
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.lastRunAt, h.now());
    const events = (await h.log.tail({})).map((e) => e.event);
    assert.deepEqual(events, ['fired', 'finished']);
  } finally {
    await h.cleanup();
  }
});

test('a non-empty queue or a pending approval defers completion', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput());
    await h.supervisor.tick();
    const row = h.registry.get('s-1');
    h.registry.advance('s-1', { result: true, state: 'idle' });

    row.queue = [{ id: 'q1', text: 'later' }];
    await h.supervisor.tick();
    assert.deepEqual(h.registry.closed, []);

    row.queue = [];
    row.pendingApprovals = [{ requestId: 'r1', toolName: 'Bash' }];
    await h.supervisor.tick();
    assert.deepEqual(h.registry.closed, []);

    row.pendingApprovals = [];
    await h.supervisor.tick();
    await h.supervisor.drain();
    assert.deepEqual(h.registry.closed, ['s-1']);
  } finally {
    await h.cleanup();
  }
});

test('a finished run records the session cost, and flags an unpriced model', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput());
    await h.supervisor.tick();
    const row = h.registry.get('s-1');
    row.usageAcc = { snapshot: () => ({ costUsd: 1.75, unpriced: ['some-new-model'] }) };
    h.registry.advance('s-1', { result: true, state: 'idle' });

    h.advanceClock(90_000);
    await h.supervisor.tick();
    await h.supervisor.drain();

    const finished = (await h.log.tail({})).find((e) => e.event === 'finished');
    assert.equal(finished.costUsd, 1.75);
    assert.equal(finished.costUnpriced, true);
    assert.equal(finished.durationMs, 90_000);
  } finally {
    await h.cleanup();
  }
});

test('a row removed with reason "error" records errored and increments the failure count', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.supervisor.tick();
    h.registry.emitRemoved('s-1', 'error');
    await h.supervisor.drain();

    const after = await h.store.getPilot(p.id);
    assert.equal(after.lastOutcome, 'errored');
    assert.equal(after.consecutiveFailures, 1);
    assert.equal(after.lastRunAt, h.now(), 'stamped, so this is not a 15-second spawn loop');
    assert.ok((await h.log.tail({})).some((e) => e.event === 'errored'));
  } finally {
    await h.cleanup();
  }
});

test('a human closing the pilot\'s session records closed-externally and is NOT a failure', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.store.recordRun(p.id, { consecutiveFailures: 3 });
    await h.supervisor.tick();

    // The DELETE route / "Close session" button, not us.
    h.registry.closeSession('s-1');
    await h.supervisor.drain();

    const after = await h.store.getPilot(p.id);
    assert.equal(after.lastOutcome, 'closed-externally');
    assert.equal(after.consecutiveFailures, 0, 'a human close is intentional, not a failure');
    assert.equal(after.lastRunAt, h.now());
  } finally {
    await h.cleanup();
  }
});

test('a stalled run is force-closed as timed-out once maxTurnStallMs passes with no new events', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput({ maxTurnStallMs: 10 * MIN }));
    await h.supervisor.tick();

    h.advanceClock(5 * MIN);
    h.registry.advance('s-1', { seq: 40 });   // progress resets the stall clock
    await h.supervisor.tick();
    assert.deepEqual(h.registry.closed, []);

    h.advanceClock(9 * MIN);
    await h.supervisor.tick();
    assert.deepEqual(h.registry.closed, [], 'still under the backstop');

    h.advanceClock(2 * MIN);
    await h.supervisor.tick();
    await h.supervisor.drain();

    assert.deepEqual(h.registry.closed, ['s-1']);
    const after = await h.store.getPilot(p.id);
    assert.equal(after.lastOutcome, 'timed-out');
    assert.equal(after.consecutiveFailures, 1);
    assert.ok((await h.log.tail({})).some((e) => e.event === 'timed-out'));
  } finally {
    await h.cleanup();
  }
});

test('a run blocked on a pending approval is exempt from the stall backstop, logged once, and keeps the lock', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ maxTurnStallMs: 10 * MIN }));
    await h.supervisor.tick();
    h.registry.get('s-1').pendingApprovals = [{ requestId: 'r1', toolName: 'Bash' }];

    for (let i = 0; i < 4; i++) {
      h.advanceClock(30 * MIN);
      await h.supervisor.tick();
    }

    assert.deepEqual(h.registry.closed, [], 'blocked is waiting for a human, not a runaway');
    const blocked = (await h.log.tail({})).filter((e) => e.event === 'blocked');
    assert.equal(blocked.length, 1, 'logged once, not once per heartbeat');
    assert.equal(h.supervisor.status().length, 1, 'still holds the lock');
  } finally {
    await h.cleanup();
  }
});

test('five consecutive failures auto-disable the pilot and surface an actionable notification', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    for (let i = 1; i <= 5; i++) {
      // Clear the back-off each round so the next tick fires again.
      await h.store.recordRun(p.id, { lastRunAt: null, consecutiveFailures: i - 1 });
      await h.supervisor.tick();
      h.registry.emitRemoved(`s-${i}`, 'error');
      await h.supervisor.drain();
    }

    const after = await h.store.getPilot(p.id);
    assert.equal(after.consecutiveFailures, 5);
    assert.equal(after.enabled, false, 'auto-disabled');

    const notes = await h.supervisor.notifications();
    const disabled = notes.entries.find((e) => e.kind === 'auto-disabled');
    assert.equal(disabled.pilotId, p.id);
    assert.match(disabled.message, /re-enable/i);
  } finally {
    await h.cleanup();
  }
});

test('the spend cap NEVER kills a run already in flight', async () => {
  const h = await harness();
  try {
    await h.store.updateSettings({ dailyCostCapUsd: 1 });
    await h.store.createPilot(pilotInput({ maxTurnStallMs: 24 * 60 * MIN }));
    await h.supervisor.tick();
    assert.equal(h.registry.created.length, 1);

    // Blow way past the cap while the run is mid-flight.
    await h.log.append({ event: 'finished', pilotId: 'other', pilotName: 'other', costUsd: 999, ts: h.now() });
    h.advanceClock(HEARTBEAT_MS);
    await h.supervisor.tick();
    await h.supervisor.drain();

    // Killing an agent mid-edit to save a few cents trades a small cost for a
    // broken working tree. The cap is a precondition on FIRING only.
    assert.deepEqual(h.registry.closed, []);
    assert.equal(h.supervisor.status().length, 1, 'still running, still holding the lock');
  } finally {
    await h.cleanup();
  }
});

test('a successful run resets the failure count', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    await h.store.recordRun(p.id, { consecutiveFailures: 3 });
    await h.supervisor.tick();
    h.registry.advance('s-1', { result: true, state: 'idle' });
    await h.supervisor.tick();
    await h.supervisor.drain();
    assert.equal((await h.store.getPilot(p.id)).consecutiveFailures, 0);
  } finally {
    await h.cleanup();
  }
});

test('notifications project pending approvals on pilot-owned rows that a human must answer', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput({ inputPolicy: 'ask' }));
    await h.supervisor.tick();
    h.registry.get('s-1').pendingApprovals = [{ requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf build' } }];

    const notes = await h.supervisor.notifications();
    const entry = notes.entries.find((e) => e.kind === 'needs-input');
    assert.equal(entry.pilotId, p.id);
    assert.equal(entry.sessionId, 's-1');
    assert.equal(entry.toolName, 'Bash');

    // Derived, never stored: the entry vanishes when the state it was
    // computed from is gone.
    h.registry.get('s-1').pendingApprovals = [];
    assert.equal((await h.supervisor.notifications()).entries.some((e) => e.kind === 'needs-input'), false);
  } finally {
    await h.cleanup();
  }
});

test('stop() awaits the in-flight tick and every pending outcome record', async () => {
  const h = await harness();
  try {
    const p = await h.store.createPilot(pilotInput());
    h.supervisor.start();
    await h.supervisor.tick();
    h.registry.emitRemoved('s-1', 'error');
    await h.supervisor.stop();
    assert.equal((await h.store.getPilot(p.id)).lastOutcome, 'errored', 'no write was left in flight');
  } finally {
    await h.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/autopilot.test.mjs`
Expected: FAIL — completion never happens (`reviewRuns` is a stub), `supervisor.notifications is not a function`, and outcomes are all recorded with `consecutiveFailures: 1`.

- [ ] **Step 3: Replace the three stubs in `src/autopilot.js`**

Add near the top, beside `HEARTBEAT_MS`:

```js
// Five failures in a row is a broken configuration, not bad luck. Disabling
// is actionable - a human must re-enable it - so it also raises a bell entry.
export const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_OUTCOMES = new Set(['timed-out', 'errored']);
```

Replace `recordOutcome`:

```js
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
      logImpl(`autopilot: "${pilot.name}" auto-disabled after ${failures} consecutive failures`);
    }
    return updated;
  }
```

Replace `finishRun`:

```js
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
    if (run.costUsd != null) entry.costUsd = run.costUsd;
    if (run.costUnpriced) entry.costUnpriced = true;
    if (run.reason) entry.reason = run.reason;
    await log.append(entry);
    await recordOutcome(pilotId, outcome, at);
  }
```

Replace `reviewRuns`:

```js
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
    for (const [pilotId, run] of [...runs]) {
      const row = registry.get(run.sessionId);
      if (!row) continue; // onSessionRemoved already classified it
      const pilot = pilotsById.get(pilotId);
      if (!pilot) continue; // deleted mid-run; the DELETE route force-closes it

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
          await log.append({
            event: 'blocked', pilotId, pilotName: pilot.name, sessionId: run.sessionId,
            reason: `waiting on approval for ${row.pendingApprovals[0]?.toolName || 'a tool call'}`,
          });
        }
        continue;
      }
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
        registry.closeSession(run.sessionId);
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
        registry.closeSession(run.sessionId);
      }
    }
  }
```

And add `notifications` before the `return`:

```js
  // Derived, never stored: a projection over live state. There is nothing to
  // persist and nothing to mark read - an entry vanishes when the state it
  // was computed from is gone.
  async function notifications() {
    const { pilots } = await store.read();
    const byId = new Map(pilots.map((p) => [p.id, p]));
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

    for (const pilot of pilots) {
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
```

Add `abandonRun` — the DELETE route needs it so removing a pilot mid-run does not record a phantom `closed-externally` outcome against a record that is about to vanish:

```js
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
```

(`pilotCache` is added in Task 7; until then that line is a no-op you can omit and add back with the cache.)

Then add both to the returned object: `return { start, stop, tick, runNow, status, notifications, drain, abandonRun, _runs: runs };`

Also add `lastSeq` to the run state created in `fire()` (Task 5 set `scannedThrough` but not `lastSeq`):

```js
      lastSeq: row.eventLog.nextSeq,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/autopilot.test.mjs`
Expected: PASS — all 32 tests in the file green (Task 5's 21 plus the 11 appended here).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/autopilot.js tests/autopilot.test.mjs
git commit -m "feat: autopilot terminal outcomes, completion guard and stall backstop"
```

---

### Task 7: Approval interceptor and `autopilot-answer.js`

**Files:**
- Create: `src/autopilot-answer.js`
- Modify: `src/session-registry.js` (`handleApprovalRequest` at `:1395-1403`; `_reset` at `:349`)
- Modify: `src/autopilot.js` (register the interceptor in `start()`, clear it in `stop()`)
- Test: `tests/autopilot-answer.test.mjs` (create)
- Test: `tests/session-registry.test.mjs` (append)
- Test: `tests/autopilot.test.mjs` (append)

**Interfaces:**
- Consumes: `runs` map (Task 5), `store.getPilot` (Task 1), `log.append` (Task 2).
- Produces:
  - `RECOMMENDED_RE = /\(recommended\)/i`
  - `buildAutoAnswer(input) => { decision, chosen } | null` from `src/autopilot-answer.js`, where `decision` is `{ behavior: 'allow', updatedInput: { questions, answers } }` and `chosen` is `[{ question, chosenLabel }]`. Returns `null` for any input shape it cannot answer, so the question falls through to a human.
  - `setApprovalInterceptor(fn | null)` on the registry — `fn({ row, request })` returns a `PermissionResult` or `null`. **Synchronous.**

- [ ] **Step 1: Write the failing tests**

Create `tests/autopilot-answer.test.mjs`:

```js
// AskUserQuestion is deliberately excluded from every auto-allow permission
// mode (src/session.js:272-291) because passing `input` back unmodified reads
// as "the user did not answer" - the tool's `answers` field stays empty. So
// auto-answering cannot be a mode change; it has to construct a real answer,
// in exactly the shape the cockpit's own client already sends
// (public/approval-panel.js:184-190).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoAnswer, RECOMMENDED_RE } from '../src/autopilot-answer.js';

function question(over = {}) {
  return {
    question: 'Which library should we use for date formatting?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'date-fns', description: 'Tree-shakeable' },
      { label: 'Luxon (Recommended)', description: 'Best DST handling' },
    ],
    ...over,
  };
}

test('it picks the option whose label matches (Recommended), case-insensitively', () => {
  const result = buildAutoAnswer({ questions: [question()] });
  assert.deepEqual(result.decision, {
    behavior: 'allow',
    updatedInput: {
      questions: [question()],
      answers: { 'Which library should we use for date formatting?': 'Luxon (Recommended)' },
    },
  });
  assert.deepEqual(result.chosen, [
    { question: 'Which library should we use for date formatting?', chosenLabel: 'Luxon (Recommended)' },
  ]);

  const lower = buildAutoAnswer({
    questions: [question({ options: [{ label: 'a' }, { label: 'b (recommended)' }] })],
  });
  assert.equal(Object.values(lower.decision.updatedInput.answers)[0], 'b (recommended)');

  assert.equal(RECOMMENDED_RE.test('Thing (RECOMMENDED)'), true);
  assert.equal(RECOMMENDED_RE.test('Recommended without parens'), false);
});

test('with no (Recommended) marker it falls back to the first option', () => {
  const result = buildAutoAnswer({
    questions: [question({ options: [{ label: 'first' }, { label: 'second' }] })],
  });
  assert.equal(Object.values(result.decision.updatedInput.answers)[0], 'first');
});

test('multiSelect: true still chooses a SINGLE option', () => {
  const result = buildAutoAnswer({
    questions: [question({
      multiSelect: true,
      options: [{ label: 'auth' }, { label: 'billing (Recommended)' }, { label: 'search' }],
    })],
  });
  // The client joins multiple selections with ', ' (approval-panel.js:188);
  // one selection needs no join, and picking everything is not what
  // "recommended" means.
  assert.equal(Object.values(result.decision.updatedInput.answers)[0], 'billing (Recommended)');
});

test('answers are keyed by the EXACT question text, for every question', () => {
  const qs = [
    question({ question: 'First question?', options: [{ label: 'one' }] }),
    question({ question: 'Second question?', options: [{ label: 'two' }, { label: 'three (Recommended)' }] }),
  ];
  const result = buildAutoAnswer({ questions: qs });
  assert.deepEqual(result.decision.updatedInput.answers, {
    'First question?': 'one',
    'Second question?': 'three (Recommended)',
  });
  assert.equal(result.chosen.length, 2);
});

test('the original questions array is passed back untouched alongside the answers', () => {
  const qs = [question()];
  const result = buildAutoAnswer({ questions: qs });
  assert.equal(result.decision.updatedInput.questions, qs);
});

test('an unusable input shape returns null so the question falls through to a human', () => {
  assert.equal(buildAutoAnswer(null), null);
  assert.equal(buildAutoAnswer({}), null);
  assert.equal(buildAutoAnswer({ questions: [] }), null);
  assert.equal(buildAutoAnswer({ questions: [{ question: 'q?', options: [] }] }), null);
  assert.equal(buildAutoAnswer({ questions: [{ question: '', options: [{ label: 'a' }] }] }), null);
  assert.equal(buildAutoAnswer({ questions: [{ question: 'q?', options: [{ label: '' }] }] }), null);
});
```

Append to `tests/session-registry.test.mjs`:

```js
test('setApprovalInterceptor resolves a request before the row or any client ever sees it', () => {
  registry._reset();
  const seen = [];
  registry.setApprovalInterceptor(({ row, request }) => {
    seen.push({ id: row.id, toolName: request.toolName });
    return { behavior: 'allow', updatedInput: { answered: true } };
  });
  try {
    const impl = fakeStartSession();
    const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
    const ws = fakeWs();
    registry.attachClient(row.id, ws);
    ws.sent.length = 0;

    const decision = impl.emitApprovalRequest({ questions: [] });

    assert.equal(seen.length, 1);
    assert.equal(row.pendingApprovals.length, 0, 'never pushed - the bell must not flicker');
    assert.equal(ws.sent.some((m) => m.type === 'cockpit:approval-request'), false, 'never broadcast');
    return decision.then((d) => assert.deepEqual(d, { behavior: 'allow', updatedInput: { answered: true } }));
  } finally {
    registry._reset();
  }
});

test('an interceptor returning null falls through to today\'s behavior unchanged', () => {
  registry._reset();
  registry.setApprovalInterceptor(() => null);
  try {
    const impl = fakeStartSession();
    const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
    const ws = fakeWs();
    registry.attachClient(row.id, ws);
    ws.sent.length = 0;

    impl.emitApprovalRequest({});

    assert.equal(row.pendingApprovals.length, 1);
    assert.equal(ws.sent.filter((m) => m.type === 'cockpit:approval-request').length, 1);
  } finally {
    registry._reset();
  }
});

test('a throwing interceptor falls through rather than stranding the tool call', () => {
  registry._reset();
  registry.setApprovalInterceptor(() => { throw new Error('interceptor blew up'); });
  try {
    const impl = fakeStartSession();
    const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
    impl.emitApprovalRequest({});
    assert.equal(row.pendingApprovals.length, 1);
  } finally {
    registry._reset();
  }
});
```

Append to `tests/autopilot.test.mjs`:

```js
test('the interceptor auto-answers AskUserQuestion only for pilot-owned rows on inputPolicy: recommended', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ name: 'Auto', inputPolicy: 'recommended' }));
    let installed = null;
    h.registry.setApprovalInterceptor = (fn) => { installed = fn; };
    h.supervisor.start();
    await h.supervisor.tick();

    const pilotRow = h.registry.get('s-1');
    const askInput = {
      questions: [{
        question: 'Ship it?',
        header: 'Ship',
        multiSelect: false,
        options: [{ label: 'No' }, { label: 'Yes (Recommended)' }],
      }],
    };

    const decision = installed({ row: pilotRow, request: { requestId: 'r1', toolName: 'AskUserQuestion', input: askInput } });
    assert.equal(decision.behavior, 'allow');
    assert.deepEqual(decision.updatedInput.answers, { 'Ship it?': 'Yes (Recommended)' });

    // A hand-driven row must be untouched: this is one process-global hook.
    const handRow = h.registry.createSession({ cwd: '/elsewhere', provider: 'claude', permissionMode: 'default' });
    assert.equal(installed({ row: handRow, request: { requestId: 'r2', toolName: 'AskUserQuestion', input: askInput } }), null);

    // A different tool on the pilot's own row is still the mode's business,
    // not the input policy's.
    assert.equal(installed({ row: pilotRow, request: { requestId: 'r3', toolName: 'Bash', input: {} } }), null);
    // So is end-of-plan approval.
    assert.equal(installed({ row: pilotRow, request: { requestId: 'r4', toolName: 'ExitPlanMode', input: {} } }), null);

    await h.supervisor.drain();
    const answered = (await h.log.tail({})).find((e) => Array.isArray(e.answered));
    assert.deepEqual(answered.answered, [{ question: 'Ship it?', chosenLabel: 'Yes (Recommended)' }]);
  } finally {
    await h.supervisor.stop();
    await h.cleanup();
  }
});

test('inputPolicy: ask leaves the question for a human', async () => {
  const h = await harness();
  try {
    await h.store.createPilot(pilotInput({ inputPolicy: 'ask' }));
    let installed = null;
    h.registry.setApprovalInterceptor = (fn) => { installed = fn; };
    h.supervisor.start();
    await h.supervisor.tick();

    const decision = installed({
      row: h.registry.get('s-1'),
      request: { requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'q?', options: [{ label: 'a' }] }] } },
    });
    assert.equal(decision, null);
  } finally {
    await h.supervisor.stop();
    await h.cleanup();
  }
});

test('a non-Claude pilot never auto-answers, whatever its inputPolicy says', async () => {
  const h = await harness();
  try {
    // The form hides the field for Grok/Codex, but a hand-edited
    // autopilots.json must not silently do something the provider has no
    // concept of.
    await h.store.createPilot(pilotInput({ provider: 'grok', effort: 'low', inputPolicy: 'recommended' }));
    let installed = null;
    h.registry.setApprovalInterceptor = (fn) => { installed = fn; };
    h.supervisor.start();
    await h.supervisor.tick();

    const decision = installed({
      row: h.registry.get('s-1'),
      request: { requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'q?', options: [{ label: 'a' }] }] } },
    });
    assert.equal(decision, null);
  } finally {
    await h.supervisor.stop();
    await h.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/autopilot-answer.test.mjs tests/session-registry.test.mjs tests/autopilot.test.mjs`
Expected: FAIL — no `src/autopilot-answer.js`, `registry.setApprovalInterceptor is not a function`, and the supervisor installs no interceptor.

- [ ] **Step 3: Write `src/autopilot-answer.js`**

```js
// Turns an AskUserQuestionInput into the exact answer payload the cockpit's
// own client already sends, so an unattended pilot can keep going instead of
// parking on a question forever.
//
// Pure: no I/O, no clock, no registry. The scoping decision (which rows may
// be auto-answered) lives in autopilot.js; this module only knows how to
// choose.
//
// Input shape, from the SDK's own types
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:855 onwards):
// questions[] of { question, header, multiSelect (REQUIRED boolean),
// options[] of { label, description, preview? } }. Output shape from
// public/approval-panel.js:184-190: { questions, answers }, with `answers`
// keyed by the EXACT question text.
export const RECOMMENDED_RE = /\(recommended\)/i;

export function buildAutoAnswer(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : null;
  if (!questions || questions.length === 0) return null;

  const answers = {};
  const chosen = [];
  for (const q of questions) {
    const text = typeof q?.question === 'string' ? q.question : '';
    const options = Array.isArray(q?.options) ? q.options : [];
    if (!text || options.length === 0) return null;
    // The option the model itself flagged, else the first - which is the
    // convention the tool's own guidance establishes ("make that the first
    // option in the list and add '(Recommended)'").
    const pick = options.find((o) => RECOMMENDED_RE.test(String(o?.label ?? ''))) || options[0];
    const label = String(pick?.label ?? '');
    if (!label) return null;
    // For multiSelect: true the rule is UNCHANGED - one option, not all of
    // them. The client joins multiple selections with ', ' (approval-panel.js
    // :188); a single selection needs no join, and "recommended" never means
    // "everything".
    answers[text] = label;
    chosen.push({ question: text, chosenLabel: label });
  }

  return {
    decision: { behavior: 'allow', updatedInput: { questions, answers } },
    chosen,
  };
}
```

- [ ] **Step 4: Add `setApprovalInterceptor` to the registry**

In `src/session-registry.js`, beside `sessionRemovedListener` (added in Task 4):

```js
// Auto-pilot's AskUserQuestion auto-answer hook (src/autopilot.js +
// src/autopilot-answer.js). Consulted in handleApprovalRequest BEFORE the row
// push and the broadcast, so the bell never flickers for a question that is
// about to be auto-answered. Returns a PermissionResult, or null to fall
// through to today's behavior unchanged.
//
// MUST be synchronous: handleApprovalRequest is called from session.js's
// canUseTool callback and pushes/broadcasts immediately afterwards. That is
// safe - session.js registers the requestId in its own map (src/session.js:288)
// BEFORE invoking this callback (:289), so an interceptor resolving
// synchronously always finds its entry.
//
// Like the removed-listener above, the registry learns only that a hook may
// exist - never what a pilot is. Scoping to pilot-owned rows is the
// interceptor's own job; it is one process-global hook, and an unscoped one
// would silently auto-answer questions in hand-driven sessions.
let approvalInterceptor = null;

export function setApprovalInterceptor(fn) {
  approvalInterceptor = typeof fn === 'function' ? fn : null;
}
```

Replace `handleApprovalRequest` (`src/session-registry.js:1395-1403`):

```js
function handleApprovalRequest(id, request) {
  const row = sessions.get(id);
  if (row && approvalInterceptor) {
    let decision = null;
    try {
      decision = approvalInterceptor({ row, request });
    } catch (err) {
      // Falling through to a human beats stranding the tool call.
      console.error(`approval interceptor failed for ${id}:`, err);
      decision = null;
    }
    if (decision) {
      // Straight to the handle, not the exported resolveApproval() above:
      // there is no pendingApprovals entry to splice (we never pushed one)
      // and an auto-answer never grants an always-allow scope. It also cannot
      // double-resolve - session.js's resolveApproval deletes before
      // resolving (src/session.js:650-652), so a human click racing this is a
      // no-op returning false.
      row.handle.resolveApproval(request.requestId, decision);
      return;
    }
  }
  if (row) {
    if (!row.pendingApprovals.some((r) => r.requestId === request.requestId)) {
      row.pendingApprovals.push(request);
    }
  }
  broadcast(id, { type: 'cockpit:approval-request', request });
}
```

If you did not already add it in Task 4, extend `_reset` with `approvalInterceptor = null;`.

- [ ] **Step 5: Install the interceptor from the supervisor**

In `src/autopilot.js`, add the import:

```js
import { buildAutoAnswer } from './autopilot-answer.js';
```

Add the interceptor next to `onSessionRemoved`:

```js
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
```

Add the pilot cache near `runs` and refresh it in `evaluate()`:

```js
  // Pilot records as of the last heartbeat. The approval interceptor has to
  // be synchronous, so it cannot await store.getPilot().
  const pilotCache = new Map();
```

In `evaluate()`, right after `const pilotsById = new Map(...)`:

```js
    pilotCache.clear();
    for (const [id, pilot] of pilotsById) pilotCache.set(id, pilot);
```

And in `fire()`, after `runs.set(...)`, seed the cache so a question arriving before the next heartbeat is still scoped correctly:

```js
    pilotCache.set(pilot.id, pilot);
```

Finally wire it into `start()`/`stop()`. The removal listener stays where Task 5 put it (the constructor body); the interceptor goes in `start()` and out in `stop()`, because unlike a passive listener it changes how live sessions behave and must not outlive a stopped supervisor:

```js
  function start() {
    if (timer) return;
    registry.setApprovalInterceptor(onApprovalRequest);
    timer = setIntervalImpl(() => { tick(); }, HEARTBEAT_MS);
  }

  async function stop() {
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    registry.setSessionRemovedListener(null);
    registry.setApprovalInterceptor(null);
    if (ticking) await ticking;
    await drain();
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/autopilot-answer.test.mjs tests/session-registry.test.mjs tests/autopilot.test.mjs`
Expected: PASS — 6 answer tests, the registry file's existing tests plus 3 new, and all 35 supervisor tests.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/autopilot-answer.js src/autopilot.js src/session-registry.js tests/autopilot-answer.test.mjs tests/autopilot.test.mjs tests/session-registry.test.mjs
git commit -m "feat: Claude-only AskUserQuestion auto-answer via a scoped approval interceptor"
```

---

### Task 8: Routes and server wiring

**Files:**
- Create: `src/routes/autopilot.js`
- Modify: `src/routes/sessions.js` (add `GET /api/sessions/:id/attach-token` **before** `registerSessionActionRoutes` runs)
- Modify: `src/server.js` (imports, route registration, supervisor construction, `shutdown.onBeforeClose`)
- Test: `tests/autopilot-routes.test.mjs` (create)

**Interfaces:**
- Consumes: everything above; `respondJson`, `readJsonBody` from `src/http-utils.js`; `parseProvider` from `src/provider-registry.js`; `isValidCwd` from `src/session-launcher.js`; `isSafeGrokArg` from `src/grok-acp.js`.
- Produces:

```
GET    /api/autopilots             list + live status + settings + today's spend
POST   /api/autopilots             create
POST   /api/autopilots/:id         update
DELETE /api/autopilots/:id         remove (force-closes a live run first)
POST   /api/autopilots/:id/toggle  enable / disable
POST   /api/autopilots/:id/run-now fire immediately, bypassing schedule + window
GET    /api/autopilots/:id/logs    tail of this pilot's run history
GET    /api/notifications          actionable list
POST   /api/autopilot-settings     update the global settings block
GET    /api/sessions/:id/attach-token   pilot-owned sessions only
```

`POST` for update because `src/router.js` exposes `get`/`post`/`delete`/`any` only (`src/router.js:69-75`).

**Two routes beyond the spec's table**, both required by Phase 5 and recorded here so the spec's list is known to be a subset rather than a disagreement: `POST /api/autopilot-settings` (the global cap and concurrency limit have to be editable somewhere) and `GET /api/autopilot-logs` (the pane's Logs tab shows every pilot interleaved; the spec defines only the per-pilot tail).

- [ ] **Step 1: Write the failing test**

Create `tests/autopilot-routes.test.mjs`:

```js
// Routes plus the operator-token gate, following server-auth.test.mjs's
// harness. Everything under /api/ already requires the operator token
// (src/server.js:75-78), so these inherit process-level auth; they are
// operator-gated but not session-token-gated, like /api/browse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.COCKPIT_OPERATOR_TOKEN = process.env.COCKPIT_OPERATOR_TOKEN || 'test-operator-token-16plus';
process.env.PORT = process.env.PORT || '4321';

const home = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-home-'));
process.env.COCKPIT_HOME = home;

const { server, PORT, HOST } = await import('../src/server.js');
const { getOperatorToken } = await import('../src/operator-auth.js');
const ORIGIN = `http://${HOST}:${PORT}`;

function api(pathAndQuery, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (!headers.has('x-cockpit-operator')) headers.set('x-cockpit-operator', getOperatorToken());
  if (opts.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${ORIGIN}${pathAndQuery}`, { ...opts, headers });
}

before(() => new Promise((resolve) => server.listen(PORT, HOST, resolve)));
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

function pilotBody(over = {}) {
  return JSON.stringify({
    name: 'RouteTest',
    cwd: process.cwd(),
    provider: 'claude',
    mode: 'acceptEdits',
    prompt: 'do the thing',
    schedule: { everyMinutes: 30 },
    ...over,
  });
}

test('every auto-pilot route 401s without the operator token', async () => {
  const routes = [
    ['GET', '/api/autopilots'],
    ['POST', '/api/autopilots'],
    ['POST', '/api/autopilots/x'],
    ['DELETE', '/api/autopilots/x'],
    ['POST', '/api/autopilots/x/toggle'],
    ['POST', '/api/autopilots/x/run-now'],
    ['GET', '/api/autopilots/x/logs'],
    ['GET', '/api/notifications'],
    ['POST', '/api/autopilot-settings'],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${ORIGIN}${route}`, { method });
    assert.equal(res.status, 401, `${method} ${route}`);
  }
});

test('GET /api/autopilots returns pilots, settings, live status and today\'s spend', async () => {
  const res = await api('/api/autopilots');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.pilots));
  assert.equal(typeof body.settings.maxConcurrentRuns, 'number');
  assert.ok(Array.isArray(body.running));
  assert.equal(typeof body.spend.costUsd, 'number');
});

test('POST /api/autopilots creates, and rejects a duplicate name with 409', async () => {
  const created = await api('/api/autopilots', { method: 'POST', body: pilotBody() });
  assert.equal(created.status, 201);
  const pilot = await created.json();
  assert.equal(pilot.name, 'RouteTest');

  const dupe = await api('/api/autopilots', { method: 'POST', body: pilotBody({ name: 'routetest' }) });
  assert.equal(dupe.status, 409);

  // Cleanup so later tests start clean.
  assert.equal((await api(`/api/autopilots/${pilot.id}`, { method: 'DELETE' })).status, 200);
});

test('POST /api/autopilots rejects a bad payload with 400 and a usable message', async () => {
  const cases = [
    [pilotBody({ prompt: '' }), /prompt/i],
    [pilotBody({ cwd: path.join(process.cwd(), 'definitely-not-here') }), /not a directory/i],
    [pilotBody({ provider: 'gemini' }), /unknown provider/i],
    [pilotBody({ provider: 'claude', effort: 'nonsense' }), /effort/i],
    [pilotBody({ model: 'oops & calc' }), /model/i],
    [pilotBody({ mode: 'nope' }), /mode/i],
  ];
  for (const [body, pattern] of cases) {
    const res = await api('/api/autopilots', { method: 'POST', body });
    assert.equal(res.status, 400, body);
    assert.match((await res.json()).error, pattern);
  }
});

test('update, toggle, logs and delete round-trip', async () => {
  const pilot = await (await api('/api/autopilots', { method: 'POST', body: pilotBody({ name: 'RoundTrip' }) })).json();

  const updated = await (await api(`/api/autopilots/${pilot.id}`, {
    method: 'POST', body: JSON.stringify({ prompt: 'changed' }),
  })).json();
  assert.equal(updated.prompt, 'changed');
  assert.equal(updated.name, 'RoundTrip');

  const toggled = await (await api(`/api/autopilots/${pilot.id}/toggle`, {
    method: 'POST', body: JSON.stringify({ enabled: false }),
  })).json();
  assert.equal(toggled.enabled, false);

  const logs = await (await api(`/api/autopilots/${pilot.id}/logs`)).json();
  assert.ok(Array.isArray(logs.entries));

  assert.equal((await api(`/api/autopilots/${pilot.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/autopilots/${pilot.id}`, { method: 'DELETE' })).status, 404);
});

test('an unknown pilot id is 404 on every :id route', async () => {
  for (const [method, route] of [
    ['POST', '/api/autopilots/missing'],
    ['DELETE', '/api/autopilots/missing'],
    ['POST', '/api/autopilots/missing/toggle'],
    ['POST', '/api/autopilots/missing/run-now'],
    ['GET', '/api/autopilots/missing/logs'],
  ]) {
    const res = await api(route, { method, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 404, `${method} ${route}`);
  }
});

test('POST /api/autopilot-settings validates', async () => {
  const ok = await api('/api/autopilot-settings', { method: 'POST', body: JSON.stringify({ dailyCostCapUsd: 42 }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dailyCostCapUsd, 42);

  const bad = await api('/api/autopilot-settings', { method: 'POST', body: JSON.stringify({ maxConcurrentRuns: 0 }) });
  assert.equal(bad.status, 400);
});

test('GET /api/notifications returns a derived list', async () => {
  const res = await api('/api/notifications');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).entries));
});

test('GET /api/sessions/:id/attach-token is not shadowed by the :action catch-all', async () => {
  const res = await api('/api/sessions/does-not-exist/attach-token');
  assert.equal(res.status, 404);
  // routes/session-actions.js:23 answers 404 with the BYTE-IDENTICAL body
  // `{ error: "unknown session: <id>" }`, so matching on that proves nothing
  // about which handler ran. The attach-token handler tags its own 404 for
  // exactly this reason - if this assertion fails, the catch-all swallowed
  // the route and the registration order in server.js has been changed.
  assert.match((await res.json()).error, /\(attach-token\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/autopilot-routes.test.mjs`
Expected: FAIL — every auto-pilot route 404s (no handler registered).

- [ ] **Step 3: Add a `COCKPIT_HOME` override**

The route test must not write into the real `~/.prompt-cockpit`. Add to `src/autopilot-store.js`, `src/autopilot-log.js` and `src/child-tracker.js`, replacing each `homedir()` default:

```js
// COCKPIT_HOME lets tests point every cockpit-owned durable file at a temp
// directory, the same way COCKPIT_OPERATOR_FILE already does for the operator
// token (src/operator-auth.js:62).
function cockpitHome() {
  return process.env.COCKPIT_HOME || homedir();
}
```

and change each `defaultXPath(home = homedir())` to `defaultXPath(home = cockpitHome())`. The existing explicit-argument tests are unaffected.

**`COCKPIT_HOME` must be set before `src/server.js` is imported.** `server.js` constructs the store, the log and the tracker at module scope, so all three paths resolve during that import. `tests/autopilot-routes.test.mjs` above does this correctly (the assignment precedes its `await import(...)`); a test that sets the variable afterwards silently writes into the real home directory.

- [ ] **Step 4: Write `src/routes/autopilot.js`**

```js
// Auto-pilot's HTTP surface, registered alongside the existing four route
// modules. Everything under /api/ already requires the operator token
// (src/server.js:75-78), so these inherit process-level auth: operator-gated
// but not session-token-gated, like /api/browse and /api/resumable.
//
// POST for update rather than PUT/PATCH because src/router.js exposes
// get/post/delete/any only (src/router.js:69-75).
import { respondJson, readJsonBody } from '../http-utils.js';
import { parseProvider } from '../provider-registry.js';
import { isValidCwd } from '../session-launcher.js';
import { isSafeGrokArg } from '../grok-acp.js';

// Validation that needs to know about providers and the filesystem, which
// autopilot-store.js deliberately does not (it would drag the agent SDK into
// a plain data store). Returns an error string, or null.
function validateAgainstProviders(body, existing = null) {
  const cwd = body.cwd ?? existing?.cwd;
  if (cwd !== undefined && !isValidCwd(cwd)) return `not a directory: ${cwd}`;

  const providerId = body.provider ?? existing?.provider;
  let descriptor;
  try {
    descriptor = parseProvider(providerId);
  } catch (err) {
    return err.message;
  }

  const model = body.model ?? existing?.model;
  if (model && !isSafeGrokArg(model)) return `invalid model: ${model}`;

  const effort = body.effort ?? existing?.effort;
  if (effort && !descriptor.efforts.includes(effort)) {
    return `invalid effort for ${descriptor.label}: ${effort}`;
  }
  return null;
}

function statusFor(err) {
  if (err?.code === 'ERR_NAME_TAKEN') return 409;
  if (err?.code === 'ERR_INVALID_PILOT') return 400;
  return 500;
}

export function registerAutopilotRoutes(router, { store, log, supervisor, registry, now = () => Date.now() }) {
  router.get('/api/autopilots', async (req, res) => {
    const { settings, pilots } = await store.read();
    const spend = await log.dailyCostUsd(now());
    return respondJson(res, 200, {
      settings,
      pilots,
      running: supervisor.status(),
      spend,
    });
  });

  router.post('/api/autopilots', async (req, res) => {
    const body = await readJsonBody(req);
    const problem = validateAgainstProviders(body);
    if (problem) return respondJson(res, 400, { error: problem });
    try {
      return respondJson(res, 201, await store.createPilot(body));
    } catch (err) {
      return respondJson(res, statusFor(err), { error: String(err.message || err) });
    }
  });

  router.post('/api/autopilots/:id', async (req, res, url, { id }) => {
    const existing = await store.getPilot(id);
    if (!existing) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const body = await readJsonBody(req);
    const problem = validateAgainstProviders(body, existing);
    if (problem) return respondJson(res, 400, { error: problem });
    try {
      // An edit applies from the NEXT firing: a run in flight is untouched,
      // because its session was already created with the old model/mode and
      // cannot adopt new ones coherently.
      return respondJson(res, 200, await store.updatePilot(id, body));
    } catch (err) {
      return respondJson(res, statusFor(err), { error: String(err.message || err) });
    }
  });

  router.delete('/api/autopilots/:id', async (req, res, url, { id }) => {
    const existing = await store.getPilot(id);
    if (!existing) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    // Force-close the live run FIRST, then remove the record - otherwise the
    // supervisor is left holding a lock for a pilot that no longer exists.
    const live = supervisor.status().find((r) => r.pilotId === id);
    if (live) {
      // Drop the run from the supervisor's map FIRST. Otherwise
      // closeSession's synchronous removal listener classifies it as
      // `closed-externally` and writes both a log entry and a recordRun
      // against a pilot we delete two statements later - a phantom outcome in
      // the Logs tab for what was actually a delete.
      await supervisor.abandonRun(id);
      registry.closeSession(live.sessionId);
    }
    await supervisor.drain();
    await store.deletePilot(id);
    return respondJson(res, 200, { deleted: true, closedSessionId: live?.sessionId ?? null });
  });

  router.post('/api/autopilots/:id/toggle', async (req, res, url, { id }) => {
    const existing = await store.getPilot(id);
    if (!existing) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const body = await readJsonBody(req);
    const enabled = body.enabled === undefined ? !existing.enabled : Boolean(body.enabled);
    const pilot = await store.setEnabled(id, enabled);
    // Re-enabling by hand is the documented recovery from an auto-disable, so
    // clear the back-off that got it there.
    if (enabled && (pilot.consecutiveFailures || 0) > 0) {
      return respondJson(res, 200, await store.recordRun(id, { consecutiveFailures: 0 }));
    }
    return respondJson(res, 200, pilot);
  });

  router.post('/api/autopilots/:id/run-now', async (req, res, url, { id }) => {
    if (!(await store.getPilot(id))) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const result = await supervisor.runNow(id);
    if (result.fired) return respondJson(res, 200, result);
    // `error` as well as `reason`: every client error path in this app reads
    // `error` (public/autopilot-panel.js's post(), and the existing panels),
    // so without it the pane renders a bare "409" instead of "already
    // running".
    return respondJson(res, 409, { error: result.reason, ...result });
  });

  router.get('/api/autopilots/:id/logs', async (req, res, url, { id }) => {
    if (!(await store.getPilot(id))) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const limit = Number(url.searchParams.get('limit')) || 200;
    return respondJson(res, 200, { entries: await log.tail({ pilotId: id, limit }) });
  });

  // Every pilot's history interleaved, for the panel's Logs tab.
  router.get('/api/autopilot-logs', async (req, res, url) => {
    const limit = Number(url.searchParams.get('limit')) || 200;
    return respondJson(res, 200, { entries: await log.tail({ limit }) });
  });

  router.post('/api/autopilot-settings', async (req, res) => {
    const body = await readJsonBody(req);
    try {
      return respondJson(res, 200, await store.updateSettings(body));
    } catch (err) {
      return respondJson(res, statusFor(err), { error: String(err.message || err) });
    }
  });

  // Derived, never stored - see autopilot.js's notifications().
  router.get('/api/notifications', async (req, res) => {
    return respondJson(res, 200, await supervisor.notifications());
  });
}
```

- [ ] **Step 5: Add the attach-token route**

At the end of `registerSessionRoutes` in `src/routes/sessions.js`, after the `DELETE /api/sessions/:id` handler:

```js
  // A pilot's session is by definition one this tab is not attached to, so
  // the notification bell needs a way to hand a NEW tab that session's bearer
  // token. `window.open('/?session=<id>&token=<t>')` would put a credential in
  // a URL - the leak backlog.md:27 already flags for /ws - so the bell opens
  // `/?attach=<sessionId>` and the new tab fetches the token from here.
  //
  // REGISTRATION-ORDER DEPENDENT. This only ever matches because
  // registerSessionRoutes runs before registerSessionActionRoutes's
  // `any('/api/sessions/:id/:action')` catch-all (src/server.js:32-35) and the
  // router's first match wins (src/router.js:45-47). Moving either
  // registration silently routes this into session-actions.js instead, which
  // has no 'attach-token' branch and would 404.
  //
  // Scoped to pilot-owned sessions. Being straight about why: this is not a
  // real trust boundary, since anyone holding the operator token can already
  // create sessions and read everything - per-session tokens are
  // defense-in-depth against a leaked session *id*. Restricting it is
  // least-privilege housekeeping costing one `if`.
  router.get('/api/sessions/:id/attach-token', async (req, res, url, { id }) => {
    const row = registry.get(id);
    // The `(attach-token)` tag is load-bearing for the regression test above:
    // session-actions.js's catch-all answers an unknown session with the
    // byte-identical `unknown session: <id>`, so without a distinguishing
    // marker there is no way to tell from a response whether this handler ran
    // at all or the catch-all shadowed it.
    if (!row) return respondJson(res, 404, { error: `unknown session: ${id} (attach-token)` });
    if (!isPilotOwned || !isPilotOwned(id)) {
      return respondJson(res, 403, { error: 'attach-token is only available for auto-pilot sessions' });
    }
    return respondJson(res, 200, { id: row.id, token: row.token });
  });
```

`isPilotOwned` is a new optional parameter on `registerSessionRoutes`. Change its signature and add the fallback:

```js
// `isPilotOwned(sessionId) => boolean` is supplied by server.js from the
// auto-pilot supervisor. Optional so the route module stays importable (and
// testable) without a supervisor; absent, attach-token refuses everything.
export function registerSessionRoutes(router, { isPilotOwned } = {}) {
```

- [ ] **Step 6: Wire it all up in `src/server.js`**

Add imports:

```js
import { registerAutopilotRoutes } from './routes/autopilot.js';
import { createAutopilotStore } from './autopilot-store.js';
import { createAutopilotLog } from './autopilot-log.js';
import { createAutopilot } from './autopilot.js';
```

Replace the router-registration block **together with the `tracker` / `shutdown` lines the process-ownership plan added directly below it** (that plan's Task 5 step 5 appended them after the block; this replacement re-declares both, so deleting the originals is required or the file will not parse):

```js
const tracker = getChildTracker();
const shutdown = createShutdown({ registry, tracker });

const autopilotStore = createAutopilotStore();
const autopilotLog = createAutopilotLog();
const autopilot = createAutopilot({ registry, store: autopilotStore, log: autopilotLog, tracker });
const isPilotOwned = (sessionId) => autopilot.status().some((run) => run.sessionId === sessionId);

const router = createRouter();
// ORDER MATTERS: registerSessionRoutes must come before
// registerSessionActionRoutes, whose any('/api/sessions/:id/:action')
// catch-all would otherwise swallow GET /api/sessions/:id/attach-token.
registerSessionRoutes(router, { isPilotOwned });
registerHistoryRoutes(router);
registerSystemRoutes(router);
registerAutopilotRoutes(router, { store: autopilotStore, log: autopilotLog, supervisor: autopilot, registry });
registerSessionActionRoutes(router);

// The heartbeat has to stop before sessions start disappearing, or it sees
// its own runs vanish mid-teardown and records them as terminal outcomes.
shutdown.onBeforeClose(() => autopilot.stop());
```

Update the export line:

```js
export { server, PORT, HOST, seedSessionDefaults, shutdown, tracker, autopilot };
```

And start the heartbeat inside the `isMain` block, after `tracker.reapOrphans()`:

```js
  // Pilots live and die with this process, by design (spec Non-goals). Not
  // started when imported by tests - a 15-second interval would keep the test
  // runner's event loop alive.
  autopilot.start();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/autopilot-routes.test.mjs`
Expected: PASS, 9/9.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Drive the whole feature by hand with `curl`**

This is the phase's acceptance test — the spec's point is that "all lifecycle semantics settle and get unit-tested here, before any UI exists to hide them."

```bash
# In one terminal:
npm start
# Copy the operator token out of the printed URL, then in another terminal:
OP=<token>
H="x-cockpit-operator: $OP"

# 1. Create a pilot pointed at a scratch repo, on a short interval.
curl -s -H "$H" -H 'content-type: application/json' -X POST \
  http://localhost:4317/api/autopilots -d '{
    "name":"Smoke","cwd":"C:/workspace/git/prompt-cockpit","provider":"claude",
    "mode":"default","prompt":"Reply with the single word OK and stop.",
    "schedule":{"everyMinutes":2},"inputPolicy":"ask"
  }'

# 2. Fire it immediately and watch a real session appear in the browser's
#    "All sessions" pane.
PID=<id from step 1>
curl -s -H "$H" -X POST http://localhost:4317/api/autopilots/$PID/run-now

# 3. Confirm the run completes and the session is force-closed.
curl -s -H "$H" http://localhost:4317/api/autopilots/$PID/logs
#    Expect: fired, then finished, with a costUsd and a durationMs.
curl -s -H "$H" http://localhost:4317/api/autopilots
#    Expect: running: [], lastOutcome "finished", consecutiveFailures 0,
#    and spend.costUsd above 0.

# 4. Prove the concurrency lock: run-now twice in a row.
curl -s -H "$H" -X POST http://localhost:4317/api/autopilots/$PID/run-now
curl -s -H "$H" -X POST http://localhost:4317/api/autopilots/$PID/run-now
#    Expect: 200 then 409 "already running".

# 5. Prove closed-externally is not a failure: run-now, then close the
#    session from its own tab's Settings > Close session.
#    Expect: lastOutcome "closed-externally", consecutiveFailures 0.

# 6. Prove the errored path does NOT spawn-loop: point a pilot at a
#    nonexistent cwd via a hand-edit of ~/.prompt-cockpit/autopilots.json,
#    then watch for 60 seconds.
#    Expect: exactly ONE errored entry, then back-off - not four per minute.

# 7. Prove auto-answering: set inputPolicy to "recommended" and use a prompt
#    that calls AskUserQuestion.
curl -s -H "$H" -H 'content-type: application/json' -X POST \
  http://localhost:4317/api/autopilots/$PID \
  -d '{"inputPolicy":"recommended","prompt":"Use AskUserQuestion to ask me whether to use tabs or spaces, marking spaces as (Recommended). Then say which I picked."}'
curl -s -H "$H" -X POST http://localhost:4317/api/autopilots/$PID/run-now
#    Expect: the session answers itself and finishes; the log has an entry
#    with answered: [{question, chosenLabel: "... (Recommended)"}]; the
#    approval banner never appeared in any tab.

# 8. Prove the spend cap blocks rather than kills.
curl -s -H "$H" -H 'content-type: application/json' -X POST \
  http://localhost:4317/api/autopilot-settings -d '{"dailyCostCapUsd":0.01}'
curl -s -H "$H" -X POST http://localhost:4317/api/autopilots/$PID/run-now
#    Expect: 409 with a "global daily spend cap reached" reason, and any run
#    already in flight is untouched.

# 9. Prove Ctrl-C stops everything (this is why the process-ownership plan
#    merged first): run-now, then Ctrl-C the server mid-run.
#    Expect: no orphaned CLI, runtime.json back to [].
```

Record the actual outputs in the commit message rather than asserting they passed.

- [ ] **Step 10: Commit**

```bash
git add src/routes/autopilot.js src/routes/sessions.js src/server.js src/autopilot-store.js src/autopilot-log.js src/child-tracker.js tests/autopilot-routes.test.mjs
git commit -m "feat: auto-pilot HTTP surface, notifications projection and server wiring"
```

---

## Done when

- `npm test` passes with the six new test files (`autopilot-store`, `autopilot-log`, `autopilot-schedule`, `autopilot-answer`, `autopilot`, `autopilot-routes`) and every pre-existing file still green.
- The `curl` walkthrough in Task 8 step 9 completes end to end, including the four terminal outcomes being distinguishable in `autopilot-log.jsonl`.
- A pilot pointed at a broken cwd produces one `errored` entry and then backs off — not a 15-second spawn loop.
- `~/.prompt-cockpit/` holds `operator-token`, `runtime.json`, `autopilots.json` and `autopilot-log.jsonl`, and no cockpit file has appeared anywhere else.
