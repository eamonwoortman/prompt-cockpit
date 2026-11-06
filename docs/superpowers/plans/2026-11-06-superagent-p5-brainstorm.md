# Superagent Plan 5 — Automatic Brainstorm and the Answer Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** 2. Folds in the Codex review of revision 1 (7 Important, 1 Minor; `.superpowers/sdd/codex-p5-review.md`). See "Revision 2 changes" at the end.

**Goal:** Make the default pipeline's `brainstorm` phase runnable as an automatic brainstorm, where a brainstormer asks and a read-only stand-in answers or escalates to the user. Add an answer path that lets the user answer any open `needs-you` question, after which the job resumes in the scope that asked.

**Architecture:** Each brainstorm turn is an ordinary runner attempt, fed from the durable record. Brainstormer attempts (purpose `ask`) publish a batch of questions or the brief. Stand-in attempts (purpose `answer`) return their result JSON as their final message, because they have no write tool, and the runner writes `result.json` for them. A new `question-answered` event returns a `needs-you/question` job to `running`. The pure sequencer then relaunches the scope that asked, and the prompt builder puts the scope's answers on every later card. No session is held open while a job waits.

**Tech Stack:** Node 18+ ESM, no framework, no bundler; `@anthropic-ai/claude-agent-sdk` 0.3.318 (unchanged); tests with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-06-superagent-p5-brainstorm-design.md` (Plan 5 design; wins over rev 3 where they differ), on top of `docs/superpowers/specs/2026-11-03-superagent-design.md` (rev 3), sections "Automatic-mode brainstorm", "Workers" (Questions from unattended workers), "Review loops", "Configuration".

## Global Constraints

- Work only on branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`; `feature/auto-pilot` is not modified.
- No new npm dependencies, no `package.json` change; plain ESM; no build step. Never commit `package-lock.json` (deliberately modified and uncommitted); stage files by name, never `git add -A`; `HANDOVER.md` stays out of commits.
- Baseline is `npm test` = 1008 passing; it stays green after every task. Tests are no-network, no real CLI, no real model (scripted workers via `tests/superagent-helpers.mjs`).
- NO `Co-Authored-By` trailer on any commit. Conventional prefix only; commit with `git commit -F- <<'EOF' ... EOF`. Files are LF.
- Edits are confined to `src/superagent/`, `prompts/superagent/`, `tests/` and Task 8's docs. `src/server.js`, `src/session.js` and `src/session-registry.js` are NOT touched (`session.js` already passes `tools`/`disallowedTools` through, `SDK_PASSTHROUGH_KEYS` at `src/session.js:175`).
- No real-model probe in this plan (the user punted every probe until all plans are done). The stand-in's tool restriction and its final-message result are therefore **unverified against the real SDK**. Task 8's docs say so.
- Stand-in tool set, verbatim: `tools: ['Read', 'Grep', 'Glob']`, `disallowedTools: ['mcp__*']`.
- Limits: `limits.brainstormExchanges` default 20 (existing), `limits.brainstormTokens` default `null` = none (existing), new `limits.questionsPerScope` default 3. Brainstorm batch: at most 5 questions per brainstormer turn. Answer text: 1-4000 characters after trim.
- Brief and spec headings, verbatim: `## Assumptions made for you` and `## Your answers`.
- Answer tags, verbatim: `from-idea`, `from-project`, `assumed` (stand-in); `from-you` (the user, derived, never written by a worker).
- No question from a superagent session reaches the user except through `needs-you`. The brainstormer's `AskUserQuestion` fall-through (`runner.js:467`) is removed.
- Never push, PR or merge.

## Review Focus

1. **Answer to the wrong thing:** answering a job that is running, stuck, ready-to-try, stopped, or waiting on a **budget** question (`detail.kind === 'budget'`), answering twice, or sending an empty or over-4000-character answer is refused with a typed error, and nothing is appended. (Task 8 test `answerQuestion refuses wrong states, budget questions, repeats and bad text`.)
2. **Restart between the answer and the next launch:** after `question-answered` lands, a fresh supervisor over the same store launches the asking scope with the answer on the card. It does not re-emit `needs-you`. (Task 2 test `question-answered returns the job to running and survives replay`; Task 8 test `restart after an answer launches the asking scope`.)
3. **A stand-in that doesn't reply with clean JSON** (prose before or after it, a fenced block, nothing at all, invalid JSON) never crashes the runner. Fenced or braced JSON is extracted; otherwise the normal nudge, then the `invalid-result`/`no-result` path. (Task 6 tests `read-only result: fenced, braced, prose-wrapped and unparseable final messages`.)
4. **A stand-in batch that doesn't match the questions** (skips one, invents an id, answers twice, escalates an id that isn't open, uses `from-you`) is `invalid-result`, never a silently partial log. (Task 3 test `answer results must cover exactly the open questions`.)
5. **Exchange cap reached:** the next brainstormer turn is `final` and must write the brief. A brainstormer that still asks on a final turn is `invalid-result` and is retried under the failed-attempt cap, never looped forever. (Task 3 test `a final ask may not ask questions`; Task 5 test `exchange cap forces a final ask; failed finals end in attempt-cap`.)

---

## Decisions the design leaves to the builder

1. **Relay = one attempt per turn, from the record.** The runner keeps one live attempt per job (`runner.js` `lives` keyed by jobId) and finishes an attempt by reading `result.json`, so each brainstorm turn is a normal attempt: brainstormer `ask` → stand-in `answer` → brainstormer `ask` … No parked sessions, so the design's "nothing stays running" rule holds even mid-brainstorm. To keep fresh sessions few, the brainstormer asks up to 5 questions per turn and the stand-in answers the whole batch.
2. **Phase kind `brainstorm`.** The default pipeline's brainstorm phase changes from `kind: 'author'` to `kind: 'brainstorm'` (`config.js:53`). The v1 composition rule is derived from `defaultConfig()`, so it follows automatically. The stand-in role is fixed, `'stand-in'` (exported `STAND_IN_ROLE`), like the fixed `'verifier'`. It is not a per-phase field.
3. **Stand-in result via final message.** With Read/Grep/Glob only it can't write files. Its template and the contract's `resultVia: "final-message"` branch tell it to reply with only the result JSON. The runner extracts the JSON from the last `result` message's `result` text: a fenced ```` ```json ```` block if present, else the first `{` to the last `}`. It overlays the identity fields from the live record (`jobId`, `phaseId`, `taskId`, `attemptId`) and writes `result.json` atomically.
   - **When:** the write happens **in `review()` as soon as `scan` sees that result message**, not only at turn end. Removal, stall, stop and reconcile run later and all read the on-disk file, so they see the result without needing their own extraction.
   - **Crash boundary (accepted, documented):** if the row is removed, or cockpit dies, between the result message arriving and the next heartbeat's scan (at most one tick, 15 s), the text is lost. The attempt then ends `no-result` (or `interrupted` after a restart) and the stand-in turn is retried. Registry rows and their logs are ephemeral, so nothing else could recover it.
   - **Failures:** a missing or unparseable text writes nothing, so the normal nudge and failure path applies. A write that throws is caught and logged, the attempt carries on as if nothing had been written, and the next scan retries the write. Nothing is left claimed.
4. **Escalation shape.** A stand-in that escalates publishes `status: 'blocked'` with `question` (for the user), `escalated` (the brainstorm question id) and `answers` for every other open question. `outcomeForResult` already maps blocked + question to outcome `question`.
5. **Events.** One new event: `question-answered { forAttemptId, answer }`. Brainstorm questions, answers and escalations ride on `attempt-ended` as `questions`, `answers`, `escalated`. Per-attempt token usage rides on `attempt-ended` as `tokens`. `deriveJob` keeps them on the attempt and keeps `job.answers`. The exported pure `brainstormLog(job)` is the one read that lists every exchange with its tag and reason (the design's inspectability requirement).
6. **Token cap measurement.** At finish, the runner snapshots the registry row's `usageAcc.totals` (`inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`) as `tokens`. An attempt finished without a live row (reconcile) records `tokens: null`, which counts as 0. This is stated as an under-count, acceptable because the cap defaults to `null`.
7. **Answers on the card.** The prompt builder puts `userAnswers: [{ question, answer }]` on every card in a scope (same phase and task) once that scope has answers, rather than threading answers through launch actions. The brainstorm uses `exchanges` instead, the full `brainstormLog`.
8. **Question cap.** The count of answered questions in a scope is the number of `job.answers` whose `forAttemptId` is an attempt in that scope. When a scope would raise a new `needs-you/question` and that count is already `>= limits.questionsPerScope` (default 3 for older jobs without the key), the action is `needs-you/stuck` with `why: 'question-cap'` instead.
9. **Answered questions don't consume.** An attempt with outcome `question` that has an answer is excluded from the author-phase attempt-cap count. Review scopes already count only failed attempts.
10. **Extra review round after an answered confirmed blocker.** Let `E = maxRounds + n`, where `n` counts that scope's answered verifier questions (1-based). The round runs: fix `E` (`final: true`, `reviewFindings` = the confirmed blockers) → reviewer round `E`.
    - If the reviewer approves, the scope completes.
    - Otherwise its blockers go to a verifier with `round: E` and `contested` = those blocker ids. Confirmed → a new question, subject to the question cap. None confirmed → complete with `disputed-not-verified`.
    - **Carried findings:** the non-blocker findings left unresolved by the cap outcome that raised the question carry through every later extra round. Completion returns them plus that round's own unresolved findings, deduplicated by id with the later entry winning. An approval in an extra round returns the carried list, not `[]`.
    - **Rounds:** the base loop looks only at reviews and fixes with `round <= maxRounds` and the base verifier with `round == null`. Verifier launches carry `round: E` in extra rounds (`null` in the base round, as today).
    - **Paths:** `review`, `response` and `taskReview` already use the round. `verify` and `taskVerify` don't (`results.js:67,70`), so `reviewPaths` gives them a `-r<round>` suffix when `round` is an integer: `<phase>-verify-r<E>.md`, `<task>-verify-r<E>.md`. Base verifiers (`round: null`) keep today's paths, and existing tests stay valid. The task `report` stays one cumulative file per task, as every task fix already treats it.
    - **Extra fix card:** `previousFindings` is `null`, because no review exists at round `E` yet (`prompts.js:70` would point at a missing file). `reviewFindings` and `userAnswers` carry what the fix needs.
11. **Brief and spec headings check.** It is a regex over the file in the primary worktree, run after `outputErrors` passes: `^##\s+Assumptions made for you\s*$` and `^##\s+Your answers\s*$`, multiline. It runs for a final ask's brief and for an `author` attempt whose phase outputs include `spec` when the job's pipeline has a `brainstorm` phase. Fix rounds aren't checked.
12. **`milestone-1`/`milestone-2` stay as they are.** Brainstorm tests use the default pipeline (`createJob` with `fixture: null`).
13. **Answers carried past their scope.** `userAnswers` stays scoped to the asking phase or task. Later phases learn the brainstorm's outcome only from the spec's `## Your answers` and `## Assumptions made for you`. The contract (Task 7) tells every worker that the former are the user's decisions and the latter are reviewable defaults, whether or not its card has `userAnswers`.
14. **Record references.** Every `brainstormLog` entry carries `askedBy`/`answeredBy` attempt ids and `askedSession`/`answeredSession` (the attempts' `sessionId`, null if unknown). The stand-in escalation's needs-you detail carries `record: { jobId, questionId, askedBy, attemptId }`. These resolve through `events.jsonl`/`state.json` under the job's store dir. The brief prefixes every listed assumption and answer with its question id (`Q<n>`), so it resolves through `brainstormLog`.
15. **Templates before their roles run in tests.** Task 1 makes the default pipeline need `stand-in.md`, but that file only arrives in Task 7. Until then, tests that create default-pipeline jobs or launch a stand-in write `brainstormer.md`/`stand-in.md` into the project override dir (`<projectDir>/.superpowers/superagent/prompts/`, `prompts.js:18-20`), the existing pattern at `tests/superagent-runner.test.mjs:402` and `tests/superagent.test.mjs:627`.

## File Structure

- `src/superagent/config.js` — `PHASE_KINDS` + `'brainstorm'`, `STAND_IN_ROLE`, default brainstorm phase kind, `limits.questionsPerScope`, brainstorm validation.
- `src/superagent/store.js` — `question-answered`, `job.answers`, attempt fields `questions`/`answers`/`escalated`/`tokens`, brainstorm phase advance.
- `src/superagent/results.js` — `ask`/`answer` purposes, headings check, `outcomeForResult` keys.
- `src/superagent/sequencer.js` — answer path in author and review scopes, question cap, extra review round, `brainstormAction`, `brainstormLog`, `answerFor`, `attemptContext` for the new purposes.
- `src/superagent/runner.js` — read-only roles, final-message result, `tokens`, deny every ask, new payload and context fields.
- `src/superagent/prompts.js` — `READ_ONLY_ROLES`, card fields `exchanges`, `openQuestions`, `maxQuestions`, `userAnswers`, `resultVia`; role-specific deny message.
- `src/superagent/index.js` — `pipelineRoles` + stand-in, `answerQuestion`.
- `prompts/superagent/brainstormer.md`, `prompts/superagent/stand-in.md` (new); `contract.md`, `spec-writer.md`, `spec-reviewer.md`, `plan-reviewer.md`, `task-reviewer.md`, `verifier.md`, `planner.md`, `implementer.md`, `tester.md` (one `userAnswers` line each where relevant).
- Tests: `tests/superagent-{config,store,results,sequencer,runner,prompts,pipeline}.test.mjs`, `tests/superagent.test.mjs`, `tests/superagent-helpers.mjs`.

---

### Task 1: Config: brainstorm kind, stand-in role, question limit

**Files:**
- Modify: `src/superagent/config.js:14,53,76-95,150-200`
- Modify: `src/superagent/sequencer.js:24` (`RUNNABLE_KINDS`)
- Modify: `src/superagent/index.js:64-73` (`pipelineRoles`)
- Test: `tests/superagent-config.test.mjs`, `tests/superagent-pipeline.test.mjs` (one `pipelineRoles` test), `tests/superagent.test.mjs` (migrate `:594-630` and `:206`)

**Interfaces:**
- Produces: `PHASE_KINDS` includes `'brainstorm'`; `export const STAND_IN_ROLE = 'stand-in'`; `defaultConfig().limits.questionsPerScope === 3`; `RUNNABLE_KINDS.has('brainstorm')`; `export function pipelineRoles(pipeline)` (index.js, now exported) includes `'stand-in'` when any phase has kind `brainstorm`.

- [ ] **Step 1: Write the failing tests** in `tests/superagent-config.test.mjs`:
  - `default brainstorm phase has kind brainstorm`: `defaultConfig().pipeline[0]` deep-equals `{ phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] }`; `validateDefaults(defaultConfig()).errors` is `[]`.
  - `questionsPerScope defaults to 3 and must be a positive integer`: default 3; `limits.questionsPerScope: 0` gives an error at path `limits.questionsPerScope`.
  - `a brainstorm phase needs a stand-in model`: delete `models['stand-in']` → error `{ path: "models['stand-in']", message: 'a stand-in model is required when the pipeline has a brainstorm phase' }`.
  - `a brainstorm phase must be first and unique`: brainstorm moved to index 1, or two brainstorm phases → error at `pipeline` with message `a brainstorm phase must be the first phase, and there can be only one`.
  - Update the existing assertion that expects brainstorm `kind: 'author'`, if any.
- [ ] **Step 2: Run** `node --test tests/superagent-config.test.mjs` → the new tests FAIL.
- [ ] **Step 3: Implement** in `config.js`: add the kind, the constant, the default, and the two checks in `checkPipeline` (next to the verifier check, `config.js:199`). `requireRole` already applies to every non-human kind. In `sequencer.js` add `'brainstorm'` to `RUNNABLE_KINDS`. In `index.js` `pipelineRoles`, push `STAND_IN_ROLE` when a phase has kind `brainstorm`.
- [ ] **Step 4: Export `pipelineRoles` from `index.js` and add the failing test** `pipelineRoles adds the stand-in for a brainstorm phase` in `tests/superagent-pipeline.test.mjs`: `pipelineRoles(defaultConfig().pipeline)` includes `'brainstormer'` and `'stand-in'`; `pipelineRoles(MILESTONE_2_PIPELINE)` does not include `'stand-in'`.
- [ ] **Step 5: Migrate `tests/superagent.test.mjs`.** The missing-template test at `:594` now expects `err.roles` deep-equal `['brainstormer', 'stand-in']` for the default pipeline, and `['brainstormer', 'stand-in', 'ghost-writer', 'ghost-reviewer']` at `:613`. The override test at `:622-630` also writes `stand-in.md`. `:206` (`ERR_NO_TEMPLATE` for the default pipeline) stays true until Task 7.
- [ ] **Step 6: Run** `node --test tests/superagent-config.test.mjs tests/superagent-pipeline.test.mjs tests/superagent.test.mjs` → PASS; then `npm test` → all pass.
- [ ] **Step 7: Commit** `feat: superagent brainstorm phase kind, stand-in role and question limit`.

### Task 2: Store: answers, brainstorm fields, phase advance

**Files:**
- Modify: `src/superagent/store.js:23,32-187`
- Test: `tests/superagent-store.test.mjs`

**Interfaces:**
- Consumes: Task 1 kind `brainstorm`.
- Produces: event `{ type: 'question-answered', forAttemptId: string, answer: string }`; `job.answers: Array<{ forAttemptId, answer, at }>`; each attempt gains `questions` (array|null), `answers` (array|null), `escalated` (string|null), `tokens` (number|null) from `attempt-ended`.

- [ ] **Step 1: Write the failing tests:**
  - `question-answered returns the job to running and survives replay`: events through `needs-you { reason: 'question', detail: { attemptId: 'a1', question: 'Q?' } }` then `question-answered { forAttemptId: 'a1', answer: 'yes' }` → `state === 'running'`, `reason === null`, `answers` deep-equals `[{ forAttemptId: 'a1', answer: 'yes', at: <stamped> }]`. A fresh store over the same dir derives the same.
  - `question-answered is ignored unless it answers the open question`: wrong `forAttemptId`, state `running`, or reason `stuck` → state unchanged, `answers` empty. A second `question-answered` for `a1` after the first → `answers.length === 1`.
  - `attempt-ended carries brainstorm fields and tokens`: `attempt-ended { questions: [{id:'Q1',text:'t'}], answers: null, escalated: null, tokens: 1234 }` → kept on the attempt; an old event without them → all `null`.
  - `a brainstorm phase advances only on an ask with no questions`: pipeline from `defaultConfig()`. A done `ask` attempt with `questions: [{...}]` → `phaseIndex` stays 0; a done `answer` attempt → stays 0; a done `ask` with `questions: []` → `phaseIndex === 1`, `phaseId === 'spec'`.
- [ ] **Step 2: Run** `node --test tests/superagent-store.test.mjs` → FAIL.
- [ ] **Step 3: Implement** in `deriveJob`: add the event type and the four attempt fields (default `null` on `attempt-started`). Add `answers: []` to the job. For `question-answered`, apply only when `job.state === 'needs-you' && job.reason === 'question' && job.detail?.attemptId === ev.forAttemptId` and no answer for it exists yet, then `setState('running')`. Phase advance: `ev.outcome === 'done' && current?.kind === 'brainstorm' && a.phase === current.phase && a.purpose === 'ask' && (ev.questions ?? []).length === 0` → `phaseIndex++`.
- [ ] **Step 4: Run** the file → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent store records answers and brainstorm exchanges`.

### Task 3: Results: `ask` and `answer` purposes, headings check

**Files:**
- Modify: `src/superagent/results.js:86-100,340-420,563-593`
- Test: `tests/superagent-results.test.mjs`

**Interfaces:**
- Consumes: attempt context fields `final` (boolean), `askedIds` (string[]: ids asked before this attempt), `openQuestions` (Array<{id,text}>), from Task 5's `attemptContext`.
- Produces: `export const BRAINSTORM_BATCH = 5`; `export const ANSWER_TAGS = ['from-idea', 'from-project', 'assumed']`; `export const BRIEF_HEADINGS = ['Assumptions made for you', 'Your answers']`; `export function headingErrors(text: string, label: string): string[]`; `requiredOutputs` treats `ask` like `author` and returns `[]` for `answer`; `outcomeForResult` copies `questions`, `answers`, `escalated` when present.

- [ ] **Step 1: Write the failing tests:**
  - `ask with questions needs no outputs`: `{ status: 'done', questions: [{ id: 'Q1', text: 'Who uses it?' }], artifacts: [], evidence: { commits: [] } }` with attempt `{ purpose: 'ask', final: false, askedIds: [] }` → ok, and `outcomeForResult` returns `{ outcome: 'done', questions: [...] }`.
  - `ask questions are validated`: 6 questions → error containing `at most 5`; id `'X1'` → error containing `id`; duplicate id in the batch → error; id in `askedIds` → error containing `already asked`; empty text → error.
  - `a final ask may not ask questions`: `final: true`, one question → error `a final brainstorm turn must write the brief, not ask questions`.
  - `ask with no questions needs the brief with both headings`: commits the brief without `## Your answers` → error `brief is missing the heading "## Your answers"`; with both headings → ok.
  - `a blocked ask is refused`: `{ status: 'blocked', question: 'q' }` on `ask` → error `the brainstormer asks through questions, not a blocked result`.
  - `answer results must cover exactly the open questions`: open `[Q1, Q2]`. A done result with answers for Q1 only → error. An answer for `Q3` → error. Q1 twice → error. Tag `from-you` → error. Missing reason → error. Both answered with valid tags → ok, `outcome: 'done'`, `answers` copied.
  - `a stand-in escalation`: blocked, `question: 'Which database?'`, `escalated: 'Q2'`, answers for Q1 → ok, `outcome: 'question'`, `escalated: 'Q2'`. `escalated: 'Q9'` → error. Blocked without `question` → error. Blocked whose answers include the escalated id → error.
  - `spec carries the brief headings when the job brainstorms`: a `spec` author attempt in a job whose pipeline has a `brainstorm` phase, with a spec lacking `## Assumptions made for you` → error `spec is missing the heading "## Assumptions made for you"`. The same spec in a `milestone-2` job → ok.
- [ ] **Step 2: Run** `node --test tests/superagent-results.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `askErrors(value, attempt)` and `answerErrors(value, attempt)`, called from `purposeErrors` **before** its early `blocked` return. In `validateResult`, skip `outputErrors` for a done `ask` with a non-empty `questions`. After `outputErrors` passes, run `headingErrors` on the brief (done `ask`, no questions) or the spec (`author` whose phase outputs include `spec`, pipeline has a `brainstorm` phase), reading the file from `primaryRepo(job).worktree` with `fs.readFile`. A read error is an error string, never a throw. `headingErrors(text, label)` returns one message per missing heading in the form `${label} is missing the heading "## ${h}"`.
- [ ] **Step 4: Run** the file → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent validates brainstorm questions, stand-in answers and brief headings`.

### Task 4: Sequencer: the answer path and the question cap

**Files:**
- Modify: `src/superagent/sequencer.js:63-121,278-366,417-445`
- Modify: `src/superagent/results.js:59-72` (`reviewPaths` verify suffix)
- Test: `tests/superagent-sequencer.test.mjs`, `tests/superagent-results.test.mjs`

**Interfaces:**
- Consumes: Task 2's `job.answers`, `limits.questionsPerScope`.
- Produces: `export function answerFor(job, attemptId): string | null`; `export function answeredInScope(job, phaseId, taskId = null): number`; `reviewLoop(attempts, { initial, maxRounds, failedCap, answers })` where `answers: Map<attemptId, string>` (absent = empty); the capOutcome `question` result gains `blockers: Array<{id,severity,text}>`; stuck `why: 'question-cap'`.

- [ ] **Step 1: Write the failing tests** (pure, on derived jobs built with `tests/superagent-helpers.mjs` `ev`):
  - `an answered author question relaunches the phase`: spec attempt `a1` outcome `question`, `answers: [{ forAttemptId: 'a1', answer: 'A' }]`, state running → `launch` with `phase: 'spec'`, `recovery: true`, `previousAttemptId: 'a1'`. Without the answer → `needs-you` `question` (unchanged).
  - `an answered question does not consume the attempt cap`: `attemptsPerPhase: 2`, attempts `failed`, `question` (answered) → `launch`, not `stuck`.
  - `question cap turns the next question into stuck`: `questionsPerScope: 2`, two answered questions in `spec` and a third unanswered → `needs-you` `stuck` with `detail.why === 'question-cap'`. With `questionsPerScope` missing from `job.limits`, the default is 3.
  - `answered questions in other scopes do not count`: two answered in `plan`, one unanswered in `spec` with cap 2 → `needs-you` `question`.
  - `an answered reviewer question relaunches the same purpose and round`: spec-review round 2 reviewer attempt `question`, answered → `launch` `purpose: 'review'`, `round: 2`.
  - `an answered confirmed blocker gets one extra round`: maxRounds 1, review r1 blocker B1, final fix r1 declines B1, verify confirms B1 (attempt `v1`), answered. Then the sequence is: `launch fix round 2 final true reviewFindings [B1]` → after done, `launch review round 2` → if approve, `complete-phase` with `unresolved: []`. If round-2 review raises blocker B2, `launch verify round 2 contested ['B2']`. If v2 confirms → `needs-you question` with `detail.attemptId === v2's id`. If v2 disputes → `complete-phase` with B2 `status: 'disputed-not-verified'`.
  - `carried minors survive the extra round`: as above, but review r1 also had minor M1 that fix r1 left `open`. Extra-round approval → `complete-phase` with `unresolved` deep-equal `[{ id: 'M1', severity: 'minor', text, status: 'open' }]`. If round 2 instead ends disputed with B2, `unresolved` has both M1 and B2.
  - `the extra round in a task loop`: the same in a per-task scope, `purpose: 'task-review'`, `detail.task === 'T1'`.
  - `attemptContext rebuilds the extra-round fix`: for an in-flight fix at round 2 (no round-2 review yet), `attemptContext(job, fix).reviewFindings` deep-equals `[B1]`.
  - `extra-round verifier paths carry the round` (in `tests/superagent-results.test.mjs`): `reviewPaths(job, { phase: 'spec-review', round: 2 }).verify` ends with `spec-review-verify-r2.md`, and `taskVerify` for `T1` round 2 ends with `T1-verify-r2.md`. With `round: null` both keep today's paths (the existing assertions near `:287` still pass).
- [ ] **Step 2: Run** `node --test tests/superagent-sequencer.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** `answerFor` reads `job.answers`. `answeredInScope` counts answers whose `forAttemptId` is an attempt with that phase and task. In `authorAction` and `scopeAction`/`reviewLoop`: a last `question` attempt with an answer is not open. In `authorAction`, `used` excludes answered `question` attempts. Every place that returns `needs-you`/`question` (`authorAction`, `scopeAction`) first checks `answeredInScope(...) >= (job.limits.questionsPerScope ?? 3)` and returns `stuckAction(..., 'question-cap', last)` instead. Pass `answers` (a Map from `job.answers`) through `reviewLoopOptions`/`taskLoopOptions`. In `loopState`, the base rounds use only reviews and fixes with `round <= maxRounds` and the base verifier with `round == null`. Then follow Decision 10, looping while the outcome is an answered `question`:

```js
let outcome = capOutcome(findings, fix, baseVerify);
for (let n = 1; outcome.type === 'question' && answers.has(outcome.attemptId); n++) {
  const E = maxRounds + n;
  const fixE = done.find((a) => a.purpose === 'fix' && a.round === E);
  if (!fixE) return loopLaunch('fix', E, 'author', { final: true, reviewFindings: outcome.blockers });
  const reviewE = done.find((a) => REVIEW_PURPOSES.has(a.purpose) && a.round === E);
  if (!reviewE) return loopLaunch(reviewer, E, 'reviewer');
  if (reviewE.verdict === 'approve') return { type: 'complete', unresolved: [], verification: [] };
  outcome = capOutcome(reviewE.findings ?? [], { findings: [] }, done.find((a) => a.purpose === 'verify' && a.round === E), E);
}
return outcome;
```

  `capOutcome` gains a `round` argument (default `null`) for its verify launch. On `question` it returns `blockers` and `carried` (the non-blocker entries of its `unresolved`). The loop above threads `carried` into every later completion, per Decision 10. In `attemptContext`, a `fix` with no review at its round takes `reviewFindings` from the `loopState` launch (as `contested` already does). In `results.js` `reviewPaths`, `verify`/`taskVerify` get the `-r<round>` suffix when `round` is an integer (Decision 10).
- [ ] **Step 4: Run** the file → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent answered questions resume their scope, with a per-scope question cap`.

### Task 5: Sequencer: the brainstorm action and log

**Files:**
- Modify: `src/superagent/sequencer.js` (new `brainstormAction`, `brainstormLog`; `nextAction`; `attemptContext`; `launch` gains `openQuestions`, `askedIds`)
- Test: `tests/superagent-sequencer.test.mjs`

**Interfaces:**
- Consumes: Task 1 `STAND_IN_ROLE`; Task 2 attempt fields; Task 3 `ANSWER_TAGS`; Task 4 `answerFor`, `answeredInScope`.
- Produces: `export function brainstormLog(job): Array<{ id, text, askedBy, askedSession, answer, tag, reason, answeredBy, answeredSession, at }>`. `tag` is one of `ANSWER_TAGS`, `'from-you'`, or `null` while open. `at` is the answering attempt's `endedAt` or the user answer's `at`. `askedSession`/`answeredSession` are the attempts' `sessionId` (null if unknown, and null for `from-you`'s `answeredSession`).
  - Launch actions for the brainstorm carry `purpose: 'ask' | 'answer'`, `final`, `openQuestions: Array<{id,text}> | null`, `askedIds: string[] | null`. `attemptContext` returns the same three fields for `ask`/`answer` attempts.
  - The stand-in escalation needs-you detail is `{ kind: 'stand-in', attemptId, question, brainstormQuestion: { id, text }, reason, record: { jobId, questionId, askedBy, attemptId }, phase: 'brainstorm', task: null }`, where `reason` is the stand-in attempt's `summary`.

- [ ] **Step 1: Write the failing tests:**
  - `brainstorm starts with an ask`: fresh default-pipeline job → `launch` `role: 'brainstormer'`, `purpose: 'ask'`, `final: false`, `askedIds: []`.
  - `open questions go to the stand-in`: done ask with Q1, Q2 → `launch` `role: 'stand-in'`, `purpose: 'answer'`, `openQuestions: [Q1, Q2]`.
  - `answered batch goes back to the brainstormer`: then a done answer for both → `launch ask` with `askedIds: ['Q1','Q2']`.
  - `brainstormLog lists every exchange with tag, reason and record references`: after the above, the log has two entries with the stand-in's tags and reasons. Each entry's `askedBy`/`answeredBy` names an attempt in `job.attempts`, and `askedSession`/`answeredSession` equal those attempts' `sessionId`.
  - The escalation test below also asserts that `detail.record` deep-equals `{ jobId, questionId: 'Q2', askedBy: <the ask attempt id>, attemptId: 's1' }`.
  - `stand-in escalation waits on the user`: answer attempt `s1` blocked, escalating Q2, answering Q1 → `needs-you` `question` with the detail above. After `question-answered { forAttemptId: 's1', answer: 'Postgres' }`, the log's Q2 has `tag: 'from-you'`, `answer: 'Postgres'`, and the next action is `launch ask`.
  - `exchange cap forces a final ask; failed finals end in attempt-cap`: `brainstormExchanges: 2`, two stand-in-answered exchanges → `launch ask final: true`. `from-you` answers don't count towards the cap. With `attemptsPerPhase: 2`, two failed final asks → `stuck` `attempt-cap`.
  - `token cap forces a final ask`: `brainstormTokens: 1000`, brainstorm attempts with `tokens` summing to 1000 → `final: true`. `tokens: null` counts 0.
  - `question cap applies to stand-in escalations`: `questionsPerScope: 1`, one answered escalation, a second unanswered → `stuck` `question-cap`.
  - `a failed stand-in attempt retries the stand-in`: answer attempt failed `no-result` → (after back-off) `launch answer` with `recovery: true` and the same `openQuestions`.
  - `attemptContext rebuilds ask and answer context`: for an in-flight `answer` attempt, `openQuestions` matches the launch; for an in-flight `ask`, `askedIds` and `final` match.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `nextAction`, `phase.kind === 'brainstorm'` → `brainstormAction(job, phase, ctx)`. Guard order mirrors `scopeAction`: in-flight → `none`; open escalation (last attempt `question`, unanswered) → question-cap check, then `needs-you`; failed-attempt cap (failed outcomes only, against `attemptsPerPhase`) → `stuck`; `retryGuard`; then decide the side. If the latest done `ask` has questions not yet answered in the log → stand-in. Otherwise → brainstormer, `final` when stand-in-tagged exchanges `>= limits.brainstormExchanges` or (`brainstormTokens != null` and the summed `tokens` of brainstorm attempts `>= brainstormTokens`). Then `routeOrApply` for a recovery launch, the concurrency check, and `launch`. `brainstormLog` walks brainstorm attempts in order: questions from done `ask` attempts, answers from `answer` attempts (`done` or `question`), and the escalated id's answer from `answerFor(job, attempt.attemptId)` with `tag: 'from-you'`, `reason: null`.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent sequencer drives the automatic brainstorm`.

### Task 6: Runner: read-only stand-in, tokens, every ask denied

**Files:**
- Modify: `src/superagent/runner.js:1-37,130-170,250-300,330-410,455-470`
- Modify: `src/superagent/prompts.js:6-12,159-164` (`READ_ONLY_ROLES`, `READ_ONLY_TOOLS`, `denyMessageFor`, `nudgeText`)
- Modify: `tests/superagent-helpers.mjs` (`scriptedWorker`: read-only cards publish via final message)
- Test: `tests/superagent-runner.test.mjs`

**Interfaces:**
- Consumes: Task 3 result fields; Task 5 launch fields `openQuestions`, `askedIds`.
- Produces: `export const READ_ONLY_ROLES = new Set(['stand-in'])`, `export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']` (prompts.js); `export function denyMessageFor(role): string`; `nudgeText(kind, { dir, readOnly })`; `export function extractResultJson(text): object | null` (runner.js); `createRunner({ ..., writeJsonImpl })`; `attempt-ended` carries `questions`, `answers`, `escalated`, `tokens`.
- Tests that launch a stand-in or brainstormer write `stand-in.md`/`brainstormer.md` into the project override dir (Decision 15). The real templates arrive in Task 7.

- [ ] **Step 1: Write the failing tests:**
  - `stand-in sessions are read-only`: launching `role: 'stand-in'` → the `createSession` call's `sdkOptions.tools` deep-equals `['Read','Grep','Glob']` and `sdkOptions.disallowedTools` deep-equals `['mcp__*']`. A `brainstormer` launch has neither key.
  - `read-only result: fenced, braced, prose-wrapped and unparseable final messages`: `extractResultJson` returns the object for ```` ```json\n{...}\n``` ````, for `Here it is: {...} done`, and for bare `{...}`. It returns `null` for `no json here`, for `{ broken`, and for a JSON array.
  - `a stand-in final message becomes result.json`: a fake stand-in whose turn ends with `{ type: 'result', subtype: 'success', result: '<valid answer JSON without identity fields>' }` → `result.json` exists in the attempt dir with identity fields from the live record, and `attempt-ended` has `outcome: 'done'` and the `answers`.
  - `the result is materialised on the first scan, so removal still judges it`: the result message is emitted while the row is still `running` (not idle), and `runner.review(job)` runs once → `result.json` exists. Then the row is removed (`registry.closeSession`) → `attempt-ended` is `done` with the answers, not `no-result`.
  - `removal before any scan loses the reply (documented boundary)`: the result message is emitted and the row removed with no `review` in between → `outcome: 'failed'`, reason `no-result`.
  - `reconcile after a restart uses the materialised result`: materialise via one `review`, drop the runner (new `createRunner` over the same store, no live record) → `reconcile(job)` appends `done` with the answers.
  - `a failing result write is retried and never strands the attempt`: inject `writeJsonImpl` that throws once, then succeeds → the first `review` logs and leaves no `result.json` and no claim (`live.finishing` stays null). The next `review` writes the file, and the attempt ends `done` exactly once, with its row closed. If it throws every time, the attempt ends through the normal nudge and `no-result` path exactly once.
  - `an unparseable stand-in reply is nudged, then fails`: final text `sorry` → one `attempt-nudged`; nudge text contains `final message`; the second miss → `outcome: 'failed'`, reason `no-result`.
  - `every ask is denied, including the brainstormer's AskUserQuestion`: replaces the existing test `brainstormer AskUserQuestion falls through, its other asks are denied` (`tests/superagent-runner.test.mjs:395`). A brainstormer `AskUserQuestion` gets `{ behavior: 'deny', message: denyMessageFor('brainstormer') }`, and the message contains `questions`. Other roles get `UNATTENDED_DENY_MESSAGE`.
  - `attempt-ended records tokens from the row`: the row's `usageAcc.totals` set to `{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 }` → `tokens: 135`. A reconcile without a row → `tokens: null`.
  - `brainstorm payload fields reach attempt-ended`: done ask with `questions` → event has `questions`. Blocked stand-in → `escalated` and `answers`.
- [ ] **Step 2: Run** `node --test tests/superagent-runner.test.mjs` → FAIL.
- [ ] **Step 3: Implement.**
  - **Launch:** add `tools`/`disallowedTools` for `READ_ONLY_ROLES`. Copy `openQuestions`/`askedIds` into `live` and `contextOf`.
  - **Capture:** in `scan`, on a `result` message after `promptSeq`, set `live.finalText = typeof message.result === 'string' ? message.result : null` and `live.materialized = false`.
  - **Materialise:** `createRunner` gains `writeJsonImpl = writeJsonAtomic` (from `../json-store.js`). In `review()`, right after `scan` and before the idle and stall checks, a read-only live with `finalText` and `!live.materialized` calls `materialize(live)`. When `extractResultJson(live.finalText)` returns an object, it writes `{ ...obj, jobId, phaseId, taskId, attemptId }` to `<dir>/result.json` via `writeJsonImpl` and sets `live.materialized = true`. A throw is caught and logged, and `materialized` stays false so the next review retries. `materialize` is not a claimer and never touches `live.finishing`. `processTurnEnd` calls it once more before `judge`, under the same rules. `judge`'s payload adds `questions`, `answers`, `escalated` (null when absent). `finish` adds `tokens` from `registry.get(live.sessionId)?.usageAcc?.totals` when all four are finite, else `null`. `onApprovalRequest` denies everything with `denyMessageFor(live.role)`; update the header comment at `runner.js:12-16`. `denyMessageFor('brainstormer')` = `'You are running unattended. Put your questions in result.json\'s `questions` list; the stand-in answers them.'`; every other role returns `UNATTENDED_DENY_MESSAGE`. `nudgeText` for `readOnly` = `` `No result was received. Reply with only the result JSON object as your final message.` ``. In `scriptedWorker`, when the card has `resultVia === 'final-message'`, the body (without identity fields) is emitted as the result message's `result` string instead of being written to `result.json`.
- [ ] **Step 4: Run** → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: superagent runner runs the stand-in read-only and records tokens`.

### Task 7: Prompts: cards and role templates

**Files:**
- Modify: `src/superagent/prompts.js:51-157`
- Create: `prompts/superagent/brainstormer.md`, `prompts/superagent/stand-in.md`
- Modify: `prompts/superagent/contract.md`, `spec-writer.md`, `spec-reviewer.md`, `plan-reviewer.md`, `task-reviewer.md`, `verifier.md`, `planner.md`, `implementer.md`, `tester.md`
- Test: `tests/superagent-prompts.test.mjs`, `tests/superagent.test.mjs` (`:206`, `:594-630`)

**Interfaces:**
- Consumes: Task 4 `answerFor`; Task 5 `brainstormLog`; Task 3 `BRAINSTORM_BATCH`, `ANSWER_TAGS`, `BRIEF_HEADINGS`; Task 6 `READ_ONLY_ROLES`.
- Produces: card fields `exchanges` (brainstorm phase only: `brainstormLog(job)` restricted to entries settled before this attempt), `openQuestions` (`answer` only), `maxQuestions: 5` (`ask` only), `userAnswers: Array<{ question, answer }>` (any scope with answers; omitted when none), `resultVia: 'final-message'` (read-only roles only). `keyedOutputs` treats `ask` like `author` and `answer` as `{}`. For a `fix` with no review at its round (an extra-round fix), `previousFindings` is `null` (Decision 10).

- [ ] **Step 1: Write the failing tests:**
  - `ask card carries exchanges, maxQuestions and the brief output`: `outputs` deep-equals `{ brief: artifactPaths(job).brief }`, `maxQuestions === 5`, `exchanges` matches `brainstormLog`, `final` set.
  - `answer card carries open questions and resultVia`: `openQuestions` as launched, `resultVia === 'final-message'`, `outputs` deep-equals `{}`.
  - `userAnswers reach every later card in the scope`: after an answered spec question, a spec card has `userAnswers: [{ question: 'Q?', answer: 'A' }]`. A plan card has no `userAnswers`. For an answered verifier question, the extra-round fix, review and verify cards all carry it.
  - `templates exist and state the rules`: `brainstormer.md` contains `brief`, `questions`, `## Assumptions made for you`, `## Your answers`, `question id`, and `Do not write a design document`. `stand-in.md` contains every `ANSWER_TAGS` value, `escalated`, `final message`, and `When unsure whether`. `spec-writer.md` contains both headings.
  - `the composed stand-in prompt never tells it to write result.json`: `buildWorkerPrompt` for `role: 'stand-in'` gives a `system` text that contains `resultVia` and `final message`. The contract's `result.json.tmp` publishing rule appears only under the condition `unless your card says resultVia`.
  - `the contract documents ask and answer`: the composed brainstormer and stand-in prompts list the `ask` fields (`questions`, at most `maxQuestions`, ids `Q<n>`) and the `answer` fields (`answers` with `id`, `tag`, `answer`, `reason`; blocked = `question` + `escalated` + answers for the rest). The "A `blocked` result needs none of these purpose fields" sentence excludes `ask` and `answer`.
  - `later workers treat the spec's sections as the user's`: a composed `plan:author` prompt for a brainstorming job, with no `userAnswers` on its card, contains the contract sentence naming `## Your answers` as the user's decisions and `## Assumptions made for you` as reviewable defaults.
  - (Do this after Step 4.) **Migrate `tests/superagent.test.mjs`** once the real templates exist. `:206` and `:594` no longer expect the default pipeline to fail on templates: the default pipeline now passes the template check, and `:594` keeps its custom-role cases. `:622-630` may drop its override files.
- [ ] **Step 2: Run** `node --test tests/superagent-prompts.test.mjs` → FAIL.
- [ ] **Step 3: Implement the card fields** in `purposeFields`/`buildWorkerPrompt`.
- [ ] **Step 4: Write the templates**, short like the existing ones (`prompts/superagent/spec-writer.md` is 18 lines).
  - `brainstormer.md`: find what is missing from the idea before a spec is written. Read the project first. Each turn, either ask up to `maxQuestions` new questions, each with a fresh id `Q<n>` that's never reused and only questions whose answer changes what gets built, or write the brief and publish `questions: []`. A `final` card means write the brief now, listing remaining unknowns as assumptions. The brief states what is built and why, then `## Assumptions made for you` (every `assumed` exchange with its reason) and `## Your answers` (every `from-you` exchange), each bullet starting with its question id (`Q<n>`). Do not write a design document, invoke other skills, or start a spec. No visual companion.
  - `stand-in.md`: you answer as the user would; you are read-only. For each open question, answer from the idea first, the project second, and only then assume. Tag `from-idea`, `from-project` or `assumed`, with a one-line reason naming what you relied on. Default to autonomy: assume small calls the spec can settle. Escalate a question only when it changes what gets built and nothing in the idea or project points to an answer. When unsure whether a question has that kind of impact, ask the user rather than guess. At most one escalation per turn: `status: "blocked"`, `question` written for the user, `escalated: "<id>"`, and answers for the rest. Reply with only the result JSON object as your final message; you cannot write files.
  - `contract.md`:
    - The publishing rule (`:7`, `:25`) applies "unless your card says `resultVia: \"final-message\"`". In that case, reply with only the result JSON object as your final message; you cannot write files.
    - The per-purpose list gains `ask` and `answer` (fields as in Task 3). The blocked-result sentence (`:47`) excludes them: a brainstormer never blocks, and a blocked stand-in still needs `escalated` and answers for the rest.
    - One paragraph on answers: `userAnswers` are the user's decisions for this scope and override the reviewer, the spec and your own judgement. A blocker the user dismissed is closed: don't raise, confirm or fix it. In a spec, `## Your answers` are the user's decisions and `## Assumptions made for you` are reviewable defaults.
  - `spec-writer.md`: carry the brief's `## Assumptions made for you` and `## Your answers` into the spec under the same headings.
  - Reviewer, verifier, planner, implementer and tester templates: one line pointing to `userAnswers` per the contract.
- [ ] **Step 5: Run** the file → PASS; `npm test` → all pass.
- [ ] **Step 6: Commit** `feat: superagent brainstormer and stand-in templates, answers on the card`.

### Task 8: Supervisor `answerQuestion`, pipeline tests, docs

**Files:**
- Modify: `src/superagent/index.js` (new `answerQuestion`, add to the returned object)
- Test: `tests/superagent-pipeline.test.mjs`
- Modify: `CLAUDE.md` (Superagent paragraph), `tests/README.md` (superagent section)

**Interfaces:**
- Consumes: everything above.
- Produces: `answerQuestion(jobId: string, text: string): Promise<JobState>`. It rejects with `code: 'ERR_INVALID_STATE'` unless the job is `needs-you`/`question`, has a `detail.attemptId`, has no answer for it yet, and `detail.kind !== 'budget'`. It rejects with `code: 'ERR_INVALID_ANSWER'` unless `text` is a string of 1-4000 characters after trim. `ERR_UNKNOWN_JOB` comes from `requireJob`.

- [ ] **Step 1: Write the failing pipeline tests** (default pipeline, scripted workers; brainstorm handlers keyed `brainstorm:ask` and `brainstorm:answer`):
  - `automatic brainstorm reaches spec with the brief`: ask Q1,Q2 → stand-in answers both → ask with `questions: []` publishing a brief with both headings → the job's `phaseId` becomes `spec`. The spec card's `inputs.brief` points at the brief, and `brainstormLog` has two stand-in-tagged entries.
  - `stand-in escalation, answer, resume`: the stand-in escalates Q2 → job `needs-you`/`question`, `detail.kind === 'stand-in'`, and no live session (`registry` rows for the job all closed). `answerQuestion(jobId, 'Postgres')` → `running`. The next brainstormer card's `exchanges` has Q2 `from-you` `Postgres`, and the brief is accepted.
  - `restart after an answer launches the asking scope`: as above, but stop the supervisor after `answerQuestion` and start a new one over the same store → the next tick launches `brainstorm:ask` with the answer on the card and appends no `needs-you`.
  - `answerQuestion refuses wrong states, budget questions, repeats and bad text`: running job → `ERR_INVALID_STATE`; budget question (`budgetCheck` refusing) → `ERR_INVALID_STATE`; `''`, `'   '` and 4001 characters → `ERR_INVALID_ANSWER`; a second answer → `ERR_INVALID_STATE`; unknown id → `ERR_UNKNOWN_JOB`. `events.jsonl` line count is unchanged after each refusal.
  - `an answered spec question resumes spec`: the spec writer blocks with a question → answer → the next spec card has `userAnswers`, and the job proceeds to `spec-review`.
  - `the fourth question in a scope is stuck`: the spec writer blocks four times, the first three answered → `needs-you`/`stuck`, `detail.why === 'question-cap'`.
  - `a dismissed blocker closes after the extra round`: in a `milestone-2` job with `maxRounds` 1 on spec-review, the verifier confirms → answer `leave it` → fix r2 (declines citing the answer) → review r2 approves → plan phase starts.
- [ ] **Step 2: Run** `node --test tests/superagent-pipeline.test.mjs` → FAIL.
- [ ] **Step 3: Implement `answerQuestion`** inside `withJob`: `requireJob`, the checks above, then `appendConfirmed(jobId, { type: 'question-answered', forAttemptId, answer: text.trim() }, (j) => j.answers.some((a) => a.forAttemptId === forAttemptId))`, and return the job.
- [ ] **Step 4: Run** the file → PASS; `npm test` → all pass, and record the new count.
- [ ] **Step 5: Update docs.** `CLAUDE.md` Superagent paragraph: runnable kinds include `brainstorm`. The automatic brainstorm (one attempt per turn, read-only stand-in returning its result as its final message, unverified against the real SDK), `answerQuestion` and the `question-answered` event, `questionsPerScope`. `needs-you` states other than `ready-to-try` and an answerable `question` stay terminal (`stuck`, `budget`, `tasks-invalid`). Manual mode is not built. Remove "an answer/resume path for needs-you questions" from the not-built list. `tests/README.md`: what each new test file section covers; the stand-in's `tools`/`disallowedTools` and final-message result are hand-verified-only (not yet probed).
- [ ] **Step 6: Run** `npm test` once more → all pass.
- [ ] **Step 7: Commit** `feat: superagent answerQuestion resumes jobs; docs for the automatic brainstorm`.

## Revision 2 changes

Codex review of revision 1 (`.superpowers/sdd/codex-p5-review.md`). All eight findings were checked against the code and accepted:

1. Contract vs stand-in publishing (Important): the contract branches on `resultVia`, documents `ask`/`answer`, and its blocked-result sentence excludes them. Task 7 tests pin the composed prompts.
2. Atomic-write failure stranding an attempt (Important): `materialize` is not a claimer, catches and logs, and retries on the next review. `writeJsonImpl` is injectable. Task 6 test added.
3. Final-message recovery only at turn end (Important): the result is materialised on the first scan that sees it, so removal, stall and reconcile read it from disk. The window up to the next scan is a documented, accepted boundary (Decision 3). Task 6 tests for removal after a scan, removal before any scan, and reconcile after restart.
4. Extra-round path collisions and a missing input (Important): `verify`/`taskVerify` get a `-r<round>` suffix for integer rounds, and base paths are unchanged. An extra-round fix has `previousFindings: null` (Decision 10; Tasks 4 and 7).
5. Carried minors dropped (Important): `capOutcome` returns `carried`, threaded into every extra-round completion (Decision 10). Task 4 test added.
6. Task ordering vs templates and `tests/superagent.test.mjs` (Important): Decision 15 has tests use override templates until Task 7. `tests/superagent.test.mjs` is migrated in Tasks 1 and 7.
7. Later scopes and the spec's "Your answers" (Important): contract paragraph (Decision 13). Task 7 test on a `plan:author` prompt without `userAnswers`.
8. Inspectability backlinks (Minor): session ids in `brainstormLog`, `record` in the escalation detail, question ids in the brief (Decision 14). Task 5 tests extended.
