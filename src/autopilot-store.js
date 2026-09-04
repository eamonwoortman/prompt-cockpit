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
    // Round 3 review (New-2): null-safe - a literal `null` in `pilots` (the
    // exact shape autopilot.js's own null-pilot guard defends against on the
    // read path) must not throw here on the write/lookup path. hydrate()
    // deliberately returns `pilots` verbatim, so a bare null is an
    // anticipated state, not a corrupt one.
    return (await listPilots()).find((p) => p?.id === id) || null;
  }

  function assertNameFree(pilots, name, exceptId) {
    const target = name.trim().toLowerCase();
    if (pilots.some((p) => p?.id !== exceptId && String(p?.name || '').trim().toLowerCase() === target)) {
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
        const i = state.pilots.findIndex((p) => p?.id === id);
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

    // Round 3 review (New-2, disclosed extension beyond the finding's own
    // list): the filter predicate has the identical unguarded `p.id` shape
    // as the five finders the finding named, and a raw null in `pilots`
    // throws here too. Null-safe here also means the filter correctly KEEPS
    // the null row (its `p?.id` is `undefined`, never equal to `id`), which
    // is what the finding's "do not drop nulls" rule requires of every
    // write path, not just the five it happened to trace.
    deletePilot(id) {
      return mutate((state) => {
        const before = state.pilots.length;
        state.pilots = state.pilots.filter((p) => p?.id !== id);
        return state.pilots.length !== before;
      });
    },

    setEnabled(id, enabled) {
      return mutate((state) => {
        const pilot = state.pilots.find((p) => p?.id === id);
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
        // Round 3 review (New-2): this was the load-bearing one - a null
        // entry throwing here meant recordOutcome's own store.recordRun call
        // (autopilot.js) threw, track() swallowed it, lastRunAt was never
        // stamped, and dueAt() reads a null lastRunAt as "due immediately" -
        // turning a killed heartbeat into a real, billing session firing
        // every ~15 seconds forever.
        const pilot = state.pilots.find((p) => p?.id === id);
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
