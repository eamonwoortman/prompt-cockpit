# Superagent Plan 3 — Review Loops, Per-Task Implementation and Test Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** 1.

**Goal:** Extend the Plan 2 library under `src/superagent/` so a job can run the named `milestone-2` fixture pipeline end to end with fake workers: `spec → spec-review → plan → plan-review → implement → test → accept`. That adds review loops (reviewer, author fix, round cap, verifier at the cap), per-task implementation with a task reviewer, test-failure routing (a failed tester appends a fix task and re-runs implement then test), the eight role templates, and a stricter result contract. It is still not wired into `src/server.js`, and it still has no router, stand-in, usage ledger, usage-cap handling or UI.

**Architecture:** The Plan 2 shape is kept: `nextAction` in `sequencer.js` stays a pure function of the derived job, `runner.js` still launches and watches one attempt per job, `index.js` executes the sequencer's actions. What changes is that a phase is no longer "one author attempt". Each attempt now carries a `purpose` (`author | review | fix | verify | implement | task-review | test`) and a `round`; one pure helper, `reviewLoop`, drives both a review phase and a task's implement/review cycle; and four new events (`tasks-loaded`, `fix-task-added`, `phase-completed`, `phase-rewound`) make multi-attempt phase progress derivable from `events.jsonl` alone.

**Tech Stack:** Node 18+ ESM, no framework, no bundler; `@anthropic-ai/claude-agent-sdk` 0.3.231 (unchanged); `git` CLI; tests with `node --test` (`npm test` = `node --test tests/*.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-03-superagent-design.md` (revision 3), "Suggested sequencing" step 2 minus the router. Plan 2: `docs/superpowers/plans/2026-11-03-superagent-p2-core-runner.md`. Probe result that shapes this plan: in `auto` mode the SDK did not call `canUseTool` for Bash (commit `367460d`).

## Scope split (author's call, stated up front)

The spec's sequencing step 2 bundles five things. This plan builds four of them; the **isolated router** (spec "The router", "Isolation", auth route, re-measuring the 6000-token baseline) is **Plan 4**. It is a separate subsystem with its own paid spike (the auth route is untested) and nothing in this plan needs it: failed attempts keep Plan 2's code-only retry (retry as-is, back-off, caps, repeated-error stop). The **brainstorm phase** and the stand-in stay in the later automatic-brainstorm plan, so the full default pipeline is still not runnable; `milestone-2` is a named fixture exactly as `milestone-1` was (Plan 2 Decision 9).

## Global Constraints

- Work only on branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`; `feature/auto-pilot` is not modified.
- No new npm dependencies; plain ESM; no build step; do not commit `package-lock.json` changes (`git checkout -- package-lock.json` first).
- Baseline is `npm test` = 807 passing; it stays green after every task. Tests are no-network, no real CLI, no real model.
- NO `Co-Authored-By` trailer on any commit (the user removed trailers from this branch). Conventional prefix only; write commits with `git commit -F- <<'EOF' ... EOF` and no trailer. Files are LF.
- Edits are confined to `src/superagent/`, `prompts/superagent/`, `tests/`, and Task 10's docs. `src/server.js`, `src/session.js` and `src/session-registry.js` are NOT touched.
- Claude only (`provider: 'claude'`); model ids `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`; never push, PR or merge; never delete a worktree or branch; never write a project's `.claude/settings*.json`.
- Real `git` in temp repos is allowed in tests (helpers in `tests/superagent-helpers.mjs`); every test repo sets `user.email`/`user.name`. Every async registry call is awaited or caught.
- Facts the plan must respect, all **Confirmed** in the code: `auto` mode does not route Bash through `canUseTool`, so the deny rule never blocks `git commit` and never constrains ordinary tools (so reviewer and verifier read-only-ness is a prompt rule, not an enforced one); `validateResult` already validates `verdict`/`findings` for any attempt whose phase has `kind: 'review'` (`results.js:161`); required outputs must be committed by a *listed primary-repo commit* and clean (`results.js:204-247`); a rejected store append may have landed (`index.js` header).
- The only manual probe (Task 10) is written, not run, by implementers. The user has said spend is not a constraint for this plan's planning and execution; the controller runs it after the final review.

## Review Focus

1. **A review loop must terminate and never exceed `maxRounds` reviewer passes,** whatever the reviewers and authors return, including attempts that fail and are retried. (Task 5, `reviewLoop` boundary tests; Task 9, `a reviewer that always answers changes stops at the cap`.)
2. **The verifier runs only for contested blockers at the cap, and a verified blocker is the only thing that reaches the user.** An unverified blocker proceeds as "disputed, not verified". (Task 5, Task 9.)
3. **A reviewer cannot approve its way past an open blocker, and a fixer cannot claim `fixed` for a finding it was never given.** Both are invalid results. (Task 3.)
4. **Test-failure routing appends exactly one fix task per failed tester attempt, even when the supervisor restarts or the same tick replays,** and it stays bounded by the phase attempt cap. (Task 5 `routeTestFailure` idempotence; Task 9 replay test.)
5. **A broken `tasks.json` must be refused when the planner publishes it, not discovered at implement time:** unknown `dependsOn`, a cycle, a duplicate or unsafe id, an unknown repo. Otherwise the implement phase deadlocks. (Task 4.)

---

## Decisions the spec leaves to the builder

1. **Fixture, not composition.** `milestone-2` is a frozen named pipeline in `config.js` (seven phases, no `brainstorm`; `spec` takes `['idea']`). `createJob({ fixture: 'milestone-2' })` is its only entry. The default pipeline with `brainstorm` is still rejected at `createJob`, now with a clear error because `brainstormer` has no template (Decision 11).
2. **Attempt purpose and round.** `attempt-started` gains `purpose` and `round`. Plan 2 attempts are read as `purpose: 'author'`, `round: null` when the fields are absent (so Plan 2 event logs replay unchanged).
3. **Phase completion events.** Author phases still advance on an attempt's `done` (Plan 2 behaviour, unchanged). Review and per-task phases advance only on `phase-completed { phase, unresolved }`, which the supervisor appends when the sequencer returns `complete-phase`. `phase-rewound { to }` sets `phaseIndex` back (test routing). Both are idempotent in `deriveJob`: an event naming a phase other than the current one for `phase-completed` is ignored.
4. **One loop helper for two uses.** `reviewLoop(attempts, { initial, maxRounds, failedCap })` in `sequencer.js` serves a review phase (`initial: null`; reviewer then author-fix) and a task (`initial: 'implement'`; implementer, task-reviewer, implementer-fix). Its result is one of `{ launch: { purpose, role: 'review'|'author', round, final } }`, `{ complete: { unresolved } }`, `{ verify: {...} }`, `{ question: {...} }`, `{ stuck: why }`. The sequencer maps those onto the phase's roles and models.
5. **Rounds.** A round is one *completed* (`done`) reviewer attempt. Round *n* of the author fix follows reviewer round *n*. Failed attempts do not advance a round; they count against `failedCap` (`attemptsPerPhase` for a phase, `attemptsPerTask` for a task).
6. **The cap round.** After reviewer round `maxRounds` returns `changes`, the author still gets one **final** fix attempt (it records dispositions and, for a review phase, appends the unresolved findings to the artifact under "Unresolved review findings"). There is no reviewer pass after it.
7. **What "contested" means at the cap.** A `blocker` in the last reviewer round is *contested* unless the final fix's result lists the same finding id with `disposition: 'fixed'`. Contested blockers (declined, open or unlisted) go to **one verifier attempt**. A verifier result `verified: [{ id, verified: boolean, evidence }]` for every contested id decides: any `verified: true` → `needs-you(question)` carrying the blocker text and the verifier's evidence; none → complete with those blockers recorded as `disputed-not-verified`. All non-blocker findings that are not `fixed` are recorded as `open` or `declined`. The record is the `unresolved` list on the `phase-completed` event; the artifact itself is only edited by the author's final pass.
8. **Task review reuses the same machinery** with `maxRounds = phase.maxRounds ?? limits.taskReviewRounds` (new limit, default 2) and the same verifier. A task with no `taskReview` role is done when its implementer attempt is `done`.
9. **Tasks live in events.** The planner's `tasks.json` is validated at publish time (Task 4) and copied into a `tasks-loaded` event when the implement phase starts. Fix tasks from test routing are `fix-task-added` events, **not** edits to `tasks.json` (the spec says to append to the file; a supervisor editing a worker's committed file races its commits, so the event log is the source of truth and the view reads the derived list). Ledger it as a ruling.
10. **Test routing.** A tester result with `status: 'failed'` must carry `findings` (id, severity, text). The sequencer returns `route-test-failure { attemptId, findings }` for the last `test` attempt when it failed with findings and no fix task already has `fromAttemptId` equal to it. The supervisor appends one `fix-task-added` plus `phase-rewound { to: 'implement' }`. Each routed failure consumes one `test` attempt, so `attemptsPerPhase` bounds the cycle; at the cap → `needs-you(stuck)`.
11. **Role templates required at job creation.** `createJob` rejects a pipeline whose roles (including `author`, `taskReview`) lack a prompt template (`hasTemplate`), with `ERR_NO_TEMPLATE`. A project override file satisfies it. `verifier` is always required when the pipeline has a review or per-task phase.
12. **Review verdict rules (results).** `verdict: 'approve'` with any finding whose `severity` is `blocker` and `disposition` `open` is invalid. A `fix` result's findings must reference only ids given in the round's review file (the validator reads the review attempt's recorded findings from the job) and must not use `open` for blockers on a non-final fix. A `verify` result must cover exactly the contested ids.
13. **Failure signature for worker-reported failures.** `outcomeForResult` gets the result summary's first line as the signature detail, so `repeated-error` can trip for `failed`/`blocked` (Plan 2 parked it).
14. **Windows path guard.** `createJob` on win32 computes the longest attempt-directory path it can produce and rejects with `ERR_PATH_TOO_LONG` above 240 characters, naming `COCKPIT_HOME` as the fix. Task ids are capped at 24 characters and phase ids at 24 so the bound is real.
15. **Artifact paths added** (all under the primary worktree, all committed, `artifactPaths`-style): reviews `docs/superpowers/jobs/<slug>/reviews/<phase>-r<round>.md` (review), `…/<phase>-r<round>-response.md` (author fix), `…/<phase>-verify.md` (verifier); tasks `docs/superpowers/jobs/<slug>/tasks/<taskId>-report.md` (implement and fix), `…/<taskId>-review-r<round>.md` (task review), `…/<taskId>-verify.md`.

## Not in this plan

Router and its auth route (Plan 4); brainstorm, stand-in and manual handover; usage ledger, budgets and usage-cap pause/resume; the feedback route and an answer/resume path for `needs-you(question)` (a verified blocker parks the job exactly like Plan 2's question does — no way out until the server/feedback plans); server wiring and the UI; worktree removal; the Plan 2 deferred items not named here (never-settling `budgetCheck`, `start()` swallowing `listJobIds`, `stopJob` slot leak).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/superagent/config.js` (modify) | `MILESTONE_2_PIPELINE`, fixture registry, `taskReviewRounds` default |
| `src/superagent/store.js` (modify) | new event types; `deriveJob` attempt fields, `tasks`, phase events |
| `src/superagent/results.js` (modify) | per-purpose schemas, `requiredOutputs`, `parseTasks`, implement/verify evidence |
| `src/superagent/sequencer.js` (modify) | `reviewLoop`, task selection, `routeTestFailure`, extended `nextAction`, `RUNNABLE_KINDS` |
| `src/superagent/prompts.js` (modify) | job card fields for purpose, round, target, task, review inputs |
| `prompts/superagent/*.md` (create/modify) | `planner`, `spec-reviewer`, `plan-reviewer`, `implementer`, `task-reviewer`, `tester`, `verifier`; update `spec-writer`, `contract.md` |
| `src/superagent/runner.js` (modify) | carry `purpose`/`round`, richer `attempt-ended` payload, expected outputs |
| `src/superagent/index.js` (modify) | execute new actions, load tasks, fixture, template and path preflight |
| `tests/superagent-*.test.mjs`, `tests/superagent-helpers.mjs` (modify/create) | per task |
| `tests/superagent-pipeline.manual.mjs` (create) | unrun manual probe |

---

### Task 1: Config — `milestone-2` fixture, `taskReviewRounds`, fixture registry

**Files:** Modify `src/superagent/config.js`, `tests/superagent-config.test.mjs`.

**Interfaces:**
- Produces: `export const MILESTONE_2_PIPELINE` (deep-frozen); `export const FIXTURES = { 'milestone-1': MILESTONE_1_PIPELINE, 'milestone-2': MILESTONE_2_PIPELINE }`; `export function validateMilestoneFixture(d, name = 'milestone-1')` (second arg selects the fixture; unknown name throws `Error`); `defaultConfig().limits.taskReviewRounds === 2`.
- `MILESTONE_2_PIPELINE` phases, in order: `spec` (author, `spec-writer`, inputs `['idea']`, outputs `['spec']`); `spec-review` (review, `spec-reviewer`, `author: 'spec-writer'`, `target: 'spec'`, `maxRounds: 3`); `plan` (author, `planner`, inputs `['spec']`, outputs `['plan','tasks']`); `plan-review` (review, `plan-reviewer`, `author: 'planner'`, `target: 'plan'`, `maxRounds: 3`); `implement` (per-task, `implementer`, `taskReview: 'task-reviewer'`, inputs `['tasks']`); `test` (author, `tester`, inputs `['spec','tasks']`, outputs `['testReport']`); `accept` (human, inputs `['testReport']`). Frozen like `freezePhase` (inputs/outputs arrays frozen too).

- [ ] **Step 1: Failing tests** in `tests/superagent-config.test.mjs`:
  - `milestone-2 fixture validates against defaults` — `validateMilestoneFixture(defaultConfig(), 'milestone-2').errors` is `[]`.
  - `milestone-2 fixture is deep-frozen and has no brainstorm phase` — `Object.isFrozen` on the array, each phase, each phase's `inputs`; no phase id `brainstorm`.
  - `milestone-2 phase order and contracts` — assert the exact seven phase ids in order, and that `plan` outputs `['plan','tasks']`.
  - `an unknown fixture name throws` — `validateMilestoneFixture(defaultConfig(), 'nope')` throws.
  - `a models map missing task-reviewer fails milestone-2 validation` — delete `models['task-reviewer']`, expect an error with path `pipeline[5].taskReview`.
  - `taskReviewRounds defaults to 2 and rejects 0` — `defaultConfig().limits.taskReviewRounds === 2`; `validateDefaults` with `limits.taskReviewRounds = 0` has an error at `limits.taskReviewRounds`.
  - Existing milestone-1 tests still pass unchanged (the default arg keeps `validateMilestoneFixture(d)` working).
- [ ] **Step 2: Run** `node --test tests/superagent-config.test.mjs`; expect the new tests FAIL.
- [ ] **Step 3: Implement** the exports above. `validateMilestoneFixture(d, name = 'milestone-1')` looks the name up in `FIXTURES` (own-property check) and validates `{ ...d, pipeline: FIXTURES[name] }` with `composition: false`. Add `taskReviewRounds: 2` to `defaultConfig().limits` (the existing positive-integer check covers it).
- [ ] **Step 4: Run** the config tests, then `npm test`; expect all green.
- [ ] **Step 5: Commit** `feat: milestone-2 fixture pipeline and taskReviewRounds limit`.

### Task 2: Store — new events and derived fields

**Files:** Modify `src/superagent/store.js`, `tests/superagent-store.test.mjs`, `tests/superagent-helpers.mjs` (add event builders).

**Interfaces:**
- `EVENT_TYPES` gains `'tasks-loaded'`, `'fix-task-added'`, `'phase-completed'`, `'phase-rewound'`.
- `attempt-started` accepts optional `purpose` (default `'author'`) and `round` (default `null`); the derived attempt gains `purpose`, `round`, `verdict: null`, `findings: null`, `commits: []`, `verified: null`.
- `attempt-ended` accepts optional `verdict`, `findings`, `commits`, `verified`; all stored on the attempt.
- `deriveJob` result gains `tasks: null | Task[]` where `Task = { id, title, repos, dependsOn, acceptance, verify, origin: 'plan' | 'test', fromAttemptId: string | null }`.
- Event shapes: `tasks-loaded { tasks: Task[] }` (ignored if `tasks` is already non-null — idempotent); `fix-task-added { task: Task }` (ignored if a task with that `id` exists); `phase-completed { phase, unresolved: [] }` (sets `phaseIndex` to the phase's index + 1 only if `phase` equals the current phase id; otherwise ignored); `phase-rewound { to, reason }` (sets `phaseIndex` to the index of `to`; unknown `to` ignored).
- Author auto-advance changes: `attempt-ended` `done` advances `phaseIndex` only when the phase's `kind` is `author` (Plan 2 behaviour for author phases is unchanged).
- Helpers: `export const taskCreated = (id, over)`, `export const ev = { tasksLoaded(tasks), fixTaskAdded(task), phaseCompleted(phase, unresolved), phaseRewound(to) }` in `superagent-helpers.mjs` returning event objects.

- [ ] **Step 1: Failing tests** (`tests/superagent-store.test.mjs`), each building events by hand and calling `deriveJob`:
  - `a Plan 2 attempt without purpose derives as purpose author, round null`.
  - `attempt-started purpose and round are kept; attempt-ended verdict, findings, commits and verified are kept`.
  - `tasks-loaded sets tasks; a second tasks-loaded is ignored`.
  - `fix-task-added appends a task once per id`.
  - `phase-completed advances only when it names the current phase` (naming a later phase → `phaseIndex` unchanged).
  - `phase-rewound moves phaseIndex back; an unknown phase is ignored`.
  - `a done review or per-task attempt does not advance phaseIndex, a done author attempt does`.
  - `store.append accepts the new event types and persists them across load` (use `createSuperagentStore` on a temp dir; append `tasks-loaded`, reload, `job.tasks.length`).
- [ ] **Step 2: Run** `node --test tests/superagent-store.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement** in `deriveJob`'s switch. Keep unknown event types a no-op as now.
- [ ] **Step 4: Run** store tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: store events and derived fields for review loops and per-task phases`.

### Task 3: Results — purposes, required outputs, review/fix/verify/test schemas

**Files:** Modify `src/superagent/results.js`, `tests/superagent-results.test.mjs`.

**Interfaces:**
- Consumes: Task 2 attempt fields.
- Produces:
  - `artifactPaths(job)` unchanged; add `export function reviewPaths(job, { phase, round, taskId })` returning `{ review, response, verify, report, taskReview, taskVerify }` as the relative paths in Decision 15 (round-less keys use `round` only where listed).
  - `export function requiredOutputs(job, { phase, purpose, round = null, task = null })` → `string[]` of relative paths. `author` and `test` → the phase's `outputs` mapped through `artifactPaths`; `review` → `[review]`; `fix` (review phase) → `[response]`; `verify` → `[verify]` (phase scope) or `[taskVerify]` (task scope); `implement` and task `fix` → `[report]`; `task-review` → `[taskReview]`.
  - `validateResult(value, { expected, phase, job, git, attempt })` — new optional `attempt: { purpose, round, task, contested?, reviewFindings? }`. Without `attempt` the Plan 2 behaviour is exactly preserved (all Plan 2 tests pass untouched).
  - `outcomeForResult(result)` returns `{ outcome:'failed', reason, signature }` for `failed`/`blocked` (Decision 13) and includes `verdict`, `findings` for any result that has them, `verified` when present.
- Schema rules by `attempt.purpose` (errors as strings, like the existing validators):
  - `review` and `task-review`: `verdict` ∈ approve|changes and `findings` array required; `approve` with any `blocker` finding whose disposition is `open` is invalid (Decision 12); `changes` must list at least one finding.
  - `fix`: `findings` required; each `id` must appear in `attempt.reviewFindings` (ids of the round's review); a `fixed` disposition on an id not given is invalid; `verdict` ignored.
  - `verify`: `verified` required: array of `{ id: string, verified: boolean, evidence: non-empty string }`; the id set must equal `attempt.contested` exactly (no missing, no extra, no duplicates).
  - `test`: when `status === 'failed'`, `findings` must be a non-empty array of `{ id, severity, text }` (no disposition required).
  - Required outputs for `status === 'done'` come from `requiredOutputs` when `attempt` is given, else from `phase.outputs` (Plan 2 path). A `review`/`task-review` with `status: 'done'` must commit its review file like any output.

- [ ] **Step 1: Failing tests** (`tests/superagent-results.test.mjs`; reuse its repo/commit helpers):
  - `requiredOutputs maps each purpose to its path` (table test over all seven purposes).
  - `reviewPaths builds round and task scoped paths under the slug`.
  - `review: approve with an open blocker is invalid`; `review: changes with no findings is invalid`; `review: a committed review file with approve and only minor findings is ok`.
  - `fix: a fixed disposition for an id the review did not list is invalid`; `fix: findings covering the review's ids with fixed/declined/open are ok`.
  - `verify: missing, extra or duplicate ids are invalid; exact coverage with evidence is ok`; `verify: verified must be boolean and evidence non-empty`.
  - `test: failed without findings is invalid; failed with findings is ok and outcomeForResult is failed with a signature`.
  - `outcomeForResult: a failed result's signature is stable across hex addresses and counts` (two summaries differing only in digits/hex give equal signatures).
  - `a review file not committed by a listed commit is invalid-result` (existing output-commit rule, now fed by `requiredOutputs`).
  - `without attempt, Plan 2 validation is unchanged` (one existing author case run with and without `attempt: { purpose: 'author' }` gives the same verdict).
- [ ] **Step 2: Run** `node --test tests/superagent-results.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement.** Thread `attempt` into `schemaErrors` (purpose rules) and `outputErrors` (take `paths` from `requiredOutputs` when `attempt` is present). Keep `validateResult`'s existing error ordering (identity, schema, commits, outputs). Use the existing helpers; no new dependency.
- [ ] **Step 4: Run** results tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: per-purpose result schemas and required outputs`.

### Task 4: Results — `tasks.json` validation and implement evidence

**Files:** Modify `src/superagent/results.js`, `tests/superagent-results.test.mjs`.

**Interfaces:**
- Produces: `export function parseTasks(text, job)` → `{ ok: true, tasks: Task[] } | { ok: false, errors: string[] }`. Rules: JSON array, non-empty; each element an object with `id` (`isSafeSessionId`, ≤ 24 chars, unique), `title` and `acceptance` non-empty strings, `repos` non-empty array of ids that exist in `job.repos`, `dependsOn` array of existing task ids (not itself), `verify` a string (may be empty); the dependency graph must be acyclic. Returned tasks have `origin: 'plan'`, `fromAttemptId: null`.
- `validateResult` with `attempt.purpose === 'author'` and `phase.outputs` including `tasks`: after the existing output checks pass, read the `tasks` file from the primary worktree and run `parseTasks`; failure → `{ ok: false, errors }` (so the planner retries as `invalid-result`).
- `validateResult` with `attempt.purpose` `implement` or task `fix` and `status: 'done'`: `evidence.commits` must contain ≥ 1 commit; the task (found via `attempt.taskDef`) `verify` string, when non-empty, must appear as `cmd` (compared after trimming and collapsing whitespace) in `evidence.checks` with `exit === 0`; every commit's repo must be in `taskDef.repos` (a commit in an unlisted repo is invalid).

- [ ] **Step 1: Failing tests:**
  - `parseTasks accepts a minimal valid list and fills origin/fromAttemptId`.
  - `parseTasks rejects: not an array, empty, a non-object element, missing title/acceptance, empty repos, an unknown repo, an unknown dependsOn, a self dependency, a dependency cycle (A→B→A), a duplicate id, an id with a path separator, an id over 24 chars` — one test each (table), asserting the error text names the field.
  - `the planner's done result is invalid-result when tasks.json has a cycle` (full `validateResult` with `attempt: { purpose: 'author' }`, plan phase outputs plan+tasks committed).
  - `implement: no commit listed is invalid; a missing verify check is invalid; a verify check with exit 1 is invalid; matching check with exit 0 and a commit in a listed repo is ok`.
  - `implement: a commit in a repo the task does not list is invalid`.
  - `implement: an empty verify string needs no check`.
- [ ] **Step 2: Run** the results tests; expect FAIL.
- [ ] **Step 3: Implement** `parseTasks` (iterative DFS or Kahn for cycles) and the two validator extensions. `attempt.taskDef` is supplied by the runner (Task 7).
- [ ] **Step 4: Run** results tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: tasks.json validation and implement evidence checks`.

### Task 5: Sequencer — `reviewLoop`, task selection, test routing

**Files:** Modify `src/superagent/sequencer.js`, `tests/superagent-sequencer.test.mjs`.

**Interfaces:**
- Consumes: Task 2 derived fields (`attempt.purpose/round/verdict/findings/verified/commits`, `job.tasks`).
- Produces:
  - `RUNNABLE_KINDS = new Set(['author', 'review', 'per-task', 'human'])`.
  - `export function reviewLoop(attempts, { initial, maxRounds, failedCap })` — `attempts` are the *scope's* attempts in order (one phase, or one task). Returns exactly one of:
    - `{ type: 'launch', purpose, round, final, side: 'author' | 'reviewer' | 'verifier' | 'initial' }`
    - `{ type: 'complete', unresolved: [{ id, severity, text, status }] }`
    - `{ type: 'question', question, evidence }` (a verified blocker)
    - `{ type: 'stuck', why }` (`attempt-cap` | `repeated-error` is NOT here — the caller applies Plan 2's repeated-error rule per scope; `why` here is `attempt-cap`)
    - `{ type: 'pending' }` (an attempt is still in flight) and `{ type: 'question-open', attemptId, question }` (the last attempt asked a question).
  - `export function pickTask(job)` → the first task in `job.tasks` (plan order) whose status is not done and whose every `dependsOn` is done; `null` if none runnable; `{ blocked: true }` if unfinished tasks remain but none is runnable. Task status (`taskStatus(job, task)`) is derived by running `reviewLoop` over that task's attempts (`complete` = done).
  - `export function routeTestFailure(job, phase)` → `null | { attemptId, findings }` per Decision 10, idempotent by `fromAttemptId`.
  - `nextAction(job, ctx)` gains result types `{ type: 'load-tasks' }`, `{ type: 'complete-phase', phase, unresolved }`, `{ type: 'route-test-failure', attemptId, findings }`; `launch` actions gain `purpose`, `round`, `final`, `task`, `taskDef` (the task object or null), `reviewFindings` (ids from the round's review, for fix), `contested` (ids, for verify), `reviewTarget`. Roles: author phase → `phase.role`; review phase reviewer → `phase.role`, fix → `phase.author`, verify → `'verifier'`; per-task initial and fix → `phase.role`, task-review → `phase.taskReview`, verify → `'verifier'`; `test` → `phase.role`. Model, effort and `maxTurns` come from `job.models[role]` as today.
- Rules `reviewLoop` implements (these are Decisions 4–8): reviewer round *n* = the *n*-th `done` attempt with purpose `review`/`task-review`; `approve` as the latest verdict completes with `unresolved: []`; `changes` → author fix of the same round (the `final` flag is true when `round === maxRounds`) → next reviewer round, until the cap, then contested/verify/question/complete per Decision 7. With `initial: 'implement'` a `done` initial attempt is required first and `initial: null` skips that step. Failed attempts of any purpose in the scope count toward `failedCap`; reaching it returns `stuck('attempt-cap')`. `interrupted`/`stopped` attempts consume nothing (Plan 2 `CONSUMING_OUTCOMES` unchanged).
- The per-scope repeated-error and back-off rules from Plan 2 apply to the scope's failed attempts (reuse the existing code path by passing the scope attempts).

- [ ] **Step 1: Failing tests** (`tests/superagent-sequencer.test.mjs`; build jobs with the Task 2 helpers; one table test per `reviewLoop` row):
  - `reviewLoop: no attempts launches reviewer round 1` (`initial: null`) and `initial implement launches the initial attempt first`.
  - `approve completes with no unresolved`.
  - `changes launches the author fix for the same round; after the fix launches reviewer round n+1`.
  - `at maxRounds the fix is final and no reviewer pass follows it`.
  - `cap with only minors: completes and lists them as open or declined`.
  - `cap with a fixed blocker: completes without a verifier`.
  - `cap with a declined or unlisted blocker launches the verifier with exactly the contested ids`.
  - `verifier verified:true on any blocker returns question with evidence; all false completes with disputed-not-verified`.
  - `failed attempts do not advance rounds and stop at failedCap with stuck`.
  - `an in-flight attempt returns pending; a question outcome returns question-open`.
  - `a reviewer that always answers changes never launches more than maxRounds reviewers` (simulate by appending done attempts in a loop; assert bound).
  - `pickTask: respects dependsOn, plan order, returns blocked when nothing is runnable, null when all done`.
  - `routeTestFailure: returns the findings once; returns null after a fix task with that fromAttemptId exists; null when the failure has no findings`.
  - `nextAction: review phase launches reviewer with the reviewer role and model; fix uses the author role; verify uses verifier`.
  - `nextAction: implement phase returns load-tasks when job.tasks is null; launches the first runnable task; complete-phase when every task is done; needs-you stuck when blocked`.
  - `nextAction: test phase with a routable failure returns route-test-failure; at attemptsPerPhase consumed attempts returns stuck`.
  - `nextAction: author phases behave exactly as in Plan 2` (the existing tests stay and pass).
- [ ] **Step 2: Run** `node --test tests/superagent-sequencer.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement** the helpers as pure functions; `nextAction` keeps its current guard order (state, human, in-flight, question, caps, repeated error, back-off, concurrency) and delegates the choice of *what* to launch to `reviewLoop`/`pickTask`/author logic. Do not read files or clocks.
- [ ] **Step 4: Run** sequencer tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: sequencer review loops, per-task selection and test-failure routing`.

### Task 6: Prompts — job card fields, role templates, contract

**Files:** Modify `src/superagent/prompts.js`, `prompts/superagent/contract.md`, `prompts/superagent/spec-writer.md`, `tests/superagent-prompts.test.mjs`; create `prompts/superagent/{planner,spec-reviewer,plan-reviewer,implementer,task-reviewer,tester,verifier}.md`.

**Interfaces:**
- `buildWorkerPrompt({ role, job, phase, attempt, projectDir })` — `attempt` gains `purpose`, `round`, `final`, `taskDef`, `reviewFindings`, `contested`. The job card JSON gains: `purpose`, `round`, `final`, `target` (path of the artifact under review, review/fix only), `outputs` (the `requiredOutputs` list — replaces the phase-output derivation whenever `attempt.purpose` is set), `task` (the task object, per-task attempts), `taskCommits` (task-review only: `[{ repo, sha }]` from the task's latest done implement/fix attempt), `previousFindings` (path of the round's review file for `fix`, of the previous round's review for a reviewer after round 1; else `null`), `contested` (verify only: `[{ id, text, disposition }]` taken from the last reviewer round and the final fix). Existing fields and the `previousAttemptDir` behaviour are unchanged; with no `purpose` the card is identical to Plan 2's.
- Templates: each role file states, in at most ~25 lines, its job, its inputs/outputs from the card, its stop condition, and the rule "do not edit files outside your listed outputs and the code your task owns". Role-specific rules that tests pin (substrings):
  - `spec-writer` and `planner` also handle `purpose: fix`: "when `purpose` is `fix`, read `previousFindings`, change the artifact for each finding or decline it with a one-sentence reason, and write the response file"; the `final` rule: "when `final` is true, append every finding you did not fix under a heading `## Unresolved review findings`".
  - `planner`: the `tasks.json` schema from the spec verbatim (`id`, `title`, `repos`, `dependsOn`, `acceptance`, `verify`), "ids are at most 24 characters, letters, digits and hyphens", "one task = one worker session".
  - `spec-reviewer` / `plan-reviewer`: read-only on the target; verdict rules ("`approve` only if there is no open blocker"; severities defined); "commit your review file and list its commit".
  - `implementer`: one task only; run the task's `verify` command and report it in `evidence.checks` with its exit code; commit per task; "check `git status` and `git log` before repeating work".
  - `task-reviewer`: review only the commits in `taskCommits` (`git diff`/`git show`), not the whole tree.
  - `tester`: write `testReport` including a "How to try it" section; on failure set `status: failed` and list each failing check as a finding (id, severity, text); never edit code.
  - `verifier`: for each contested finding, decide `verified` true/false with concrete evidence from the artifact or code; read-only; cover exactly the contested ids.
- `contract.md` gains: (a) a "Purposes" section naming the seven purposes and which result fields each needs (`verdict`+`findings` for review/task-review; `findings` with dispositions for fix; `verified` for verify; `evidence.commits`+`evidence.checks` for implement/fix; `findings` on a failed test); (b) the existing "Committing outputs" section extended: review, response, verify and report files are outputs and must be committed and listed.

- [ ] **Step 1: Failing tests** (`tests/superagent-prompts.test.mjs`, prompt-surface style like the existing ones):
  - `every role in milestone-2 has a template` — loop `MILESTONE_2_PIPELINE` roles plus `author`, `taskReview`, `verifier` through `hasTemplate`.
  - `the card carries purpose, round, final and the required outputs list when purpose is set`.
  - `a review card has target and previousFindings null in round 1, the previous review path in round 2`.
  - `a fix card has previousFindings pointing at the round's review file`.
  - `a task-review card lists taskCommits`; `a verify card lists contested findings`.
  - `with no purpose the card equals the Plan 2 card` (deep-equal against a card built the Plan 2 way for the spec phase).
  - Substring pins: planner contains the `tasks.json` field names and "24 characters"; spec-writer and planner contain `## Unresolved review findings`; implementer contains `evidence.checks`; task-reviewer contains `taskCommits`; tester contains `How to try it`; verifier contains `contested`; contract contains `Purposes` and every purpose name.
- [ ] **Step 2: Run** `node --test tests/superagent-prompts.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement** the card changes and write the templates (plain markdown, imperative, no emoji). Keep each template self-contained: a template may name a superpowers skill only to say it is overridden at the phase boundary.
- [ ] **Step 4: Run** prompts tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: pipeline role templates, contract purposes and card fields`.

### Task 7: Runner — carry purpose and round, richer ended payload

**Files:** Modify `src/superagent/runner.js`, `tests/superagent-runner.test.mjs`.

**Interfaces:**
- `launch(job, action)` — `action` now may carry `purpose`, `round`, `final`, `taskDef`, `reviewFindings`, `contested`, `reviewTarget`. The `attempt-started` event includes `purpose` (default `'author'`) and `round`. The `live` record keeps them. `buildWorkerPrompt` receives them (Task 6 shape).
- `judge` passes `attempt: { purpose, round, task, taskDef, reviewFindings, contested }` to `validateResult`. For a **reconcile** of a derived attempt (no `live`), `purpose`/`round` come from the stored attempt and `taskDef`/`contested`/`reviewFindings` are rebuilt from `job` by a new exported pure helper in `sequencer.js`: `export function attemptContext(job, attempt)` (so reconcile validates with the same rules as a live finish).
- The `attempt-ended` payload gains `verdict`, `findings`, `commits`, `verified` from the validated result (empty/`null` when absent) and, for failed results, `signature` (Decision 13).
- `onApprovalRequest`: unchanged behaviour (deny every ask, brainstormer exception). A comment records that in `auto` the SDK does not call it for ordinary tools.

- [ ] **Step 1: Failing tests** (`tests/superagent-runner.test.mjs`, reusing its fake-registry harness and a temp git repo):
  - `attempt-started records purpose and round`; `no purpose defaults to author`.
  - `a valid review result ends the attempt with verdict and findings stored on the derived attempt`.
  - `a valid implement result stores commits; a missing verify check ends the attempt invalid-result`.
  - `a worker-reported failed result gets a signature, and two identical failures produce equal signatures`.
  - `reconcile validates a finished fix attempt with the same rules as a live finish` (build a job with a review attempt and its findings, an unfinished fix attempt whose result.json is valid for those ids; `reconcile` ends it `done`; the same file with an extra id ends it `failed(invalid-result)`).
  - `attemptContext rebuilds taskDef, contested and reviewFindings from the job` (pure, in the sequencer tests file).
  - Existing runner tests pass unchanged.
- [ ] **Step 2: Run** the runner and sequencer tests; expect FAIL.
- [ ] **Step 3: Implement.** `attemptContext` lives in `sequencer.js` (pure) and is imported by `runner.js`. No change to claim/finish/nudge/stall logic.
- [ ] **Step 4: Run** runner tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: runner carries attempt purpose and round and records richer outcomes`.

### Task 8: Supervisor — execute the new actions, preflights, fixture

**Files:** Modify `src/superagent/index.js`, `tests/superagent.test.mjs`.

**Interfaces:**
- `createJob({ …, fixture })` accepts `'milestone-2'` via `FIXTURES`; `resolvePipeline` additionally (a) rejects a pipeline whose roles lack a template with `ERR_NO_TEMPLATE` (Decision 11; a `projectDir` override counts), (b) on win32 rejects with `ERR_PATH_TOO_LONG` per Decision 14 (a `platform = process.platform` option on `createSuperagent` for tests). `RUNNABLE_KINDS` now includes `review` and `per-task`, so the Plan 2 "phase kinds not runnable yet" error no longer fires for them.
- `stepJob` handles, in the existing per-job chain and with the existing stop/recheck discipline:
  - `load-tasks` → read `docs/superpowers/jobs/<slug>/tasks.json` from the primary worktree, `parseTasks`, append `tasks-loaded`; a read/parse failure appends `needs-you { reason: 'stuck', detail: { why: 'tasks-invalid', errors } }`.
  - `complete-phase` → append `phase-completed { phase, unresolved }`.
  - `route-test-failure` → append `fix-task-added` (id `F<k>` where `k` = existing fix tasks + 1; `title` from the first finding; `repos: ['primary']`; `acceptance` = the findings' texts joined; `verify: ''`; `origin: 'test'`; `fromAttemptId`) then `phase-rewound { to: 'implement', reason: 'test-failure' }`. Both appends go through `appendConfirmed` and a reload on rejection, so replay after a landed-but-rejected append appends nothing twice (the sequencer's idempotence by `fromAttemptId` and `phase-rewound`'s no-op when already there make this safe).
  - A `needs-you` from a verified blocker carries `detail: { kind: 'blocker', text, evidence }`.
- `getJob`/`listJobs` expose `tasks`, attempt `purpose`/`round`/`verdict` through the derived job unchanged.

- [ ] **Step 1: Failing tests** (`tests/superagent.test.mjs`, existing `harness`):
  - `createJob with the milestone-2 fixture provisions and validates` (job `running`, seven-phase pipeline stored).
  - `createJob rejects a pipeline whose role has no template with ERR_NO_TEMPLATE, and the default pipeline fails on brainstormer`; `a project override template satisfies the check`.
  - `createJob on win32 with a long COCKPIT_HOME-style root rejects with ERR_PATH_TOO_LONG; a short root passes` (inject `platform: 'win32'` and a long `worktreesRoot`).
  - `tick: a finished review loop appends phase-completed and the phase index advances`.
  - `tick: load-tasks appends tasks-loaded once; an invalid tasks.json parks the job needs-you stuck with the errors`.
  - `tick: route-test-failure appends one fix task and a rewind; replaying the tick after a rejected-but-landed append appends nothing more` (use the store's `openImpl` seam from Plan 2 tests to fail one append after write).
  - `a verified blocker parks the job needs-you with the blocker text and evidence`.
  - Plan 2 supervisor tests pass unchanged.
- [ ] **Step 2: Run** `node --test tests/superagent.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement** in `index.js`. Keep `withJob` serialisation; every new append happens inside the job's chain.
- [ ] **Step 4: Run** supervisor tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: supervisor executes review, task and test-routing actions`.

### Task 9: Pipeline integration tests with scripted fake workers

**Files:** Create `tests/superagent-pipeline.test.mjs`; modify `tests/superagent-helpers.mjs` (a `scriptedWorker` helper).

**Interfaces:**
- `scriptedWorker({ registry, repo, jobSlug, handlers })` — a test double wired through the existing `sessionFactory`/`fakeStartSession` seam: when the supervisor launches an attempt it reads the job card from the first `sendInput`, looks up `handlers[card.purpose]` (or a handler keyed `card.phaseId + ':' + card.purpose`), runs it with `{ card, commit(files, message) }` (which writes files into the primary worktree, commits on the job branch and returns the sha) and then writes `result.json` atomically in `card.attemptDir`, ending the turn. A handler returns the result body (without identity fields — the helper adds `jobId/phaseId/taskId/attemptId`).

- [ ] **Step 1: Write the failing tests** (each drives `createSuperagent` with `tick()` calls and a fake clock; the toy repo is created with `initRepo`):
  - `milestone-2 happy path`: spec → spec-review approve in round 1 → plan (writes plan and a two-task `tasks.json`) → plan-review approve → implement T1 (commit + `verify` check) → T1 task-review approve → T2 (depends on T1) same → test done with `testReport` → `needs-you(ready-to-try)`; `accept` → `done`. Assert the order of `attempt-started` purposes and roles, and that T2 never launched before T1 completed.
  - `a reviewer that always answers changes stops at the cap`: `spec-review` returns `changes` with one `major` finding every round, the fix declines it; assert exactly 3 reviewer attempts, 3 fixes, the last fix `final`, then the phase completes and the next phase launches (no blocker, so no verifier).
  - `a contested blocker at the cap reaches the verifier; verified:false proceeds as disputed-not-verified; verified:true parks the job needs-you with the evidence` (two runs).
  - `an approve with an open blocker is invalid-result and is retried, bounded by attemptsPerPhase`.
  - `a task review loop: changes then fix then approve completes the task; at taskReviewRounds the verifier path is the same`.
  - `test failure routing`: the first `test` attempt returns `failed` with two findings → one `F1` task is appended, `implement` runs it, `test` runs again and passes; a second test run that fails again at the attempt cap parks the job `needs-you(stuck)`; a restart (`stop()`, rebuild supervisor on the same store, `start()`) between the rewind and the implement does not append a second fix task.
  - `an invalid tasks.json (cycle) fails the planner attempt as invalid-result and the planner is retried`.
  - `stopJob mid-review-loop closes the live attempt and launches nothing more`.
- [ ] **Step 2: Run** `node --test tests/superagent-pipeline.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement** `scriptedWorker` and any small supervisor fixes the tests expose. Fixes to production code found here are reported in the task report and each gets its own regression test in the owning module's test file.
- [ ] **Step 4: Run** the pipeline tests, then `npm test`.
- [ ] **Step 5: Commit** `test: milestone-2 pipeline integration with scripted workers`.

### Task 10: Manual probe and docs

**Files:** Create `tests/superagent-pipeline.manual.mjs`; modify `CLAUDE.md`, `tests/README.md`.

- [ ] **Step 1: Write `tests/superagent-pipeline.manual.mjs`**, modelled on `tests/superagent-two-phase.manual.mjs` (temp `COCKPIT_HOME`, toy repo, 10-minute-per-phase wall-clock deadline scaled to 40 minutes total, the same fake-ws `TOOL_USE` logging, wrapped interceptor). It creates a `milestone-2` job with a deliberately tiny idea ("a `hello.txt` containing `hi`, with a `node` one-liner as verify"), caps `maxRounds` at 1 and `taskReviewRounds` at 1, `attemptsPerPhase` 2, and prints per-attempt purpose/outcome/summary, every `phase-completed`/`phase-rewound` event, the final state, the worktree `git log --oneline`, and which artifact paths exist. Header states: not run by implementers; no cost cap beyond the wall-clock and attempt limits; spend is not a constraint for this plan but the run is still the controller's to start; it observes what the unit tests cannot (do real reviewers produce parseable verdict/findings, do real planners produce a valid `tasks.json`, does the real implementer report the `verify` check). `node --check` must pass.
- [ ] **Step 2: Docs.** `CLAUDE.md`: update the Superagent paragraph — phases now runnable (`author`, `review`, `per-task`, `human`), the `milestone-2` fixture, what still does not exist (router, brainstorm, usage ledger, caps, UI). `tests/README.md`: append a "Superagent pipeline (Plan 3)" section listing what is unit-tested and what only the manual probe observes. Append-only edits.
- [ ] **Step 3:** `node --check tests/superagent-pipeline.manual.mjs`; `npm test` green; working tree clean after the commit.
- [ ] **Step 4: Commit** `docs: superagent pipeline probe and coverage notes`.

---

## Self-review notes (author)

- **Spec coverage (milestone 2):** review loops with cap and verifier (Tasks 3, 5, 9); per-task implementation with task review (Tasks 4, 5, 9); test-failure routing (Tasks 5, 8, 9); role templates and the contract (Task 6); results rules from "Validation before the sequencer advances" for `implement` (Task 4). The isolated router is deliberately Plan 4 (see Scope split).
- **Interface consistency:** `purpose` values are the same seven strings in Tasks 2, 3, 5, 6, 7. `attemptContext` (Task 7) is the one place that rebuilds `taskDef`/`contested`/`reviewFindings` for reconcile. `requiredOutputs` (Task 3) is the one place that maps purpose to paths, used by results (validation) and prompts (card `outputs`).
- **Known divergences from the spec, ruled here:** fix tasks are events, not edits to `tasks.json` (Decision 9); the verifier also serves task review (Decision 8); unresolved findings are recorded in `phase-completed` and appended to the artifact only by the author's final pass (Decision 7).
- **Test counts are not pinned** (Plan 2's counts drifted); the gate is "baseline 807 green plus every test named in the task".
