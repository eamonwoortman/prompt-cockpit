# Superagent Plan 7 — workflow files, a troubleshooting workflow, and in-place folders

_2026-11-17 · branch `feature/superagent` @ `b54b2c6` · builds on [the superagent design, rev 3](2026-11-03-superagent-design.md), [Plan 5](2026-11-06-superagent-p5-brainstorm-design.md) and [Plan 6](2026-11-17-superagent-p6-view-design.md)_

Labels: **[Decided]** = decided by the user in the 2026-11-17 brainstorm. **[Author's call]** = chosen by the design author; the user may override. Unlabelled = consequence of the two, or already in earlier designs. Where this document and earlier ones disagree, this document wins for Plan 7.

## Intent

The user ran the first real job from the Superagent tab: a bug investigation in the FallGuys Unity repo (an ADO work item plus two Sentry issues). Two things got in the way.

1. **Provisioning is far too slow for a big repo.** Every job runs `git worktree add`, which wrote out ~52 GB (43.8 GB of it LFS content, 34,178 LFS files) at ~14 MB/s, about an hour before the first worker started. A fresh worktree also has no Unity `Library/`, so any worker that opens the project re-imports it from scratch. The user wants, as a per-job option, to run the job in a folder they already have instead of creating a worktree every time. **[Decided]**
2. **Bug fixing does not fit the feature flow.** brainstorm → spec → spec-review → plan → plan-review → implement → test → accept is a feature process. For a bug the user wants a troubleshooting flow built on the systematic-debugging method (reproduce, find the root cause with evidence, test one hypothesis, then fix with a failing test first and verify), chosen per job. **[Decided]**

The user then asked that flows be user-definable so people can build their own (for example without Superpowers), and that this be folded into this plan rather than built later. **[Decided]** Flows are therefore **workflow files**: data, not code. Feature and Troubleshooting ship as the first two, so the troubleshooting workflow is the proof that the format works.

## Goals

1. **Workflow files.** A job's pipeline comes from a JSON workflow file chosen in the New job form. Cockpit ships `feature` (today's default pipeline, unchanged in behaviour) and `troubleshooting`. Users add their own globally or per project. **[Decided: files, JSON]**
2. **A troubleshooting workflow** that reproduces the bug, writes a diagnosis, has the diagnosis reviewed, fixes with a failing test first, verifies, and ends at accept. It runs straight through; the diagnosis gets no human checkpoint. **[Decided: option B]** It stops for the user in the cases every workflow already has (see "When a troubleshooting job stops"), the two that matter here being a bug it cannot reproduce and a rejected root cause the verifier confirms. A rejection the verifier does not confirm moves on to the fix, as review loops do today.
3. **In-place folders.** Per folder on the New job form, "Use this folder directly (no new worktree)". The job creates its branch in that folder with `git switch -c` and runs its workers there. **[Decided]** Allowed for the primary and for additional folders. **[Author's call]**
4. Everything existing keeps working: jobs created before Plan 7 resume and finish exactly as before (their models are frozen in `job-created`); `createJob({ fixture })` and the milestone fixtures keep working for tests and manual probes. The one deliberate change to new Feature jobs is the default models (see "Default models per role").

## Non-goals

- **YAML or script workflows.** JSON only: YAML needs a new dependency (Cockpit has two: the Agent SDK and `ws`) and a hand-rolled parser would be fragile; a script would run arbitrary code inside Cockpit, which holds session tokens and decides when paid workers launch, and could not be validated up front or resumed after a restart. **[Decided: JSON]**
- **New phase kinds.** Workflows compose the five existing kinds (`author`, `brainstorm`, `review`, `per-task`, `human`). A new kind needs engine code and is a later plan.
- **A workflow editor in the UI.** Files are edited by hand; the form only lists and validates them.
- **Reusing old job worktrees** (pooling) and worktree removal. Backlog.
- **A provisioning progress indicator.** Backlog (the view shows only "provisioning" during a long `worktree add`).
- **Switching an in-place folder back** to its original branch after the job. The folder stays on the job's branch for review.
- Everything Plan 6 deferred stays deferred.

## Anti-goals (a failure even if it works)

- **Any paid run in tests.** Tests stay no-network, no real CLI, no real model, as in every earlier plan.
- **Touching the user's folder when a check fails.** An in-place folder that fails any check is refused before `job-created`, with nothing switched, created or written in it.
- **Destructive git in a user's folder.** Superagent never runs `reset`, `clean`, `stash`, `checkout -- .`, `switch --discard-changes` or a forced switch in an in-place folder. It creates one branch with `git switch -c` and otherwise leaves the folder's git state to the workers and the user.
- **An existing job changing behaviour.** A job's workflow is frozen into its `job-created` event; editing or deleting a workflow file never changes a job already created.
- **A workflow file making Cockpit unusable.** A broken file is listed as invalid with its errors; it never stops boot, the view, or the other workflows.

## Constraints

- Plain ESM, no build step, no new npm dependencies, no `package.json` change. `src/session-registry.js` and `src/shutdown.js` are not modified.
- All Plan 6 global constraints carry over (commits, staging, LF, no `Co-Authored-By`, `COCKPIT_HOME` in tests, temp repos through `initRepo` with `core.fsmonitor false`).
- Exact copy from Plan 6 stays verbatim.

## Approaches considered

1. **Workflow files, with feature and troubleshooting shipped as files (chosen).** The engine already runs non-default shapes (the milestone fixtures pass validation with the order check off, `src/superagent/config.js:298-301`), and phase or artifact names are hard-coded in only a handful of places. Cost: a validator, a loader, per-job artifact paths, and replacing the few name checks with phase properties. **[Decided]**
2. **A second hard-coded pipeline** (troubleshooting next to the default). Less code now, but user-defined flows would later rebuild it. Folded into 1 at the user's request.
3. **Squeeze troubleshooting into the feature pipeline** (drop brainstorm, rename spec → diagnosis, plan → fix plan). Least code, but wrong artifact names, a forced tasks list and wrong labels in the view. Rejected.

For in-place folders there was one sensible way (below); a pooled-worktree approach (reset an old job's worktree to the new base) is faster than a fresh worktree but still slower than in place and needs worktree lifecycle rules that do not exist. Backlog.

## Workflow files

### Where they live and which one wins

Three sources, listed in the New job form in this order, by `id`: **[Author's call]**

| Source | Location | Trust |
|---|---|---|
| Built-in | `<cockpit>/workflows/*.json` (alongside `prompts/superagent/`) | shipped with Cockpit |
| Global | `<superagent root>/workflows/*.json` (`~/.prompt-cockpit/superagent/workflows/`, redirected by `COCKPIT_HOME`) | the user's own |
| Project | `<primary folder>/.superpowers/superagent/workflows/*.json` | the repo's; same trust as today's per-project prompt overrides (`<primary folder>/.superpowers/superagent/prompts/`, `src/superagent/prompts.js:27-29`) |

"Primary folder" is the folder exactly as chosen (the resolved origin), which is also the root today's prompt overrides are read from (`index.js:602-604`, `runner.js:81`); project workflows use the same root so the two can never disagree when the user picks a subfolder of a repo. **[Author's call]**

A later source with the same `id` overrides an earlier one (project > global > built-in), and the form shows where the chosen one came from. The file name is not the id; the `id` field is. Loader contract: **[Author's call]**

- `id` matches today's phase-id pattern (`/^[a-z0-9][a-z0-9-]{0,23}$/i`); `config-pipeline` is reserved (a file using it is invalid).
- Files in a directory are read in name order; only `*.json` directly in the directory.
- Two files in the **same** source with the same id are both listed invalid (`duplicate id`), and that id is unavailable from that source.
- A file that is not parseable JSON, or has no valid `id`, is listed invalid under its file name and shadows nothing.
- An **invalid** file with a valid `id` still shadows the same id from lower sources: it is listed invalid and the lower one is not silently used, so a broken override is visible rather than replaced by the built-in.
- A configured default (`workflow` in `config.json`) that is unknown or invalid is not used: the form falls back to `feature` and shows why. The project list depends on the primary folder, so the form refreshes the list when the primary folder changes.

### Format

```json
{
  "format": 1,
  "id": "troubleshooting",
  "name": "Troubleshooting",
  "description": "Reproduce, find the root cause, fix with a failing test, verify.",
  "artifacts": {
    "diagnosis": "docs/superpowers/jobs/{slug}/diagnosis.md",
    "tasks":     "docs/superpowers/jobs/{slug}/tasks.json",
    "testReport":"docs/superpowers/jobs/{slug}/test-report.md"
  },
  "phases": [
    { "phase": "investigate",       "kind": "author",   "role": "investigator",       "inputs": ["idea"], "outputs": ["diagnosis", "tasks"] },
    { "phase": "diagnosis-review",  "kind": "review",   "role": "diagnosis-reviewer", "author": "investigator", "target": "diagnosis", "inputs": ["tasks"], "maxRounds": 3 },
    { "phase": "fix",               "kind": "per-task", "role": "fixer", "taskReview": "fix-reviewer", "inputs": ["diagnosis", "tasks"] },
    { "phase": "verify",            "kind": "author",   "role": "verifier-tester",    "inputs": ["diagnosis", "tasks"], "outputs": ["testReport"], "test": true },
    { "phase": "accept",            "kind": "human",    "inputs": ["testReport"] }
  ],
  "roles": {
    "investigator":       { "prompt": "investigator.md", "model": "claude-opus-5-5",   "maxTurns": 80 },
    "diagnosis-reviewer": { "prompt": "diagnosis-reviewer.md", "model": "claude-opus-5-5", "maxTurns": 40 },
    "fixer":              { "prompt": "fixer.md", "model": "claude-sonnet-5-5", "maxTurns": 80, "alternate": "claude-opus-5-5" },
    "fix-reviewer":       { "prompt": "fix-reviewer.md", "model": "claude-sonnet-5-5", "maxTurns": 80 },
    "verifier-tester":    { "prompt": "verifier-tester.md", "model": "claude-sonnet-5-5", "maxTurns": 80 }
  }
}
```

(Illustrative; the builder fixes exact role names, models and turn counts for the shipped troubleshooting file.)

- **`phases`** uses today's phase shape (`src/superagent/config.js:50-62`) unchanged, so the existing per-phase validation applies.
- **`artifacts`** maps every artifact key the phases use to a path relative to the primary repo, with `{slug}` and `{date}` (the job's `createdDate`) as the only placeholders. Paths must stay inside the repo (no absolute paths, no `..` segments) and must be unique. Review, verify and per-task report paths (`reviewPaths`, `src/superagent/results.js:64-78`) stay as they are, under `docs/superpowers/jobs/{slug}/`.
- **`roles`** gives each role its prompt file (relative to the workflow file's own directory) and its model defaults. **Prompt lookup order, first found wins:** (1) the project override `<primary folder>/.superpowers/superagent/prompts/<role>.md` (today's mechanism, unchanged, so Feature behaves as before); (2) the workflow file's `prompt`; (3) the built-in template `prompts/superagent/<role>.md`. The shipped troubleshooting prompts live in `prompts/superagent/` like the feature ones, so any custom workflow can reuse every shipped role by name with no `prompt` field. `hasTemplate` and the validator use the same order. **[Author's call]**
- **Model lookup order, later wins:** built-in defaults (`defaultConfig().models`) < the workflow file's `roles.<role>` model fields < `config.json` `defaults.models` < `config.json` `projects[<path>].models`. Today's `resolveProjectConfig` (`config.js:317-326`) merges built-ins and the file in one step, so the workflow layer needs a slot inserted between them; that is a change to the merge, not a reuse of it. The `verifier`, `stand-in` and `router` roles stay engine roles and come from config as today.
- **`format`** is `1`. An unknown format is invalid.

### What the engine treats specially, and how a workflow says it

Today some behaviour is tied to phase ids or artifact names. Plan 7 ties it to properties instead, with the old names as what the shipped `feature` file declares: **[Author's call]**

| Today | Plan 7 |
|---|---|
| Test-failure routing applies to the phase whose id is `test` and routes into the phase whose id is `implement` (`src/superagent/sequencer.js:196, 338`; `src/superagent/store.js:171`) | An `author` phase with `"test": true` is a test phase: its failed findings route as fix tasks into the workflow's single `per-task` phase, if it has one. `purpose: 'test'` follows the flag. |
| `tasks` is parsed and validated as the task list for the `per-task` phase | Unchanged: the artifact key `tasks` is reserved for the task list, must be a `.json` path, and a workflow with a `per-task` phase must have an earlier phase that outputs `tasks`. |
| The brainstorm writes `brief`, and the spec of a brainstorming job must carry both brief headings (`src/superagent/results.js:628-645`) | Unchanged for `brainstorm` phases: a brainstorm phase outputs `brief`; the headings check applies to `brief` and to the first `author` output that takes `brief` as an input. |
| The artifact table is fixed (`artifactPaths`, `results.js:52-60`), and the view's artifact list knows five fixed keys (`view-model.js:5`, and `brief` picked from inputs at `:63`) | The job carries its workflow's `artifacts` map; `artifactPaths(job)` returns it. The view lists whatever keys the job's phases output. Artifact reads keep real-path containment (Plan 6). |
| The brainstormer's deny message is chosen by the role name `brainstormer` (`prompts.js:15`) | Chosen by the phase kind `brainstorm`, whatever its role is called. |
| "Ready to try" shows `testReport` and `brief` inline (`public/superagent-view.js:487-489`) | Shows the final `human` phase's `inputs` (for Feature that is `testReport`, as today; for Troubleshooting `testReport`). The brief stays shown when the job has one. |

A test phase's routed failures go back into the `per-task` phase, and the store re-enters only that phase (`store.js:170-177`); so the validator requires the `test: true` phase to come **directly** after the `per-task` phase, with nothing in between that a revisit would skip. **[Author's call]**

### Validation

A workflow is valid when, besides today's per-phase checks:

- phase ids are unique and match today's id pattern; every `inputs` entry is `idea` or an output of an earlier phase; every output and review `target` is a key in `artifacts`;
- every review `target` has exactly one earlier `author` phase that outputs it, and the review's `author` equals that phase's role (revision rounds pick the first author producing the target, `results.js:107`, so an ambiguous or mismatched producer would give the fix worker the wrong outputs);
- a `brainstorm` phase outputs exactly `brief`; `test: true` is allowed only on `author` phases;
- after substituting `{slug}` and `{date}` for a sample job and normalising (case- and separator-insensitive on Windows), artifact paths are unique and do not fall inside the reserved namespaces: `.git/`, `.superpowers/superagent/` (ledger, prompts, workflows), and the generated review and report paths under `docs/superpowers/jobs/{slug}/reviews/` and `docs/superpowers/jobs/{slug}/tasks/` (`results.js:64-78`);
- every role used has a model (from the file or from config) and a prompt (from the file or a built-in template of that name);
- at most one `per-task` phase and at most one `brainstorm` phase; a `brainstorm` phase, if present, is the first phase (today's rule, `config.js:209-211`); at most one `test: true` phase, and if the workflow has a `per-task` phase the `test: true` phase comes directly after it;
- the last phase is `human`;
- `artifacts` paths obey the rules above.

`checkComposition` (the "v1 pipelines must contain the phases …" rule, `config.js:108-133`) is retired for workflow-based jobs; the shipped `feature` file passes the new validator and produces exactly today's pipeline.

Validation runs when the list is built (invalid files are listed, greyed out, with their errors) and again in `createJob` (a workflow that became invalid is refused with `ERR_INVALID_WORKFLOW` before `job-created`).

### What a job records

`job-created` gains `workflow: { id, name, source, file }`, `artifacts` (the resolved map) and `prompts` (per role, the absolute path of the workflow file's `prompt` for that role, or `null` when the role uses the built-in), next to the `pipeline` and `models` it already embeds. The workflow file is never read again for that job: a restart resolves every prompt from the recorded `prompts` map. Prompt **text** is not frozen: it is read at launch, in the lookup order above (project override > recorded workflow prompt > built-in), as today's overrides are. **[Author's call]** (Freezing text would protect a running job from an edited prompt, but today's overrides are not frozen either, and the user edits prompts to fix a job.) If a recorded workflow prompt file has disappeared at launch, the attempt is not launched and the job goes `stuck` with `why: 'prompt-missing'` and the path; it does not silently fall back to the built-in.

Jobs created before Plan 7 have no `workflow` or `artifacts`; they read as `feature` with today's fixed artifact table, and their phase-id-based test routing keeps working because the shipped `feature` file declares `test: true` on its `test` phase and the store treats a job without `workflow` as the old shape.

### Configuration and defaults

- `config.json` gains `defaults.workflow` (and per-project `projects[<path>].workflow`): the id pre-selected in the form. Built-in default: `feature`. **[Author's call]**
- `config.json`'s `pipeline` key keeps working for one plan as an implicit workflow with id `config-pipeline`, named `custom (config.json)`, validated by today's composition rule, so nobody's existing config breaks; the docs mark it deprecated in favour of a global workflow file. It appears only when the **raw** file sets `pipeline` (in `defaults` or in the primary folder's `projects` entry; `defaultConfig()` always carries one, so presence is detected before the merge). It is listed next to `feature`, not instead of it, and it is the pre-selected default unless `workflow` is set in the same or a more specific scope, so an existing user's jobs keep their pipeline. **[Author's call]**

## The troubleshooting workflow

Shipped as `workflows/troubleshooting.json` with its own role prompts. **[Decided: shape B]**

1. **investigate** (`author`): read the idea (it may hold ADO and Sentry links; the worker uses whatever tools its session has, such as the user's MCP servers and agents like fg-unity-agent). Reproduce the bug. Write **`diagnosis`**: reproduction steps, evidence, the root cause, and the hypothesis tested with its result. Also write **`tasks`**: normally one task, "fix root cause X", with acceptance criteria that name the failing test to write and the reproduction to re-run. A worker that cannot reproduce the bug returns `status: blocked` with a question, which reaches the user through the existing needs-you question path (`answerQuestion` resumes it). **[Author's call: reuse the question path rather than a new stop reason]**
2. **diagnosis-review** (`review`, up to 3 rounds, with the existing verifier): a reviewer challenges the root cause against the evidence. At the round cap today's review-loop outcome applies unchanged (`capOutcome`, `src/superagent/sequencer.js:91-115`): no blocker left → the phase completes; contested blockers go to the verifier; a blocker the verifier confirms becomes an answerable `question` to the user (answering it earns one extra round, Plan 5); none confirmed → the phase completes as `disputed-not-verified` and the fix proceeds. No new engine behaviour. **[Author's call]**
3. **fix** (`per-task`, with task review): the fixer writes a failing test that shows the bug, makes one fix aimed at the root cause, and verifies. The fix reviewer checks that the test fails without the fix and that the fix targets the diagnosed cause rather than a symptom. Existing task-review rounds (`limits.taskReviewRounds`, default 2) and alternate-model retries apply. The fix phase takes `diagnosis` as an input, so the fixer and the fix reviewer get the diagnosed cause and the reproduction directly, including on fix tasks generated from a failed verify.
4. **verify** (`author`, `test: true`): re-run the reproduction and the test suite; write `testReport`. Failures route back into **fix** as fix tasks, as today's test phase does.
5. **accept** (`human`): the user reviews the diagnosis, the fix and the report.

**When a troubleshooting job stops.** Exactly the existing outcomes, unchanged: an answerable `question` (a worker that blocks, such as the investigator unable to reproduce, or a verifier-confirmed blocker at a review or task-review cap) and the terminal `stuck` cases (attempt cap, repeated errors, question cap, invalid tasks, and the new `prompt-missing`), then `ready-to-try` at accept; plus the self-clearing `folder-changed` notice for in-place folders (below). No new stop logic. **[Author's call]**

**Prompts.** The troubleshooting prompts carry the method in their own words (Phase 1 root cause investigation with evidence, Phase 2 pattern analysis, Phase 3 a single hypothesis tested minimally, Phase 4 failing test, one fix, verification; three failed fixes means question the architecture), so they work without Superpowers. The three-fix rule is **advisory** in the prompts: the engine has no counter for it (task-review rounds count review/fix exchanges, and verify failures become fresh fix tasks), so the prompts tell the fixer to read the job's earlier fix reports and, on a third failed approach, return `status: blocked` with a question instead of trying a fourth. They also tell the worker to invoke `superpowers:systematic-debugging` (investigator), `superpowers:test-driven-development` (fixer) and `superpowers:verification-before-completion` (verifier-tester) when those skills are available in its session. **[Author's call]** Whether worker sessions load the user's plugins is unverified; the prompts must not depend on it.

**Rename of the feature workflow.** The default flow is labelled **Feature** in the form; its id is `feature`. Behaviour is unchanged.

## Default models per role

The user asked for sensible defaults instead of Opus nearly everywhere. Today's built-ins (`src/superagent/config.js:63-76`) put seven roles on Opus (stand-in, brainstormer, spec-writer, planner, spec-reviewer, plan-reviewer, verifier), the implementer, tester, task reviewer and triage on Sonnet, and the router on Haiku. Rule of thumb: **Opus where a wrong call wastes the rest of the run** (writing the brief, spec, plan or diagnosis; settling disputes), **Sonnet for bounded work against a written target** (reviews, implementing tasks, running tests, answering from the project), **Haiku for the router**. Spec and plan reviewers stay on Opus: they judge feasibility against the real repository (`prompts/superagent/spec-reviewer.md:6`, `plan-reviewer.md:6`), and the verifier only re-checks blockers a reviewer raised and the author disputed after the final round (`sequencer.js:125-145`), so it cannot catch a blocker the reviewer missed (Codex design review). **[Author's call, at the user's request]**

| Workflow | Role | Model | Was | Why |
|---|---|---|---|---|
| Feature | brainstormer | Opus | Opus | the brief shapes everything after it |
| Feature | stand-in | **Sonnet** | Opus | answers questions read-only from the idea and project, 8 turns |
| Feature | spec-writer | Opus | Opus | design judgement |
| Feature | spec-reviewer | Opus | Opus | judges feasibility against the repo; the verifier cannot catch what it misses |
| Feature | planner | Opus | Opus | task split and order decide the implementation |
| Feature | plan-reviewer | Opus | Opus | same as spec-reviewer |
| Feature | implementer | Sonnet (alternate Opus) | same | unchanged; the Opus alternate takes over a stuck task |
| Feature | task-reviewer | Sonnet | Sonnet | unchanged |
| Feature | tester | Sonnet | Sonnet | unchanged |
| Engine | verifier | Opus | Opus | settles reviewer-vs-author disputes; rarely runs |
| Engine | router | Haiku | Haiku | unchanged (allowlisted, single turn) |
| Engine | triage | Sonnet | Sonnet | unchanged (not built yet) |
| Troubleshooting | investigator | Opus | — | finding the root cause is the hard part |
| Troubleshooting | diagnosis-reviewer | Opus | — | a wrong root cause wastes the fix and the verify; this review is the main guard (option B), so it is the one review kept on Opus |
| Troubleshooting | fixer | Sonnet (alternate Opus) | — | one targeted fix against a written diagnosis |
| Troubleshooting | fix-reviewer | Sonnet | — | checks the test fails without the fix and the fix targets the cause |
| Troubleshooting | verifier-tester | Sonnet | — | re-runs the reproduction and the suite |

Net effect on Feature: one role (stand-in) moves from Opus to Sonnet. This is the one deliberate behaviour change to the Feature workflow (Goal 4 otherwise holds). `config.json` `models` still overrides any role per user or project. Turn counts stay as today; the troubleshooting roles take the turn counts of their nearest Feature counterparts (investigator 80, diagnosis-reviewer 40, fixer, fix-reviewer and verifier-tester 80). Fable 5.2 is not used as a default: its fit for these roles has not been compared.

## In-place folders

### The option

Each folder row in the New job form (primary and every additional folder) gets a checkbox **Use this folder directly (no new worktree)**, off by default. **[Decided]** Under it, when checked, a one-line note: "The job switches this folder to its own branch and works there. Don't work in this folder while the job runs." **[Author's call]**

The repo entry in `job-created` gains `inPlace: true`, and its `worktree` is the folder's repo top level instead of `<superagent root>/worktrees/<slug>/<id>`.

### Checks, before `job-created`

**Reservation.** Checks alone race: two creates can both pass before either appends `job-created`, and today's serialisation is per job id, after preflight (`index.js:610, 631`). So the supervisor keeps an in-memory **folder reservation** keyed by the normalised repo top level, taken synchronously at the start of `createJob`'s preflight for every folder of the job (in place or worktree origin) and held until that job is finished (or released at once if `createJob` refuses). An in-place reservation excludes every other reservation on that top level; worktree-origin reservations exclude only in-place ones, so two worktree jobs on one origin still coexist. On boot the reservations are rebuilt from unfinished jobs before the heartbeat starts. A conflicting reservation is `ERR_FOLDER_IN_USE`. **[Author's call]**

Run inside `createJob`'s existing folder preflight (Plan 6, `ERR_DUPLICATE_REPO`), for each in-place folder; any failure refuses the job with nothing touched:

| Check | Error code |
|---|---|
| Not a git repo / no commits (existing checks) | `ERR_NOT_GIT_REPO` / `ERR_NO_COMMITS` |
| HEAD is detached, or a rebase, merge, cherry-pick or bisect is in progress | `ERR_FOLDER_BUSY_GIT` |
| ~~`git status --porcelain` (untracked included, ignored excluded) is not empty; the error lists up to 10 paths~~ `git status` cannot be read (amended 2026-11-18, see below) | `ERR_FOLDER_DIRTY` |
| Another job that is not finished (any state other than done, stopped, failed) uses the same repo top level, in place **or as the origin of a worktree** | `ERR_FOLDER_IN_USE` |
| The folder's current branch is a `superagent/*` branch (left there by an earlier in-place job) | `ERR_FOLDER_ON_JOB_BRANCH` ("switch this folder back to your own branch first") |
| `superagent/<slug>` already exists (existing check) | `ERR_BRANCH_EXISTS` |

Untracked files count as dirty because workers stage and commit, and the user's untracked files would end up in the job's commits. **[Author's call]**

**Amendment (2026-11-18, user decision).** A folder with uncommitted or untracked changes is no longer refused. `checkInPlace` returns them as `pending`, `job-created` records them on the in-place repo as `pendingChanges: { paths, total }` (at most 200 paths kept), the worker card carries them, and `contract.md` tells workers to stage only their own files by explicit path (never `add -A`/`add .`/`add -u`/`commit -a`), never stage, commit, edit, revert or delete a pending path, not to mistake them for an earlier attempt's leftovers in recovery, and to publish `blocked` if the task needs one of those files changed. Like the other in-place rules this is prompt-only. The pre-switch recheck no longer requires a clean status. Comparisons of top levels use the same normalisation as `ERR_DUPLICATE_REPO`.

**Base commit.** Both a worktree and an in-place branch start from the folder's current HEAD (`worktree.js:72, 89`). So a new job must never start from another job's branch without the user choosing it: an in-place folder still on `superagent/*` is refused (above), and a **worktree** job whose origin is the top level of a repo that an unfinished in-place job is using is refused with `ERR_FOLDER_IN_USE` too, since that origin's HEAD is the running job's branch. Two worktree jobs on one origin keep coexisting as today. **[Author's call]**

### Provisioning

For an in-place repo, `provision()` runs `git switch -c superagent/<slug>` in the folder instead of `git worktree add`. It then creates the ledger folder, but **not** the `*` `.gitignore` a worktree gets (`src/superagent/worktree.js:92-94`): in the user's real folder that file would be permanent, would hide new project workflow and prompt files under `.superpowers/superagent/` from git, and would dirty the folder if the repo tracks one. Instead it adds one line, ignoring the job's own ledger directory (`/.superpowers/superagent/<jobId>/`), to the repo's local exclude file (`git rev-parse --git-path info/exclude`), which is never committed or shared; the line is added once and never removed. The local Claude settings copy is skipped, since the folder already is the origin (`settingsCopy: 'in-place'`). **[Author's call]** `baseSha` is the folder's HEAD at switch time. The `worktree-created` event carries `inPlace: true`.

Provisioning can start long after the checks (a slow worktree for an earlier folder of the same job), so **immediately before the switch** the in-place checks run again (clean status, no git operation in progress, current branch not `superagent/*`, and HEAD equal to the HEAD seen at `createJob`). Any difference fails the job as provisioning failures do today, with nothing switched. A switch at the same commit rewrites no files and takes seconds; if it fails anyway, the job fails and nothing else is attempted in the folder.

**Ignore rule, verified.** The exclude file path comes from `git rev-parse --git-path info/exclude` run in the folder, resolved against the folder. The rule is appended preserving existing content (a newline is added first if the file does not end with one). Then `git check-ignore -q` on a path inside the job's ledger directory must succeed; if it does not (a tracked path there, or a nested `.gitignore` negation), the job fails before any worker launches. **[Author's call]**

### While the job runs, and after

- Workers run with the folder as their cwd. Attempt directories live in the folder's `.superpowers/superagent/`, as in a worktree.
- The Windows path-length check (`ERR_PATH_TOO_LONG`, `src/superagent/index.js:565`) measures from the in-place folder, not from the worktrees root.
- `listOrphanWorktrees` ignores in-place repos; they are not superagent worktrees.
- Stop, accept, failure and restart leave the folder on `superagent/<slug>`. Reconcile after a restart judges unfinished attempts as today.
- **In-place safety gate.** Before every worker launch (including the first after a restart), an in-place repo must still be on `superagent/<slug>`, have no git operation in progress, and have `baseSha` as an ancestor of HEAD. Uncommitted changes are allowed (an interrupted worker leaves them, and `RECOVERY_NOTE` already tells the next attempt to check git status). If the gate fails, nothing is launched, switched or cleaned: the job shows `needs-you` with `why: 'folder-changed'` and what was found ("this folder is on `main`; switch it back to `superagent/<slug>` to continue"). The gate is re-checked every heartbeat and the job continues on its own once the folder is back. It is not a terminal `stuck`, since Retry on stuck does not exist yet. **[Author's call]**
- The view shows `in place` next to the branch and, on a finished job, "This folder is still on the job's branch."
- The user's own Cockpit sessions in that folder are not detected (the note under the checkbox warns). **[Author's call]**

## The view

- **New job form:** a **Workflow** select listing every workflow (built-in, global, project) with its name, description and source; invalid ones greyed out with their first error on hover or below the select. Default selection from `config.json`'s `workflow`, else `feature`. Each folder row gains the in-place checkbox. Creation errors show inline as today, with the new codes.
- **Job list and detail:** the workflow's name next to the phase; the phase chips come from the job's own pipeline (already true); `in place` next to each in-place branch.
- **Artifacts:** listed by the job's own artifact keys, labelled by key.

Exact layout and copy beyond the strings above are left to the builder, within Cockpit's existing CSS tokens.

## Routes

- `GET /api/superagent/workflows?primary=<folder>` returns `{ workflows: [{ id, name, description, source, valid, errors }], default }`. Admitted like the other superagent read routes (503 while not ready, 409 not-owner).
- `POST /api/superagent/jobs` accepts `workflow` (id) and, per folder, `inPlace` (boolean). `fixture` stays a library option, not a route field. A missing `workflow` uses the default.

## Testing

Unit-tested, no network, no real model, under a temp `COCKPIT_HOME`, temp repos through `initRepo`:

- Validator: the shipped `feature` file produces exactly today's default pipeline; the shipped `troubleshooting` file is valid; each rule above has a refusing case; a broken file is listed as invalid and does not affect the others; source precedence by id.
- Engine: a scripted-worker run of the troubleshooting workflow through investigate → diagnosis-review → fix → verify (with one routed failure back into fix) → accept, using the existing scripted-worker harness; a job created before Plan 7 (no `workflow`, no `artifacts`) resumes and routes test failures as before.
- In-place: each check refuses with its code and leaves the folder byte-for-byte unchanged (branch list, HEAD, status, no `.superpowers/` created); a clean folder gets `superagent/<slug>` at the same HEAD with no tracked file rewritten, no `.gitignore` written, and `git status --porcelain` still empty after provisioning; two in-place jobs on one folder are refused; a folder left on `superagent/*` is refused; a worktree job on a repo with an unfinished in-place job is refused, and two worktree jobs on one origin still coexist; orphan listing skips in-place repos; the path-length check measures from the folder.
- In-place races and drift: two overlapping `createJob` calls on one folder (one refused `ERR_FOLDER_IN_USE`); reservations rebuilt on boot; the folder changed between checks and switch (job fails, nothing switched); the exclude rule appended with a newline boundary and `check-ignore` verified, and a nested negation making it fail before any launch; the safety gate (folder switched away → `folder-changed`, nothing launched; switched back → continues on the next heartbeat; uncommitted changes alone do not trip it).
- Workflow loader contract: same-source duplicate ids, unparseable files, an invalid override shadowing a valid built-in, an unknown configured default falling back to `feature`; validation of review producers, brainstorm outputs, `test` on non-author phases and reserved artifact namespaces; a recorded workflow prompt deleted after creation → `prompt-missing`, and an edited workflow file not changing an existing job after a restart.
- Workflows: prompt lookup order (project override > workflow `prompt` > built-in) and model lookup order; a `test: true` phase not directly after the `per-task` phase is refused; the brainstorm deny message follows the phase kind; a raw `config.json` `pipeline` appears as `config-pipeline` and is pre-selected unless `workflow` is set.
- Routes: workflows listing (including project source and invalid files), create with `workflow` and `inPlace`, the new error codes.

Hand-verified with Playwright under a temp `COCKPIT_HOME`, as in Plan 6, with the no-launch fixture proof before any Cockpit runs: the workflow select, the in-place checkbox and its errors, the `in place` marker. Never clicking Send and never creating a job that passes the checks (that would launch a paid worker).

No real-model run in this plan. A real troubleshooting run on FallGuys is the user's to start, after the plan.

## Left to the builder

Module split (for example a `src/superagent/workflows.js` loader and validator); exact role names, models and turn counts in the shipped troubleshooting file; prompt wording within the method above; the exact store change that makes pre-Plan-7 jobs read as `feature`; route field names beyond those above; form layout; test file layout.
