# Superagent Plan 3 — Review Loops, Per-Task Implementation and Test Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** 2 — folds in the Codex review of revision 1 (17 findings; `.superpowers/sdd/codex-p3-review.md`). See "Revision 2 changes" at the end.

**Goal:** Extend the Plan 2 library under `src/superagent/` so a job can run the named `milestone-2` fixture pipeline end to end with fake workers: `spec → spec-review → plan → plan-review → implement → test → accept`. That adds review loops (reviewer, author fix, round cap, verifier at the cap), per-task implementation with a task reviewer, test-failure routing (a failed tester appends a fix task and re-runs implement then test), the eight role templates, and a stricter result contract. It is still not wired into `src/server.js`, and it still has no router, stand-in, usage ledger, usage-cap handling or UI.

**Architecture:** The Plan 2 shape is kept: `nextAction` in `sequencer.js` stays a pure function of the derived job, `runner.js` still launches and watches one attempt per job, `index.js` executes the sequencer's actions. What changes is that a phase is no longer "one author attempt". Each attempt now carries a `purpose` (`author | review | fix | verify | implement | task-review | test`) and a `round`; one pure helper, `reviewLoop`, drives both a review phase and a task's implement/review cycle; and three new events (`tasks-loaded`, `test-routed`, `phase-completed`) make multi-attempt phase progress derivable from `events.jsonl` alone.

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
4. **Test-failure routing is one atomic event, appends exactly one fix task per failed tester attempt, and cannot be double-applied across implement cycles** (the fix-task id is derived from the failed attempt, so a planned `F1` cannot collide; stale `phase-completed` events carry a visit number and are ignored). It stays bounded by the phase attempt cap. (Task 2, Task 5 `routeTestFailure`, Task 9 replay tests across two cycles and a restart right after the routing event.)
5. **A broken `tasks.json` must be refused whenever it is published — by the planner or by a planner fix after plan review:** unknown `dependsOn`, a cycle, a duplicate or non-portable id, an unknown repo. Otherwise the implement phase deadlocks. (Task 4.)

---

## Decisions the spec leaves to the builder

1. **Fixture, not composition.** `milestone-2` is a frozen named pipeline in `config.js` (seven phases, no `brainstorm`; `spec` takes `['idea']`). `createJob({ fixture: 'milestone-2' })` is its only entry. The default pipeline with `brainstorm` is still rejected at `createJob`, now with a clear error because `brainstormer` has no template (Decision 11).
2. **Attempt purpose and round.** `attempt-started` gains `purpose` and `round`. Plan 2 attempts are read as `purpose: 'author'`, `round: null` when the fields are absent (so Plan 2 event logs replay unchanged).
3. **Phase completion events and visits.** Author phases still advance on an attempt's `done` (Plan 2 behaviour, unchanged). Review and per-task phases advance only on `phase-completed { phase, visit, unresolved, verification }`, which the supervisor appends when the sequencer returns `complete-phase`. A *visit* is how many times the pipeline has entered a phase (`deriveJob` keeps `visits[phase]`, starting at 1 for the first entry, +1 each time a `test-routed` event rewinds into `implement`); `phase-completed` is applied only when `phase` is the current phase **and** `visit` equals the current visit, so a stale duplicate appended after a rewind is ignored. Test routing is ONE event, `test-routed { attemptId, task }`, which in `deriveJob` appends the fix task (deduplicated by `task.id` and by `fromAttemptId`) **and** rewinds to `implement` — there is no crash window between two events. `deriveJob` keeps `completions: [{ phase, visit, unresolved, verification }]` so the unresolved findings and verifier evidence stay readable from `getJob` and survive a restart.
4. **One loop helper for two uses.** `reviewLoop(attempts, { initial, maxRounds, failedCap })` in `sequencer.js` serves a review phase (`initial: null`; reviewer then author-fix) and a task (`initial: 'implement'`; implementer, task-reviewer, implementer-fix). Its result is one of `launch` (with `purpose`, `round`, `final`, `side`), `complete { unresolved, verification }`, `question`, `stuck`, `pending`, `question-open`. The sequencer maps those onto the phase's roles and models. **Cap structure:** author phases and `test` keep Plan 2's consuming-attempt cap (`done`+`failed`+`question`); review phases and tasks use only a *failed*-attempt cap inside `reviewLoop`, and the loop state (complete, question) is evaluated **before** any launch guard, so reviewer 1 → fix 1 → reviewer 2 → … is never stopped by a count of `done` attempts.
5. **Rounds.** A round is one *completed* (`done`) reviewer attempt. Round *n* of the author fix follows reviewer round *n*. Failed attempts do not advance a round; they count against `failedCap` (`attemptsPerPhase` for a phase, `attemptsPerTask` for a task).
6. **The cap round.** After reviewer round `maxRounds` returns `changes`, the author still gets one **final** fix attempt (it records dispositions and, for a review phase, appends the unresolved findings to the artifact under "Unresolved review findings"). There is no reviewer pass after it.
7. **The `final` flag is persisted:** `attempt-started` carries `final` (boolean, default false) and `deriveJob` keeps it, so live finish and reconcile validate identically. **What "contested" means at the cap.** A `blocker` in the last reviewer round is *contested* unless the final fix's result lists the same finding id with `disposition: 'fixed'`. Contested blockers (declined, open or unlisted) go to **one verifier attempt**. A verifier result `verified: [{ id, verified: boolean, evidence }]` for every contested id decides: any `verified: true` → `needs-you(question)` carrying the blocker text and the verifier's evidence; none → complete with those blockers recorded as `disputed-not-verified`. All non-blocker findings that are not `fixed` are recorded as `open` or `declined`. The record is the `unresolved` list on the `phase-completed` event; the artifact itself is only edited by the author's final pass.
8. **Task review reuses the same machinery** with `maxRounds = phase.maxRounds ?? limits.taskReviewRounds` (new limit, default 2) and the same verifier. A task with no `taskReview` role is done when its implementer attempt is `done`.
9. **Tasks live in events.** The planner's `tasks.json` is validated at publish time — by the planner and by any planner fix (Task 4) — and copied into a `tasks-loaded` event when the implement phase starts. Fix tasks from test routing arrive inside the `test-routed` event, **not** as edits to `tasks.json` (the spec says to append to the file; a supervisor editing a worker's committed file races its commits, so the event log is the source of truth and the view reads the derived list). Workers that need the effective list get it on their card as `effectiveTasks` (Task 6), so a tester re-run sees the generated fix's acceptance criteria. Ledger it as a ruling.
10. **Test routing.** A tester result with `status: 'failed'` must carry `findings` (id, severity, text). Findings may carry an optional `repo` (a repo id). The sequencer returns `route-test-failure { attemptId, findings }` for the last `test` attempt when it failed with findings and no task has `fromAttemptId` equal to it, and `buildFixTask(job, attemptId, findings)` (pure, in `sequencer.js`, the one builder) makes the task: `id = 'F-' + attemptId.slice(0, 8)` (planner ids matching `^F-[0-9a-f]{8}$` are rejected by `parseTasks`, so no collision), `dependsOn: []`, `repos` = the distinct valid repo ids named by the findings (default `['primary']`), `acceptance` = the findings' texts, `verify: ''`, `origin: 'test'`, `fromAttemptId`. The supervisor appends one `test-routed` event. Each routed failure consumes one `test` attempt, so `attemptsPerPhase` bounds the cycle; at the cap → `needs-you(stuck)`.
11. **Role templates required at job creation.** `createJob` rejects a pipeline whose roles (including `author`, `taskReview`) lack a prompt template (`hasTemplate`), with `ERR_NO_TEMPLATE`. A project override file satisfies it. `verifier` is always required when the pipeline has a review or per-task phase.
12. **Review verdict rules (results).** `verdict: 'approve'` with any finding whose `severity` is `blocker` and `disposition` `open` is invalid. A `fix` result's findings must reference only ids given in the round's review file (the validator reads the review attempt's recorded findings from the job) and a **non-final** fix must not use `open` for a blocker (a final fix may). A `fix` result for a phase whose revise set includes `tasks` is revalidated with `parseTasks` (Decision 16). A `verify` result must cover exactly the contested ids.
13. **Failure signature for worker-reported failures.** `outcomeForResult` gets the result summary's first line as the signature detail, so `repeated-error` can trip for `failed`/`blocked` (Plan 2 parked it).
14. **Windows path guard.** `createJob` on win32 computes the longest attempt-directory path it can produce and rejects with `ERR_PATH_TOO_LONG` above 240 characters, naming `COCKPIT_HOME` as the fix. The bound is computed from validated ids: config validation enforces the portable grammar `/^[a-z0-9][a-z0-9-]{0,23}$/i` for every phase id (new check in `checkPipeline`) and `parseTasks` enforces it for task ids, so 24 characters is a real maximum.
15. **Artifact paths added** (all under the primary worktree, all committed, `artifactPaths`-style): reviews `docs/superpowers/jobs/<slug>/reviews/<phase>-r<round>.md` (review), `…/<phase>-r<round>-response.md` (author fix), `…/<phase>-verify.md` (verifier); tasks `docs/superpowers/jobs/<slug>/tasks/<taskId>-report.md` (implement and fix), `…/<taskId>-review-r<round>.md` (task review), `…/<taskId>-verify.md`.

16. **Review fixes publish the revised artifacts.** For a review phase the *revise set* is the `outputs` of the earliest author phase that outputs the review `target` (`spec` → `[spec]`, `plan` → `[plan, tasks]`; exported as `reviseOutputs(job, phase)` in `results.js`). A `fix` result with `status: done` needs its response file committed and listed (as an output) **and** every revise-set file present, non-empty and clean in the primary worktree (`git status --porcelain` empty — the author may legitimately decline everything, so no commit touching them is required); `tasks` in the set is revalidated with `parseTasks`.
17. **Commit rules for implement and task fixes.** A listed commit in the primary repo is always allowed (it carries the report file); a listed commit in any other repo must be in the task's `repos`; at least one listed commit must be in one of the task's `repos` (code evidence). Task review sees **cumulative** task commits: `taskCommits` is the union, in order, of every done implement/fix attempt's commits for that task.
18. **Required models.** Config validation requires `models.verifier` whenever the pipeline has a `review` or `per-task` phase (error path `models.verifier`).

## Not in this plan

Router and its auth route (Plan 4); brainstorm, stand-in and manual handover; usage ledger, budgets and usage-cap pause/resume; the feedback route and an answer/resume path for `needs-you(question)` (a verified blocker parks the job exactly like Plan 2's question does — no way out until the server/feedback plans); server wiring and the UI; worktree removal; the Plan 2 deferred items not named here (never-settling `budgetCheck`, `start()` swallowing `listJobIds`, `stopJob` slot leak). Every `needs-you` state except `ready-to-try` (stuck, question, budget, tasks-invalid) is terminal until a resume/answer path exists in a later plan.

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
- Produces: `export const MILESTONE_2_PIPELINE` (deep-frozen); `export const FIXTURES = { 'milestone-1': MILESTONE_1_PIPELINE, 'milestone-2': MILESTONE_2_PIPELINE }`; `export function validateMilestoneFixture(d, name = 'milestone-1')` (second arg selects the fixture; unknown name throws `Error`); `defaultConfig().limits.taskReviewRounds === 2`. `checkPipeline` gains two rules: every phase id must match `/^[a-z0-9][a-z0-9-]{0,23}$/i` (error at `pipeline[i].phase`), and a pipeline containing a `review` or `per-task` phase requires `models.verifier` (error at `models.verifier`; spec Decision 18).
- `MILESTONE_2_PIPELINE` phases, in order: `spec` (author, `spec-writer`, inputs `['idea']`, outputs `['spec']`); `spec-review` (review, `spec-reviewer`, `author: 'spec-writer'`, `target: 'spec'`, `maxRounds: 3`); `plan` (author, `planner`, inputs `['spec']`, outputs `['plan','tasks']`); `plan-review` (review, `plan-reviewer`, `author: 'planner'`, `target: 'plan'`, `maxRounds: 3`); `implement` (per-task, `implementer`, `taskReview: 'task-reviewer'`, inputs `['tasks']`); `test` (author, `tester`, inputs `['spec','tasks']`, outputs `['testReport']`); `accept` (human, inputs `['testReport']`). Frozen like `freezePhase` (inputs/outputs arrays frozen too); `freezePhase` is changed to default a missing `inputs` to `[]` (review phases carry none).

- [ ] **Step 1: Failing tests** in `tests/superagent-config.test.mjs`:
  - `milestone-2 fixture validates against defaults` — `validateMilestoneFixture(defaultConfig(), 'milestone-2').errors` is `[]`.
  - `milestone-2 fixture is deep-frozen and has no brainstorm phase` — `Object.isFrozen` on the array, each phase, each phase's `inputs`; no phase id `brainstorm`.
  - `milestone-2 phase order and contracts` — assert the exact seven phase ids in order, and that `plan` outputs `['plan','tasks']`.
  - `an unknown fixture name throws` — `validateMilestoneFixture(defaultConfig(), 'nope')` throws.
  - `a models map missing task-reviewer fails milestone-2 validation` — delete `models['task-reviewer']`, expect an error with path `pipeline[4].taskReview` (implement is index 4).
  - `a phase id with a slash, a space or 25+ characters is rejected` (three cases, error at `pipeline[i].phase`).
  - `deleting models.verifier fails validation for any pipeline with a review or per-task phase, and not for MILESTONE_1` (error path `models.verifier`).
  - `taskReviewRounds defaults to 2 and rejects 0` — `defaultConfig().limits.taskReviewRounds === 2`; `validateDefaults` with `limits.taskReviewRounds = 0` has an error at `limits.taskReviewRounds`.
  - Existing milestone-1 tests still pass unchanged (the default arg keeps `validateMilestoneFixture(d)` working).
- [ ] **Step 2: Run** `node --test tests/superagent-config.test.mjs`; expect the new tests FAIL.
- [ ] **Step 3: Implement** the exports above. `validateMilestoneFixture(d, name = 'milestone-1')` looks the name up in `FIXTURES` (own-property check) and validates `{ ...d, pipeline: FIXTURES[name] }` with `composition: false`. Add `taskReviewRounds: 2` to `defaultConfig().limits` (the existing positive-integer check covers it).
- [ ] **Step 4: Run** the config tests, then `npm test`; expect all green.
- [ ] **Step 5: Commit** `feat: milestone-2 fixture pipeline and taskReviewRounds limit`.

### Task 2: Store — new events and derived fields

**Files:** Modify `src/superagent/store.js`, `tests/superagent-store.test.mjs`, `tests/superagent-helpers.mjs` (add event builders).

**Interfaces:**
- `EVENT_TYPES` gains `'tasks-loaded'`, `'test-routed'`, `'phase-completed'`.
- `attempt-started` accepts optional `purpose` (default `'author'`), `round` (default `null`) and `final` (default `false`); the derived attempt gains `purpose`, `round`, `final`, `verdict: null`, `findings: null`, `commits: []`, `verified: null`.
- `attempt-ended` accepts optional `verdict`, `findings`, `commits`, `verified`; all stored on the attempt.
- `deriveJob` result gains `tasks: null | Task[]` where `Task = { id, title, repos, dependsOn, acceptance, verify, origin: 'plan' | 'test', fromAttemptId: string | null }`.
- `deriveJob` result also gains `visits: { [phaseId]: number }` (every phase starts at 1 when first reached; the current phase's visit is `visits[phaseId]`) and `completions: [{ phase, visit, unresolved, verification }]`.
- Event shapes: `tasks-loaded { tasks: Task[] }` (ignored if `tasks` is already non-null — idempotent); `test-routed { attemptId, task: Task }` (applies **only if** the current phase is `test` and no task has `fromAttemptId === attemptId`: appends `task`, sets `phaseIndex` to the `implement` phase's index and increments `visits.implement`; otherwise ignored — one atomic event, so a crash cannot split the fix task from the rewind); `phase-completed { phase, visit, unresolved, verification }` (applies only when `phase` is the current phase **and** `visit === visits[phase]`; sets `phaseIndex` to the phase's index + 1 and records the completion; any other event is ignored).
- Author auto-advance changes: `attempt-ended` `done` advances `phaseIndex` only when the phase's `kind` is `author` (Plan 2 behaviour for author phases is unchanged).
- Helpers: `export const taskCreated = (id, over)`, `export const ev = { tasksLoaded(tasks), testRouted(attemptId, task), phaseCompleted(phase, visit, unresolved) }` in `superagent-helpers.mjs` returning event objects.

- [ ] **Step 1: Failing tests** (`tests/superagent-store.test.mjs`), each building events by hand and calling `deriveJob`:
  - `a Plan 2 attempt without purpose derives as purpose author, round null`.
  - `attempt-started purpose and round are kept; attempt-ended verdict, findings, commits and verified are kept`.
  - `tasks-loaded sets tasks; a second tasks-loaded is ignored`.
  - `test-routed appends the fix task and rewinds to implement in one event; a second test-routed for the same attemptId is ignored; test-routed while the current phase is not test is ignored`.
  - `a Plan-2-style log (no purpose/final) derives visits of 1 for every reached phase`.
  - `phase-completed advances only when it names the current phase and the current visit` (later phase → ignored; a stale visit after a test-routed rewind → ignored; the matching visit → advances and is recorded in completions with unresolved and verification).
  - `two test-failure cycles: complete implement (visit 1) → test-routed → a replayed phase-completed for visit 1 is ignored → phase-completed for visit 2 advances`.
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
  - `export function reviseOutputs(job, phase)` → `string[]` of relative paths: the `outputs` of the earliest author phase whose outputs include `phase.target`, mapped through `artifactPaths` (`spec` → `[spec]`; `plan` → `[plan, tasks]`).
  - `validateResult(value, { expected, phase, job, git, attempt })` — new optional `attempt: { purpose, round, final, task, taskDef?, contested?, reviewFindings? }`. Without `attempt` the Plan 2 behaviour is exactly preserved (all Plan 2 tests pass untouched).
  - `outcomeForResult(result)` returns `{ outcome:'failed', reason, signature }` for `failed`/`blocked` (Decision 13) and includes `verdict`, `findings` for any result that has them, `verified` when present.
- Schema rules by `attempt.purpose` (errors as strings, like the existing validators):
  - `review` and `task-review`: `verdict` ∈ approve|changes and `findings` array required; `approve` with any `blocker` finding whose disposition is `open` is invalid (Decision 12); `changes` must list at least one finding.
  - `fix`: `findings` required; each `id` must appear in `attempt.reviewFindings` (ids of the round's review); a `fixed` disposition on an id not given is invalid; `verdict` ignored; when `attempt.final` is false a blocker finding with `disposition: 'open'` is invalid (a final fix may leave it open). For a review-phase fix with `status: 'done'`, every path in `reviseOutputs(job, phase)` must exist, be a non-empty file and be clean (`git status --porcelain -- <path>` empty) — no commit touching them is required.
  - `verify`: `verified` required: array of `{ id: string, verified: boolean, evidence: non-empty string }`; the id set must equal `attempt.contested` exactly (no missing, no extra, no duplicates).
  - `test`: when `status === 'failed'`, `findings` must be a non-empty array of `{ id, severity, text, repo? }` (no disposition required; `repo`, when present, must be a repo id of the job).
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
  - `reviseOutputs maps spec to [spec] and plan to [plan, tasks]`.
  - `fix (non-final): an open blocker is invalid; the same result with final true is ok`.
  - `fix: a missing, empty or dirty revise-set file is invalid; declining everything with a clean tree and no touching commit is ok`.
  - `test: a finding with an unknown repo is invalid; a finding naming additional repo "lib" is ok`.
  - `without attempt, Plan 2 validation is unchanged` (one existing author case run with and without `attempt: { purpose: 'author' }` gives the same verdict).
- [ ] **Step 2: Run** `node --test tests/superagent-results.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement.** Thread `attempt` into `schemaErrors` (purpose rules) and `outputErrors` (take `paths` from `requiredOutputs` when `attempt` is present). Keep `validateResult`'s existing error ordering (identity, schema, commits, outputs). Use the existing helpers; no new dependency.
- [ ] **Step 4: Run** results tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: per-purpose result schemas and required outputs`.

### Task 4: Results — `tasks.json` validation and implement evidence

**Files:** Modify `src/superagent/results.js`, `tests/superagent-results.test.mjs`.

**Interfaces:**
- Produces: `export function parseTasks(text, job)` → `{ ok: true, tasks: Task[] } | { ok: false, errors: string[] }`. Rules: JSON array, non-empty; each element an object with `id` (matches `/^[a-z0-9][a-z0-9-]{0,23}$/i`, unique, and does not match the reserved `^F-[0-9a-f]{8}$` used for generated fix tasks), `title` and `acceptance` non-empty strings, `repos` non-empty array of ids that exist in `job.repos`, `dependsOn` array of existing task ids (not itself), `verify` a string (may be empty); the dependency graph must be acyclic. Returned tasks have `origin: 'plan'`, `fromAttemptId: null`.
- `validateResult` with `attempt.purpose === 'author'` and `phase.outputs` including `tasks`, **and** with a review-phase `fix` whose `reviseOutputs` include `tasks` (Task 3): after the other output checks pass, read the `tasks` file from the primary worktree and run `parseTasks`; failure → `{ ok: false, errors }` (so the author retries as `invalid-result`).
- `validateResult` with `attempt.purpose` `implement` or task `fix` and `status: 'done'`: `evidence.commits` must contain ≥ 1 commit; the task (found via `attempt.taskDef`) `verify` string, when non-empty, must appear as `cmd` (compared after trimming and collapsing whitespace) in `evidence.checks` with `exit === 0`; commit rules (spec Decision 17): a listed commit in the primary repo is always allowed (it carries the report file); a listed commit in any other repo must be in `taskDef.repos`; at least one listed commit must be in one of `taskDef.repos` (code evidence — a task that lists only an additional repo is satisfied by a commit there plus the primary report commit).

- [ ] **Step 1: Failing tests:**
  - `parseTasks accepts a minimal valid list and fills origin/fromAttemptId`.
  - `parseTasks rejects: not an array, empty, a non-object element, missing title/acceptance, empty repos, an unknown repo, an unknown dependsOn, a self dependency, a dependency cycle (A→B→A), a duplicate id, an id with a path separator or a space, an id over 24 chars` — one test each (table), asserting the error text names the field.
  - `the planner's done result is invalid-result when tasks.json has a cycle` (full `validateResult` with `attempt: { purpose: 'author' }`, plan phase outputs plan+tasks committed).
  - `implement: no commit listed is invalid; a missing verify check is invalid; a verify check with exit 1 is invalid; matching check with exit 0 and a commit in a listed repo is ok`.
  - `implement: a commit in a non-primary repo the task does not list is invalid`.
  - `implement: a task listing only an additional repo is ok with one commit in that repo plus the primary report commit, and invalid with only the primary report commit`.
  - `parseTasks rejects an id matching the generated fix-task pattern`.
  - `a planner fix that leaves a cyclic tasks.json is invalid-result (review-phase fix revalidates tasks)`.
  - `implement: an empty verify string needs no check`.
- [ ] **Step 2: Run** the results tests; expect FAIL.
- [ ] **Step 3: Implement** `parseTasks` (iterative DFS or Kahn for cycles) and the two validator extensions. `attempt.taskDef` is supplied by the runner (Task 7).
- [ ] **Step 4: Run** results tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: tasks.json validation and implement evidence checks`.

### Task 5: Sequencer — `reviewLoop`, task selection, test routing

**Files:** Modify `src/superagent/sequencer.js`, `tests/superagent-sequencer.test.mjs`.

**Interfaces:**
- Consumes: Task 2 derived fields (`attempt.purpose/round/final/verdict/findings/verified/commits`, `job.tasks`, `job.visits`).
- Produces:
  - `RUNNABLE_KINDS = new Set(['author', 'review', 'per-task', 'human'])`.
  - `export function reviewLoop(attempts, { initial, maxRounds, failedCap })` — `attempts` are the *scope's* attempts in order (one phase, or one task). Returns exactly one of:
    - `{ type: 'launch', purpose, round, final, side: 'author' | 'reviewer' | 'verifier' | 'initial' }`
    - `{ type: 'complete', unresolved: [{ id, severity, text, status }], verification: [{ id, verified, evidence }] }`
    - `{ type: 'question', question, evidence }` (a verified blocker)
    - `{ type: 'stuck', why }` (`attempt-cap` | `repeated-error` is NOT here — the caller applies Plan 2's repeated-error rule per scope; `why` here is `attempt-cap`)
    - `{ type: 'pending' }` (an attempt is still in flight) and `{ type: 'question-open', attemptId, question }` (the last attempt asked a question).
  - `export function pickTask(job)` → the first task in `job.tasks` (plan order) whose status is not done and whose every `dependsOn` is done; `null` if none runnable; `{ blocked: true }` if unfinished tasks remain but none is runnable. Task status (`taskStatus(job, task)`) is derived by running `reviewLoop` over that task's attempts (`complete` = done).
  - `export function routeTestFailure(job, phase)` → `null | { attemptId, findings }` per Decision 10, idempotent by `fromAttemptId`; and `export function buildFixTask(job, attemptId, findings)` → the fix `Task` of Decision 10 (always includes `dependsOn: []`; `repos` from the findings' `repo` fields, filtered to repos the job has, default `['primary']`).
  - `nextAction(job, ctx)` gains result types `{ type: 'load-tasks' }`, `{ type: 'complete-phase', phase, visit, unresolved, verification }` (`visit` = `job.visits[phase]`; for the per-task phase `unresolved`/`verification` aggregate every task's, each entry tagged with its `task` id), `{ type: 'route-test-failure', attemptId, findings }`; `launch` actions gain `purpose`, `round`, `final`, `task`, `taskDef` (the task object or null), `reviewFindings` (ids from the round's review, for fix), `contested` (ids, for verify), `reviewTarget`. Roles: author phase → `phase.role`; review phase reviewer → `phase.role`, fix → `phase.author`, verify → `'verifier'`; per-task initial and fix → `phase.role`, task-review → `phase.taskReview`, verify → `'verifier'`; `test` → `phase.role`. Model, effort and `maxTurns` come from `job.models[role]` as today.
- Rules `reviewLoop` implements (these are Decisions 4–8): reviewer round *n* = the *n*-th `done` attempt with purpose `review`/`task-review`; `approve` as the latest verdict completes with `unresolved: []`; `changes` → author fix of the same round (the `final` flag is true when `round === maxRounds`) → next reviewer round, until the cap, then contested/verify/question/complete per Decision 7. With `initial: 'implement'` a `done` initial attempt is required first and `initial: null` skips that step. Failed attempts of any purpose in the scope count toward `failedCap`; reaching it returns `stuck('attempt-cap')`. `interrupted`/`stopped` attempts consume nothing (Plan 2 `CONSUMING_OUTCOMES` unchanged).
- **Guard order in `nextAction`** (replaces "retained guard order" for non-author phases): (1) in-flight attempt → `none`; (2) loop state first — `complete` → `complete-phase`, `question`/`question-open` → `needs-you`; (3) the failed-attempt cap (`stuck('attempt-cap')`); (4) repeated-error over the scope's failed attempts, then back-off after a failed last attempt (Plan 2 code, fed the scope attempts); (5) concurrency; (6) launch. Author and `test` phases keep Plan 2's order and consuming-attempt cap unchanged.
- A launch action also carries `final` (true on the cap-round author fix) which `attempt-started` persists.

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
  - `an always-changes reviewer with maxRounds 3 yields exactly 3 reviewer launches and 3 fix launches, the third fix final, then complete` (drive the loop by appending done attempts until it returns `complete`; assert the exact purpose sequence `review fix review fix review fix`, and that it terminates within 20 iterations).
  - `injected failures: two failed reviewer attempts before the first success do not advance the round and do not stop the loop under failedCap 3; a third failure returns stuck`.
  - `with defaults (attemptsPerPhase 3) reviewer 1, fix 1, reviewer 2 is NOT stopped by the cap` (regression for counting done attempts).
  - `buildFixTask: id is F- plus the first 8 attempt id chars, dependsOn is [], repos come from findings, defaults to primary`.
  - `routeTestFailure with a planned task already named like the generated id still returns the failure once (id is not the dedupe key; fromAttemptId is)`.
  - `pickTask: respects dependsOn, plan order, returns blocked when nothing is runnable, null when all done`.
  - `routeTestFailure: returns the findings once; returns null after a task with that fromAttemptId exists; null when the failure has no findings`.
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
- `buildWorkerPrompt({ role, job, phase, attempt, projectDir })` — `attempt` gains `purpose`, `round`, `final`, `taskDef`, `reviewFindings`, `contested`. The job card JSON gains: `purpose`, `round`, `final`, `target` (path of the artifact under review, review/fix only), `outputs` (the `requiredOutputs` list — replaces the phase-output derivation whenever `attempt.purpose` is set), `task` (the task object, per-task attempts), `taskCommits` (task-review only: `[{ repo, sha }]`, the cumulative union in order of every done implement/fix attempt's commits for the task, deduplicated), `previousFindings` (path of the round's review file for `fix`, of the previous round's review for a reviewer after round 1; else `null`), `contested` (verify only: `[{ id, text, disposition }]` taken from the last reviewer round and the final fix), `effectiveTasks` (every card once `job.tasks` is non-null: `[{ id, title, repos, acceptance, verify, origin }]`, so a tester re-run sees generated fix tasks). Existing fields and the `previousAttemptDir` behaviour are unchanged; with no `purpose` the card is identical to Plan 2's.
- Templates: each role file states, in at most ~25 lines, its job, its inputs/outputs from the card, its stop condition, and the rule "do not edit files outside your listed outputs and the code your task owns". Role-specific rules that tests pin (substrings):
  - `spec-writer` and `planner` also handle `purpose: fix`: "when `purpose` is `fix`, read `previousFindings`, change the artifact for each finding or decline it with a one-sentence reason, and write the response file"; the `final` rule: "when `final` is true, append every finding you did not fix under a heading `## Unresolved review findings`".
  - `planner`: the `tasks.json` schema from the spec verbatim (`id`, `title`, `repos`, `dependsOn`, `acceptance`, `verify`), "ids are at most 24 characters, letters, digits and hyphens", "one task = one worker session".
  - `spec-reviewer` / `plan-reviewer`: read-only on the target; verdict rules ("`approve` only if there is no open blocker"; severities defined); "commit your review file and list its commit".
  - `implementer`: one task only; run the task's `verify` command and report it in `evidence.checks` with its exit code; commit per task; "check `git status` and `git log` before repeating work".
  - `task-reviewer`: review only the commits in `taskCommits` (`git diff`/`git show`), not the whole tree.
  - `tester`: read `effectiveTasks` (including generated fix tasks) and check each task's `acceptance`; name the affected repo id in a finding's `repo` field when the failure is in an additional repo; write `testReport` including a "How to try it" section; on failure set `status: failed` and list each failing check as a finding (id, severity, text); never edit code.
  - `verifier`: for each contested finding, decide `verified` true/false with concrete evidence from the artifact or code; read-only; cover exactly the contested ids.
- `contract.md` gains: (a) a "Purposes" section naming the seven purposes and which result fields each needs (`verdict`+`findings` for review/task-review; `findings` with dispositions for fix; `verified` for verify; `evidence.commits`+`evidence.checks` for implement/fix; `findings` on a failed test); (b) the existing "Committing outputs" section extended: review, response, verify and report files are outputs and must be committed and listed.

- [ ] **Step 1: Failing tests** (`tests/superagent-prompts.test.mjs`, prompt-surface style like the existing ones):
  - `every role in milestone-2 has a template` — loop `MILESTONE_2_PIPELINE` roles plus `author`, `taskReview`, `verifier` through `hasTemplate`.
  - `the card carries purpose, round, final and the required outputs list when purpose is set`.
  - `a review card has target and previousFindings null in round 1, the previous review path in round 2`.
  - `a fix card has previousFindings pointing at the round's review file`.
  - `a task-review card lists cumulative taskCommits: round 2 after a fix includes the original implementation commit and the corrective commit`; `a verify card lists contested findings`.
  - `a tester card carries effectiveTasks including a generated fix task's acceptance criteria`.
  - **Migration:** the existing `a missing role template fails and a project override wins` test uses role `planner`, which now has a template; change it to the deliberately nonexistent role `no-such-role` (keeping both assertions and the override check).
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
- `launch` also persists `final` on `attempt-started`; `judge` passes `attempt: { purpose, round, final, task, taskDef, reviewFindings, contested }` to `validateResult`. For a **reconcile** of a derived attempt (no `live`), `purpose`/`round` come from the stored attempt and `taskDef`/`contested`/`reviewFindings` are rebuilt from `job` by a new exported pure helper in `sequencer.js`: `export function attemptContext(job, attempt)` (so reconcile validates with the same rules as a live finish).
- The `attempt-ended` payload gains `verdict`, `findings`, `commits`, `verified` from the validated result (empty/`null` when absent) and, for failed results, `signature` (Decision 13).
- `onApprovalRequest`: unchanged behaviour (deny every ask, brainstormer exception). A comment records that in `auto` the SDK does not call it for ordinary tools.

- [ ] **Step 1: Failing tests** (`tests/superagent-runner.test.mjs`, reusing its fake-registry harness and a temp git repo):
  - `attempt-started records purpose and round`; `no purpose defaults to author`.
  - `a valid review result ends the attempt with verdict and findings stored on the derived attempt`.
  - `a valid implement result stores commits; a missing verify check ends the attempt invalid-result`.
  - `a worker-reported failed result gets a signature, and two identical failures produce equal signatures`.
  - `reconcile validates a finished fix attempt with the same rules as a live finish` (build a job with a review attempt and its findings, an unfinished fix attempt whose result.json is valid for those ids; `reconcile` ends it `done`; the same file with an extra id ends it `failed(invalid-result)`).
  - `attemptContext rebuilds taskDef, contested and reviewFindings from the job` (pure, in the sequencer tests file).
  - `a non-final fix with an open blocker ends invalid-result live and in reconcile (final is persisted and rebuilt); the same result on the final fix is accepted`.
  - **Migrations:** `tests/superagent-runner.test.mjs` launches a `launchAction({ role: 'planner' })` to provoke `launch-failed` for a missing template — change the role to `no-such-role`. `tests/superagent-sequencer.test.mjs` has `assert.deepEqual(outcomeForResult({ status: 'failed' }), { outcome: 'failed', reason: 'failed' })` and the `blocked` equivalent — update them to the new shape (`reason` plus a `signature` string; assert `reason` and `typeof signature`), keeping the `done` and question cases exact.
  - All other existing runner tests pass unchanged.
- [ ] **Step 2: Run** the runner and sequencer tests; expect FAIL.
- [ ] **Step 3: Implement.** `attemptContext` lives in `sequencer.js` (pure) and is imported by `runner.js`. No change to claim/finish/nudge/stall logic.
- [ ] **Step 4: Run** runner tests, then `npm test`.
- [ ] **Step 5: Commit** `feat: runner carries attempt purpose and round and records richer outcomes`.

### Task 8: Supervisor — execute the new actions, preflights, fixture

**Files:** Modify `src/superagent/index.js`, `tests/superagent.test.mjs`.

**Interfaces:**
- `createJob({ …, fixture })` accepts `'milestone-2'` via `FIXTURES`; `resolvePipeline` additionally (a) rejects a pipeline whose roles (phase `role`, review `author`, per-task `taskReview`, and `verifier` when a review or per-task phase exists) lack a template with `ERR_NO_TEMPLATE` (Decision 11; a `projectDir` override counts), (b) on win32 rejects with `ERR_PATH_TOO_LONG` per Decision 14 (a `platform = process.platform` option on `createSuperagent` for tests). `RUNNABLE_KINDS` now includes `review` and `per-task`, so the Plan 2 "phase kinds not runnable yet" error no longer fires for them.
- `stepJob` handles, in the existing per-job chain and with the existing stop/recheck discipline:
  - `load-tasks` → read `docs/superpowers/jobs/<slug>/tasks.json` from the primary worktree, `parseTasks`, append `tasks-loaded`; a read/parse failure appends `needs-you { reason: 'stuck', detail: { why: 'tasks-invalid', errors } }`.
  - `complete-phase` → append `phase-completed { phase, visit, unresolved, verification }` exactly as returned by the sequencer.
  - `route-test-failure` → append ONE `test-routed { attemptId, task: buildFixTask(job, attemptId, findings) }` through `appendConfirmed` (landed check: a task with that `fromAttemptId` exists), reloading on rejection. `deriveJob` ignores a duplicate, so replay after a landed-but-rejected append is safe.
  - A `needs-you` from a verified blocker carries `detail: { kind: 'blocker', text, evidence }`.
- `getJob`/`listJobs` expose `tasks`, `visits`, `completions` and each attempt's `purpose`/`round`/`final`/`verdict`/`findings`/`verified` through the derived job unchanged.

- [ ] **Step 1: Failing tests** (`tests/superagent.test.mjs`, existing `harness`):
  - `createJob with the milestone-2 fixture provisions and validates` (job `running`, seven-phase pipeline stored).
  - `createJob rejects a pipeline whose role has no template with ERR_NO_TEMPLATE, and the default pipeline fails on brainstormer`; `a project override template satisfies the check`.
  - **Migration:** `tests/superagent.test.mjs` currently expects `create(h, { fixture: 'milestone-2' })` to reject with `ERR_UNKNOWN_FIXTURE` (twice) and `create(plain, { fixture: undefined })` to reject with `ERR_PHASE_KIND_UNSUPPORTED`. Change the unknown-fixture probes to a still-unknown name (`'milestone-9'`), and the default-pipeline expectation to `ERR_NO_TEMPLATE` (review and per-task are runnable now, `brainstormer` has no template). Keep every other assertion.
  - `createJob on win32 with a long COCKPIT_HOME-style root rejects with ERR_PATH_TOO_LONG; a short root passes` (inject `platform: 'win32'` and a long `worktreesRoot`).
  - `tick: a finished review loop appends phase-completed and the phase index advances`.
  - `tick: load-tasks appends tasks-loaded once; an invalid tasks.json parks the job needs-you stuck with the errors`.
  - `tick: route-test-failure appends one test-routed event; replaying the tick after a rejected-but-landed append appends nothing more` (use the store's `openImpl` seam from Plan 2 tests to fail one append after write).
  - `getJob exposes completions with unresolved findings and verifier evidence after a restart` (stop, rebuild the supervisor on the same store, start, assert `completions[0].unresolved`).
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
  - `a task review loop: changes then fix then approve completes the task; round 2's card lists both the original and the corrective commit; at taskReviewRounds the verifier path is the same`.
  - `two test-failure cycles: a planner task named F1 does not collide with the generated fix id, the second cycle's implement completion advances to test (visit 2), and a stale visit-1 phase-completed appended by hand is ignored`.
  - `an additional-repo-only task completes with a commit in the additional repo plus the primary report commit`; `a test failure naming an additional repo routes a fix task whose repos include it`.
  - `a plan-review fix that corrupts tasks.json is invalid-result and retried`.
  - `test failure routing`: the first `test` attempt returns `failed` with two findings → one generated `F-xxxxxxxx` task is appended, `implement` runs it, `test` runs again and passes; a second test run that fails again at the attempt cap parks the job `needs-you(stuck)`; a restart (`stop()`, rebuild supervisor on the same store, `start()`) immediately after the `test-routed` event (before any implement attempt) launches the fix task, not a second tester, and appends no second `test-routed`.
  - `an invalid tasks.json (cycle) fails the planner attempt as invalid-result and the planner is retried`.
  - `stopJob mid-review-loop closes the live attempt and launches nothing more`.
- [ ] **Step 2: Run** `node --test tests/superagent-pipeline.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement** `scriptedWorker` and any small supervisor fixes the tests expose. Fixes to production code found here are reported in the task report and each gets its own regression test in the owning module's test file.
- [ ] **Step 4: Run** the pipeline tests, then `npm test`.
- [ ] **Step 5: Commit** `test: milestone-2 pipeline integration with scripted workers`.

### Task 10: Manual probe and docs

**Files:** Create `tests/superagent-pipeline.manual.mjs`; modify `CLAUDE.md`, `tests/README.md`.

- [ ] **Step 1: Write `tests/superagent-pipeline.manual.mjs`**, modelled on `tests/superagent-two-phase.manual.mjs` (temp `COCKPIT_HOME`, toy repo, 10-minute-per-phase wall-clock deadline scaled to 40 minutes total, the same fake-ws `TOOL_USE` logging, wrapped interceptor). It creates a `milestone-2` job with a deliberately tiny idea ("a `hello.txt` containing `hi`, with a `node` one-liner as verify"), caps `maxRounds` at 1 and `taskReviewRounds` at 1, `attemptsPerPhase` 2, and prints per-attempt purpose/outcome/summary, every `phase-completed`/`test-routed` event, the final state, the worktree `git log --oneline`, and which artifact paths exist. Header states: not run by implementers; no cost cap beyond the wall-clock and attempt limits; spend is not a constraint for this plan but the run is still the controller's to start; it observes what the unit tests cannot (do real reviewers produce parseable verdict/findings, do real planners produce a valid `tasks.json`, does the real implementer report the `verify` check). `node --check` must pass.
- [ ] **Step 2: Docs.** `CLAUDE.md`: update the Superagent paragraph — phases now runnable (`author`, `review`, `per-task`, `human`), the `milestone-2` fixture, what still does not exist (router, brainstorm, usage ledger, caps, UI). `tests/README.md`: append a "Superagent pipeline (Plan 3)" section listing what is unit-tested and what only the manual probe observes. Append-only edits.
- [ ] **Step 3:** `node --check tests/superagent-pipeline.manual.mjs`; `npm test` green; working tree clean after the commit.
- [ ] **Step 4: Commit** `docs: superagent pipeline probe and coverage notes`.

---

## Self-review notes (author)

- **Spec coverage (milestone 2):** review loops with cap and verifier (Tasks 3, 5, 9); per-task implementation with task review (Tasks 4, 5, 9); test-failure routing (Tasks 5, 8, 9); role templates and the contract (Task 6); results rules from "Validation before the sequencer advances" for `implement` (Task 4). The isolated router is deliberately Plan 4 (see Scope split).
- **Interface consistency:** `purpose` values are the same seven strings in Tasks 2, 3, 5, 6, 7. `attemptContext` (Task 7) is the one place that rebuilds `taskDef`/`contested`/`reviewFindings` for reconcile. `requiredOutputs` (Task 3) is the one place that maps purpose to paths, used by results (validation) and prompts (card `outputs`).
- **Known divergences from the spec, ruled here:** fix tasks are events, not edits to `tasks.json` (Decision 9); the verifier also serves task review (Decision 8); unresolved findings are recorded in `phase-completed` and appended to the artifact only by the author's final pass (Decision 7).
- **Test counts are not pinned** (Plan 2's counts drifted); the gate is "baseline 807 green plus every test named in the task".

## Revision 2 changes (Codex review, 17 findings)

1. **Fix-task id collisions** → id derived from the failed attempt (`F-` + 8 chars), planner ids in that pattern rejected, dedupe by `fromAttemptId` (Decision 10, Task 4, Task 5).
2. **Routing crash window** → one atomic `test-routed` event replaces `fix-task-added` + `phase-rewound` (Decision 3, Task 2, Task 8).
3. **Phase-event idempotence across cycles** → `visits` and a `visit` on `phase-completed` (Decision 3, Task 2).
4. **Attempt-cap guard stopping loops** → failed-attempt cap inside `reviewLoop`, loop state evaluated before launch guards (Decision 4, Task 5).
5. **Fix task missing `dependsOn`** → one `buildFixTask` builder (Task 5).
6. **Non-primary task cannot commit its report** → primary commits always allowed, code evidence needed in task repos (Decision 17, Task 4).
7. **Test fixes could not repair additional repos** → findings carry an optional `repo`; fix task repos derive from it (Decision 10, Task 3, Task 5).
8. **Review fixes did not publish or validate revised artifacts** → `reviseOutputs`, clean-tree check, `tasks` revalidated after planner fixes (Decision 16, Tasks 3 and 4).
9. **Non-final blocker rule absent** → `final` persisted on `attempt-started`, enforced live and in reconcile (Decision 7, Tasks 2, 3, 7).
10. **Missing verifier model** → config validation requires `models.verifier` (Decision 18, Task 1).
11. **Task review lost the original implementation** → cumulative `taskCommits` (Decision 17, Task 6).
12. **Tester could not see fix tasks** → `effectiveTasks` on every card (Decision 9, Task 6).
13. **Unresolved findings vanished** → `completions` derived and exposed (Decision 3, Tasks 2 and 8).
14. **"Existing tests unchanged" was false** → explicit test migrations in Tasks 6, 7 and 8.
15. **Path bound relied on an unenforced limit** → portable id grammar enforced for phases (Task 1) and tasks (Task 4).
16. **`freezePhase` and an index slip in Task 1** → `inputs` defaults to `[]`; expected index is `pipeline[4].taskReview`.
17. **Weak reviewer-bound test** → exact purpose sequences and injected-failure cases (Task 5).

## Execution amendments (controller rulings during SDD, 2026-11-04)

These supersede the text above where they differ; the ledger (`.superpowers/sdd/2026-11-04-superagent-p3-pipeline/progress.md`, git-ignored) holds the full record.

- **Decision 14 / Task 4 / Task 6 / Task 8 (Windows path guard):** the limit is 259 (MAX_PATH including the terminating NUL), not 240; task ids are capped at **12** characters (`/^[a-z0-9][a-z0-9-]{0,11}$/i`), not 24; on win32 `createJob` trims the slug (`slugify(title, jobId, maxBase = 40)`) to fit and refuses with `ERR_PATH_TOO_LONG` only when fewer than 8 title characters would fit. Reason: at 240 almost no milestone-2 job passed under the default `COCKPIT_HOME`.
- **Task 3 / Task 6 (review findings):** a review or task-review finding may omit `disposition` (treated as `open`); templates still tell reviewers to set it. `reviewFindings` is passed to the validator as finding objects, not bare ids. Duplicate finding ids are rejected.
- **Task 5:** routed tester failures are excluded from the test phase's repeated-error window, back-off and recovery note; the consuming-attempt cap still counts every tester attempt.
- **Task 8:** `tasks.json` read errors other than ENOENT are retried on the next tick instead of parking the job. The blocker `needs-you` detail also carries `attemptId`, `phase` and `task`.
- **Test routing visit:** the `test` phase's visit stays 1 after a rewind (it advances on attempt `done`, not `phase-completed`).
