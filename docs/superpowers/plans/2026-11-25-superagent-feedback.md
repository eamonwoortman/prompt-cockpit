# Superagent: Give feedback on a ready-to-try job — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ready-to-try job gets a Give feedback action: a read-only triage attempt routes the feedback as `fix`, `subplan` or `separate`, and the job carries out the change in the same job, folder and branch, then returns to ready-to-try.

**Architecture:** Engine-level, modelled on `test-routed`. New events (`feedback-given`, `feedback-routed`, `tasks-appended`) and an `attempt.feedbackRound` field scope the task-writing, plan review, test and human phases to the current round. Path and key helpers resolve every round output under `<artifact root>/feedback/round-<N>/` with `feedback:<N>:` keys. A new pure module `src/superagent/feedback.js` holds the workflow-shape, eligibility and round-path rules that the store, sequencer, results, prompts and view model share.

**Tech Stack:** Node.js 26 ESM, `node:test`, git CLI, vanilla browser JS.

**Spec:** `docs/superpowers/specs/2026-11-25-superagent-feedback-design.md`

## Global Constraints

- Feedback `text`: 1-4000 characters after trim (`ANSWER_MAX_CHARS`). `needsYouSeq` is required at the library boundary and the route.
- Routes: `fix` | `subplan` | `separate`. There is no `new_job` route.
- Error codes: `ERR_FEEDBACK_UNSUPPORTED` (400), `ERR_INVALID_REQUEST` (400: bad text, missing seq), `ERR_INVALID_STATE` (409: stale seq, wrong state).
- Round folder: `<ledgerArtifactRoot(jobId)>/feedback/round-<N>/`. Round output path: `<round folder>/outputs/<key><extension of the workflow path>`. Round test report: `<round folder>/tests/<key>-<reportOrdinal><ext>` (Feature: `tests/testReport-1.md`), where `reportOrdinal` = 1 + the number of test attempts already started in the round (retried, interrupted and gated ones included), recorded on `attempt-started`, never the cap counter `n`. Triage file: `<round folder>/triage.md`. Round review files: `reviewPaths` names under `<round folder>/reviews/`.
- Round artifact keys: `feedback:<N>:<kind>:...`, where the second segment is a fixed word, so no workflow key can collide with an engine file:
  - `feedback:<N>:triage`
  - `feedback:<N>:out:<key>` (sub-plan outputs)
  - `feedback:<N>:test:<key>:<reportOrdinal>`, and the alias `feedback:<N>:test:<key>` for the latest done tester's report
  - `feedback:<N>:review:...`, `feedback:<N>:response:...`, `feedback:<N>:verify:...` (today's review keys behind the round prefix)
- `triage.md` body: the result's `brief`, then `## Requirement changes` and one `- ` line per entry (or `- None`).
- Triage role: `triage`, an engine role (added to `ENGINE_ROLES`), read-only (`READ_ONLY_TOOLS`, `disallowedTools: ['mcp__*']`), default model unchanged from `defaultConfig().models.triage` (`claude-sonnet-5-5`, maxTurns 20), from config only, resolved at `feedback-given`.
- Eligible task-writing outputs: their keys are unique case-insensitively (`plan` and `Plan` together make the job ineligible).
- Eligible layout: task-writing phase, then optionally its review phase (target = one of its outputs, author = its role), then `per-task`, then `test: true`, then the final `human` phase, back to back.
- Triage runs under `maxConcurrentSessions` like any worker; there is no reserved slot.
- Absent `feedbackRound` on any event means 0. Old event logs must derive exactly as before.
- `feedback/` becomes a reserved artifact path prefix in `workflows.js`.
- Baseline: SHA-256 of every file under the job's ledger artifact root except `feedback/round-<current>/**` and `tasks/*-tests/**`.
- `npm test` stays green before every commit. Commit messages follow `feat(superagent): ...`, with no `Co-Authored-By` trailer.

## Review Focus

1. Cockpit restarts between the triage attempt ending and `feedback-routed`, or between the plan review completing and `tasks-appended`. Expected: the job resumes and routes or appends exactly once (Task 6 tests `routes after a restart before feedback-routed`, `appends round tasks after a restart before tasks-appended`).
2. Give feedback double-clicked, or raced against Accept. Expected: one round or one accept, never both (Task 6 test `feedback and accept on one needs-you: only the first lands`).
3. The real test job, created before this code: its 52 attempts keep their meaning, and triage gets a model even though `job.models` has none (Task 1 test `old event logs derive unchanged`, Task 6 test `resolves the triage model for a job created before triage existed`).
4. A second feedback round after the first. Expected: no path, key, verdict or cap from round 1 leaks into round 2 (Task 4 test `round 2 review ignores round 1 approve`, Task 7 test `round keys do not collide across rounds`).
5. A round tester fails, then a retest runs after a routed fix, a Retry or an interrupted attempt. Expected: the retest writes a new, higher-numbered report and is never satisfied by an older file (Task 3 test `round test outputs are numbered by report ordinal`, Task 4 tests `retest in a round gets the next report ordinal`, `a retried tester does not reuse its report ordinal`).

---

### Task 1: Round events in the store

**Files:**
- Modify: `src/superagent/store.js:25` (EVENT_TYPES), `:91-100` (job defaults), `:147-165` (`job-retried`), `:168-208` (`attempt-started`), `:221-246` (`attempt-ended`), `:247-259` (new cases)
- Test: `tests/superagent-store.test.mjs`

**Interfaces:**
- Produces, events:
  - `{ type: 'feedback-given', round, forNeedsYouSeq, text, triageModel: { model, effort, maxTurns }, baseline: Record<rel, sha256>, pendingChanges: Record<repoId, { paths, total }> }`
  - `{ type: 'feedback-routed', round, attemptId, route, task? }`
  - `{ type: 'tasks-appended', round, tasks }`
  - `attempt-started.feedbackRound?`, `attempt-started.reportOrdinal?`, `attempt-ended.triage?`, `job-retried.feedbackRound?`, `job-retried.reopen?`, `job-retried.errors?` (the stuck detail's `errors`, kept on the retry record)
- Produces, derived:
  - `attempt.reportOrdinal: number | null`
  - `job.feedbackRound: number` (0 by default)
  - `job.feedbackRounds: [{ round, forNeedsYouSeq, text, triageModel, baseline, pendingChanges, at, route: null | 'fix' | 'subplan' | 'separate', attemptId: null | string, tasksAppended: boolean }]`
  - `attempt.feedbackRound: number`, `attempt.triage: null | { route, summary, requirementChanges, task?, idea? }`

- [ ] **Step 1: Write the failing tests** over a Feature-shaped job: `jobCreated({ pipeline: <workflows/feature.json phases>, workflow: { id: 'feature', ... }, artifactRoot: 'ledger' })` plus `provisionedEvents()`. `build()` in `tests/superagent-sequencer.test.mjs` defaults to `MILESTONE_1_PIPELINE`, which has no planner, per-task or test phase.

- `feedback-given applies only to its ready-to-try`: the job at `needs-you`/`ready-to-try` with `needsYouSeq: 9` → `feedback-given { round: 1, forNeedsYouSeq: 9 }` sets `state: 'running'`, `feedbackRound: 1`, one `feedbackRounds` entry. The same event again, or one with `forNeedsYouSeq: 8`, changes nothing.
- `feedback-routed fix appends the task and re-enters per-task`: `job.tasks` gains the task (`origin: 'feedback'`, `round: 1`), `phaseIndex` = the per-task index, `visits.implement` +1. A replay changes nothing.
- `feedback-routed subplan re-enters the task-writing phase`: `phaseIndex` = the `plan` index, and `visits.plan` and `visits['plan-review']` each +1 once.
- `feedback-routed separate is a fresh ready-to-try`: `state: 'needs-you'`, `reason: 'ready-to-try'`, `needsYouSeq` = the event's seq, `detail: { phase: 'accept', feedback: { round: 1 } }`.
- `tasks-appended adds round tasks once`: tasks are appended, `visits.implement` +1, `tasksAppended: true`. A replay with the same round changes nothing.
- `job-retried in a round marks only that round's attempts`: a failed round-1 test attempt and a failed round-0 one in the same phase → only the round-1 attempt gets `retried: true`.
- `job-retried reopen resets the round's authoring and review`: `{ reopen: true, phase: 'plan', feedbackRound: 1 }` marks every round-1 `plan` and `plan-review` attempt `retried`, whatever its outcome, sets `phaseIndex` to `plan`, and bumps `visits.plan` and `visits['plan-review']` once each. A replay of the round's earlier `phase-completed { phase: 'plan-review', visit: <old> }` after the reopen changes nothing.
- `a pending retry is consumed only in its round`: a round-1 retry record for `test` is not consumed by a round-2 `attempt-started` in `test`.
- `attempt-ended keeps the triage decision`: `attempt.triage` equals the event's `triage`.
- `old event logs derive unchanged`: every existing test in this file passes without edits. Before changing `store.js`, write an expected object literal for the Feature-shaped job after one done planner attempt (state, phaseIndex, visits, tasks, the attempts' existing fields). After the change, the derived job with the new fields removed deep-equals that literal, and the new fields are `feedbackRound: 0`, `feedbackRounds: []`, `attempt.feedbackRound: 0`, `attempt.reportOrdinal: null`, `attempt.triage: null`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-store.test.mjs`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement the reducer cases**

Follow the `test-routed` and `job-retried` cases. Find the per-task, task-writing and plan review phases with `feedbackShape` from Task 2; if Task 2 has not landed yet, inline the lookup and switch over in Task 2. `pendingRetry`'s record gains `feedbackRound`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/store.js tests/superagent-store.test.mjs
git commit -m "feat(superagent): feedback round events in the job store"
```

### Task 2: Workflow shape, eligibility and round paths

**Files:**
- Create: `src/superagent/feedback.js`
- Modify: `src/superagent/workflows.js:31` (RESERVED_PATHS), `src/superagent/store.js` (use `feedbackShape`)
- Test: `tests/superagent-feedback.test.mjs` (new), `tests/superagent-workflows.test.mjs`

**Interfaces:**
- Produces (all pure):
  - `feedbackShape(job): { taskWriting, planReview: Phase | null, perTask, test, human, requirementKeys: string[] } | null`
  - `feedbackEligibility(job): { ok: true } | { ok: false, why: string }`. `why` is one of `'not-ready'`, `'legacy-artifacts'`, `'workflow-shape'`, `'feedback-path-in-use'`, `'output-keys-clash'`.
  - `currentRound(job): number`, `roundOf(attempt): number`
  - `isRoundScoped(job, phaseId): boolean`: true for the task-writing, plan review, test and human phases
  - `roundDir(job, round): string`
  - `roundOutputPaths(job, round, keys): Record<key, rel>`
  - `roundTestReportPaths(job, round, reportOrdinal): Record<key, rel>`
  - `roundTriagePath(job, round): string`
  - `roundKey(round, key): string`, `parseRoundKey(key): { round, key } | null`
  - `roundRoute(job, round): null | 'fix' | 'subplan' | 'separate'`

- [ ] **Step 1: Write the failing tests**

- `shape of the built-in workflows`: Feature → `taskWriting.phase === 'plan'`, `planReview.phase === 'plan-review'`, `requirementKeys` `['spec']`. Troubleshooting → `investigate`, `diagnosis-review`, `['diagnosis']`.
- `shape is null without a single task-writing phase`: a pipeline with two `author` phases that output `tasks` → `null`; one with none → `null`.
- `shape requires the back-to-back layout`: Feature with an extra `author` phase inserted between `plan-review` and `implement` → `null`; a `review` phase after `plan` whose `author` is `planner` but whose `target` is `spec` → `null`; a pipeline `plan` → `implement` → `test` → `accept` (no review) → a shape with `planReview: null`.
- `output keys that differ only in case are refused`: a task-writing phase with outputs `['plan', 'Plan', 'tasks']` (paths `design.md`, `rollout.md`, `tasks.json`) → `{ ok: false, why: 'output-keys-clash' }`.
- `a legacy ledger job qualifies`: a ledger job with no recorded `workflow` (normalised to `feature` by `deriveJob`) at ready-to-try → `{ ok: true }`.
- `eligibility refuses`: `artifactsCommitted` legacy job → `legacy-artifacts`; a job whose recorded `artifacts` has `feedback/notes.md` (and `Feedback/x.md`) → `feedback-path-in-use`; a running job → `not-ready`.
- `round paths`: for jobId `J`, Feature, round 2: `roundOutputPaths(job, 2, ['plan', 'tasks'])` → `{ plan: '.superpowers/superagent/J/artifacts/feedback/round-2/outputs/plan.md', tasks: '.../feedback/round-2/outputs/tasks.json' }` (with `ledgerArtifactRoot`'s exact prefix); `roundTestReportPaths(job, 2, 3)` (report ordinal 3) → `{ testReport: '.../feedback/round-2/tests/testReport-3.md' }`; `roundTriagePath(job, 2)` → `.../feedback/round-2/triage.md`.
- `round keys round-trip`: `parseRoundKey(roundKey(3, 'review:plan-review:1'))` → `{ round: 3, key: 'review:plan-review:1' }`; `parseRoundKey('plan')` → `null`.
- `a workflow key named triage cannot collide`: a task-writing phase with outputs `['triage', 'tasks']` → `roundOutputPaths` gives `.../outputs/triage.<ext>` and the round key `feedback:1:out:triage`, distinct from `roundTriagePath` and `feedback:1:triage`.
- Workflows: `a workflow artifact under feedback/ is invalid`: `artifacts: { x: 'feedback/x.md' }` is listed invalid with a reserved-path error.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-feedback.test.mjs tests/superagent-workflows.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `src/superagent/feedback.js`; add `'feedback/'` to `RESERVED_PATHS`**

Use `results.js`'s `artifactPaths` and `ledgerArtifactRoot`. Compare paths case-insensitively for `feedback-path-in-use`. Switch Task 1's inline phase lookup to `feedbackShape`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/feedback.js src/superagent/workflows.js src/superagent/store.js tests/
git commit -m "feat(superagent): feedback workflow shape, eligibility and round paths"
```

### Task 3: Round-aware result validation

**Files:**
- Modify: `src/superagent/results.js:74-123` (`reviewPaths`, `PURPOSE_OUTPUT`, `requiredOutputs`, `reviseOutputs`), `:157-217` (`parseTasks`), `:426-443` (`purposeErrors`), `:597-689` (`reviseErrors`, `outputErrors`, `tasksFileErrors`), `:729-755` (`validateResult`)
- Test: `tests/superagent-results.test.mjs`

**Interfaces:**
- Consumes: Task 2's path helpers.
- Produces:
  - `reviewPaths(job, { phase, round, taskId, feedbackRound = 0 })`: with `feedbackRound > 0`, the `review`/`response`/`verify` paths move under `roundDir(job, feedbackRound)/reviews/`; task paths are unchanged.
  - `requiredOutputs(job, { phase, purpose, round, task, feedbackRound = 0, reportOrdinal = null })`: purpose `triage` → `[roundTriagePath]`; `feedback-plan` → the values of `roundOutputPaths(job, feedbackRound, phase.outputs)`; `test` with `feedbackRound > 0` → the values of `roundTestReportPaths(job, feedbackRound, reportOrdinal)`.
  - `reviseOutputs(job, phase, { feedbackRound = 0 } = {})`: round paths when `feedbackRound > 0`.
  - `parseTasks(text, job, { existing = [] } = {})`: ids collide case-insensitively with `existing` ids; `dependsOn` resolves against `existing` plus the file.
  - `triageErrors(value, job)`, wired into `purposeErrors` for purpose `triage`.
  - `baselineErrors(job, round): Promise<string[]>`: `changed since feedback was given: <rel>` per mismatch, `missing since feedback was given: <rel>` per deleted file.

- [ ] **Step 1: Write the failing tests**

- `round review paths`: `reviewPaths(job, { phase: 'plan-review', round: 1, feedbackRound: 2 }).review` ends `/feedback/round-2/reviews/plan-review-r1.md`; with `feedbackRound: 0` it equals today's value.
- `feedback-plan outputs`: `requiredOutputs(job, { phase: plan, purpose: 'feedback-plan', feedbackRound: 1 })` → the round's `plan.md` and `tasks.json`.
- `round test outputs are numbered by report ordinal`: `requiredOutputs(job, { phase: test, purpose: 'test', feedbackRound: 1, reportOrdinal: 2 })` → `[.../feedback/round-1/tests/testReport-2.md]`; a done round tester whose `tests/testReport-2.md` is missing while `tests/testReport-1.md` exists → invalid with `missing output`.
- `round review fix revises the round plan`: `reviseOutputs(job, planReview, { feedbackRound: 1 })` → the round paths, never `plan.md`.
- `round tasks may depend on earlier tasks`: `parseTasks('[{"id":"B1",...,"dependsOn":["A1"]}]', job, { existing: [{ id: 'A1' }] })` → ok.
- `round task ids may not collide`: an id `a1` with existing `A1` → error containing `collides with an existing task`.
- `round tasks file is checked at fix time`: a `fix` result in plan review round 1 of feedback round 1, whose round `tasks.json` has a cycle → invalid.
- `triage result schema`: a `done` result without a non-empty string `brief` → error `brief must be a non-empty string`, even when a `triage.md` from an earlier rejected result exists on disk; `route: 'later'` → error; `fix` without `task.title` → error; `separate` with `idea` of 4001 characters → error; `requirementChanges: 'x'` → error; a valid `subplan` result → ok.
- `baseline refuses a changed original`: `plan.md` edited after `feedback-given` → `validateResult` for a round attempt is not ok, with `changed since feedback was given: <plan rel>`. Any `status` is checked.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-results.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

`validateResult` reads `attempt.feedbackRound` and `attempt.reportOrdinal`, passes them to `requiredOutputs` and `reviseErrors`, and runs `baselineErrors` first when `feedbackRound > 0`. The `publishesTasks` check also covers `feedback-plan`, and round review fixes of the round tasks path, using `tasksFileErrors(job, rel, job.tasks ?? [])`. Triage results carry no commits; `schemaErrors` already allows an empty `artifacts`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/results.js tests/superagent-results.test.mjs
git commit -m "feat(superagent): validate feedback round results and round files"
```

### Task 4: Round scoping and feedback actions in the sequencer

**Files:**
- Modify: `src/superagent/sequencer.js:48-55` (`attemptsFor`, `pendingRetry`), `:88-91` (`answeredInScope`), `:238-270` (`launch`), `:339-384` (`authorAction`), `:455-474` (`perTaskAction`), `:571-615` (`attemptContext`), `:617-626` (`nextAction`)
- Test: `tests/superagent-sequencer.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:
  - `attemptsFor(job, phase, task = null, round = currentRound(job))`: filters by `roundOf(a) === round` only when `isRoundScoped(job, phase)`.
  - New actions:
    - `{ type: 'route-feedback', round, attemptId }`
    - `{ type: 'load-round-tasks', round }`
  - A launch action carries `feedbackRound` (when > 0), `reportOrdinal` (round test attempts only) and `retryErrors` (from a pending retry record's `errors`).
  - Purposes: `triage` (role `triage`, model from the round's `triageModel`) and `feedback-plan`.
  - `attemptContext(job, attempt)` reconstructs with `roundOf(attempt)` and returns the attempt's `feedbackRound` and `reportOrdinal`.

- [ ] **Step 1: Write the failing tests**

- `ready-to-try with no round needs the user`: unchanged.
- `a new round launches triage`: after `feedback-given` → `launch` with `role: 'triage'`, `purpose: 'triage'`, `feedbackRound: 1`, `model: 'claude-sonnet-5-5'`, `recovery: false`, `n: 1`.
- `a done triage routes`: triage `attempt-ended done` with `triage.route: 'subplan'` → `{ type: 'route-feedback', round: 1, attemptId }`.
- `triage question then answer relaunches triage`: question → `needs-you`/`question`; after `question-answered` → `launch` triage with `recovery: true`.
- `subplan round launches feedback-plan, not a recovery of round 0`: after `feedback-routed subplan` → `launch` `phase: 'plan'`, `purpose: 'feedback-plan'`, `recovery: false`, `previousAttemptId: null`, `n: 1`, even though round 0's planner used 1 of 3 attempts.
- `round 2 review ignores round 1 approve`: round 1 plan-review approved, round 2's feedback-plan done → `launch` `purpose: 'review'`, `round: 1`.
- `per-task waits for round tasks`: in a subplan round with the per-task phase current and every round-0 task complete → `{ type: 'load-round-tasks', round: 1 }`, not `complete-phase`.
- `retest in a round gets the next report ordinal`: a failed round-1 tester (`reportOrdinal: 1`) routed by `test-routed`, and its fix task complete → `launch` test with `reportOrdinal: 2`.
- `a retried tester does not reuse its report ordinal`: a failed round-1 tester (`reportOrdinal: 1`) then `job-retried` → `launch` test with `n: 1` and `reportOrdinal: 2`. An interrupted round tester (no outcome, reconciled away) also consumes its ordinal.
- `a second round's attempt caps start fresh`: round 1 used all 3 `plan` attempts (`attemptsPerPhase`); round 2 subplan → `launch` `feedback-plan` with `n: 1`.
- `reconciled round verifier keeps its contested ids`: `attemptContext` for a round-1 plan-review `verify` attempt, with round 0 approved → `contested` equals the round-1 cap outcome's ids.
- `question cap counts the round only`: three answered round-0 questions in `plan` do not stop a round-1 `feedback-plan` question.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-sequencer.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

`nextAction`'s human branch returns ready-to-try when `currentRound(job) === 0` or the round is routed. Otherwise it calls a new `triageAction(job, phase, ctx)` built on `authorAction`'s guard order (in-flight, question, cap, retry guard, concurrency), with no router. `authorAction` picks purpose `feedback-plan` for the task-writing phase in a `subplan` round. For the test phase in a round, it sets `reportOrdinal` = 1 + the count of the round's test attempts in `job.attempts`, unfiltered. `launch` reads `job.feedbackRounds[round - 1].triageModel` for role `triage`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/sequencer.js tests/superagent-sequencer.test.mjs
git commit -m "feat(superagent): scope phases to the feedback round and launch triage"
```

### Task 5: Triage runner, cards and prompts

**Files:**
- Modify: `src/superagent/prompts.js:12` (`READ_ONLY_ROLES`), `:85-161` (`purposeFields`), `:163-209` (`buildWorkerPrompt`)
- Modify: `src/superagent/runner.js`:
  - `:97`: a new injected `writeFileImpl = fsp.writeFile`
  - `:191-205`: materialise
  - `:227-240`: the `judge` payload
  - `:423-445`: the live record gains `feedbackRound`, `reportOrdinal` and `retryErrors`
  - `:462` and `:490`: the `attempt-started` append, and the attempt context handed to `buildWorkerPrompt`/`validateResult`
  - `:563`: reconcile uses `attemptContext`'s new fields
- Modify: `src/superagent/results.js:759-766` (`outcomeForResult` keeps `triage`)
- Create: `prompts/superagent/triage.md`
- Modify: `prompts/superagent/planner.md:8` and `investigator.md:9` (`dependsOn` may also name existing tasks in a feedback round), `verifier-tester.md:5` (replay the reproduction as amended by the card's feedback), `prompts/superagent/contract.md`, and the role prompts `planner.md`, `plan-reviewer.md`, `implementer.md`, `task-reviewer.md`, `tester.md`, `verifier.md`, `investigator.md`, `diagnosis-reviewer.md`, `fixer.md`, `fix-reviewer.md`, `verifier-tester.md`
- Test: `tests/superagent-prompts.test.mjs`, `tests/superagent-runner.test.mjs`

**Interfaces:**
- Consumes: Tasks 2-4.
- Produces:
  - The card fields:
    - `feedback: [{ round, text, triage, requirementChanges, pendingChanges }]` on every attempt with `feedbackRound > 0`
    - for triage, `feedbackText`, `earlierRounds`, `latestTestReport`
    - `target`, `outputs` and `reviseOutputs` resolved to round paths
    - `retryErrors: string[]` when the attempt consumed a retry record with `errors` (Task 1)
  - `attempt-ended.triage`.

- [ ] **Step 1: Write the failing tests**

- Prompts:
  - `triage card`: carries `resultVia: 'final-message'`, `purpose: 'triage'`, `feedbackText`, `outputs` = `{ triage: <round triage path> }`, and the paths of spec, plan, tasks and the original test report.
  - `round planner card`: `outputs` = the round plan/tasks paths, `feedback[0].text` = the feedback, `feedback[0].triage` = the triage path.
  - `round review fix card`: `target` = the round plan, and `reviseOutputs` = the round paths.
  - `round review card in full`: for a feedback-round-1 plan-review `review` attempt in review round 2, the card's `inputs` are `{ spec, tasks: <round tasks path>, triage: <round triage path> }`, `previousFindings` and `previousResponse` are the round's `reviews/` files, and the original `tasks.json` and `reviews/plan-review-r1.md` appear nowhere in the card. The same holds for a round-1 `verify` card.
  - `round 2 triage recovery card has only round 2 answers`: an answered round-1 triage question does not appear in a round-2 triage card's `userAnswers`.
  - `amended prompts`: `planner.md` and `investigator.md` contain `In a feedback round, dependsOn may also name tasks already in the job.`; `verifier-tester.md` contains `replay the reproduction as amended by the card's feedback`.
  - `round cards list the re-recorded pending changes`: `feedback[0].pendingChanges.primary.paths` equals the `feedback-given` value, for an in-place job and for a worktree job.
  - `every role prompt states feedback precedence`: each listed prompt file contains the line `Where the job card lists feedback, each round's requirementChanges amend the requirements in round order; a later round wins.`
- Runner:
  - `materialises triage.md before result.json`: a scripted triage final message with `status: 'done'`, `brief: 'B'`, `requirementChanges: ['add X']` → the round triage file equals `B\n\n## Requirement changes\n\n- add X\n`, and an injected `writeJsonImpl` asserts the file exists when it is called. A second materialisation of the same text leaves it byte-identical.
  - `a blocked triage writes no triage.md`: `status: 'blocked'` with a question → `result.json` written, no triage file, outcome `question`.
  - `a malformed triage decision writes no triage.md`: `status: 'done'` without `brief` → no triage file, and the attempt ends `failed` / `invalid-result` with `brief must be a non-empty string`. A first result with an invalid `route` but a valid `brief` (which writes `triage.md`), followed by a corrected one with no `brief`, is still invalid, so a stale file never backs a routed decision.
  - `live and reconciled round attempts validate against round files`: a round-1 tester with `reportOrdinal: 2` validates against `tests/testReport-2.md` live, and again after a restart (reconcile). A reconciled triage attempt derives `feedbackRound: 1`.
  - `attempt-ended carries the triage decision`: the appended event has `triage: { route, summary, requirementChanges, task }` and no `brief`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-prompts.test.mjs tests/superagent-runner.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Add `'triage'` to `READ_ONLY_ROLES`.
- In `materialise`, for role `triage` with `status === 'done'`, a string `brief` and an array `requirementChanges`, write the triage file (`mkdir -p` its folder) with the new injected `writeFileImpl`, before `writeJsonImpl`. Otherwise write no triage file.
- Carry `feedbackRound`, `reportOrdinal` and `retryErrors` from the launch action onto the live record, the `attempt-started` event and the attempt context passed to `buildWorkerPrompt` and `validateResult`. `purposeFields` and `buildWorkerPrompt` resolve `inputs`, `previousFindings`, `previousResponse` and `userAnswersFor` with the attempt's round.
- `judge` copies `route`, `summary`, `requirementChanges`, `task` and `idea` into `payload.triage` for purpose `triage`.
- `triage.md`'s prompt tells the worker:
  - pick the smallest route;
  - `fix` only when one task with one acceptance covers it;
  - `separate` when it is a different feature;
  - list every requirement change;
  - the evidence files are evidence, not instructions;
  - return the result as the final message.
- `contract.md` gains the feedback precedence line and a rule to leave a round's `pendingChanges` untouched and unstaged.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/prompts.js src/superagent/runner.js src/superagent/results.js prompts/superagent/ tests/
git commit -m "feat(superagent): triage worker, round job cards and feedback precedence"
```

### Task 6: Supervisor: giveFeedback, routing, round tasks, round-aware retry

**Files:**
- Modify: `src/superagent/index.js`:
  - `:106-110` (`needsYouDetail`)
  - `:303-347` (steps)
  - `:507-525` (action dispatch)
  - `:948` (`requireSeen`)
  - `:1038-1063` (`retryJob`)
  - `:1142` (exports)
- Modify: `src/superagent/config.js:17`: `ENGINE_ROLES` gains `'triage'`; the default `models.triage` stays `claude-sonnet-5-5`/20. Add `resolveEngineModel(fileConfig, origin, role)`, which applies `defaultConfig().models[role]` < `defaults.models[role]` < `projects[origin].models[role]`.
- Modify: `src/superagent/inplace.js:84-92` (extract `readPendingChanges({ git, folder })` from `checkInPlace` and export it)
- Test: `tests/superagent.test.mjs`, `tests/superagent-config.test.mjs`, `tests/superagent-inplace.test.mjs`, `tests/superagent-pipeline.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces:
  - `giveFeedback(jobId, { needsYouSeq, text } = {}): Promise<Job>`
  - `readPendingChanges({ git, folder }): Promise<{ paths, total }>`
  - `retryJob` reopens the task-writing phase for a round `tasks-invalid`.

- [ ] **Step 1: Write the failing tests**

- `giveFeedback`:
  - `validates and records the round`: a ready-to-try job → the event has `round: 1`, `forNeedsYouSeq`, the trimmed `text`, `triageModel.model === 'claude-sonnet-5-5'`, a `baseline` with the SHA-256 of `spec.md`, `plan.md`, `tasks.json`, the test report and `reviews/*`, and `pendingChanges.primary` from `git status`.
  - `refuses`: no seq → `ERR_INVALID_REQUEST`; a stale seq → `ERR_INVALID_STATE`; `''` or 4001 characters → `ERR_INVALID_REQUEST`; a legacy job → `ERR_FEEDBACK_UNSUPPORTED`; a running job → `ERR_INVALID_STATE`.
  - `resolves the triage model for a job created before triage existed`: a `job-created` with no `models.triage` → the event's `triageModel` is `{ model: 'claude-sonnet-5-5', maxTurns: 20 }`; with `projects[<origin>].models.triage.model = 'claude-opus-5-5'` it is Opus.
  - `feedback works when the workflow file is gone`: the job's recorded workflow file is deleted → `giveFeedback` still records the round.
  - `feedback and accept on one needs-you: only the first lands`: `Promise.allSettled([giveFeedback(...), accept(...)])` with the same seq → one fulfilled, one rejected with `ERR_INVALID_STATE`, and exactly one of `feedback-given` and `job-accepted` in the log.
- Routing and round tasks:
  - `routes after a restart before feedback-routed`: the store holds a done triage attempt with `triage.route: 'fix'` and no `feedback-routed`; a fresh supervisor's `tick()` appends `feedback-routed` once and the fix task once.
  - `appends round tasks after a restart before tasks-appended`: a subplan round with plan-review `phase-completed` and no `tasks-appended`; `tick()` parses the round `tasks.json` with the existing tasks and appends `tasks-appended` once.
  - `invalid round tasks go stuck with the round`: `needs-you`/`stuck`, `detail.why === 'tasks-invalid'`, `detail.round === 1`.
  - `retry on round tasks-invalid reopens authoring`: `retryJob` appends `job-retried { phase: 'plan', feedbackRound: 1, reopen: true }`. The next launch is `feedback-plan` with `recovery: true`, and its card's `retryErrors` holds the parse errors. Continue the loop: a fresh review (review round 1 of the reopened visit) runs and approves, then `tasks-appended` lands.
- Config: the existing assertion `[['triage'], 'claude-sonnet-5-5', 20]` (`tests/superagent-config.test.mjs:32`) stays. A workflow file whose `roles.triage` sets a model is listed invalid (`"triage" is an engine role`).
- Pipeline (scripted workers, `superagent-pipeline.test.mjs`). Create the job with `workflow: 'feature'` or `'troubleshooting'` explicitly, since the helper defaults to the `milestone-2` fixture. The triage handler returns its result as the final message, not through `publish()`: `publish()` writes every card output itself and would hide a broken runner publication.
  - `feature subplan round end to end`: ready-to-try → feedback → triage `subplan` → round plan → round review approve → tasks appended → the new task implemented and reviewed → round tester done → ready-to-try with a new seq. The original `plan.md`, `tasks.json`, the test report and the review files are byte-identical.
  - `feature fix round end to end`: the same with `fix`, with no plan or plan review attempt in the round.
  - `separate returns to ready-to-try`: no launches after triage, with a new `needsYouSeq`.
  - `troubleshooting subplan round end to end`: the task-writing phase is `investigate`, its round outputs are `diagnosis.md` and `tasks.json`, and the reviewing phase is `diagnosis-review`. The round's `requirementChanges` change the reproduction, and the verifier-tester card carries them.
  - `troubleshooting fix round end to end` and `troubleshooting separate`.
  - `subplan round without a review phase`: a custom workflow `plan` → `implement` → `test` → `accept` goes from `feedback-plan` straight to `tasks-appended`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent.test.mjs tests/superagent-config.test.mjs tests/superagent-inplace.test.mjs tests/superagent-pipeline.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `giveFeedback` runs under `withJob`. It checks seq and state (same messages as `accept`) and `feedbackEligibility`. It resolves `triageModel` as `resolvePipeline` resolves models for the job's recorded workflow and origin, then takes `.triage`. It computes `baseline` with `readdir({ recursive: true })` under the ledger artifact root, applying the Global Constraints exclusions, and runs `readPendingChanges` per repo (`worktree` or in-place folder). Then `appendConfirmed`, with the predicate that a round carries `forNeedsYouSeq`.
- `routeFeedbackStep` appends `feedback-routed` from `attempt.triage`. A fix task gets id `B<round>-<attemptId8>` (new `FEEDBACK_TASK_ID_RE = /^B[1-9][0-9]*-[0-9a-f]{8}$/i`, reserved alongside `FIX_TASK_ID_RE` in `parseTasks`) and `verify` from the task.
- `appendRoundTasksStep` mirrors `loadTasksStep`: the same in-place gate, `parseTasks(text, job, { existing: job.tasks })`, `stuck` with `detail: { why: 'tasks-invalid', errors, round }`.
- `retryJob`: when `detail.why === 'tasks-invalid'` and `detail.round > 0`, set `phase` to the task-writing phase, `reopen: true`, `errors: detail.errors` and `fromAttemptId` = the round's last done `feedback-plan` attempt. Every retry event carries `feedbackRound: currentRound(job)`.
- Export `giveFeedback` from `createSuperagent`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/index.js src/superagent/config.js src/superagent/inplace.js src/superagent/results.js tests/
git commit -m "feat(superagent): give feedback, route it and append round tasks"
```

### Task 7: View model and accounting for round artifacts

**Files:**
- Modify: `src/superagent/view-model.js:50-68` (`attemptKey`), `:70-121` (`artifactKeys`, `keysWritten`, `artifactWriters`), `:135-160` (`artifactPath`), `:190-210` (ready-to-try links), `:270-300` (`jobDetail`)
- Modify: `src/superagent/artifacts.js:77-114` (round keys through the read path)
- Test: `tests/superagent-view-model.test.mjs`, `tests/superagent-accounting.test.mjs`, `tests/superagent-artifacts.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces, in `jobDetail`:
  - `feedbackRounds: [{ round, text, route, summary, requirementChanges, idea, at }]`
  - `canGiveFeedback: boolean` (`feedbackEligibility(job).ok`)
  - per attempt `feedbackRound`
  - the ready-to-try links (built at `view-model.js:190-210` from the last human phase's inputs) drawn from the latest round when there is one
- Produces: `artifactPath(job, key)` resolves every round key form in Global Constraints.

- [ ] **Step 1: Write the failing tests**

- `round keys do not collide across rounds`: two rounds, each with a plan review round 1 → `artifactKeys` holds `feedback:1:review:plan-review:1` and `feedback:2:review:plan-review:1`, and `review:plan-review:1` still names the original attempt as writer.
- `round planner writes only round keys`: `artifactWriters(job).get('plan')` stays the round-0 planner; `feedback:1:out:plan` is the round planner.
- `triage writes feedback:N:triage`. Round test keys use the report ordinal: a failed tester (`n: 1`, `reportOrdinal: 1`), then a Retry, then a passing tester (`n: 1`, `reportOrdinal: 2`) → `feedback:1:test:testReport:1` keeps the failed tester as writer, `feedback:1:test:testReport:2` the passing one, and the alias `feedback:1:test:testReport` names the passing one.
- `artifactPath resolves round keys` to the Task 2 paths; an unknown round key → `null`.
- `jobDetail carries feedback rounds and links`: after a routed `subplan` round back at ready-to-try, `feedbackRounds[0].summary` is set and the ready-to-try links point at `feedback:1:triage` and `feedback:1:test:testReport`. Before any round, the links are unchanged.
- `canGiveFeedback` is false for a legacy job and for a running job.
- Accounting: `snapshots round artifacts`: after a done triage, the snapshot for `feedback:1:triage` is written once the attempt has no live session.
- Artifacts read path (`tests/superagent-artifacts.test.mjs`): `feedback:1:test:testReport:1`, `feedback:1:test:testReport:2` and the alias `feedback:1:test:testReport`, read through `artifacts.js`, serve the right file while the workspace exists, and the right snapshot after the ledger files are deleted. The alias serves the passing tester's report, not the failed one's.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-view-model.test.mjs tests/superagent-accounting.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

`keysWritten` maps a round review, response or verify attempt to `roundKey(round, <today's key>)`. A round `feedback-plan` and a round review fix write `feedback:<N>:out:<key>` for the task-writing phase's outputs. A round tester writes `feedback:<N>:test:<key>:<attempt.reportOrdinal>`, never its cap counter `n`. A triage attempt writes `feedback:<N>:triage`. `artifactWriters` adds the alias `feedback:<N>:test:<key>` for the latest done round tester. `accounting.js` needs no change if its tests pass on the new writer map; otherwise adjust only how it reads keys.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/view-model.js src/superagent/accounting.js src/superagent/artifacts.js tests/
git commit -m "feat(superagent): round artifacts in the job view and snapshots"
```

### Task 8: Route and view

**Files:**
- Modify: `src/routes/superagent.js:25-31` (`BAD_REQUEST` gains `ERR_FEEDBACK_UNSUPPORTED`), `:290-320` (action `feedback`)
- Modify: `public/superagent-view.js:754-800` (ready-to-try box), `public/superagent-job-pane.js` (attempt card round label), `public/superagent-format.js` (`feedbackRoundLabel(n): string`)
- Modify: `public/style-superagent.css` (textarea sizing, reusing the answer box's classes where they fit)
- Test: `tests/superagent-routes.test.mjs`, `tests/superagent-format.test.mjs`

**Interfaces:**
- Consumes: `giveFeedback` (Task 6), `jobDetail` fields (Task 7).
- Produces:
  - `POST /api/superagent/jobs/:id/feedback`, body `{ needsYouSeq, text }`
  - `feedbackRoundLabel(n)`: `''` for 0, `'feedback 1'` for 1

- [ ] **Step 1: Write the failing tests**

- Routes:
  - `feedback requires needsYouSeq`: no seq → 400 `ERR_INVALID_REQUEST` `needsYouSeq is required: the needs-you this feedback was written for`.
  - `feedback text must be text`: `text: 5` → 400 `ERR_INVALID_REQUEST`.
  - `feedback errors map`: `ERR_FEEDBACK_UNSUPPORTED` → 400; `ERR_INVALID_STATE` → 409.
  - `feedback is Origin-checked`: a POST with a foreign `Origin` is rejected exactly like `retry`'s.
  - `passes seq and text`: a stub `giveFeedback` receives `{ needsYouSeq: 7, text: 'make it readable' }`.
- Format: `feedbackRoundLabel(0) === ''` and `feedbackRoundLabel(2) === 'feedback 2'`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-routes.test.mjs tests/superagent-format.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

- The ready-to-try box, when `detail.canGiveFeedback`, adds a textarea with `maxlength="4000"` and a **Give feedback** button beside Accept. It POSTs and shows errors in the box's existing error line.
- With `feedbackRounds` present, the box shows the latest round's `summary`. After `separate`, it also shows the `idea` and a Copy button (`navigator.clipboard.writeText`).
- Attempt cards show `feedbackRoundLabel(attempt.feedbackRound)`.
- DOM behaviour is hand-verified (no jsdom; see `tests/README.md`), against the fixture COCKPIT_HOME from `tests/superagent-view-fixture.manual.mjs` with a ready-to-try job:
  1. The textarea and Give feedback appear beside Accept, and an over-long or empty text shows the error line.
  2. After giving feedback, the triage attempt card shows under the accept stage, labelled `feedback 1`.
  3. After a `separate` verdict, the summary and idea show, and Copy puts the idea on the clipboard.
  4. Accept still works after a round.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/superagent.js public/ tests/
git commit -m "feat(superagent): Give feedback route and ready-to-try box"
```

### Task 9: Docs and the real run on the Level Design Book job

**Files:**
- Modify: `CLAUDE.md` (the superagent paragraph: events, the triage role, round files, routes, Give feedback)
- Modify: `backlog.md:157`: remove "Give feedback on a ready-to-try job" and add two entries, "Real `new_job` feedback route: needs chained worktrees/branches. Later plan." and "Reserved interactive session slot for triage (parent spec): not built; triage waits under `maxConcurrentSessions`." `:162`: keep, and note that Give feedback shipped.
- Modify: `README.md` (Status), `tests/README.md` (Give feedback: unit-tested vs hand-verified)

- [ ] **Step 1: Sweep and write the docs**

Run: `git grep -n "Give feedback\|giving feedback\|feedback triage" -- ':!docs/superpowers/plans'`
Expected: every hit either describes the shipped behaviour or is the parent spec's history.

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md backlog.md README.md tests/README.md
git commit -m "docs(superagent): Give feedback"
```

- [ ] **Step 4: Real run (by hand, with the user; costs real model spend)**

1. Restart Cockpit on this branch.
2. Open job `cf6435ce-1902-485a-a903-52eca855f534` in the Superagent tab and confirm it is still ready-to-try with Give feedback shown.
3. Give the feedback: a human-readable, locally hostable site version of the book (GitBook-style; the book already has `README.md`/`SUMMARY.md`) that stays in sync with the markdown.

Expected:
- triage routes `subplan`;
- `feedback/round-1/outputs/plan.md` and `outputs/tasks.json` are written and reviewed;
- only the new tasks run, in place on `superagent/fg-level-design-book-cf6435ce`;
- `python -I fg-level-design-book/tools/check_book.py --tools` still exits 0;
- `feedback/round-1/tests/testReport-1.md` exists and the original `test-report.md` is unchanged;
- the job returns to ready-to-try;
- you try the site, then Accept (with the suggested branch name), and the branch is renamed as today.

Record the outcome in `tests/README.md` with the date.
