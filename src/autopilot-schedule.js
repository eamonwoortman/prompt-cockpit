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
