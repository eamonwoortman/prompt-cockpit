# Superagent Plan 6 — the Superagent View, Server Wiring and Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** 2. Folds in the Codex review of revision 1 (5 Important, 2 Minor; `.superpowers/sdd/codex-p6-plan-review.md`). See "Revision 2 changes" at the end.

**Goal:** Wire the superagent library into Cockpit's server and add a Superagent tab, Needs-you actions (answer, accept, stop), bell entries, a badge and browser notifications, with superagent worker sessions watch-only.

**Architecture:** A `superagent-host` owns the supervisor's lifecycle (owner lock, config load, router choice, initialising/ready/stopping admission) and is the only thing routes, the bell and the watch-only checks talk to. Pure modules turn derived jobs into view rows and notification entries. The frontend picks the Superagent view in a new `entry.js` before `app.js` (and its session bootstrap) is ever loaded. Watch-only is enforced server-side on every mutating session route and on WebSocket input.

**Tech Stack:** Node 18+ ESM, no framework, no bundler; vanilla JS ES modules in `public/`; `@anthropic-ai/claude-agent-sdk` 0.3.318 (unchanged); tests with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-17-superagent-p6-view-design.md` (Plan 6 design; wins over rev 3 where they differ), on top of `docs/superpowers/specs/2026-11-03-superagent-design.md` (rev 3), sections "The Superagent view", "Notifications", "Restart and recovery".

## Global Constraints

- Work only on branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`; `feature/auto-pilot` is not modified.
- No new npm dependencies, no `package.json` change; plain ESM; no build step. Never commit `package-lock.json` (deliberately modified and uncommitted); stage files by name, never `git add -A`; `HANDOVER.md` stays out of commits.
- Baseline: run `npm test` before Task 1 and record the count in the SDD ledger (last recorded: 1086 passing at `da8d6e5`). It stays green after every task. Run the full suite with a timeout (`timeout 500 npm test`); summary lines are `ℹ tests/pass/fail`.
- Tests are no-network, no real CLI, no real model. Any test that builds a host, store, config or lock sets `COCKPIT_HOME` to a temp dir, and server-importing tests also set `COCKPIT_OPERATOR_TOKEN` (existing pattern, `tests/autopilot-routes.test.mjs:11-15`). Temp git repos go through `initRepo` (`tests/superagent-helpers.mjs:16`, disables `core.fsmonitor`).
- NO `Co-Authored-By` trailer on any commit. Conventional prefix only; commit with `git commit -F- <<'EOF' ... EOF`. Files are LF.
- `src/session-registry.js` and `src/shutdown.js` are NOT modified: the registry stays superagent-agnostic, and wiring goes through `shutdown.onBeforeClose`/`onAfterClose` only.
- No real-model probe and no paid run in this plan.
- Never push, PR or merge.
- Exact copy (verbatim):
  - Watch-only banner: `Superagent worker — watch only`
  - Not-owner notice: `Superagent is running in the Cockpit on port <N>` (link to `http://127.0.0.1:<N>/?view=superagent`)
  - Router off: `Router off: no apiKeyHelper`
  - Watch-only refusal body: `{ "error": "superagent worker sessions are watch only", "code": "ERR_WATCH_ONLY" }`, status 403
- Values: view poll 5 s while visible; bell/badge poll stays 10 s (`public/notifications-panel.js:11`); answer 1-4000 characters after trim; notification key `superagent:<jobId>:<needsYouSeq>`; lock file `<superagent root>/owner.lock`, takeover claim `<superagent root>/owner.lock.<token>.claim`; host stop deadline 2500 ms; `FORCE_EXIT_MS` 10000.

## Review Focus

1. **The same repo given twice** (primary repeated among additional folders, two additional folders in one repo, or a subfolder of the primary's repo) is refused with `ERR_DUPLICATE_REPO` before `job-created` lands; a folder that does not exist is a 400 from the route. Today the second worktree fails mid-provision and leaves a failed job plus a kept worktree. (Task 1 test `createJob refuses the same repo twice before the job exists`; Task 7 test `POST /api/superagent/jobs refuses a missing folder`.)
2. **Two tabs, or a double-click, acting on the same needs-you entry:** a second answer or accept gets 409 `ERR_INVALID_STATE` and appends nothing; a second stop is a harmless 200 returning the stopped job and appends nothing (`stopJob` is idempotent today, `src/superagent/index.js:665`, and stays so). The view shows any error and refreshes. (Task 1 test `repeated answer, accept and stop append nothing` on the real supervisor; Task 7 test `a second answer to the same question is a 409`.)
3. **A corrupt job** (`{ jobId, state: 'failed', reason: 'corrupt-events' }`, no title, no pipeline — `src/superagent/index.js:442`) in the list, the detail route or the notification projection never throws; it shows as `corrupt event log`. (Task 4 test `a corrupt job summarises without throwing`.)
4. **Cockpit restarting while a Superagent tab is open, or after a crash:** routes answer 503 `starting` during initialisation and the view shows "Starting…" and recovers on the next poll; a lock left by a dead Cockpit is taken over at boot. (Task 3 test `a dead owner's lock is taken over`; Task 6 test `actions are refused while initialising and admitted once ready`.)
5. **Question text that is long, multi-line or HTML-looking** (`<img onerror=…>`) is rendered as text, never HTML, and the notification line is the first line, cut to 120 characters with `…`. (Task 4 test `notification text uses the first line, cut to 120 characters`; view code uses `textContent` only — hand-verified in Task 11.)

---

## Decisions the design leaves to the builder

1. **Host object.** `src/superagent-host.js` `createSuperagentHost(...)` is the single seam between Cockpit and the supervisor. Routes, the notification route and the watch-only checks hold the host, never the supervisor, so "not owner", "starting", "config corrupt" and "stopping" are answered in one place. `server.js` constructs the host at module scope (no side effects) and `wireSuperagent` calls `init()` inside the `listen` callback, after `wireAutopilot`, mirroring why `wireAutopilot` runs there (`src/server.js:322-334`).
2. **Lifecycle states:** `off` (constructed, `init` not called) → `initialising` → `ready` | `not-owner` | `error`; then `stopping` → `stopped`. `admit(fn)` runs `fn(supervisor)` only in `ready` and tracks the promise. Status codes: `not-owner` → 409; `off`/`initialising`/`stopping`/`stopped`/`error` → 503; body `{ error, code: 'ERR_SUPERAGENT_UNAVAILABLE', state, ownerPort }`.
   - **Init is cancellable.** `init()` checks a `stopRequested` flag after every await (lock, config load, router factory) and immediately before building and before starting the supervisor. Once `stop()` has been called, `init` never builds or starts a supervisor and never overwrites `stopping` (an init error after stop is logged, not stored as `error`).
   - **Stop is bounded** (Codex plan review, Important 1): shutdown awaits each before-close hook before it closes any session (`src/shutdown.js:46-63`), under an 8 s force-exit watchdog (`src/server.js:248`). `stop()` sets `stopping` and calls `supervisor.stop()`'s synchronous part first (its `stopping = true` and `runner.setStopping(true)`, `src/superagent/index.js:491-494`, happen before its first await, so no new launch can start), then waits for admitted actions and the rest of `supervisor.stop()` together, raced against `HOST_STOP_DEADLINE_MS = 2500`. On timeout it logs `superagent stop did not settle within 2500ms - closing sessions anyway` and returns, so shutdown goes on to close sessions. The lock is kept until `afterClose()`.
   - `FORCE_EXIT_MS` (`src/server.js:248`) rises from 8000 to 10000, and its comment adds `superagent host.stop()'s HOST_STOP_DEADLINE_MS (2.5s)` to the budget sum (3 + 1.5 + 2 + 2.5 = 9 s).
   - `afterClose()` runs `supervisor.drain()` (raced against the same 2500 ms), `supervisor.dispose()`, then `lock.release()`.
3. **Ownership lifetime.** The runner keeps an `owned` Set of session ids, added the moment `registry.createSession` returns (`src/superagent/runner.js:462-484`) and removed only in `onSessionRemoved`. `onApprovalRequest` denies for any id in `owned`, whether or not `bySession` still has it. `stop()` no longer removes the approval interceptor; a new `dispose()` does, and the host calls it in `afterClose`. This closes both gaps in the design (shutdown, failed close).
4. **Owner lock algorithm** (`src/superagent/owner-lock.js`). Identity `{ pid, osStartedAt, port, token }` (`token` = `randomUUID()`; `osStartedAt` from `probeProcessStartTime(process.pid)`, may be `null`).
   - `acquire()`: `open(file, 'wx')`, write identity, `datasync`, close → owned. On `EEXIST`, read and parse; unparseable → occupied (`owner: null`, `corrupt: true`). Else `verifyEntry({ pid, osStartedAt })` (`src/child-tracker.js:180`): `'match'` or `'unverifiable'` → occupied; `'gone'` or `'mismatch'` → stale takeover.
   - Stale takeover, without a separate mutex (Codex plan review, Important 4: an mtime-reclaimed mutex is not exclusive). Let `S` be the stale token observed.
     1. `rename(file, claim)` where `claim = file + '.' + ourToken + '.claim'`. A rename moves one directory entry, so of two contenders renaming the same entry only one succeeds; the other gets `ENOENT` → re-run `acquire()` from the top (once; a second `ENOENT` → occupied).
     2. Read `claim`. If its token is `S`: unlink `claim`, then `open(file, 'wx')`. Success → owned. `EEXIST` → a faster contender won; re-observe (occupied unless ours).
     3. If its token is not `S` (we moved a lock a faster contender had just written): put it back with `link(claim, file)` (fails with `EEXIST` instead of overwriting, unlike `rename` on Windows), then unlink `claim`; → occupied. If `link` fails with `EEXIST`, unlink `claim` and → occupied.
     - Residual, documented in the module: three or more Cockpits booting within the same instant over a stale lock can still interleave badly. Out of scope.
   - `release()`: read the lock; unlink only if `token` equals ours. Never throws (logs). Leftover `*.claim` files from a crash mid-takeover are ignored by `acquire()`.
5. **Pure projections.** `src/superagent/view-model.js` (job rows and job detail) and `src/superagent/notifications.js` (bell entries) take derived jobs plus an `isLive(sessionId)` predicate and never touch the filesystem, so they are unit-tested without a server.
6. **Artifacts by key.** The view lists artifacts by key, never by path. Keys: `brief`, `spec`, `plan`, `tasks`, `testReport` (`artifactPaths`, `src/superagent/results.js:52`) and, for each attempt that has them, `review:<phase>:<round>`, `response:<phase>:<round>`, `verify:<phase>` / `verify:<phase>:<round>`, `report:<task>`, `taskReview:<task>:<round>`, `taskVerify:<task>` / `taskVerify:<task>:<round>` (`reviewPaths`, `results.js:64-78`). `artifactPath(job, key)` maps a key back through those two functions and returns `null` for anything else. `readArtifact` then enforces real-path containment.
7. **Notification route.** `/api/notifications` moves out of `src/routes/autopilot.js:167-169` into `src/routes/notifications.js`, which merges `await autopilot.notifications()` with `host.notifications()`. Auto-pilot entries keep their shape. Superagent entries are `{ kind: 'superagent', type, key, jobId, title, message }`.
8. **Browser-notification de-duplication** lives in `src/notify-dedupe.js`, served verbatim to the browser through `SHARED_SRC_FILES` (`src/static-files.js:16`), so it is unit-tested in Node and used unchanged by every tab. The record lives in `localStorage` under `cockpit:notifiedKeys`. Read-compute-write must be atomic across tabs (Codex plan review, Important 3), so `claimNotifications` runs it inside a Web Lock (`navigator.locks.request('cockpit:notify', fn)`; `127.0.0.1`/`localhost` are secure contexts, so the API is available in current browsers). Fallback when `navigator.locks` is absent: run without the lock; every notification still carries `tag: key`, so a duplicate replaces the first rather than stacking.
9. **View dispatch.** `index.html` loads `/entry.js` instead of `/app.js`. `entry.js` imports `/superagent-view.js` when `?view=superagent` is present and `/app.js` otherwise. `app.js`'s session bootstrap (`public/app.js:2699-2717`) therefore never runs in the Superagent tab.
10. **WebSocket input.** The `ws.on('message')` body (`src/server.js:171-214`) moves unchanged into `src/ws-input.js` `handleClientMessage(...)` with an added watch-only gate, so the gate is unit-testable without a socket.

## File Structure

- `src/superagent/store.js` — `job.needsYouSeq`.
- `src/superagent/worktree.js` — `checkRepo`, `repoToplevel`.
- `src/superagent/index.js` — `createJob` preflight; `stop()` keeps the interceptor; `dispose()`; `ownsSession()`.
- `src/superagent/runner.js` — `owned` set, `ownsSession()`.
- `src/superagent/owner-lock.js` (new) — the single-owner lock.
- `src/superagent/view-model.js` (new) — `jobSummary`, `jobDetail`, `artifactKeys`, `artifactPath`.
- `src/superagent/notifications.js` (new) — `superagentNotifications`.
- `src/superagent/artifacts.js` (new) — `readArtifact` with containment.
- `src/superagent-host.js` (new) — lifecycle, admission, router choice.
- `src/superagent-wiring.js` (new) — `wireSuperagent({ shutdown, host })`.
- `src/routes/superagent.js` (new), `src/routes/notifications.js` (new); `src/routes/autopilot.js` (route removed); `src/routes/sessions.js`, `src/routes/session-actions.js` (watch-only, supervisor ownership).
- `src/ws-input.js` (new) — WebSocket message handling with the watch-only gate.
- `src/notify-dedupe.js` (new, shared with the browser); `src/static-files.js` (`SHARED_SRC_FILES`).
- `src/server.js` — host construction, route registration, ownership predicate, `ws-input`, wiring call, export `superagentHost`.
- `public/entry.js` (new), `public/index.html`, `public/app.js` (watch-only tab, Superagent button), `public/notifications-panel.js` (superagent entries, badge, browser notifications), `public/superagent-view.js` (new), `public/style-superagent.css` (new).
- Docs: `CLAUDE.md`, `README.md`, `tests/README.md`, `backlog.md`.
- Tests: `tests/superagent-store.test.mjs`, `tests/superagent-worktree.test.mjs`, `tests/superagent.test.mjs`, `tests/superagent-runner.test.mjs`, new `tests/superagent-owner-lock.test.mjs`, `tests/superagent-view-model.test.mjs`, `tests/superagent-artifacts.test.mjs`, `tests/superagent-host.test.mjs`, `tests/superagent-routes.test.mjs`, `tests/watch-only.test.mjs`, `tests/notify-dedupe.test.mjs`; existing `tests/server-auth.test.mjs`, `tests/autopilot-routes.test.mjs`.

---

### Task 1: Library: needs-you seq and folder checks before the job exists

**Files:**
- Modify: `src/superagent/store.js:82` (`needs-you` case), job init `:36-62`
- Modify: `src/superagent/worktree.js:64-72`
- Modify: `src/superagent/index.js:584-624` (`createJob`)
- Test: `tests/superagent-store.test.mjs`, `tests/superagent-worktree.test.mjs`, `tests/superagent.test.mjs`

**Interfaces:**
- Produces: `job.needsYouSeq: number|null` (seq of the `needs-you` event that set the current state; `null` otherwise). `export async function repoToplevel({ git, origin }) -> string` (throws `ERR_NOT_GIT_REPO`). `export async function checkRepo({ git, origin, worktree, branch }) -> { toplevel: string }` (throws `ERR_NOT_GIT_REPO`, `ERR_NO_COMMITS`, `ERR_BRANCH_EXISTS`, `ERR_WORKTREE_PATH_EXISTS`). `createJob` throws those codes plus `ERR_DUPLICATE_REPO` before appending `job-created`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/superagent-store.test.mjs` `needsYouSeq tracks the needs-you that set the state`: events through `needs-you` at seq 7 → `needsYouSeq === 7`; then `question-answered` → `null`; a later `needs-you` at seq 12 → `12`; `job-stopped` → `null`.
  - `tests/superagent-worktree.test.mjs` `checkRepo reports each refusal with its code`: a plain dir → `ERR_NOT_GIT_REPO`; `initRepo` with no commit → `ERR_NO_COMMITS`; an existing branch → `ERR_BRANCH_EXISTS`; an existing worktree path → `ERR_WORKTREE_PATH_EXISTS`; a good repo → `{ toplevel }` equal to `repoToplevel`.
  - `tests/superagent.test.mjs` `createJob refuses a bad folder before the job exists`: primary is a plain dir → rejects with `code === 'ERR_NOT_GIT_REPO'`; an additional folder with no commits → `ERR_NO_COMMITS`; in both cases `listJobs()` is `[]`, the jobs root has no job dir, and no worktree dir exists.
  - `tests/superagent.test.mjs` `createJob refuses the same repo twice before the job exists`: primary listed again in `additionalRepos` → `ERR_DUPLICATE_REPO`; a subfolder of the primary repo as additional → `ERR_DUPLICATE_REPO`; nothing appended.
  - `tests/superagent.test.mjs` `repeated answer, accept and stop append nothing` (real supervisor, store-backed job): after a successful `answerQuestion`, a second one rejects `ERR_INVALID_STATE` and `events.jsonl` has the same line count; same for a second `accept` on a ready-to-try job; a second `stopJob` resolves with the stopped job and the line count is unchanged. (Pins existing behaviour the routes rely on; may pass on first run, which is fine.)
- [ ] **Step 2: Run** `node --test tests/superagent-store.test.mjs tests/superagent-worktree.test.mjs tests/superagent.test.mjs` → the new tests FAIL.
- [ ] **Step 3: Implement.** Store: set `needsYouSeq = ev.seq ?? null` in the `needs-you` case and reset it to `null` in every `setState` call that leaves `needs-you`. Worktree: extract the four checks from `createWorktree` into `checkRepo`; `createWorktree` calls `checkRepo` first, so its behaviour is unchanged. Index: after `fitSlug`, for each repo from `repoIds(...)`, `await checkRepo({ git, origin, worktree: path.join(worktreesRoot, slug, repo.id), branch })`; compare toplevels with `path.resolve` (lower-cased on `platform === 'win32'`) and throw `fail('ERR_DUPLICATE_REPO', 'superagent: <origin> is the same repository as <other>')` on a repeat. `provision()` keeps its catch.
- [ ] **Step 4: Run** the three files → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent createJob checks every folder before the job exists; job records its needs-you seq`.

### Task 2: Library: worker ownership lasts until the row is gone

**Files:**
- Modify: `src/superagent/runner.js:85,462-484,535-545,551-563`
- Modify: `src/superagent/index.js:490-510` (`stop`), `:697` (return)
- Test: `tests/superagent-runner.test.mjs`, `tests/superagent.test.mjs`

**Interfaces:**
- Produces: `runner.ownsSession(sessionId) -> boolean`; supervisor `ownsSession(sessionId) -> boolean`, `dispose() -> void` (removes the approval interceptor; idempotent). `stop()` no longer removes the interceptor.

- [ ] **Step 1: Write the failing tests.**
  - runner `an ask on a row whose close threw is still denied`: launch an attempt with the fake registry from `sessionFactory`; make `registry.closeSession` throw for that id; finish the attempt (result written, review). The row is still in the registry; `runner.onApprovalRequest({ row })` returns `{ behavior: 'deny', ... }`; `runner.ownsSession(row.id) === true`. After `runner.onSessionRemoved({ id: row.id })`, `ownsSession` is `false` and the interceptor returns `null`.
  - supervisor `an ask during stop is denied until dispose`: start a job with a live attempt; `await sa.stop()`; the registry's interceptor chain still denies an ask on the attempt's row; after `sa.dispose()` the superagent's interceptor is no longer registered (the registry returns its default for that row).
  - supervisor `ownsSession is true from launch until removal`: false before launch, true after `attempt-session`, true after `stopJob` while the row lingers, false after the row's removal is reported.
- [ ] **Step 2: Run** `node --test tests/superagent-runner.test.mjs tests/superagent.test.mjs` → FAIL.
- [ ] **Step 3: Implement** as in Decision 3. Update any existing test that asserted `stop()` unregisters the interceptor to call `dispose()` instead.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `fix: superagent denies a worker's ask until its row is gone, not just until stop`.

### Task 3: Owner lock

**Files:**
- Create: `src/superagent/owner-lock.js`
- Test: `tests/superagent-owner-lock.test.mjs`

**Interfaces:**
- Produces: `export function createOwnerLock({ file, port, pid = process.pid, idImpl = randomUUID, probeStartTime = probeProcessStartTime, verify = verifyEntry, fsImpl = fsPromises, logImpl = console.error }) -> { acquire(): Promise<{ owned: true } | { owned: false, owner: { pid, port } | null, corrupt?: true }>, release(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests** (temp dir; `verify` and `probeStartTime` injected):
  - `the first acquire owns the lock and writes its identity`: file contains `{ pid, osStartedAt, port, token }`.
  - `a live owner's lock is refused`: a second lock (different `idImpl`) with `verify` → `'match'` gets `{ owned: false, owner: { pid, port } }`; same for `'unverifiable'`.
  - `a dead owner's lock is taken over`: `verify` → `'gone'` (and separately `'mismatch'`) → `{ owned: true }` and the file now carries the new token.
  - `simultaneous acquisition has exactly one winner`: two locks on one file, `Promise.all([a.acquire(), b.acquire()])` → exactly one `owned: true`.
  - `simultaneous stale takeover has exactly one winner`: a stale lock on disk, two contenders both seeing `'gone'` → exactly one `owned: true`, the file carries the winner's token.
  - `a contender that moved a fresh lock puts it back`: inject the fs ops (`createOwnerLock` takes `fsImpl` with `open`, `readFile`, `rename`, `link`, `unlink`, default `node:fs/promises`) and interleave: A observes stale `S`, B completes its takeover and writes `N`, then A renames → A reads `N`, links it back and reports `owned: false`; the file carries `N` and no `*.claim` file remains.
  - `a faster contender's new lock makes the slower one occupied`: A unlinks its claim of `S`, B's `open(file, 'wx')` lands first → A's `wx` gets `EEXIST` → `owned: false`.
  - `a leftover claim file from a crash is ignored`: an `owner.lock.x.claim` beside a live lock does not change the outcome.
  - `an unparseable lock is occupied`: garbage in the file → `{ owned: false, owner: null, corrupt: true }`.
  - `release removes only our own lock`: after another token overwrote the file, `release()` leaves it; our own lock is removed; `release()` with no file does not throw.
- [ ] **Step 2: Run** `node --test tests/superagent-owner-lock.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the algorithm in Decision 4.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent single-owner lock`.

### Task 4: View model and notification entries

**Files:**
- Create: `src/superagent/view-model.js`, `src/superagent/notifications.js`
- Test: `tests/superagent-view-model.test.mjs`

**Interfaces:**
- Consumes: `job.needsYouSeq` (Task 1); derived job shape (`src/superagent/store.js:36-62,92-125,180-194`).
- Produces:
  - `jobSummary(job) -> { jobId, title, state, reason, phaseId, status: 'provisioning'|'running'|'needs-you'|'done'|'stopped'|'failed', needsYou: 'question'|'ready-to-try'|'stuck'|null, createdAt }`
  - `jobDetail(job, { isLive }) -> { ...jobSummary(job), idea, branch, repos: [{ id, origin, worktree }], phases: [{ phase, kind, status: 'done'|'running'|'waiting'|'todo' }], tasks: [{ id, title, done }]|null, attempts: [{ attemptId, phase, task, role, model, n, cap, round, purpose, outcome, live, sessionId }], artifacts: [{ key, label }], router: { model, allowlist, maxInputTokens, calls, lastRequestTokens, decisions: [{ forAttemptId, action, note, ok, error, at }] }, needsYou: null | { type, key, text, detail, answerable } }`
  - `artifactKeys(job) -> string[]`; `artifactPath(job, key) -> string|null` (repo-relative)
  - `superagentNotifications(jobs) -> Array<{ kind: 'superagent', type: 'question'|'ready-to-try'|'stuck', key, jobId, title, message }>`

- [ ] **Step 1: Write the failing tests:**
  - `jobSummary maps states and needs-you reasons`: `needs-you/question` → `needsYou: 'question'`; `needs-you/ready-to-try` → `'ready-to-try'`; `needs-you/stuck` → `'stuck'`; `running` → `null`.
  - `phase chips`: a milestone-2 job whose current phase is `plan-review` → `spec`, `spec-review`, `plan` are `done`, `plan-review` is `running`, `implement`, `test`, `accept` are `todo`; the same job in `needs-you` → `plan-review` is `waiting`.
  - `attempts carry their cap and live flag`: author attempt `cap === limits.attemptsPerPhase`, per-task attempt `cap === limits.attemptsPerTask`; `live` follows `isLive(sessionId)`.
  - `needsYou.answerable is false for a budget question and true for any other question`; `key === 'superagent:<jobId>:<needsYouSeq>'`.
  - `artifactPath maps known keys and refuses others`: `spec` → `artifactPaths(job).spec`; `review:spec-review:2` → `reviewPaths(job, { phase: 'spec-review', round: 2 }).review`; `verify:plan-review` → the base verify path; `../etc/passwd`, `review:x` (no round), `brief/../x` → `null`.
  - `artifactKeys lists only keys the attempts imply`: a job with a spec-review round 1 review and response lists `review:spec-review:1` and `response:spec-review:1` and not round 2.
  - `notification entries: one per needs-you job, typed`: three jobs (question, ready-to-try, stuck) plus one running → three entries with the right `type`; a budget question → `type: 'question'`.
  - `notification text uses the first line, cut to 120 characters`: question `"Line one\nLine two"` → message `"<title>" has a question: Line one`; a 300-char first line ends with `…` and the question part is 120 characters including `…`. Ready → `"<title>" is ready to try`; stuck → `"<title>" is stuck: <detail.why ?? reason>`.
  - `the key changes with a new needs-you`: same job, `needsYouSeq` 7 then 12 → different keys.
  - `a corrupt job summarises without throwing`: `{ jobId, state: 'failed', reason: 'corrupt-events' }` → `jobSummary` gives `title: 'corrupt event log'`, `status: 'failed'`; `jobDetail` gives empty `phases`/`attempts`/`artifacts`; no notification entry.
- [ ] **Step 2: Run** `node --test tests/superagent-view-model.test.mjs` → FAIL.
- [ ] **Step 3: Implement** both modules, pure (no `fs`, no registry import). `lastRequestTokens` is the last decision's request estimate as recorded in `router-decided`'s `request` (read the field name from `buildRouterRequest`, `src/superagent/router.js:99`).
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent view model and notification entries`.

### Task 5: Artifact reader with real-path containment

**Files:**
- Create: `src/superagent/artifacts.js`
- Test: `tests/superagent-artifacts.test.mjs`

**Interfaces:**
- Consumes: `artifactPath(job, key)` (Task 4); `primaryRepo(job)` (`src/superagent/results.js`).
- Produces: `export async function readArtifact(job, key, { maxBytes = 1_000_000 } = {}) -> { key, path, text, truncated: boolean }`; throws `ERR_UNKNOWN_ARTIFACT` (key not known), `ERR_ARTIFACT_MISSING` (no file), `ERR_ARTIFACT_OUTSIDE` (real path outside the worktree's real path).

- [ ] **Step 1: Write the failing tests** (temp worktree dir; a second temp dir as "outside"):
  - `reads a known artifact`: write the spec file → `text` matches, `truncated === false`.
  - `refuses an unknown key` → `ERR_UNKNOWN_ARTIFACT`.
  - `a missing file` → `ERR_ARTIFACT_MISSING`.
  - `a linked file pointing outside is refused`: the spec path is a symlink to a file in the outside dir → `ERR_ARTIFACT_OUTSIDE`. On Windows create it with `symlink(target, link, 'file')`; skip the test (`t.skip`) only if symlink creation fails with `EPERM`.
  - `a linked parent directory pointing outside is refused`: `docs/superpowers/jobs/<slug>` is a junction (`symlink(dir, link, 'junction')`) to the outside dir → `ERR_ARTIFACT_OUTSIDE`.
  - `a large file is truncated at maxBytes`: `maxBytes: 10` → `text.length === 10`, `truncated === true`.
- [ ] **Step 2: Run** `node --test tests/superagent-artifacts.test.mjs` → FAIL.
- [ ] **Step 3: Implement:** `realpath` the worktree and the joined artifact path; require `path.relative(realRoot, realFile)` to be non-empty, not starting with `..` and not absolute (case-insensitive compare on win32); then read at most `maxBytes`.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent artifact reader refuses links outside the worktree`.

### Task 6: Superagent host and wiring

**Files:**
- Create: `src/superagent-host.js`, `src/superagent-wiring.js`
- Test: `tests/superagent-host.test.mjs`

**Interfaces:**
- Consumes: `createOwnerLock` (Task 3); supervisor `ownsSession`/`dispose` (Task 2); `superagentNotifications` (Task 4); `createSuperagentConfig`, `createSuperagentStore`, `createSuperagent`, `readUserApiKeyHelper`, `createRouter` (superagent router).
- Produces:
  - `export function createSuperagentHost({ registry, port, root = defaultSuperagentRoot(), lockFactory, configFactory, storeFactory, superagentFactory, routerFactory, stopDeadlineMs = HOST_STOP_DEADLINE_MS, logImpl = console.error }) -> { status(): { state, ownerPort: number|null, error: string|null, router: 'on'|'off' }, init(): Promise<void>, stop(): Promise<void>, afterClose(): Promise<void>, admit(fn): Promise<any>, read(fn): any, ownsSession(id): boolean, notifications(): Entry[] }`
  - Default `routerFactory`: `async () => (await readUserApiKeyHelper()) ? createRouter() : null` (logs `superagent router off: no apiKeyHelper in ~/.claude/settings.json` when null).
  - `admit` rejects with `err.code === 'ERR_SUPERAGENT_UNAVAILABLE'`, `err.state`, `err.ownerPort`, `err.status` (409 for `not-owner`, else 503). `read(fn)` returns `fn(supervisor)` in `ready`/`stopping`, else `null`. `ownsSession` delegates while a supervisor exists, else `false`. `notifications()` is `[]` unless a supervisor exists.
  - `export function wireSuperagent({ shutdown, host, logImpl }) -> Promise<void>`: registers `shutdown.onBeforeClose(() => host.stop())` and `shutdown.onAfterClose(() => host.afterClose())` **before** calling `host.init()`; returns the `init` promise (errors logged, never thrown).

- [ ] **Step 1: Write the failing tests** (fakes for every factory; `COCKPIT_HOME` temp):
  - `init loads config before building the supervisor`: the fake config records `load()` before `superagentFactory` is called; with a saved non-default `maxConcurrentSessions` in a real `createSuperagentConfig` file, the supervisor deps see it via `config.resolve(null)`.
  - `a corrupt config leaves the superagent in error and the rest untouched`: `load()` rejects `ERR_CONFIG_CORRUPT` → `status().state === 'error'`, `error` names the file; `admit` rejects 503; the lock is released.
  - `not owner when another Cockpit holds the lock`: lock fake returns `{ owned: false, owner: { port: 4400 } }` → `state 'not-owner'`, `ownerPort 4400`, `admit` rejects 409, no supervisor built, no store created.
  - `router on only with an apiKeyHelper`: `routerFactory` returning `null` → supervisor deps have `router: null` and `status().router === 'off'`; returning a router → `'on'`.
  - `actions are refused while initialising and admitted once ready`: hold `lock.acquire` on a deferred → `admit` rejects 503 with `state 'initialising'`; resolve → `admit(fn)` calls `fn(supervisor)`.
  - `stop blocks new launches at once and waits for admitted actions`: an admitted `fn` held on a deferred; `host.stop()` → `supervisor.stop` is called synchronously (before `stop()`'s first await), new `admit` rejects 503 `stopping`; `stop()` resolves after the held `fn` resolves.
  - `stop is bounded`: `stopDeadlineMs: 50` (a `createSuperagentHost` option, default `HOST_STOP_DEADLINE_MS = 2500`), an admitted `fn` that never settles and a `supervisor.stop` that never settles → `stop()` resolves within ~50 ms and logs the timeout line; `afterClose()` still releases the lock.
  - `shutdown during initialisation never starts the supervisor`: `stop()` while `acquire` is pending; resolve acquire as owned → no `superagentFactory` call, no `start`, `status().state === 'stopped'` after `afterClose()`, lock released. Same with `stop()` while `config.load()` is pending, and while `routerFactory` is pending.
  - `an init error after stop does not overwrite stopping`: `stop()` during `config.load()`, which then rejects → state stays `stopping` until `afterClose()`.
  - `afterClose drains, disposes, then releases`: call order `drain, dispose, release`.
  - `wireSuperagent registers both hooks before init`: fake shutdown records hook registration; `init` called after both.
- [ ] **Step 2: Run** `node --test tests/superagent-host.test.mjs` → FAIL.
- [ ] **Step 3: Implement** per Decisions 1-2. `init()`: `state='initialising'` → `lock.acquire()` → (not owned → `not-owner`, done) → `config.load()` → `store = storeFactory()` → `router = await routerFactory()` → `supervisor = superagentFactory({ registry, store, config, router })` → `await supervisor.start()` → `ready`, with the `stopRequested` check after each await and before building and starting. Any throw before stop → `error` and release the lock.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent host owns lifecycle, lock, config load and router choice`.

### Task 7: Superagent and notification routes, server wiring

**Files:**
- Create: `src/routes/superagent.js`, `src/routes/notifications.js`
- Modify: `src/routes/autopilot.js:166-169` (remove `/api/notifications`)
- Modify: `src/server.js:18,27-64,242-248,322-334,222` (host, routes, `FORCE_EXIT_MS` 8000 → 10000 with the budget comment from Decision 2, wiring, export)
- Test: `tests/superagent-routes.test.mjs`, `tests/autopilot-routes.test.mjs` (notification route still 401s/200s)

**Interfaces:**
- Consumes: host (Task 6), `jobSummary`/`jobDetail` (Task 4), `readArtifact` (Task 5), `isValidCwd` (`src/session-launcher.js`).
- Produces routes (all operator-gated by the existing `/api/` check):
  - `GET /api/superagent` → `{ status: host.status(), jobs: jobSummary[] }` (jobs `[]` unless readable).
  - `GET /api/superagent/jobs/:id` → `jobDetail(job, { isLive: (sid) => Boolean(registry.get(sid)) })`; 404 `ERR_UNKNOWN_JOB`.
  - `POST /api/superagent/jobs` body `{ idea, title?, primaryRepo, additionalRepos? }` → 200 `jobSummary`; 400 when `idea` is empty or any folder fails `isValidCwd` (`not a directory: <path>`); `title` defaults to the idea's first 8 words.
  - `POST /api/superagent/jobs/:id/answer` `{ text }`, `POST …/accept`, `POST …/stop` → 200 `jobSummary`.
  - `GET /api/superagent/jobs/:id/artifacts/:key` → `{ key, path, text, truncated }`.
  - Error mapping: `ERR_UNKNOWN_JOB`/`ERR_ARTIFACT_MISSING` 404; `ERR_INVALID_STATE` 409; `ERR_INVALID_ANSWER`, `ERR_UNKNOWN_ARTIFACT`, `ERR_ARTIFACT_OUTSIDE`, `ERR_NOT_GIT_REPO`, `ERR_NO_COMMITS`, `ERR_BRANCH_EXISTS`, `ERR_WORKTREE_PATH_EXISTS`, `ERR_DUPLICATE_REPO`, `ERR_INVALID_CONFIG`, `ERR_NO_TEMPLATE`, `ERR_PATH_TOO_LONG`, `ERR_PHASE_KIND_UNSUPPORTED`, `ERR_MODE_UNSUPPORTED` 400; `ERR_SUPERAGENT_UNAVAILABLE` → `err.status`; anything else 500. Body always `{ error, code }` (+ `state`, `ownerPort` for unavailable).
  - `GET /api/notifications` → `{ entries: [...autopilotEntries, ...host.notifications()] }`.
  - `server.js` exports `superagentHost`; `wireSuperagent({ shutdown, host: superagentHost })` is called in the `listen` callback after `wireAutopilot`. The superagent router is imported as `createSuperagentRouter`.

- [ ] **Step 1: Write the failing tests** in `tests/superagent-routes.test.mjs`, registering `registerSuperagentRoutes` and `registerNotificationRoutes` on `createRouter()` (`src/router.js`) behind a bare `http.createServer` in the test, with a fake host whose supervisor is a stub:
  - `GET /api/superagent reports status and summaries`.
  - `POST /api/superagent/jobs passes fields through and defaults the title`: idea `"Add a login page with remember me and more words here"` and no title → `createJob` receives `title: 'Add a login page with remember me and'`, `mode: 'automatic'`, `fixture: null`.
  - `POST /api/superagent/jobs refuses a missing folder`: nonexistent `primaryRepo` → 400 `not a directory: …`; `createJob` not called.
  - `createJob's coded errors come back as 400 with their code`: stub throws `ERR_DUPLICATE_REPO` → 400 `{ code: 'ERR_DUPLICATE_REPO' }`.
  - `a second answer to the same question is a 409 and appends nothing`: stub `answerQuestion` throws `ERR_INVALID_STATE` on the second call → 409.
  - `unavailable host answers with its status`: host `admit` rejects `{ code: 'ERR_SUPERAGENT_UNAVAILABLE', status: 409, state: 'not-owner', ownerPort: 4400 }` → 409 with `ownerPort: 4400`; with `status: 503, state: 'initialising'` → 503.
  - `artifact route maps reader errors`: `ERR_ARTIFACT_OUTSIDE` → 400; `ERR_ARTIFACT_MISSING` → 404.
  - `notifications merge both sources`: autopilot returns one entry, host returns one → two entries, autopilot's first.
  - In `tests/autopilot-routes.test.mjs`, the existing `/api/notifications` 401 assertion stays and a 200 assertion confirms `{ entries: [] }` through the real server (host is `off`).
- [ ] **Step 2: Run** `node --test tests/superagent-routes.test.mjs tests/autopilot-routes.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the two route modules and the `server.js` changes. Every action route goes through `host.admit`; GETs go through `host.read`.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass (server-importing tests must still not touch the real home: the host stays `off` because `wireSuperagent` only runs in the `listen` callback of a real start).
- [ ] **Step 5: Commit** `feat: superagent routes, merged notifications and server wiring`.

### Task 8: Watch-only worker sessions and supervisor-owned attach

**Files:**
- Create: `src/ws-input.js`
- Modify: `src/server.js:55,61,170-214` (ownership predicate, ws handler)
- Modify: `src/routes/sessions.js:42,157-180,202-213`
- Modify: `src/routes/session-actions.js:20-30`
- Test: `tests/watch-only.test.mjs`, `tests/server-auth.test.mjs`

**Interfaces:**
- Consumes: `superagentHost.ownsSession(id)` (Task 6).
- Produces:
  - `registerSessionRoutes(router, { isSupervisorOwned, isWatchOnly })`: `GET /api/sessions/:id` adds `watchOnly: isWatchOnly(id)` to the summary; `DELETE /api/sessions/:id` refused for watch-only (403 body from Global Constraints); attach-token allowed when `isSupervisorOwned(id)` and returns `{ id, token, watchOnly }`; its 403 message becomes `attach-token is only available for auto-pilot and superagent sessions`.
  - `registerSessionActionRoutes(router, { isWatchOnly })`: after the token check, any non-`GET` request on a watch-only session → 403 watch-only body.
  - `export function handleClientMessage({ id, payload, ws, registry, isWatchOnly, logImpl })` in `src/ws-input.js`: the existing body of `ws.on('message')` verbatim, preceded by: if `isWatchOnly(id)` and `payload.type` is one of `input`, `queue-remove`, `queue-reorder`, `queue-send-now`, `delegate` → `ws.send(JSON.stringify({ type: 'cockpit:watch-only', error: 'superagent worker sessions are watch only' }))` and return.
  - `server.js`: `isSupervisorOwned = (id) => isPilotOwned(id) || superagentHost.ownsSession(id)`; `isWatchOnly = (id) => superagentHost.ownsSession(id)`.

- [ ] **Step 1: Write the failing tests** in `tests/watch-only.test.mjs` (registry rows via `registry.createSession({ cwd, startSessionImpl: fakeStartSession })` as in `tests/server-auth.test.mjs`; routes on a bare router; `isWatchOnly` a Set lookup):
  - `every mutating session action is refused for a watch-only session`: for each `POST`/`DELETE` action in `session-actions.js` (`mode`, `interrupt`, `force-idle`, `mcp-toggle`, `mcp-reconnect`, `reload-plugins`, `plugin-enabled`, `git-guard`, `handshake`, `model`, `permissions` DELETE, `title`, `effort`, `thinking`, `auto-continue`, `approval-decision`, `rewind`) → 403 `ERR_WATCH_ONLY`, and the registry method behind it was not called.
  - `reads stay allowed`: `GET models`, `GET diff`, `GET earlier-history`, `GET /api/sessions/:id` → not 403; the summary has `watchOnly: true`.
  - `DELETE /api/sessions/:id is refused for a watch-only session` and the row survives.
  - `a session that is not watch-only is unaffected`: `POST title` → 200.
  - `ws input is refused for a watch-only session`: `handleClientMessage` with each refused `payload.type` → `registry.sendInput` (etc.) not called, one `cockpit:watch-only` frame sent; a non-watch-only id → `sendInput` called.
  - In `tests/server-auth.test.mjs`: the existing attach-token tests still pass (message still matches `/auto-pilot/i`), plus `attach-token reports watchOnly false for a pilot session`.
- [ ] **Step 2: Run** `node --test tests/watch-only.test.mjs tests/server-auth.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** Move the ws body into `ws-input.js` unchanged apart from the gate; `server.js` calls `handleClientMessage({ id, payload, ws, registry, isWatchOnly })` after parsing.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent worker sessions are watch only; attach admits supervisor-owned sessions`.

### Task 9: Browser-notification de-duplication (shared)

**Files:**
- Create: `src/notify-dedupe.js`
- Modify: `src/static-files.js:16` (`SHARED_SRC_FILES` adds `notify-dedupe.js`)
- Test: `tests/notify-dedupe.test.mjs`

**Interfaces:**
- Produces:
  - `export function planNotifications({ entries, record, firstPoll }) -> { notify: Entry[], record: string[] }`. `entries` are superagent entries (`key` present); `record` is the shared list of keys already notified. Returns the entries to notify now and the next record (current keys only, so it never grows past the open entries).
  - `export async function claimNotifications({ entries, firstPoll, storage, locks }) -> Entry[]`: inside `locks.request('cockpit:notify', fn)` when `locks` is given (else directly), reads `storage.getItem('cockpit:notifiedKeys')` (`[]` if absent or unparseable), runs `planNotifications`, writes the new record with `storage.setItem`, and returns `notify`. The browser passes `localStorage` and `navigator.locks`.

- [ ] **Step 1: Write the failing tests:**
  - `first poll records but does not notify`: `firstPoll: true`, two entries, empty record → `notify: []`, `record` = both keys.
  - `a new entry notifies once`: record `[k1]`, entries `[k1, k2]` → `notify` = `[k2]`, record `[k1, k2]`; same call again with the returned record → `notify: []`.
  - `a second tab sees the first tab's record`: tab A returns record `[k1, k2]`; tab B (not first poll) with that record and the same entries → `notify: []`.
  - `record is pruned to current entries`: record `[k0, k1]`, entries `[k1]` → record `[k1]`.
  - `overlapping claims from two tabs notify once`: a shared in-memory `storage` with an async `getItem` delay, and a fake `locks` that serialises `request` callbacks (a promise chain); two `claimNotifications` calls started together with the same new entry → the results' combined length is 1. The same two calls with `locks: undefined` and the delay may both notify — assert nothing about that case beyond not throwing (it is the documented fallback).
  - `unparseable record counts as empty`: `storage` holding `"{"` → treated as `[]`, then overwritten with a valid record.
  - `served to the browser verbatim`: `GET /notify-dedupe.js` through `serveStatic` returns the file's bytes (follow the existing shared-file test for `autopilot-schedule.js`, if present; otherwise call `serveStatic` with a fake `res`).
- [ ] **Step 2: Run** `node --test tests/notify-dedupe.test.mjs` → FAIL.
- [ ] **Step 3: Implement** (pure, no DOM, no Node imports — it must load in the browser).
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: shared de-duplication for browser notifications`.

### Task 10: Frontend: entry point, watch-only tab, bell, badge, browser notifications

**Files:**
- Create: `public/entry.js`
- Modify: `public/index.html:38,577` (Superagent button next to the bell; script `/entry.js`)
- Modify: `public/app.js` (watch-only mode on rejoin; Superagent button opens the view)
- Modify: `public/notifications-panel.js`
- Modify: `public/style-autopilot.css` or `public/style-base.css` (badge, watch-only banner) — builder's pick, matching neighbours
- Test: hand-verified (no jsdom); record in `tests/README.md` in Task 12

**Interfaces:**
- Consumes: `GET /api/sessions/:id` `watchOnly` (Task 8); `/api/notifications` superagent entries (Task 7); `planNotifications` from `/notify-dedupe.js` (Task 9).
- Produces: `initNotificationsPanel({ button, panel, headerEl, onOpenPilots, superagentButton })` — `superagentButton` gets a red badge with the count of `kind === 'superagent'` entries; superagent rows are clickable and open/focus `/?view=superagent&job=<jobId>` in a tab named `cockpit-superagent` (`window.open(url, 'cockpit-superagent')`). Exported `requestBrowserNotifications()` for the view's control. The bell button's title copy drops "Auto-pilot" (`… item(s) need your attention` / `Notifications`).

- [ ] **Step 1: `public/entry.js`:** if `new URL(location.href).searchParams.get('view') === 'superagent'`, add class `view-superagent` to `<body>` and `import('/superagent-view.js')` then call its `initSuperagentView()`; else `import('/app.js')`. `index.html` loads `/entry.js` as its only module script.
- [ ] **Step 2: Watch-only tab in `app.js`:** in `rejoinActiveSession` read the summary JSON; when `watchOnly` is true add class `watch-only` to `<body>` and show a one-line banner `Superagent worker — watch only`. CSS for `body.watch-only` hides the compose form, the queue panel's mutating controls, the approval banner buttons, rewind controls and session-control buttons that POST. A `cockpit:watch-only` frame (Task 8) shows the same banner if it ever arrives.
- [ ] **Step 3: Bell and badge:** extend `notifications-panel.js` as in Interfaces. On every successful poll, when `Notification.permission === 'granted'`, call `claimNotifications({ entries: superagentEntries, firstPoll, storage: localStorage, locks: navigator.locks })` (`firstPoll` true only for this tab's first successful poll), and show `new Notification(entry.message, { tag: entry.key })` for each `notify` entry; its `onclick` focuses/opens the Superagent tab for that job. Never ask for permission here.
- [ ] **Step 4: Superagent button** in the top bar of every tab: label `Superagent`, opens `/?view=superagent` in the `cockpit-superagent` tab.
- [ ] **Step 5: Hand-verify** with `npm start`: a normal tab still boots, rejoins its session after a reload, and shows the bell and the Superagent button. Opening the view itself is verified in Task 11, which creates `superagent-view.js`. Run `npm test` → all pass.
- [ ] **Step 6: Commit** `feat: superagent entry point, bell entries, badge and browser notifications`.

### Task 11: Frontend: the Superagent view

**Files:**
- Create: `public/superagent-view.js`, `public/style-superagent.css`, `tests/superagent-view-fixture.manual.mjs`
- Modify: `public/index.html` (link `style-superagent.css`; a `#superagentView` container hidden unless `body.view-superagent`; CSS hides the transcript UI in that mode)
- Test: hand-verified; record in `tests/README.md` in Task 12

**Interfaces:**
- Consumes: routes (Task 7); `initOperatorGate` (`public/operator-auth.js:64`), `initDirBrowser` (`public/dir-browser.js:6`), `initNotificationsPanel` (Task 10).
- Produces: `export function initSuperagentView()`.

- [ ] **Step 1: Shell.** `initSuperagentView` initialises the operator gate, the bell (with `superagentButton`), the folder browser, and the three panes inside `#superagentView`. Polls `GET /api/superagent` and, when a job is selected, `GET /api/superagent/jobs/:id`, every 5 s while `document.visibilityState === 'visible'`. `?job=<id>` selects on load; selection updates the URL with `history.replaceState`.
- [ ] **Step 2: Status states.** `initialising` → "Starting…"; `not-owner` → the not-owner notice with link (Global Constraints copy); `error` → the error text; `off`/`stopping`/`stopped` → "Superagent is not running". Panes render only in `ready`.
- [ ] **Step 3: Left pane.** Rows from `jobs`: title, `phaseId`, status label (`running`, `needs you`, `done`, `stopped`, `failed`, `provisioning`); unfinished first, newest first within each group. **+ New job** form: idea (textarea, required), title (optional), primary folder (folder browser), additional folders (add/remove list via the folder browser), the fixed text `Mode: Automatic`. Submit → `POST /api/superagent/jobs`; errors render inline under the form from `{ error, code }`.
- [ ] **Step 4: Middle pane.** Phase chips by status; task checklist; attempts list with role · model · outcome · `n/cap` · round, and an **open** link while `live` (`window.open('/?attach=' + sessionId, '_blank')`); artifact links open a read-only viewer (a `<dialog>` with the text in a `<pre>`, or the markdown renderer `stream-view.js` already uses, builder's pick) fed by the artifact route; branch per repo; **Stop job** while the job is not `done`/`stopped`/`failed` (confirm dialog).
- [ ] **Step 5: Right pane.** Needs-you per `needsYou.type`: question → text, answer `<textarea maxlength=4000>`, **Send** (disabled when empty after trim), **Stop**; budget question (`answerable: false`) → text and **Stop**; ready-to-try → branches, the `testReport` artifact text and the brief's `## Assumptions made for you` section (fetched via the artifact route; the section is the text from that heading to the next `## ` heading) when the job has a `brief` artifact, **Accept**, **Stop**; stuck → reason and detail, **Stop**. Router panel: model, calls, last request size vs `maxInputTokens`, decision log (event → action → note); `Router off: no apiKeyHelper` when `status.router === 'off'`. A browser-notification control: "Enable browser notifications" → `requestBrowserNotifications()`; hidden once granted, shows "Blocked in browser settings" when denied.
- [ ] **Step 6: Text only.** Every server-supplied string goes through `textContent`; no `innerHTML` with server data.
- [ ] **Step 7: Hand-verify** with `npm start` under a temp `COCKPIT_HOME`, without launching any worker: status states (start a second Cockpit on another `PORT` for the not-owner notice), form errors (plain dir, repo with no commits, duplicate repo — all refused before a job exists), an empty job list, and the bell/badge with no entries. Then seed jobs with a new `tests/superagent-view-fixture.manual.mjs <cockpitHome> <repoDir>` (not in `npm test`): it provisions real worktrees in `<repoDir>` and writes event logs, using the `tests/superagent-helpers.mjs` builders, for four jobs that launch nothing on start: `needs-you/question`, `needs-you/ready-to-try` (with a brief and a test report committed in its worktree), `needs-you/stuck`, `done`. Verify the populated panes, artifact viewer, bell entries, badge, notification click, Accept and Stop. Also verify: opening the view from a tab with an active session does not rejoin that session in the Superagent tab, and the view survives a reload. Browser notification: grant permission in a Superagent tab while Cockpit runs with no needs-you jobs (so that tab's first successful poll records nothing); stop Cockpit, keeping the tab open; seed the fixture; start Cockpit again → the tab's next successful poll is not its first, so exactly one notification appears per seeded entry, also with a second Cockpit tab open. **Answering the question resumes the job and launches a paid worker: ask the user before doing it.** Creating a real job does the same. Run `npm test` → all pass.
- [ ] **Step 8: Commit** `feat: the Superagent view`.

### Task 12: Docs and the deferred-work record

**Files:**
- Modify: `CLAUDE.md` (Superagent paragraph; `public/` module list; ownership and notification sentences; four state stores paragraph: `owner.lock`)
- Modify: `README.md` (Status; new section `## Superagent view (Plan 6)` after `:443`)
- Modify: `tests/README.md` (unit-tested vs hand-verified per feature from Tasks 1-11)
- Modify: `backlog.md` (new section `## Superagent — planned for later plans`)

- [ ] **Step 1: `backlog.md`:** add the section with one entry per row of the design's "Non-goals (for Plan 6) — and where each one goes" table (Pause/Resume; spend and budget override; answering budget questions; Give feedback; Retry on stuck; manual mode and Hand over; router-written notification text; settings modal; offer `git init`; read-only view in a second Cockpit; stepping into a worker session; base verifier evidence after an extra round), each naming its later plan.
- [ ] **Step 2: `CLAUDE.md`:** the Superagent paragraph no longer says "not wired into `src/server.js`" or lists "any UI" as missing; it names the host, the owner lock, watch-only, the routes, and what is still missing (the deferred list, briefly). Add `superagent-view.js` and `entry.js` to the frontend list; `notify-dedupe.js` to the shared-files sentence; `owner.lock` to the `superagent/` file list.
- [ ] **Step 3: `README.md` and `tests/README.md`** as listed.
- [ ] **Step 4: Sweep:** `grep -rn "not wired into\|isPilotOwned\|Auto-pilot notifications" src public CLAUDE.md README.md tests` — every hit is either updated or deliberately kept (auto-pilot-specific code). Run `npm test` → all pass.
- [ ] **Step 5: Commit** `docs: superagent view, wiring and the deferred-work backlog`.

## Revision 2 changes

1. **Bounded, cancellable host lifecycle** (Important 1, 2): `stop()` blocks launches synchronously, then waits at most `HOST_STOP_DEADLINE_MS = 2500` so shutdown always reaches the session-close pass; `init()` checks for a stop after every await and never builds or starts a supervisor once stop began; `FORCE_EXIT_MS` 8000 → 10000. Decision 2, Task 6 tests, Task 7 files.
2. **Atomic cross-tab claim** (Important 3): `claimNotifications` runs read-compute-write inside a Web Lock, with a tag-only fallback; tested with overlapping calls. Decision 8, Task 9, Task 10.
3. **Owner-lock takeover without a reclaimable mutex** (Important 4): rename-to-claim, verify the claimed token, `link` back a lock moved by mistake; interleaving tests via injected fs. Decision 4, Task 3.
4. **Repeated stop stays idempotent** (Important 5): Review Focus 2 now says a second stop is a 200 that appends nothing; a real-supervisor test pins answer/accept/stop repeats. Task 1.
5. **Verification moved to where the code exists** (Minor 6, 7): opening the view is verified in Task 11; the browser-notification check keeps the tab open across a Cockpit restart so its next poll is not its first.
