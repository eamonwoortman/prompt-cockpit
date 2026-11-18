# Superagent Plan 7 — workflow files, a troubleshooting workflow, and in-place folders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A job's pipeline comes from a JSON workflow file chosen in the New job form (shipped: `feature`, `troubleshooting`; users add their own), and any folder of a job can be used in place instead of a new git worktree.

**Architecture:** A new pure loader/validator (`src/superagent/workflows.js`) resolves a workflow into a pipeline, an artifact map, a per-role prompt map and role models, all frozen into `job-created`. The engine stops keying behaviour on phase ids and artifact names (`test`, `implement`, `spec`, `brainstormer`) and keys it on phase properties instead, with legacy jobs normalised on read. In-place folders reuse the worktree code path with `git switch -c`, guarded by an in-memory folder reservation, a pre-switch recheck, a verified `info/exclude` rule and a per-launch safety gate.

**Tech Stack:** Node ESM, `node --test`, vanilla JS frontend, git CLI. No new dependencies.

**Revision:** 2. Folds in the Codex review of revision 1; see "Revision 2 changes" at the end.

**Spec:** [docs/superpowers/specs/2026-11-17-superagent-p7-workflows-design.md](../specs/2026-11-17-superagent-p7-workflows-design.md) (committed `f433d19`). The spec wins over this plan.

## Global Constraints

- Work only on branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`; base `f433d19`.
- No new npm dependencies, no `package.json` change; plain ESM; no build step. Never commit `package-lock.json` (deliberately modified and uncommitted); stage files by name, never `git add -A`; `HANDOVER.md` stays out of commits.
- `src/session-registry.js` and `src/shutdown.js` are NOT modified.
- Baseline: `timeout 500 npm test` → 1193 tests, 1192 pass, 0 fail, 1 skipped (at `b54b2c6`). Record the count in the SDD ledger before Task 1; it stays green after every task.
- Tests are no-network, no real CLI, no real model. Any test that builds a host, store, config, lock or supervisor sets `COCKPIT_HOME` to a temp dir; server-importing tests also set `COCKPIT_OPERATOR_TOKEN` (pattern `tests/autopilot-routes.test.mjs:11-15`). Temp git repos go through `initRepo` (`tests/superagent-helpers.mjs`, disables `core.fsmonitor`).
- NO `Co-Authored-By` trailer. Conventional prefix only; commit with `git commit -F- <<'EOF' ... EOF`. Files are LF.
- No real-model probe and no paid run in this plan. Hand-verification never clicks Send and never creates a job that passes the folder checks.
- Never push, PR or merge.
- Exact values:
  - Workflow file `format`: `1`. Workflow `id` pattern: `/^[a-z0-9][a-z0-9-]{0,23}$/i`. Reserved id: `config-pipeline` (display name `custom (config.json)`).
  - Artifact placeholders: `{slug}`, `{date}` only. Reserved artifact path namespaces: `.git/`, `.superpowers/superagent/`, `docs/superpowers/jobs/{slug}/reviews/`, `docs/superpowers/jobs/{slug}/tasks/`.
  - Sources and locations: built-in `<cockpit>/workflows/*.json`; global `<superagent root>/workflows/*.json`; project `<primary folder>/.superpowers/superagent/workflows/*.json`. Precedence project > global > built-in.
  - Prompt lookup order: `<primary folder>/.superpowers/superagent/prompts/<role>.md` > the job's recorded workflow prompt path > `prompts/superagent/<role>.md`.
  - Model lookup order (later wins): `defaultConfig().models` < workflow `roles.<role>` < `config.json` `defaults.models` < `config.json` `projects[<path>].models`.
  - Default models: stand-in → `claude-sonnet-5-5` (was Opus); all other Feature defaults unchanged. Troubleshooting: investigator Opus 80, diagnosis-reviewer Opus 40, fixer Sonnet 80 alternate Opus, fix-reviewer Sonnet 80, verifier-tester Sonnet 80. Model ids: Opus `claude-opus-5-5`, Sonnet `claude-sonnet-5-5`.
  - New error codes: `ERR_INVALID_WORKFLOW`, `ERR_UNKNOWN_WORKFLOW`, `ERR_FOLDER_BUSY_GIT`, `ERR_FOLDER_DIRTY`, `ERR_FOLDER_IN_USE`, `ERR_FOLDER_ON_JOB_BRANCH`, `ERR_FOLDER_CHANGED`, `ERR_PROMPT_MISSING` (internal), `ERR_INVALID_REQUEST`. New stuck reason: `why: 'prompt-missing'`. New needs-you reason: `folder-changed`; new event type `folder-restored`.
  - In-place checkbox copy: `Use this folder directly (no new worktree)`; note under it: `The job switches this folder to its own branch and works there. Don't work in this folder while the job runs.`; finished-job copy: `This folder is still on the job's branch.`; marker `in place`.
  - `settingsCopy` value for in-place repos: `'in-place'`.
  - Plan 6 exact copy stays verbatim.

## Review Focus

1. **A folder that is not quite clean** (untracked file only, a rebase in progress, detached HEAD, already on `superagent/*`): refused with the specific code and the folder byte-for-byte unchanged. Task 5 test `each in-place check refuses and leaves the folder unchanged`.
2. **Two creates racing on one folder** (double-click, two tabs): exactly one wins; the other gets 409 `ERR_FOLDER_IN_USE` and no `job-created`. Task 5 test `overlapping createJob calls on one folder admit one`.
3. **The user switches the in-place folder's branch while the job waits between attempts, or before a restart**: nothing launches, the job shows `folder-changed`, and it continues by itself after the switch back. Task 7 tests `the safety gate pauses and resumes`.
4. **An existing job and an existing `config.json` pipeline after upgrade**: a pre-Plan-7 job resumes with identical test routing and artifact paths; a raw config `pipeline` is offered and pre-selected as `config-pipeline`. Task 2 test `a legacy job derives the old artifacts and test flag`; Task 3 test `a raw config pipeline is offered and pre-selected`.
5. **A broken or hostile workflow file** (bad JSON, duplicate id, artifact path into `.git/` or `..`, review with two producers): listed invalid with errors, never crashes the list or boot, and never silently replaced by a lower source. Task 1 tests under `loader contract` and `validation refuses`.

---

## Decisions the spec leaves to the builder

1. **Module split.** `src/superagent/workflows.js` holds the pure parts (`validateWorkflow`, `substituteArtifacts`, `resolveWorkflowModels`) and the loader (`loadWorkflows({ builtinDir, globalDir, projectDir, fileConfig, projectPath, fsImpl })`). `src/superagent/inplace.js` holds the in-place git checks and the exclude rule. `worktree.js` keeps worktree code.
2. **Shipped workflow files** live in `<repo>/workflows/feature.json` and `<repo>/workflows/troubleshooting.json`; `workflowsDir()` mirrors `templatesDir()` (`prompts.js:23`). The shipped files carry no `prompt` fields: every shipped role resolves to `prompts/superagent/<role>.md`.
3. **Legacy normalisation lives in `deriveJob`.** A `job-created` without `workflow` (pre-Plan-7, or a fixture job): `artifacts` = today's table, and the author phase with id `test` gets `test: true` in the derived pipeline. The event log is never rewritten.
4. **Fixtures.** `MILESTONE_2_PIPELINE`'s `test` phase gains `test: true` in `config.js`; `createJob({ fixture })` keeps the old path (no `workflow` recorded, legacy artifacts) so existing tests and probes are untouched.
5. **`folder-changed` in the bell** is notification type `stuck` (Plan 6 allows three types) with message `"<title>" is paused: <detail.text>`.
6. **Request shape.** `POST /api/superagent/jobs` takes `workflow` (string id, optional) and `inPlace` (array of folder paths, each equal after `path.resolve` to the primary or one additional folder; optional). Library: `createJob({ ..., workflow = null, inPlace = [] })`.
7. **Reservation** is a `Map<normalisedTopLevel, { jobId, inPlace: boolean }[]>` inside `createSuperagent`, rebuilt in `start()` from unfinished jobs' repos before the timer is armed, and released when a job reaches `done`, `stopped` or `failed` (checked where those events are appended, and on `createJob` refusal).

---

### Task 1: Workflow loader and validator

**Files:**
- Create: `src/superagent/workflows.js`
- Create: `workflows/feature.json`
- Modify: `src/superagent/config.js` (export `validatePipeline(d) = validate(d, { composition: false })` for the workflow validator; `defaultConfig().models['stand-in']` → Sonnet; `MILESTONE_2_PIPELINE` and `defaultConfig().pipeline` `test` phase gain `test: true`)
- Test: `tests/superagent-workflows.test.mjs`

**Interfaces:**
- Produces:
  - `WORKFLOW_FORMAT = 1`, `CONFIG_PIPELINE_ID = 'config-pipeline'`, `LEGACY_ARTIFACTS` (today's five-key table with `{slug}`/`{date}` placeholders).
  - `workflowsDir(): string` (`<repo>/workflows/`).
  - `async resolvePromptPath(role, { projectDir, workflowFile, promptField, builtinDir, fsImpl }): Promise<{ source: 'project'|'workflow'|'built-in', path } | null>` — the lookup order from Global Constraints; `workflowFile` is the workflow's absolute path (its `prompt` is relative to that file's directory); a role name failing `prompts.js`'s role pattern → `null`. Read errors other than `ENOENT` reject. This is the only implementation of the lookup; Task 3 makes `prompts.js` use it.
  - `validateWorkflow(doc, { models, promptFor }): { errors: {path, message}[] }` — pure and synchronous; `models` is the merged model map, `promptFor` a plain object `{ [role]: resolvedPathOrNull }` the caller built with `resolvePromptPath` beforehand.
  - `substituteArtifacts(artifacts, { slug, date }): Record<string,string>`.
  - `resolveWorkflowModels(workflow, fileConfig, projectPath): models` — the four-layer merge.
  - `async loadWorkflows({ builtinDir, globalDir, projectDir, fileConfig, projectPath, fsImpl }): { workflows: Entry[], default: string, defaultNote: string|null }` where `Entry = { id, name, description, source: 'built-in'|'global'|'project'|'config', file, valid, errors, doc }`; for each id, `workflows` holds the entries of the **highest source that has that id**: one entry normally, or every same-id file of that source marked `valid: false` with `duplicate id`; entries of that id from lower sources are omitted (shadowed), so a duplicate or invalid override is never replaced by a lower one. Files with no usable id are listed by file name, `valid: false`, shadowing nothing. A prompt that cannot be resolved, or a prompt read that rejects, makes that entry invalid; it never rejects the whole list. `loadWorkflows` resolves every role's prompt with `resolvePromptPath` before calling `validateWorkflow`.

- [ ] **Step 1: Write the failing tests** in `tests/superagent-workflows.test.mjs`:
  - `the shipped feature file produces today's default pipeline`: loading `workflows/feature.json` gives `doc.phases` deep-equal to `defaultConfig().pipeline` and `valid === true`.
  - `validation refuses` — one case each, asserting the error message names the rule: unknown `format`; bad id; `config-pipeline` id; duplicate phase id; input not produced earlier; output not in `artifacts`; review target with two earlier author producers; review `author` not equal to the producer's role; brainstorm not first, or with outputs other than `['brief']`; `test: true` on a non-author phase; two `test: true` phases; with a `per-task` phase, a `test: true` phase not directly after it; two `per-task` phases; last phase not `human`; a role with no model; a role with no prompt; artifact key `review` (reserved attempt-key kind) or with a colon; artifact path absolute, containing `..`, inside `.git/`, inside `.superpowers/superagent/`, inside `docs/superpowers/jobs/{slug}/reviews/`; two artifact paths equal after substitution and win32 normalisation (`Docs\\A.md` vs `docs/a.md`); `tasks` mapped to a non-`.json` path.
  - `validation accepts a test phase without a per-task phase`: `author` → `author` with `test: true` → `human` is valid.
  - `loader contract`: same-id files in one source → both invalid `duplicate id`, and a duplicated `feature` in the global source shadows the valid built-in (no valid `feature` returned); unparseable file → listed invalid under its file name; an invalid project `feature` shadows the built-in (entry is invalid, no valid `feature` returned); a valid global `x` is overridden by a valid project `x` (`source: 'project'`); files read in name order, non-`.json` and subdirectories ignored; a missing directory is no error.
  - `default selection`, in this order, first hit wins: `projects[<path>].workflow` > `projects[<path>].pipeline` (→ `config-pipeline`) > `defaults.workflow` > `defaults.pipeline` (→ `config-pipeline`) > `feature`; the project key matched with `config.js`'s normalised path comparison. Cases: project pipeline beats defaults workflow; project workflow beats defaults pipeline; a project key differing only in case on win32 still matches; `defaults.workflow = 'nope'` → `default: 'feature'` with `defaultNote` mentioning `nope`.
  - `config-pipeline` is listed when the raw file has `pipeline` in `defaults` or in the matching `projects` entry, and its phases are that scope's pipeline (project over defaults).
  - `models merge in four layers`: built-in < workflow role < defaults.models < projects.models, asserted on one role.
- [ ] **Step 2: Run** `node --test tests/superagent-workflows.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/superagent/workflows.js` and `workflows/feature.json`. The validator reuses `config.js`'s per-phase checks through `validatePipeline({ ...resolvedConfig, pipeline: doc.phases, models })` and adds the workflow-level rules above; keep the reserved-kind list (`review`, `response`, `verify`, `report`, `taskReview`, `taskVerify`, `idea`) next to `view-model.js`'s key kinds by importing it from one place. Artifact key pattern `/^[a-zA-Z][a-zA-Z0-9]{0,31}$/`. Normalise paths for collision with `path.posix.normalize` on `\\`→`/`, lower-cased when `platform === 'win32'` (inject `platform`).
- [ ] **Step 4: Run** the file → PASS; run `node --test tests/superagent-config.test.mjs` → PASS (update only the stand-in model assertion if one exists).
- [ ] **Step 5: Commit** `feat: superagent workflow files - loader and validator`.

### Task 2: Engine keys on phase properties, artifacts from the job

**Files:**
- Modify: `src/superagent/store.js` (`deriveJob` copies `workflow`, `artifacts`, `prompts` and, per repo, `inPlace`, `toplevel`, `admittedHead` from `job-created` (today it rebuilds repos field by field, `store.js:44`); legacy normalisation per Decision 3; `test-routed` replaces all three hard-coded references — the `implement` lookup (`store.js:171`), the `phase !== 'test'` guard (`:172`) and `job.visits.implement` (`:176`) — with the `per-task` phase found by kind, the current phase's `test` flag, and `job.visits[<per-task phase id>]`)
- Modify: `src/superagent/results.js` (`artifactPaths(job)` returns `job.artifacts`; `headingsTarget` uses "author phase whose inputs include `brief`" and returns its first output)
- Modify: `src/superagent/sequencer.js` (`isTest = phase.test === true`; `routeTestFailure` requires a `per-task` phase instead of id `implement`)
- Modify: `src/superagent/prompts.js` (`denyMessageFor(phaseKind)`), `src/superagent/runner.js:541` (pass the attempt's phase kind)
- Modify: `src/superagent/view-model.js` (`artifactKeys`/`artifactPath` use `Object.keys(artifactPaths(job))` instead of `FIXED_KEYS`; `brief` shown when present)
- Test: `tests/superagent-store.test.mjs`, `tests/superagent-results.test.mjs`, `tests/superagent-sequencer.test.mjs`, `tests/superagent-prompts.test.mjs`, `tests/superagent-view-model.test.mjs`, `tests/superagent-pipeline.test.mjs`

**Interfaces:**
- Consumes: `LEGACY_ARTIFACTS`, `substituteArtifacts` (Task 1).
- Produces: derived job fields `job.workflow` (`{id,name,source,file}` or `null`), `job.artifacts` (resolved map), `job.prompts` (`{ [role]: absPath|null }` or `{}`), and per repo `inPlace` (boolean, default `false`), `toplevel` (string or `null`), `admittedHead` (string or `null`). `job-created` accepts those fields; Task 5 is the first writer of the repo fields.

- [ ] **Step 1: Failing tests:**
  - store `a legacy job derives the old artifacts and test flag`: a `job-created` without `workflow` → `job.artifacts` equals today's `artifactPaths` output for that slug/date; the `test` phase has `test: true`; a `test-routed` event moves `phaseIndex` to the `per-task` phase.
  - pipeline `a pre-Plan-7 job resumes and routes a test failure`: write an old-format event log by hand (no `workflow`, `artifacts` or `test` flags; repos without the new fields; the default pipeline as it was before Task 1) for a job paused mid-`test`, start a supervisor over it, drive scripted workers through a failed test → generated fix task in `implement` → passing test → `ready-to-try`; assert the artifact paths used are today's, and `phaseIndex` and `visits.implement` after the route.
  - store `a workflow job keeps its recorded artifacts and phases`: a `job-created` with `workflow`, `artifacts: { diagnosis: 'd.md', tasks: 't.json', testReport: 'r.md' }` and a pipeline whose test phase is `verify` with `test: true` and per-task phase `fix` → `artifactPaths(job)` returns that map; `test-routed` re-enters `fix`.
  - sequencer `test routing follows the test flag, not the id`: a `verify` phase with `test: true` and a failed attempt with findings → `route-test-failure`; the same phase without the flag → no routing.
  - results `the headings check follows the brief input`: a brainstorming job whose author phase `diagnosis-writer` takes `brief` checks its first output's headings; a phase not taking `brief` is not checked.
  - prompts `the deny message follows the phase kind`: `denyMessageFor('brainstorm')` is the brainstormer message; `denyMessageFor('author')` is `UNATTENDED_DENY_MESSAGE`.
  - view-model `workflow artifact keys are listed`: a job with outputs `diagnosis` lists key `diagnosis` and resolves its path; an unknown key → `null`.
- [ ] **Step 2: Run** the five files → the new tests FAIL.
- [ ] **Step 3: Implement** as listed under Files. `deriveJob` computes legacy artifacts with `substituteArtifacts(LEGACY_ARTIFACTS, { slug, date: createdDate })`.
- [ ] **Step 4: Run** the five files plus `tests/superagent-pipeline.test.mjs` and `tests/superagent.test.mjs` → PASS (the milestone-2 and brainstorm runs show new jobs behave as before; the hand-written old-format log above shows pre-Plan-7 jobs do).
- [ ] **Step 5: Commit** `refactor: superagent engine keys on phase properties and per-job artifacts`.

### Task 3: createJob takes a workflow

**Files:**
- Modify: `src/superagent/index.js` (`createJob({ ..., workflow = null })`; new `listWorkflows(primaryPath)`; `resolvePipeline` gains a workflow branch; `job-created` records `workflow`, `artifacts`, `prompts`, workflow-merged `models`)
- Modify: `src/superagent/config.js` (`createSuperagentConfig` exposes `raw()` returning the loaded file object, so the loader can see a raw `pipeline` and `workflow`)
- Modify: `src/superagent/prompts.js` (`loadRoleTemplate(role, projectDir, recordedPrompt)` and `hasTemplate(role, { projectDir, recordedPrompt })` delegate to Task 1's `resolvePromptPath` — with a recorded absolute path standing in for the workflow step — and read the file it returns; `buildWorkerPrompt` passes `job.prompts?.[role] ?? null`; a non-null recorded path that no longer exists, with no project override present, throws code `ERR_PROMPT_MISSING`)
- Modify: `src/superagent/runner.js` (an `ERR_PROMPT_MISSING` from `buildWorkerPrompt` ends the launch without a session and makes the job `stuck` with `why: 'prompt-missing'`, `path`)
- Test: `tests/superagent.test.mjs`, `tests/superagent-prompts.test.mjs`, `tests/superagent-runner.test.mjs`

**Interfaces:**
- Consumes: `loadWorkflows`, `resolveWorkflowModels`, `substituteArtifacts`, `CONFIG_PIPELINE_ID` (Task 1); derived job fields (Task 2).
- Produces: `supervisor.createJob({ title, idea, primaryRepo, additionalRepos, mode, fixture, workflow, inPlace })` (`inPlace` used from Task 5); `supervisor.listWorkflows(primaryPath): Promise<{ workflows: Entry[], default, defaultNote }>` (entries without `doc`); `createSuperagent({ ..., workflowDirs = { builtin: workflowsDir(), global: <root>/workflows } })`.

- [ ] **Step 1: Failing tests:**
  - `createJob with a workflow records it`: a global workflow file with one author + human phase → `job-created` has `workflow.id`, substituted `artifacts`, `prompts` with absolute paths for roles that set `prompt` and `null` otherwise, and models from the four-layer merge.
  - `createJob refuses an unknown or invalid workflow before the job exists`: `ERR_UNKNOWN_WORKFLOW` / `ERR_INVALID_WORKFLOW`, no job directory created.
  - `a raw config pipeline is offered and pre-selected`: through a real `createSuperagentConfig` file, `defaults.pipeline` → `listWorkflows` contains `config-pipeline` named `custom (config.json)` and `default === 'config-pipeline'`; a project-scope pipeline beats `defaults.workflow`; without a raw pipeline it is absent; `createJob({ workflow: 'config-pipeline' })` records that scope's phases.
  - `createJob without workflow uses the default`; `createJob with fixture keeps the legacy shape` (no `workflow` field recorded).
  - prompts `prompt lookup order`: project override beats a recorded workflow prompt, which beats the built-in.
  - runner `a recorded prompt that disappeared makes the job stuck`: delete the file after `createJob`, tick → no session created, job `stuck` `why: 'prompt-missing'`.
  - `an edited workflow file does not change an existing job`: edit the file's phases after `createJob`, restart the supervisor over the same store → the job's pipeline is unchanged.
- [ ] **Step 2: Run** those files → FAIL.
- [ ] **Step 3: Implement.** `createJob` resolves the workflow before the job id is minted (so a refusal creates nothing), using `loadWorkflows` with `projectDir = origin` (prompt availability is already resolved there) and recording `prompts[role]` as the `path` when `resolvePromptPath` returned `source: 'workflow'`, else `null`. `config-pipeline` resolves from the raw config's `pipeline` and is validated with today's `validateDefaults` (composition on).
- [ ] **Step 4: Run** those files plus the whole superagent suite (`node --test tests/superagent*.test.mjs`) → PASS.
- [ ] **Step 5: Commit** `feat: superagent jobs are created from a workflow file`.

### Task 4: The troubleshooting workflow

**Files:**
- Create: `workflows/troubleshooting.json` (phases exactly as the spec's example: `investigate` author `investigator` outputs `diagnosis`,`tasks`; `diagnosis-review` review `diagnosis-reviewer` author `investigator` target `diagnosis` inputs `tasks` maxRounds 3; `fix` per-task `fixer` taskReview `fix-reviewer` inputs `diagnosis`,`tasks`; `verify` author `verifier-tester` inputs `diagnosis`,`tasks` outputs `testReport` `test: true`; `accept` human inputs `testReport`; artifacts `diagnosis` → `docs/superpowers/jobs/{slug}/diagnosis.md`, `tasks` → `docs/superpowers/jobs/{slug}/tasks.json`, `testReport` → `docs/superpowers/jobs/{slug}/test-report.md`; role models per Global Constraints)
- Create: `prompts/superagent/investigator.md`, `diagnosis-reviewer.md`, `fixer.md`, `fix-reviewer.md`, `verifier-tester.md`
- Test: `tests/superagent-pipeline.test.mjs` (new test), `tests/superagent-workflows.test.mjs` (shipped file valid)

**Interfaces:**
- Consumes: Tasks 1-3.

- [ ] **Step 1: Failing tests:**
  - workflows `the shipped troubleshooting file is valid`.
  - pipeline `troubleshooting runs investigate to accept with one routed failure`: scripted workers (existing `scriptedWorker` harness) — investigator writes `diagnosis.md` and a one-task `tasks.json`; diagnosis reviewer approves round 1; fixer commits; fix reviewer approves; verifier-tester fails once with findings → a fix task `F-…` is routed into `fix`; second verify passes → job `needs-you` `ready-to-try`. Assert the fixer's job card lists `diagnosis` among its inputs.
  - pipeline `an investigator that cannot reproduce asks the user`: investigator returns `status: blocked` with a question → job `needs-you` `question`; `answerQuestion` resumes `investigate`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write the file and the five prompts.** Each prompt follows the existing templates' shape (role, what to read, what to publish, result contract reference). Content requirements:
  - investigator: Phase 1 root-cause investigation (read errors fully, reproduce consistently, check recent changes, gather evidence at component boundaries, trace data flow), Phase 2 pattern analysis, Phase 3 one hypothesis tested minimally; write `diagnosis` with headings `## Reproduction`, `## Evidence`, `## Root cause`, `## Hypothesis tested`; write `tasks` (normally one task whose `acceptance` names the failing test to write and the reproduction to re-run); cannot reproduce → `status: blocked` with a question; "invoke `superpowers:systematic-debugging` if it is available in your session".
  - diagnosis-reviewer: challenge the root cause against the evidence; a symptom presented as a cause, an untested hypothesis or an unreproduced bug is a blocker.
  - fixer: read `diagnosis`; write the failing test first and show it fails; one fix aimed at the root cause; verify; read earlier fix reports of this job and, on a third failed approach, return `status: blocked` with a question instead of a fourth; "invoke `superpowers:test-driven-development` if available".
  - fix-reviewer: the test fails without the fix; the fix targets the diagnosed cause, not a symptom; no unrelated changes.
  - verifier-tester: re-run the reproduction and the suite; write `testReport`; failures as findings; "invoke `superpowers:verification-before-completion` if available".
- [ ] **Step 4: Run** the two files → PASS.
- [ ] **Step 5: Commit** `feat: superagent troubleshooting workflow`.

### Task 5: In-place checks and the folder reservation

**Files:**
- Create: `src/superagent/inplace.js`
- Modify: `src/superagent/index.js` (`createJob`'s `inPlace` option; reservation per Decision 7; `checkRepos` runs the in-place checks for in-place repos, skips the worktree-path check for them, and returns `{ toplevel, head }` per repo instead of discarding it (`index.js:578-583`); each in-place repo in `job-created` carries `inPlace: true`, `toplevel` and `admittedHead` = that `head`)
- Test: `tests/superagent-inplace.test.mjs`

**Interfaces:**
- Produces:
  - `async checkInPlace({ git, folder, branch }): { toplevel, head }` — `toplevel` from `repoToplevel`, `head` the full SHA of HEAD; throws `ERR_NOT_GIT_REPO`, `ERR_NO_COMMITS`, `ERR_FOLDER_BUSY_GIT` (detached HEAD; `rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` under `git rev-parse --git-dir`), `ERR_FOLDER_ON_JOB_BRANCH` (current branch starts with `superagent/`), `ERR_FOLDER_DIRTY` (`git status --porcelain --untracked-files=all` non-empty; message lists up to 10 paths), `ERR_BRANCH_EXISTS`.
  - `normaliseTop(p, platform): string` shared with `ERR_DUPLICATE_REPO`'s comparison.

- [ ] **Step 1: Failing tests** (temp repos via `initRepo`; snapshot = branch list, HEAD, `git status --porcelain`, existence of `.superpowers/`):
  - `each in-place check refuses and leaves the folder unchanged` — one case per code above (untracked-only file → `ERR_FOLDER_DIRTY`; detached HEAD and an in-progress merge → `ERR_FOLDER_BUSY_GIT`; on `superagent/x` → `ERR_FOLDER_ON_JOB_BRANCH`); snapshot equal before and after; no job directory.
  - `overlapping createJob calls on one folder admit one`: two `createJob` calls on one in-place folder started in the same tick (no await between) → one resolves, one rejects `ERR_FOLDER_IN_USE`.
  - `an unfinished in-place job blocks a worktree job on that repo`; `two worktree jobs on one origin coexist`; `a finished in-place job releases its reservation` (stop it, then a new in-place job on the folder after switching it back passes the checks).
  - `a subfolder of a repo records the repo top level`: in place on `<repo>/sub` → the `job-created` repo has `toplevel` = `<repo>` and `admittedHead` = HEAD.
  - `reservations are rebuilt on start`: a store holding an unfinished in-place job, new supervisor, `start()`, then `createJob` in place on that folder → `ERR_FOLDER_IN_USE`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Take reservations synchronously before the first `await` of `createJob`'s folder work, keyed by `normaliseTop(path.resolve(folder))` first and re-keyed to the real top level once `repoToplevel` returns (both keys held until release). An `inPlace` entry that matches neither the primary nor an additional folder is refused with `ERR_INVALID_REQUEST` (`inPlace folder is not one of the job's folders`); the route maps it to 400. Add a test case for it to Step 1's file.
- [ ] **Step 4: Run** the file and `tests/superagent.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat: superagent in-place folder checks and reservation`.

### Task 6: In-place provisioning

**Files:**
- Modify: `src/superagent/inplace.js` (`provisionInPlace`, `addLedgerExclude`)
- Modify: `src/superagent/index.js` (`provision()` branches on `repo.inPlace`; `fitSlug`/`longestAttemptPath` measure from the in-place folder when the primary is in place; `orphanWorktrees()` passes only non-in-place origins)
- Modify: `src/superagent/worktree.js` only if `listOrphanWorktrees` needs a parameter (prefer filtering in `index.js`)
- Test: `tests/superagent-inplace.test.mjs`

**Interfaces:**
- Produces:
  - `async provisionInPlace({ git, folder, branch, jobId, expectedHead }): { worktree, branch, baseSha, settingsCopy: 'in-place' }` — `provision()` calls it with `folder = repo.toplevel` and `expectedHead = repo.admittedHead` from the derived job, and records `worktree = repo.toplevel`; it re-runs `checkInPlace` and compares HEAD to `expectedHead` (mismatch → `ERR_FOLDER_CHANGED`), runs `git switch -c <branch>`, creates `.superpowers/superagent/<jobId>/`, calls `addLedgerExclude`, verifies with `git check-ignore -q .superpowers/superagent/<jobId>/probe`.
  - `async addLedgerExclude({ git, folder, jobId, fsImpl })` — path from `git rev-parse --git-path info/exclude` resolved against `folder`; appends `/.superpowers/superagent/<jobId>/` (with a leading newline when the file does not end in one) unless the line is already present; creates `info/` if missing.
  - `worktree-created` event gains `inPlace: true` for these repos.

- [ ] **Step 1: Failing tests:**
  - `a clean folder is switched in place`: HEAD unchanged, current branch `superagent/<slug>`, no `.gitignore` written under `.superpowers/`, `git status --porcelain` empty after provisioning, exclude file ends with the rule, `settingsCopy === 'in-place'`.
  - `an exclude file without a final newline keeps its last line`.
  - `a nested negation makes provisioning fail before any launch`: a tracked `.superpowers/superagent/.gitignore` containing `!*` → job `failed`, no session created.
  - `the folder changed between checks and switch`: change HEAD (new commit) after `createJob` admission but before provisioning (inject a `git` wrapper that commits on the first `switch`-preceding call) → job `failed`, branch not created.
  - `orphan listing skips in-place repos`; `the path-length check measures from the in-place folder` (win32 platform injected, short folder, long `worktreesRoot` → no `ERR_PATH_TOO_LONG`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `tests/superagent-worktree.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat: superagent in-place provisioning with a verified exclude rule`.

### Task 7: The in-place safety gate

**Files:**
- Modify: `src/superagent/inplace.js` (`checkGate`)
- Modify: `src/superagent/index.js` (`launchStep` runs the gate first, so a paused job does not even run `budgetCheck`; `runTick` also visits jobs in `needs-you`/`folder-changed`, inside `withJob`, and appends `folder-restored` when the gate passes and the job is still `needs-you`/`folder-changed` and not stop-requested after the gate's await)
- Modify: `src/superagent/runner.js` (`createRunner` takes `beforeSession(job) => Promise<{ ok } | { ok: false, text }>` and calls it for the job's in-place repos **immediately before `registry.createSession`**, after the second `gate(live)` (`runner.js:456`) — the budget check, attempt start and prompt reads all await first, so the early gate alone can be stale. A failure ends the attempt without a session, outcome `failed`, reason `folder-changed`, which the sequencer's `consumes()` must not count toward caps, repeated-error or back-off; then the job gets `needs-you` `folder-changed`)
- Modify: `src/superagent/store.js` (`EVENT_TYPES` gains `folder-restored`; it sets `running` only from `needs-you`/`folder-changed`)
- Modify: `src/superagent/notifications.js` and `view-model.js` (`folder-changed` → type `stuck`, message per Decision 5; detail text shown in the needs-you pane)
- Test: `tests/superagent-inplace.test.mjs`, `tests/superagent-store.test.mjs`, `tests/superagent-view-model.test.mjs`, `tests/superagent-sequencer.test.mjs`

**Interfaces:**
- Produces: `async checkGate({ git, folder, branch, baseSha }): { ok: true } | { ok: false, text }` — fails when the current branch is not `branch`, a git operation is in progress, or `git merge-base --is-ancestor <baseSha> HEAD` fails; `text` e.g. `this folder is on main; switch it back to superagent/<slug> to continue`. Uncommitted changes never fail it.

- [ ] **Step 1: Failing tests:**
  - `the safety gate pauses and resumes`: provisioned in-place job; `git switch main` in the folder; tick → no session created, job `needs-you` `folder-changed` with that text; tick again → still paused, no new event; `git switch superagent/<slug>`; tick → `folder-restored`, job `running`, next tick launches.
  - `a branch switch during a pending budget check still blocks the launch`: inject a deferred `budgetCheck`; switch the folder while it is pending; resolve it → no session created (the final gate caught it), job `folder-changed`, the ended attempt not counted (a later resume launches attempt n with the same `n` budget).
  - `a stop during a pending restoration check appends no folder-restored`: hold the gate's git call, `stopJob`, release → job `stopped`, no `folder-restored`.
  - `uncommitted changes alone do not trip the gate`.
  - `the gate runs after a restart`: switch the folder away, new supervisor over the same store, `start()` + tick → `folder-changed`, nothing launched.
  - store `folder-restored only resumes a folder-changed job`.
  - view-model/notifications `folder-changed is a stuck bell entry with its text`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those files and `tests/superagent-runner.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat: superagent pauses an in-place job whose folder changed`.

### Task 8: Routes and view-model

**Files:**
- Modify: `src/routes/superagent.js` (`GET /api/superagent/workflows?primary=<folder>`; `POST /api/superagent/jobs` accepts `workflow` and `inPlace`; status mapping for the new codes: `ERR_FOLDER_IN_USE` → 409; `ERR_UNKNOWN_WORKFLOW`, `ERR_INVALID_WORKFLOW`, `ERR_FOLDER_*` other than in-use, `ERR_INVALID_REQUEST` → 400)
- Modify: `src/superagent/view-model.js` (`jobSummary`/`jobDetail` gain `workflow: { id, name } | null` and `repos[].inPlace`; detail `readyInputs`: the final human phase's `inputs` keys)
- Test: `tests/superagent-routes.test.mjs`, `tests/superagent-view-model.test.mjs`

**Interfaces:**
- Consumes: `supervisor.listWorkflows`, `createJob` options (Tasks 3, 5).
- Produces: `GET /api/superagent/workflows` → 200 `{ workflows: [{ id, name, description, source, valid, errors }], default, defaultNote }`, admitted like the other read routes (503 not ready, 409 not-owner); `primary` missing or not a directory → 400.

- [ ] **Step 1: Failing tests:** workflows listing including a project-source file and an invalid file; `primary` missing → 400; create with `workflow` and `inPlace` passes them through; each new code maps to its status; `inPlace` not an array of strings → 400; detail carries `workflow.name`, `repos[].inPlace` and `readyInputs`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: superagent workflow and in-place routes`.

### Task 9: The view

**Files:**
- Modify: `public/superagent-view.js` (Workflow select fed by `GET /api/superagent/workflows`, refetched when the primary folder changes; invalid entries `disabled` with their first error shown under the select; `defaultNote` shown; per-folder in-place checkbox and note; job list/detail show the workflow name and `in place`; finished in-place job shows `This folder is still on the job's branch.`; Ready to try shows `readyInputs` (plus `brief` when the job has one) instead of the hard-coded `testReport`/`brief`; `folder-changed` shown in the needs-you pane with its text)
- Modify: `public/style-superagent.css`, only if a new class is needed
- Modify: `tests/superagent-view-fixture.manual.mjs` (seed one troubleshooting job at `ready-to-try` and one in-place job paused at `folder-changed`; its no-launch check must still pass)
- Test: hand-verified (no jsdom in this project, see `tests/README.md`)

- [ ] **Step 1:** Run the fixture under a temp `COCKPIT_HOME` and `COCKPIT_OPERATOR_FILE`; it must print the no-launch PASSED line before any Cockpit starts on that home.
- [ ] **Step 2:** Start Cockpit on `PORT=4399` on that home; with Playwright verify: the select lists Feature, Troubleshooting and a seeded invalid global file (disabled, error shown); changing the primary folder to a temp repo with a project workflow adds it; the in-place checkbox shows its note; creating a job in place on a dirty temp folder shows `ERR_FOLDER_DIRTY` inline and leaves the folder unchanged; the seeded troubleshooting job's Ready to try shows `testReport`; the paused job shows its folder-changed text. Never click Send; never create a job that passes the checks. Stop the server.
- [ ] **Step 3: Commit** `feat: superagent view - workflow select and in-place folders`.

### Task 10: Docs

**Files:**
- Modify: `CLAUDE.md` (Superagent paragraph: workflow files and their three sources, the troubleshooting workflow, in-place folders and the safety gate; `workflows/` next to `prompts/superagent/`)
- Modify: `README.md` (Superagent section: choosing a workflow, writing one, in-place folders and their checks), `tests/README.md` (what is unit-tested vs hand-verified for Tasks 1-9), `backlog.md` (append under "Superagent - planned for later plans": reusing old job worktrees; a provisioning progress indicator; removing `config.json` `pipeline` support; detecting the user's own sessions in an in-place folder)
- Modify: this plan — append `## Execution amendments` for any ruling made during execution

- [ ] **Step 1:** Update the four docs; append only, except the stale claims the sweep finds.
- [ ] **Step 2: Sweep:** `grep -rn "FIXED_KEYS\|phase === 'test'\|=== 'implement'\|'brainstormer'\|v1 pipelines must" src public tests CLAUDE.md README.md` — every hit updated or deliberately kept (legacy normalisation, tests of legacy jobs). Run `timeout 500 npm test` → all pass.
- [ ] **Step 3: Commit** `docs: superagent workflow files, troubleshooting and in-place folders`.

## Revision 2 changes

Folds in the Codex review of revision 1 (`.superpowers/sdd/codex-p7-plan-review.md`, 3 High, 4 Medium):

1. **Final safety gate right before `createSession`** (High 1): the runner calls `beforeSession` after every await; a failure ends the attempt uncounted; restoration runs inside `withJob` and re-checks stop. Task 7.
2. **Admitted HEAD and top level travel in the event log** (High 2): `checkRepos` returns them, `job-created` records `toplevel`/`admittedHead` per in-place repo, `deriveJob` keeps them, `provision()` passes them. Tasks 2, 5, 6.
3. **One prompt-resolution contract** (High 3): `resolvePromptPath` (async) in Task 1, `validateWorkflow` takes a pre-resolved `promptFor` map, `prompts.js` delegates to it in Task 3; prompt failures make an entry invalid, never the list. Tasks 1, 3.
4. **Duplicate entries shadow lower sources** (Medium 4). Task 1.
5. **At most one test phase; adjacency only with a per-task phase** (Medium 5). Task 1.
6. **Default selection by scope** (Medium 6): project workflow > project pipeline > defaults workflow > defaults pipeline > feature. Tasks 1, 3.
7. **A real pre-Plan-7 replay test** and all three hard-coded `test-routed` references replaced (Medium 7). Task 2.

## Execution amendments

Rulings made while executing, from the SDD ledger; where one differs from the text above, the ruling wins.

- Base is `5bb42eb`, not `f433d19`: the plan commit sits on top of it and is docs only.
- Task 1 implements and tests both reserved report namespaces (`reviews/` and `tasks/`), since Global Constraints list both and the test list named one.
- The role-name pattern lives in `workflows.js` and `prompts.js` imports it, to avoid an import cycle; `resolvePromptPath` stays the only lookup implementation.
- Task 2 runs all six listed test files (the plan's "five" was a miscount).
- Task 7 may change `sequencer.js` for the `consumes()` exclusion (the plan required the behaviour).
- The route `inPlace` is an array of folder paths and the workflows response carries `defaultNote`, so the form can show why a default fell back.
- A workflow `prompt` naming a missing file makes the entry invalid rather than falling back to the built-in, so a broken override stays visible; a declared prompt is always recorded in `job-created`, so a vanished one gives `prompt-missing`.
- The runner gives the phase kind to `denyMessageFor` only when the attempt's role is the phase's own role, so a stand-in inside a brainstorm keeps the unattended message.
- `artifactPaths` throws on a job without `artifacts` instead of returning undefined; legacy jobs are normalised in `deriveJob`.
- A non-fixture `createJob` with invalid config models refuses with `ERR_INVALID_WORKFLOW` (the models feed the workflow's validation).
- Reviewer-found prompt gap raised to Important: `fix-reviewer.md` no longer allows a temporary git worktree, since troubleshooting targets in-place folders of huge repos.
- Until Task 6 an admitted in-place job still provisioned as a worktree (transient on the branch).
- `toplevel` is recorded in `job-created` for every repo, not only in-place ones; the start-up rebuild keys on it and resolves the top level through git for pre-Plan-7 jobs. In-place-ness keys on `inPlace`.
- The Windows path-length guard measures from the folder as given, which is only ever conservative.
- A worktree job whose origin is on a `superagent/*` branch is refused with `ERR_FOLDER_ON_JOB_BRANCH` too, so a new job never starts from another job's branch (the spec table listed only the in-place case).
- The tasks.json read is gated like a launch: a folder switched away pauses as `folder-changed` instead of ending `tasks-invalid`.
- Gated attempts are excluded in `attemptsFor` (caps, repeated-error, back-off, attempt numbers), not only in `consumes()`, and `artifactKeys` ignores them too.
- A git read failure or missing folder at the gate pauses (`could not check this folder: ...`) rather than failing the launch.
- Only the first brief-consuming `author` phase carries the brief-heading check, matching the spec.
- Engine roles (`verifier`, `stand-in`, `router`) are not settable from a workflow file; they stay in config.
