# Superagent: final branch name at accept — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the operator accepts a job, the job branch is renamed to a name that follows the project's convention, e.g. `bugfix/171558-fix-root-cause-fallguycarryobject-is-used`, suggested from a per-project, per-workflow template and editable before accepting.

**Architecture:** `config.json` gains `branchTemplates` keyed by workflow id, with built-in defaults; `createJob` records the template for the job's workflow on `job-created`. A new pure module `src/superagent/branch-name.js` fills the template from the job (ticket from the idea, description from the first task's title). `jobDetail` exposes the suggestion; the ready-to-try box sends the chosen name with Accept; `accept()` validates and renames the branch in every repo, with rollback, and appends `branch-renamed` before `job-accepted`. During the job the branch stays `superagent/<slug>`.

**Tech Stack:** Node.js 26 ESM, `node:test`, git CLI, vanilla browser JS.

**Spec:** `docs/superpowers/specs/2026-11-24-superagent-artifacts-out-of-git-and-branch-names-design.md` (section B, Decisions 1-2).

## Global Constraints

- Built-in `branchTemplates` default, verbatim: `{ "troubleshooting": "bugfix/{ticket}-{description}", "feature": "feature/{description}" }`; any other workflow, or no workflow, has no template and the suggestion is the current `job.branch`.
- Placeholders: `{ticket}`, `{description}`, `{slug}` only.
- `{ticket}`: first match of `_workitems/edit/(\d+)`, else `\bADO\s*#?(\d+)` (case-insensitive), else `#(\d{4,})`, in `job.idea`; empty string if none.
- `{description}`: the first task's `title` (`job.tasks[0].title`), else `job.title`, lowercased, non-alphanumerics to `-`, at most 6 words, joined with `-`.
- After filling: collapse `/-+` to `/`, `-{2,}` to `-`, trim `-` from each `/`-segment end (so a missing ticket gives `bugfix/<description>`).
- Template keys are compared with `sameWorkflowId` (case-insensitive).
- Error codes: `ERR_INVALID_BRANCH` (400), `ERR_BRANCH_EXISTS` (400, the existing mapping in `src/routes/superagent.js:25-30`), `ERR_RENAME_FAILED` (500).
- Accept stays "Nothing is merged or pushed".
- Run `npm test` before every commit; it must stay green.

## Review Focus

1. A suggested name that git rejects (a task title with only punctuation, or a ticket-less template that collapses to `bugfix/`) — the suggestion must still be a valid branch or fall back to `job.branch` (Task 2 test `falls back to the job branch when the filled name is invalid`).
2. Accept clicked twice, or after the rename succeeded but `job-accepted` failed to append — a second accept with the same name must not fail on "branch exists" for the job's own, already-renamed branch (Task 3 test `accept is idempotent after a rename`).
3. A multi-repo job whose second repo already has the target branch — nothing may be renamed (Task 3 test `refuses before renaming when any repo has the name`).
4. An in-place job whose folder the user has switched off the job branch before accepting — `git branch -m old new` must still rename the job branch, not the user's current branch (Task 3 test `renames by name, not the current branch`).
5. The operator clears the Branch field — accept with an empty name keeps the current branch (Task 3 test `empty branch keeps the current name`; Task 4 view sends no `branch` for an empty field).

---

### Task 1: `branchTemplates` config and recording

**Files:**
- Modify: `src/superagent/config.js:52-101` (defaultConfig), `:256-284` (checkScalars)
- Modify: `src/superagent/index.js:870-920` (createJob/admitJob), `src/superagent/store.js:40-75` (deriveJob)
- Test: `tests/superagent-config.test.mjs`, `tests/superagent.test.mjs`, `tests/superagent-store.test.mjs`

**Interfaces:**
- Produces: `defaultConfig().branchTemplates` (Global Constraints value); `export function templateFor(templates: object, workflowId: string | null): string | null` in `config.js`; `job-created.branchTemplate: string | null`; derived `job.branchTemplate` (absent → `null`).

- [ ] **Step 1: Write the failing tests**

- `config`: `branchTemplates` must be an object of non-empty strings (`branchTemplates.<key> must be a non-empty string`); a project entry `{ branchTemplates: { troubleshooting: 'fix/{ticket}' } }` overrides the built-in `troubleshooting` and keeps `feature`; `templateFor(t, 'Troubleshooting')` returns the troubleshooting value; `templateFor(t, 'custom')` and `templateFor(t, null)` return `null`.
- `superagent.test.mjs`: a `troubleshooting` job records `branchTemplate: 'bugfix/{ticket}-{description}'`; a fixture job (no workflow) records `null`.
- `store`: `job.branchTemplate` is read from `job-created`, `null` when absent.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-config.test.mjs tests/superagent.test.mjs tests/superagent-store.test.mjs`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** — `templateFor` looks the workflow id up with `sameWorkflowId`; `createJob` records `branchTemplate: templateFor(resolved.branchTemplates, recorded?.workflow?.id ?? null)`.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/config.js src/superagent/index.js src/superagent/store.js tests/
git commit -m "feat(superagent): per-project branch templates, recorded on the job"
```

### Task 2: Branch name suggestion

**Files:**
- Create: `src/superagent/branch-name.js`
- Modify: `src/superagent/view-model.js:280-284` (jobDetail)
- Test: `tests/superagent-branch-name.test.mjs` (new), `tests/superagent-view-model.test.mjs`

**Interfaces:**
- Consumes: `job.branchTemplate` (Task 1).
- Produces: `export function ticketFromIdea(idea: string | null): string`, `export function describe(job): string`, `export function suggestBranch(job, { isValid = isValidBranchName } = {}): string`, `export function isValidBranchName(name: string): boolean` (pure: no `..`, no `@{`, no ASCII control chars, space, `~^:?*[\`, no leading `-` or `/`, no trailing `/`, `.` or `.lock`, no `//`, non-empty segments); `jobDetail(...).branchSuggestion: string | null` (non-null only when `job.reason === 'ready-to-try'`).

- [ ] **Step 1: Write the failing tests**

- `ticketFromIdea` on the 171558 idea (`https://dev.azure.com/mediatonic/Fall%20Guys%20Client/_workitems/edit/171558 ...`) → `'171558'`; `'Fix ADO #170001 crash'` → `'170001'`; `'see #12345'` → `'12345'`; `'no ticket'` → `''`.
- `suggestBranch` for a job with `branchTemplate: 'bugfix/{ticket}-{description}'`, the 171558 idea and first task title `Fix root cause: FallGuyCarryObject is used before Start when the rolling ball begins and ends in one update phase` → `'bugfix/171558-fix-root-cause-fallguycarryobject-is-used'`.
- No ticket → `'bugfix/fix-root-cause-fallguycarryobject-is-used'`; no tasks → description from `job.title`; `branchTemplate: null` → `job.branch`.
- `falls back to the job branch when the filled name is invalid`: title `'!!!'`, template `'bugfix/{description}'` → `job.branch`.
- `isValidBranchName`: `'a/b'` true; `'a..b'`, `'a/'`, `'-a'`, `'a.lock'`, `'a b'`, `''` false.
- `view-model`: ready-to-try job → `branchSuggestion` as above; running job → `null`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-branch-name.test.mjs tests/superagent-view-model.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** per Global Constraints; `jobDetail` adds `branchSuggestion` and `finalBranch: job.finalBranch ?? null` (set in Task 3).

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/branch-name.js src/superagent/view-model.js tests/superagent-branch-name.test.mjs tests/superagent-view-model.test.mjs
git commit -m "feat(superagent): suggest the final branch name from the project template"
```

### Task 3: Rename on accept

**Files:**
- Modify: `src/superagent/index.js:944-956` (accept)
- Modify: `src/superagent/store.js` (`branch-renamed` reducer)
- Modify: `src/routes/superagent.js:25-30` (error mapping), `:284`, `:291-300` (accept body)
- Test: `tests/superagent.test.mjs`, `tests/superagent-inplace.test.mjs`, `tests/superagent-routes.test.mjs`, `tests/superagent-store.test.mjs`

**Interfaces:**
- Consumes: `isValidBranchName` (Task 2).
- Produces: `accept(jobId, { needsYouSeq?, branch? })`; event `{ type: 'branch-renamed', from: string, to: string }`; derived `job.finalBranch: string | null`.

- [ ] **Step 1: Write the failing tests** (temp repos as in the existing accept tests)

- `accept renames the branch in every repo`: two-repo worktree job at ready-to-try, `accept(id, { needsYouSeq, branch: 'bugfix/1-x' })` → `git rev-parse --verify refs/heads/bugfix/1-x` succeeds in both, the old branch is gone, events end `branch-renamed { from, to }`, `job-accepted`; `job.finalBranch === 'bugfix/1-x'`.
- `renames by name, not the current branch` (in-place): the folder is switched to another branch before accept; after accept the job branch is renamed and the folder's current branch is unchanged.
- `refuses before renaming when any repo has the name`: second repo already has `bugfix/1-x` → `ERR_BRANCH_EXISTS`, no repo renamed, no event appended.
- `rolls back when a later rename fails`: inject a `git` that fails `branch -m` on the second repo → `ERR_RENAME_FAILED`, first repo renamed back, no event.
- `rejects an invalid name`: `'a..b'` → `ERR_INVALID_BRANCH`, nothing changed.
- `empty branch keeps the current name` and `same name as job.branch`: no rename, no `branch-renamed`, `job-accepted` appended.
- `accept is idempotent after a rename`: a job whose events already have `branch-renamed` to `X` but no `job-accepted`: `accept(id, { branch: X })` appends only `job-accepted`.
- Routes: `branch: 5` → 400 `ERR_INVALID_REQUEST` `branch must be text`; `ERR_INVALID_BRANCH` → 400; `ERR_RENAME_FAILED` → 500.
- Store: `branch-renamed` sets `finalBranch` and leaves `branch` unchanged.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent.test.mjs tests/superagent-inplace.test.mjs tests/superagent-routes.test.mjs tests/superagent-store.test.mjs`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

In `accept`, after the existing state checks: `const from = job.finalBranch ?? job.branch; const to = branch?.trim() || from`. If `to !== from`: `isValidBranchName(to)` and `git check-ref-format --branch <to>` (in the primary worktree) else `ERR_INVALID_BRANCH`; for each repo `git rev-parse --verify --quiet refs/heads/<to>` must fail, else `ERR_BRANCH_EXISTS`; then `git branch -m <from> <to>` per repo in repo order (`cwd` = the repo's worktree or in-place folder), renaming already-renamed repos back on a failure and throwing `ERR_RENAME_FAILED`; then append `branch-renamed`. Then `job-accepted` as today. Use the injected `git` (`defaultGit` default) so the rollback test can fail one call. Add `ERR_INVALID_BRANCH` to `BAD_REQUEST`; map `ERR_RENAME_FAILED` to 500; the accept action passes `branch: body.branch`.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/index.js src/superagent/store.js src/routes/superagent.js tests/
git commit -m "feat(superagent): rename the job branch on accept"
```

### Task 4: Branch field in the view, and docs

**Files:**
- Modify: `public/superagent-view.js:747-767` (ready-to-try), `:545-549` (branchLine)
- Modify: `public/superagent-job-pane.js:498-508` (branchesCard)
- Modify: `CLAUDE.md` (superagent paragraph: `branchTemplates`, accept rename, `branch-renamed`, the error codes), `tests/README.md`
- Test: `tests/superagent-job-pane.test.mjs`

**Interfaces:**
- Consumes: `branchSuggestion`, `finalBranch` (Task 2), the accept body (Task 3).

- [ ] **Step 1: Write the failing test** — `superagent-job-pane.test.mjs`, `the branches card shows the final branch`: a detail with `finalBranch: 'bugfix/1-x'` renders `bugfix/1-x` and not the `superagent/...` name.
- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/superagent-job-pane.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** — ready-to-try box: a labelled text input "Branch" pre-filled with `detail.branchSuggestion`, above the Accept row; Accept sends `{ needsYouSeq, branch }` with `branch` omitted when the trimmed field is empty; the tooltip becomes `Mark the job done and rename the branch. Nothing is merged or pushed.`. `branchesCard` and `branchLine` show `finalBranch ?? branch`. Update the docs.
- [ ] **Step 4: Run all tests, then check by hand**

Run: `npm test` (PASS), then `npm start`, open the Superagent tab on a ready-to-try job from `tests/superagent-view-fixture.manual.mjs`, accept with an edited name, and confirm the branch in the repo and in the branches card.

- [ ] **Step 5: Commit**

```bash
git add public/superagent-view.js public/superagent-job-pane.js CLAUDE.md tests/README.md tests/superagent-job-pane.test.mjs
git commit -m "feat(superagent): name the branch when accepting a job"
```
