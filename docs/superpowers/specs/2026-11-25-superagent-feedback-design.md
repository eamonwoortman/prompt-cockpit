# Superagent: Give feedback on a ready-to-try job (step 6)

Status: design, 2026-11-25. Parent: `2026-11-03-superagent-design.md`, "Feedback and sub-plans" (Decision 8) and "Suggested sequencing" step 6. Replaces the backlog entry "Give feedback on a ready-to-try job" (`backlog.md`, Superagent - planned for later plans). Reviewed by a builder check and by Codex (2026-11-25); their findings are folded in.

## Intent

A job that reaches ready-to-try is often close but not what the user wants yet. Today the only way to ask for more is to accept the job and start a new one, which re-runs the whole pipeline, loses the job's spec, plan and test report, and makes the user accept work they have not signed off on. In-place jobs cannot even do that before accepting: the job holds its folder (`ERR_FOLDER_IN_USE`, `src/superagent/index.js:207`) and the folder sits on a `superagent/*` branch (`ERR_FOLDER_ON_JOB_BRANCH`, `src/superagent/inplace.js:69`).

Give feedback lets the user type what they want changed on the ready-to-try box. The job then carries out the change inside the same job, folder and branch, and comes back to ready-to-try.

**First real use:** job `cf6435ce-1902-485a-a903-52eca855f534` ("FG Level Design Book", Feature workflow, in-place in `C:\workspace\claude\research\level-design-book`, at ready-to-try since seq 166). The book was written for an agent; the user wants a human-readable version as well, a local HTML or GitBook-style site that stays up to date as the markdown changes. The book is already in GitBook layout (`README.md`, `SUMMARY.md` with `##` parts, 65 pages, SVG diagrams), so this is a sub-plan-sized, additive change. Which site tool to use is the job's call (the user may name one in the feedback text); it is not part of this design.

## Goals

- A **Give feedback** action next to Accept on every ready-to-try box, for jobs on any workflow whose shape supports it (Eligibility).
- Pressing it starts work **straight away**: no confirmation step between triage and the work (user's decision).
- A **triage** attempt reads the feedback with the job's artifacts and picks a route:
  - `fix`: one added task, then implement, test, back to ready-to-try.
  - `subplan`: a feedback plan with added tasks, then plan review, implement, test, back to ready-to-try.
  - `separate`: the feedback is really a separate feature; the job returns to ready-to-try showing that verdict and a ready-written idea for a new job.
- Feedback can be given again on every later ready-to-try. Rounds are numbered 1, 2, 3...; no cap in this step.
- A round that gets stuck is recovered with the existing Retry button and API, made round-aware (Retry in a round).
- Edits the user made while trying the job are re-recorded when feedback is given and protected from the round's workers (user's decision).

## Non-goals

- **A real `new_job` route** (the parent spec's third route). Neither folder kind can start a job that builds on this job's unaccepted work: an in-place job holds the folder and branch, and a worktree job's new job branches from the origin, which lacks this job's commits. `separate` replaces it; the real route goes to `backlog.md` until worktrees and branches can be chained.
- A confirmation step showing triage's route before the work starts.
- Rewriting the job's requirement files (Feature's spec, Troubleshooting's diagnosis). They stay as the original run left them; the feedback travels alongside them as amendments (Precedence).
- A cap on rounds, budget enforcement for rounds, or router involvement in triage.
- The parent spec's reserved interactive session slot for triage (`2026-11-03-superagent-design.md`, "Triage uses the reserved interactive slot"): it was never built, so triage waits for a free slot under `maxConcurrentSessions` like any worker. It goes to `backlog.md`.
- Workflows whose task-writing, plan review, per-task and test phases are not back to back (Eligibility).
- Stepping into a worker session (`ERR_WATCH_ONLY` stays).
- Feedback on legacy jobs whose artifacts are committed (`artifactsCommitted: true`, no `artifactRoot`): no Give feedback button for them (author's call).

## Anti-goals

- A round that changes or re-runs work the user already has: earlier tasks, earlier artifacts (`brief`, `spec`, `plan`, `tasks`, reviews, test reports, earlier rounds' files) and their snapshots must be left as they are. A round writes only new files (Round-scoped files).
- A round that silently skips review: a sub-plan's plan must go through the workflow's review phase like the original did.
- A round that skips its own new tasks, or ends in a test that passes on a report a failed tester left behind.
- Old jobs (created before this ships, including the test job) changing state or meaning when the new code first reads their events.
- A worker staging, reverting or overwriting the user's own try-out edits.

## Constraints (from the code today)

- **Test routing is the model.** `test-routed` (`src/superagent/store.js:250-258`, `buildFixTask` at `src/superagent/sequencer.js:221`) already appends a task, sets `phaseIndex` back to the per-task phase and bumps `visits[perTask]`. The `fix` route does the same from the human phase.
- **Tasks load once.** `tasks-loaded` only applies when `job.tasks === null` (`store.js:248`), and `perTaskAction` completes the phase at once when every loaded task is complete (`sequencer.js:456-462`). Re-entering the per-task phase before the round's tasks are recorded would skip them.
- **A result's fields reach the event log only if the runner copies them.** `judge`'s payload (`runner.js:227-234`) and `deriveJob`'s `attempt-ended` fold (`store.js:221-241`) take a fixed field list; anything else in `result.json` is lost on a restart.
- **Attempt scope is per phase, not per visit.** `attemptsFor(job, phase, task)` (`sequencer.js:48`) returns every attempt of the phase. Re-entering a phase as-is would break it:
  - `authorAction` (`sequencer.js:339`) would count the earlier visit's attempts toward `attemptsPerPhase` and launch as a recovery of the earlier visit's done attempt (`retry = last != null`, `:368`).
  - `reviewLoop` (`:168`) would see the earlier visit's `approve` verdict and complete the review phase without reviewing anything.
  - `attemptContext` (`:571`) rebuilds a review scope's state on reconcile from every earlier attempt of the phase, so it would hand a round's verifier no contested ids.
- **Path helpers know nothing of rounds.** `reviewPaths` (`results.js:74-88`) depends only on phase and review round; `reviseOutputs` (`results.js:117`) and the revise card (`prompts.js:142`) resolve the target's producer to its original artifact paths; `artifactWriters`/`keysWritten` (`view-model.js:94-121`) keep one writer per key and the snapshot store one copy per key.
- **`parseTasks`** (`results.js:157`) resolves `dependsOn` only against ids in the same file.
- **The engine keys on phase properties, not names** (CLAUDE.md, Plan 7). Both built-in workflows share the needed shape: one `author` phase whose `outputs` include `tasks` (Feature `plan`, Troubleshooting `investigate`), followed by one `review` phase whose `author` is that phase's role, then the single `per-task` phase, the single `test: true` author phase, and the final `human` phase.
- **Artifact paths** are relative to the job's artifact root and may not use the reserved prefixes `.git/`, `.superpowers/`, `reviews/`, `tasks/` (`workflows.js`). Ledger jobs keep artifacts out of git (`results.js`'s `ledgerArtifactRoot`).
- The router skips human phases (`router.js:91`).
- Answer, retry and accept carry the `needsYouSeq` they were written for and refuse a stale one with 409 `ERR_INVALID_STATE` before appending; `requireSeen` (`index.js:948`) lets an omitted one through, and mutating calls run under the per-job `withJob` queue (`index.js:182`).
- Uncommitted changes are recorded once, at `job-created`, as `pendingChanges`; the in-place gate allows uncommitted changes (`inplace.js:153-167`).

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | Built into the engine, modelled on test routing: new events, a `triage` engine role, phases found by property. | More special cases in the engine; no workflow file changes, works for both built-ins and the test job as-is. |
| B | Declared in the workflow file: a `feedback` block names the triage role and the phase to re-enter. | Most flexible, but changes the format, the validator and both built-ins, and a workflow without the block gets no feedback. |
| C | No triage: feedback always re-enters the task-writing phase; the planner decides one task or many. | Fewest moving parts, but every round pays a plan and plan review even for a typo, departs from Decision 8, and moves the `separate` verdict to the planner. |

The user picked **A**: it is how test routing, the verifier and the router already work.

## Design

### Terms

- **Task-writing phase:** the one `author` phase with `tasks` in its `outputs` (Feature `plan`, Troubleshooting `investigate`).
- **Plan review phase:** the `review` phase directly after the task-writing phase, whose `target` is one of the task-writing phase's outputs and whose `author` is its role (Feature `plan-review`, Troubleshooting `diagnosis-review`). Optional; a round without one goes straight from authoring to tasks.
- **Requirement artifacts:** the test phase's `inputs` other than `tasks` (Feature `spec`, Troubleshooting `diagnosis`). These are what feedback amends (Precedence).

### Eligibility

Give feedback is offered (and `giveFeedback` accepts) only when all of these hold; otherwise the box shows no button and the library refuses with `ERR_FEEDBACK_UNSUPPORTED` (400):

- the job is `needs-you` / `ready-to-try`;
- it is a ledger job (`artifactRoot` set);
- its recorded workflow has exactly one task-writing phase, one `per-task` phase and one `test: true` phase, laid out back to back: the task-writing phase, then the plan review phase if there is one, then the `per-task` phase, then the `test: true` phase, then the final `human` phase. The reducer advances phases in order, so a phase between these would re-run in the round with its original output paths; such a workflow is unsupported rather than half-handled;
- none of the job's recorded artifact paths starts with `feedback/` (compared case-insensitively), so an existing job or custom workflow that already uses that folder is never overwritten;
- the task-writing phase's output keys are unique when compared case-insensitively, so their round files (`outputs/<key><ext>`) never share a path on a case-insensitive filesystem (a workflow may legally declare both `plan` and `Plan`).

Jobs normalised from the legacy table (`store.js`'s `deriveJob`) qualify when they meet the same rules. New workflow files may not declare paths under `feedback/` (`workflows.js` reserved prefixes).

### Flow

1. **Give feedback.** `giveFeedback(jobId, { needsYouSeq, text })` runs under `withJob`. `needsYouSeq` is required at the library boundary, not only at the route (unlike `requireSeen`'s optional form). `text` is 1-4000 characters after trim. Inside the queue it checks state, seq and eligibility, then reads, for every repo, `git status` (the same reader `checkInPlace` uses for `pendingChanges`, `.superpowers/` excluded) and hashes the baseline files, then appends:

   `feedback-given { round, forNeedsYouSeq, text, triageModel, baseline, pendingChanges }`

   - `round` = previous rounds + 1.
   - `forNeedsYouSeq`: the reducer ignores the event unless the job is ready-to-try with that `needsYouSeq` and no `feedback-given` already carries it, so a replay or a stale double submit does nothing.
   - `triageModel`: resolved from the current config (`defaults.models` < `projects[<primary origin>].models` over `defaultConfig().models.triage`, without loading the workflow file, so a job whose workflow file has since gone still qualifies) and recorded, because a job's `models` were fixed at `job-created` and older jobs (the test job included) have no `triage` entry (`store.js:78`).
   - `baseline`: SHA-256 of every existing artifact file the round must not change (every workflow artifact, every review, task and test-report file of the original run and earlier rounds), computed now rather than taken from `attempt-ended.outputs`, since review fixes are not hashed.
   - `pendingChanges`: per repo `{ paths (at most 200), total }`, the same shape as `job-created`'s. The round's worker cards list them as the user's own changes, and `contract.md` tells workers to leave them untouched and unstaged, as it does for the original `pendingChanges` (a prompt-only rule, like the other in-place rules).

   The job becomes `running` with `job.feedbackRound = round`.

2. **Triage.** In the human phase, a round with no routing decision launches a triage attempt: phase = the human phase, `task: null`, role `triage`, purpose `triage`, `feedbackRound = round`, model `triageModel`. Read-only like the stand-in (`tools: ['Read', 'Grep', 'Glob']`, `disallowedTools: ['mcp__*']`), returning its result as its final message. Its card carries the feedback text, the round's `pendingChanges`, every earlier round's feedback and decision, and the paths of the requirement artifacts, plan, tasks, the latest test report and earlier rounds' files. The result carries:
   - `route`: `fix` | `subplan` | `separate`
   - `summary`: one paragraph, shown on the ready-to-try box
   - `brief`: markdown, the body of `triage.md`, for later roles
   - `requirementChanges`: a list (possibly empty) of the requirements the feedback adds, changes or drops, one line each, against the requirement artifacts as amended by earlier rounds
   - for `fix`: `task { title, repos, acceptance, verify }` (`verify` may be empty)
   - for `separate`: `idea` (1-4000 characters, the text a new job would start from)

   **Publication.** When the runner materialises a triage final message whose `status` is `done` and that carries a string `brief` and an array `requirementChanges` into `result.json`, it first writes `feedback/round-<N>/triage.md` from `brief` with `requirementChanges` under `## Requirement changes`. It overwrites deterministically from the same text, so a retry after a crash is harmless. A blocked triage (a question) or a malformed decision writes no `triage.md`. The triage schema itself requires a non-empty `brief` and an array `requirementChanges` on every `done` result, so a `triage.md` left by an earlier rejected result can never back a later decision that lacks them. `triage.md` is the triage attempt's one required output, so it exists before `attempt-ended` and the attempt is its normal writer for accounting (Artifacts and spend). The validated decision (`route`, `summary`, `requirementChanges`, `task`, `idea`) is added to `judge`'s payload and to `deriveJob`'s `attempt-ended` fold as `attempt.triage`, so it survives a restart. A missing or invalid triage result is an `invalid-result` failure with the usual nudge, caps and back-off, in the round's scope.

   **Questions.** A triage that cannot decide may return a question (purpose `triage`, one question). The human phase's action then distinguishes three cases: an unanswered question goes `needs-you` / `question`; an answered one launches a follow-up triage with the answer as `userAnswers`; a done triage with a decision is ready to route. `limits.questionsPerScope` applies to the round's triage scope.

3. **Routed.** For a done triage whose round has no `feedback-routed`, the supervisor appends `feedback-routed { round, attemptId, route, task? }`, deduped by `round`:
   - `fix`: the task is appended to `job.tasks` with an id that cannot collide with plan or test-fix ids (form left to the builder, alongside `FIX_TASK_ID_RE`), `origin: 'feedback'`, `fromAttemptId`, `round`; `phaseIndex` goes to the per-task phase and `visits[perTask]` is bumped once (as `test-routed`).
   - `subplan`: `phaseIndex` goes to the task-writing phase; its visit and the plan review phase's are bumped once.
   - `separate`: the same event sets the job `needs-you` / `ready-to-try` with `needsYouSeq` = the event's own seq and `detail.feedback = { round }`, so the fresh bell entry is created in one durable step (notifications key on `needsYouSeq`, `notifications.js:18`).

4. **Sub-plan authoring.** The task-writing phase runs with purpose `feedback-plan`. Its required outputs are `feedback/round-<N>/outputs/<key><extension of the original path>` for each of the phase's output keys (keys are unique, so two outputs never share a path, and the `outputs/` folder keeps a workflow key such as `triage` away from the engine's own files): Feature `feedback/round-1/outputs/plan.md` and `outputs/tasks.json`, Troubleshooting `outputs/diagnosis.md` and `outputs/tasks.json`. The round's tasks file holds only the new tasks. It is checked by the **round-aware task parser**: `parseTasks` rules, plus ids must not collide with any existing task id (case-insensitive), plus `dependsOn` may name earlier tasks as well as tasks in the same file. The same parser runs at authoring, at every review fix and when the tasks are appended. Every file in the round's `baseline` must be unchanged when any attempt in the round ends; a change is an invalid result with the usual nudge.

5. **Sub-plan review.** The plan review phase runs its normal loop with target = the round's plan file and inputs = the requirement artifacts, the round's tasks and `triage.md`. Same `maxRounds`, verifier and question behaviour as today. The review target, the fix card's revise list (`reviseOutputs`, `prompts.js:142`), revise validation and the writer map all resolve to the round's files, never the originals. Its review, response and verify files go to the round's folder (Round-scoped files).

6. **Tasks appended.** In a sub-plan round, entering the per-task phase is not enough: while the round has no `tasks-appended`, `perTaskAction` returns a load action for the round instead of completing, both after the plan review phase completes and when there is no plan review phase. The supervisor runs the round-aware parser and appends `tasks-appended { round, tasks }` (`origin: 'feedback'`, `round`), deduped by `round`, bumping `visits[perTask]` once. An invalid file is `stuck` / `tasks-invalid` with `detail.round`.

7. **Implement.** Unchanged: `pickTask` runs the open tasks, which are only the new ones. The per-task phase completes with the bumped visit.

8. **Test.** The test phase re-runs with the requirement artifacts, all tasks and every round's `triage.md` on its card. Each tester attempt in the round writes its own report, `feedback/round-<N>/tests/<key>-<n><extension>` (Feature `tests/testReport-1.md`). `n` is the attempt's **report ordinal**: one more than the number of test attempts already started in the round, retried, interrupted and gated ones included, recorded on `attempt-started`. It is not the attempt number `n` used for caps, which restarts after a Retry, so a passing tester can never be satisfied by a file a failed one left. Each report's key is `feedback:<N>:test:<key>:<report ordinal>`, and the alias `feedback:<N>:test:<key>` names the latest done tester's report. A failure routes through `test-routed` as today, in the same order as today: the attempt cap is checked before routing, so the last allowed failure goes stuck without adding a fix task.

9. **Back to ready-to-try**, new `needsYouSeq`. The box shows the round's triage summary and links its latest test report.

### Round scoping

Every `attempt-started` records `feedbackRound` (absent means 0, for attempts before any feedback, so the test job's 52 attempts keep their meaning). For the task-writing phase, the plan review phase, the test phase and the human phase (triage), every scope read is limited to the round: `attemptsFor` in `nextAction`, `attemptContext`'s reconstruction (scoped to the **attempt's** round, not the job's current one), `answeredInScope`, `pendingRetry` and the router's view. Caps, repeated-error, back-off, recovery, review verdicts and question counts therefore start fresh in each round. Per-task scopes stay per task id. The mechanism is the builder's; the rule is that a round never reads another round's attempts as its own.

### Retry in a round

The Retry button and `retryJob` API stay. `job-retried` and the retry records gain `feedbackRound`, and the retried-away marking and `pendingRetry` match on it, so a retry in round 2 never touches round 1. Each stuck reason in a round resumes where the fix can happen:

- An attempt-scoped cause (attempt cap, repeated error, invalid results) resumes that scope, as today.
- `tasks-invalid` from step 6 resumes the task-writing phase as a recovery of its last done `feedback-plan` attempt, with the parser errors and the retry note on its card. Its fix then goes back through the plan review phase. Re-reading the same file would only go stuck again.
- `question-cap` and other causes that are still there go stuck again, as today (CLAUDE.md: "A stuck cause that is still there just goes stuck again").

### Engine role `triage`

`triage` joins `ENGINE_ROLES` (`config.js:17`), so its model comes from config only, like `verifier`, `stand-in` and `router`, and a workflow file cannot set it (`defaultConfig().models.triage`, overridable in `config.json` `defaults.models` / `projects[<path>].models`), resolved at `feedback-given`. Default: the existing `defaultConfig().models.triage`, Claude Sonnet 5.5 with 20 turns (`config.js:77`), as the parent spec's model table decided. Prompt: `prompts/superagent/triage.md`, looked up like any role (`resolvePromptPath`). Every ask is denied like other workers'. Not router-eligible (the router skips human phases).

### Later roles see the feedback

From the round's routing on, every attempt card in the round (planner, plan reviewer, implementer, task reviewer, tester, verifier, and Troubleshooting's investigator, diagnosis reviewer, fixer, fix reviewer and verifier-tester) carries `feedback: [{ round, text, triage: <path>, requirementChanges, pendingChanges }]` for every round so far, oldest first.

**Precedence.** The requirement artifacts are never rewritten. What every role works and judges against is the requirement artifacts amended by each round's `requirementChanges`, applied in round order, so a later round beats an earlier one. A requirement a round dropped or changed is superseded for every later attempt, the tester's whole-job check included. For Troubleshooting, that covers the diagnosis's reproduction: `verifier-tester.md` says to replay it exactly, and a round that changes the reproduction amends that instruction, so that prompt is reworded to replay the reproduction as amended. Likewise `investigator.md` and `planner.md` say `dependsOn` names only listed ids; in a feedback round it may also name existing tasks. The tester must not fail the job on a superseded requirement or route a fix task that undoes one. Anything not listed in `requirementChanges` still stands as written. The prompts for every role above (both workflows) say this plainly.

### Round-scoped files

Nothing a round writes may overwrite a file from the original run or an earlier round. In round N:

- every round output lives under `<artifact root>/feedback/round-<N>/`: `triage.md`, the sub-plan outputs under `outputs/`, `reviews/...` (the names `reviewPaths` gives today, under the round folder) and test reports under `tests/`;
- artifact keys are `feedback:<N>:<kind>:...` with a fixed second segment, so no workflow key can collide with an engine file: `feedback:1:triage`, `feedback:1:out:plan`, `feedback:1:review:plan-review:1` (and `response:`/`verify:`), `feedback:1:test:testReport:2` and its alias `feedback:1:test:testReport`. `artifactWriters`, snapshots and the artifact routes keep the original run's keys and copies untouched;
- the round's planner attempt writes its round keys only, never `plan`/`tasks`;
- task reports and task reviews need no change: new tasks have new ids (`tasks/<id>-report.md`).

The builder threads the round through `reviewPaths`, `requiredOutputs`, `reviseOutputs`, the revise card, the artifact-key helpers and `artifactWriters`. The mechanism is theirs; the rule above is not.

### Server route and view

- `POST /api/superagent/jobs/:id/feedback` body `{ needsYouSeq, text }`. Returns 400 `ERR_INVALID_REQUEST` for bad text or a missing seq, 400 `ERR_FEEDBACK_UNSUPPORTED`, and 409 `ERR_INVALID_STATE` for a stale seq or the wrong state. Watch-only and Origin/Host rules are the same as the other superagent routes.
- `jobDetail` carries `feedbackRounds: [{ round, text, route, summary, requirementChanges, idea?, at }]` and `canGiveFeedback`.
- Ready-to-try box: a **Give feedback** textarea and button beside Accept. The box's links come from the latest round when there is one: its triage summary, its latest test report, and after `separate` the idea with a Copy button. No job is created for the user. Before any round, the box shows the original test report as today (`view-model.js:196`).
- The middle pane labels a re-entered phase's attempts with their round ("feedback 1") and shows the triage attempt in the accept stage group.
- Notifications: unchanged; every ready-to-try, including the one `separate` sets, has a new `needsYouSeq`.

### Artifacts and spend

Round files are engine artifacts with the `feedback:<N>:` keys above. `accounting.js` snapshots them like other artifacts, once their latest writer has an outcome and no live session. `triage.md` qualifies because the runner writes it before the triage attempt ends. Spend for triage and round attempts is read from transcripts like any attempt's.

## Author's calls (check these)

1. `separate` replaces `new_job`; no job is created automatically.
2. Legacy committed-artifact jobs, and jobs whose recorded paths already use `feedback/`, get no Give feedback.
3. Triage keeps the parent spec's Sonnet 5.5 / 20 turns default, becomes an engine role, has read-only tools and is not router-eligible; its model is resolved at `feedback-given` and recorded.
9. A round's test reports are numbered by a durable report ordinal, never by the cap counter.
10. Only back-to-back workflow layouts qualify; triage runs without a reserved slot.
4. Everything a round writes lives under `feedback/round-<N>/` with `feedback:<N>:` keys, and each round tester writes its own numbered report.
5. Every existing artifact file is hash-checked against the round's `baseline` to stay unchanged.
6. Requirement artifacts are never rewritten; each round's `requirementChanges` amend them in round order, later rounds winning, for every role in both workflows.
7. The runner writes `triage.md` from the read-only triage's result before the attempt ends, and the decision is persisted on `attempt-ended`.
8. `tasks-invalid` in a sub-plan round retries the task-writing phase, not the file read.

## Left to the builder

- The fix task id form, and how scopes filter by round.
- Event field names beyond those named here, and how `deriveJob` folds them.
- Prompt wording for `triage.md` and the feedback sections of existing prompts and `contract.md`.
- View layout details within the box and pane.
- Doc sweep: `CLAUDE.md`'s superagent paragraph, `backlog.md` (remove the Give feedback entry, add the real `new_job` route), `README.md` status, `tests/README.md`.

## Testing

- Unit (`npm test`, scripted workers):
  - each route end to end through `deriveJob`/`nextAction` for Feature and Troubleshooting;
  - restart and replay: a restart after triage ends and before `feedback-routed`, and one after plan review completes and before `tasks-appended`, each resumes correctly; replays of `feedback-given`, `feedback-routed` and `tasks-appended` are no-ops;
  - round scoping: a second round's review does not see round 1's approve, caps reset, and a reconciled round verifier gets its contested ids;
  - round-aware parser: collisions (case-insensitive), dependencies on earlier tasks, checks at fix time;
  - baseline refusal; a passing retest cannot reuse a failed tester's report;
  - Retry in a round, including `tasks-invalid` re-entering authoring;
  - stale and missing `needsYouSeq`, a double submit, and accept racing feedback;
  - ineligible workflow, legacy job and `feedback/` path refusal; `pendingChanges` re-recorded on the card;
  - old event logs (no `feedbackRound`) derive identically.
- Manual, real models: job `cf6435ce-1902-485a-a903-52eca855f534` with feedback asking for a human-readable, locally hostable site version of the book that stays in sync with the markdown. Expected:
  1. Triage routes `subplan`.
  2. `feedback/round-1/outputs/plan.md` and `outputs/tasks.json` are written and reviewed.
  3. Only the new tasks run, in place on `superagent/fg-level-design-book-cf6435ce`.
  4. The book's existing pages and `check_book.py` still pass.
  5. `feedback/round-1/tests/testReport-1.md` is written and the original test report is untouched.
  6. The job returns to ready-to-try, and Accept then works as today.

  Cockpit must be restarted on the new code before the run; the job resumes from its events.
