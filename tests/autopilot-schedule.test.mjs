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
