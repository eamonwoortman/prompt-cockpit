// Presentation-only helpers for the auto-pilot panel and bell. Pure: no DOM,
// no fetch, no clock of its own - every function that needs "now" takes it as
// a parameter, which is what makes this file unit-testable with no jsdom
// (tests/autopilot-format.test.mjs, same shape as turn-chart.js's
// niceScaleMax).
//
// The temporal math itself is NOT here: nextRunAt/backoffMs live in
// src/autopilot-schedule.js and are served to the browser verbatim
// (static-files.js's SHARED_SRC_FILES), so this label and the server's own
// firing decision can never disagree.
//
// They are INJECTED rather than imported, and that is load-bearing: the
// browser reaches that module at `/autopilot-schedule.js`, but Node resolves
// a root-absolute specifier against the filesystem root (`C:\autopilot-
// schedule.js`) and throws ERR_MODULE_NOT_FOUND. An import here would make
// this whole file unimportable from tests/ - which is exactly why every
// other Node-tested public/ module (turn-chart.js, ask-picker.js,
// provider-catalog.js, markdown.js) has zero imports. autopilot-panel.js
// passes the real functions in; the test passes the same ones via a plain
// relative import of ../src/autopilot-schedule.js.

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatMinuteOfDay(minute) {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatInterval(everyMinutes) {
  if (everyMinutes < 60) return `${everyMinutes} min`;
  const h = Math.floor(everyMinutes / 60);
  const m = everyMinutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function formatWeekdays(weekdays) {
  const days = [...new Set(weekdays || [])].sort((a, b) => a - b);
  if (days.length === 7) return 'daily';
  if (days.length === 0) return 'never';
  // Only collapse a genuinely contiguous run, so [1,3,5] never renders as a
  // range that would read as "every day Mon through Fri".
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (contiguous && days.length > 2) return `${WEEKDAY_LABELS[days[0]]}–${WEEKDAY_LABELS[days[days.length - 1]]}`;
  return days.map((d) => WEEKDAY_LABELS[d]).join(', ');
}

export function describeSchedule(pilot) {
  const { everyMinutes, window } = pilot.schedule;
  const base = `every ${formatInterval(everyMinutes)}`;
  if (!window) return base;
  const span = `${formatMinuteOfDay(window.fromMinute)}–${formatMinuteOfDay(window.toMinute)}`;
  // A window whose end is before its start crosses midnight, and the weekday
  // set names the day it OPENED - worth saying out loud, because "Mon–Fri
  // 22:00–06:00" otherwise reads as an impossible eight-hour negative.
  const overnight = window.fromMinute > window.toMinute ? ' (overnight)' : '';
  return `${base}, ${formatWeekdays(window.weekdays)} ${span}${overnight}`;
}

export function describeNextRun(pilot, atMs, { nextRunAt }) {
  if (!pilot.enabled) return 'disabled';
  const next = nextRunAt(pilot, atMs);
  if (next === null) return 'no upcoming run (the active window is unreachable)';
  if (next <= atMs) return 'due now';
  const failures = pilot.consecutiveFailures || 0;
  // Any failure at all has pushed this time out, so any failure is worth
  // naming. dueAt ADDS backoffMs to the interval rather than replacing it
  // (src/autopilot-schedule.js:36-41) - under the replacing reading a first
  // failure would delay nothing, which is precisely the hole that file's own
  // comment rejects. So there is no "back-off that changed nothing" case to
  // suppress here.
  const suffix = failures > 0
    ? ` (backing off after ${failures} failure${failures === 1 ? '' : 's'})`
    : '';
  return `next run in ${formatApproxSpan(next - atMs)}${suffix}`;
}

function formatApproxSpan(ms) {
  if (ms < MIN) return 'under a minute';
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms % HOUR) / MIN);
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  const days = Math.round(ms / DAY);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function formatRelativeTime(ms, atMs) {
  if (ms == null) return 'never';
  const delta = atMs - ms;
  if (delta < MIN) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MIN)} min ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`;
  const days = Math.floor(delta / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

export function describeSpend({ costUsd = 0, unpricedRuns = 0 } = {}, dailyCostCapUsd) {
  const spent = `$${costUsd.toFixed(2)}`;
  const base = dailyCostCapUsd == null
    ? `${spent} today (no cap)`
    : `${spent} / $${dailyCostCapUsd.toFixed(2)} today`;
  if (!unpricedRuns) return base;
  // costForUsage returns null for a model with no pricing entry
  // (src/usage.js:52) rather than guessing, so those runs contribute nothing
  // and the cap can be exceeded. Say so instead of implying the number is
  // complete.
  const plural = unpricedRuns === 1 ? '1 run on an unpriced model' : `${unpricedRuns} runs on unpriced models`;
  return `${base} · ${plural}, so the real total is higher`;
}

const OUTCOME_LABELS = {
  finished: 'finished',
  'timed-out': 'timed out',
  errored: 'errored',
  'closed-externally': 'closed by hand',
};
const FAILURE_OUTCOMES = new Set(['timed-out', 'errored']);

export function describeOutcome(pilot, atMs) {
  if (!pilot.lastRunAt || !pilot.lastOutcome) return 'never run';
  const label = OUTCOME_LABELS[pilot.lastOutcome] || pilot.lastOutcome;
  const when = formatRelativeTime(pilot.lastRunAt, atMs);
  const failures = pilot.consecutiveFailures || 0;
  if (failures > 0 && FAILURE_OUTCOMES.has(pilot.lastOutcome)) {
    return `${label} ${when} (${failures} failure${failures === 1 ? '' : 's'} in a row)`;
  }
  return `${label} ${when}`;
}
