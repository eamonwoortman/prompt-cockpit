# Auto-pilot — design

**Date:** 2026-09-01
**Revision:** 2 (revision 1 committed as `d32b9ac`; see "What changed in revision 2")
**Status:** design approved, not implemented
**Scope:** five phases, see Sequencing

## What this is

Auto-pilot fires **new** cockpit sessions on a schedule. It is not `/loop`: nothing
iterates inside a single conversation. Each firing spawns a fresh session in a
configured working directory, sends one stored prompt, runs unattended under a
chosen permission mode, and is force-closed when the work is done.

A pilot is a saved configuration plus a schedule. At most one session per pilot runs
at a time.

## What changed in revision 2

Revision 1 was reviewed against the codebase and three of its claims were wrong.
Recording the superseded decisions so they are not re-litigated:

- **The custom Claude spawner is dropped.** Revision 1 justified it as fixing an
  orphaned-CLI-on-exit bug affecting every session. That premise is false: the SDK
  registers its own `process.on('exit')` cleanup
  (`function oke(e){if(Ip.add(e),!t1)t1=!0,process.on("exit",rke)}` in
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`), invoked on the transport's
  process *after* the spawn branch, so it applies to a custom spawner too. The real
  orphan exposure is Grok and Codex, neither of which has any exit-time teardown.
  Claude keeps the SDK's built-in spawn. `spawnClaudeCodeProcess` remains available
  (`sdk.d.ts:2130`) and is a legitimate future option for Windows grandchild
  teardown, but it is out of scope here and must be re-justified on its own merits.
- **"First cross-project durable store" was wrong.** `~/.prompt-cockpit/operator-token`
  already exists (`src/operator-auth.js:17`). The new files go in that same directory
  rather than opening a second cockpit-owned home dir.
- **"No jsdom, so client modules are hand-verified only" overstated it.**
  `tests/helpers/dom-stub.mjs` exists and four client modules already have unit tests.
  Pure client logic here is unit-tested, not written off.

Also corrected: `multiSelect` is a required field on every `AskUserQuestion` question;
`process.exit(0)` is at `src/server.js:225`; `nextSeq` is at `src/event-log.js:17`.

## Non-goals

- Running pilots while the cockpit process is down. Pilots live and die with it.
- Resuming a pilot's previous conversation. Every firing starts clean.
- Cron expressions. Interval plus an active window only.
- Auto-approving tool permissions or plans. Only explicit questions are auto-answered.
- Per-pilot spend caps. The cap is global.
- A custom Claude process spawner (see above).

## Decisions

1. **In-process Node scheduler**, not OS cron or Task Scheduler. Pilots only run while
   the cockpit runs, consistent with the requirement that closing the cockpit kills
   them. No platform-specific task registration, no operator token in a scheduled-task
   definition, and the schedule is testable with an injected clock.

2. **One stored prompt per pilot**, entered at creation and sent verbatim on every
   firing. It may itself be a slash command.

3. **The stale monitor caps actively-running turns only.** A session blocked on a
   question holds its pilot's lock indefinitely and renders as `needs input`.

4. **The input policy governs `AskUserQuestion` only.** Tool permissions stay governed
   by the pilot's permission mode. End-of-plan approval is not auto-approved.

5. **Interval plus an optional active window**, plus an optional **run-gate command**.
   No cron parser, no new dependency.

6. **The bell holds actionable entries only.** Run history lives in the panel's Logs
   tab.

7. **Claude keeps the SDK's built-in spawn.** PID tracking covers Grok and Codex only.
   (Superseded revision-1 decision; see above.)

8. **The manage UI is a toggleable pane** under the top bar, closed by default, with
   **Pilots** and **Logs** tabs. Create/edit opens a Settings-style modal. The bell is
   a separate small dropdown; the pane has no notifications section.

9. **The spend cap is global across all pilots**, not per pilot.

10. **Rate-limit back-off is reactive**, driven by existing registry state, not a
    pre-flight `/usage` check.

11. **Auto-answering is Claude-only.** `AskUserQuestion` exists nowhere else
    (`src/session.js:273,283` are its only occurrences in `src/`); Grok uses ACP
    permission options (`src/grok-session.js:377-385`) and Codex uses app-server
    approval methods (`src/codex-session.js:150`). The field is provider-gated in the
    form.

## Data model and storage

Three files under `~/.prompt-cockpit/`, alongside the existing `operator-token`.

### `autopilots.json`

```
{
  settings: { dailyCostCapUsd, maxConcurrentRuns },
  pilots: [{
    id, name,                       // name unique across all pilots
    enabled,
    cwd, provider, model, effort, mode,
    prompt,                         // required, sent verbatim each firing
    schedule: {
      everyMinutes,
      window: { fromMinute, toMinute, weekdays: [0-6] } | null
    },
    gate: { command, timeoutMs } | null,
    inputPolicy: 'recommended' | 'ask',   // Claude only
    maxTurnStallMs,
    lastRunAt, lastOutcome, consecutiveFailures
  }]
}
```

`lastRunAt` persists so a short restart does not immediately re-fire everything. It
does **not** prevent a startup stampede — if the cockpit was down longer than a
pilot's interval, which is normal for anything on a 30-minute cadence, every pilot is
overdue at boot. That is handled by `maxConcurrentRuns` and the startup stagger, not
by `lastRunAt`.

### `autopilot-log.jsonl`

Append-only run history backing the Logs tab and the daily spend total:

```
{ ts, pilotId, pilotName, event, sessionId?, reason?, durationMs?, costUsd?,
  costUnpriced?, answered? }
```

`event` is one of `fired | skipped | blocked | finished | timed-out | errored |
closed-externally`. `answered` records auto-answered questions as
`{ question, chosenLabel }`. Rotated past ~2 MB.

**Rotation and the spend cap share this file.** Rotating resets the day's computed
total. At 2 MB this is unlikely within one day, but the rotation routine must carry
forward the current day's running total rather than truncate it away.

### `runtime.json`

PIDs surviving a hard kill, for orphan reaping on next start:

```
[{ pid, provider, osStartedAt, command, pilotIds: [] }]
```

**Keyed by process, not by session** — Codex runs *one* shared app-server for all
Codex sessions (`src/codex-app-server.js:1-3`, ref-counted at `:297-303`), so a
per-session row would either duplicate one PID N times or drop the entry (and kill
every other Codex session) when any one session closes. `pilotIds` is the set of
pilots currently depending on that process; the entry is removed when it empties.

**PID reuse.** A leftover PID may now belong to something unrelated, so the reaper
verifies the recorded start time against the live process — `Get-Process | Select
StartTime` on Windows, `ps -o lstart` elsewhere. Two requirements revision 1 left
under-specified:

- Record the **OS-reported** start time at spawn (`osStartedAt`), not `Date.now()`.
  Comparing a JS millisecond timestamp against a 1-second-granularity `ps` value with
  no tolerance means the reaper always refuses and never reaps anything.
- Compare with a tolerance of a few seconds. If it still cannot confirm, **refuse to
  kill** and log a skipped reap. Logging an orphan beats killing the operator's editor.

**An unreaped orphan blocks its pilots from firing.** Otherwise the two safety
behaviors combine badly: after a crash the in-memory lock is empty and the pilot is
overdue, so it fires immediately, while the reaper correctly declines to kill the
previous run — two unattended agents in one working tree.

### Refactor: extract `src/json-store.js`

`settings-file.js` already contains the atomic-write logic these files need: tmp-file
plus rename including the Windows "cannot rename over an existing file" workaround,
the corrupt-file refusal, and the per-path serialized read-modify-write queue. Extract
it; `settings-file.js` keeps its public API and delegates, so no existing caller
changes.

## Process ownership

### `src/child-tracker.js`

PID registry, `runtime.json` persistence, orphan reaper, and cross-platform tree-kill
generalized from `grok-acp.js:111`. Covers **Grok and Codex only**.

This is where the orphan bug actually is. `killGrokProcess` is called only on session
close (`src/grok-session.js:38,350`, `src/grok-cli.js:57`), and
`src/codex-app-server.js`'s shared process has no exit-time teardown at all. Neither
is in the SDK's exit-cleanup set.

### Shutdown

One async `shutdown()`: stop the heartbeat, close every live session (pilot or not),
tree-kill any tracked PID that outlives its grace period, clear `runtime.json`.

Wiring, with the Windows specifics that revision 1 missed:

- `process.stdin.setRawMode(true)` (`src/server.js:221`) means the OS never delivers
  `SIGINT` — the keypress handler is the only Ctrl-C path. It must `setRawMode(false)`
  first (or it leaves the terminal broken), `await shutdown()`, then exit. It
  currently calls `process.exit(0)` directly (`src/server.js:225`).
- Register `SIGTERM` and `SIGBREAK`; `SIGTERM` is not meaningfully deliverable on
  Windows, `SIGBREAK` is the closer analogue.

## The supervisor

`src/autopilot.js`, built as
`createAutopilot({ registry, store, log, tracker, now, timer })` — the
dependency-injection shape of `createDelegation()` (`src/delegation.js:19`), which is
what makes the schedule testable against an injected clock.

**One heartbeat, not one timer per pilot.** A single ~15 s interval evaluates every
pilot and every live run.

### The concurrency lock is not a PID

`activeSessionId` on the supervisor's in-memory run state, checked against
`registry.get()`. The registry row knows whether a session is *running*, *blocked*, or
*idle*, where a PID only proves a process exists. The PID exists for killing, not
locking.

### Preconditions

Evaluated in order per pilot per heartbeat. Failures are logged with a reason **only
when the pilot was actually due**.

1. `enabled`
2. Due: `now >= lastRunAt + everyMinutes`, and past any failure back-off
3. Inside the active window — weekday set and minute-of-day range, midnight-crossing
   handled explicitly
4. Lock free, and no unreaped orphan for this pilot
5. Provider available (`descriptor.isAvailable()`) and `effort` valid for that
   provider (`src/provider-registry.js:18-20`) — otherwise a Grok pilot on a machine
   without the CLI fires straight into an error
6. Run-gate command exits 0 — spawned in the pilot's cwd with `gate.timeoutMs` and
   `windowsHide: true` (matching `src/grok-acp.js:219-226`); non-zero or timeout skips
   with the stdout tail as the reason
7. Not rate-limited for this pilot's provider
8. Under the global daily spend cap, and under `maxConcurrentRuns`

**A lock-skip does not advance `lastRunAt`**, so the pilot fires on the first
heartbeat after the lock frees. Because the only state is `lastRunAt` rather than a
queue of missed firings, a session that overran five intervals fires **once**.

**Startup stagger.** At most one overdue pilot is fired per heartbeat, and never more
than `maxConcurrentRuns` are live at once (default 2). Without this, a cockpit
restarted after an hour launches every pilot simultaneously.

### Precondition 7 — rate-limit back-off

`row.rateLimitHit` is `{ resetsAt, rateLimitType }`, set on a `rejected` rate-limit
event and also from a second source parsing the CLI's session-limit text
(`src/session-registry.js:833-848`, `:858-868`), normalized to epoch-ms.

**Keyed by provider.** A Claude plan limit says nothing about a Grok or Codex account,
so the back-off applies only to pilots whose `provider` matches the rejected row.

**This signal is best-effort and the spec says so.** `rateLimitHit` is cleared as soon
as any non-`rejected` rate-limit event lands (`src/session-registry.js:843-846`), and
the row vanishes entirely if the session then errors (`:1426`). A 15-second sample can
miss the window. A rate-limited run also typically ends idle-with-a-result, so it logs
as `finished` with near-zero cost — a successful-looking run that did nothing. If this
proves unreliable in practice, the fix is a transition hook, not more polling.

**Why not a pre-flight `/usage` check:** `fetchAccountLimits()` spawns a real
`claude -p "/usage"` subprocess and returns plain text. Its own module comment states
it is on-demand, "never polled", and the worst route in the app to leave open
(`src/account-limits.js:1-34`). Parsing a human-readable table whose format is not a
contract, on a timer, against a module designed not to be polled, is the brittle
version. The run-gate command remains available for custom predictive checks.

### Precondition 8 — global daily spend cap

`settings.dailyCostCapUsd`, summed over today's log entries carrying a `costUsd`.
Reset at local midnight. Shown in the pane header as `$1.24 / $10.00 today`.

- **All cost-bearing events count, not just `finished`.** A `timed-out` run spent real
  money before it was killed.
- **The cap is a precondition only; it never kills a run in flight.** Killing an agent
  mid-edit to save a few cents trades a small cost for a broken working tree.
- **Best-effort:** `costForUsage` returns `null` for an unpriced model
  (`src/usage.js:52`). Such runs contribute nothing and can exceed the cap. The
  accumulator already collects an `unpriced` model set (`src/usage.js:110-114`), so
  flagging it via `costUnpriced` in the log is cheap.

### Firing

Creates the session from the **pilot record's own** model/effort/mode, not the cwd's
persisted `sessionDefaults` — same reasoning as the rewind route passing explicit
defaults (`src/routes/sessions.js:21-27`), since two pilots in one cwd would otherwise
clobber each other.

The row is named after the pilot so `/ask` can address it, falling back to unnamed if
a hand-driven session already holds that name in that cwd; a name collision must not
fail the firing.

`run-now` uses the same path, bypassing preconditions 2 and 3 but honouring 4–8.

### Terminal outcomes

Revision 1's completion model had a hot-refire hole. Rows leave the registry through
**three** paths, only one of which is completion:

- `setState` reaps on `'closed'` or `'error'` — `src/session-registry.js:785`
- `handleError` reaps directly — `src/session-registry.js:1426`
- `closeSession` — `src/session-registry.js:343` (the supervisor's own completion
  path, the `DELETE` route, and the user's "Close session" button)

A supervisor that only tests "is the row gone?" cannot distinguish these. On a crash
or a human close, the completion block never runs, `lastRunAt` is never stamped, and
the pilot is due and lock-free on the very next heartbeat — so a session dying at
startup (missing CLI, bad model, invalid cwd) becomes a 15-second spawn loop.

**Fix: a second generic registry hook.** `setSessionRemovedListener(fn)`, invoked at
all three `sessions.delete(id)` sites with `{ id, reason }` where reason is `'closed'`
or `'error'`. Like the approval interceptor, the registry learns that a listener may
exist, never what a pilot is.

The supervisor then classifies every run:

| Outcome | Trigger | `lastRunAt` | Failure count |
|---|---|---|---|
| `finished` | supervisor closed it after completion | stamped | reset to 0 |
| `timed-out` | supervisor closed it after a stall | stamped | incremented |
| `errored` | removed with reason `'error'` | stamped | incremented |
| `closed-externally` | removed with reason `'closed'`, not by us | stamped | reset to 0 |

A human closing a pilot's session in an attached tab is intentional, not a failure.

**Back-off on repeated failure.** `consecutiveFailures` delays the next firing by
`min(everyMinutes × 2^(n−1), 6h)`. After 5 consecutive failures the pilot is
auto-disabled and raises a bell entry — that is actionable (you must re-enable it), so
it belongs in the tray.

### Completion

Row idle, queue empty, no pending approvals, **and at least one result produced**. The
last clause is load-bearing: a freshly created row is idle before the prompt lands.

The guard is sufficient because the priming sentinel's own `result` is swallowed
inside `session.js` and never reaches the registry (`src/session.js:388-397`), so any
result the registry sees is real. But **no row field counts results** — the supervisor
tracks `sawResult` on its own run state rather than reading four existing row fields.

### Stale detection

Progress is the row's event-log `nextSeq` advancing (`src/event-log.js:17`). It is
monotonic and unaffected by byte-cap eviction (`:30-34`), which makes it the right
counter — but it has a real limitation that must be designed around, not ignored:

**Only `sdk:message` events go through the log** (`src/event-log.js:1-6`,
`src/session-registry.js:869`). A single long tool call — a build, a test suite, an
`npm install` — emits nothing between its `tool_use` and its `tool_result`, so
`nextSeq` freezes while the session is genuinely working. Unattended pilots are
exactly the workload that runs ten-minute commands.

Therefore `maxTurnStallMs` is specified as a **runaway backstop, not a hang detector**,
with a generous default (60 minutes) and form copy that says so. With the signals
available, an in-flight tool call is indistinguishable from a hang; pretending
otherwise would force-close healthy runs. A run blocked on a pending approval is
exempt entirely, logged `blocked` once, and keeps the lock.

### Pilot edited or deleted mid-run

- **Deleted:** the live run is force-closed first, then the record is removed.
- **Edited:** the change applies from the next firing; a run in flight is untouched,
  because its session was already created with the old model/mode and cannot adopt new
  ones coherently.
- Concurrent edits from two tabs are last-write-wins. `json-store` serializes the
  read-modify-write so nothing corrupts, but an edit can be silently lost. Acceptable
  for a single-operator tool.

## Input policy and the approval interceptor

`AskUserQuestion` is deliberately excluded from every auto-allow permission mode
(`src/session.js:272-291`) because passing `input` back unmodified reads as "the user
did not answer" — the `answers` field stays empty. Auto-answering therefore cannot be
a mode change; it must construct a real answer.

### `setApprovalInterceptor(fn)`

Consulted in `handleApprovalRequest` (`src/session-registry.js:1395-1403`) **before**
the row push (`:1398-1400`) and the broadcast (`:1402`), so the bell never flickers for
a question about to be auto-answered. Returns a decision, or `null` to fall through to
today's behavior unchanged.

Two constraints, both verified against the code:

- **It must be synchronous.** `handleApprovalRequest` is called from a sync callback
  and pushes/broadcasts immediately afterwards. This is safe: `session.js` registers
  the `requestId` in its own map (`:288`) *before* invoking the callback (`:289`), so
  an interceptor resolving synchronously finds its entry.
- **It must scope itself to pilot-owned rows.** It is a single process-global hook; an
  unscoped interceptor would silently auto-answer questions in hand-driven sessions.

It cannot double-resolve: `resolveApproval` deletes before resolving
(`src/session.js:650-652`), so a human click racing the interceptor is a no-op
returning `false`.

### `src/autopilot-answer.js`

Pure function. Given an `AskUserQuestionInput` — `questions[]` each with `question`,
`header`, **`multiSelect` (required)**, and `options[]` of
`{ label, description, preview? }` (`sdk-tools.d.ts:855-2431`, `multiSelect` at
`:1015`) — it returns what the cockpit's own client already sends:
`{ questions, answers }` with `answers` keyed by the **exact question text**
(`public/approval-panel.js:184-190`).

Selection rule: the option whose label matches `/\(recommended\)/i`, else
`options[0]`. **For `multiSelect: true` the rule is unchanged** — a single option is
chosen, not all of them. The client joins multiple selections with `', '` (`:188`);
one selection needs no join. Every auto-answer is logged with the question and chosen
label.

### Misconfigurations the form must warn about

1. `default` mode with `inputPolicy: 'recommended'` — still parks on ordinary
   tool-permission prompts, because the mode governs those (Decision 4).
2. A Grok or Codex pilot with `inputPolicy: 'recommended'` — the setting does nothing
   for those providers (Decision 11), so the field is hidden or disabled rather than
   silently ineffective.

## Server surface

`src/routes/autopilot.js`, registered alongside the existing four. Everything under
`/api/` already requires the operator token (`src/server.js:75-78`), so these inherit
process-level auth; operator-gated but not session-token-gated, like `/api/browse`.

```
GET    /api/autopilots             list + live status
POST   /api/autopilots             create
POST   /api/autopilots/:id         update
DELETE /api/autopilots/:id         remove (force-closes a live run first)
POST   /api/autopilots/:id/toggle  enable / disable
POST   /api/autopilots/:id/run-now fire immediately, bypassing schedule + window
GET    /api/autopilots/:id/logs    tail of this pilot's run history
GET    /api/notifications          actionable list
```

`POST` for update because `src/router.js` exposes `get`/`post`/`delete`/`any` only.

One route lives in `src/routes/sessions.js` instead, being session-scoped:

```
GET    /api/sessions/:id/attach-token   pilot-owned sessions only
```

**This is registration-order dependent and needs a code comment.** It matches only
because `registerSessionRoutes` runs before `registerSessionActionRoutes`'s
`any('/api/sessions/:id/:action')` catch-all (`src/server.js:32-35`,
`src/routes/session-actions.js:21`), and the router's first match wins.

### Notifications are derived, never stored

A projection over live state: pilot runs whose row has `pendingApprovals` and whose
policy left the question to a human, plus pilots auto-disabled after repeated
failures. Nothing to persist, nothing to mark read — an entry vanishes when the state
it was computed from is gone.

### Delivery is a poll, not a new socket

Each tab's WebSocket is scoped to the one session it is attached to; a pilot's session
is by definition one it is not attached to. The bell polls `/api/notifications`,
following the "All sessions" pane's 10 s poll
(`public/session-list-pane.js:211-218`).

### The attach flow keeps the token out of the URL

`window.open('/?session=<id>&token=<t>')` would put a credential in a URL — the leak
`backlog.md:27` already flags for `/ws`. Instead the bell opens `/?attach=<sessionId>`
and the new tab fetches the token from `GET /api/sessions/:id/attach-token`.

This is safe for auth because the **operator** token lives in `localStorage`, not
`sessionStorage` (`public/operator-auth.js:6,13,25`), so clearing the inherited
sessionStorage copy does not de-authenticate the new tab.

The endpoint is scoped to pilot-owned sessions. Being straight about why: it is not a
real trust boundary, since anyone holding the operator token can already create
sessions and read everything — per-session tokens are defense-in-depth against a
leaked session *id*. Restricting it is least-privilege housekeeping costing one `if`.

## Frontend

`public/app.js` is 2609 lines and flagged in `backlog.md:76` as over the 2000-line bar,
so none of this lands there. Each module owns its `init()`; `app.js` only wires it,
following the `settings-security-panel.js` precedent.

| Module | Modeled on |
|---|---|
| `public/autopilot-panel.js` | `session-list-pane.js` — fixed overlay, `top` from header height, header-button toggle, interval poll |
| `public/autopilot-form.js` | the Settings modal |
| `public/notifications-panel.js` | small bell dropdown, own poll |
| `public/style-autopilot.css` | new `<link>`, **appended last** in `index.html`'s ordered list (`public/index.html:13-20`) |

Stylesheet position is not pedantry: the CSS split is cascade-ordered, and
`backlog.md:31` records a real bug from an equal-specificity rule landing in the wrong
place.

`index.html` gets `#autopilotBtn` (badged with enabled-pilot count) and
`#notificationsBtn` (badged with actionable count) before `#settingsBtn`.

The form is largely wiring existing pickers: `dir-browser.js` for cwd,
`provider-catalog.js` and `model-picker.js` for provider/model/effort, and
`src/permissions.js` for modes — already shared into the browser via
`SHARED_SRC_FILES` (`src/static-files.js:13`).

### The sessionStorage trap

Per the HTML spec a script-opened same-origin tab receives a **copy** of the opener's
`sessionStorage` — the bug `?newTab=1` exists to work around
(`public/app.js:414-432`). The attach flow must clear the inherited copy *before*
`rejoinActiveSession()` runs, then strip `?attach` with `history.replaceState`.
Otherwise clicking a notification silently reattaches to the opener's session.

## Testing

### Unit (`npm test` — no network, no CLI spawned)

- `autopilot-schedule` — due-ness; midnight-crossing windows; weekday sets; a
  lock-skip **not** advancing `lastRunAt`; a five-interval overrun firing **once**;
  the startup stagger and `maxConcurrentRuns`
- `autopilot-answer` — `(Recommended)` matching, case-insensitivity, fallback to
  `options[0]`, `multiSelect: true` still choosing a single option, multi-question,
  `answers` keyed by exact question text
- `autopilot-store` / `autopilot-log` — CRUD, unique names, corrupt-file refusal,
  rotation carrying the day's total forward, the local-midnight sum including
  cost-bearing non-`finished` events
- `child-tracker` — `runtime.json` lifecycle, Codex's shared-process ref-counting,
  orphan detection, start-time tolerance, and that it **refuses to kill when
  unverifiable**
- `json-store` — the extracted helper, with every existing `settings-file` test
  passing unchanged
- `autopilot` — the supervisor against an injected clock and a fake registry: the full
  precondition chain; all four terminal outcomes and their differing effect on
  `lastRunAt` and `consecutiveFailures`; the failure back-off and auto-disable; the
  completion guard; blocked-exempt; provider-keyed rate-limit back-off; the spend cap
- `autopilot-routes` — routes plus operator-token 401s, following
  `server-auth.test.mjs`

### Client unit tests

Pure logic in the new panels — schedule summary formatting, next-run computation, the
notification projection — is unit-tested using `tests/helpers/dom-stub.mjs`, following
`tests/turn-chart.test.mjs`, `ask-picker.test.mjs`, `provider-catalog.test.mjs` and
`markdown.test.mjs` (`tests/README.md:105-110`). Only genuine DOM/interaction behavior
is hand-verified.

### Manual

`tests/grok-live.manual.mjs` and a Codex equivalent must be re-run after the
`child-tracker` work, since it touches their spawn/teardown paths.
`tests/integration.manual.mjs` is **not** affected — Claude's spawn is unchanged.

## Sequencing

Five phases, each independently mergeable, riskiest dependencies resolved earliest.

1. **`json-store.js` extraction.** Pure refactor, zero behavior change, every existing
   `settings-file` test passes unchanged.
2. **Shutdown + `child-tracker` (Grok and Codex).** Where the orphan bug actually is.
   `SIGINT`/`SIGBREAK`/`SIGTERM`, the TTY handler rerouted through async `shutdown()`
   with `setRawMode(false)`, tree-kill generalized from `grok-acp.js:111`, Codex's
   shared-process model. Ships a real fix with no auto-pilot dependency.
3. **Store, log, and supervisor — headless.** `autopilot-store`, `autopilot-log`,
   `autopilot`, `routes/autopilot`, plus `setSessionRemovedListener`. Driven via
   `run-now` and `curl` with the operator token; no UI. All lifecycle semantics settle
   and get unit-tested here, before any UI exists to hide them.
4. **Approval interceptor + `autopilot-answer`.** Claude-only, provider-gated.
   Small and independently testable.
5. **UI: panel, form, bell, attach flow.** Depends on nothing above being re-opened.

## Risks and limitations

1. **Unattended agents in `acceptEdits`/`bypassPermissions` on a timer** means
   unsupervised writes to real repositories. `run-now`, the run log, the visible pane,
   and the failure auto-disable are the mitigations; the git-commit-guard covers only
   its narrow case.
2. **The run-gate command executes arbitrary shell from a config file on a schedule.**
   Precedented by Claude Code's own `hooks` key, but stated plainly.
3. **PID reuse**, mitigated by refuse-to-kill-if-unverifiable — which in turn requires
   the orphan-blocks-firing rule, or the two mitigations combine into two agents in one
   repo.
4. **The spend cap is best-effort**, because unpriced models report `null` cost.
5. **`maxTurnStallMs` cannot distinguish a long tool call from a hang.** It is a
   runaway backstop only.
6. **Rate-limit back-off is best-effort**, because the signal is polled and
   self-clearing.
7. **Pilots do not run when the cockpit is down** — by design, but worth saying, since
   "cron" invites the opposite assumption.

## Follow-ups, deliberately out of scope

- Per-pilot spend caps alongside the global one.
- A custom Claude spawner for Windows grandchild teardown, re-justified on its own
  merits.
- Predictive limit checks, if a structured `/usage` ever exists.
- A rate-limit transition hook, if polling proves too lossy.
- Notifications covering non-pilot sessions — the natural base for the MVP7
  phone-approvals page in `backlog.md`.
