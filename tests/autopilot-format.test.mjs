// Pure presentation helpers for the auto-pilot panel - no DOM, so they are
// unit-tested directly, the same way turn-chart.js's niceScaleMax is
// (tests/turn-chart.test.mjs). Genuine DOM/interaction behavior in the panels
// is hand-verified instead; see tests/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSchedule, describeNextRun, formatRelativeTime, formatDuration,
  describeSpend, describeOutcome, formatMinuteOfDay,
} from '../public/autopilot-format.js';
// The same functions the browser gets at /autopilot-schedule.js, reached here
// by a normal relative path. describeNextRun takes them as a parameter so
// autopilot-format.js itself stays import-free and therefore Node-importable.
import { nextRunAt, backoffMs } from '../src/autopilot-schedule.js';

const SCHEDULE = { nextRunAt, backoffMs };
const MIN = 60_000;
function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

function pilot(over = {}) {
  return {
    name: 'Nightly',
    enabled: true,
    schedule: { everyMinutes: 30, window: null },
    lastRunAt: null,
    lastOutcome: null,
    consecutiveFailures: 0,
    ...over,
  };
}

test('formatMinuteOfDay zero-pads to HH:MM', () => {
  assert.equal(formatMinuteOfDay(0), '00:00');
  assert.equal(formatMinuteOfDay(9 * 60), '09:00');
  assert.equal(formatMinuteOfDay(17 * 60 + 5), '17:05');
  assert.equal(formatMinuteOfDay(23 * 60 + 59), '23:59');
});

test('describeSchedule renders the interval alone when there is no window', () => {
  assert.equal(describeSchedule(pilot()), 'every 30 min');
  assert.equal(describeSchedule(pilot({ schedule: { everyMinutes: 1, window: null } })), 'every 1 min');
  assert.equal(describeSchedule(pilot({ schedule: { everyMinutes: 60, window: null } })), 'every 1 h');
  assert.equal(describeSchedule(pilot({ schedule: { everyMinutes: 90, window: null } })), 'every 1 h 30 min');
  assert.equal(describeSchedule(pilot({ schedule: { everyMinutes: 1440, window: null } })), 'every 24 h');
});

test('describeSchedule collapses a full weekday set and names a partial one', () => {
  const all = { fromMinute: 9 * 60, toMinute: 17 * 60, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(describeSchedule(pilot({ schedule: { everyMinutes: 30, window: all } })), 'every 30 min, daily 09:00–17:00');

  const weekdays = { fromMinute: 9 * 60, toMinute: 17 * 60, weekdays: [1, 2, 3, 4, 5] };
  assert.equal(describeSchedule(pilot({ schedule: { everyMinutes: 30, window: weekdays } })), 'every 30 min, Mon–Fri 09:00–17:00');

  const scattered = { fromMinute: 0, toMinute: 6 * 60, weekdays: [1, 3, 5] };
  assert.equal(describeSchedule(pilot({ schedule: { everyMinutes: 30, window: scattered } })), 'every 30 min, Mon, Wed, Fri 00:00–06:00');
});

test('describeSchedule flags a midnight-crossing window, since it reads wrong otherwise', () => {
  const overnight = { fromMinute: 22 * 60, toMinute: 6 * 60, weekdays: [1, 2, 3, 4, 5] };
  assert.equal(
    describeSchedule(pilot({ schedule: { everyMinutes: 30, window: overnight } })),
    'every 30 min, Mon–Fri 22:00–06:00 (overnight)',
  );
});

test('describeNextRun covers disabled, overdue, upcoming and unreachable', () => {
  const now = at(2026, 9, 1, 12, 0);

  assert.equal(describeNextRun(pilot({ enabled: false }), now, SCHEDULE), 'disabled');
  assert.equal(describeNextRun(pilot({ lastRunAt: null }), now, SCHEDULE), 'due now');
  assert.equal(describeNextRun(pilot({ lastRunAt: now - 45 * MIN }), now, SCHEDULE), 'due now');
  assert.equal(describeNextRun(pilot({ lastRunAt: now - 18 * MIN }), now, SCHEDULE), 'next run in 12 min');
  // An empty weekday set is REJECTED by autopilot-store.js, so this state is
  // only reachable by hand-editing autopilots.json. The label still has to be
  // honest rather than claiming a run is imminent.
  assert.equal(
    describeNextRun(pilot({ schedule: { everyMinutes: 30, window: { fromMinute: 0, toMinute: 0, weekdays: [] } } }), now, SCHEDULE),
    'no upcoming run (the active window is unreachable)',
  );
});

// The plan's own version of this test asserted `lastRunAt + backoff`, i.e. that
// the back-off REPLACES the interval. It does not: dueAt ADDS the two
// (src/autopilot-schedule.js:36-41), and that file's comment rejects the
// max(interval, backoff) reading by name, because under it a first failure
// would produce no delay at all. Asserting what the shared module actually
// does, since this label's whole purpose is to agree with it.
test('describeNextRun adds the failure back-off on top of the interval, and says so', () => {
  const now = at(2026, 9, 1, 12, 0);
  // 3 failures on a 30-minute interval: 30 min interval + 120 min back-off.
  const backedOff = pilot({ lastRunAt: now - 60 * MIN, consecutiveFailures: 3 });
  assert.equal(describeNextRun(backedOff, now, SCHEDULE), 'next run in 1 h 30 min (backing off after 3 failures)');
  // A single failure already doubles the wait, so it is mentioned too - the
  // plan suppressed this case on the mistaken belief that n=1 changes nothing.
  const firstFailure = pilot({ lastRunAt: now - 30 * MIN, consecutiveFailures: 1 });
  assert.equal(describeNextRun(firstFailure, now, SCHEDULE), 'next run in 30 min (backing off after 1 failure)');
});

test('formatRelativeTime reads naturally across the ranges that matter', () => {
  const now = at(2026, 9, 1, 12, 0);
  assert.equal(formatRelativeTime(now, now), 'just now');
  assert.equal(formatRelativeTime(now - 30_000, now), 'just now');
  assert.equal(formatRelativeTime(now - 3 * MIN, now), '3 min ago');
  assert.equal(formatRelativeTime(now - 90 * MIN, now), '1 h ago');
  assert.equal(formatRelativeTime(now - 26 * 60 * MIN, now), 'yesterday');
  assert.equal(formatRelativeTime(now - 5 * 24 * 60 * MIN, now), '5 days ago');
  assert.equal(formatRelativeTime(null, now), 'never');
});

test('formatDuration is compact and never renders bare milliseconds', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(900), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_600_000), '1h 0m');
  assert.equal(formatDuration(5_430_000), '1h 30m');
  assert.equal(formatDuration(null), '—');
});

test('describeSpend shows the cap, the no-cap case, and the unpriced caveat', () => {
  assert.equal(describeSpend({ costUsd: 1.239, unpricedRuns: 0 }, 10), '$1.24 / $10.00 today');
  assert.equal(describeSpend({ costUsd: 0, unpricedRuns: 0 }, 10), '$0.00 / $10.00 today');
  assert.equal(describeSpend({ costUsd: 1.24, unpricedRuns: 0 }, null), '$1.24 today (no cap)');
  // costForUsage returns null for an unpriced model, so the cap can be
  // exceeded - say so rather than implying the number is complete.
  assert.equal(
    describeSpend({ costUsd: 1.24, unpricedRuns: 2 }, 10),
    '$1.24 / $10.00 today · 2 runs on unpriced models, so the real total is higher',
  );
  assert.equal(
    describeSpend({ costUsd: 1.24, unpricedRuns: 1 }, 10),
    '$1.24 / $10.00 today · 1 run on an unpriced model, so the real total is higher',
  );
});

test('describeOutcome names the last outcome and surfaces a failure streak', () => {
  const now = at(2026, 9, 1, 12, 0);
  assert.equal(describeOutcome(pilot(), now), 'never run');
  assert.equal(describeOutcome(pilot({ lastRunAt: now - 5 * MIN, lastOutcome: 'finished' }), now), 'finished 5 min ago');
  assert.equal(
    describeOutcome(pilot({ lastRunAt: now - 2 * 60 * MIN, lastOutcome: 'errored', consecutiveFailures: 3 }), now),
    'errored 2 h ago (3 failures in a row)',
  );
  assert.equal(
    describeOutcome(pilot({ lastRunAt: now - MIN, lastOutcome: 'closed-externally' }), now),
    'closed by hand 1 min ago',
  );
  assert.equal(
    describeOutcome(pilot({ lastRunAt: now - MIN, lastOutcome: 'timed-out', consecutiveFailures: 1 }), now),
    'timed out 1 min ago (1 failure in a row)',
  );
});
