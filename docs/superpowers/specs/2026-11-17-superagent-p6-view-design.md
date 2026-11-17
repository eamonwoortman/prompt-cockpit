# Superagent Plan 6 — the Superagent view, server wiring and notifications

_2026-11-17 · branch `feature/superagent` @ `da8d6e5` · builds on [the superagent design, rev 3](2026-11-03-superagent-design.md) and [Plan 5](2026-11-06-superagent-p5-brainstorm-design.md)_

Labels: **[Decided]** = decided by the user in the 2026-11-17 brainstorm. **[Author's call]** = chosen by the design author; the user may override. Unlabelled = consequence of the two, or already in rev 3. Where this document and rev 3 disagree, this document wins for Plan 6.

## Intent

Plans 1-5 built the superagent as a library. Nothing can start a job, see it, or answer it except a script. The user wants to start a job from Cockpit, leave it, and be pulled back only when it needs them: a question to answer, a result to try, or a job that is stuck. When pulled back, they want to see where the job stands and act on it in one place.

This plan delivers that for the backend that exists today. Controls whose backend belongs to a later plan are left out, not stubbed, and each is recorded below so it is built later. **[Decided]**

## Goals

1. **Server wiring.** `src/server.js` creates the superagent supervisor at boot, starts it, and stops it on Cockpit's single shutdown path. Unfinished jobs carry on after a restart (rev 3 "Restart and recovery").
2. **A Superagent tab** at `/?view=superagent`, opened from a **Superagent** button in the top bar, with rev 3's three-pane layout cut to the backend that exists (see "The view").
3. **Needs-you actions:** answer a question (`answerQuestion`), accept a ready-to-try job (`accept`), stop a job (`stopJob`).
4. **Notifications:** superagent entries in the bell, a red badge on the Superagent button, and browser notifications for new entries. Three types only: ready to try, question, stuck (rev 3 Decision 16).
5. **Watch-only worker sessions.** Each attempt with a live session has an **open** link that shows its transcript in a new tab. The user cannot type into it, approve anything in it, or otherwise change it. **[Decided]**

## Non-goals (for Plan 6) — and where each one goes

The user asked that none of these is dropped. Each row is a control from rev 3's view or notifications section with no backend yet. Each is also listed in `backlog.md` under a new "Superagent — planned for later plans" section, so it is visible outside the spec folder. **[Decided]**

| Missing piece | Why it is not in Plan 6 | Later plan (rev 3 "Suggested sequencing") |
|---|---|---|
| Pause / Resume (job-level) | No pause state or API in the supervisor | Usage-cap pause/resume, budgets and ledger (step 5) |
| Spend so far (per job, per router) and budget override on the New job form | No usage ledger or budget check yet (`budgetCheck` defaults to allow) | Same (step 5) |
| Answering a budget question ("extend budget") | Budget questions are not answerable (`answerQuestion` refuses `detail.kind: 'budget'`) | Same (step 5) |
| Give feedback (on a ready-to-try job) | No triage worker | Feedback triage and sub-plans (step 6) |
| Retry on a stuck job | `stuck` is terminal; no resume API | Feedback/resume plan (step 6) |
| Manual mode on the New job form, and **Hand over** | `createJob` refuses `mode: 'manual'` (`ERR_MODE_UNSUPPORTED`) | Manual-mode handover (rev 3 step 4, deferred by Plan 5) |
| Router-written notification text (≤ 40 words) | Not built (CLAUDE.md, superagent paragraph) | A later router plan; Plan 6 uses code-generated text, which rev 3 already names as the fallback |
| Settings modal (pipeline, model matrix, limits, budget, permission mode) | Out of scope by the user's choice; `createSuperagentConfig().save` already exists | A later view plan |
| "Offer `git init`" for a folder that is not a git repo (rev 3 Decision 10) | No backend; `createJob` fails with `ERR_NOT_GIT_REPO` / `ERR_NO_COMMITS` | A later view plan; Plan 6 checks folders before the job exists and shows the error inline |
| Read-only superagent view in a second Cockpit (one that does not own the superagent folder) | The store has no reload-from-disk path; the user chose a single owner (option A) | A later view plan |
| Stepping into a worker session (rev 3: "open … to watch or step in") | The user chose watch-only for now: input would become part of the attempt the code then judges | Revisit with Give feedback / Retry (step 6) |
| Base verifier evidence dropped from complete-phase verification after an extra round (Plan 5 final review) | A sequencer correctness gap, not UI | Next backend plan; logged in `backlog.md` **[Author's call]** |

Also not in Plan 6: real-model probe runs (the user deferred probing until every plan is done), non-Claude providers.

## Anti-goals

- **A noisy tab or bell.** Phase changes, review rounds, retries and router decisions never notify (rev 3 Decision 16). Only a job entering `needs-you` creates an entry.
- **Duplicate browser notifications.** With several Cockpit tabs open, one new entry must produce one browser notification, not one per tab.
- **The user's input leaking into an attempt.** Watch-only must be enforced by the server, not only by a disabled box in the browser.
- **Dead buttons.** No greyed-out controls for features that do not exist.

## Approach

Three approaches were considered. The user picked 1. **[Decided]**

1. **Follow auto-pilot's pattern** (picked). `public/app.js` sees `?view=superagent` and mounts a new `public/superagent-view.js` in place of the transcript UI. The view polls a new `src/routes/superagent.js`. A new `src/superagent-wiring.js` composes boot and shutdown like `src/autopilot-wiring.js`. The bell and badge keep polling `/api/notifications` every 10 s from every tab. Reuses operator auth, the folder browser (`dir-browser.js`), the attach flow and the CSS. Cost: a few seconds of lag in the view.
2. **A separate page** (`superagent.html`) with its own entry module. Rejected: re-wires auth, folder browser and styles, and the project already moved away from the `agent-view.html` pop-out pattern.
3. **Live push** (server-sent events fed by the store's appends). Rejected: a second live channel the server does not have today, for little gain when a phase takes minutes.

## Design

### Server wiring

- `src/server.js` builds the superagent with its real store (`createSuperagentStore()`), config (`createSuperagentConfig()`) and the shared registry. `server.js` already imports the HTTP router as `createRouter` (`src/server.js:18`), so the superagent's is imported under an alias.
- **Router only when it can authenticate.** **[Author's call]** The router authenticates only through an `apiKeyHelper` copied from `~/.claude/settings.json` (`src/superagent/router.js:173-179`; spike S4b: `settingSources: []` otherwise gives "Not logged in"). With a router injected, router-eligible failures go to it instead of the code-only retries (`src/superagent/index.js:389`), and in Plan 6 `stuck` is final. So: when a helper is found at boot, inject the router (rev 3 intends it; each call is one cheap isolated Haiku request on a failed attempt only). When none is found, pass `router: null` (code-only retries) and log one line saying why. The router panel shows "Router off: no apiKeyHelper" in that case.
- **One owner per superagent folder.** **[Decided]** Two Cockpits on different ports share `~/.prompt-cockpit/superagent/`, and the store has no cross-process protection: each process caches jobs and assigns the next event `seq` in memory (`src/superagent/store.js:230-298`), and a second supervisor would treat the first's live attempts as interrupted and relaunch them (`src/superagent/index.js:454-455`). So the first Cockpit to boot takes a lock file in the superagent root carrying `ownerPid`, `ownerStartedAt` and its `PORT` (same identity check `child-tracker.js` uses for `runtime.json`). Any other Cockpit does not create or start the supervisor: its Superagent tab shows "Superagent is running in the Cockpit on port N" with a link, its `/api/superagent/*` action routes refuse with a clear error, and its bell and badge carry no superagent entries. A lock whose owner is provably gone (process absent, or start time differs) is taken over at boot. The owner removes the lock on clean shutdown. Taking over a live owner's lock, or switching owners while both run, is out of scope. Protocol requirements (Codex design review): acquisition is exclusive and atomic (e.g. create-if-absent, not read-check-write), so two Cockpits booting together cannot both win; stale takeover is serialised and rechecks that the lock still carries the identity it judged dead before replacing it, so two Cockpits that both see the same dead owner cannot both take over; ownership that cannot be verified counts as occupied (same "refuse rather than guess" rule as `child-tracker.js`); a Cockpit only ever removes a lock carrying its own identity. Tests: simultaneous acquisition, simultaneous stale takeover, unverifiable owner, release-own-only.
- **Config is loaded before anything uses it.** `createSuperagentConfig()` does not read its file until `load()` is called (`src/superagent/config.js:332-339`), and the supervisor reads `config.resolve(null)` at construction and on start (`src/superagent/index.js:121`, `:466`). So boot awaits `config.load()` before constructing the supervisor. **[Author's call]** If the file is corrupt (`ERR_CONFIG_CORRUPT`), the superagent does not start: the tab shows the error and the file path, the action routes refuse, and the rest of Cockpit (sessions, auto-pilot) runs normally. A test boots with a non-default saved config and sees it applied.
- **Lifecycle and admission.** The HTTP server already serves requests while async boot wiring runs (`src/server.js:322-334`), `createJob` has no stopping check (`src/superagent/index.js:584-624`), and `stop()`/`drain()` do not await provisioning or every per-job chain (`:484-510`). So the superagent side has explicit states: *initialising* (lock, config load, supervisor start; action routes refuse with "starting"), *ready* (actions admitted), *stopping* (new actions refused; admitted creates, answers, accepts and stops are settled before the store is flushed and the lock released). Teardown is registered before async initialisation begins, so a shutdown during initialisation still releases the lock. Tests: shutdown during initialisation, shutdown during a create's provisioning.
- All paths come from the existing defaults (`~/.prompt-cockpit/superagent/…`, redirected by `COCKPIT_HOME`). Tests must set `COCKPIT_HOME` (and `COCKPIT_OPERATOR_FILE` / `COCKPIT_OPERATOR_TOKEN`) so nothing touches the real home.
- `src/superagent-wiring.js` (new) registers start at boot and the stop on `src/shutdown.js`'s hooks, so neither `shutdown.js` nor `session-registry.js` learns that a superagent exists (same rule as auto-pilot).
- **Close the approval gaps.** Required outcome: **a superagent worker's ask is denied, and its session counts as superagent-owned (for watch-only and attach), from session creation until the registry confirms the row is gone**, regardless of attempt outcome or runner bookkeeping. Two known gaps (Codex design review, confirmed):
  - *Shutdown* (Plan 5 final review): `stop()` removes the approval interceptor (`src/superagent/index.js:497-500`) in `onBeforeClose`, and rows close only afterwards (`src/shutdown.js:57-63`).
  - *Failed close*: the runner drops its `bySession` entry before closing the row (`src/superagent/runner.js:130-141`, `:149-154`), and its interceptor then returns `null` (`:535-538`). If `registry.closeSession` throws, `closeRow` logs and carries on (`:113-119`) and the row stays live and unowned.
  
  Mechanism is the builder's call (e.g. ownership keyed on live registry rows, cleared only from the session-removed listener; the interceptor kept until `onAfterClose`). Tests cover both gaps.
- **Ownership is generalised** from "pilot-owned" to "owned by a supervisor" (rev 3 Decision 1). `isPilotOwned` (`src/server.js:55`) becomes a check that accepts sessions owned by either supervisor. The superagent side answers from its live attempts (an attempt whose `sessionId` is a live registry row).

### Watch-only for superagent sessions

- **Server:** for a session owned by the superagent, the server refuses every operation that would change it: sending a message over the WebSocket (`src/server.js:171`), answering an approval, interrupting, and the mutating session routes (mode, model, thinking, rewind, close and similar in `src/routes/session-actions.js`). Reading (attaching, replay, history) stays allowed. The refusal is a clear error, not a silent drop. Pilot-owned sessions keep their current behaviour.
- **Browser:** the attach-token response and the session summary (`GET /api/sessions/:id`, which a reloaded tab rejoins through without calling attach-token again, `public/app.js:2700-2709`) both say the session is watch-only. The attached tab then hides or disables the compose box and session controls, and shows a one-line banner: "Superagent worker — watch only".
- Exactly which routes count as mutating is the builder's call, with the rule above as the test: if it can change what the worker does or sees, it is refused.

### Routes (`src/routes/superagent.js`)

Operator-gated and Origin/Host-checked like every other `/api/` route. Exact shapes are the builder's call. Needed:

- List jobs (a summary row per job, including corrupt jobs `listJobs()` returns).
- Get one job (the derived job plus what the middle pane needs: phases with status, the task list, attempts with live-session flag, router decisions, the needs-you entry if any).
- Create a job: title (optional), idea, primary folder, additional folders. Mode is always `automatic`; no fixture. Errors from `createJob` come back with their `code` and message so the form can show them inline.
- **Folder checks before the job exists.** **[Author's call]** Today `ERR_NOT_GIT_REPO`, `ERR_NO_COMMITS`, `ERR_BRANCH_EXISTS` and `ERR_WORKTREE_PATH_EXISTS` are thrown inside `provision()` (`src/superagent/worktree.js:66-72`), which catches them and appends `job-failed` after `job-created` has landed (`src/superagent/index.js:569-581`). A bad folder would leave a permanent failed job (Plan 6 cannot delete jobs) and, with several folders, worktrees already made for the earlier ones. So `createJob` runs those checks for **every** folder before it appends `job-created`, and throws the coded error. This is a library change with its own tests. `provision()` keeps its catch for failures that only show up while creating worktrees.
- Answer, accept, stop: thin calls to `answerQuestion`, `accept`, `stopJob`, returning their `ERR_*` codes as 4xx.
- Read an artifact: returns the text of one of the job's known artifacts (`artifactPaths`, `reviewPaths`) from the primary worktree. **Only those paths**, never a caller-supplied path. A known filename is not enough on its own: a worker could leave the artifact, or a directory above it, as a symlink or Windows junction pointing outside the worktree, and the existing artifact reads follow links (`src/superagent/results.js:534`, `:577`, `:641`). So the route resolves the real path and refuses anything outside the primary worktree's real path. Tests: a linked file and a linked parent directory are both refused.

### The view (`public/superagent-view.js`, `public/style-superagent.css`)

**The view is chosen before any session bootstrap.** A script-opened tab inherits the opener's `sessionStorage` (handled today for `?newTab` and `?attach`, `public/app.js:484-520`), and the bootstrap rejoins the saved session unconditionally (`public/app.js:2699-2717`). So `app.js` dispatches on `?view=superagent` before session adoption, rejoin or bootstrap, and skips transcript initialisation entirely in that tab. Hand-verified: opening the view from a tab with an active session, reloading it, and arriving from a notification click.

Polls the job list and the selected job every 5 s while the tab is visible. **[Author's call]**. `/?view=superagent&job=<id>` opens with that job selected (used by notification clicks).

```
┌ Jobs ─────────────────┬ Selected job ─────────────────────┬ Needs you + Router ───────┐
│ + New job             │ Add login page        running      │ QUESTION                  │
│ ● Add login page  … ▸ │ [brainstorm✓][spec✓][spec-review●] │ Should the session expire │
│   spec-review running │ [plan][plan-review][implement]…    │ after 30 min or 8 h?      │
│ ! Fix CSV export      │ Tasks: ☐ t1 parse  ☐ t2 export     │ [answer box        ][Send]│
│   needs you           │ Attempts                           │ [Stop job]                │
│ ✓ Rename settings     │  spec-review r2 · reviewer ·       │ ─ Router ───────────────  │
│   done                │   opus-5-5 · running · 1/3 [open]  │ claude-haiku-5-5 · 2 calls│
│                       │ Artifacts: brief · spec · reviews  │ attempt-failed → retry …  │
└───────────────────────┴────────────────────────────────────┴───────────────────────────┘
```

- **Left — Jobs.** One row per job: title, current phase, status (running / needs you / done / stopped / failed / provisioning). Newest first, finished jobs below unfinished ones. **[Author's call]**. **+ New job** opens a form: idea (required), title (optional; derived from the idea's first words when empty), primary folder (via the existing folder browser), additional folders (zero or more), and a fixed "Automatic" label (no mode selector, no budget field). Creation errors show inline.
- **Middle — Selected job.** Phase chips (done / running / waiting / todo); the task checklist; attempts with role, model, status, attempt *n*/cap and review round, each with **open** while its session is live (watch-only, via the generalised attach flow); links to the job's artifacts (opened in a read-only viewer inside the view); the branch name per repo. Job-level **Stop** for a job that is not finished.
- **Right — Needs you + Router.**
  - *Question:* the question text, a 1-4000 character answer box, **Send** (→ `answerQuestion`), **Stop**. A budget question shows its text and **Stop** only (answering budget questions is deferred).
  - *Ready to try:* the branch per repo, the test report, and the brief's "Assumptions made for you" section when the job has a brief (rev 3's "how-to-test, assumptions" has no structured source yet, so it comes from these artifacts). **Accept** (→ `accept`; never merges or pushes) and **Stop**.
  - *Stuck:* the reason and detail, and **Stop**.
  - *Router:* model, calls this job, last request size vs limit, and a log of decisions (event → action → note), from `router-decided` events. No spend.
- Styling stays within Cockpit's existing CSS tokens.

### Notifications

- **Projection.** `/api/notifications` returns entries from both supervisors (rev 3 Decision 1: "projection accepts multiple sources"). Superagent entries are derived from current job state, nothing stored, nothing to mark read: one entry per job in `needs-you`, typed `ready-to-try`, `question` or `stuck` (a budget question is type `question`; every other terminal `needs-you` reason is `stuck`). Each entry has a stable key that changes when the job enters a new `needs-you` (job id plus the `needs-you` event's seq), so a second question on the same job is a new entry. `deriveJob` does not keep that seq today (`src/superagent/store.js`, the `needs-you` case), so it records it on the job.
- **Text** is code-generated: job title plus a short line per type (the question's first line, "ready to try", or the stuck reason). Router-written text is deferred.
- **Bell.** Superagent entries appear beside auto-pilot's. Clicking one opens (or focuses) the Superagent tab with that job selected. The bell's tooltip stops saying "Auto-pilot".
- **Badge.** The Superagent button in every tab's top bar shows a red badge with the count of superagent entries, from the same 10 s poll.
- **Browser notifications.** A Superagent-view control asks for permission (never on page load). Once granted, any open Cockpit tab shows one browser notification per *new* entry, tagged with the entry key. Entries already present when a tab first polls do not notify (the bell and badge show them). Cross-tab de-duplication is required: the tabs share a record of notified keys (e.g. in `localStorage`, pruned to current entries) so only the first tab to see an entry notifies. Mechanism is **[Author's call]**; the builder may choose another that meets the anti-goal.

## Testing

Same split as earlier plans (`tests/README.md` documents it feature by feature):

- **Unit / route tests (`npm test`):** the routes with an injected supervisor (mirror the auto-pilot route tests); the notification projection from both sources, including entry keys changing on a new `needs-you`; supervisor ownership for attach; watch-only refusals for every refused operation and allowance for reads; the approval gaps (an ask during stop is denied; an ask on a row whose close threw is denied); the artifact route refusing anything outside the job's known artifacts; the wiring module's start/stop ordering; the owner lock (take, refuse while a live owner holds it, take over a dead owner's, release on shutdown); `createJob` refusing a bad folder before `job-created` lands, for the primary and an additional folder; router injected only when a helper is found.
- **Hand-verified (no jsdom):** the view, the badge, the bell entries, browser notifications and their cross-tab de-duplication, the watch-only banner. Record each in `tests/README.md`.
- No paid runs.

## Docs to update

`CLAUDE.md` (superagent paragraph says it is "not wired into `src/server.js`" and lists "any UI" as missing; the four `public/` module lists; the ownership/notification sentences), `README.md` Status, `tests/README.md`, `backlog.md` (new section above), and the rev 3 spec is left as is (this document wins for Plan 6).

## Left to the builder

Route shapes and payloads; exact module split inside `public/`; the approval-gap mechanism; the lock file's name and format; the list of refused session operations (by the rule above); the cross-tab de-duplication mechanism; markdown rendering in the artifact viewer (reuse whatever `stream-view.js` uses, or plain text); poll intervals; styling.
