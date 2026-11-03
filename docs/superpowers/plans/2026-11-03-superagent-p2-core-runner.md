# Superagent Plan 2 — Core, Store and Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** 2 — folds in the Codex review of revision 1 (13 findings; `.superpowers/sdd/codex-p2-review.md`). See "Revision 2 changes" at the end.

**Goal:** A tested superagent library under `src/superagent/` that validates the full default pipeline config, persists each job as an append-only event log, creates one git worktree per repo per job, validates attempt results, enforces the sequencer limits and runs the named milestone-1 fixture pipeline (one author phase, then the human `accept` phase) through real registry sessions. It is not wired into the server.

**Architecture:** Same DI shape as auto-pilot's `createAutopilot`: `createSuperagent({ registry, store, config, git, now, setIntervalImpl, ... })` composes a pure **sequencer** (`nextAction(job, ctx)` decides, owns every limit), a **runner** (launches and watches attempts via `registry.createSession`/`sendInput`/`closeSession` plus the Plan 1 hooks; one finishing claim per attempt), a **results** validator and an event **store** (`events.jsonl` is the truth, `state.json` a write-only cache). Job state is always `deriveJob(events)`. Three small changes outside `src/superagent/` (Task 1): `src/session.js` gains merged `sdkOptions.hooks` and `sdkOptions.interceptEveryPermission` (PreCompact logging; "deny every worker `canUseTool` call"), and `src/session-registry.js`'s `createSession` stops leaving a row behind when the start function throws synchronously.

**Tech Stack:** Node 18+ ESM, no framework, no bundler; `@anthropic-ai/claude-agent-sdk` 0.3.231; `git` CLI via `execFile`; tests with `node --test` (`npm test` = `node --test tests/*.test.mjs`, top-level files only).

**Spec:** `docs/superpowers/specs/2026-11-03-superagent-design.md` (revision 3), "Suggested sequencing" step 1. Spike findings: `docs/superpowers/spikes/2026-11-03-superagent-spikes.md`.

## Global Constraints

- Work only on branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`; `feature/auto-pilot` is not modified.
- No new npm dependencies; plain ESM; no build step; do not commit `package-lock.json` changes (`git checkout -- package-lock.json` first).
- Hand-driven sessions and auto-pilot behave exactly as before; baseline is `npm test` = 711 passing and stays green after every task.
- NO `Co-Authored-By` trailer on any commit (the user removed trailers from this branch and does not want them). Commit messages use a conventional prefix only; show commits as `git commit -F- <<'EOF' ... EOF` WITHOUT a trailer. Preserve each existing file's line-ending convention; new files follow the repo's convention (check).
- Line endings checked when this plan was written: LF throughout, `core.autocrlf=false`; every new file is LF.
- State lives under `path.join(process.env.COCKPIT_HOME || homedir(), '.prompt-cockpit')`; tests never touch the real home (temp dirs, injected paths).
- Tests use `node --test`, no network, no real CLI/model; no real-model probe is run by any task. If you include a manual end-to-end probe file (`tests/*.manual.mjs`) it is written but NOT run by implementers; it states limits and an estimated cost that must be treated as a floor — Plan 1's probes cost 10-30x their header estimates; the user's approval is needed before it is run.
- Facts from Plan 1 the plan must respect: the rate-limit listener `registry.addRateLimitListener` and `createProviderCooldowns` exist; cooldown reads are synchronous but lag un-awaited writes and are empty before `load()`; `wireAutopilot` owns `cooldowns.load()` today; `sdkOptions` is whitelisted; the ledger field is `result.modelUsage` (later plan).
- Spec rules every task inherits: Claude only (`provider: 'claude'`, Decision 13); model ids `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`; never push, open a PR or merge (Decision 10); never delete a worktree or branch automatically; never write a project's `.claude/settings*.json` (Decision 17 — the copy goes into the worktree only); `src/server.js` is not changed.
- The only edits outside `src/superagent/`, `prompts/superagent/` and `tests/` are Task 1's (`src/session.js`, `src/session-registry.js`) and Task 10's docs. Every async registry call (`sendInput`) is awaited or caught; no floating promise may reject unhandled (pattern: `src/autopilot.js:592-600`).
- Real `git` in temp repos is allowed in tests (precedent: `tests/sdk-adapter.test.mjs:205-209`); every test repo sets `user.email`/`user.name` locally. On Windows `git worktree list --porcelain` prints forward slashes: compare paths with `path.resolve` and, on win32, lower-case.

## Review Focus

1. **A stale or copied `result.json` from an earlier attempt must not count.** Identity is checked field by field against the attempt that was launched. (Task 5, `a result carrying an earlier attempt's id is invalid-result`.)
2. **A hard kill mid-append leaves a torn last line in `events.jsonl`.** It is ignored on load, and the next append must not glue onto it and turn it into a corrupt middle line. (Task 3, `a torn final line is ignored and the next append starts on a fresh line`.)
3. **One attempt must have exactly one ending, and one job one live attempt.** Overlapping ticks, a removal during result validation, a stall and a `stopJob` can all race; each attempt gets one `attempt-ended`, and no launch survives `stop()`/`stopJob()` started while it awaited. (Task 8, `concurrent launches for one job create one session`, `completion, removal and stop claim one finish per attempt`; Task 9, `overlapping ticks launch one attempt`, `stop while a budget check is pending launches nothing`, `stopJob while a budget check is pending: no attempt-started, job stopped`.)
4. **A crash between `attempt-started` and session creation, or during provisioning,** must give exactly one new attempt with the recovery note that does not consume an attempt (or a failed job that keeps its worktrees), and a crash after a worker published a valid result must not re-run it. (Task 9, `reconcile: started without a result becomes interrupted and relaunches uncounted`, `reconcile: started with a valid result is processed, not re-run`, `restart during provisioning fails the job and keeps its worktrees`.)
5. **The interceptor must deny only for rows the superagent owns, and use the right role.** A hand-driven or auto-pilot row's question must still reach the human. (Task 8, `the interceptor passes on rows it does not own`, `brainstormer AskUserQuestion falls through, its other asks are denied`.)

---

## Decisions the spec leaves to the builder

1. **Module split.** `src/superagent/{config,store,worktree,results,prompts,sequencer,runner,index}.js`. `sequencer.js` is pure (decisions and limits, no I/O); the timer lives in `index.js` (`createSuperagent`), which executes the sequencer's actions. Router, standin, usage and caps modules come in later plans.
2. **Event schema.** One JSON object per line, `{ seq, at, type, ...payload }`, `seq` starting at 1 per job. Types (`EVENT_TYPES`): `job-created`, `worktree-created`, `job-provisioned`, `job-failed`, `attempt-started`, `attempt-session`, `attempt-nudged`, `attempt-ended`, `needs-you`, `job-accepted`, `job-stopped`, `precompact`. Phase advance is not an event: it is derived from `attempt-ended { outcome: 'done' }` for the current phase.
3. **Attempt outcomes** (`attempt-ended.outcome`): `done`, `failed`, `question`, `interrupted`, `stopped`. `failed` carries `reason` ∈ `no-result`, `invalid-result`, `turn-cap`, `stalled`, `failed`, `blocked` (spec names) plus `launch-failed` (builder's addition: prompt build, `createSession`, the `attempt-session` append or the first `sendInput` failed). `usage-cap` is reserved for milestone 5. Consuming outcomes: `done`, `failed`, `question`; `interrupted` and `stopped` never consume.
4. **Job states produced here:** `provisioning` (builder's addition: `job-created` until `job-provisioned`; never launchable), `running`, `needs-you` (`ready-to-try` | `question` | `stuck`), `done`, `stopped`, `failed`. `draft`, `brainstorming`, `paused` and `accepting` are not produced by this plan (see "Spec ambiguities resolved here"). A job still `provisioning` when `start()` runs (a crash mid-provisioning) becomes `failed` with its worktrees kept — the smaller choice than resuming provisioning, and the user can create the job again.
5. **`state.json`** is write-only from the library's point of view: written (atomic) after every append, never read for decisions; `start()` always rebuilds from `events.jsonl`.
6. **Job config snapshot.** `job-created` stores the resolved pipeline, models, limits, `workerPermissionMode` and `copyLocalClaudeSettings`, so a config edit never changes a running job. `maxConcurrentSessions` is read from the global defaults at `start()`.
7. **Config merge.** Built-in defaults ← file `defaults` ← `projects[<abs path>]`. Objects `limits` and `budget` merge by key; `models` merges per role then per field; arrays (`pipeline`, `routerModelAllowlist`, `additionalRepos`) replace. Project keys are canonicalised with `path.resolve` (+ lower-case on win32).
8. **v1 composition rule (concrete, exactly spec §Phase contracts "v1 allows only validated compositions").** The non-review phases are the default's six (`brainstorm`, `spec`, `plan`, `implement`, `test`, `accept`) in default order with the default `kind`, `inputs` and `outputs`; only their `role` (and the per-task `taskReview`, which may also be removed) may change. Review phases may be removed, or added with a unique id when their target is produced earlier. Nothing else.
9. **The milestone-1 fixture.** Spec "Suggested sequencing" step 1 asks for "a two-phase pipeline (author → human)", which the v1 rule above rejects. It is therefore not a config composition: `config.js` exports a named constant `MILESTONE_1_PIPELINE` (`spec` from `idea` → `accept`) and a separate `validateMilestoneFixture(defaults)`, and only `createJob({ …, fixture: 'milestone-1' })` uses it. `save()` never accepts it. **Runnable kinds in this plan:** `author` and `human`; `createJob` without the fixture rejects the default pipeline (`ERR_PHASE_KIND_UNSUPPORTED`) until Plan 3.
10. **Worktree location:** `~/.prompt-cockpit/superagent/worktrees/<job-slug>/<repo-id>`; repo ids are `primary` then the additional repos' basenames (deduped with `-2`, `-3`). Slug = `slugify(title)` (max 40 chars) + `-` + first 8 chars of the job id. Base = the origin repo's `HEAD`.
11. **Ledger hygiene:** `createWorktree` writes `<worktree>/.superpowers/superagent/.gitignore` containing `*`, so the ledger is ignored even in repos without the `.superpowers/` convention. The `.claude/settings.local.json` copy is **skipped** (recorded as `settingsCopy: 'skipped-not-ignored'`) when the repo does not ignore that path, so a worker's `git add -A` cannot commit it.
12. **Prompt delivery:** role template + shared contract go into `sdkOptions.appendSystemPrompt` (a stable prefix per role); the job card is the first user message. Per-project override: `<primary origin repo>/.superpowers/superagent/prompts/<role>.md`.
13. **One deny message** (`UNATTENDED_DENY_MESSAGE`, the spec's exact text) for every denied worker `canUseTool` call, not only `AskUserQuestion`.
14. **Result leniency and commit evidence:** a summary over 60 words is truncated, not rejected; `verdict`/`findings` on a non-review phase are ignored. Commit evidence entries are `"sha"` (primary repo) or `{ "repo": "<repo id>", "sha": "…" }`; every listed commit must be on the job branch **and not reachable from the base commit**, for any phase. For `done`, each required output must also be **committed by a listed primary-repo commit** (the path is in that commit's `git diff-tree` file list) and unchanged since (clean in `git status --porcelain -- <path>`). Grounds: Decision 10 ("spec, plan, tasks, reviews, brief and test report are committed too") and §Artifact locations ("Committed in the primary worktree"); §Worker contract's `implement`-only wording covers the extra per-task checks, not whether artifacts are committed.
15. **createSuperagent surface:** `start`, `stop`, `tick`, `drain`, `createJob`, `accept`, `stopJob`, `listJobs`, `getJob`, `orphanWorktrees`. No `cooldowns` or `log` dependency yet: `events.jsonl` is the log, and milestone 5 adds `cooldowns` at the runner's turn-ended step.
16. **Concurrency inside the library.** One per-attempt finishing claim in the runner (completion, removal, stall, stop); one per-job promise chain in `index.js` (`tick`'s job step, `stopJob`, `accept`); `stopping` and the job's state rechecked after every await on the launch path. `start()`/`stop()` are idempotent; `start()` clears `stopping`; `stop()` waits for an in-flight tick for at most `stopTickDeadlineMs` (default 2000, as `src/autopilot.js:43`).
17. **Stall progress** = a new event-log entry whose message `type` is `assistant`, `user` or `result` (`PROGRESS_TYPES`). `system` and `rate_limit_event` entries are telemetry and never postpone the deadline.

## Spec ambiguities resolved here

- **Two-phase pipeline vs v1 compositions.** §Phase contracts' allowed edits reject any author → human pipeline, while "Suggested sequencing" step 1 asks for one. Resolved without widening the v1 rule: the two-phase pipeline is the named milestone fixture of builder decision 9.
- **S4 router auth (authority amendment).** The spec (§Isolation, Spike 4) and spike S4 said "Plan 2" resolves the router auth route and re-measures the baseline. Plan 2 is the milestone-1 core and the router is milestone 2, so this revision reassigns that work to the router plan (milestone 2) and edits those three sentences to say so. `routerMaxInputTokens: 6000` stays marked unvalidated; no paid probe is added.
- **`needs-you(ready-to-try)` vs `accepting`.** §Job states lists both without saying when `accepting` applies. Here reaching the human phase is `needs-you(ready-to-try)`; `accepting` is left to the feedback plan.
- **"Deny every `canUseTool` call" vs `src/session.js`.** In `auto` the session auto-allows every non-`AskUserQuestion` tool before any interceptor runs, so the spec's rule needs Task 1's flag.
- **`maxTurns` in streaming input** may count per turn or per session (Plan 1 probes assumed per prompt; unverified). The turn-cap path (nudge, then `turn-cap`) is correct either way; the manual probe observes which.

## Not in this plan

| Item | Owner |
|---|---|
| Review loops, verifier, per-task implementation, `tasks.json` handling, task reviewer, test-failure routing, the `verify`-check exit-0 rule for `implement` | Plan 3 (milestone 2) |
| Isolated router: request builder, truncation, schema validation, router log; **the S4 follow-up (auth route that keeps isolation, re-measured empty-card baseline against the unvalidated 6000 default)** — reassigned from "Plan 2" by the authority amendment above | Plan 3, the router plan (milestone 2) |
| Resuming an interrupted provisioning (this plan fails the job instead) | Plan 6 (milestone 5, restart recovery hardening) |
| Superagent view, `/api/superagent/*` routes, notifications, attach-ownership and notification-projection generalisation, Pause/Resume/Retry/answer actions, **Remove worktree**, offering `git init` | Plan 4 (milestone 3) |
| Wiring `createSuperagent` into `src/server.js` boot and `shutdown.js` (`onBeforeClose(stop)`, `onAfterClose(drain + store.flush)`) | Plan 4 (milestone 3), when the view first needs it |
| Automatic-mode brainstorm (stand-in, relay, question routing to the stand-in), manual-mode handover, read-only tool sets | Plan 5 (milestone 4) |
| Usage-cap classification and pause/resume (`usage-cap`, `cooldowns`, `setAutoContinue`), usage ledger from `result.modelUsage`, budgets (only the injected `budgetCheck` hook exists here), drift handoff at `driftHandoffPct` | Plan 6 (milestone 5) |
| Feedback triage and sub-plans, the `accepting` state | Plan 7 (milestone 6) |
| Non-Claude providers | Plan 8 (milestone 7) |
| Reserved interactive slot: nothing interactive runs in this plan; background launches are gated at `maxConcurrentSessions` so the slot is already free | Plan 5 |

**Task order and `npm test` count after each task** (every task only adds files or opt-in options, so the suite stays green throughout): 1 → 715, 2 → 724, 3 → 730, 4 → 737, 5 → 746, 6 → 750, 7 → 762, 8 → 778, 9 → 789, 10 → 789.

---

### Task 1: Shared-file changes — `src/session.js` hooks/intercept options, `createSession` cleanup on a failed start

**Files (all outside `src/superagent/`, flagged):**
- Modify: `src/session.js:281-300` (`canUseTool`), `:334-357` (`hooks`)
- Modify: `src/session-registry.js:344-376` (`createSession`'s `startSessionImpl` call)
- Modify: `tests/test-helpers.mjs:163-168` (`emitApprovalRequest` gains an optional `toolName`)
- Test: `tests/session.test.mjs` (append, next to the `sdkOptions` tests at `:652-675`), `tests/session-registry.test.mjs` (append)

**Why:** `sdkOptions` cannot carry hooks today, and adding `hooks` to `SDK_PASSTHROUGH_KEYS` would replace the git commit guard (`...passthrough` is spread after `hooks`). And `canUseTool` auto-allows every non-`AskUserQuestion` tool in `auto` (`AUTO_ALLOW_MODES` includes it, `src/permissions.js:22`), so the spec's "deny every `canUseTool` call from a worker" (§Permissions) is impossible without a flag. Both are cockpit-level options read by `startSession`; neither reaches `query()`; hand-driven sessions never pass them. Separately, `createSession` does `sessions.set(id, row)` (`:344`) before `row.handle = startSessionImpl(...)` (`:346`), so a synchronous throw leaves a handle-less row in the table for the life of the process; the runner's launch cleanup needs that row gone. The fix only changes that failure path (today auto-pilot's `fire()` already treats the throw as `errored`, `src/autopilot.js:466-495`; it simply stops leaving a ghost row).

**Interfaces:**
- Consumes: Plan 1's `sdkOptions` (`src/session.js:188`, `:237-240`).
- Produces:
  - `sdkOptions.hooks?: { [HookEvent]: HookCallbackMatcher[] }` — merged per event **after** cockpit's own matchers: `options.hooks[event] = [...(cockpitHooks[event] || []), ...extra[event]]`.
  - `sdkOptions.interceptEveryPermission?: true` — `canUseTool` skips the `AUTO_ALLOW_MODES`/`alwaysAllowTools` shortcut, so every call reaches `onApprovalRequest` (and thus the registry interceptors).
  - `tests/test-helpers.mjs`: `impl.emitApprovalRequest(input, toolName = 'ExitPlanMode')`.
  - `createSession`: if `startSessionImpl` throws synchronously, `sessions.delete(id)` (no removed-listener call: the row never started) and rethrow the same error.

- [ ] **Step 1: Write the tests** (the registry test goes in `tests/session-registry.test.mjs`)

```js
test('createSession leaves no row behind when the start function throws', () => {
  registry._reset();
  try {
    const removed = [];
    registry.addSessionRemovedListener((e) => removed.push(e));
    assert.throws(() => registry.createSession({ cwd: '/tmp', startSessionImpl: () => { throw new Error('spawn failed'); } }), /spawn failed/);
    assert.equal(registry.list().length, 0);
    assert.deepEqual(removed, []);
  } finally { registry._reset(); }
});
```

```js
test('sdkOptions.hooks adds events after the cockpit hooks without replacing the git guard', () => {
  const preCompact = async () => ({ continue: true });
  const extraBash = async () => ({ continue: true });
  const { getOptions } = startFakeSession({ sdkOptions: { hooks: { PreCompact: [{ hooks: [preCompact] }], PreToolUse: [{ matcher: 'Bash', hooks: [extraBash] }] } } });
  const { hooks } = getOptions();
  assert.equal(hooks.PreCompact[0].hooks[0], preCompact);
  assert.equal(hooks.PreToolUse.length, 2);
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
  assert.notEqual(hooks.PreToolUse[0].hooks[0], extraBash, 'cockpit git guard stays first');
  assert.equal(hooks.PreToolUse[1].hooks[0], extraBash);
  assert.equal('interceptEveryPermission' in getOptions(), false);
});

test('sdkOptions.interceptEveryPermission routes an auto-mode tool call to onApprovalRequest', () => {
  const approvalRequests = [];
  const { getOptions } = startFakeSession({ permissionMode: 'auto', sdkOptions: { interceptEveryPermission: true }, onApprovalRequest: (r) => approvalRequests.push(r) });
  getOptions().canUseTool('Bash', { command: 'curl x' }, {}); // never resolved here - do not await
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0].toolName, 'Bash');
});

// Regression guard: passes before and after this task.
test('no sdkOptions keeps the cockpit hooks and auto-allow exactly as before', async () => {
  const { getOptions } = startFakeSession({ permissionMode: 'auto' });
  assert.deepEqual(Object.keys(getOptions().hooks), ['PreToolUse']);
  assert.equal(getOptions().hooks.PreToolUse.length, 1);
  assert.deepEqual(await getOptions().canUseTool('Bash', { command: 'ls' }, {}), { behavior: 'allow', updatedInput: { command: 'ls' } });
});
```

- [ ] **Step 2: Run to verify the new ones fail**

Run: `node --test tests/session.test.mjs tests/session-registry.test.mjs`
Expected: FAIL on the hooks test, the intercept test (`hooks.PreCompact` undefined; `approvalRequests.length` 0) and the registry test (`list().length` 1); the regression guard passes.

- [ ] **Step 3: Implement** per Interfaces. Name the cockpit object `cockpitHooks` and merge with a local `mergeHooks(base, extra)`. Extend `startSession`'s doc comment with one sentence per option, naming the superagent runner as the only caller. Wrap only the `startSessionImpl(...)` call in `createSession` in `try/catch` with a one-line comment. Change `emitApprovalRequest` in `tests/test-helpers.mjs` (default keeps every existing caller unchanged).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 715 tests, 0 failures (every `tests/autopilot.test.mjs` test unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/session.js src/session-registry.js tests/session.test.mjs tests/session-registry.test.mjs tests/test-helpers.mjs
git commit -F- <<'EOF'
feat: merged extra hooks, intercept-every-permission and failed-start row cleanup
EOF
```

---

### Task 2: `src/superagent/config.js` — config, merge, contract validation

**Files:**
- Create: `src/superagent/config.js`
- Create: `tests/superagent-helpers.mjs` (shared test fixtures; not matched by `npm test`'s glob)
- Test: `tests/superagent-config.test.mjs`

**Interfaces:**
- Consumes: `readJsonChecked`, `writeJsonAtomic` (`src/json-store.js:26,40`); `costForUsage` (`src/usage.js:34`); `CLAUDE_EFFORTS` (`src/provider-registry.js:18`).
- Produces:

```js
export const PHASE_KINDS = ['author', 'review', 'per-task', 'human'];
export const WORKER_PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk']; // 'default' and 'plan' rejected
export const MILESTONE_1_PIPELINE = Object.freeze([          // spec "Suggested sequencing" step 1 fixture (builder decision 9)
  { phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['idea'], outputs: ['spec'] },
  { phase: 'accept', kind: 'human', inputs: ['spec'] },
]);
export function defaultSuperagentRoot(): string   // path.join(COCKPIT_HOME || homedir(), '.prompt-cockpit', 'superagent')
export function defaultConfig(): Defaults          // fresh deep copy each call
export function validateDefaults(d: Defaults): { errors: Issue[], warnings: Issue[] }   // Issue = { path: string, message: string }; strict v1 rule
export function validateMilestoneFixture(d: Defaults): { errors: Issue[], warnings: Issue[] }
  // validates { ...d, pipeline: MILESTONE_1_PIPELINE } with every check except the v1 composition rule; used only by createJob({ fixture: 'milestone-1' })
export function resolveProjectConfig(fileConfig: { defaults?, projects? }, projectPath: string|null): Defaults
export function createSuperagentConfig({ filePath = path.join(defaultSuperagentRoot(), 'config.json') } = {}): {
  load(): Promise<void>,                 // missing -> built-ins; corrupt -> rejects err.code 'ERR_CONFIG_CORRUPT', file untouched
  resolve(projectPath: string|null): Defaults,   // sync, after load()
  save(fileConfig): Promise<void>,       // validates defaults and every project's resolved config; err.code 'ERR_INVALID_CONFIG', err.errors
}
```

`defaultConfig()` is the spec's §Configuration JSON verbatim (pipeline, `routerModelAllowlist: ['claude-haiku-5-5']`, `routerMaxInputTokens: 6000`, `routerMaxOutputTokens: 300`, `limits`, `maxConcurrentSessions: 3`, `budget`, `workerPermissionMode: 'auto'`, `copyLocalClaudeSettings: true`, `additionalRepos: []`, `mode: 'automatic'`) with the full §Default model matrix (every entry `provider: 'claude'`; `alternate` only on `implementer`, `claude-opus-5-5`, as in the spec example):

| roles | model | maxTurns |
|---|---|---|
| router | claude-haiku-5-5 | 1 |
| stand-in | claude-opus-5-5 | 8 |
| brainstormer, spec-writer, planner | claude-opus-5-5 | 60 |
| spec-reviewer, plan-reviewer, verifier | claude-opus-5-5 | 40 |
| implementer, tester, task-reviewer | claude-sonnet-5-5 | 80 |
| triage | claude-sonnet-5-5 | 20 |

`validateDefaults` errors (each with a `path` like `pipeline[2].target`): unknown kind; the v1 composition rule of builder decision 8 (the non-review phases, in order, must match the default's six on `phase`, `kind`, `inputs`, `outputs` — reported at `pipeline` for a missing/extra/reordered phase, at `pipeline[i].inputs`/`.outputs` for a changed contract); duplicate phase id; a non-human phase without `role`; an input not produced by an earlier phase (`idea` always available); review without `target`, or target not produced earlier, or without `author`; `per-task` without `tasks` among its inputs or not produced earlier; any role (`role`, `author`, `taskReview`) missing from `models`; not exactly one `human` phase, or not last; any `models[*].provider !== 'claude'`; `effort` not in `CLAUDE_EFFORTS`; `maxTurns`, `maxRounds`, every `limits` number and `maxConcurrentSessions` not a positive integer (`backoffMinutes` a non-empty array of positive numbers; `brainstormTokens` may be `null`); `models.router.model` not in `routerModelAllowlist`; `workerPermissionMode` not in `WORKER_PERMISSION_MODES`; `mode` not `automatic`/`manual`. Warnings: a model for which `costForUsage(model, { input_tokens: 1, output_tokens: 1 })` is `null` ("unpriced; budget falls back to tokens").

`tests/superagent-helpers.mjs` (grows in later tasks) starts with `export async function tempDir(prefix)` (`fs.mkdtemp` under `os.tmpdir()`).

- [ ] **Step 1: Write the failing tests** (`tests/superagent-config.test.mjs`, temp files only)

- `the default config validates end-to-end with no errors or warnings` — `validateDefaults(defaultConfig())` → `{ errors: [], warnings: [] }` (all three 5.5 models are priced since Plan 1 Task 8).
- `the default model matrix matches the spec table` — for each row of the table above, `models[role]` has that `model`, `maxTurns` and `provider: 'claude'`; `models.implementer.alternate === 'claude-opus-5-5'`.
- `contract validation rejects broken compositions` — one test looping over cases, each mutating `defaultConfig()` and asserting `errors.some((e) => e.path === <path>)`: `per-task` with `inputs: []` (`pipeline[5].inputs`); review without `target` (`pipeline[2].target`); review targeting `testReport` at index 2 (`pipeline[2].target`); review without `author` (`pipeline[2].author`); spec with `inputs: ['plan']` (`pipeline[1].inputs`); `models['spec-writer']` deleted (`pipeline[1].role`); a second human phase (`pipeline`); accept moved before test (`pipeline`); `models.implementer.provider = 'grok'` (`models.implementer.provider`); `kind: 'deploy'` (`pipeline[1].kind`); `{ phase: 'deploy', kind: 'author', role: 'planner', inputs: ['idea'], outputs: [] }` inserted at index 1 (`pipeline`); the `spec` phase removed (`pipeline`); `MILESTONE_1_PIPELINE` as the pipeline (`pipeline`); `workerPermissionMode: 'default'` and `'plan'` (`workerPermissionMode`); router model `claude-opus-5-5` (`models.router.model`).
- `validated compositions pass` — default minus `spec-review`; default plus `{ phase: 'security-review', kind: 'review', role: 'plan-reviewer', author: 'planner', target: 'plan', maxRounds: 2 }` after `plan-review`; default with `taskReview` removed; default with `spec`'s role changed to `planner` → each `errors: []`.
- `the milestone-1 fixture validates only through its own entry point` — `validateMilestoneFixture(defaultConfig())` → `errors: []`; `validateDefaults({ ...defaultConfig(), pipeline: [...MILESTONE_1_PIPELINE] })` → an error at `pipeline`; `validateMilestoneFixture` with `models['spec-writer'].provider = 'grok'` → an error at `models['spec-writer'].provider` (the non-composition checks still apply); `MILESTONE_1_PIPELINE` is frozen.
- `an unpriced model is a warning, not an error` — `models.triage.model = 'claude-unknown-9'` → `errors: []`, one warning at `models.triage.model`.
- `project overrides merge objects and replace arrays` — file `{ defaults: { limits: { stallMinutes: 30 } }, projects: { [repo]: { pipeline: <default minus spec-review>, models: { 'spec-writer': { maxTurns: 10 } }, limits: { attemptsPerPhase: 2 } } } }` → `resolve(repo)`: pipeline deep-equals that 7-phase pipeline, `models['spec-writer']` is `{ provider: 'claude', model: 'claude-opus-5-5', maxTurns: 10 }`, `limits.attemptsPerPhase === 2`, `limits.stallMinutes === 30`, `limits.attemptsPerTask === 2`; `resolve(null)` has the default pipeline. On win32 only (`if (process.platform === 'win32')`), `resolve(repo.toUpperCase())` gives the same pipeline.
- `load tolerates a missing file and refuses a corrupt one` — missing → `resolve(null)` deep-equals `defaultConfig()`; file `'{not json'` → `load()` rejects with `code: 'ERR_CONFIG_CORRUPT'` and the file still reads `'{not json'`.
- `save refuses an invalid config and leaves the file unchanged` — existing valid file; `save({ projects: { [repo]: { pipeline: [] } } })` rejects `ERR_INVALID_CONFIG` with `err.errors.length > 0`; file bytes unchanged; a valid `save` round-trips through a fresh `createSuperagentConfig().load()`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent-config.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/config.js`.

- [ ] **Step 3: Implement `src/superagent/config.js`** per Interfaces, with a header comment naming spec §Configuration, §Phase contracts and validation, Decision 13 and Decision 17 (never writes a project's settings files).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 724 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/config.js tests/superagent-config.test.mjs tests/superagent-helpers.mjs
git commit -F- <<'EOF'
feat: superagent config with pipeline contract validation
EOF
```

---

### Task 3: `src/superagent/store.js` — events.jsonl, derived state, state.json

**Files:**
- Create: `src/superagent/store.js`
- Test: `tests/superagent-store.test.mjs`

**Interfaces:**
- Consumes: `defaultSuperagentRoot` (Task 2); `writeJsonAtomic` (`src/json-store.js:40`); `isSafeSessionId` (`src/safe-id.js:11`) for job ids.
- Produces:

```js
export const EVENT_TYPES = ['job-created', 'worktree-created', 'job-provisioned', 'job-failed', 'attempt-started', 'attempt-session', 'attempt-nudged', 'attempt-ended', 'needs-you', 'job-accepted', 'job-stopped', 'precompact'];
export function deriveJob(events: Event[]): JobState   // pure; throws if events[0].type !== 'job-created'
export function createSuperagentStore({ rootDir = path.join(defaultSuperagentRoot(), 'jobs'), now = Date.now, logImpl = console.error } = {}): {
  append(jobId, event: { type, ...payload }): Promise<Event>,  // returns { seq, at, ...event }; resolves after datasync; per-job serialised
  load(jobId): Promise<JobState>,       // rejects err.code 'ERR_EVENTS_CORRUPT' (with err.line) on an unparseable non-final line
  get(jobId): JobState | null,          // sync, from the cache append/load maintain
  listJobIds(): Promise<string[]>,      // safe-id directory names under rootDir
  jobDir(jobId): string,
  flush(): Promise<void>,               // every queued append and state.json write has landed
}
```

Event payloads (names used by every later task):
- `job-created { jobId, slug, title, idea, mode, branch, createdDate /* local YYYY-MM-DD */, repos: [{ id, origin }], pipeline, models, limits, workerPermissionMode, copyLocalClaudeSettings }`
- `worktree-created { repo /* id */, worktree, branch, baseSha, settingsCopy }`; `job-provisioned {}` (every repo's worktree exists); `job-failed { error }`
- `attempt-started { attemptId, phase, task /* null */, role, model, n, recovery, previousAttemptId, dir }`; `attempt-session { attemptId, sessionId }`; `attempt-nudged { attemptId, kind /* 'result' | 'turn-cap' */ }`
- `attempt-ended { attemptId, outcome, reason?, signature?, summary?, artifacts?, commits?, question? }`
- `needs-you { reason /* 'ready-to-try' | 'question' | 'stuck' */, detail }`; `job-accepted {}`; `job-stopped {}`; `precompact { attemptId, trigger }`

`JobState`: `{ jobId, slug, title, idea, mode, branch, createdAt, createdDate, repos: [{ id, origin, worktree, baseSha, settingsCopy }], pipeline, models, limits, workerPermissionMode, copyLocalClaudeSettings, state, reason, detail, phaseIndex, phaseId, attempts: Attempt[], lastSeq }`; `Attempt`: `{ attemptId, phase, task, role, model, n, recovery, previousAttemptId, dir, sessionId, startedAt, endedAt, outcome, reason, signature, summary, question, nudges, precompacts }`. Derivation: `state` starts `provisioning`; `job-provisioned` → `running`; `needs-you` sets `state`/`reason`/`detail`; `job-accepted` → `done`; `job-stopped` → `stopped`; `job-failed` → `failed` (`reason: 'job-failed'`, `detail: { error }`). `phaseIndex` increments when an `attempt-ended { outcome: 'done' }` belongs to `pipeline[phaseIndex].phase`; `phaseId = pipeline[phaseIndex]?.phase ?? null`.

**Torn-tail rule** (the algorithm the tests do not fully determine): on the first append or load of a job in this process, read `events.jsonl`; if it is non-empty and does not end in `\n`, the bytes after the last `\n` are a torn line — `load` ignores them, and before the next append the store truncates the file to `lastIndexOf('\n') + 1` and logs `superagent: dropped a torn final line in <file>`. Any other unparseable line is corruption: refuse, never rewrite. Each append opens the file with `'a'`, writes one line, `datasync()`s and closes, then queues `writeJsonAtomic(<jobDir>/state.json, deriveJob(events))` on the same per-job chain.

- [ ] **Step 1: Write the failing tests** (`rootDir` in a temp dir, injected `now`)

```js
test('a torn final line is ignored and the next append starts on a fresh line', async () => {
  const rootDir = await tempDir('sa-store-');
  const a = createSuperagentStore({ rootDir, now: () => 1000, logImpl: () => {} });
  await a.append('j1', jobCreated());
  await a.append('j1', { type: 'needs-you', reason: 'stuck', detail: {} });
  const file = path.join(rootDir, 'j1', 'events.jsonl');
  await fs.appendFile(file, '{"seq":3,"type":"job-acc');          // hard kill mid-append
  const b = createSuperagentStore({ rootDir, now: () => 2000, logImpl: () => {} });
  assert.equal((await b.load('j1')).state, 'needs-you');
  const ev = await b.append('j1', { type: 'job-stopped' });
  assert.equal(ev.seq, 3);
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) JSON.parse(line);                       // no glued, corrupt middle line
  assert.equal((await createSuperagentStore({ rootDir, logImpl: () => {} }).load('j1')).state, 'stopped');
});
```

`jobCreated(over)` goes into `tests/superagent-helpers.mjs`: a `job-created` payload with `jobId: 'j1'`, `pipeline: MILESTONE_1_PIPELINE`, `models: defaultConfig().models`, `limits: defaultConfig().limits`, one repo `{ id: 'primary', origin: '/repo' }`, spread with `over`; plus `provisionedEvents(over)` → `[jobCreated(over), worktree-created per repo, { type: 'job-provisioned' }]`.

- `append assigns increasing seq and at, and load returns the same events` — three appends → `seq` 1, 2, 3, `at` from `now`; a fresh store's `load` gives a `JobState` with `lastSeq === 3`.
- `a corrupt middle line is refused and left on disk` — replace line 2 with `nope`; `load` rejects `{ code: 'ERR_EVENTS_CORRUPT', line: 2 }`; file bytes unchanged.
- `deriveJob tracks provisioning, attempts, outcomes and phase advance` — `job-created` alone → `state === 'provisioning'`; after `worktree-created` still `provisioning`, after `job-provisioned` → `running`; then `attempt-started a1 (spec, n 1)`, `attempt-session a1 s1`, `attempt-ended a1 failed no-result`, `attempt-started a2 (n 2, recovery true, previousAttemptId a1)`, `attempt-ended a2 done` → `attempts.length === 2`, `attempts[0].sessionId === 's1'`, `attempts[0].reason === 'no-result'`, `phaseIndex === 1`, `phaseId === 'accept'`, `state === 'running'`; then `needs-you ready-to-try` → `state === 'needs-you'`, `reason === 'ready-to-try'`; then `job-accepted` → `state === 'done'`.
- `state.json mirrors deriveJob and a stale state.json is ignored on load` — append `provisionedEvents()`; after `flush()`, `state.json` deep-equals `deriveJob(events)`; overwrite `state.json` with `{ state: 'done' }`; a fresh store's `load` still returns `state: 'running'`.
- `concurrent appends to one job land in call order with unique seq` — `Promise.all` of 10 appends without awaiting in between → seqs 1..10 in file order matching call order (payload `i`).

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent-store.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/store.js`.

- [ ] **Step 3: Implement `src/superagent/store.js`** per Interfaces and the torn-tail rule; header comment cites spec §Restart and recovery ("`events.jsonl` is the source of truth; `state.json` is a derived cache").

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 730 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/store.js tests/superagent-store.test.mjs tests/superagent-helpers.mjs
git commit -F- <<'EOF'
feat: superagent job event log with derived state and torn-tail repair
EOF
```

---

### Task 4: `src/superagent/worktree.js` — worktrees, settings copy, ledger archive, orphans

**Files:**
- Create: `src/superagent/worktree.js`
- Test: `tests/superagent-worktree.test.mjs` (real `git` in temp repos)

**Interfaces:**
- Consumes: `node:child_process` `execFile`; `node:fs/promises` `cp`, `copyFile`, `mkdir`, `writeFile`.
- Produces:

```js
export const BRANCH_PREFIX = 'superagent/';
export function slugify(title: string, jobId: string): string   // lower-case, [^a-z0-9]+ -> '-', trimmed, max 40, + '-' + jobId.slice(0, 8); empty title -> 'job'
export function defaultGit(args: string[], { cwd }): Promise<{ code: number, stdout: string, stderr: string }>  // never rejects on a non-zero exit
export function repoIds(primary: string, additional: string[]): [{ id, origin }]   // 'primary', then basenames deduped -2, -3
export async function createWorktree({ git = defaultGit, origin, worktree, branch, copyLocalClaudeSettings }):
  Promise<{ worktree, branch, baseSha, settingsCopy: 'copied' | 'absent' | 'disabled' | 'skipped-not-ignored' }>
  // errors (err.code): ERR_NOT_GIT_REPO, ERR_NO_COMMITS, ERR_BRANCH_EXISTS, ERR_WORKTREE_PATH_EXISTS
export async function inspectWorktree({ git = defaultGit, worktree }): Promise<{ exists, head, branch, dirty }>
export async function archiveLedger({ worktree, jobId, destDir }): Promise<{ copied: boolean }>  // <worktree>/.superpowers/superagent/<jobId>/ -> destDir
export async function listOrphanWorktrees({ git = defaultGit, repos: string[], knownBranches: Set<string> }): Promise<[{ repo, worktree, branch }]>
```

`createWorktree`: `git rev-parse --show-toplevel` in `origin` (fail → `ERR_NOT_GIT_REPO`); `git rev-parse --verify HEAD` (fail → `ERR_NO_COMMITS`); `git show-ref --verify --quiet refs/heads/<branch>` (exists → `ERR_BRANCH_EXISTS`, never reuse); path exists → `ERR_WORKTREE_PATH_EXISTS`; `git worktree add -b <branch> <worktree> HEAD`; write `<worktree>/.superpowers/superagent/.gitignore` = `*\n`; settings copy: `disabled` when the toggle is off, `absent` when `<origin>/.claude/settings.local.json` does not exist, `skipped-not-ignored` when `git check-ignore -q .claude/settings.local.json` in the worktree exits non-zero, else copy to `<worktree>/.claude/settings.local.json` → `copied`. Nothing here pushes, removes or prunes.

`tests/superagent-helpers.mjs` gains `initRepo(dir, { ignoreLocalSettings = true } = {})`: `git init -q`, local `user.email`/`user.name`, `README.md`, a `.gitignore` containing `.claude/settings.local.json` when the flag is set, one commit; returns the HEAD sha.

- [ ] **Step 1: Write the failing tests**

- `createWorktree makes branch superagent/<slug> from HEAD and records the base` — `inspectWorktree` → `exists: true`, `branch: 'superagent/add-hello-12345678'`, `head === baseSha === initRepo's sha`, `dirty: false`; `slugify('Add hello!', '12345678-aaaa')` is `'add-hello-12345678'`; `repoIds('/a/app', ['/b/lib', '/c/lib']).map((r) => r.id)` is `['primary', 'lib', 'lib-2']`.
- `createWorktree refuses a non-repo, an unborn repo and an existing branch` — plain temp dir → `ERR_NOT_GIT_REPO`; `git init` with no commit → `ERR_NO_COMMITS`; second call with the same branch → `ERR_BRANCH_EXISTS`, and the first worktree is still listed by `git worktree list`.
- `local settings are copied only when the repo ignores them; the original is untouched` — origin has `.claude/settings.local.json` = `{"permissions":{"allow":["Bash(npm test)"]}}`: ignored repo → `copied`, worktree copy byte-equal, original bytes and mtime unchanged; repo without the ignore line → `skipped-not-ignored`, no file in the worktree; toggle off → `disabled`; no source → `absent`.
- `the ledger directory is ignored inside the worktree` — write `<worktree>/.superpowers/superagent/j1/attempts/spec/a1/result.json`; `git status --porcelain` in the worktree prints nothing.
- `inspectWorktree reports dirt and a missing path` — after writing `x.txt`: `dirty: true`; for a non-existent path: `{ exists: false, head: null, branch: null, dirty: false }`.
- `archiveLedger copies the job ledger and leaves the worktree intact` — `destDir/attempts/spec/a1/result.json` equals the source; the source still exists; a job with no ledger → `{ copied: false }`.
- `listOrphanWorktrees lists superagent worktrees no job knows and removes nothing` — two worktrees on `superagent/a-…` and `superagent/b-…`; `knownBranches = new Set(['superagent/a-…'])` → exactly the `b` entry (path compared case-insensitively on win32); both directories still exist; a non-superagent worktree is never listed.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent-worktree.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/worktree.js`.

- [ ] **Step 3: Implement `src/superagent/worktree.js`** per Interfaces. Header comment cites Decisions 10–12 and the "never delete automatically" rule.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 737 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/worktree.js tests/superagent-worktree.test.mjs tests/superagent-helpers.mjs
git commit -F- <<'EOF'
feat: superagent git worktrees with settings copy and ledger archive
EOF
```

---

### Task 5: `src/superagent/results.js` — attempt directories, atomic read, validation

**Files:**
- Create: `src/superagent/results.js`
- Test: `tests/superagent-results.test.mjs`

**Interfaces:**
- Consumes: `JobState` (Task 3); `defaultGit` (Task 4).
- Produces:

```js
export const RESULT_FILE = 'result.json';
export function attemptDir(primaryWorktree, { jobId, phase, task, attemptId }): string
  // <primaryWorktree>/.superpowers/superagent/<jobId>/attempts/<phase>[/<task>]/<attemptId>
export function artifactPaths(job): { brief, spec, plan, tasks, testReport }   // relative, forward slashes:
  // brief: docs/superpowers/jobs/<slug>/brief.md        spec: docs/superpowers/specs/<createdDate>-<slug>-design.md
  // plan:  docs/superpowers/plans/<createdDate>-<slug>.md tasks: docs/superpowers/jobs/<slug>/tasks.json
  // testReport: docs/superpowers/jobs/<slug>/test-report.md
export async function readResult(dir): Promise<{ state: 'missing' } | { state: 'unparseable', error: string } | { state: 'present', value: object }>
  // reads only result.json; result.json.tmp is never read
export async function validateResult(value, { expected: { jobId, phaseId, taskId, attemptId }, phase, job, git = defaultGit }):
  Promise<{ ok: true, result: NormalisedResult } | { ok: false, errors: string[] }>
export function outcomeForResult(result: NormalisedResult): { outcome: 'done' } | { outcome: 'question', question } | { outcome: 'failed', reason: 'failed' | 'blocked' }
```

Validation (spec §Worker contract), errors as plain strings, first error first: each of `jobId`, `phaseId`, `taskId`, `attemptId` strictly equals `expected` (`identity mismatch: attemptId`); `status` ∈ `done|blocked|failed`; `artifacts` an array of relative paths that do not escape the primary worktree; `summary` a non-empty string (normalised to its first 60 words); `question` null or a non-empty string, and non-null only with `status: 'blocked'`; `evidence` optional, `evidence.commits` an array of `"sha"` or `{ repo, sha }` with `repo` a job repo id, `evidence.checks` an array of `{ cmd: string, exit: integer }`; for `done`, every path in `artifactPaths(job)` for each of `phase.outputs` exists in the primary worktree, is non-empty, is **committed by a listed primary-repo commit** (`git diff-tree --no-commit-id --name-only -r <sha>` includes the path; error `output not committed by a listed commit: <path>`) and is clean (`git status --porcelain -- <path>` prints nothing; error `output changed after its commit: <path>`) — builder decision 14; every commit resolves (`git rev-parse --verify --quiet <sha>^{commit}` in that repo's worktree), is an ancestor of `refs/heads/<job.branch>` (`git merge-base --is-ancestor`), and is **not** an ancestor of that repo's `baseSha`; for `phase.kind === 'review'`, `verdict` ∈ `approve|changes` and each finding has `id`, `severity` ∈ `blocker|major|minor`, non-empty `text`, `disposition` matching `fixed`, `open` or `declined: <non-empty reason>`. `NormalisedResult` = the input with the truncated summary and `commits: [{ repo, sha /* full */ }]`.

- [ ] **Step 1: Write the failing tests** (`fixture()` in this file: `initRepo` + `createWorktree` from Task 4, `job` from `deriveJob(provisionedEvents(…))` with that worktree and `baseSha`, the spec output written **and committed** in the worktree as `specSha`; `goodResult(over)` builds a valid `done` result for attempt `a2` listing `specSha`)

```js
test('a result carrying an earlier attempt\'s id is invalid-result', async () => {
  const { job, phase, dir } = await fixture();                 // spec output committed, attempt a2 launched
  await writeResult(dir, goodResult({ attemptId: 'a1' }));      // copied forward from attempt a1
  const read = await readResult(dir);
  const v = await validateResult(read.value, { expected: { jobId: job.jobId, phaseId: 'spec', taskId: null, attemptId: 'a2' }, phase, job });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /identity mismatch: attemptId/);
});
```

- `attemptDir and artifactPaths follow the spec layout` — exact strings for a phase without and with a task; `artifactPaths(job).spec === 'docs/superpowers/specs/2026-11-03-add-hello-12345678-design.md'`.
- `readResult ignores a tmp-only publish and reports an unparseable file` — only `result.json.tmp` → `missing`; `result.json` = `'{"status":'` → `unparseable`.
- `schema errors are reported` — each case gives `ok: false`: `status: 'maybe'`; `question: 'Which?'` with `status: 'done'`; `artifacts: ['/abs/x']`; `artifacts: ['../x']`; `summary: ''`; `evidence.checks: [{ cmd: 'npm test' }]`.
- `a long summary is truncated, not rejected` — 70 words → `ok: true`, 60 words.
- `done without its required output, or with an empty one, is invalid` — spec file absent (fresh worktree, nothing committed) → `ok: false`; zero bytes committed → `ok: false`; the `fixture()` default → `ok: true`.
- `an author phase's output must be committed by a listed commit` — a non-empty spec written but never committed, with an unrelated listed commit → `ok: false` (`output not committed by a listed commit`); the spec committed but `evidence.commits: []` → `ok: false`; committed and listed, then edited again in the worktree → `ok: false` (`output changed after its commit`); committed and listed → `ok: true`.
- `commit evidence must be new work on the job branch` — `specSha` → `ok: true` with the full sha; a sha absent from the repo → `ok: false`; `job.repos[0].baseSha` (pre-job commit) → `ok: false`; a commit on another branch of the origin → `ok: false`; `{ repo: 'nope', sha }` → `ok: false`.
- `review phases require verdict and well-formed findings` — review phase with no `verdict` → `ok: false`; disposition `'declined:'` → `ok: false`; `'declined: out of scope'` → `ok: true`; the same `verdict`/`findings` on an author phase are ignored (`ok: true`).

`outcomeForResult` is covered by Task 7's table.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent-results.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/results.js`.

- [ ] **Step 3: Implement `src/superagent/results.js`** per Interfaces.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 746 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/results.js tests/superagent-results.test.mjs
git commit -F- <<'EOF'
feat: superagent attempt result reading and validation
EOF
```

---

### Task 6: `src/superagent/prompts.js` and role templates

**Files:**
- Create: `src/superagent/prompts.js`
- Create: `prompts/superagent/contract.md` (shared by every role), `prompts/superagent/spec-writer.md`
- Test: `tests/superagent-prompts.test.mjs`

**Interfaces:**
- Consumes: `artifactPaths` (Task 5); `JobState`/`Attempt` (Task 3).
- Produces:

```js
export const UNATTENDED_DENY_MESSAGE = 'You are running unattended. Put your question in `result.json` with `status: blocked`.';
export const RECOVERY_NOTE = 'check every worktree\'s git status and log, and the ledger, before repeating work; continue from `handoff.md` if present';
export function templatesDir(): string   // fileURLToPath(new URL('../../prompts/superagent/', import.meta.url))
export async function hasTemplate(role, { projectDir }): Promise<boolean>
export async function buildWorkerPrompt({ role, job, phase, attempt, projectDir }): Promise<{ system: string, card: string }>
  // system = role template + '\n\n' + contract.md; card = job card; err.code 'ERR_NO_TEMPLATE' when no role template
export function nudgeText(kind: 'result' | 'turn-cap', attempt): string
```

Template lookup: `<projectDir>/.superpowers/superagent/prompts/<role>.md` first, then `templatesDir()/<role>.md`. `contract.md` always comes from `templatesDir()` (not overridable, so the contract can't be dropped by an override).

**Job card** (`card`): a heading line `# Superagent job card`, then one fenced `json` block with exactly: `jobId`, `phaseId`, `taskId`, `attemptId`, `title`, `mode`, `idea` (verbatim), `repos` (`[{ id, worktree, branch }]`, primary first), `inputs` (`{ key: path }` from `artifactPaths`, `idea` excluded), `outputs` (`{ key: path }`), `attemptDir`, `round: null`, `previousFindings: null`, `recoveryNote` (`RECOVERY_NOTE` when `attempt.recovery`, else `null`), `previousAttemptDir` (the previous attempt's `dir` or `null`).

**`contract.md` must state** (the test asserts these substrings): the full result JSON with keys `jobId`, `phaseId`, `taskId`, `attemptId`, `status`, `artifacts`, `summary`, `question`, `evidence`; that identity fields are copied from the job card; publishing by writing `result.json.tmp` in `attemptDir` and then `rename` to `result.json` as the final action; `Do not start the next phase`; never asking the user directly (`AskUserQuestion` is unavailable; a question goes in `question` with `status: blocked`); and `If the job card has a recovery note` (follow it, continue from `handoff.md` in `previousAttemptDir`). **`spec-writer.md`**: write the design for the idea at `outputs.spec`, commit it on the job branch in the primary worktree and list the commit in `evidence.commits`, never push, do not write a plan or invoke the writing-plans skill.

`nudgeText('result', a)`: names `a.dir` and says to publish `result.json` now via `result.json.tmp` + rename. `nudgeText('turn-cap', a)`: says the turn limit was reached, asks for `handoff.md` in `a.dir` (state, next steps) and then `result.json`.

- [ ] **Step 1: Write the failing tests** (fixture: `job` = `deriveJob([jobCreated({ slug: 'add-hello-12345678', createdDate: '2026-11-03' }), worktree-created…])`, `phase = job.pipeline[0]`, `attempt` = an `Attempt` with `dir`, `emptyDir` = a temp dir with no overrides)

```js
test('prompt surface: every role template plus the contract states the worker contract', async () => {
  const roles = (await fs.readdir(templatesDir())).filter((f) => f.endsWith('.md') && f !== 'contract.md').map((f) => f.slice(0, -3));
  assert.ok(roles.includes('spec-writer'));
  for (const role of roles) {
    const { system } = await buildWorkerPrompt({ role, job, phase, attempt, projectDir: emptyDir });
    for (const needle of ['result.json.tmp', 'rename', '"attemptId"', '"status"', 'blocked', 'Do not start the next phase', 'If the job card has a recovery note', 'AskUserQuestion']) {
      assert.ok(system.includes(needle), `${role}: missing ${needle}`);
    }
  }
});
```

- `the job card carries every field and the recovery note only on retries` — parse the card's JSON block: identity fields equal the attempt; `idea` equals a multi-line idea byte for byte; `repos[0].id === 'primary'`; `outputs.spec` equals `artifactPaths(job).spec`; `attemptDir === attempt.dir`; `recoveryNote === null` for `recovery: false`; with `recovery: true, previousAttemptId: 'a1'` → `recoveryNote === RECOVERY_NOTE` and `previousAttemptDir` is `a1`'s dir.
- `a missing role template fails and a project override wins` — `role: 'planner'` → rejects `ERR_NO_TEMPLATE`; `hasTemplate('planner', …)` false; a project override `spec-writer.md` containing `OVERRIDE-MARKER` → `system` contains it and still contains `result.json.tmp`.
- `nudge texts name the attempt directory and ask for handoff.md on a turn cap` — `nudgeText('result', a)` includes `a.dir` and `result.json`; `nudgeText('turn-cap', a)` includes `handoff.md`, `a.dir` and `result.json`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent-prompts.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/prompts.js`.

- [ ] **Step 3: Implement** `src/superagent/prompts.js` and both templates per Interfaces (templates in plain English, each under ~60 lines).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 750 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/prompts.js prompts/superagent/contract.md prompts/superagent/spec-writer.md tests/superagent-prompts.test.mjs
git commit -F- <<'EOF'
feat: superagent worker prompts, job card and prompt-surface test
EOF
```

---

### Task 7: `src/superagent/sequencer.js` — pure decisions and limits

**Files:**
- Create: `src/superagent/sequencer.js`
- Test: `tests/superagent-sequencer.test.mjs` (pure; jobs built with `deriveJob` from event arrays)

**Interfaces:**
- Consumes: `deriveJob`, `JobState` (Task 3); `outcomeForResult` (Task 5) for its table test.
- Produces:

```js
export const CONSUMING_OUTCOMES = new Set(['done', 'failed', 'question']);
export const RUNNABLE_KINDS = new Set(['author', 'human']);
export function attemptsFor(job, phase, task = null): Attempt[]        // start order
export function attemptCap(limits, task): number                       // task ? attemptsPerTask : attemptsPerPhase
export function backoffMs(limits, failedCount): number                 // backoffMinutes[min(failedCount - 1, len - 1)] * 60_000
export function failureSignature(reason, firstLine = ''): string
export function nextAction(job, { now, liveSessions, maxConcurrentSessions }): Action
// Action = { type: 'none' }
//        | { type: 'wait', until: number | null, why: 'backoff' | 'concurrency' }
//        | { type: 'needs-you', reason: 'ready-to-try' | 'question' | 'stuck', detail }
//        | { type: 'launch', phase, task: null, role, model, effort /* string | null */, maxTurns, n, recovery, previousAttemptId }
```

`failureSignature`: `${reason}|${line}` where `line` is the first line of `firstLine`, lower-cased, then in this order: `/\b0x[0-9a-f]+\b/g` → `#`, `/\b[0-9a-f]{7,}\b/g` → `#`, `/\d+/g` → `#`, whitespace collapsed, trimmed, cut to 200 chars. (Revision 1 applied the 7-hex rule before handling `0x`, giving `#x#`.)

**`nextAction` order** (the algorithm; first match wins):
1. `job.state` is not `running` → `none`.
2. `phase = job.pipeline[job.phaseIndex]`; `phase.kind === 'human'` → `needs-you ready-to-try { phase: phase.phase }`.
3. An attempt for `phase` with no `outcome` → `none` (one live attempt per job).
4. `last` = latest attempt for `(phase, null)`; `last?.outcome === 'question'` → `needs-you question { attemptId, question: last.question }`.
5. `used` = consuming attempts; `used >= attemptCap(...)` → `needs-you stuck { phase, task: null, why: 'attempt-cap', lastReason: last.reason, signature: last.signature }`.
6. The last `limits.repeatedErrorStop` consuming attempts are all `failed` with one equal signature → `needs-you stuck { …, why: 'repeated-error' }`.
7. `last?.outcome === 'failed'` and `now < last.endedAt + backoffMs(limits, <failed count>)` → `wait backoff`.
8. `liveSessions >= maxConcurrentSessions` → `wait concurrency` (`until: null`).
9. `launch` with `role = phase.role`, `model`/`maxTurns` from `job.models[role]`, `effort = job.models[role].effort ?? null`, `n = used + 1`, `recovery = last != null`, `previousAttemptId = last?.attemptId ?? null`.

- [ ] **Step 1: Write the failing tests** (jobs = `deriveJob([...provisionedEvents(), ...attemptEvents])`; event helper `ev(type, payload)`; `T0 = 1_000_000`; default limits: 3 per phase, 2 per task, back-off `[1, 5]`, repeated-error 2)

- `a fresh job launches attempt 1 of its first phase without a recovery note` → `{ type: 'launch', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', effort: null, maxTurns: 60, n: 1, recovery: false, previousAttemptId: null }`.
- `a done attempt moves to the human phase, which needs the user` → `{ type: 'needs-you', reason: 'ready-to-try', detail: { phase: 'accept' } }`.
- `a live attempt blocks any further launch` → `none` while `a1` has no outcome.
- `back-off is 1 minute after the first failure and 5 after the second` — one `failed no-result` ended at `T0`: at `T0 + 59_999` → `wait backoff until T0 + 60_000`; at `T0 + 60_000` → `launch n 2, recovery true, previousAttemptId 'a1'`; after a second failure (different signature) ended at `T1`: `until === T1 + 300_000`.
- `three consuming attempts reach the phase cap` → `needs-you stuck` with `why: 'attempt-cap'` (signatures all different).
- `the same failure signature twice stops retrying before the cap` → after two `failed` with signature `'invalid-result|identity mismatch: attemptid'` → `stuck`, `why: 'repeated-error'`.
- `interrupted and stopped attempts do not consume` — `a1 interrupted` → `launch n 1, recovery true, previousAttemptId 'a1'`, no back-off.
- `a question outcome asks the user` → `needs-you question { attemptId: 'a1', question: 'Which DB?' }`.
- `concurrency: no launch when live sessions are at the limit` — `liveSessions: 3, maxConcurrentSessions: 3` → `wait concurrency`; `2` → `launch`.
- `a provisioning job launches nothing` — `deriveJob([jobCreated()])` → `none`.
- `failure signatures are stable across addresses, hashes and counters` — `failureSignature('failed', 'Error at 0x1f3a9c2d line 42\nmore')` → `'failed|error at # line #'`; equal pairs: `'Error at 0x7ffe line 9'` / `'Error at 0x1f3a9c2d line 42'`; `'commit 3f9a1c2 missing'` / `'commit 88ab12e0d missing'`; `'attempt-12 timed out'` / `'attempt-7 timed out'`; a different pair stays different: `'ENOENT spec.md'` / `'EACCES spec.md'`; `failureSignature('no-result')` → `'no-result|'`.
- `helpers: attemptCap and outcomeForResult` — `attemptCap(limits, null) === 3`, `attemptCap(limits, 'T1') === 2`; `outcomeForResult` for `done` → `{ outcome: 'done' }`, `failed` → `{ outcome: 'failed', reason: 'failed' }`, `blocked` + question → `{ outcome: 'question', question }`, `blocked` without → `{ outcome: 'failed', reason: 'blocked' }`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent-sequencer.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/sequencer.js`.

- [ ] **Step 3: Implement `src/superagent/sequencer.js`**: pure, no imports beyond Task 3's types. Header comment cites Decision 2 and §Retry, stall and repetition limits, and that the stall deadline is enforced by the runner (it needs the live row) using `limits.stallMinutes`.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 762 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/sequencer.js tests/superagent-sequencer.test.mjs
git commit -F- <<'EOF'
feat: superagent sequencer decisions with attempt, back-off and repeat limits
EOF
```

---

### Task 8: `src/superagent/runner.js` — launch, watch, deny, nudge, stall, PreCompact

**Files:**
- Create: `src/superagent/runner.js`
- Test: `tests/superagent-runner.test.mjs` (real `src/session-registry.js` + `fakeStartSession`, `registry._reset()` in `finally`)

**Interfaces:**
- Consumes: `registry.createSession({ cwd, provider, model, effort, permissionMode, name, sdkOptions })`, `registry.sendInput(id, text)`, `registry.closeSession(id)`, `registry.get(id)` (row fields `state`, `queue`, `pendingApprovals`, `eventLog.{nextSeq, entries}`), interceptor callback shape `({ row, request }) => PermissionResult | null` and removed-listener shape `({ id, reason })` (`src/session-registry.js:59-115`); Task 1's `sdkOptions.hooks`/`interceptEveryPermission`; Tasks 3, 5, 6, 7.
- Produces:

```js
export const PROGRESS_TYPES = new Set(['assistant', 'user', 'result']);   // builder decision 17
export function createRunner({ registry, store, results = { readResult, validateResult }, git = defaultGit, now = Date.now, idImpl = randomUUID, logImpl = console.error, projectDirFor = (job) => job.repos[0].origin }): {
  launch(job, action /* Task 7 'launch' */): Promise<{ attemptId } | { error: 'stopping' | 'busy' | 'store-failed' | 'launch-failed' | 'job-not-running' }>,
  review(job): Promise<void>,          // retries a pending end; progress, completion, nudge, stall for the job's live attempt
  reconcile(job): Promise<void>,       // start-up: every started-without-ended attempt -> processed result or 'interrupted'
  stopAttempt(jobId): Promise<void>,   // ends the live attempt 'stopped' (waits for a finish already in progress)
  onApprovalRequest({ row, request }): PermissionResult | null,   // synchronous
  onSessionRemoved({ id, reason }): void,                          // synchronous; async work is tracked
  liveCount(): number,                 // live + reserved attempts
  isLive(jobId): boolean,
  setStopping(flag: boolean): void,
  drain(): Promise<void>,              // every tracked removal/finish promise has settled
}
```

The live entry (one per job, keyed by `jobId`, indexed by `sessionId`): `{ jobId, attemptId, role, phase, dir, sessionId, scannedThrough, lastProgressAt, promptSeq, sawResult, sawMaxTurns, lastResultSubtype, nudge, finishing, removedReason, pendingEnd }`.

**One finish per attempt.** `claim(live)` is synchronous: it returns `false` if `live.finishing` is set, else stores the caller's work as `live.finishing` (a promise) and returns `true`. Every path that may end an attempt — turn-ended processing, stall, removal, `stopAttempt`, launch failure — claims **before its first await**. `finish(live, payload)` (only ever called by the claimer): mark `intended`, `append attempt-ended`; on success drop the live entry; on rejection keep `live.pendingEnd = payload` (the next `review` retries that append and does nothing else until it lands); in both cases `closeSession` if the row is still there (swallowed). A non-terminal processing step (the nudge) clears `live.finishing` when done and, if `live.removedReason` was recorded meanwhile, runs the removal path itself.

**`launch`** — each step's failure exit is listed; "release" means drop the reservation, "in flight" means `attempt-started` is on disk with no ending (next start reconciles it to `interrupted`):
1. Synchronously: `stopping` → `{ error: 'stopping' }`; `isLive(job.jobId)` → `{ error: 'busy' }`; reserve the live entry (counts in `liveCount`).
2. `mkdir(dir)` and `await store.append(attempt-started { attemptId, phase, task, role, model, n, recovery, previousAttemptId, dir })` → rejects: release, `{ error: 'store-failed' }`.
3. After that await: `stopping` → release (in flight), `{ error: 'stopping' }`; `store.get(jobId).state !== 'running'` → claim, `finish({ outcome: 'stopped' })`, `{ error: 'job-not-running' }`.
4. `await buildWorkerPrompt(...)` → rejects: claim, `finish({ outcome: 'failed', reason: 'launch-failed', signature })`, `{ error: 'launch-failed' }`. Then repeat step 3's checks.
5. `row = registry.createSession({ cwd: job.repos[0].worktree, provider: 'claude', model, effort: action.effort ?? undefined, permissionMode: job.workerPermissionMode, name: null, sdkOptions: { additionalDirectories: job.repos.slice(1).map((r) => r.worktree), maxTurns, appendSystemPrompt: system, interceptEveryPermission: true, hooks: { PreCompact: [{ hooks: [preCompactHook] }] } } })` → throws (Task 1 guarantees no row is left): claim, `finish(launch-failed)`. Otherwise set `live.sessionId = row.id`, `promptSeq = scannedThrough = row.eventLog.nextSeq - 1`, `lastProgressAt = now()` **synchronously** (the interceptor must find it; mirrors `src/autopilot.js:517`).
6. `await store.append(attempt-session)` → rejects: claim, `finish(launch-failed)` (closes the session), `{ error: 'launch-failed' }`.
7. After that await: if `live.finishing` is set or `registry.get(row.id)` is gone, the removal path owns the attempt → return `{ attemptId }` without sending. If `stopping` → return without sending (shutdown closes the row; the attempt stays in flight).
8. `await registry.sendInput(row.id, card)` inside `try`: rejects → if the row is gone, removal owns it; else claim, `finish(launch-failed)`.
Model, effort and `maxTurns` come only from the action (the job's matrix), never from session defaults.

**`preCompactHook(input)`**: `await store.append(job.jobId, { type: 'precompact', attemptId, trigger: input.trigger })` (errors logged, swallowed); returns `{ continue: true }`.

**`onApprovalRequest`**: look up the live entry by `row.id`; none → `null`. `role === 'brainstormer' && request.toolName === 'AskUserQuestion'` → `null` (§Questions from unattended workers; manual mode reaches the user, automatic mode is routed in Plan 5). Anything else → `{ behavior: 'deny', message: UNATTENDED_DENY_MESSAGE }`.

**`review(job)`** for the live entry: `pendingEnd` → retry its append, return. Row gone or `finishing` set → return. Scan `eventLog.entries` with `seq > scannedThrough`: an entry whose `message.type` is in `PROGRESS_TYPES` sets `lastProgressAt = now()`; a `result` with `seq > promptSeq` sets `sawResult`, `lastResultSubtype = message.subtype`, and `sawMaxTurns ||= subtype === 'error_max_turns'`. **Turn ended** = `row.state === 'idle' && row.queue.length === 0 && sawResult` → claim, then:
1. `results.readResult(dir)`; `present` → `results.validateResult` → valid: `finish(outcomeForResult(result) + summary/artifacts/commits/question)`; invalid: `finish(failed invalid-result, signature from errors[0])`.
2. Not present and `nudge === null` → `kind = lastResultSubtype === 'error_max_turns' ? 'turn-cap' : 'result'`; `await append attempt-nudged { kind }`; `promptSeq = row.eventLog.nextSeq - 1`, `sawResult = false`; `await sendInput(nudgeText(kind, …))` in `try` (rejection with the row gone → removal owns it); release the claim (see above).
3. Not present after the nudge → `finish(failed)` with `turn-cap` if `sawMaxTurns`, else `invalid-result` if `unparseable`, else `no-result`.
Not ended, `row.pendingApprovals.length === 0`, and `now() - lastProgressAt >= limits.stallMinutes * 60_000` → claim, `finish(failed stalled)`.

**`onSessionRemoved`**: find the live entry by `id`; none or `intended` → ignore. `stopping` → drop the in-memory entry only (spec §Restart: shutdown leaves attempts in flight for the next start's reconcile). `finishing` set → record `live.removedReason = reason` and return. Else claim and track: `readResult` + validate → valid finishes with its outcome; otherwise `finish(failed no-result, failureSignature('no-result', 'session ' + reason))`.

**`stopAttempt(jobId)`**: if `live.finishing` → await it; if the entry is still live (a nudge released the claim) → claim, `finish({ outcome: 'stopped' })`.

**`reconcile(job)`**: for each attempt with no `outcome`: valid result in `attempt.dir` → append `attempt-ended` with its outcome (same payload as `review`); else (missing, unparseable or invalid) → `attempt-ended { outcome: 'interrupted' }`.

`tests/superagent-helpers.mjs` gains:
- `sessionFactory(registryModule)` → `{ registry: wrapped, impls: Map<rowId, impl>, calls: CreateSessionOpts[], failNextCreate(err) }`, where `wrapped = { ...registryModule, createSession(o) { … } }` — a spread of the real module (so `get`, `list`, `sendInput`, `closeSession`, `addApprovalInterceptor`, `addSessionRemovedListener` and every other export are the real ones) overriding only `createSession` to inject a **fresh** `fakeStartSession()` per call (one instance keeps only its last callbacks); `failNextCreate(err)` makes the next injected start function throw `err` synchronously.
- `liveJob(store, { repos })` → appends `provisionedEvents(...)` (worktree = an existing temp dir, `baseSha: 'base'`) and returns `store.get(jobId)`.
- `launchAction(over)` → Task 7's launch action for `spec-writer` (`n: 1`, `recovery: false`, `previousAttemptId: null`, `effort: null`, `maxTurns: 60`) spread with `over`; `ids(prefix = 'a')` → a sequential id generator (`a1`, `a2`, …); `deferred()` → `{ promise, resolve, reject }`; `T0 = 1_000_000`, `MIN = 60_000`.

Each runner test builds `store` in a temp dir and `job = await liveJob(store, { repos: [primary, extra] })`, and passes `results: { readResult, validateResult: stubValidate }` where `stubValidate` checks only identity and `status` (Task 5 owns real validation; Task 9 runs it against real git).

- [ ] **Step 1: Write the failing tests**

```js
test('the interceptor passes on rows it does not own', async () => {
  registry._reset();
  try {
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, now: () => T0, idImpl: ids() });
    registry.addApprovalInterceptor(runner.onApprovalRequest);
    const { attemptId } = await runner.launch(job, launchAction());
    const worker = impls.get(store.get(job.jobId).attempts.at(-1).sessionId);
    const denied = await worker.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion');
    assert.deepEqual(denied, { behavior: 'deny', message: UNATTENDED_DENY_MESSAGE });
    const bash = await worker.emitApprovalRequest({ command: 'curl x' }, 'Bash');
    assert.equal(bash.behavior, 'deny');
    const handImpl = fakeStartSession();
    const handRow = registry.createSession({ cwd: '/elsewhere', startSessionImpl: handImpl });
    handImpl.emitApprovalRequest({ questions: [{ question: 'Human?' }] }, 'AskUserQuestion');
    assert.equal(handRow.pendingApprovals.length, 1, 'hand-driven question reaches the human');
    assert.ok(attemptId);
  } finally { registry._reset(); }
});
```

- `launch writes attempt-started before the session and passes explicit options` — order recorded by wrapping `store.append` and `createSession`: `['append:attempt-started', 'createSession', 'append:attempt-session', 'sendInput']`; `calls[0]` has `cwd` = primary worktree, `provider: 'claude'`, `model: 'claude-opus-5-5'`, `permissionMode: 'auto'`, `name: null`, `sdkOptions.additionalDirectories` = the additional worktree, `sdkOptions.maxTurns: 60`, `sdkOptions.interceptEveryPermission: true`, `sdkOptions.appendSystemPrompt` contains `result.json.tmp`; the first input contains the attempt id.
- `a failed attempt-started append creates no session` — store whose `append` rejects for `attempt-started` → `{ error: 'store-failed' }`, `registry.list().length === 0`, `isLive(job.jobId) === false`.
- `every later launch failure releases the reservation and leaves no session` — three cases, each on a fresh job: (a) `launchAction({ role: 'planner' })` (no template) → `launch-failed`; (b) `failNextCreate(new Error('spawn failed'))` → `launch-failed`; (c) a store whose `append` rejects once for `attempt-session` → `launch-failed`; (d) as (c) but the first `attempt-ended` append also rejects → no `attempt-ended` yet and `isLive === true` (pending end), then `await review(job)` lands it and `isLive === false`. Each case, at its end: `registry.list().length === 0`, `isLive === false`, last event `attempt-ended { outcome: 'failed', reason: 'launch-failed' }`, no unhandled rejection (`process.on('unhandledRejection')` spy stays empty).
- `a removal during the attempt-session append sends nothing and ends once` — wrap `store.append` so that, while appending `attempt-session`, it calls `registry.closeSession(sessionId)` first; after `launch` and `drain()`: the fake received no job card (`impl.allInputs` is undefined), exactly one `attempt-ended { reason: 'no-result' }`, no unhandled rejection.
- `launch refuses while stopping and stops cleanly when stop begins mid-launch` — `setStopping(true)` → `{ error: 'stopping' }`, no event; then `setStopping(false)`, a store whose `attempt-started` append resolves only after the test calls `setStopping(true)` → `{ error: 'stopping' }`, no session, the attempt has no `attempt-ended` (left in flight for reconcile).
- `concurrent launches for one job create one session` — `Promise.all([launch(job, a), launch(job, a)])` → one `{ attemptId }`, one `{ error: 'busy' }`, `registry.list().length === 1`, one `attempt-started` event.
- `brainstormer AskUserQuestion falls through, its other asks are denied` — launch with `role: 'brainstormer'`: `AskUserQuestion` → `row.pendingApprovals.length === 1`; `Bash` → `{ behavior: 'deny', message: UNATTENDED_DENY_MESSAGE }`.
- `a valid result at turn end ends the attempt done and closes the session` — write the spec output and a valid `result.json`; `emitMessage({ type: 'result', subtype: 'success' })`, `emitState('idle')`; `await runner.review(job)` → last event `attempt-ended { outcome: 'done' }` with the summary; `registry.get(sessionId) === undefined`; exactly one `attempt-ended`.
- `no result: one nudge, then no-result` — turn ends with no file → `attempt-nudged { kind: 'result' }`, last input equals `nudgeText('result', …)`; `review` again before a new result → nothing new; after a second `result` + idle → `attempt-ended { outcome: 'failed', reason: 'no-result' }`.
- `hitting maxTurns asks for handoff.md and ends as turn-cap` — first `result` with `subtype: 'error_max_turns'` → nudge `kind: 'turn-cap'` (input contains `handoff.md`); second result without a file → `reason: 'turn-cap'`.
- `a silent attempt is closed as stalled after stallMinutes` — clock `T0`; at `T0 + 19 * MIN` `review` adds nothing; at `T0 + 20 * MIN` → `attempt-ended { reason: 'stalled' }`, session closed, still exactly one `attempt-ended` (the removal listener did not add one).
- `telemetry does not postpone the stall deadline, worker messages do` — a `rate_limit_event` (`status: 'allowed'`) and a `system` `status` message emitted every 5 minutes: at `T0 + 20 * MIN` → `stalled`. Second job: an `assistant` message at `T0 + 19 * MIN` → no stall at `T0 + 20 * MIN` or `T0 + 38 * MIN`; `stalled` at `T0 + 39 * MIN`.
- `completion, removal and stop claim one finish per attempt` — (a) `results.validateResult` returns a `deferred()`; turn ends; start `review(job)`; while it waits, `registry.closeSession(sessionId)` (external); resolve as valid; after `review` and `drain()` → exactly one `attempt-ended`, outcome `done`. (b) Same with `stopAttempt(jobId)` called while validation waits → exactly one `attempt-ended` (the first claimer's, `done`), and `stopAttempt` resolves after it.
- `PreCompact firings are logged with the attempt id` — `await calls[0].sdkOptions.hooks.PreCompact[0].hooks[0]({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null })` deep-equals `{ continue: true }`; store has `precompact { attemptId, trigger: 'auto' }`.
- `an external close is classified, but a shutdown close leaves the attempt in flight` — `registry.addSessionRemovedListener(runner.onSessionRemoved)`; `registry.closeSession(sessionId)` then `await runner.drain()` → `attempt-ended { outcome: 'failed', reason: 'no-result' }`; second job: `runner.setStopping(true)`, close its session, `drain()` → no `attempt-ended`, `runner.isLive(job2.jobId) === false`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent-runner.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/runner.js`.

- [ ] **Step 3: Implement `src/superagent/runner.js`** per Interfaces. Header comment: spec §Worker contract (completion detection), §Permissions (S1: deny every worker ask), §Context drift (S2: PreCompact is an observation point), the one-finish claim, and why `sessionId` is set before the first `await` after `createSession`.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 778 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/runner.js tests/superagent-runner.test.mjs tests/superagent-helpers.mjs
git commit -F- <<'EOF'
feat: superagent runner with unattended denial, nudge, stall and PreCompact log
EOF
```

---

### Task 9: `src/superagent/index.js` — `createSuperagent`, timer, two-phase end to end, reconcile

**Files:**
- Create: `src/superagent/index.js`
- Test: `tests/superagent.test.mjs` (real registry + `sessionFactory`, real git temp repo, temp config/store/worktree roots)

**Interfaces:**
- Consumes: everything above; `registry.addApprovalInterceptor` / `addSessionRemovedListener` (return unsubscribe).
- Produces:

```js
export const TICK_MS = 15_000;
export function createSuperagent({
  registry, store, config /* Task 2, already load()ed */, git = defaultGit,
  worktreesRoot = path.join(defaultSuperagentRoot(), 'worktrees'),
  now = Date.now, idImpl = randomUUID, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  budgetCheck = () => ({ allow: true }),   // ({ job, action }) => { allow: true } | { allow: false, reason } (may be async)
  stopTickDeadlineMs = 2_000,
  logImpl = console.error,
}): {
  start(): Promise<void>,   // idempotent; clears stopping; load every job, fail interrupted provisioning, reconcile, install interceptor, arm timer
  stop(): Promise<void>,    // idempotent; stopping = true + runner.setStopping(true) first, clear timer, remove interceptor,
                            // await the in-flight tick for at most stopTickDeadlineMs, drain
  tick(): Promise<void>,    // never overlaps itself
  drain(): Promise<void>,   // runner.drain() + store.flush()
  createJob({ title, idea, primaryRepo, additionalRepos = [], mode = 'automatic', fixture = null /* 'milestone-1' */ }): Promise<JobState>,
  accept(jobId): Promise<JobState>,     // needs-you ready-to-try -> job-accepted -> archive ledger; else ERR_INVALID_STATE
  stopJob(jobId): Promise<JobState>,    // stop live attempt, job-stopped, archive ledger
  listJobs(): JobState[], getJob(jobId): JobState | null,
  orphanWorktrees(): Promise<[{ repo, worktree, branch }]>,   // listOrphanWorktrees over every job's origins
}
```

The constructor registers `addSessionRemovedListener(runner.onSessionRemoved)` once (like `src/autopilot.js:1035`, so removals between start/stop are not lost); `start()` adds the interceptor only if not already added, `stop()` removes it.

**Per-job serialisation.** `withJob(jobId, fn)` chains `fn` behind the job's previous operation (a `Map<jobId, Promise>`, entries removed once drained, same shape as `src/json-store.js:76-91`). `tick`'s per-job step, `stopJob` and `accept` all run inside it. `stopJob` adds `jobId` to a `stopRequested` set **synchronously**, before waiting for the chain.

**`createJob`**: `resolve(primaryRepo)`; with `fixture: 'milestone-1'` → `pipeline = MILESTONE_1_PIPELINE`, validated by `validateMilestoneFixture`; any other `fixture` value → `ERR_UNKNOWN_FIXTURE`; without a fixture → `validateDefaults`. Errors → `ERR_INVALID_CONFIG`; any phase kind outside `RUNNABLE_KINDS` → `ERR_PHASE_KIND_UNSUPPORTED`. Then `jobId = idImpl()`, `slug = slugify(title, jobId)`, `branch = BRANCH_PREFIX + slug`, `repos = repoIds(primaryRepo, [...resolved.additionalRepos, ...additionalRepos])`; add `jobId` to an in-memory `provisioningNow` set; append `job-created` (snapshot, builder decision 6) **before** touching git — the job is `provisioning` and no tick will launch it; `createWorktree` per repo at `<worktreesRoot>/<slug>/<repo id>` → `worktree-created`; all done → `job-provisioned` (now `running`); any failure → `job-failed { error }` (worktrees already made are kept, never removed); finally remove from `provisioningNow`. No launch happens here; the next `tick` launches. (A role without a template fails at launch as `launch-failed`, Task 8; Plan 3 adds an up-front check once more roles exist.)

**`tick`** (per job with `state === 'running'`, in `createdAt` order, each inside `withJob`): `await runner.review(job)`; `action = nextAction(store.get(jobId), { now: now(), liveSessions: runner.liveCount(), maxConcurrentSessions })`; `needs-you` → append it; `launch` → `await budgetCheck({ job, action })`, then **recheck** `stopping`, `stopRequested.has(jobId)` and `store.get(jobId).state === 'running'` (any fails → return, nothing launched); denied → append `needs-you { reason: 'question', detail: { kind: 'budget', text: reason } }` (spec Decision 15: a budget extension is a question); allowed → `runner.launch`. `tick` also returns early before each job when `stopping`. A job whose `load` threw `ERR_EVENTS_CORRUPT` is listed as `{ jobId, state: 'failed', reason: 'corrupt-events' }` and never appended to.

**`start`**: for each `listJobIds()` → `load`; a job still `provisioning` and not in `provisioningNow` → append `job-failed { error: 'provisioning was interrupted (restart)' }`, worktrees kept (builder decision 4); `running` → `runner.reconcile(job)`; `needs-you`/terminal jobs are left as they are (spec §Restart step 3).

- [ ] **Step 1: Write the failing tests**

```js
test('reconcile: started without a result becomes interrupted and relaunches uncounted', async () => {
  const h = await harness();                          // real repo and worktree, default config file
  const job = await h.sa.createJob({ title: 'Add hello', idea: 'Add hello.txt', primaryRepo: h.repo, fixture: 'milestone-1' });
  // Crash right after attempt-started: no session was ever created.
  await h.store.append(job.jobId, { type: 'attempt-started', attemptId: 'a1', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', n: 1, recovery: false, previousAttemptId: null, dir: h.dirFor(job, 'a1') });
  const fresh = h.restart();                         // new store + superagent over the same files, empty registry
  await fresh.sa.start();
  assert.equal(fresh.events(job.jobId).at(-1).type, 'attempt-ended');
  assert.equal(fresh.events(job.jobId).at(-1).outcome, 'interrupted');
  await fresh.sa.tick();
  const started = fresh.events(job.jobId).filter((e) => e.type === 'attempt-started');
  assert.equal(started.length, 2);
  assert.deepEqual([started[1].n, started[1].recovery, started[1].previousAttemptId], [1, true, 'a1']);
  assert.match(fresh.inputs().at(-1), /check every worktree's git status and log/);
  await fresh.sa.stop();
});
```

`harness()` (in this test file): one temp dir holding the store `rootDir`, the config `filePath` and `worktreesRoot` (all injected; `COCKPIT_HOME` is not read); `initRepo`; an empty config file (built-in defaults); `sessionFactory(registry)`; an injected clock, `setIntervalImpl: () => 'timer'` and `stopTickDeadlineMs: 20`; every `createJob` below passes `fixture: 'milestone-1'` unless stated. `restart()` runs `registry._reset()` and builds a fresh store/config/superagent over the same directories; `events(jobId)` reads `events.jsonl`; `inputs()` returns every input pushed into any fake; `dirFor(job, attemptId)` is `attemptDir(job.repos[0].worktree, { jobId: job.jobId, phase: 'spec', task: null, attemptId })`.

- `two-phase pipeline end to end: spec-writer to ready-to-try to done` — `createJob` → `worktree-created` with `settingsCopy` and `baseSha`; `tick` → one session; the test plays the worker: writes `artifactPaths(job).spec` in the worktree, commits it, writes `result.json.tmp` (listing that commit in `evidence.commits`) and renames it, emits `result` + `idle`; `tick` → `attempt-ended done` then `needs-you ready-to-try`; `getJob(...).state === 'needs-you'`; `accept` → `state: 'done'`, `<jobsRoot>/<jobId>/ledger/attempts/spec/<attemptId>/result.json` exists, the worktree and branch still exist, `await sa.orphanWorktrees()` is `[]`.
- `stopJob closes the live attempt and archives the ledger` — after the first `tick`, `stopJob(jobId)` → `attempt-ended { outcome: 'stopped' }`, `job-stopped`, `state: 'stopped'`, the session is gone from the registry, `<jobsRoot>/<jobId>/ledger/` exists; a later `tick` launches nothing.
- `createJob refuses pipelines this plan cannot run` — no fixture (default pipeline) → `ERR_PHASE_KIND_UNSUPPORTED`; `fixture: 'milestone-2'` → `ERR_UNKNOWN_FIXTURE`; the fixture with a project config setting `models['spec-writer'].provider = 'grok'` → `ERR_INVALID_CONFIG`; none leaves a job directory.
- `provisioning gate: a tick during worktree creation launches nothing` — a `git` wrapper whose `worktree add` waits on a `deferred()`; start `createJob` without awaiting; once `job-created` is on disk, `await sa.tick()` → no `attempt-started`, `getJob(...).state === 'provisioning'`; resolve; `await` the `createJob` → `job-provisioned`; `tick` → one `attempt-started`.
- `restart during provisioning fails the job and keeps its worktrees` — job A: only `job-created` on disk; job B (two repos): `job-created` + one real `worktree-created` (made with `createWorktree`); `restart().sa.start()` → both end with `job-failed`; B's worktree directory and branch still exist; `tick` launches nothing.
- `stop while a budget check is pending launches nothing` — `budgetCheck` returns a `deferred()`; `const t = sa.tick()`; `await sa.stop()` (returns within the 20 ms deadline); resolve `{ allow: true }`; `await t` → no `attempt-started`, `registry.list().length === 0`.
- `stopJob while a budget check is pending: no attempt-started, job stopped` — `budgetCheck` returns a `deferred()`; `const t = sa.tick()`; `const s = sa.stopJob(jobId)`; resolve `{ allow: true }`; `await Promise.all([t, s])` → no `attempt-started`, last event `job-stopped`, `state: 'stopped'`.
- `overlapping ticks launch one attempt` — `await Promise.all([sa.tick(), sa.tick()])` → one `attempt-started`, `registry.list().length === 1`.
- `reconcile: started with a valid result is processed, not re-run` — `attempt-started a1` + `attempt-session a1 s-gone` + a valid `result.json` (spec committed in the worktree); `restart().sa.start()` then `tick()` → `attempt-ended { outcome: 'done' }` for `a1`, then `needs-you ready-to-try`; only one `attempt-started` in the log; a second job already `needs-you` before the restart has no new events after `start()`.
- `budget denial before launch asks the user and starts nothing` — `budgetCheck: () => ({ allow: false, reason: 'job budget of $5 reached' })` → after `tick`, `needs-you { reason: 'question', detail: { kind: 'budget', text: 'job budget of $5 reached' } }`, no `attempt-started`, `registry.list().length === 0`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/superagent.test.mjs`
Expected: FAIL — cannot find module `../src/superagent/index.js`.

- [ ] **Step 3: Implement `src/superagent/index.js`** per Interfaces. Header comment: modelled on `createAutopilot` (DI, one timer, no overlap), separate timer from auto-pilot (Decision 1), not wired into `src/server.js` yet (see "Not in this plan").

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, 789 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/superagent/index.js tests/superagent.test.mjs
git commit -F- <<'EOF'
feat: createSuperagent with two-phase pipeline, reconcile and budget hook
EOF
```

---

### Task 10: Docs and the (unrun) manual end-to-end probe

**Files:**
- Create: `tests/superagent-two-phase.manual.mjs`
- Modify: `tests/README.md` (append a section), `CLAUDE.md` (the `~/.prompt-cockpit/` bullet and one Architecture paragraph)

**Interfaces:**
- Consumes: `createSuperagent`, `createSuperagentStore`, `createSuperagentConfig`, the real `src/session-registry.js`.
- Produces: documentation only, plus a probe file nobody runs in this plan.

- [ ] **Step 1: Write `tests/superagent-two-phase.manual.mjs`** — temp `COCKPIT_HOME`, a toy git repo with no remote, a config whose project entry for that repo sets only `models['spec-writer'] = { provider: 'claude', model: 'claude-sonnet-5-5', maxTurns: 20 }`; `createSuperagent` over the real registry, `start()`, one `createJob({ title: 'Add a hello file', idea: 'Add hello.txt containing hi, with a one-paragraph design.', primaryRepo: <toy repo path>, fixture: 'milestone-1' })`, `tick()` every 5 s until `needs-you` or a 10-minute wall-clock deadline; prints `events.jsonl` (all `attempt-*` and `precompact` lines) and the worktree's `git log --oneline`; `finally`: `stop()`, `closeSession` on every registry row, leave temp dirs (the SDK child can hold the cwd on Windows, S2). Header: "NOT run by npm test and NOT run by implementers of Plan 2. Run by hand only with the user's approval: `node tests/superagent-two-phase.manual.mjs`. Limits: 1 job, 1 phase, ≤ 3 attempts × maxTurns 20, one nudge each, 10-minute deadline. Estimated cost: about $0.50 (Sonnet 5.5) — treat as a floor; Plan 1's probes cost 10-30x their header estimates. Observes what unit tests cannot: whether `maxTurns` is per turn or per session in streaming input, the real `error_max_turns` subtype, and whether a PreCompact firing reaches `events.jsonl`."

- [ ] **Step 2: Append `## Superagent core (Plan 2)` to `tests/README.md`** — which `tests/superagent-*.test.mjs` file covers which module; that runner and end-to-end tests use the real registry with one `fakeStartSession` per session (`sessionFactory`) and real `git` in temp repos; **hand-verified only (not yet run):** real `auto`-mode behaviour, `maxTurns` semantics, PreCompact firing through `sdkOptions.hooks`, all via the manual probe above.

- [ ] **Step 3: Update `CLAUDE.md`** — add `superagent/` (`config.json`, `jobs/<id>/events.jsonl` + `state.json` + `ledger/`, `worktrees/`) to the `~/.prompt-cockpit/` list, and one short paragraph under Architecture: `src/superagent/` is a library (config, store, worktree, results, prompts, sequencer, runner, `createSuperagent`) not yet wired into `src/server.js`; `src/session.js` accepts `sdkOptions.hooks` (merged after cockpit's own) and `sdkOptions.interceptEveryPermission` for it.

- [ ] **Step 4: Verify**

Run: `npm test` and `git diff --stat`
Expected: PASS, 789 tests, 0 failures; only the three files above changed; the probe was not run.

- [ ] **Step 5: Commit**

```bash
git add tests/superagent-two-phase.manual.mjs tests/README.md CLAUDE.md
git commit -F- <<'EOF'
docs: superagent core coverage notes and an unrun two-phase probe
EOF
```

---

## Spec coverage (in scope → task)

| Spec requirement | Task |
|---|---|
| Runner session options (`additionalDirectories`, `maxTurns`, appended prompt, explicit model/effort/mode) | 1, 8 |
| Global + per-project config, model matrix, contracts, v1 compositions, Claude-only, unpriced warning, worker mode rejection, router allowlist | 2 |
| `events.jsonl` truth, `state.json` cache, truncated final line, rebuild on start | 3, 9 |
| One worktree + branch per repo per job, settings copy, never auto-delete, orphans listed, ledger archived | 4, 9 |
| Attempt directories, atomic publish, identity/schema/artifact/commit/review-field validation, `invalid-result` | 5, 8 |
| Role templates (overridable per project), job card, recovery note, prompt-surface test | 6 |
| Attempts per phase/task, back-off, repeated error, concurrency, budget-before-launch hook | 7, 9 |
| Stall deadline, completion detection with one nudge, `no-result`, `turn-cap` + handoff request | 8 |
| Unattended denial of every worker ask, brainstormer exception (role-aware), scoping to owned rows | 1, 8 |
| PreCompact observation log (S2 follow-up) | 1, 8 |
| Write order `attempt-started` → flush → session → `attempt-session`; reconcile (valid result processed, else `interrupted`, uncounted) | 3, 8, 9 |
| Two-phase pipeline (author → human) as the named milestone-1 fixture, accept → `done` | 2, 9 |
| Artifacts committed in the primary worktree (Decision 10, §Artifact locations) | 5 |
| Launch gated on complete provisioning; interrupted provisioning on restart | 3, 9 |
| One ending per attempt; no launch after `stop()`/`stopJob()` | 8, 9 |

## Revision 2 changes

Codex review of revision 1 (`.superpowers/sdd/codex-p2-review.md`); every finding was checked against the code and spec before folding in.

| # | Finding | Change |
|---|---|---|
| 1 | Launch failures can strand attempts or sessions; a sync start throw leaves a row (`src/session-registry.js:344-346`, confirmed) | Task 1 drops the row on a synchronous start throw (flagged, outside `src/superagent/`); Task 8 lists the exit for every launch step, adds `pendingEnd` retry, and tests prompt-build, create and `attempt-session` failures |
| 2 | `sendInput` is async and rejects for a missing row (`:637-640`, confirmed) | Every send is awaited in `try`; launch rechecks the live entry and row before sending; test for a removal during the `attempt-session` append |
| 3 | Terminal processing not serialised | One synchronous `claim` per attempt shared by completion, removal, stall, stop and launch failure (builder decision 16); race test |
| 4 | Stop does not prevent a pending launch | `stopping` checked at launch entry and after every await; `tick` rechecks after `budgetCheck`; idempotent start/stop, bounded `stopTickDeadlineMs`; test |
| 5 | Partially provisioned jobs are runnable | New `provisioning` state and `job-provisioned` event; restart fails an interrupted provisioning and keeps worktrees; two tests |
| 6 | `stopJob` races a budget-approved launch | Per-job `withJob` chain plus synchronous `stopRequested`; test |
| 7 | Registry wrapper lacks registration methods | `sessionFactory` spreads the real module and overrides only `createSession` |
| 8 | Signature test contradicts the algorithm (confirmed: `#x#`) | `0x` hex normalised first; new stability test with equivalent and distinct pairs |
| 9 | Invented general phase-removal rule; "Decision 8" misattributed | v1 validator kept as strict as spec §Phase contracts; two-phase pipeline is the named `MILESTONE_1_PIPELINE` fixture with its own validator and `createJob({ fixture })`; attribution removed |
| 10 | Committed author artifacts not enforced | `done` requires each required output to be committed by a listed commit and clean (builder decision 14, grounded in Decision 10 and §Artifact locations); new test. Not an over-reach: §Worker contract's `implement`-only sentence adds per-task checks, it does not exempt other artifacts from being committed |
| 11 | Telemetry can postpone the stall deadline | `PROGRESS_TYPES` (`assistant`, `user`, `result`); telemetry test |
| 12 | S4 deferred despite authority saying "Plan 2" | Kept out of this plan by explicit authority amendment ("Spec ambiguities resolved here", "Not in this plan"); spec §Isolation, Spike 4 and spike S4 reworded to "the router plan (milestone 2)"; 6000 stays unvalidated; no paid probe |
| 13 | Manual probe omits `primaryRepo` | Probe passes the toy repo and `fixture: 'milestone-1'` |

No finding was rejected. One addition beyond the review: `ERR_NO_TEMPLATE` is no longer checked in `createJob` (the fixture's only role always has a template); a missing template fails the attempt as `launch-failed` (Task 8 test case (a)).
