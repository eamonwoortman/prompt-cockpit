# Auto-pilot — design

**Date:** 2026-09-01
**Status:** design approved, not implemented
**Scope:** one feature, one implementation plan

## What this is

Auto-pilot fires **new** cockpit sessions on a schedule. It is not `/loop`: nothing
iterates inside a single conversation. Each firing spawns a fresh session in a
configured working directory, sends one stored prompt, runs unattended under a
chosen permission mode, and is force-closed when the work is done.

A pilot is a saved configuration plus a schedule. At most one session per pilot runs
at a time, and the cockpit owns the underlying CLI process so that closing the
cockpit does not leave agents running.

## Non-goals

- Running pilots while the cockpit process is down. Pilots live and die with it.
- Resuming a pilot's previous conversation. Every firing starts clean.
- Cron expressions. Interval plus an active window only.
- Auto-approving tool permissions or plans. Only explicit questions are auto-answered.
- Per-pilot spend caps. The cap is global (see Decision 9).

## Decisions

Each of these was settled during design; the rationale matters because several
close off paths that look obvious later.

1. **In-process Node scheduler**, not OS cron or Task Scheduler. Pilots only run
   while the cockpit runs, which is consistent with the requirement that closing the
   cockpit kills them. No platform-specific task registration, no operator token
   living in a scheduled-task definition, and the schedule is testable with an
   injected clock.

2. **One stored prompt per pilot**, entered when the pilot is created and sent
   verbatim on every firing. It may itself be a slash command. The transcript of each
   run is the record of what happened.

3. **The stale monitor caps actively-running turns only.** A session blocked on a
   question is a state the operator asked for, so it holds its pilot's lock
   indefinitely and renders as `needs input`. Nothing silently dies; nothing
   silently stops either, because the block is visible in the panel and in the bell.

4. **The input policy governs `AskUserQuestion` only.** Tool permissions stay
   governed by the pilot's permission mode, exactly as for a hand-driven session. This
   keeps one meaning per setting instead of two settings that both mean "don't ask me
   about tools". End-of-plan approval is deliberately not auto-approved.

5. **Interval plus an optional active window** (time-of-day range and weekday set),
   plus an optional **run-gate command** for arbitrary preconditions. No cron parser,
   no new dependency.

6. **The bell holds actionable entries only.** Per-pilot run history lives in the
   panel's Logs tab. A non-zero bell badge always means something is waiting on a
   human.

7. **The custom spawner is used for every Claude session**, not only pilot-spawned
   ones. It fixes the orphaned-CLI-on-exit bug across the board rather than for
   pilots alone. The cost is stated in Testing.

8. **The manage UI is a toggleable pane** under the top bar (closed by default),
   with **Pilots** and **Logs** tabs. Creating and editing a pilot opens a
   Settings-style modal. The bell is a separate small dropdown; the pane has no
   notifications section, to avoid two surfaces for one thing.

9. **The spend cap is global across all pilots**, not per pilot.

10. **Rate-limit back-off is reactive, driven by existing state** — not a
    pre-flight `/usage` check. See Preconditions.

## Data model and storage

Auto-pilot introduces the codebase's first **cross-project durable store**. The
existing per-cwd `.claude/settings.local.json` pattern cannot be reused: the
supervisor must enumerate every pilot at startup, and a per-cwd store is only
reachable once the cwd is already known.

Three files under `~/.claude/prompt-cockpit/`, consistent with the cockpit already
reading `~/.claude/projects` (`src/session-launcher.js`).

### `autopilots.json`

```
{
  settings: { dailyCostCapUsd },
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
    inputPolicy: 'recommended' | 'ask',
    maxTurnStallMs,
    lastRunAt, lastOutcome
  }]
}
```

`lastRunAt` persists deliberately. On restart the supervisor computes
`nextRunAt = lastRunAt + everyMinutes`, so a restart does not fire every pilot at
once — which is what a purely in-memory schedule would do.

### `autopilot-log.jsonl`

Append-only run history backing the Logs tab and the daily spend total. One line per
event:

```
{ ts, pilotId, pilotName, event, sessionId?, reason?, durationMs?, costUsd?, answered? }
```

`event` is one of `fired | skipped | blocked | finished | timed-out | errored`.
`answered` records auto-answered questions as `{ question, chosenLabel }` pairs, so
the log shows what was decided on the operator's behalf. Rotated past ~2 MB; the
Logs tab reads the tail.

### `runtime.json`

Live PIDs, for the hard-kill case only:

```
[{ pilotId, sessionId, pid, startedAt, command }]
```

Written at spawn, entry dropped on clean session close, whole file cleared on
graceful shutdown. Anything surviving a crash is an orphan candidate on next start.

**PID reuse is a real hazard here.** A leftover PID from a previous boot may now
belong to an unrelated process. The reaper must verify the live process's actual
start time matches the record before killing — `Get-Process | Select StartTime` on
Windows, `ps -o lstart` elsewhere. If it cannot confirm, it **must refuse to kill**
and log a skipped reap. Logging an orphan is strictly better than killing the
operator's editor.

### Refactor: extract `src/json-store.js`

`settings-file.js` already contains the atomic-write logic these files need: the
tmp-file-plus-rename dance including the Windows "cannot rename over an existing
file" workaround, the corrupt-file refusal, and the per-path serialized
read-modify-write queue. That is non-obvious, hard-won code and must not exist
twice. Extract it into `src/json-store.js`; `settings-file.js` keeps its current
public API and delegates, so no existing caller changes.

## Process ownership and the PID lifecycle

### Spike result

The requirement "store its PID so we can kill it" had no foundation in the codebase:
`session.js` drives Claude through the SDK's `query()` and never touches a child
process. A spike against the installed `@anthropic-ai/claude-agent-sdk@0.3.231`
resolved it.

**Confirmed** from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

- `query()` accepts `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`
  (line 2130), documented for running Claude Code "in VMs, containers, or remote
  environments".
- `SpawnOptions` is `{ command, args, cwd?, env, signal }` (line 7113).
- Node's `ChildProcess` already satisfies `SpawnedProcess` (line 7059).

So the cockpit does not have to extract a PID — it can own the spawn. Claude reaches
parity with Grok (`connection.proc`, `src/grok-session.js`) and Codex
(`src/codex-app-server.js`), and `grok-acp.js`'s existing tree-killer is directly
reusable.

### `src/claude-spawn.js`

Roughly: `spawn(command, args, { cwd, env, signal })`, register `child.pid` with the
tracker, return the child. Three details from the same SDK docs must not be lost:

1. The default spawn **checks the executable exists before spawning** (sdk.d.ts:2115).
   Ours must too, or a missing `claude` on PATH degrades from a clear message to a
   raw `ENOENT`.
2. The built-in spawn **delays its `'exit'` event until the child's stderr closes**
   so exit errors carry a stderr tail; custom spawners "emit plain process exit"
   (sdk.d.ts:7085). Since we own the returned object, buffer stderr and delay our own
   `'exit'` to preserve this. This is a thing to not forget, not a regression to
   accept.
3. `signal` is safe to forward to `spawn()`: it fires only after the SDK's stdin-EOF
   plus ~2 s grace (sdk.d.ts:7124), so the CLI still gets its graceful shutdown.

**Not yet verified live.** The above is confirmed at the API and type level only.
`tests/autopilot.manual.mjs` covers the live half.

### `src/child-tracker.js`

PID registry, `runtime.json` persistence, orphan reaper, and cross-platform tree-kill
generalized from `grok-acp.js`. Provider-agnostic: it tracks Claude, Grok, and Codex
children alike, because orphan cleanup was never a pilot-specific problem.

### Shutdown

One `shutdown()`: stop the heartbeat, close every live session (pilot or not),
tree-kill any tracked PID that outlives its grace period, clear `runtime.json`.
Wired to `SIGINT` and `SIGTERM`. The TTY Ctrl-C handler stops calling
`process.exit(0)` directly (`src/server.js:216`) and routes through it.

There is no shutdown handling in the codebase today — `grep` for
`SIGINT|SIGTERM|process.on` across `src/` returns nothing. Every session's CLI child
is orphaned on exit right now, pilot or not. This fixes a pre-existing bug.

## The supervisor

`src/autopilot.js`, built as `createAutopilot({ registry, store, log, tracker, now, timer })`
— the dependency-injection shape of `createDelegation()` (`src/delegation.js:19`),
which is also what makes the schedule testable against an injected clock instead of
real sleeps.

**One heartbeat, not one timer per pilot.** A single ~15 s interval evaluates every
pilot and every live run. Restart behavior, clock skew, the stale monitor, and pilot
deletion all collapse into one code path with no per-pilot timer to leak.

### The concurrency lock is not a PID

"Do not fire while the previous firing is still running" is answered by
`activeSessionId` on the supervisor's in-memory pilot state, checked against
`registry.get(activeSessionId)`. This is strictly better than a PID as a lock: the
registry row knows whether the session is *running*, *blocked on a question*, or
*idle*, where a live PID only proves a process exists. The PID exists for killing,
not for locking.

### Preconditions

Evaluated in order for each pilot on each heartbeat. A failure is logged with a
reason **only when the pilot was actually due**, so a disabled or not-yet-due pilot
does not spam the log every tick.

1. `enabled`
2. Due: `now >= lastRunAt + everyMinutes`
3. Inside the active window — weekday set and minute-of-day range, with
   midnight-crossing windows handled explicitly
4. Lock free: `activeSessionId` is null, or its row is gone from the registry
5. Run-gate command exits 0 — spawned in the pilot's cwd with `gate.timeoutMs`;
   non-zero or timeout skips the firing, with the stdout tail as the logged reason
6. Not rate-limited (below)
7. Under the global daily spend cap (below)

**A lock-skip deliberately does not advance `lastRunAt`.** That is what "wait for the
existing one to finish" has to mean: the pilot fires on the first heartbeat after the
lock frees, not a full interval later. And because the only state is `lastRunAt`
rather than a queue of missed firings, a session that overran five intervals fires
**once**, not five times.

### Precondition 6 — rate-limit back-off

Reactive, using state the registry already maintains. `row.rateLimitHit` is
`{ resetsAt, rateLimitType }`, set when a `rejected` rate-limit event lands and also
from a second independent source that parses the CLI's own session-limit text
(`src/session-registry.js:833-863`). `resetsAt` is normalized to epoch-ms.

An account limit is not project-scoped, so when a pilot run is rejected the supervisor
lifts that row's `resetsAt` into a `limitedUntil` and every pilot skips until it
passes — logged as `skipped: session limit, retry 14:20`, carrying `rateLimitType` so
session-versus-weekly is visible in the Logs tab.

**`limitedUntil` is keyed by provider, not global.** A Claude plan limit says nothing
about a Grok or Codex account, so blocking every pilot on one provider's limit would
stall pilots that could run perfectly well. The back-off applies only to pilots whose
`provider` matches the row that was rejected.

**Why not a pre-flight `/usage` check:** `account-limits.js`'s `fetchAccountLimits()`
spawns a real `claude -p "/usage"` subprocess and returns the CLI's **plain-text**
table. Its own module comment states it is on-demand and "never polled", and calls it
the worst route in the app to leave open precisely because every call spawns a
process. Parsing a human-readable table whose format is not a contract, on a timer,
against a module explicitly designed not to be polled, is the brittle version. The
run-gate command remains available for operators who want a custom predictive check.

### Precondition 7 — global daily spend cap

`settings.dailyCostCapUsd`, one ceiling across all pilots. The daily total needs no
new store: it is a sum over today's log entries in `autopilot-log.jsonl` that carry a
`costUsd`. Reset is local midnight, not a rolling window. Shown in the pane header as
`$1.24 / $10.00 today`.

Two points that would otherwise be read either way:

- **All cost-bearing events count, not just `finished`.** A `timed-out` run spent real
  money before it was killed. Summing only successful runs would undercount exactly
  the failure mode most likely to be expensive.
- **The cap is a precondition only. It never kills a run in flight.** Exceeding it
  stops the *next* firing; a session already working is left to finish, because
  killing an agent mid-edit to save a few cents trades a small cost for a possibly
  broken working tree.

**Limitation, stated rather than hidden:** `costForUsage` returns `null` rather than a
guess for an unpriced model (`src/usage.js`). A pilot running an unpriced model
contributes nothing to the total and can run past the cap. The cap is best-effort. A
run whose cost came back `null` is flagged in the log rather than silently counted as
zero.

### Firing

Creates the session from the **pilot record's own** model/effort/mode — not the cwd's
persisted `sessionDefaults`. Same reasoning as the rewind route passing explicit
defaults rather than reading the shared store (`src/routes/sessions.js:26-38`): two
pilots in one cwd would otherwise clobber each other, since the persisted store
reflects whichever wrote most recently.

The row is named after the pilot so `/ask` can address it, falling back to unnamed if
a hand-driven session already holds that name in that cwd — a name collision must not
fail the firing. Then: `sendInput(id, prompt)`, register the PID, write the
`runtime.json` entry, log `fired`, set `activeSessionId`.

`run-now` (below) uses the same path, bypassing preconditions 2 and 3 but still
honouring 4 through 7, and logs its `fired` event marked manual.

### Completion

A run is complete when its row is idle, its queue is empty, it has no pending
approvals, **and it has produced at least one result**. That last clause is
load-bearing: a freshly created row is idle before the prompt lands and would
otherwise read as instantly complete.

Then: log `finished` with duration and cost, call the existing
`registry.closeSession(id)` (already the teardown used by the `DELETE
/api/sessions/:id` route), drop the runtime entry, clear the lock, stamp `lastRunAt`
and `lastOutcome`.

### Stale detection

Progress is the row's event-log `nextSeq` advancing (`src/event-log.js:18`). A
non-idle run whose `nextSeq` has not moved for `maxTurnStallMs` is force-closed and
logged `timed-out`.

A run blocked on a pending approval is **exempt** (Decision 3): logged `blocked`
once, and it keeps the lock.

## Input policy and the approval interceptor

`AskUserQuestion` is deliberately excluded from every auto-allow permission mode
(`src/session.js:272-290`) because passing `input` back unmodified reads to the tool
as "the user did not answer" — its `answers` field stays empty. So auto-answering
cannot be a permission-mode change; it must construct a real answer.

### One new registry hook

`setApprovalInterceptor(fn)`, consulted in the existing approval path
(`src/session-registry.js:1398`) **before** the row push and the broadcast, so the
bell never flickers for a question that is about to be auto-answered. It returns a
decision to auto-resolve, or `null` to fall through to today's behavior unchanged.

The registry learns that an interceptor may exist; it never learns what a pilot is.
Pilot semantics stay in `src/autopilot.js`, matching how `delegation.js` was split
out of the registry.

### `src/autopilot-answer.js`

A pure function. Given an `AskUserQuestionInput` — `questions[]` each with
`question`, `header`, `options[]` of `{ label, description, preview? }`
(`sdk-tools.d.ts:855-935`) — it returns the payload the cockpit's own client already
sends: `{ questions, answers }` with `answers` keyed by the **exact question text**
and valued by the chosen label (`public/approval-panel.js:184-190`). Reusing that
shape matters: it is already proven against the real tool.

Selection rule per question: the option whose label matches `/\(recommended\)/i`,
else `options[0]`. Every auto-answer is written to the run log with the question and
the chosen label.

### The misconfiguration this leaves open

A pilot in `default` mode with `inputPolicy: 'recommended'` still parks on ordinary
tool-permission prompts, because per Decision 4 the mode governs those. The setup
modal must warn on this combination rather than silently absorb it.

## Server surface

One new route module, `src/routes/autopilot.js`, registered alongside the existing
four. Everything under `/api/` already requires the operator token
(`src/server.js:73-78`), so these inherit process-level auth with no new machinery;
they are operator-gated but not session-token-gated, same as `/api/browse` and
`/api/resumable`.

```
GET    /api/autopilots             list + live status (nextRunAt, lock holder, lastOutcome, blocked?)
POST   /api/autopilots             create
POST   /api/autopilots/:id         update
DELETE /api/autopilots/:id         remove (force-closes a live run first)
POST   /api/autopilots/:id/toggle  enable / disable
POST   /api/autopilots/:id/run-now fire immediately, bypassing schedule + window
GET    /api/autopilots/:id/logs    tail of this pilot's run history
GET    /api/notifications          actionable "needs input" list
```

One further route lives in `src/routes/sessions.js`, not here, since it is scoped to a
session rather than a pilot:

```
GET    /api/sessions/:id/attach-token   pilot-owned sessions only
```

`run-now` is not a luxury: without it, verifying a freshly configured pilot means
waiting out an interval.

`POST` is used for update because `src/router.js` exposes `get`/`post`/`delete`/`any`
only.

### Notifications are derived, never stored

The bell list is a projection over live state: pilot runs whose row has
`pendingApprovals` and whose policy left the question for a human. Nothing to
persist, nothing to mark read, nothing to go stale — an entry vanishes on its own
when the approval resolves, because the state it was computed from is gone. This is
why "in-memory only" is correct rather than a shortcut: there is no store to keep in
sync.

### Delivery is a poll, not a new socket

Each tab's WebSocket is scoped to the one session it is attached to (`/ws?id&token`),
and a pilot's session is by definition one it is not attached to. Rather than add a
second session-less operator socket, the bell polls `/api/notifications`. The "All
sessions" pane already establishes this precedent with a 10 s poll
(`public/session-list-pane.js:211`). For something that has been waiting on a human
for minutes, 10 s of latency costs nothing.

### The attach flow keeps the token out of the URL

`window.open('/?session=<id>&token=<t>')` would put a credential in a URL — the exact
leak `backlog.md` already flags for the `/ws` query string. Instead the bell opens
`/?attach=<sessionId>` and the new tab fetches the token itself from
`GET /api/sessions/:id/attach-token`. No secret enters a URL, history entry, or
referrer.

That endpoint is scoped to pilot-owned sessions. Being straight about why: it is not
a real trust boundary, because anyone holding the operator token can already create
sessions and read everything — per-session tokens are defense-in-depth against a
leaked session *id*, not a layer above the operator credential. Restricting it is
least-privilege housekeeping that costs one `if`.

## Frontend

`public/app.js` is already 2609 lines and flagged in `backlog.md` as over the
2000-line bar, so none of this lands there. Each module owns its `init()` and
`app.js` only wires it, following the `settings-security-panel.js` precedent the
backlog names.

| Module | Modeled on |
|---|---|
| `public/autopilot-panel.js` | `session-list-pane.js` — fixed overlay, `top` from header height, header-button toggle, interval poll |
| `public/autopilot-form.js` | the Settings modal — new/edit pilot |
| `public/notifications-panel.js` | small bell dropdown, own poll of `/api/notifications` |
| `public/style-autopilot.css` | new `<link>`, **appended last** in `index.html`'s ordered list |

The stylesheet position is not pedantry: the CSS split is cascade-ordered by design,
and `backlog.md` records a real bug from an equal-specificity rule landing in the
wrong position — a `prefers-reduced-motion` override that silently never applied.

`index.html` gets two buttons before `#settingsBtn`: `#autopilotBtn` (badged with the
enabled-pilot count) and `#notificationsBtn` (badged with actionable count only),
plus the pane and modal containers.

### The pane

Closed by default; toggles from `#autopilotBtn`. Two tabs, **Pilots** and **Logs** —
no notifications section, since the bell is the single surface for that. Each pilot
row shows an enable toggle, name, schedule, next run, status, and
`Run now · Edit · ✕`. A blocked pilot's row shows `needs input` as *status*; acting on
it happens through the bell.

Header shows the global spend total against the cap.

### The form

Largely wiring existing pickers into a new container: the cwd field reuses
`dir-browser.js`'s browse modal, provider/model/effort reuse `provider-catalog.js`
and `model-picker.js`, and the permission-mode list comes from `src/permissions.js`,
already shared verbatim into the browser via `SHARED_SRC_FILES`
(`src/static-files.js`). Advanced section holds the run-gate command, its timeout,
and the stall cap. The mode/policy mismatch warning from Decision 4 lives here.

### One trap already documented in this codebase

Per the HTML spec, a script-opened same-origin tab receives a **copy** of the
opener's `sessionStorage`, not an empty one — the bug the `?newTab=1` marker exists
to work around (`public/app.js:414-431`). The attach flow must therefore clear the
inherited copy *before* `rejoinActiveSession()` runs, then strip `?attach` with
`history.replaceState`. Without that, clicking a notification silently reattaches the
new tab to whatever session the opener had, not the pilot's.

## Testing

### Unit (`npm test` — no network, no CLI spawned)

- `autopilot-schedule` — due-ness; active windows including midnight-crossing;
  weekday sets; a lock-skip **not** advancing `lastRunAt`; a five-interval overrun
  firing **once**
- `autopilot-answer` — `(Recommended)` matching, case-insensitivity, fallback to
  `options[0]`, multi-question, `answers` keyed by exact question text
- `autopilot-store` / `autopilot-log` — CRUD, unique names, corrupt-file refusal,
  rotation, the local-midnight daily total
- `child-tracker` — `runtime.json` lifecycle, orphan detection, and specifically that
  it **refuses to kill when start time is unverifiable**
- `json-store` — the extracted helper, with every existing `settings-file` test still
  passing unchanged
- `autopilot` — the supervisor against an injected clock and a fake registry: the full
  precondition chain, the "idle before the prompt lands" completion guard, stall
  timeout, blocked-exempt, rate-limit back-off, spend cap
- `autopilot-routes` — routes plus operator-token 401s, following
  `server-auth.test.mjs`

### Hand-verified only

The three client modules, the pane and modal, and the attach flow — per this
project's established convention for `public/*.js`, which has no jsdom harness.
`tests/README.md` gets its feature-by-feature entry, since that file is the contract
for what is covered and why.

### Manual

- `tests/autopilot.manual.mjs` (new) — the live half of the spawner spike: the PID is
  actually captured, tree-kill works, a missing `claude` still produces a good error,
  and the stderr tail survives on exit.
- `tests/integration.manual.mjs` (existing) — **must be re-run**, because every
  Claude session now goes through the new spawner.

### The headline risk

`npm test` never spawns a CLI, so **no unit test can catch a spawner regression** —
only the manual suites can, and they cost real money. That is the price of Decision 7
and it belongs in front of whoever implements this.

## File inventory

**New (12 source + 1 spec):** `src/json-store.js`, `src/child-tracker.js`,
`src/claude-spawn.js`, `src/autopilot.js`, `src/autopilot-store.js`,
`src/autopilot-log.js`, `src/autopilot-answer.js`, `src/routes/autopilot.js`,
`public/autopilot-panel.js`, `public/autopilot-form.js`,
`public/notifications-panel.js`, `public/style-autopilot.css`.

**Modified (7):** `src/session.js` (the `spawnClaudeCodeProcess` option),
`src/session-registry.js` (`setApprovalInterceptor`), `src/server.js` (route
registration, shutdown, Ctrl-C reroute), `src/settings-file.js` (delegates to
`json-store`), `src/routes/sessions.js` (attach-token), `public/index.html`,
`public/app.js` (wiring only).

**Docs:** `tests/README.md`, `backlog.md`, `README.md` status, and `CLAUDE.md` — which
needs an auto-pilot paragraph and is already drifted enough to have an open `[L]`
backlog item.

## Risks and limitations

1. **The spawner sits in every Claude session's startup path.** A bug there breaks
   all sessions, not just pilots, and unit tests cannot catch it. Mitigated by
   replicating the exists-check and the stderr-delayed `'exit'`, and by re-running the
   manual suites.
2. **Unattended agents in `acceptEdits`/`bypassPermissions` on a timer** means
   unsupervised writes to real repositories. `run-now`, the run log, and the visible
   pane are the mitigations; the git-commit-guard covers only its narrow case.
3. **The run-gate command executes arbitrary shell from a config file on a
   schedule.** Precedented by Claude Code's own `hooks` key in the same settings
   family, but stated plainly rather than left implicit.
4. **PID reuse**, mitigated by refuse-to-kill-if-unverifiable.
5. **The spend cap is best-effort**, because unpriced models report `null` cost.
6. **Pilots do not run when the cockpit is down** — by design (Decision 1), but worth
   saying out loud, since "cron" invites the opposite assumption.

## Follow-ups, deliberately out of scope

- Per-pilot spend caps, in addition to the global one.
- Predictive limit checks (a structured `/usage`, if one ever exists — the current
  text output is not a contract).
- Notifications covering non-pilot sessions, which is the natural base for the
  MVP7 phone-approvals page in `backlog.md`.
- Auto-approving end-of-plan for pilots deliberately left in plan mode.
