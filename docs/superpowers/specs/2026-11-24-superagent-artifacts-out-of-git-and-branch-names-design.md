# Superagent: job artifacts out of git, and a properly named branch at accept

Date: 2026-11-24. Branch: `feature/superagent`.

## Intent

A finished troubleshooting job (5f2d3c36, ADO 171558) left the FallGuys job branch with seven commits for a 4-line fix: six of them only added job documents (`diagnosis.md`, `tasks.json`, review files, the task report, the test report) under `docs/superpowers/jobs/<slug>/`, and the fix commit itself carried the task report. The operator had to rebuild the branch by hand before it could go anywhere. The branch was also called `superagent/investigate-this-ado-issue-https-dev-azu-5f2d3c36`, while the team convention for bug fixes is `bugfix/<bug_number>-<small_description>` (fall-guys-dev `skills/ado-azure-work-items-read/SKILL.md:26-27`; nothing in the FallGuys repo documents it).

The operator wants:

1. Superagent never commits its job artifacts to the project repo.
2. Superagent never commits tests either, in any project, unless the user asks for it. Tests are still written and run to prove the fix (red before, green after), but only the fix itself is committed.
3. The branch a job hands over follows the project's naming convention, e.g. `bugfix/171558-fix-StopBypassingNetAuthority-exception`.

The 171558 branch was rebuilt by hand to match: `e098cabd1b3` holds only the `FallGuyCarryObject.cs` change (the old commits are kept as `backup/superagent-5f2d3c36`).

## Goals

1. **Artifacts live in the job's ledger, not in git.** Every artifact a job writes (workflow artifacts, review, response, verify and report files) is a file under the job's ledger folder in the primary worktree, `.superpowers/superagent/<jobId>/artifacts/`, which is already git-ignored (worktree jobs: `.superpowers/superagent/.gitignore` with `*`, `worktree.js:128-130`; in-place jobs: the `info/exclude` line, `inplace.js:102-117`, verified with `check-ignore`).
2. **Validation no longer requires an artifact commit.** A required output must exist and be non-empty when the result is judged; the engine records its SHA-256 on `attempt-ended` so a later change is detectable. `evidence.commits` is only for code.
3. **No artifact can slip into a commit.** A listed commit that touches any path under `.superpowers/` is an invalid result (`commit includes superagent files: <path>`).
4. **Tests are evidence, not deliverables.** Unless the job commits tests (see C), a worker saves each test it wrote, with its red and green runs, as an artifact and removes it from the repo before committing; a listed commit that touches a test path is an invalid result.
5. **Rename at accept.** Accept takes an optional final branch name, pre-filled in the view from a per-project, per-workflow template, and renames the job branch in every repo before `job-accepted` is appended.

## Non-goals

- No merge, push or PR creation at accept (unchanged: "Nothing is merged or pushed").
- No change to the internal job branch during the job: it stays `superagent/<slug>`, so `refuseJobBranch` (`inplace.js:66-72`), `listOrphanWorktrees` (`worktree.js:271`), `checkGate` (`inplace.js:153-167`) and `resolveCommits` (`results.js:505`) keep working unchanged.
- No migration of jobs created before this change: they keep committed artifacts (see *Compatibility*).
- No cleanup of the ledger folder in the project (unchanged; it is git-ignored and archived on accept and stop).

## Design

### A. Artifacts in the ledger

**Paths.** A new job records `artifactRoot: 'ledger'` on `job-created`. For such a job every artifact path is resolved as `.superpowers/superagent/<jobId>/artifacts/<declared path>`, relative to the primary worktree, so the job card, readers and the view keep using worktree-relative paths:

- `substituteArtifacts` (`workflows.js:54-56`) prefixes the declared paths at `job-created` (`index.js:910`).
- `reviewPaths` (`results.js:66-81`) builds review, response, verify and report paths under the same root (`.../artifacts/reviews/<phase>-r<n>.md`, `.../artifacts/tasks/<task>-report.md`).
- Built-in workflows drop the `docs/superpowers/jobs/{slug}/` prefix: `feature.json` and `troubleshooting.json` declare `diagnosis.md`, `tasks.json`, `test-report.md`, etc. `{slug}`/`{date}` stay allowed.
- `checkArtifacts` (`workflows.js:108-144`): for a declared path the reserved namespaces become `reviews/` and `tasks/` (relative to the artifact root); `..` segments and absolute paths stay rejected. A project workflow that still declares `docs/superpowers/jobs/{slug}/x.md` stays valid; it just lands under the artifact root.

**Validation** (`results.js`):

- `outputErrors` (556-606): keep "exists and non-empty"; drop the `diff-tree` "committed by a listed commit" check and the `status --porcelain` "changed after its commit" check for ledger jobs. Return the SHA-256 of each required output; the runner records them on `attempt-ended` as `outputs: { <path>: <sha256> }`.
- `reviseErrors` (528-554): keep "exists and non-empty"; drop the uncommitted-changes check for ledger jobs.
- `taskEvidenceErrors` (444-466): the primary commit is no longer allowed "because the primary repo carries the report file"; a task needs at least one commit in one of its repos, as today (459), and the verify check (462).
- Author and review purposes no longer need any commit (the artifact was their only change). `evidence.commits` may be empty or absent for them.
- New check, for every job: each listed commit, `git diff-tree --no-commit-id --name-only -r <sha>`, must not touch `.superpowers/`.
- `tasksFileErrors` (610-620), `loadTasksStep` (`index.js:321-339`) and the headings check (`results.js:633-649`) already read the worktree file; they get the ledger path from `artifactPaths(job)` with no other change.

**Readers.** No change beyond the paths: the job card passes paths (`prompts.js:163-207`); reviewer prompts say "read `target`"; `artifacts.js` reads the worktree file (the ledger is inside the primary worktree, so real-path containment holds) and falls back to the snapshot; accounting snapshots, retrospectives and `archiveLedger` (which now also carries the artifacts) are unchanged.

**Prompts.** `contract.md`'s "Committing outputs" section (28-34) becomes "Outputs": write each output to the path on your card; outputs are never committed; commit only code (tests too only when the card says `commitTests: true`, see C), by explicit path; never stage anything under `.superpowers/`, and never write job documents anywhere else in the repo. Every "commit it / list its commit" instruction for an artifact is removed (spec-writer 7/14/15, planner 6/9/10, investigator 10/16, brainstormer 9, the six reviewers' "commit your review file", implementer 9, fixer 9, tester 6, verifier-tester 6, and `contract.md:46`, `:52`). Code commits stay (`implementer.md:8`, `fixer.md:8`). The invalid-result and turn-cap nudges (`prompts.js:213`, `:217`) say "write" instead of "commit" for outputs. For a legacy job the card carries `artifactsCommitted: true` and the contract keeps a short paragraph for that case.

### B. Final branch name at accept

**Template.** `config.json` gains `branchTemplates`, under `defaults` and `projects[<path>]`, keyed by workflow id (compared with `sameWorkflowId`), e.g.

```json
"projects": { "C:\\workspace\\git\\FallGuys": { "branchTemplates": { "troubleshooting": "bugfix/{ticket}-{description}" } } }
```

Placeholders: `{ticket}` (the first work-item number in the idea: a `_workitems/edit/<n>` URL, else `ADO <n>`, else `#<n>` with 4+ digits; empty if none), `{description}` (the first task's title, else the job title, slugified to at most 6 words), `{slug}` (the job slug). No template: the suggestion is the current branch name. Validated in `checkScalars` (`config.js:256-284`): an object of non-empty strings. The resolved template is recorded on `job-created` (like `copyLocalClaudeSettings`, `index.js:915`), so a later config edit does not change a running job.

**Suggestion.** `jobDetail` (`view-model.js`) gains `branchSuggestion`, computed from the recorded template when the job is `ready-to-try`.

**Accept.** `POST /api/superagent/jobs/:id/accept` takes `{ needsYouSeq, branch? }`. `accept(jobId, { needsYouSeq, branch })` (`index.js:944`):

1. As today: `requireSeen`, state must be `ready-to-try`.
2. If `branch` is given and differs from `job.branch`: validate with `git check-ref-format --branch`, refuse with `ERR_INVALID_BRANCH` (400) if invalid and `ERR_BRANCH_EXISTS` (400, its existing mapping in `src/routes/superagent.js:25-30`) if it exists in any of the job's repos, before changing anything.
3. `git branch -m <job.branch> <branch>` in each repo, in repo order. A failure on a later repo renames the earlier ones back and fails with `ERR_RENAME_FAILED` (500); nothing is appended.
4. Append `branch-renamed { from, to }` (sets `job.finalBranch`), then `job-accepted` as today.

**View.** The ready-to-try box gets a "Branch" text field pre-filled with `branchSuggestion`, next to the branches list (`superagent-view.js:749-751`); Accept sends it. The branches card shows `finalBranch` once set.

### C. Tests are not committed

**Opt-in.** `config.json` gains `commitTests` (boolean, default `false`) under `defaults` and `projects[<path>]`, and the create-job request takes an optional `commitTests` that overrides it for one job (the create form gets a "Commit tests" checkbox, off by default). The resolved value is recorded on `job-created` and shown on the job card as `commitTests`.

**Test paths.** `config.json` gains `testPaths`, a list of repo-relative globs, under `defaults` and `projects[<path>]`. Built-in default: `**/test/**`, `**/tests/**`, `**/Test/**`, `**/Tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/*Test.cs`, `**/*Tests.cs`, each also matching a Unity `.meta` next to it. Recorded on `job-created` and listed on the job card.

**Workers** (when `commitTests` is false):

- `fixer.md` and `implementer.md`: write the failing test first and run it red, as today; make the fix and run it green; then copy each test file you created or changed to `tasks/<task>-tests/` under the artifact root (keeping its repo-relative path), record both runs in the task report, restore the test files in the repo to their state at the start of the attempt (delete new ones, `git restore` changed ones, by explicit path), and commit only the fix.
- `fix-reviewer.md` and `task-reviewer.md`: judge red-then-green from the report's recorded runs and the saved test under `tasks/<task>-tests/`; a fix commit that adds or changes a test is a blocker.
- `contract.md` "Outputs": tests are not committed unless your card says `commitTests: true`.
- When `commitTests` is true, today's prompts apply (the test is committed with the fix), except that artifacts are still never committed.

**Engine.** For a job with `commitTests` false, each listed commit is checked with `git diff-tree --no-commit-id --name-only -r <sha>` against `testPaths`; a match is an invalid result, `commit includes test files: <path>`. A test the globs do not match is only covered by the prompt rule; the report names it.

## Compatibility

Jobs whose `job-created` has no `artifactRoot` keep the current behaviour end to end: repo paths, commit-required validation, the commit instructions (via `artifactsCommitted` on the card), and committed tests (`commitTests` absent is treated as `true` for them). The new "no `.superpowers/` paths in commits" check applies to them too, since no current prompt asks for such a commit. Accept with a rename works for every job.

## Testing

- `superagent-results.test.mjs`: ledger job passes with an uncommitted output and an empty `evidence.commits`; missing/empty output still fails; output hash recorded; `.superpowers/` in a listed commit fails (ledger and legacy); task with only a primary report commit fails for ledger jobs; legacy-job tests unchanged.
- `superagent-workflows.test.mjs`: ledger prefix on substitution; new reserved paths; legacy repo paths still accepted.
- `superagent-config.test.mjs`: `branchTemplates` validation and per-project precedence.
- `superagent.test.mjs` / `superagent-inplace.test.mjs`: accept with a rename (worktree and in-place), invalid name, existing branch, rollback on a second-repo failure, `branch-renamed` event.
- `superagent-prompts.test.mjs`: pinned strings updated; legacy card paragraph.
- `superagent-helpers.mjs` fakes stop committing outputs for ledger jobs.
- `superagent-view-model.test.mjs`: `branchSuggestion` from the 171558 idea gives `bugfix/171558-…`.
- Manual: `tests/superagent-two-phase.manual.mjs` run once to confirm a real worker writes outputs without committing them.

- `superagent-results.test.mjs` (C): a commit touching `Tests/Editor/FooTests.cs` or its `.meta` fails when `commitTests` is false and passes when true; the default globs; legacy jobs unaffected.
- `superagent-config.test.mjs` (C): `commitTests` and `testPaths` validation and precedence; the create request override.
- `superagent-prompts.test.mjs` (C): fixer, implementer and both task reviewers carry the no-commit-tests wording when `commitTests` is false.

## Decisions (2026-11-24, operator)

1. `{description}` from the first task's title (`fix-root-cause-fallguycarryobject-is-used` for 171558) is fine as an editable suggestion.
2. A project without a template falls back to a built-in default per workflow: `bugfix/{ticket}-{description}` for `troubleshooting` (`bugfix/{description}` when there is no ticket), `feature/{description}` for `feature`, and the current name for any other workflow.
3. Tests are never committed in any project unless the user asks for it (config `commitTests` or the per-job checkbox).
