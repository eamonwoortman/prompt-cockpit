# Auto-pilot UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a face on the headless supervisor: a toggleable Pilots/Logs pane under the top bar, a Settings-style create/edit modal, a notifications bell, and a click-through that attaches a new tab to a running pilot's session without putting a credential in a URL.

**Architecture:** Four new `public/` modules, each owning its own `init()`, with `app.js` only wiring them — the `session-controls-panel.js` precedent. The pane is a fixed overlay modelled on `session-list-pane.js` (measured `top`, header-button toggle, interval poll). All pure logic — schedule summaries, next-run labels, relative times, the cost-cap label — lives in `public/autopilot-format.js` and is unit-tested with no DOM at all; `src/autopilot-schedule.js` is served straight to the browser via `SHARED_SRC_FILES` so the panel's "next run" and the server's due-ness check can never disagree.

**Tech Stack:** Vanilla ES modules loaded natively by `index.html`, no bundler, no framework. One new stylesheet appended last in the cascade. `node --test` for the pure modules.

**Spec:** `docs/superpowers/specs/2026-09-01-auto-pilot-design.md` — this plan implements **Sequencing phase 5** ("UI: panel, form, bell, attach flow"). Phases 1–2 are `2026-09-01-process-ownership.md`; phases 3–4 are `2026-09-01-auto-pilot-supervisor.md`. **Both must be merged first** — every endpoint this plan calls is defined there.

> **Spec corrections and deviations, verified against the tree:**
>
> 1. The spec's Frontend section cites `settings-security-panel.js` as the module precedent. **No such file exists** — `backlog.md`'s own note naming it is stale. The real precedent, a Settings-modal section extracted into its own dependency-injected `init()`, is `public/session-controls-panel.js`. Follow that file, and `public/list-panel.js` for the shared loading/error list skeleton.
> 2. The spec says the form wires `model-picker.js` for model selection. **This plan uses a plain text input instead.** `model-picker.js` is a compose-box autocomplete driven by a *live session's* model list (`initModelPicker({ textarea, dropdown, fetchModels, ... })`); a pilot has no live session at edit time, so there is nothing to fetch from. The trade-off is real and worth stating: the operator gets no model list and must type an id, which the server then validates with the same `isSafeGrokArg` rule a hand-started session uses. Revisit if a session-free model catalogue ever exists.
> 3. The spec lists "the notification projection" under *client* unit tests. It is implemented server-side (`src/autopilot.js`'s `notifications()`) and tested there, in the supervisor plan's Task 6. `tests/autopilot-format.test.mjs` covers only the schedule/next-run/relative-time/spend/outcome formatters.

## Global Constraints

- **No new npm dependencies, no bundler, no build step.** Modules are loaded as native ES modules by `public/index.html`.
- **No jsdom.** Pure logic is unit-tested directly (the `tests/turn-chart.test.mjs` pattern: import the real function, assert on its return value). `tests/helpers/dom-stub.mjs` exists for markdown-style rendering only and is not needed here. Genuine DOM/interaction behavior is hand-verified — and this plan says exactly what to click.
- **`public/style-autopilot.css` is appended LAST** in `index.html`'s ordered `<link>` list (`public/index.html:13-20`). The CSS split is cascade-ordered; `backlog.md` records a real bug caused by an equal-specificity rule landing in the wrong place (a `prefers-reduced-motion` override that never applied).
- **Nothing lands in `public/app.js` beyond wiring.** It is 2609 lines and already flagged in `backlog.md` as over the 2000-line bar. Each new module owns its own `init()`.
- **Never put a token in a URL.** The attach flow opens `/?attach=<sessionId>` and the new tab fetches the bearer token from `GET /api/sessions/:id/attach-token`. `backlog.md:27` already flags the URL-credential leak for `/ws`; do not add a second one.
- **Build DOM with `createElement`/`textContent`, never `innerHTML`.** `markdown.js` already holds this line and `backlog.md` notes there is no CSP; a pilot name, a gate command's stdout tail and a log reason are all attacker-adjacent strings.
- **`/api/*` fetches carry the operator token automatically** — `public/operator-auth.js` patches `window.fetch` for any URL containing `/api/` (`public/operator-auth.js:52-62`). Plain `fetch('/api/autopilots')` is correct; do not add headers by hand.
- **Every panel fetch is best-effort.** A failed poll leaves the last-known value showing rather than replacing it with an alarming placeholder (`public/session-list-pane.js:122-126`).

## File Structure

| File | Responsibility |
|---|---|
| `public/autopilot-format.js` (create) | Pure presentation helpers: schedule summary, next-run label, relative time, outcome label, spend-cap label. No DOM, no fetch. |
| `public/autopilot-panel.js` (create) | The `#autopilotPane` overlay: Pilots and Logs tabs, header-button toggle, 10 s poll, per-row run-now/toggle/edit/delete. |
| `public/autopilot-form.js` (create) | The create/edit modal: provider-gated fields, the two misconfiguration warnings, submit/validation error surface. |
| `public/notifications-panel.js` (create) | The bell dropdown: own poll, badge count, attach click-through. |
| `public/style-autopilot.css` (create) | Styles for all three, appended last. |
| `public/index.html` (modify) | `#autopilotBtn` and `#notificationsBtn` before `#settingsBtn`; the pane, bell and modal markup; the new stylesheet link. |
| `public/app.js` (modify) | Wiring only: construct the three panels, and the `?attach=` bootstrap beside the existing `?newTab=1` one. |
| `src/static-files.js` (modify) | Add `autopilot-schedule.js` to `SHARED_SRC_FILES`. |
| `tests/autopilot-format.test.mjs` (create) | The pure helpers. |
| `tests/static-files.test.mjs` (create) | That the shared schedule module is actually reachable at `/autopilot-schedule.js`. |

---

### Task 1: Share the schedule module with the browser, and add `public/autopilot-format.js`

**Files:**
- Modify: `src/static-files.js:13`
- Create: `public/autopilot-format.js`
- Test: `tests/static-files.test.mjs` (create)
- Test: `tests/autopilot-format.test.mjs` (create)

**Interfaces:**
- Consumes: `nextRunAt` and `backoffMs` from `src/autopilot-schedule.js` (supervisor plan, Task 3). **Injected as a parameter, never imported** — the browser reaches that module at `/autopilot-schedule.js`, but Node resolves a root-absolute specifier against the filesystem root and throws `ERR_MODULE_NOT_FOUND`, which would make this file unimportable from `tests/`. Every other Node-tested `public/` module (`turn-chart.js`, `ask-picker.js`, `provider-catalog.js`, `markdown.js`) has zero imports for exactly this reason.
- Produces, from `public/autopilot-format.js`:
  - `describeSchedule(pilot) => string` — e.g. `"every 30 min, Mon–Fri 09:00–17:00"`.
  - `describeNextRun(pilot, atMs, { nextRunAt, backoffMs }) => string` — returns `"due now"`, `"next run in 12 min"`, `"next run in 1 h (backing off after 3 failures)"`, `"disabled"`, or `"no upcoming run (the active window is unreachable)"`. The schedule functions are **injected, not imported** — see the module comment for why.
  - `formatRelativeTime(ms, atMs) => string` — `"just now"`, `"3 min ago"`, `"2 h ago"`, `"yesterday"`.
  - `formatDuration(ms) => string` — `"1m 30s"`.
  - `describeSpend({ costUsd, unpricedRuns }, dailyCostCapUsd) => string` — `"$1.24 / $10.00 today"`, `"$1.24 today (no cap)"`, with a `" · some costs unknown"` suffix when `unpricedRuns > 0`.
  - `describeOutcome(pilot, atMs) => string` — `"finished 5 min ago"`, `"errored 2 h ago (3 failures in a row)"`, `"closed by hand 1 min ago"`, `"never run"`.
  - `WEEKDAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']`
  - `formatMinuteOfDay(minute) => string` — `"09:00"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/static-files.test.mjs`:

```js
// src/permissions.js and src/stream-join.js are already shared verbatim with
// the browser rather than duplicated into public/. autopilot-schedule.js joins
// them so the panel's "next run" label and the supervisor's own due-ness check
// cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/static-files.js';

const SRC_DIR = path.dirname(fileURLToPath(new URL('../src/static-files.js', import.meta.url)));

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || null; },
    end(data) { this.body = data; },
  };
}

test('the shared src modules are served from /', async () => {
  for (const name of ['permissions.js', 'stream-join.js', 'autopilot-schedule.js']) {
    const res = fakeRes();
    await serveStatic({}, res, new URL(`http://localhost/${name}`));
    assert.equal(res.statusCode, 200, name);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    const onDisk = await readFile(path.join(SRC_DIR, name));
    assert.equal(Buffer.compare(Buffer.from(res.body), onDisk), 0, `${name} served verbatim`);
  }
});

test('a src file that is NOT on the shared list is not reachable', async () => {
  const res = fakeRes();
  await serveStatic({}, res, new URL('http://localhost/session-registry.js'));
  assert.equal(res.statusCode, 404);
});

test('autopilot-schedule.js has no node: imports, or the browser load would fail', async () => {
  const source = await readFile(path.join(SRC_DIR, 'autopilot-schedule.js'), 'utf-8');
  assert.equal(/from ['"]node:/.test(source), false);
  assert.equal(/require\(/.test(source), false);
});
```

Create `tests/autopilot-format.test.mjs`:

```js
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

test('describeNextRun accounts for the failure back-off', () => {
  const now = at(2026, 9, 1, 12, 0);
  // 3 failures on a 30-minute interval => 120 minutes, not 30.
  const backedOff = pilot({ lastRunAt: now - 60 * MIN, consecutiveFailures: 3 });
  assert.equal(describeNextRun(backedOff, now, SCHEDULE), 'next run in 1 h (backing off after 3 failures)');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/static-files.test.mjs tests/autopilot-format.test.mjs`
Expected: FAIL — `autopilot-schedule.js` 404s from `serveStatic`, and `public/autopilot-format.js` does not exist.

- [ ] **Step 3: Share the schedule module**

In `src/static-files.js:10-13`, extend the set and the comment:

```js
// No Node-specific imports; shared verbatim with the browser rather than
// duplicated into public/. permissions.js is mode-cycle order;
// stream-join.js is Grok token-join whitespace (also imported by grok-messages.js);
// autopilot-schedule.js is due-ness/window/back-off math, so the panel's
// "next run" label and the supervisor's own precondition check are literally
// the same code rather than two implementations that drift.
const SHARED_SRC_FILES = new Set(['permissions.js', 'stream-join.js', 'autopilot-schedule.js']);
```

- [ ] **Step 4: Write `public/autopilot-format.js`**

```js
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

export function describeNextRun(pilot, atMs, { nextRunAt, backoffMs }) {
  if (!pilot.enabled) return 'disabled';
  const next = nextRunAt(pilot, atMs);
  if (next === null) return 'no upcoming run (the active window is unreachable)';
  if (next <= atMs) return 'due now';
  const inMs = next - atMs;
  const failures = pilot.consecutiveFailures || 0;
  // Only mention back-off when it is actually what pushed the time out -
  // at one failure the back-off equals the interval and changes nothing.
  const backedOff = failures > 0 && backoffMs(pilot.schedule.everyMinutes, failures) > pilot.schedule.everyMinutes * MIN;
  const suffix = backedOff ? ` (backing off after ${failures} failures)` : '';
  return `next run in ${formatApproxSpan(inMs)}${suffix}`;
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/static-files.test.mjs tests/autopilot-format.test.mjs`
Expected: PASS — 3 static-file tests, 10 format tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/static-files.js public/autopilot-format.js tests/static-files.test.mjs tests/autopilot-format.test.mjs
git commit -m "feat: share autopilot-schedule with the browser, add pure panel formatters"
```

---

### Task 2: The Pilots/Logs pane

**Files:**
- Create: `public/autopilot-panel.js`
- Create: `public/style-autopilot.css`
- Modify: `public/index.html` (stylesheet link at `:20`; `#autopilotBtn` before `#settingsBtn` at `:36`; the pane markup after `#sessionListPane` at `:122`)
- Modify: `public/app.js` (import and one `initAutopilotPanel({...})` call beside `initSessionListPane` at `public/app.js:142`)

**Interfaces:**
- Consumes: `describeSchedule`, `describeNextRun`, `describeOutcome`, `describeSpend`, `formatRelativeTime`, `formatDuration` (Task 1); `GET /api/autopilots`, `GET /api/autopilot-logs`, `POST /api/autopilots/:id/toggle`, `POST /api/autopilots/:id/run-now`, `DELETE /api/autopilots/:id` (supervisor plan, Task 8).
- Produces:
  - `initAutopilotPanel({ panel, body, tabsEl, headerEl, toggleBtn, closeBtn, newBtn, spendEl, resizeHandle, initialWidth, onWidthChange, onEdit, onCreate, now? }) => { refresh, openPane, closePane, selectTab, isOpen }`
  - `newBtn` is required — the implementation calls `newBtn.addEventListener` unconditionally.
  - `onEdit(pilot)` / `onCreate()` are the callbacks Task 3's form hooks into. `refresh()` is exported so the form can force a redraw after a save; `openPane()` and `selectTab('pilots')` are exported so Task 4's bell can bring the operator to the pilot list without toggling the pane shut.

- [ ] **Step 1: Add the markup and the stylesheet**

In `public/index.html`, add the stylesheet **last** in the ordered list (after line 20's `style-overlays.css`):

```html
<link rel="stylesheet" href="/style-autopilot.css" />
```

Add the two header buttons before `#settingsBtn` (`public/index.html:36`):

```html
    <button type="button" id="autopilotBtn" class="btn" title="Auto-pilot: scheduled unattended sessions">🛫 Auto-pilot</button>
    <button type="button" id="notificationsBtn" class="btn" title="Auto-pilot notifications needing your attention" hidden>🔔</button>
```

Add the pane after `#sessionListPane`'s closing `</div>` (`public/index.html:122`):

```html
  <!-- Fixed overlay, same reasoning as #sessionListPane above: the launcher's
       display:none must not hide it, and `top` is measured from the header in
       autopilot-panel.js rather than being a CSS constant, because the header
       height changes when the rate-limit banner wraps it onto two lines. -->
  <div id="autopilotPane" class="detail-pane">
    <div id="autopilotResizeHandle" class="detail-pane-resize-handle" title="Drag to resize"></div>
    <div class="detail-pane-header">
      <span class="detail-pane-header-label">Auto-pilot</span>
      <span id="autopilotSpend" class="autopilot-spend" title="Total spend across every pilot today. The cap is a precondition only - it never kills a run already in flight."></span>
      <button type="button" id="autopilotNewBtn" class="btn" title="Create a new pilot">+ New</button>
      <button type="button" id="autopilotCloseBtn" class="btn" title="Close" aria-label="Close auto-pilot panel">✕</button>
    </div>
    <div class="detail-pane-tabs" role="tablist" id="autopilotTabs">
      <button type="button" class="detail-tab active" data-autopilot-tab="pilots" role="tab" aria-selected="true" title="Configured pilots">Pilots</button>
      <button type="button" class="detail-tab" data-autopilot-tab="logs" role="tab" aria-selected="false" title="Run history across every pilot">Logs</button>
    </div>
    <div id="autopilotBody" class="detail-pane-body"></div>
  </div>
```

- [ ] **Step 2: Write `public/autopilot-panel.js`**

```js
// The auto-pilot pane: a fixed overlay under the top bar with Pilots and Logs
// tabs, modelled on session-list-pane.js (measured `top`, header-button
// toggle, interval poll while open) rather than on the Settings modal - it is
// a monitoring surface you leave open, not a dialog you dismiss.
//
// The bell is deliberately NOT here: run history lives in the Logs tab and the
// bell holds actionable entries only (spec Decision 6), so they are two
// independent surfaces with two independent polls.
//
// Everything is built with createElement/textContent, never innerHTML: a pilot
// name, a gate command's captured stdout and a log reason are all strings this
// app did not author, and there is no CSP (backlog.md).
// Root-absolute specifiers are correct here and nowhere else in this feature:
// this module is only ever loaded by the browser, never imported by a test.
// autopilot-format.js is the one that has to stay import-free, which is why it
// takes the schedule functions as a parameter and this file supplies them.
import { initResizablePanel } from '/resizable-panel.js';
import { nextRunAt, backoffMs } from '/autopilot-schedule.js';
import {
  describeSchedule, describeNextRun, describeOutcome, describeSpend,
  formatRelativeTime, formatDuration,
} from '/autopilot-format.js';

const SCHEDULE = { nextRunAt, backoffMs };
const POLL_MS = 10_000;

export function initAutopilotPanel({
  panel, body, tabsEl, headerEl, toggleBtn, closeBtn, newBtn, spendEl,
  resizeHandle, initialWidth, onWidthChange, onEdit, onCreate,
  now = () => Date.now(),
}) {
  let open = false;
  let tab = 'pilots';
  let pollTimer = null;
  let lastSnapshot = null;

  initResizablePanel({
    panel,
    handle: resizeHandle,
    minWidthPx: 360,
    initialWidth,
    onWidthChange,
    isNarrowLayout: () => window.matchMedia('(max-width: 900px)').matches,
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function placeholder(text) {
    body.textContent = '';
    body.append(el('div', 'detail-pane-placeholder', text));
  }

  // Badge is kept fresh even while the pane is closed, so the header reflects
  // pilots enabled from another tab.
  function applyBadge(pilots, running) {
    const enabled = pilots.filter((p) => p.enabled).length;
    toggleBtn.textContent = running.length
      ? `🛫 Auto-pilot ${running.length}/${enabled}`
      : `🛫 Auto-pilot ${enabled}`;
    toggleBtn.title = running.length
      ? `${running.length} pilot run${running.length === 1 ? '' : 's'} in flight, ${enabled} enabled`
      : `${enabled} pilot${enabled === 1 ? '' : 's'} enabled`;
  }

  async function fetchSnapshot() {
    try {
      const res = await fetch('/api/autopilots');
      if (!res.ok) return lastSnapshot;
      lastSnapshot = await res.json();
      return lastSnapshot;
    } catch {
      // Best-effort: a failed poll leaves the last-known value showing rather
      // than replacing it with an alarming placeholder.
      return lastSnapshot;
    }
  }

  async function post(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  }

  function renderPilotRow(pilot, runningById, at) {
    const row = el('div', 'autopilot-row');
    if (!pilot.enabled) row.classList.add('disabled');
    const live = runningById.get(pilot.id);
    if (live) row.classList.add('running');

    const top = el('div', 'autopilot-row-top');
    top.append(el('span', 'autopilot-name', pilot.name));
    const state = el('span', 'autopilot-state');
    if (live) {
      state.textContent = live.blocked ? 'needs input' : 'running';
      state.classList.add(live.blocked ? 'blocked' : 'live');
      state.title = live.blocked
        ? 'Blocked on a permission prompt. It holds this pilot\'s lock until a human answers - and is exempt from the stall backstop, since waiting for you is not a runaway.'
        : `Started ${formatRelativeTime(live.startedAt, at)}`;
    } else {
      state.textContent = describeNextRun(pilot, at, SCHEDULE);
    }
    top.append(state);
    row.append(top);

    const meta = el('div', 'autopilot-meta');
    meta.append(el('span', null, describeSchedule(pilot)));
    meta.append(el('span', null, `${pilot.provider}${pilot.model ? ` / ${pilot.model}` : ''}${pilot.effort ? ` / ${pilot.effort}` : ''}`));
    const mode = el('span', 'autopilot-mode', pilot.mode);
    // Unattended writes to a real repository are the headline risk (spec
    // Risks #1) - the mode belongs on the row, not buried in the form.
    if (pilot.mode === 'acceptEdits' || pilot.mode === 'bypassPermissions' || pilot.mode === 'dontAsk' || pilot.mode === 'auto') {
      mode.classList.add('unattended');
      mode.title = 'This pilot writes to the working tree without asking.';
    }
    meta.append(mode);
    row.append(meta);

    const cwd = el('div', 'autopilot-cwd', pilot.cwd);
    cwd.title = pilot.cwd;
    row.append(cwd);
    row.append(el('div', 'autopilot-outcome', describeOutcome(pilot, at)));

    const actions = el('div', 'autopilot-actions');

    const runBtn = el('button', 'btn', 'Run now');
    runBtn.type = 'button';
    runBtn.title = 'Fire immediately, bypassing the schedule and the active window. Still honours the lock, the provider check, the run gate, rate limits and the spend cap.';
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      try {
        await post(`/api/autopilots/${pilot.id}/run-now`);
        await refresh();
      } catch (err) {
        showRowError(row, err);
      } finally {
        runBtn.disabled = false;
      }
    });

    const toggle = el('button', 'btn', pilot.enabled ? 'Disable' : 'Enable');
    toggle.type = 'button';
    toggle.title = pilot.enabled
      ? 'Stop scheduling this pilot. A run already in flight is left alone.'
      : 'Resume scheduling, and clear any failure back-off.';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await post(`/api/autopilots/${pilot.id}/toggle`, { enabled: !pilot.enabled });
        await refresh();
      } catch (err) {
        showRowError(row, err);
      } finally {
        toggle.disabled = false;
      }
    });

    const edit = el('button', 'btn', 'Edit');
    edit.type = 'button';
    edit.title = 'Changes apply from the next firing; a run in flight keeps the model and mode it was created with.';
    edit.addEventListener('click', () => onEdit?.(pilot));

    const del = el('button', 'btn btn-danger', 'Delete');
    del.type = 'button';
    del.title = 'Force-closes any live run first, then removes the pilot.';
    del.addEventListener('click', async () => {
      const warning = live
        ? `Delete "${pilot.name}"? Its running session will be force-closed first.`
        : `Delete "${pilot.name}"?`;
      if (!confirm(warning)) return;
      del.disabled = true;
      try {
        const res = await fetch(`/api/autopilots/${pilot.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
        await refresh();
      } catch (err) {
        showRowError(row, err);
        del.disabled = false;
      }
    });

    actions.append(runBtn, toggle, edit, del);
    row.append(actions);
    return row;
  }

  function showRowError(row, err) {
    let box = row.querySelector('.autopilot-row-error');
    if (!box) {
      box = el('div', 'autopilot-row-error mcp-error');
      row.append(box);
    }
    box.textContent = String(err?.message || err);
    box.hidden = false;
  }

  function renderPilots(snapshot) {
    const at = now();
    body.textContent = '';
    if (!snapshot.pilots.length) {
      const empty = el('div', 'detail-pane-placeholder');
      empty.append(el('p', null, 'No pilots yet.'));
      empty.append(el('p', null, 'A pilot fires a NEW session on a schedule: fresh conversation, one stored prompt, force-closed when the work is done. Pilots only run while this cockpit is running.'));
      body.append(empty);
      return;
    }
    const runningById = new Map(snapshot.running.map((r) => [r.pilotId, r]));
    for (const pilot of snapshot.pilots) body.append(renderPilotRow(pilot, runningById, at));
  }

  async function renderLogs() {
    placeholder('Loading…');
    let entries = [];
    try {
      const res = await fetch('/api/autopilot-logs?limit=200');
      entries = (await res.json()).entries || [];
    } catch {
      placeholder('Could not load the run log.');
      return;
    }
    if (tab !== 'logs' || !open) return;
    body.textContent = '';
    if (!entries.length) {
      placeholder('No runs yet.');
      return;
    }
    const at = now();
    // Newest first here, unlike the transcript: this is a log you scan from
    // the top, not a conversation you read forwards.
    for (const entry of [...entries].reverse()) {
      const row = el('div', `autopilot-log-row autopilot-log-${entry.event}`);
      const head = el('div', 'autopilot-log-head');
      head.append(el('span', 'autopilot-log-event', entry.event));
      head.append(el('span', 'autopilot-log-pilot', entry.pilotName || '—'));
      head.append(el('span', 'autopilot-log-when', formatRelativeTime(entry.ts, at)));
      row.append(head);

      const bits = [];
      if (entry.reason) bits.push(entry.reason);
      if (entry.durationMs != null) bits.push(`took ${formatDuration(entry.durationMs)}`);
      if (typeof entry.costUsd === 'number') bits.push(`$${entry.costUsd.toFixed(4)}`);
      if (entry.costUnpriced) bits.push('cost incomplete (unpriced model)');
      if (bits.length) row.append(el('div', 'autopilot-log-detail', bits.join(' · ')));

      if (Array.isArray(entry.answered)) {
        for (const a of entry.answered) {
          row.append(el('div', 'autopilot-log-answer', `auto-answered "${a.question}" → ${a.chosenLabel}`));
        }
      }
      body.append(row);
    }
  }

  async function refresh() {
    const snapshot = await fetchSnapshot();
    if (!snapshot) {
      if (open && tab === 'pilots') placeholder('Could not reach the server.');
      return;
    }
    applyBadge(snapshot.pilots, snapshot.running);
    spendEl.textContent = describeSpend(snapshot.spend, snapshot.settings.dailyCostCapUsd);
    if (!open) return;
    if (tab === 'pilots') renderPilots(snapshot);
    else await renderLogs();
  }

  function selectTab(next) {
    tab = next;
    for (const btn of tabsEl.querySelectorAll('[data-autopilot-tab]')) {
      const on = btn.dataset.autopilotTab === next;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    refresh();
  }

  function openPane() {
    open = true;
    toggleBtn.classList.add('on');
    // Measured live, not a fixed CSS constant - the header's height isn't
    // fixed (the rate-limit banner can wrap it onto two lines).
    panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
    panel.classList.add('enabled');
    placeholder('Loading…');
    refresh();
    // Poll only while open: unlike the badge, the list body is expensive to
    // rebuild and nobody is reading it when the pane is shut.
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
  }

  function closePane() {
    if (!open) return;
    open = false;
    toggleBtn.classList.remove('on');
    panel.classList.remove('enabled');
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Exported as openPane, not as a toggle: the notification bell needs
  // "bring me to the pilot list", and .click()ing the header button would
  // CLOSE the pane whenever it was already open - which is exactly when an
  // auto-disabled notification is most likely to be read.
  toggleBtn.addEventListener('click', () => (open ? closePane() : openPane()));
  closeBtn.addEventListener('click', closePane);
  newBtn.addEventListener('click', () => onCreate?.());
  tabsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-autopilot-tab]');
    if (btn) selectTab(btn.dataset.autopilotTab);
  });
  window.addEventListener('resize', () => {
    if (open) panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
  });

  refresh();
  // Badge stays fresh even with the pane closed, so pilots enabled in another
  // tab (or auto-disabled by the supervisor) show up here - same reasoning as
  // session-list-pane.js's own 10 s count poll.
  setInterval(() => { if (!open) refresh(); }, POLL_MS);

  return { refresh, openPane, closePane, selectTab, isOpen: () => open };
}
```

- [ ] **Step 3: Write `public/style-autopilot.css`**

```css
/* Auto-pilot pane, form modal and notifications bell.
   LOADED LAST in index.html's ordered stylesheet list, deliberately: the CSS
   split is cascade-ordered, so a later file's rule wins an equal-specificity
   tie against an earlier one. These rules extend .detail-pane / .btn from
   style-base.css and style-panels.css, so they must come after both. */

#autopilotPane {
  position: fixed;
  right: 0;
  bottom: 0;
  width: 480px;
  z-index: 40;
}

.autopilot-spend {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  font-size: 0.85em;
}

.autopilot-row {
  border-bottom: 1px solid var(--border, #2a2a2a);
  padding: 0.6rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.autopilot-row.disabled { opacity: 0.55; }
.autopilot-row.running { border-left: 3px solid var(--accent, #4a9eff); }

.autopilot-row-top { display: flex; align-items: baseline; gap: 0.5rem; }
.autopilot-name { font-weight: 600; }
.autopilot-state { margin-left: auto; font-size: 0.85em; opacity: 0.8; }
.autopilot-state.live { color: var(--accent, #4a9eff); opacity: 1; }
.autopilot-state.blocked { color: var(--warn, #e0a030); opacity: 1; }

.autopilot-meta { display: flex; flex-wrap: wrap; gap: 0.5rem; font-size: 0.82em; opacity: 0.8; }
.autopilot-mode.unattended { color: var(--warn, #e0a030); opacity: 1; }

.autopilot-cwd {
  font-size: 0.78em;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* keep the leaf folder visible when the path is long */
  text-align: left;
}
.autopilot-outcome { font-size: 0.8em; opacity: 0.7; }

.autopilot-actions { display: flex; gap: 0.35rem; margin-top: 0.25rem; flex-wrap: wrap; }
.autopilot-row-error { margin-top: 0.35rem; }

.autopilot-log-row { border-bottom: 1px solid var(--border, #2a2a2a); padding: 0.45rem 0.75rem; }
.autopilot-log-head { display: flex; gap: 0.5rem; align-items: baseline; }
.autopilot-log-event {
  font-size: 0.72em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
  background: var(--chip-bg, #2a2a2a);
}
.autopilot-log-finished .autopilot-log-event { background: #1e4620; }
.autopilot-log-errored .autopilot-log-event,
.autopilot-log-timed-out .autopilot-log-event { background: #4a1e1e; }
.autopilot-log-blocked .autopilot-log-event { background: #4a3a1e; }
.autopilot-log-pilot { font-weight: 600; font-size: 0.85em; }
.autopilot-log-when { margin-left: auto; font-size: 0.78em; opacity: 0.6; }
.autopilot-log-detail, .autopilot-log-answer { font-size: 0.8em; opacity: 0.75; margin-top: 0.15rem; }

/* --- notifications bell (see notifications-panel.js) --- */

#notificationsBtn.has-entries { color: var(--warn, #e0a030); }

#notificationsPanel {
  position: fixed;
  right: 0.5rem;
  width: 340px;
  max-height: 60vh;
  overflow-y: auto;
  z-index: 60; /* above #autopilotPane, which it can open on top of */
  background: var(--panel-bg, #1a1a1a);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 6px;
  padding: 0.35rem;
}
#notificationsPanel[hidden] { display: none; }
.notification-row {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid var(--border, #2a2a2a);
}
.notification-row:last-child { border-bottom: none; }
.notification-row.clickable { cursor: pointer; }
.notification-row.clickable:hover { background: var(--hover-bg, #232323); }
.notification-message { font-size: 0.88em; }
.notification-hint { font-size: 0.76em; opacity: 0.6; }

/* --- create/edit form modal --- */

#autopilotFormModal .modal-box { width: min(640px, 92vw); }
.autopilot-form-warning {
  border-left: 3px solid var(--warn, #e0a030);
  padding: 0.4rem 0.6rem;
  margin: 0.4rem 0;
  font-size: 0.85em;
}
.autopilot-window-row { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
.autopilot-weekdays { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.autopilot-weekdays label { display: flex; align-items: center; gap: 0.15rem; font-size: 0.82em; }

@media (max-width: 900px) {
  #autopilotPane { width: 100%; }
  #notificationsPanel { width: calc(100% - 1rem); }
}
```

- [ ] **Step 4: Wire it in `app.js`**

Add the import beside the other panel imports (`public/app.js:25`):

```js
import { initAutopilotPanel } from '/autopilot-panel.js';
```

Add the construction next to `initSessionListPane` (`public/app.js:142`). Leave `onEdit`/`onCreate` as `null` for now — Task 3 replaces them:

```js
const autopilotPanel = initAutopilotPanel({
  panel: document.getElementById('autopilotPane'),
  body: document.getElementById('autopilotBody'),
  tabsEl: document.getElementById('autopilotTabs'),
  headerEl: document.querySelector('.app-header'),
  toggleBtn: document.getElementById('autopilotBtn'),
  closeBtn: document.getElementById('autopilotCloseBtn'),
  newBtn: document.getElementById('autopilotNewBtn'),
  spendEl: document.getElementById('autopilotSpend'),
  resizeHandle: document.getElementById('autopilotResizeHandle'),
  // Same persistence pair initSessionListPane already uses
  // (public/app.js:159-160) - without both of these initResizablePanel gets
  // `undefined` and the width resets on every reload.
  initialWidth: persistedTurnChartPrefs.autopilotPaneWidth,
  onWidthChange: (width) => patchSettings({ autopilotPaneWidth: width }),
  onEdit: null,   // wired to autopilot-form.js below
  onCreate: null,
});
```

- [ ] **Step 5: Hand-verify the pane**

There is no jsdom in this project, so this is the test. Run `npm start`, open the URL, and check each of these:

1. `🛫 Auto-pilot 0` appears in the header before the ⚙ button, and clicking it opens a right-docked pane whose top edge sits exactly under the header.
2. With no pilots, the pane shows the empty-state copy including "Pilots only run while this cockpit is running."
3. Create a pilot with `curl` (see the supervisor plan's Task 8 walkthrough), then reopen the pane: the row shows name, `every N min`, provider/model/effort, the mode chip, the cwd and `never run`.
4. Set the mode to `acceptEdits`: the mode chip turns amber with the "writes to the working tree without asking" tooltip.
5. Click **Run now**: within a poll the row shows `running`, the header badge reads `🛫 Auto-pilot 1/1`, and the spend figure in the pane header updates once the run finishes.
6. Click **Run now** twice quickly: the second attempt surfaces **"already running"** as a red line inside the row — not a bare `409`, not a browser alert, not a silent no-op. (If you see `409`, the route is not putting the reason in an `error` key; see the supervisor plan's Task 8.)
7. Switch to **Logs**: entries render newest-first with the event chip coloured (`finished` green, `errored`/`timed-out` red, `blocked` amber), a duration and a dollar figure.
8. Resize the pane by dragging its left edge; the width persists across the tab reopening.
9. Shrink the window below 900 px: the pane goes full width and nothing overlaps the compose box.
10. Close the pane and confirm the header badge still updates when you toggle a pilot from `curl` in another terminal (the closed-pane poll).

- [ ] **Step 6: Commit**

```bash
git add public/autopilot-panel.js public/style-autopilot.css public/index.html public/app.js
git commit -m "feat: auto-pilot pane with Pilots and Logs tabs"
```

---

### Task 3: The create/edit form modal

**Files:**
- Create: `public/autopilot-form.js`
- Modify: `public/index.html` (the modal markup, after `#settingsModal` at `:423`)
- Modify: `public/app.js` (construct the form; pass its openers as the panel's `onEdit`/`onCreate`)

**Interfaces:**
- Consumes: `PERMISSION_MODES` from `/permissions.js`; `createProviderCatalog` from `/provider-catalog.js` (already imported by `app.js` at `public/app.js:30`); `initDirBrowser`'s `onSelect` (`public/dir-browser.js:6`); `WEEKDAY_LABELS`, `formatMinuteOfDay` (Task 1); `POST /api/autopilots`, `POST /api/autopilots/:id`.
- Produces:
  - `initAutopilotForm({ modal, form, titleEl, errorEl, warningsEl, fields, cancelBtn, browseBtn, getProviderCatalog, openDirBrowser, onSaved }) => { openCreate, openEdit, refreshProviders }`
  - No `saveBtn`: the save button is the form's `type="submit"`, so the `submit` listener covers it.
  - `fields` is a flat object of the input elements, listed in Step 1's markup.

- [ ] **Step 1: Add the modal markup**

In `public/index.html`, after `#settingsModal`'s closing `</dialog>` (`public/index.html:423`):

```html
  <dialog id="autopilotFormModal" class="modal" aria-labelledby="autopilotFormTitle">
    <form class="modal-box" id="autopilotForm" method="dialog">
      <header class="modal-header"><strong id="autopilotFormTitle">New pilot</strong></header>
      <div class="modal-body settings-body">
        <div id="autopilotFormWarnings"></div>
        <div id="autopilotFormError" class="mcp-error" hidden></div>

        <label class="settings-row">
          <span>Name</span>
          <input type="text" id="apName" required maxlength="80" placeholder="Nightly triage" />
          <span class="hint" title="Unique across all pilots. The session it fires is named after the pilot, so another session can /ask it by name.">?</span>
        </label>

        <div class="settings-row">
          <span>Project folder</span>
          <input type="text" id="apCwd" required placeholder="C:\path\to\project" />
          <button type="button" id="apBrowseBtn" class="btn" title="Browse for a project folder">Browse</button>
        </div>

        <label class="settings-row">
          <span>Provider</span>
          <select id="apProvider"></select>
        </label>

        <label class="settings-row">
          <span>Model</span>
          <input type="text" id="apModel" placeholder="(provider default)" />
          <span class="hint" title="Leave blank for the provider's default. Validated against the same safe-argument rule a hand-started session uses.">?</span>
        </label>

        <label class="settings-row">
          <span>Reasoning effort</span>
          <select id="apEffort"></select>
        </label>

        <label class="settings-row">
          <span>Permission mode</span>
          <select id="apMode"></select>
          <span class="hint" title="This governs tool permissions for the whole unattended run. acceptEdits / bypassPermissions / dontAsk / auto all write to the working tree without asking.">?</span>
        </label>

        <label class="settings-row settings-row-stacked">
          <span>Prompt</span>
          <textarea id="apPrompt" required rows="4" placeholder="/triage-backlog"></textarea>
          <span class="hint" title="Sent verbatim on every firing, into a brand-new conversation. It may itself be a slash command.">?</span>
        </label>

        <label class="settings-row">
          <span>Run every</span>
          <input type="number" id="apEveryMinutes" min="1" max="10080" required />
          <span>minutes</span>
        </label>

        <label class="settings-row">
          <input type="checkbox" id="apWindowEnabled" />
          <span>Only inside an active window</span>
        </label>
        <div class="settings-row autopilot-window-row" id="apWindowRow" hidden>
          <label class="visually-hidden" for="apWindowFrom">Window start</label>
          <input type="time" id="apWindowFrom" value="09:00" />
          <span>to</span>
          <label class="visually-hidden" for="apWindowTo">Window end</label>
          <input type="time" id="apWindowTo" value="17:00" />
          <div class="autopilot-weekdays" id="apWeekdays"></div>
          <span class="hint" title="An end time earlier than the start crosses midnight. The weekday is the day the window OPENED, so 01:00 Saturday belongs to Friday night.">?</span>
        </div>

        <label class="settings-row">
          <input type="checkbox" id="apGateEnabled" />
          <span>Only run if a command succeeds</span>
          <span class="hint" title="Runs in the project folder before each firing. A non-zero exit or a timeout skips the run, with the command's output as the reason. This executes arbitrary shell from your config file on a schedule.">?</span>
        </label>
        <div class="settings-row autopilot-window-row" id="apGateRow" hidden>
          <label class="visually-hidden" for="apGateCommand">Gate command</label>
          <input type="text" id="apGateCommand" placeholder="git fetch && git log --oneline -1 origin/main" />
          <label class="visually-hidden" for="apGateTimeout">Gate timeout (ms)</label>
          <input type="number" id="apGateTimeout" min="1000" max="600000" value="30000" />
          <span>ms timeout</span>
        </div>

        <label class="settings-row" id="apInputPolicyRow">
          <span>When it asks a question</span>
          <select id="apInputPolicy">
            <option value="ask">Wait for me (notify)</option>
            <option value="recommended">Pick the recommended answer</option>
          </select>
          <span class="hint" title="Governs AskUserQuestion only. Tool permissions stay governed by the permission mode above, and an end-of-plan approval is never auto-approved. Claude only.">?</span>
        </label>

        <label class="settings-row">
          <span>Runaway backstop</span>
          <input type="number" id="apMaxStallMinutes" min="1" max="1440" value="60" />
          <span>minutes</span>
          <span class="hint" title="Force-closes a run after this long with no new messages. NOT a hang detector: a single long tool call (a build, a test suite) emits nothing while it works, so keep this generous.">?</span>
        </label>
      </div>
      <footer>
        <button type="button" id="apCancelBtn" class="btn" title="Discard changes">Cancel</button>
        <button type="submit" id="apSaveBtn" class="btn btn-primary" title="Save this pilot">Save</button>
      </footer>
    </form>
  </dialog>
```

- [ ] **Step 2: Write `public/autopilot-form.js`**

```js
// Create/edit modal for one pilot. Mostly wiring around pickers that already
// exist: dir-browser.js for the folder, provider-catalog.js for the provider's
// effort list, and permissions.js for the mode list (shared verbatim with the
// server via static-files.js's SHARED_SRC_FILES, so the option list here and
// the server's own validation are literally the same array).
//
// Two misconfigurations the form is required to warn about, because both are
// silently ineffective rather than loudly wrong:
//   1. `default` mode with "pick the recommended answer" - the mode still
//      parks on ordinary tool-permission prompts, since the mode governs
//      those, not the input policy.
//   2. A Grok or Codex pilot with "pick the recommended answer" -
//      AskUserQuestion is Claude-only, so the field does nothing at all. The
//      field is DISABLED for those providers rather than left to look active.
import { PERMISSION_MODES } from '/permissions.js';
import { WEEKDAY_LABELS } from '/autopilot-format.js';

const UNATTENDED_WRITE_MODES = new Set(['acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']);

function minuteOfDayFromTimeInput(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
}

function timeInputFromMinuteOfDay(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function initAutopilotForm({
  modal, form, titleEl, errorEl, warningsEl, fields, cancelBtn, browseBtn,
  getProviderCatalog, openDirBrowser, onSaved,
}) {
  let editingId = null;

  // Weekday checkboxes, built once.
  const weekdayInputs = [];
  for (let day = 0; day < 7; day++) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.addEventListener('change', renderWarnings);
    const text = document.createElement('span');
    text.textContent = WEEKDAY_LABELS[day];
    label.append(input, text);
    fields.weekdays.append(label);
    weekdayInputs.push(input);
  }

  function fillModes() {
    fields.mode.textContent = '';
    for (const mode of PERMISSION_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = mode;
      fields.mode.append(option);
    }
  }

  // createProviderCatalog returns { add, get, has, list, label, validate }
  // (public/provider-catalog.js:89) - list() yields descriptors, not ids.
  function fillProviders() {
    const catalog = getProviderCatalog();
    const previous = fields.provider.value;
    fields.provider.textContent = '';
    for (const descriptor of catalog.list()) {
      const option = document.createElement('option');
      option.value = descriptor.id;
      option.textContent = catalog.label(descriptor.id);
      fields.provider.append(option);
    }
    if (previous && catalog.has(previous)) fields.provider.value = previous;
  }

  function fillEfforts() {
    const catalog = getProviderCatalog();
    // The server's providerDetails() puts the effort list under
    // `launch.efforts` (src/provider-registry.js:177-187), and the catalog
    // spreads that payload onto the descriptor verbatim. Empty until
    // /api/providers resolves, which is why app.js calls refreshProviders()
    // afterwards.
    const efforts = catalog.get(fields.provider.value)?.launch?.efforts || [];
    const previous = fields.effort.value;
    fields.effort.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '(provider default)';
    fields.effort.append(blank);
    for (const effort of efforts) {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = effort;
      fields.effort.append(option);
    }
    // An effort the new provider does not support must not silently survive a
    // provider switch - the server would 400 on save.
    fields.effort.value = efforts.includes(previous) ? previous : '';
  }

  function warn(text) {
    const box = document.createElement('div');
    box.className = 'autopilot-form-warning';
    box.textContent = text;
    warningsEl.append(box);
  }

  function renderWarnings() {
    warningsEl.textContent = '';
    const provider = fields.provider.value;
    const claude = provider === 'claude';

    // Misconfiguration 2: hide the control entirely for a provider that has
    // no AskUserQuestion, rather than leaving a setting that does nothing.
    fields.inputPolicyRow.hidden = !claude;
    if (!claude) fields.inputPolicy.value = 'ask';

    if (claude && fields.inputPolicy.value === 'recommended' && fields.mode.value === 'default') {
      // Misconfiguration 1.
      warn('Heads up: "pick the recommended answer" only covers questions the agent asks you. In "default" mode this pilot will still stop and wait on ordinary tool-permission prompts, because the permission mode governs those.');
    }
    if (UNATTENDED_WRITE_MODES.has(fields.mode.value)) {
      warn(`"${fields.mode.value}" writes to ${fields.cwd.value || 'the project folder'} without asking, unattended, on a timer. Make sure that folder is one you are happy for an agent to change while you are not watching.`);
    }
    if (fields.gateEnabled.checked) {
      warn('The run-gate command is executed as shell in the project folder before every firing.');
    }
    const from = minuteOfDayFromTimeInput(fields.windowFrom.value);
    const to = minuteOfDayFromTimeInput(fields.windowTo.value);
    if (fields.windowEnabled.checked && from != null && to != null && from > to) {
      warn('This window crosses midnight. The weekday set is the day the window OPENS, so a Friday window covers Friday night into Saturday morning.');
    }
    // BLOCKS submission rather than only warning: autopilot-store.js rejects
    // an explicitly empty weekday set (it refuses to silently widen it to
    // every day, which would be the opposite of what the operator selected),
    // so letting this through would just produce a 400.
    if (fields.windowEnabled.checked && weekdayInputs.every((i) => !i.checked)) {
      warn('Select at least one weekday - a window with no days selected cannot be saved.');
      return false;
    }
    return true;
  }

  function readForm() {
    const windowEnabled = fields.windowEnabled.checked;
    const gateEnabled = fields.gateEnabled.checked;
    return {
      name: fields.name.value.trim(),
      cwd: fields.cwd.value.trim(),
      provider: fields.provider.value,
      model: fields.model.value.trim() || null,
      effort: fields.effort.value || null,
      mode: fields.mode.value,
      prompt: fields.prompt.value,
      schedule: {
        everyMinutes: Number(fields.everyMinutes.value),
        window: windowEnabled ? {
          fromMinute: minuteOfDayFromTimeInput(fields.windowFrom.value),
          toMinute: minuteOfDayFromTimeInput(fields.windowTo.value),
          weekdays: weekdayInputs.map((input, day) => (input.checked ? day : null)).filter((d) => d !== null),
        } : null,
      },
      gate: gateEnabled ? {
        command: fields.gateCommand.value.trim(),
        timeoutMs: Number(fields.gateTimeout.value),
      } : null,
      inputPolicy: fields.inputPolicy.value,
      maxTurnStallMs: Number(fields.maxStallMinutes.value) * 60_000,
    };
  }

  function writeForm(pilot) {
    fields.name.value = pilot?.name ?? '';
    fields.cwd.value = pilot?.cwd ?? '';
    fillProviders();
    fields.provider.value = pilot?.provider ?? 'claude';
    fillEfforts();
    fields.model.value = pilot?.model ?? '';
    fields.effort.value = pilot?.effort ?? '';
    fields.mode.value = pilot?.mode ?? 'default';
    fields.prompt.value = pilot?.prompt ?? '';
    fields.everyMinutes.value = pilot?.schedule?.everyMinutes ?? 60;

    const window = pilot?.schedule?.window ?? null;
    fields.windowEnabled.checked = Boolean(window);
    fields.windowRow.hidden = !window;
    fields.windowFrom.value = window ? timeInputFromMinuteOfDay(window.fromMinute) : '09:00';
    fields.windowTo.value = window ? timeInputFromMinuteOfDay(window.toMinute) : '17:00';
    const days = window ? new Set(window.weekdays) : new Set([0, 1, 2, 3, 4, 5, 6]);
    weekdayInputs.forEach((input, day) => { input.checked = days.has(day); });

    const gate = pilot?.gate ?? null;
    fields.gateEnabled.checked = Boolean(gate);
    fields.gateRow.hidden = !gate;
    fields.gateCommand.value = gate?.command ?? '';
    fields.gateTimeout.value = gate?.timeoutMs ?? 30_000;

    fields.inputPolicy.value = pilot?.inputPolicy ?? 'ask';
    fields.maxStallMinutes.value = Math.round((pilot?.maxTurnStallMs ?? 3_600_000) / 60_000);

    errorEl.hidden = true;
    renderWarnings();
  }

  function open(pilot) {
    editingId = pilot?.id ?? null;
    titleEl.textContent = pilot ? `Edit "${pilot.name}"` : 'New pilot';
    writeForm(pilot);
    modal.showModal();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // renderWarnings returns false for the one client-side condition the
    // server would reject anyway (a window with no weekdays). Everything else
    // it produces is advisory and must not block a save.
    if (!renderWarnings()) return;
    const body = readForm();
    const url = editingId ? `/api/autopilots/${editingId}` : '/api/autopilots';
    errorEl.hidden = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
      modal.close();
      onSaved?.(data);
    } catch (err) {
      // The server is the authority on provider/effort/model/cwd validity
      // (routes/autopilot.js) - surface its message rather than duplicating
      // those rules here and drifting.
      errorEl.textContent = String(err?.message || err);
      errorEl.hidden = false;
    }
  });

  cancelBtn.addEventListener('click', () => modal.close());
  browseBtn.addEventListener('click', () => openDirBrowser((selected) => {
    fields.cwd.value = selected;
    renderWarnings();
  }));

  fields.provider.addEventListener('change', () => { fillEfforts(); renderWarnings(); });
  for (const el of [fields.mode, fields.inputPolicy, fields.cwd, fields.windowFrom, fields.windowTo]) {
    el.addEventListener('change', renderWarnings);
  }
  fields.windowEnabled.addEventListener('change', () => {
    fields.windowRow.hidden = !fields.windowEnabled.checked;
    renderWarnings();
  });
  fields.gateEnabled.addEventListener('change', () => {
    fields.gateRow.hidden = !fields.gateEnabled.checked;
    renderWarnings();
  });

  fillModes();
  fillProviders();
  fillEfforts();

  return {
    openCreate: () => open(null),
    openEdit: (pilot) => open(pilot),
    refreshProviders: () => { fillProviders(); fillEfforts(); },
  };
}
```

- [ ] **Step 3: Wire it in `app.js`**

Add the import:

```js
import { initAutopilotForm } from '/autopilot-form.js';
```

After the `initAutopilotPanel` call, construct the form and connect the two directions. `dirBrowser` and `providerCatalog` already exist in `app.js` (`public/app.js:30`, `public/app.js:37`):

```js
const autopilotForm = initAutopilotForm({
  modal: document.getElementById('autopilotFormModal'),
  form: document.getElementById('autopilotForm'),
  titleEl: document.getElementById('autopilotFormTitle'),
  errorEl: document.getElementById('autopilotFormError'),
  warningsEl: document.getElementById('autopilotFormWarnings'),
  cancelBtn: document.getElementById('apCancelBtn'),
  browseBtn: document.getElementById('apBrowseBtn'),
  getProviderCatalog: () => providerCatalog,
  openDirBrowser: (onSelect) => dirBrowser.open(cwdInput.value || '', onSelect),
  onSaved: () => autopilotPanel.refresh(),
  fields: {
    name: document.getElementById('apName'),
    cwd: document.getElementById('apCwd'),
    provider: document.getElementById('apProvider'),
    model: document.getElementById('apModel'),
    effort: document.getElementById('apEffort'),
    mode: document.getElementById('apMode'),
    prompt: document.getElementById('apPrompt'),
    everyMinutes: document.getElementById('apEveryMinutes'),
    windowEnabled: document.getElementById('apWindowEnabled'),
    windowRow: document.getElementById('apWindowRow'),
    windowFrom: document.getElementById('apWindowFrom'),
    windowTo: document.getElementById('apWindowTo'),
    weekdays: document.getElementById('apWeekdays'),
    gateEnabled: document.getElementById('apGateEnabled'),
    gateRow: document.getElementById('apGateRow'),
    gateCommand: document.getElementById('apGateCommand'),
    gateTimeout: document.getElementById('apGateTimeout'),
    inputPolicy: document.getElementById('apInputPolicy'),
    inputPolicyRow: document.getElementById('apInputPolicyRow'),
    maxStallMinutes: document.getElementById('apMaxStallMinutes'),
  },
});
```

Replace the panel's two `null` callbacks with the form's openers. `initAutopilotPanel` runs before the form exists, so pass thunks:

```js
  onEdit: (pilot) => autopilotForm.openEdit(pilot),
  onCreate: () => autopilotForm.openCreate(),
```

`app.js` starts with a two-provider placeholder catalog (`public/app.js:37`) and replaces it once `/api/providers` resolves, at `providerCatalog = catalog;` (`public/app.js:1991`). Add the refresh immediately after that line, so the dropdown gains Codex and every provider's real effort list:

```js
    providerCatalog = catalog;
    autopilotForm.refreshProviders(); // the placeholder catalog has no effort lists
```

Note `autopilotForm` is declared with `const` above that line in module scope, so it is initialized by the time the `/api/providers` response lands.

- [ ] **Step 4: Hand-verify the form**

1. Click **+ New**: the modal opens with sane defaults (Claude, `default` mode, 60 minutes, no window, no gate, 60-minute backstop).
2. **Browse** opens the existing folder picker and fills the cwd field.
3. Switch the provider to Grok: the effort list changes to Grok's set, and the "When it asks a question" row disappears entirely. Switch back to Claude: it returns.
4. Set Claude + `default` mode + "Pick the recommended answer": the first warning appears, naming permission mode as the reason.
5. Set mode to `acceptEdits`: the unattended-write warning appears and names the actual folder.
6. Tick the window box, set 22:00 → 06:00: the midnight-crossing warning appears. Untick every weekday: the "can never fire" warning appears.
7. Tick the gate box: the shell warning appears.
8. Save with a duplicate name: the server's 409 message renders in the modal's error line and the modal stays open.
9. Save with an effort the provider does not support (force it by editing the DOM): the server's 400 message renders, not a silent failure.
10. Save a valid pilot: the modal closes and the pane's row appears without a manual refresh.
11. **Edit** an existing pilot: every field round-trips, including the window times, the exact weekday set, and the gate command.

- [ ] **Step 5: Commit**

```bash
git add public/autopilot-form.js public/index.html public/app.js
git commit -m "feat: auto-pilot create/edit modal with provider gating and misconfiguration warnings"
```

---

### Task 4: The notifications bell and the attach flow

**Files:**
- Create: `public/notifications-panel.js`
- Modify: `public/index.html` (the dropdown markup after `#autopilotPane`)
- Modify: `public/app.js` (construct the bell; add the `?attach=` bootstrap beside the existing `?newTab=1` one at `public/app.js:426-432`)

**Interfaces:**
- Consumes: `GET /api/notifications`, `GET /api/sessions/:id/attach-token` (supervisor plan, Task 8).
- Produces:
  - `initNotificationsPanel({ button, panel, headerEl, onOpenPilots }) => { refresh }`
  - In `app.js`: `adoptAttachedSession()` — the `?attach=<sessionId>` bootstrap, which **must run before `rejoinActiveSession()`**.

- [ ] **Step 1: Add the dropdown markup**

In `public/index.html`, after `#autopilotPane`'s closing `</div>`:

```html
  <!-- Small dropdown, not a pane: the bell holds ACTIONABLE entries only.
       Run history lives in the auto-pilot pane's Logs tab. -->
  <div id="notificationsPanel" role="menu" aria-labelledby="notificationsBtn" hidden></div>
```

- [ ] **Step 2: Write `public/notifications-panel.js`**

```js
// The notifications bell. Two entry kinds, both DERIVED server-side from live
// state (src/autopilot.js's notifications()): a pilot run blocked on a
// question a human has to answer, and a pilot auto-disabled after repeated
// failures. Nothing is stored and nothing is marked read - an entry vanishes
// when the state it was computed from is gone.
//
// A POLL, not a socket: each tab's WebSocket is scoped to the one session it
// is attached to, and a pilot's session is by definition one it is NOT
// attached to. Same 10s cadence as the "All sessions" pane
// (public/session-list-pane.js:211-218).
const POLL_MS = 10_000;

export function initNotificationsPanel({ button, panel, headerEl, onOpenPilots }) {
  let open = false;
  let entries = [];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Opens a NEW tab attached to a pilot's running session. The token stays out
  // of the URL: `?session=<id>&token=<t>` would put a credential somewhere it
  // gets logged and referred (the leak backlog.md:27 flags for /ws). Instead
  // the new tab fetches the token from GET /api/sessions/:id/attach-token.
  //
  // Safe for auth because the OPERATOR token lives in localStorage, not
  // sessionStorage (public/operator-auth.js:6,13,25) - so the new tab clearing
  // its inherited sessionStorage copy does not de-authenticate it.
  function attach(sessionId) {
    window.open(`/?attach=${encodeURIComponent(sessionId)}`, '_blank');
  }

  function render() {
    panel.textContent = '';
    if (!entries.length) {
      panel.append(el('div', 'notification-row notification-hint', 'Nothing needs your attention.'));
      return;
    }
    for (const entry of entries) {
      const row = el('div', 'notification-row');
      row.append(el('div', 'notification-message', entry.message));
      if (entry.kind === 'needs-input') {
        row.classList.add('clickable');
        row.append(el('div', 'notification-hint', 'Click to open this session in a new tab and answer it.'));
        row.addEventListener('click', () => {
          attach(entry.sessionId);
          closePanel();
        });
      } else if (entry.kind === 'auto-disabled') {
        row.classList.add('clickable');
        row.append(el('div', 'notification-hint', 'Click to open the auto-pilot panel and re-enable it.'));
        row.addEventListener('click', () => {
          onOpenPilots?.();
          closePanel();
        });
      }
      panel.append(row);
    }
  }

  function applyBadge() {
    button.hidden = entries.length === 0;
    button.classList.toggle('has-entries', entries.length > 0);
    button.textContent = entries.length ? `🔔 ${entries.length}` : '🔔';
    button.title = entries.length
      ? `${entries.length} auto-pilot item${entries.length === 1 ? '' : 's'} needs your attention`
      : 'Auto-pilot notifications';
  }

  async function refresh() {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      entries = (await res.json()).entries || [];
    } catch {
      return; // best-effort; keep showing the last-known list
    }
    applyBadge();
    if (open) render();
  }

  function openPanel() {
    open = true;
    panel.style.top = `${headerEl.getBoundingClientRect().bottom + 4}px`;
    panel.hidden = false;
    render();
    refresh();
  }

  function closePanel() {
    open = false;
    panel.hidden = true;
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (open) closePanel();
    else openPanel();
  });
  document.addEventListener('click', (event) => {
    if (open && !panel.contains(event.target) && event.target !== button) closePanel();
  });
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') closePanel();
  });

  refresh();
  setInterval(refresh, POLL_MS);

  return { refresh };
}
```

- [ ] **Step 3: Add the attach bootstrap to `app.js`**

Immediately **after** the existing `discardInheritedSessionOnNewTab` IIFE (`public/app.js:426-432`) and **before** anything calls `rejoinActiveSession()`:

```js
// Opening a pilot's session from the notification bell. Same sessionStorage
// trap as ?newTab=1 above: per the HTML spec a script-opened same-origin tab
// gets a COPY of the opener's sessionStorage, so without clearing it first
// rejoinActiveSession() below silently reattaches this tab to the OPENER's
// session instead of the pilot's.
//
// The token deliberately is not in the URL - it is fetched from
// /api/sessions/:id/attach-token, which is operator-gated (like every /api/
// route) and scoped server-side to pilot-owned sessions.
const attachSessionId = (() => {
  const url = new URL(window.location.href);
  const id = url.searchParams.get('attach');
  if (!id) return null;
  clearActiveSession();               // MUST happen before rejoinActiveSession
  url.searchParams.delete('attach');
  history.replaceState(null, '', url);
  return id;
})();

async function adoptAttachedSession() {
  if (!attachSessionId) return false;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(attachSessionId)}/attach-token`);
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      console.warn(`could not attach to ${attachSessionId}: ${error || res.status}`);
      return false;
    }
    const { id, token } = await res.json();
    saveActiveSession(id, token);
    return true;
  } catch (err) {
    console.warn(`could not attach to ${attachSessionId}:`, err);
    return false;
  }
}
```

Then change the load-time invocation at `public/app.js:2607`, which currently reads `rejoinActiveSession().then((rejoined) => { ... })`. Wrap it so the adoption resolves first, preserving the existing `.then` body verbatim:

```js
adoptAttachedSession().then(() => rejoinActiveSession()).then((rejoined) => {
  // ...existing body, unchanged...
});
```

`adoptAttachedSession` already swallows its own failures and resolves `false`, so a bad or expired `attach` id falls through to the normal launcher rather than blocking startup. Do not touch the `rejoinActiveSession` function definition at `public/app.js:2591`, and do not add a second caller.

- [ ] **Step 4: Construct the bell in `app.js`**

Import beside the other panel imports, and construct it immediately after the `initAutopilotForm` call from Task 3 — it references `autopilotPanel`, so it must come after that binding. The return value is intentionally not stored: the bell owns its own poll and nothing else drives it.

```js
import { initNotificationsPanel } from '/notifications-panel.js';

initNotificationsPanel({
  button: document.getElementById('notificationsBtn'),
  panel: document.getElementById('notificationsPanel'),
  headerEl: document.querySelector('.app-header'),
  // Not `autopilotBtn.click()`: that toggles, so it would CLOSE the pane
  // whenever it was already open. Open explicitly and force the Pilots tab,
  // since an operator sitting on Logs would otherwise see no pilot list.
  onOpenPilots: () => {
    autopilotPanel.openPane();
    autopilotPanel.selectTab('pilots');
  },
});
```

- [ ] **Step 5: Hand-verify the bell and the attach flow**

1. With nothing pending, `#notificationsBtn` is hidden entirely.
2. Create a pilot with `inputPolicy: "ask"` and a prompt that triggers a permission prompt (mode `default`, prompt "Run `git status` using the Bash tool"). Run it. Within a poll the bell appears reading `🔔 1`, coloured amber.
3. Click the bell: the dropdown lists `"<pilot>" is waiting on Bash` with the "open in a new tab" hint.
4. Click the entry. **This is the load-bearing check:** the new tab must show the *pilot's* transcript with its approval banner — **not** the opener's session. If it shows the opener's session, `clearActiveSession()` is running too late.
5. Confirm the new tab's URL is a bare `/` — no `?attach`, no `token`, no `op`.
6. Answer the approval in the new tab. Within a poll the bell disappears in **both** tabs (it is derived, so nothing needs marking read).
7. Force an auto-disable: point a pilot at a nonexistent folder and let it fail five times (or hand-edit `consecutiveFailures` to 4 in `~/.prompt-cockpit/autopilots.json` and let it fail once). The bell shows the auto-disabled entry; clicking it opens the Pilots pane.
8. Re-enable that pilot from the pane: the bell entry disappears and `consecutiveFailures` resets to 0.
9. Click outside the dropdown, and press Escape: both close it.
10. Open a pilot session tab, then reload it: it stays attached to the pilot's session (the `?attach` marker is one-shot, but `saveActiveSession` persisted the real credential).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — no new failures. Nothing in this task is unit-testable without jsdom, which is why steps 5's checks are enumerated rather than summarised.

- [ ] **Step 7: Update `tests/README.md`**

`tests/README.md` documents feature by feature what is unit-tested versus hand-verified and why. Add an auto-pilot section recording:

- Unit-tested: `autopilot-store`, `autopilot-log`, `autopilot-schedule`, `autopilot-answer`, `autopilot` (supervisor, injected clock + fake registry), `autopilot-routes`, `child-tracker`, `json-store`, `shutdown`, `autopilot-format`, `static-files`.
- Hand-verified only: `autopilot-panel.js`, `autopilot-form.js`, `notifications-panel.js` and the `?attach=` bootstrap — DOM and interaction behavior with no jsdom in this project. Link to this plan's Task 2 step 5, Task 3 step 4 and Task 4 step 5 as the click-throughs to re-run.
- Re-run after touching Grok/Codex spawn or teardown: `tests/grok-live.manual.mjs`. Note that there is still no Codex equivalent (`backlog.md` already records this gap) and that `tests/integration.manual.mjs` is unaffected, since Claude's spawn is unchanged.

- [ ] **Step 8: Commit**

```bash
git add public/notifications-panel.js public/index.html public/app.js tests/README.md
git commit -m "feat: auto-pilot notifications bell and token-free attach flow"
```

---

### Task 5: Backlog and README housekeeping

The spec's own framing is that auto-pilot is a shipped capability, and this repo tracks status in two places that a reviewer will check.

**Files:**
- Modify: `README.md` (Status section)
- Modify: `backlog.md`
- Modify: `CLAUDE.md` (Architecture section)

- [ ] **Step 1: Update `README.md`'s Status section**

Add this after the MVP1-5 entries. Copy it verbatim rather than paraphrasing - the four limitations are the ones the spec requires stating plainly, and a reader deciding whether to point a pilot at a real repository needs all four:

```markdown
**Auto-pilot** (scheduled unattended sessions). A pilot is a saved configuration
plus a schedule; each firing starts a *new* session in a configured folder,
sends one stored prompt, runs under a chosen permission mode, and is
force-closed when the work is done. Configured from the header's Auto-pilot
pane (Pilots and Logs tabs); notifications for anything needing a human land in
the bell beside it. A global daily spend cap and a per-pilot failure back-off
(auto-disable after 5 consecutive failures) are the guard rails. On Claude, a
pilot can optionally auto-answer the agent's own `AskUserQuestion` prompts by
taking the recommended option.

Four limitations, by design or by available signal:

- **Pilots do not run while the cockpit is down.** They live and die with the
  process - there is no OS cron registration, deliberately. "Cron" invites the
  opposite assumption, so: closing the cockpit stops every pilot.
- **The spend cap is best-effort.** `costForUsage` returns `null` rather than
  guessing for a model with no pricing entry, so runs on an unpriced model
  contribute nothing to the total and can carry it past the cap. The pane says
  so when it happens.
- **The stall timeout is a runaway backstop, not a hang detector.** Only
  `sdk:message` events advance the progress counter, so a single long tool call
  (a build, a test suite, an `npm install`) looks identical to a hang. The
  default is 60 minutes for that reason; anything shorter force-closes healthy
  runs.
- **Rate-limit back-off is best-effort.** The signal is polled and
  self-clearing, so a short limit window can be missed entirely.

Unattended agents in `acceptEdits` or `bypassPermissions` on a timer means
unsupervised writes to real repositories. Run-now, the run log, the visible
pane and the failure auto-disable are the mitigations; the git-commit-guard
covers only its own narrow case.
```

- [ ] **Step 2: Add the deliberate follow-ups to `backlog.md`**

Append these verbatim, matching the file's existing `- [YYYY-MM-DD] [severity] text` convention:

```markdown
- [2026-09-02] [M] Auto-pilot follow-ups, deliberately out of scope at ship
  time (see `docs/superpowers/specs/2026-09-01-auto-pilot-design.md`):
  (a) per-pilot spend caps alongside the global one - the cap is global because
  one number is enough for a single operator, but two pilots with very
  different budgets have no way to express that;
  (b) a custom Claude spawner (`spawnClaudeCodeProcess`, `sdk.d.ts:2130`) for
  Windows grandchild teardown. **Do not resurrect the revision-1 rationale for
  this** - it claimed the SDK had no exit-time cleanup, which is false (it
  registers its own `process.on('exit')`, and that applies to a custom spawner
  too). The genuine open question is narrower: that handler only does
  `stdin.end()` on win32, not a kill, so a Claude transport *may* survive exit
  on Windows. Confirm that empirically before building anything;
  (c) predictive limit checks, if a structured `/usage` ever exists. The
  current one is unsuitable on purpose: `fetchAccountLimits()` spawns a real
  `claude -p "/usage"` subprocess and returns plain text, and its own module
  comment states it is on-demand and "never polled"
  (`src/account-limits.js:1-34`). Parsing a human-readable table whose format
  is not a contract, on a timer, against a module designed not to be polled, is
  the brittle version;
  (d) a rate-limit transition hook, if the current polled-and-self-clearing
  signal proves too lossy in practice. The fix is a hook, not more polling;
  (e) notifications covering non-pilot sessions - the natural base for the
  MVP7 phone-approvals page above.
```

Then update the existing `app.js` size entry. Get the real number first:

```bash
wc -l public/app.js
```

and append to that entry: `Auto-pilot's UI was added as four new modules (autopilot-panel.js, autopilot-form.js, notifications-panel.js, autopilot-format.js) with only wiring in app.js, so it is now <N> lines - the pattern this entry asks for.`

- [ ] **Step 3: Update `CLAUDE.md`**

Two edits. First, the settings-store count is now wrong. Replace the opening line of that section:

```markdown
**Three separate settings stores, deliberately not unified** (see the boundary comment atop `session-registry.js`):
```

with:

```markdown
**Four separate settings stores, deliberately not unified** (see the boundary comment atop `session-registry.js`):
```

and add this fourth bullet after the existing three:

```markdown
- `~/.prompt-cockpit/` (`operator-auth.js`'s `operator-token`, `autopilot-store.js`'s `autopilots.json`, `autopilot-log.js`'s `autopilot-log.jsonl`, `child-tracker.js`'s `runtime.json`) - the only **cross-project** store. A pilot is defined by the cwd it targets rather than owned by it, so it cannot live under any one project's `.claude/`. All four go through `json-store.js`'s atomic write and corrupt-file refusal, except the append-only JSONL log.
```

Second, add this to the Architecture section, after the "Rewind = fork, not mutate" paragraph:

```markdown
**Auto-pilot is one heartbeat, not one timer per pilot.** `src/autopilot.js`
(`createAutopilot({...})`, the same dependency-injection shape as
`createDelegation()`) evaluates every pilot and every live run on a single ~15s
interval, which is what makes the concurrency cap and the startup stagger
enforceable at all. The concurrency lock is `activeSessionId` on its own
in-memory run state checked against `registry.get()` - *not* a PID, because the
row knows whether a session is running, blocked or idle where a PID only proves
a process exists. Two generic hooks connect it to the registry:
`setSessionRemovedListener` (three separate code paths drop a row, and only one
of them is completion - without a reason, a crash at startup becomes a
15-second spawn loop) and `setApprovalInterceptor` (consulted before the row
push and the broadcast, so the bell never flickers for a question about to be
auto-answered). Both are deliberately ignorant: the registry learns a listener
may exist, never what a pilot is, and the interceptor scopes itself to
pilot-owned rows.

**`src/child-tracker.js` owns Grok and Codex process teardown**, persisted to
`runtime.json` and keyed by process rather than by session (one Codex
app-server backs every Codex session). Claude's transport is the SDK's - see
that module's comment for the Windows caveat on the SDK's own exit handler.
`src/shutdown.js` is the single async teardown every exit route funnels
through; the TTY keypress handler is the only Ctrl-C path a raw-mode terminal
ever sees.
```

Third, apply the same count fix to the boundary comment at the top of `src/session-registry.js` (lines 5-18), which currently opens `Settings-store boundary (three stores exist; this is one of them):`. Change `three stores` to `four stores` and add one sentence naming `~/.prompt-cockpit/` as the cross-project one, so the comment and `CLAUDE.md` agree.

- [ ] **Step 4: Run the full suite one last time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md backlog.md CLAUDE.md src/session-registry.js
git commit -m "docs: record auto-pilot in README, backlog and CLAUDE.md"
```

---

## Done when

- `npm test` passes, including `tests/autopilot-format.test.mjs` and `tests/static-files.test.mjs`.
- Every hand-verification step in Task 2 step 5, Task 3 step 4 and Task 4 step 5 has been performed against a running cockpit, with the results recorded — not assumed.
- Clicking a `needs-input` notification opens the **pilot's** session in a new tab, with no credential anywhere in the URL.
- `public/app.js` grew only by wiring; the four new UI modules own their own `init()`.
- `README.md`, `backlog.md` and `CLAUDE.md` describe what actually shipped, including the four stated limitations.
