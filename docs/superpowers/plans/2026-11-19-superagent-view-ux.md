# Superagent view UX, spend, inspect and retrospective — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Superagent tab readable and professional, show what every agent spent, and let the operator inspect any worker session and start a retrospective on it.

**Architecture:** Server side, a transcript index matches each attempt to its Claude transcript by the job card's `jobId`/`attemptId` and prices it once per `message.id`; a supervisor-owned accounting queue persists spend (`usage.json`) and artifact snapshots in Cockpit's own job directory; the view model gains attempt results and a spend roll-up; two new routes serve transcripts and start retrospectives. Client side, the middle pane moves to its own module and renders Markdown with link chips, a coloured stage timeline, grouped attempt cards with results and cost, and Inspect/Retrospective buttons.

**Tech Stack:** Node ESM, `node --test`, vanilla JS ES modules (no bundler), git CLI. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-11-19-superagent-view-ux-design.md](../specs/2026-11-19-superagent-view-ux-design.md) (committed `ba0af3b`). The spec wins over this plan; section letters below (B, C, C2, D, E, F) refer to it.

## Global Constraints

- Branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`; base `ba0af3b`.
- No new npm dependencies, no `package.json` change, no build step. Stage files by name, never `git add -A`. `HANDOVER.md` stays out of commits.
- NO `Co-Authored-By` trailer. Conventional prefix only; commit with `git commit -F- <<'EOF' ... EOF`. Files are LF.
- `src/session-registry.js` and `src/shutdown.js` are NOT modified. The live accumulator's double counting is NOT fixed here (backlog).
- Baseline at `ba0af3b`: `timeout 600 npm test` → 1377 tests, 1376 pass, 0 fail, 1 skipped. It stays green after every task.
- Tests: no network, no real CLI, no real model. Any test that builds a host, store, config or supervisor sets `COCKPIT_HOME` to a temp dir; server-importing tests also set `COCKPIT_OPERATOR_TOKEN` (pattern `tests/autopilot-routes.test.mjs:11-15`). Temp git repos go through `initRepo` (`tests/superagent-helpers.mjs`). Transcript tests use a temp projects root, never `~/.claude/projects`. Client DOM tests use `tests/helpers/dom-stub.mjs` (as `tests/markdown.test.mjs`).
- Worker/operator text is never set through `innerHTML`; Markdown goes through `renderMarkdown`, hrefs through `isSafeHref`.
- No paid run. Hand-verification uses `tests/superagent-view-fixture.manual.mjs`-style seeded `COCKPIT_HOME` data and never clicks Retrospective against a real model unless the operator does it.
- Never push, PR or merge.
- Exact values:
  - Prefix stripped by pricing fallback: `anthropic.` (exact id tried first).
  - Job card marker: `# Superagent job card`; card fields matched: `jobId`, `attemptId`.
  - Claude project dir name: the cwd with every character outside `[A-Za-z0-9]` replaced by `-`.
  - Persisted files (under `store.jobDir(jobId)`): `usage.json` (`format: 1`), `artifacts/<encodeURIComponent(key)>`.
  - Retro snapshot root: `<superagent root>/retros/<retroId>/`.
  - Forbidden access roots (after `realpath`): `~/.claude/plugins/cache/`, `~/.claude/plugins/marketplaces/`, `~/.claude/projects/`, `~/.prompt-cockpit/` (except the retro snapshot folder).
  - Clone search depth: 3; skipped dirs: `node_modules`, `.git`, names starting with `.`.
  - Error codes: `ERR_TRANSCRIPT_MISSING` (404 on the transcript route, 409 on retrospective), `ERR_TRANSCRIPT_AMBIGUOUS` (409), `ERR_ARTIFACT_GONE` (410).
  - Session storage key: `cockpit:activeSession`. Retro session name: `Retro: <job title> · <phase>[ / <task>][ #n]`.
  - Artifact modal width: `min(1100px, 94vw)`.

## Review Focus

1. **A job whose transcripts have been pruned or never existed** (e.g. the test fixtures, a job from another machine): every attempt shows "not available", the total reads "at least $X" (or "not available" with nothing known), Inspect is disabled with a tooltip, and nothing throws. → Task 5 test `jobDetail with no usage marks spend incomplete and never sums null`.
2. **An in-place job whose Claude project directory is full of the operator's own sessions**: only the job's own transcripts match, and the retrospective snapshot copies none of the others. → Task 2 test `find ignores unrelated sessions in the same project dir`; Task 6 test `snapshot copies only the selected attempts' transcripts`.
3. **Poll re-render while the operator is reading**: an expanded attempt result and the pane's scroll position survive the 5 s poll. → Task 8 test `renderJobPane keeps expanded attempts across re-render` (DOM stub) plus hand-check.
4. **A worker-written URL or Markdown with a hostile scheme or malformed URL** in the idea, a result summary or an artifact: rendered as text, never a live `javascript:` link, never `innerHTML`. → Task 7 tests.
5. **A Retrospective click when the popup is blocked**: the session exists once, the row offers "Retrospective started: Open", and Open does not create a second session. → Task 10 test `handoff without a tab keeps one session and offers Open` (DOM stub).

---

### Task 1: Pricing falls back to the unprefixed model id

**Files:**
- Modify: `src/usage.js` (`ratesFor`)
- Test: `tests/usage.test.mjs`

**Interfaces:**
- Produces: `costForUsage('anthropic.claude-opus-5-5', usage)` prices as `claude-opus-5-5`.

- [ ] **Step 1: Write the failing tests**

```js
test('costForUsage prices an anthropic.-prefixed id as the bare id', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(costForUsage('anthropic.claude-opus-5-5', usage).cost, costForUsage('claude-opus-5-5', usage).cost);
});
test('costForUsage keeps an exact prefixed entry ahead of the fallback', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(costForUsage('anthropic.claude-opus-5', usage).cost, 5); // pricing.json:11
});
test('costForUsage still returns null for an unknown prefixed id', () => {
  assert.equal(costForUsage('anthropic.nope', { input_tokens: 1 }), null);
});
```

- [ ] **Step 2:** Run `node --test tests/usage.test.mjs`. Expected: the first test FAILS (`Cannot read properties of null`).
- [ ] **Step 3:** In `ratesFor(model)`, after the two exact lookups, retry once with `model.slice('anthropic.'.length)` when `model` starts with `anthropic.`.
- [ ] **Step 4:** Run the file and `timeout 600 npm test`. Expected: PASS, totals = baseline + 3.
- [ ] **Step 5:** Commit `fix: price anthropic.-prefixed model ids as the bare id`.

---

### Task 2: Transcript index (spec B)

**Files:**
- Create: `src/superagent/transcripts.js`
- Test: `tests/superagent-transcripts.test.mjs`

**Interfaces:**
- Consumes: `costForUsage` (Task 1), `primaryRepo(job)` (`src/superagent/results.js:219`).
- Produces:
  - `projectDirName(cwd: string): string`
  - `readJobCard(text: string): object | null` — parses the first fenced ```` ```json ```` block after `# Superagent job card`.
  - `summarizeUsage(rows: Array<{ id: string|null, model: string|null, usage: object }>, { truncated: boolean }): Usage` where `Usage = { knownCostUsd: number, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, byModel: Record<string, { costUsd: number|null, tokens: number }>, unpricedModels: string[], complete: boolean, conflicts: number }`.
  - `createTranscriptIndex({ projectsRoot?: string, fsImpl? }): { find(job, attempt): Promise<Found>, usage(found): Promise<Usage & { fingerprint: string }> }` where `Found = { status: 'found', claudeSessionId, file, cwd, subagentFiles: string[] } | { status: 'missing' } | { status: 'ambiguous', files: string[] }`. Default `projectsRoot` = `path.join(os.homedir(), '.claude', 'projects')`.

- [ ] **Step 1: Write the failing tests** (temp `projectsRoot`; helper `writeTranscript(dir, sessionId, lines)` writing JSONL):
  - `projectDirName('C:\\workspace\\git\\FallGuys') === 'C--workspace-git-FallGuys'`.
  - `find matches the card's own attemptId, not a quoted earlier one`: file A's first card has `attemptId: 'a1'`; file B's first card has `attemptId: 'a2'` and a later user message quoting `"attemptId": "a1"`; `find(job, {attemptId:'a1'})` → `{ status: 'found', claudeSessionId: 'A' }`.
  - `find requires jobId to match too` (card with right attemptId, other jobId → `missing`).
  - `find returns ambiguous for two matching files`.
  - `find skips files older than the attempt's startedAt` (set mtime with `utimes`).
  - `find falls back to all project dirs when the cwd dir has no match` and `when it does not exist`.
  - `find ignores unrelated sessions in the same project dir` (Review Focus 2).
  - `find lists subagents/*.jsonl of the matched session`.
  - `summarizeUsage counts a repeated message.id once` (3 identical rows → tokens of 1).
  - `summarizeUsage keeps the largest output_tokens row for conflicting repeats and counts a conflict`.
  - `summarizeUsage counts an id-less row once and as a conflict`.
  - `summarizeUsage reports an unpriced model as incomplete with tokens but no cost`.
  - `summarizeUsage marks a truncated input incomplete`.
  - `usage sums main and subagent files` and `usage cache is invalidated when a subagent file is created, appended or deleted while the main file is unchanged` (spy on reads through `fsImpl`).
- [ ] **Step 2:** Run `node --test tests/superagent-transcripts.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `src/superagent/transcripts.js`. Read files line by line with `readline` (as `src/global-stats.js:58`); a line that fails `JSON.parse` sets `truncated`. Only `type === 'assistant'` rows with `message.usage` feed `summarizeUsage`. The candidate's cwd is `primaryRepo(job).worktree`. Fallback scan reuses `listAllSessionFiles(projectsRoot)` (`src/session-launcher.js:19`). Fingerprint = `JSON.stringify` of the sorted `[path, size, mtimeMs]` list of main + subagent files; cache `Map<fingerprint, Usage>` (bounded, e.g. 500 entries, oldest dropped).
- [ ] **Step 4:** Run the file and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: superagent transcript index prices each attempt once per message`.

---

### Task 3: Accounting queue and `usage.json` (spec C)

**Files:**
- Create: `src/superagent/accounting.js`
- Modify: `src/superagent/index.js` (construct the queue in `createSuperagent`, enqueue from `tick()`, drain in `stop()`, expose `usageForJob`, `transcriptFor`, `jobDir`)
- Test: `tests/superagent-accounting.test.mjs`, `tests/superagent.test.mjs` (wiring)

**Interfaces:**
- Consumes: `createTranscriptIndex` (Task 2), `store.jobDir(jobId)` (`src/superagent/store.js:297`), `updateJson`/`readJson` (`src/json-store.js:101`, `:17`).
- Produces:
  - `createAccounting({ store, transcripts, isLive: (sessionId) => boolean, snapshot?: (job, attempt) => Promise<void>, now?, logImpl?, itemBudgetMs = 10_000, finalMissingAfter = 3 }): { enqueue(jobs: Job[]): void, usageForJob(job): Promise<Map<attemptId, UsageView>>, drain(deadlineMs: number): Promise<void> }`.
  - `UsageView = { state: 'provisional'|'final'|'live', knownCostUsd, tokens, byModel, unpricedModels, complete, claudeSessionId } | { state: 'unknown', note: 'missing'|'ambiguous'|'pruned' }`.
  - Supervisor (return of `createSuperagent`) gains `usageForJob(jobId): Promise<Map>`, `transcriptFor(jobId, attemptId): Promise<Found>`, `jobDir(jobId): string`.
  - `snapshot` is Task 4's hook; Task 3 calls it (when given) exactly once per attempt at the provisional→final transition.

- [ ] **Step 1: Write the failing tests** (fake `transcripts` returning scripted `find`/`usage`, real temp store dir):
  - `an ended attempt is written provisional with its fingerprint`.
  - `a provisional entry is refreshed when the fingerprint changes`.
  - `an entry becomes final only when the session is not live and the fingerprint is unchanged across two runs`.
  - `a final entry is never rescanned` (`usage` spy not called).
  - `missing is retried and recorded final-unknown after finalMissingAfter runs on a finished job`; same for `ambiguous`.
  - `a running attempt is never persisted; usageForJob returns state 'live' from a scan`.
  - `a throwing item is logged and does not stop the next item`.
  - `enqueue twice for the same attempt runs it once`.
  - `usageForJob prefers the usage.json entry over a scan`.
  - `drain returns within its deadline even with a hung item`.
  - `snapshot hook is called once, on finalisation`.
  - In `tests/superagent.test.mjs`: `tick enqueues every known job, including finished ones` and `stop drains the accounting queue within stopTickDeadlineMs`.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement. One item at a time; each item races `itemBudgetMs`. `usage.json` shape exactly as spec C; written with `updateJson(file, mutate, { fallback: () => ({ format: 1, attempts: {} }) })`. In `index.js`, `tick()` calls `accounting.enqueue(listJobs-without-corrupt)` after `runTick()` resolves (inside the same try, never awaited by the tick), and `stop()` awaits `accounting.drain(stopTickDeadlineMs)` before `drain()`. `createSuperagent` accepts `transcripts` (default `createTranscriptIndex()`) so tests inject a fake.
- [ ] **Step 4:** Run both files and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: superagent accounting queue persists per-attempt spend`.

---

### Task 4: Artifact snapshots and the gone state (spec C2)

**Files:**
- Modify: `src/superagent/artifacts.js` (`readArtifact`), `src/superagent/view-model.js` (export `artifactKeysForAttempt`, `artifactWriterEnded`), `src/superagent/index.js` (pass `snapshot` to accounting), `src/routes/superagent.js` (`statusFor`: `ERR_ARTIFACT_GONE` → 410; pass snapshot dir and `ended`)
- Test: `tests/superagent-artifacts.test.mjs`, `tests/superagent-routes.test.mjs`

**Interfaces:**
- Consumes: Task 3's `snapshot` hook and `supervisor.jobDir`.
- Produces:
  - `snapshotArtifacts(job, attempt, { snapshotDir, maxBytes }): Promise<void>` in `artifacts.js` — copies each key of `artifactKeysForAttempt(job, attempt)` to `snapshotDir/<encodeURIComponent(key)>`, skipping missing files.
  - `readArtifact(job, key, { maxBytes, snapshotDir?, ended? })` → `{ key, path, text, truncated, source: 'workspace'|'snapshot' }`; with neither file: throws `ERR_ARTIFACT_GONE` when `ended`, else `ERR_ARTIFACT_MISSING`.
  - `artifactKeysForAttempt(job, attempt): string[]` (the attempt's phase outputs + its `attemptKey`); `artifactWriterEnded(job, key): boolean` (an attempt producing `key` has an `outcome`).

- [ ] **Step 1: Write the failing tests:** `snapshot copies the attempt's outputs and its review file`; `readArtifact prefers the workspace file` (`source: 'workspace'`); `readArtifact falls back to the snapshot after the workspace file is deleted` (`source: 'snapshot'`); `readArtifact throws ERR_ARTIFACT_GONE when ended and both are missing`; `readArtifact keeps ERR_ARTIFACT_MISSING before the writer ended`; `a snapshot path cannot escape snapshotDir` (key with `..`); route test `GET artifact answers 410 ERR_ARTIFACT_GONE`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Containment for snapshots: `realpath(snapshotDir)` and `isInside` as for the workspace. A later attempt's snapshot overwrites an earlier one of the same key.
- [ ] **Step 4:** Run the files and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: superagent artifacts survive deletion from the workspace`.

---

### Task 5: View model attempt results and spend (spec D)

**Files:**
- Modify: `src/superagent/view-model.js` (`jobDetail`), `src/routes/superagent.js` (job detail route awaits `supervisor.usageForJob`)
- Test: `tests/superagent-view-model.test.mjs`, `tests/superagent-routes.test.mjs`

**Interfaces:**
- Consumes: `UsageView` (Task 3).
- Produces: `jobDetail(job, { isLive, usageFor?: (attempt) => UsageView|null })` adds per attempt `startedAt, endedAt, durationMs, summary, reason, verdict, findingsCount, question, commits, usage, usageNote, transcript: { available }`, and per job `spend = { knownTotalUsd, workersUsd, routerUsd, byPhase: [{ phase, task, usd, attempts }], byTask: [{ task, usd }], byModel: [{ model, usd, tokens, source }], complete }` exactly as spec D. `transcript.available` = `usage?.claudeSessionId != null`.

- [ ] **Step 1: Write the failing tests:**
  - `jobDetail exposes attempt result fields` (summary, reason, verdict, `findingsCount: findings.length`, `commits: commits.length`, `durationMs = endedAt - startedAt`).
  - `jobDetail sums known spend by phase, task and model`.
  - `jobDetail with no usage marks spend incomplete and never sums null` (Review Focus 1): `knownTotalUsd === 0`, `complete === false`.
  - `a partially priced attempt makes spend incomplete`.
  - `a router decision with usage null or costUsd null makes spend incomplete; a numeric one lands in byModel with source 'router'`.
  - `byPhase groups a per-task phase per (phase, task)`.
  - Route: `GET job detail includes spend from usageForJob`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; `usageFor` defaults to `() => null`. The route does `const usage = await host.read((sv) => sv.usageForJob(id))` (null-safe) and passes `usageFor: (a) => usage?.get(a.attemptId) ?? null`.
- [ ] **Step 4:** Run the files and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: superagent job detail carries attempt results and spend`.

---

### Task 6: Retrospective builder (spec F, server side, no session yet)

**Files:**
- Create: `src/superagent/retrospective.js`, `prompts/superagent/retrospective.md`
- Test: `tests/superagent-retrospective.test.mjs`

**Interfaces:**
- Consumes: `Found`, `readJobCard` (Task 2), `readArtifact` (Task 4).
- Produces:
  - `pluginRefs(lines: object[]): string[]` — plugin names from `tool_use` blocks: `Skill` (`input.skill` of form `plugin:skill`) and `Agent`/`Task` (`input.subagent_type` of form `plugin:name`); deduplicated, sorted.
  - `normaliseRemote(url: string): string | null` — `https://host/owner/repo(.git)`, `git@host:owner/repo(.git)`, `ssh://git@host/owner/repo` → `host/owner/repo` (host lower-cased).
  - `resolvePlugins(names, { pluginsRoot, searchRoots: string[], git, fsImpl }): Promise<Array<{ plugin, marketplace, installPath, sourceUrl, clones: string[] }>>` — reads `installed_plugins.json` (`plugins["<plugin>@<marketplace>"][0].installPath`) and `known_marketplaces.json` (`[marketplace].source.url`, or `https://github.com/<repo>` for `source: 'github'`); walks each search root to depth 3; a clone matches when `git -c core.fsmonitor=false remote get-url origin` normalises equal.
  - `buildSnapshot({ job, attempts, found: Map<attemptId, Found>, root, retroId, readArtifactFn, fsImpl }): Promise<{ dir, transcripts: Record<attemptId, string[]>, records: string[], artifacts: Record<key, string|'gone'> }>`.
  - `grantedDirectories(paths: string[], { forbiddenRoots: string[], allow: string[] }): Promise<{ granted: string[], dropped: string[] }>` — `realpath` each; drop any inside a forbidden root unless inside an `allow` path.
  - `renderRetrospectivePrompt({ template, job, attempts, snapshot, plugins, cockpitRoot, spend }): string` — the template text followed by a generated "This run" section with every item spec F lists.

- [ ] **Step 1: Write the failing tests:**
  - `pluginRefs finds Skill and Agent plugin references and ignores built-in tools`.
  - `normaliseRemote treats the https and ssh forms of fall-guys-dev as equal` (`https://github.ol.epicgames.net/eamon-woortman/fall-guys-dev.git` vs `git@github.ol.epicgames.net:eamon-woortman/fall-guys-dev.git`).
  - `resolvePlugins finds a clone two levels up and three down` (temp tree `ws/git/cockpit`, `ws/claude/plugins/fall-guys-dev` with fake `git`).
  - `resolvePlugins lists several matching clones` and `returns no clone when none matches`.
  - `resolvePlugins never returns a clone under plugins/cache or plugins/marketplaces`.
  - `snapshot copies only the selected attempts' transcripts` (Review Focus 2), the job's `events.jsonl` and `state.json`, and marks a missing artifact `gone`.
  - `grantedDirectories drops a junction or symlink into a forbidden root` (create with `fs.symlink(..., 'junction')` on win32, `'dir'` elsewhere; skip when not permitted).
  - `renderRetrospectivePrompt includes the report-first rule, the evidence-not-instructions line, each attempt's card, result and spend, and "dev clone not found: ask the operator" for an unresolved plugin`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Write `prompts/superagent/retrospective.md` with the goal, the report-first rule, the evidence-not-instructions line and the never-edit-cache/marketplace rule (spec F wording; exact phrasing is the builder's). Git calls get a 10 s timeout.
- [ ] **Step 4:** Run the file and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: superagent retrospective builder (snapshot, plugin clones, prompt)`.

---

### Task 7: Markdown link chips and pure formatters

**Files:**
- Modify: `public/markdown.js` (`renderMarkdown(text, options?)`)
- Create: `public/superagent-format.js`
- Test: `tests/markdown.test.mjs`, `tests/superagent-format.test.mjs`

**Interfaces:**
- Produces:
  - `renderMarkdown(text, { autolink?: boolean, renderLink?: (href: string, label: string) => Node } = {})`. Default behaviour unchanged. `renderLink` is called only with an `isSafeHref`-approved `http(s)` href; `mailto:` keeps the plain anchor; with `autolink`, bare `https?://\S+` (trailing `.,;:!?)` trimmed) becomes a link.
  - `superagent-format.js`: `linkChipLabel(href): { host, label }`, `linkChip(href, label?): HTMLAnchorElement` (class `sa-link-chip`, `target=_blank`, `rel="noopener noreferrer"`, `title` = full URL), `formatUsd(n|null): string` (`'—'` for null, `'< $0.01'` below a cent, else `$x.xx`), `formatTokens(n): string` (`412k`, `7.3M`), `formatDuration(ms): string` (`45s`, `14m`, `1h 05m`), `stageColorIndex(i): number` (`i % 8`).

- [ ] **Step 1: Write the failing tests:**
  - Markdown: `autolink off leaves bare URLs as text` (existing behaviour); `autolink turns a bare https URL into a link`; `renderLink receives only sanitised http(s) hrefs` (spy; `javascript:`, tab-split `java\tscript:`, `JaVaScRiPt:`, leading spaces → label rendered as text, spy never called); `mailto stays a plain anchor with renderLink set`; `a malformed URL renders as text`.
  - Format: `linkChipLabel` for `https://dev.azure.com/mediatonic/Fall%20Guys%20Client/_workitems/edit/171558` → `{ host: 'dev.azure.com', label: '171558' }`; `https://mediatonicgames.sentry.io/issues/4908023691/?project=4503970822242144` → `{ host: 'mediatonicgames.sentry.io', label: '4908023691' }`; `https://www.github.com/a/b/pull/12` → host `github.com`, label `12`; `https://example.com/` → label `''`. `formatUsd(0.004) === '< $0.01'`, `formatUsd(16.06) === '$16.06'`, `formatUsd(null) === '—'`; `formatTokens(7_276_245) === '7.3M'`; `formatDuration(840_000) === '14m'`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; thread `options` through `renderInline`/`appendInline` (signature change is internal).
- [ ] **Step 4:** Run the files and the full suite (the transcript renderer's tests must be unchanged). Expected: PASS.
- [ ] **Step 5:** Commit `feat: markdown link chips option and superagent formatters`.

---

### Task 8: Middle pane rebuild (header, description, timeline, spend, attempts, artifacts)

**Files:**
- Create: `public/superagent-job-pane.js`
- Modify: `public/superagent-view.js` (middle pane delegates to it), `public/style-superagent.css`
- Test: `tests/superagent-job-pane.test.mjs` (DOM stub)

**Interfaces:**
- Consumes: Task 5 detail shape, Task 7 helpers.
- Produces: `createJobPane({ root, onOpenArtifact(key), onInspect(attempt), onRetrospective(selector), stopButton() }): { render(detail), setRetroState(selectorKey, state) }`. `selector` = `{ attemptId }` or `{ phase, task? }`; `selectorKey` = `JSON.stringify(selector)`. Expansion state is a `Set<attemptId>` inside the pane.

- [ ] **Step 1: Write the failing tests:**
  - `renders the idea as markdown with link chips` (two Sentry URLs → two `.sa-link-chip`).
  - `renders one timeline step per phase with arrows between and the workflow name as the panel title`; each step has class `sa-stage-<i % 8>` and a status class.
  - `groups attempts per phase, and per (phase, task) for per-task phases, with count and spend in the header`.
  - `an attempt card shows outcome, role, model, n/cap, duration, tokens, cost and its result line`; `'retried, not counted'` when `retried`.
  - `unknown usage renders 'not available' with the note as tooltip`, and the spend header reads `at least` when `spend.complete` is false.
  - `renderJobPane keeps expanded attempts across re-render` (Review Focus 3: click, `render(sameDetail)`, still expanded).
  - `Inspect is disabled without a transcript unless the attempt is live`.
  - `a live attempt's cost is labelled 'so far'`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, then move `renderMiddle`'s body out of `superagent-view.js` (keep Stop, Branches, Tasks). CSS: 8 `--sa-stage-0..7` hues readable on `--bg` (WCAG AA for chip text), cards with `--panel` background and `--border`, outcome badges in `--ok`/`--warn`/`--error`/`--accent`, the timeline wraps; keep scroll position across re-render (save/restore `middle.scrollTop`). Readability pass on the left job list too (title, workflow, status badge in the outcome colours) without changing its behaviour.
- [ ] **Step 4:** Run the file and the full suite. Expected: PASS.
- [ ] **Step 5:** Hand-check with a seeded fixture (`node tests/superagent-view-fixture.manual.mjs` pattern) at 1920 and 900 px widths; screenshot both.
- [ ] **Step 6:** Commit `feat: superagent job pane with timeline, spend and attempt cards`.

---

### Task 9: Markdown artifacts, Ready-to-try, Inspect

**Files:**
- Modify: `public/superagent-view.js` (artifact modal, `artifactBlock`, router log cards, Inspect wiring), `public/index.html` (`#superagentArtifactText` `<pre>` → `<div>`), `public/style-superagent.css`
- Modify: `src/routes/superagent.js` (add `GET /api/superagent/jobs/:id/attempts/:attemptId/transcript`)
- Test: `tests/superagent-routes.test.mjs`, `tests/superagent-job-pane.test.mjs` (artifact body renderer)

**Interfaces:**
- Consumes: `supervisor.transcriptFor` (Task 3), `readArtifact` `source` (Task 4), `initHistoryPane` (`public/history-pane.js:15`).
- Produces: `renderArtifactBody(artifact: { path, text, source }): Node` exported from `superagent-job-pane.js` (`.md` → Markdown with chips; `.json` → pretty-printed code block, falling back to text when invalid; else `<pre>`); route answers `{ claudeSessionId, cwd }`, 404 `ERR_TRANSCRIPT_MISSING`, 409 `ERR_TRANSCRIPT_AMBIGUOUS`.

- [ ] **Step 1: Write the failing tests:** `renderArtifactBody renders a test report's table as a <table>`; `renders JSON pretty-printed`; `invalid JSON falls back to text`; route tests for the transcript route's 200/404/409 and the host gate.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The modal shows "From snapshot: deleted from the workspace" for `source: 'snapshot'` and "Deleted from the workspace; no snapshot was taken" for `ERR_ARTIFACT_GONE`; width `min(1100px, 94vw)`. Ready-to-try blocks and the assumptions section use `renderArtifactBody`. Initialise `initHistoryPane` with the `#historyModal` elements (`index.html:278-299`); Inspect on a finished attempt fetches the transcript route then calls `historyPane.open({ sessionId: claudeSessionId, cwd, label, provider: 'claude', assistantLabel: 'Claude' })`; on a live attempt it keeps `/?attach=`.
- [ ] **Step 4:** Run the files and the full suite. Expected: PASS.
- [ ] **Step 5:** Hand-check: open a `.md` artifact, a `.json` artifact, a deleted one; Inspect a finished attempt (history modal opens over the Superagent tab).
- [ ] **Step 6:** Commit `feat: superagent markdown artifacts and inspect`.

---

### Task 10: Retrospective route and new-tab handoff

**Files:**
- Modify: `src/routes/superagent.js` (`POST /api/superagent/jobs/:id/retrospective`), `src/server.js` (pass `cockpitRoot`, `seedDefaults`, `readSessionDefaults` into the route deps if needed)
- Create: `public/superagent-handoff.js` (the handoff, testable), and a same-origin placeholder page or reuse `/` with a one-shot marker
- Modify: `public/superagent-view.js` (wire `onRetrospective`)
- Test: `tests/superagent-routes.test.mjs`, `tests/superagent-handoff.test.mjs` (DOM stub)

**Interfaces:**
- Consumes: Task 6 builders, `registry.createSession({ cwd, name, provider: 'claude', effort, sdkOptions: { additionalDirectories } })`, `registry.sendInput(id, text)`, `seedSessionDefaults(row)` (`src/routes/sessions.js:28`), `readSessionDefaults(cwd)`.
- Produces:
  - Route returns `{ id, token, name }`; errors 404 (unknown job/attempt/phase), 409 `ERR_TRANSCRIPT_MISSING`.
  - `startHandoff({ openWindow, storage, postJson }): Promise<{ status: 'opened' | 'blocked', session: { id, token, name } }>` and `completeHandoff(win, session, storage)`.

- [ ] **Step 1: Write the failing tests:**
  - Route: `creates one session in the cockpit root with additionalDirectories from grantedDirectories and sends the prompt`; `passes no model`; `uses the persisted effort and seeds defaults`; `name follows 'Retro: <title> · <phase> / <task> #n'`; `409 when no selected attempt has a transcript`; `{ phase, task }` selects that task's attempts only; host gate refusal.
  - Handoff: `writes the session under cockpit:activeSession, navigates the placeholder to /, restores the previous value`; `handoff without a tab keeps one session and offers Open` (Review Focus 5: `openWindow` returns null → `status: 'blocked'`, `postJson` called once; a second `completeHandoff` with a new window does not call `postJson`); `a storage write that throws still restores and reports blocked`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Placeholder opened synchronously in the click handler before the POST. Verify by hand that a placeholder opened before the POST sees the later `sessionStorage` write; if it does not, implement the spec's `postMessage` fallback (placeholder asks its opener, origin checked, then `saveActiveSession`) and replace the first handoff test's storage assertion with the message exchange. Never put the token in a URL.
- [ ] **Step 4:** Run the files and the full suite. Expected: PASS.
- [ ] **Step 5:** Hand-check without a paid turn: stub `registry.sendInput` via a seeded fixture or stop the session before it sends (operator decides whether to run one real retrospective).
- [ ] **Step 6:** Commit `feat: superagent retrospective sessions open in a new tab`.

---

### Task 11: Docs sweep

**Files:**
- Modify: `CLAUDE.md` (superagent paragraph: spend from transcripts with `message.id` dedupe and the `anthropic.` fallback, accounting queue and `usage.json`/`artifacts/` in the job dir, the two new routes, `ERR_ARTIFACT_GONE`, retrospective snapshot folder and access rules, new modules `transcripts.js`, `accounting.js`, `retrospective.js`, `superagent-job-pane.js`, `superagent-format.js`, `superagent-handoff.js`, `prompts/superagent/retrospective.md`), `README.md` (status line if it lists superagent UI), `tests/README.md` (what is unit-tested vs hand-verified per Tasks 8-10), `backlog.md` (narrow the 2026-11-17 "Spend so far" entry to the budget override only; leave the three 2026-11-19 entries), `docs/superpowers/specs/2026-11-17-superagent-p6-view-design.md` only where it states behaviour this changes.

- [ ] **Step 1:** Grep for every renamed or new name and stale statement: `grep -n "plain text\|ERR_ARTIFACT_MISSING\|Spend so far\|superagent-view.js" CLAUDE.md README.md tests/README.md backlog.md`.
- [ ] **Step 2:** Edit; append to `backlog.md` and handover-style docs, never overwrite existing entries.
- [ ] **Step 3:** Run `timeout 600 npm test`. Expected: PASS, totals recorded.
- [ ] **Step 4:** Commit `docs: superagent view UX, spend, inspect and retrospective`.
