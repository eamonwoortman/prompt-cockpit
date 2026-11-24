# Superagent: artifacts and tests out of git — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New superagent jobs keep every job artifact in the git-ignored ledger and commit only the fix: no job documents and, unless the job opts in, no tests.

**Architecture:** A new job records `artifactRoot: 'ledger'`, `commitTests` and `testPaths` on `job-created`. `deriveJob` resolves every artifact path under `.superpowers/superagent/<jobId>/artifacts/` (worktree-relative), so readers keep working unchanged. `results.js` stops requiring an artifact commit for ledger jobs, records each output's SHA-256, and rejects any listed commit that touches `.superpowers/` or (when `commitTests` is false) a test path. Prompts tell workers to write outputs without committing them and to save tests as artifacts.

**Tech Stack:** Node.js 26 ESM, `node:test`, git CLI, `node:path` `matchesGlob`, `node:crypto` `createHash`.

**Spec:** `docs/superpowers/specs/2026-11-24-superagent-artifacts-out-of-git-and-branch-names-design.md` (sections A and C, Compatibility, Testing, Decisions).

## Global Constraints

- Ledger artifact root, worktree-relative: `.superpowers/superagent/<jobId>/artifacts` (forward slashes).
- Jobs without `artifactRoot` on `job-created` keep today's behaviour exactly; for them `commitTests` absent means `true`.
- `commitTests` default `false` (built-in default, `config.json` `defaults`/`projects[<path>]`, and a per-job create option).
- Built-in `testPaths` default, verbatim: `**/test/**`, `**/tests/**`, `**/Test/**`, `**/Tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/*Test.cs`, `**/*Tests.cs`; a path ending in `.meta` is matched with the `.meta` stripped too.
- Error texts, verbatim: `commit includes superagent files: <path>`, `commit includes test files: <path>`.
- Never stage paths by `git add -A`/`.`/`-u` in fakes or engine code; explicit paths only.
- Run `npm test` before every commit; it must stay green (1580 tests today).

## Review Focus

1. A worker that writes an output *and also* force-adds it (`git add -f`) — the `.superpowers/` guard must reject the result (Task 2 test `rejects a commit that touches .superpowers`).
2. A Unity `.meta` file of a test committed on its own (`Tests/Editor/FooTests.cs.meta` without the `.cs`) — must count as a test path (Task 4 test `matches a .meta next to a test`).
3. A legacy job (created before this change) resumed after the upgrade — paths, commit-required validation and committed tests unchanged (Task 1 and Task 2 legacy tests, Task 5 legacy card test).
4. A review fix on a ledger job where the author declines every finding (no file changed, no commits) — must pass (Task 2 test `review fix with no commits passes for a ledger job`).
5. A per-task attempt that commits only a primary-repo change when the task lists another repo — must still fail now that the report no longer justifies a primary commit (Task 2 test `primary-only commit no longer passes for a non-primary task`).

---

### Task 1: Ledger artifact paths

**Files:**
- Modify: `src/superagent/store.js:40-70` (deriveJob)
- Modify: `src/superagent/results.js:52-81` (artifactPaths, reviewPaths)
- Modify: `src/superagent/workflows.js:31-39` (constants)
- Test: `tests/superagent-store.test.mjs`, `tests/superagent-results.test.mjs`

**Interfaces:**
- Produces: `export function ledgerArtifactRoot(jobId: string): string` in `results.js` returning `.superpowers/superagent/${jobId}/artifacts`; `export const LEDGER_LEGACY_ARTIFACTS` in `workflows.js` = `{ brief: 'brief.md', spec: 'spec.md', plan: 'plan.md', tasks: 'tasks.json', testReport: 'test-report.md' }`; `job.artifactRoot: 'ledger' | null` on the derived job.

- [ ] **Step 1: Write the failing tests**

In `superagent-store.test.mjs`, test `deriveJob resolves ledger artifact paths`: a `job-created` with `artifactRoot: 'ledger'`, `workflow` set and `artifacts: { diagnosis: 'diagnosis.md', tasks: 'tasks.json' }` gives `job.artifacts.diagnosis === '.superpowers/superagent/<jobId>/artifacts/diagnosis.md'` and `job.artifactRoot === 'ledger'`; with `workflow` absent it gives `job.artifacts.brief === '.superpowers/superagent/<jobId>/artifacts/brief.md'`; without `artifactRoot` the existing expectations (`docs/superpowers/jobs/<slug>/...`) hold and `job.artifactRoot === null`.

In `superagent-results.test.mjs`, test `reviewPaths uses the ledger root for a ledger job`: `reviewPaths(ledgerJob, { phase: 'spec-review', round: 2, taskId: 'T1' })` gives `review: '<root>/reviews/spec-review-r2.md'` and `report: '<root>/tasks/T1-report.md'`, where `<root>` is `ledgerArtifactRoot(jobId)`; the legacy job keeps `docs/superpowers/jobs/<slug>/reviews/...`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-store.test.mjs tests/superagent-results.test.mjs`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement**

`deriveJob`: `artifactRoot: first.artifactRoot === 'ledger' ? 'ledger' : null`; for a ledger job the base map is `first.artifacts` (workflow) or `LEDGER_LEGACY_ARTIFACTS` substituted (no workflow), and every value is prefixed with `ledgerArtifactRoot(first.jobId) + '/'`. `reviewPaths`: the `jobs` root is `ledgerArtifactRoot(job.jobId)` when `job.artifactRoot === 'ledger'`, else today's value. Put `ledgerArtifactRoot` in `results.js` and import it in `store.js` only if that import adds no cycle (`store.js` already imports from `workflows.js`; if `results.js` → `store.js` exists, define it in `workflows.js` instead and re-export from `results.js`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, no other test changes (nothing records `artifactRoot` yet).

- [ ] **Step 5: Commit**

```bash
git add src/superagent/store.js src/superagent/results.js src/superagent/workflows.js tests/superagent-store.test.mjs tests/superagent-results.test.mjs
git commit -m "feat(superagent): resolve artifact paths under the ledger for ledger jobs"
```

### Task 2: Validation without artifact commits

**Files:**
- Modify: `src/superagent/results.js:444-466` (taskEvidenceErrors), `:528-606` (reviseErrors, outputErrors), `:660-686` (validateResult)
- Modify: `src/superagent/runner.js:226-242` (judge payload), `src/superagent/store.js:203-222` (attempt-ended)
- Test: `tests/superagent-results.test.mjs`, `tests/superagent-store.test.mjs`

**Interfaces:**
- Consumes: `job.artifactRoot` (Task 1).
- Produces: `validateResult(...)` ok result gains `outputs: { [relPath: string]: string /* sha256 hex */ }` (empty object when none); `attempt-ended` payload carries `outputs`; derived attempt `a.outputs` (default `{}`); `export async function commitPathErrors(commits, { job, git }): Promise<string[]>` in `results.js`, used by Task 4.

- [ ] **Step 1: Write the failing tests** (ledger job fixtures built like the existing ones, with `artifactRoot: 'ledger'`; files written but not committed)

- `ledger author output passes uncommitted with no commits`: done result, `evidence` without commits, output file present → `ok: true`, `result.outputs[rel]` equals `sha256(content)`.
- `ledger author output still must exist and be non-empty`: missing → `missing output: <rel>`; empty → `empty output: <rel>`.
- `review fix with no commits passes for a ledger job`: revise outputs present and unchanged, no commits → ok.
- `primary-only commit no longer passes for a non-primary task`: task `repos: ['lib']`, one primary commit → error `evidence.commits must include a commit in one of the task's repos (lib)`, and `evidence.commits[0]: repo "primary" is not one of the task's repos (lib)`.
- `rejects a commit that touches .superpowers` (ledger and legacy job): a listed commit adding `.superpowers/superagent/x/artifacts/a.md` via `git add -f` → `commit includes superagent files: .superpowers/superagent/x/artifacts/a.md`.
- `legacy job still needs its output committed`: existing tests unchanged and passing.
- Store: `attempt-ended keeps outputs` → `a.outputs` deep-equals the event's map; absent → `{}`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-results.test.mjs tests/superagent-store.test.mjs`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

- `outputErrors(...)` returns `{ errors, outputs }`. For `job.artifactRoot === 'ledger'` skip the `diff-tree` "committed" and `status --porcelain` checks; for every present, non-empty output put `createHash('sha256').update(await readFile(abs)).digest('hex')` in `outputs`. Legacy jobs: unchanged checks, `outputs` still filled.
- `reviseErrors`: skip the uncommitted-changes check for ledger jobs.
- `taskEvidenceErrors`: for ledger jobs drop the "primary is always allowed" exception (`repo !== primary &&` in the first loop).
- `commitPathErrors(commits, { job, git })`: for each `{ repo, sha }` run `git diff-tree --no-commit-id --name-only -r <sha>` in that repo's worktree; any path starting with `.superpowers/` gives `commit includes superagent files: <path>` (first offending path per commit). Call it in `validateResult` right after `resolveCommits`, for every job.
- `validateResult` puts `outputs` on the ok result; `runner.js` judge copies `outputs: r.outputs ?? {}` into the payload; `store.js` `attempt-ended` sets `outputs: ev.outputs ?? {}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/results.js src/superagent/runner.js src/superagent/store.js tests/superagent-results.test.mjs tests/superagent-store.test.mjs
git commit -m "feat(superagent): ledger jobs need no artifact commits; record output hashes; refuse .superpowers in commits"
```

### Task 3: New jobs use the ledger

**Files:**
- Modify: `src/superagent/index.js:870-920` (createJob/admitJob: record `artifactRoot: 'ledger'`)
- Modify: `workflows/feature.json:6-11`, `workflows/troubleshooting.json:6-9` (drop `docs/superpowers/jobs/{slug}/`; spec/plan become `spec.md`, `plan.md`)
- Modify: `src/superagent/workflows.js:31` (`RESERVED_PATHS` adds `.superpowers/`, `reviews/`, `tasks/`)
- Modify: `tests/superagent-helpers.mjs:186-226` (scriptedWorker)
- Modify: tests that pin repo artifact paths or the commit of outputs (`superagent-pipeline.test.mjs`, `superagent-runner.test.mjs:995`, `:1010`, `superagent-workflows.test.mjs:77`, `:87`, `:138-140`, `superagent-view-model.test.mjs`, `superagent-accounting.test.mjs:379-488`, `superagent-retrospective.test.mjs:281`)
- Test: `tests/superagent.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: every job created after this task is a ledger job; `scriptedWorker`'s `publish(card, fields, { content, files })` writes outputs without committing and commits only `files` (none → no commit and no `evidence.commits`).

- [ ] **Step 1: Write the failing test**

`superagent.test.mjs`, test `a new job keeps its artifacts in the ledger and off the branch`: run a scripted `troubleshooting` job to `ready-to-try`; assert `job-created.artifactRoot === 'ledger'`, the diagnosis exists at `<primary worktree>/.superpowers/superagent/<jobId>/artifacts/diagnosis.md`, and `git log --name-only <baseSha>..<branch>` lists no path under `docs/superpowers/` or `.superpowers/`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/superagent.test.mjs`
Expected: FAIL (`artifactRoot` undefined).

- [ ] **Step 3: Implement**

Record `artifactRoot: 'ledger'` on `job-created`; change both workflow files and `RESERVED_PATHS`; change `scriptedWorker.publish` as in Interfaces (outputs written with `mkdirSync` + `writeFileSync`, `commit()` called only when `files` is non-empty). Update the pinned path tests to the ledger paths; tests that check legacy behaviour build their `job-created` by hand without `artifactRoot`.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/index.js src/superagent/workflows.js workflows/feature.json workflows/troubleshooting.json tests/
git commit -m "feat(superagent): new jobs write artifacts into the ledger"
```

### Task 4: Tests are not committed

**Files:**
- Modify: `src/superagent/config.js:52-101` (defaultConfig), `:256-284` (checkScalars)
- Create: `src/superagent/test-paths.js`
- Modify: `src/superagent/index.js:870` (createJob option, record), `src/superagent/store.js` (deriveJob)
- Modify: `src/superagent/results.js` (validateResult)
- Modify: `src/routes/superagent.js:55-70`, `:261-270` (create body)
- Modify: `public/superagent-view.js:187-230`, `:383` (create form checkbox)
- Test: `tests/superagent-config.test.mjs`, `tests/superagent-test-paths.test.mjs` (new), `tests/superagent-results.test.mjs`, `tests/superagent-routes.test.mjs`, `tests/superagent.test.mjs`

**Interfaces:**
- Consumes: `commitPathErrors` (Task 2).
- Produces: `defaultConfig().commitTests === false`, `defaultConfig().testPaths` = the Global Constraints list; `export function isTestPath(rel: string, globs: string[]): boolean` in `test-paths.js`; `createJob({ ..., commitTests?: boolean })`; `job-created.commitTests: boolean`, `job-created.testPaths: string[]`; derived `job.commitTests` (absent → `true`), `job.testPaths` (absent → `[]`).

- [ ] **Step 1: Write the failing tests**

- `test-paths`: `isTestPath('FallGuys_MP/SharedUnityPackages/x/Tests/Editor/FooTests.cs', DEFAULT)` true; `matches a .meta next to a test`: `.../Tests/Editor/FooTests.cs.meta` true; `src/app.test.js`, `pkg/__tests__/a.js`, `a_test.go` true; `src/latest.js`, `docs/testing.md`, `Contest.cs` false; backslash paths normalised.
- `config`: `commitTests` must be boolean, `testPaths` a non-empty array of non-empty strings (`commitTests must be a boolean`, `testPaths must be a non-empty array of glob strings`); project entry overrides defaults.
- `results`: ledger job with `commitTests: false` and a listed commit adding `Tests/Editor/FooTests.cs` → `commit includes test files: Tests/Editor/FooTests.cs`; same commit with `commitTests: true` → ok; a legacy job (no `commitTests`) → ok.
- `routes`: `commitTests: "yes"` → 400 `ERR_INVALID_REQUEST` `commitTests must be true or false`; `true` reaches `createJob`.
- `superagent.test.mjs`: `createJob({ commitTests: true })` records `commitTests: true` over a config default `false`; without it the resolved config value is recorded with `testPaths`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-test-paths.test.mjs tests/superagent-config.test.mjs tests/superagent-results.test.mjs tests/superagent-routes.test.mjs tests/superagent.test.mjs`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`isTestPath`: normalise `\` to `/`, test `path.posix.matchesGlob(rel, g)` for each glob, and again for `rel` without a trailing `.meta`. `commitPathErrors` also reports `commit includes test files: <path>` when `job.commitTests === false` and `isTestPath(path, job.testPaths)`. Record `commitTests` (option ?? resolved) and `testPaths` (resolved) on `job-created`. The create form gets a "Commit tests" checkbox (off) next to the in-place toggles, sent as `commitTests`.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/test-paths.js src/superagent/config.js src/superagent/index.js src/superagent/store.js src/superagent/results.js src/routes/superagent.js public/superagent-view.js tests/
git commit -m "feat(superagent): tests are not committed unless the job opts in"
```

### Task 5: Prompts and job card

**Files:**
- Modify: `src/superagent/prompts.js:163-207` (card), `:213`, `:217` (nudges)
- Modify: `prompts/superagent/contract.md:19`, `:28-34`, `:46`, `:52`
- Modify: `prompts/superagent/` `brainstormer.md:9`, `spec-writer.md:7,14,15`, `planner.md:6,9,10`, `investigator.md:10,16`, `spec-reviewer.md:9`, `plan-reviewer.md:9`, `diagnosis-reviewer.md:9`, `task-reviewer.md:6,9`, `fix-reviewer.md:4-6,10`, `verifier.md:9`, `implementer.md:5-9`, `fixer.md:5-9`, `tester.md:6`, `verifier-tester.md:6`
- Test: `tests/superagent-prompts.test.mjs:217`, `:309`, `:331` and new tests

**Interfaces:**
- Consumes: `job.artifactRoot`, `job.commitTests`, `job.testPaths` (Tasks 1, 4).
- Produces: card fields `commitTests: boolean`, `testPaths: string[]` on every card; `artifactsCommitted: true` only on legacy-job cards.

- [ ] **Step 1: Write the failing tests**

- `a ledger job card carries commitTests and testPaths, not artifactsCommitted`; `a legacy job card carries artifactsCommitted: true`.
- Pinned strings: contract contains `Outputs are never committed`, `never stage anything under \`.superpowers/\``, `If your card has \`artifactsCommitted: true\``, `unless your card says \`commitTests: true\``; `fixer.md` and `implementer.md` contain `tasks/<task>-tests/` and `commit only the fix`; `fix-reviewer.md` and `task-reviewer.md` contain `a fix commit that adds or changes a test is a blocker`; no prompt other than contract's legacy paragraph contains `commit your review file` or `list its commit`.
- Nudges: invalid-result says `write any output you change`; turn-cap says `writing your outputs`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-prompts.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Rewrite contract "Committing outputs" as "Outputs" per spec A (Prompts) and C (Workers); one legacy paragraph for `artifactsCommitted: true` keeps today's rules. Edit each listed role line: remove "commit it / list its commit" for artifacts; fixer/implementer get the save-test-then-remove steps from spec C; the two task reviewers judge from `tasks/<task>-tests/` and the recorded runs. Update the three existing pins.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/prompts.js prompts/superagent/ tests/superagent-prompts.test.mjs
git commit -m "feat(superagent): prompts write outputs without committing them and keep tests out of commits"
```

### Task 6: Docs and a real-worker check

**Files:**
- Modify: `CLAUDE.md` (superagent paragraph: ledger artifacts, `commitTests`, `testPaths`, the two new errors), `docs/superpowers/specs/2026-11-03-superagent-design.md` (worker contract: outputs not committed; append, do not rewrite)
- Modify: `tests/README.md` (what the new tests cover; the manual run)

- [ ] **Step 1: Update the docs** with the facts from Tasks 1-5 (names and error texts as implemented).
- [ ] **Step 2: Run the manual probe**

Run: `node tests/superagent-two-phase.manual.mjs`
Expected: ends `ready-to-try`; the job branch has no commit touching `.superpowers/` or `docs/superpowers/jobs/`; the outputs exist under the ledger. Record the result in `tests/README.md`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-11-03-superagent-design.md tests/README.md
git commit -m "docs(superagent): artifacts in the ledger, tests not committed"
```
