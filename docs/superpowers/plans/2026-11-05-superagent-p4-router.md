# Superagent Plan 4 — Isolated Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** 2 — folds in the Codex review of revision 1 (9 Important, 1 Minor; `.superpowers/sdd/codex-p4-review.md`). See "Revision 2 changes" at the end.

**Goal:** Add the spec's isolated router to the `src/superagent/` library: when a worker attempt fails without a user question and the attempt cap still allows a retry, one isolated single-turn Haiku call picks how to retry (as-is, alternate model, from the handoff) or escalates the job as `stuck`. Every call's request size, latency, usage and decision is logged to `events.jsonl`.

**Architecture:** `nextAction` stays pure. It returns a new `route` action when the next launch would retry a router-eligible failure that has no decision yet, and applies a recorded `router-decided` decision once one exists. The supervisor (`index.js`) runs the router call in the background, outside the tick, serialised per job, and appends `router-decided`. The new `router.js` has a pure half (request builder, truncation, output validation) and an I/O half (`createRouter`, the isolated `query()` call).

**Tech Stack:** Node 18+ ESM, no framework, no bundler; `@anthropic-ai/claude-agent-sdk` 0.3.318 (unchanged); tests with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-03-superagent-design.md` (revision 3), sections "The router", "Router request", "Isolation", Decisions 3, 4 and 15, and "Testing" (Router bullet). Auth route and baseline come from spike S4b in `docs/superpowers/spikes/2026-11-03-superagent-spikes.md` (2026-11-05).

## Scope (author's call)

In: the retry-routing judgement point (spec table row 1), isolation, the request builder with whole-request limit and truncation order, output validation, logging, config validation of the router fields, and the budget check before a router call (Decision 15, through the existing `budgetCheck` hook).

Out: the **notification-text** judgement point (spec table row 2). Nothing displays notifications yet. It lands with the notifications plan, which can reuse `createRouter` with a second action set. Also out: the router panel UI and the usage ledger/budget totals (the `router-decided` events carry the usage figures those plans will read).

## Global Constraints

- Work only on branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`; `feature/auto-pilot` is not modified.
- No new npm dependencies; plain ESM; no build step; never commit `package-lock.json` (it is deliberately modified and uncommitted; stage files by name, never `git add -A`; `HANDOVER.md` is untracked and stays out of commits).
- Baseline is `npm test` = 932 passing; it stays green after every task. Tests are no-network, no real CLI, no real model: the router's `query` is always injected in tests.
- NO `Co-Authored-By` trailer on any commit. Conventional prefix only; commit with `git commit -F- <<'EOF' ... EOF`. Files are LF.
- Edits are confined to `src/superagent/`, `prompts/superagent/`, `tests/` and Task 7's docs. `src/server.js`, `src/session.js` and `src/session-registry.js` are NOT touched.
- Router isolation options, verbatim (spec "Isolation" + S4b): `model` (on `routerModelAllowlist`), `maxTurns: 1`, `tools: []`, `settingSources: []`, `mcpServers: {}`, `strictMcpConfig: true`, `systemPrompt: <plain string>`, `settings: { autoMemoryEnabled: false, apiKeyHelper?: <user's helper string> }`, `persistSession: false`, `thinking: { type: 'disabled' }`, `cwd: <superagent root>/router`, `abortController`, and `env` = the parent environment plus `CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens)` (a generation cap the CLI is expected to honour; **unverified** at 0.3.318, so Task 7's probe checks it and the post-call check stays).
- Router limits from config: `routerMaxInputTokens` (default 6000), `routerMaxOutputTokens` (default 300), call timeout 30 s, note ≤ 30 words.
- Closed action set: `retry`, `retry-alternate`, `retry-handoff`, `escalate`. Router-eligible failure reasons, verbatim from the spec: `no-result`, `invalid-result`, `turn-cap`, `stalled`, `failed`, `blocked`. (`launch-failed` and `interrupted` are not routed; `question` is a `needs-you`.)
- Any router failure (over-limit request, timeout, error result, unparseable/invalid/over-length output, isolation breach, non-allowlisted model) escalates as `stuck` with `why: 'router-failed'` and the error. It never silently retries or proceeds (spec "Router request").
- The router never extends a limit: attempt cap, repeated-error and back-off are evaluated before any `route` action.
- Never push, PR or merge; never write a project's `.claude/settings*.json`; the router only *reads* the user's `settings.json`.
- The manual probe (Task 7) is written, not run, by implementers; the controller runs it.

## Review Focus

1. **A router that cannot authenticate or answer** (for example "Not logged in", a timeout or a garbage reply) must leave the job `needs-you/stuck` with `why: 'router-failed'` and the error text visible in `detail`. It must not retry forever or launch anyway. (Task 6 test `router failure escalates the job as stuck with the error`.)
2. **Stopping the supervisor or the job while a router call is in flight** must abort the call and append nothing after the stop; on the next start the same failure is routed again. (Task 6 tests `stop aborts an in-flight router call and records nothing` and `stopJob during a router call leaves no router-decided`.)
3. **Restart between `router-decided` and the launch** must apply the stored decision without a second router call. (Task 4 test `a recorded decision is applied, not re-routed`; Task 6 test `restart after a decision launches without calling the router`.)
4. **A machine without `apiKeyHelper`**, or with a missing or corrupt `~/.claude/settings.json`, must still make the call (settings without the helper) and never throw. (Task 3 test `no helper or unreadable settings: settings carry only autoMemoryEnabled`.)
5. **A decision can never launch past a limit:** at the attempt cap, after a repeated error, or inside back-off, no `route` action is returned. (Task 4 tests `cap, repeated-error and back-off win over routing`.)

---

## Decisions the spec leaves to the builder

1. **No router injected = Plan 3 behaviour.** `createSuperagent({ router = null })`. With `null`, `nextAction` gets `routing: false` and retries as-is, so every existing test and the not-yet-wired library keep working. The pipeline probe and later server wiring pass `createRouter()`.
2. **Decision storage.** `router-decided { forAttemptId, action, note, ok, error, model, request: { estimatedTokens, truncated }, usage, latencyMs }`. `deriveJob` keeps `routerDecisions` in event order; the first decision per `forAttemptId` wins (a rejected append that landed may be replayed). A failed call is stored as `ok: false, action: 'escalate', error: '<code>: <message>'`.
3. **What each action does.** `retry`: the Plan 3 launch (recovery note). `retry-alternate`: the same launch with `model = job.models[role].alternate`. Offered only when the role has an `alternate` different from its `model`. `retry-handoff`: the same launch with `handoff` = the failed attempt's `<dir>/handoff.md`, put on the card so the worker reads it first. Offered only when that file exists. The supervisor checks this with `fs.access`, because the sequencer is pure. `escalate`: `needs-you/stuck` with `why: 'router-escalated'` and the note.
4. **Token measurement is an estimate, not a tokenizer count (deviation from "measured", stated).** No local tokenizer and no SDK count call. `estimateTokens(text) = Math.ceil(Buffer.byteLength(text, 'utf8') / 3)` — UTF-8 bytes, so CJK and emoji (3–4 bytes per character) are counted heavier than ASCII — and the whole request is `ROUTER_OVERHEAD_TOKENS (600) + estimateTokens(system) + estimateTokens(card)`. S4b's one worst-case ASCII card measured 2,427 real total input against 2,947 estimated; that is one sample, not a proof, so every call logs the estimate next to the real **total** input (`inputTokens + cacheReadInputTokens + cacheCreationInputTokens`) and Task 7's probe also sends a Unicode-heavy card. The default limit (6000) sits more than 2x above the measured worst case.
5. **Output length: cap plus check.** The SDK has no per-call output option; the router passes `CLAUDE_CODE_MAX_OUTPUT_TOKENS` through `env` as the generation cap (unverified, probed in Task 7) and still rejects after the call: `outputTokens > maxOutputTokens` → `over-length`; missing or non-finite `outputTokens` → `usage-missing` (the limit cannot be shown to hold, so it does not proceed).
6. **Isolation breach guard.** The call is aborted with `isolation-breach` if the `system/init` message lists any tool, any MCP server, or any plugin whose `path` is not `'builtin'` (S4b: the four plugins present all had `path: 'builtin'`, source `…@builtin`). Skills are not guarded: `init` lists them by name only, with no provenance, and the bundled list changes per CLI version (ledgered ruling; a user skill can only arrive with a user plugin, which the plugin guard catches).
7. **Non-blocking, cancellable per job.** The tick never awaits a model call (DSH concept 4). `index.js` keeps `routing: Map<jobId, { controller: AbortController, promise }>`, registered synchronously **before** the first await of `routeStep`. A job with an entry is skipped by `stepJob`. `stopJob(jobId)` aborts only that job's controller; `stop()` aborts all. `router.decide` takes the `signal` and settles promptly on abort even if the SDK iterator ignores it. Aborted results are never appended.
8. **Router limits are snapshotted per job.** `job-created` gains `router: { allowlist, maxInputTokens, maxOutputTokens }` from the resolved config. `deriveJob` keeps `job.router`, falling back to `defaultConfig()` values for older logs. `job.models.router` (already snapshotted) gives the model.
9. **Rechecks after every await in `routeStep`** (mirrors `launchStep`): after the budget check, after `fs.access`, and immediately before calling `decide` or appending an over-limit decision, `routeStep` returns (clearing its entry) when `stopping`, `stopRequested.has(jobId)`, the job is not `running`, the controller is aborted, or the job's last attempt in that scope is no longer `forAttemptId` / already has a decision.
10. **Confirmed decision appends.** The background completion appends via `appendConfirmed` (landed = `routerDecisions` has `forAttemptId`). If it still rejects (did not land), the finished event is kept in `pendingDecisions: Map<jobId, event>` and `stepJob` retries that append first on the next tick (after a `reload`) before anything else decides — the model is never called twice for one attempt. All background promises are caught (no unhandled rejection) and tracked so `drain()` awaits them.
11. **Trigger status and question.** Derived attempts keep `outcome`/`reason`, not the result's `status`, so the route action maps it: reason `blocked` → `status: 'blocked'`; reason `failed` → `status: 'failed'`; `no-result`, `invalid-result`, `turn-cap`, `stalled` → `status: null` (no valid result). `question` is the attempt's `question` (always `null` for a routed attempt, since a blocked result with a question is a `needs-you`, but carried so the card has the spec's fields). `summary` is the attempt's `summary` (null when there was no valid result); `signature` carries the failure detail.
12. **Attempt accounting per scope.** `attemptsUsed`/`attemptsLeft`: author and `test` phases count consuming attempts (`CONSUMING_OUTCOMES`) against `attemptsPerPhase`; review phases and tasks count **failed** attempts against their `failedCap` (`attemptsPerPhase` / `attemptsPerTask`), matching `reviewLoop`.

## File Structure

- Create `src/superagent/router.js`: constants, `allowedActions`, `buildRouterRequest`, `validateRouterOutput`, `estimateTokens`, `readUserApiKeyHelper`, `createRouter`.
- Create `tests/superagent-router.test.mjs`: unit tests for router.js.
- Create `tests/superagent-router.manual.mjs`: real isolated call through `createRouter`. Not run by `npm test`.
- Modify `src/superagent/config.js`: router field validation, `alternate` validation.
- Modify `src/superagent/store.js`: `router-decided` event, `routerDecisions`, `job.router`, attempt `handoff`.
- Modify `src/superagent/sequencer.js`: `route` action, decision application.
- Modify `src/superagent/runner.js`, `src/superagent/prompts.js`, `prompts/superagent/contract.md`: `handoff` on the attempt and the card.
- Modify `src/superagent/index.js`: `router` option, `routeStep`, `routing` map, stop handling, `job-created.router`.
- Modify docs (Task 7): `CLAUDE.md` superagent paragraph, `tests/README.md`, spec "Isolation" note, `tests/superagent-pipeline.manual.mjs`.

---

### Task 1: Config validation and the per-job router snapshot

**Files:**
- Modify: `src/superagent/config.js` (`checkModels`, `checkScalars`)
- Modify: `src/superagent/store.js` (`deriveJob`)
- Modify: `src/superagent/index.js` (`createJob`'s `created` event)
- Test: `tests/superagent-config.test.mjs`, `tests/superagent-store.test.mjs`

**Interfaces:**
- Produces: `job.router = { allowlist: string[], maxInputTokens: number, maxOutputTokens: number }` on every derived job.

- [ ] **Step 1: Write the failing tests**

In `tests/superagent-config.test.mjs`, each test takes `defaultConfig()`, sets one field, and asserts that `validateDefaults(...).errors` contains the path:
- `router maxTurns must be 1`: `models.router.maxTurns = 2` → error at `models.router.maxTurns`.
- `routerMaxInputTokens and routerMaxOutputTokens must be positive integers`: `0`, `-1`, `1.5`, `'6000'` → errors at `routerMaxInputTokens` / `routerMaxOutputTokens`.
- `routerModelAllowlist must be a non-empty array of strings`: `[]` and `[1]` → error at `routerModelAllowlist`.
- `alternate must be a non-empty string different from model`: `implementer.alternate = ''` and `= 'claude-sonnet-5-5'` → error at `models.implementer.alternate`. `defaultConfig()` itself still validates clean.

In `tests/superagent-store.test.mjs`:
- `deriveJob keeps the router snapshot and defaults it for older logs`: a `job-created` with `router: { allowlist: ['m'], maxInputTokens: 10, maxOutputTokens: 5 }` → `job.router` deep-equals it. A `job-created` without `router` → `{ allowlist: ['claude-haiku-5-5'], maxInputTokens: 6000, maxOutputTokens: 300 }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/superagent-config.test.mjs tests/superagent-store.test.mjs`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

Add the checks to `checkModels` (router `maxTurns === 1`, allowlist shape, `alternate`) and `checkScalars` (the two token limits). Leave the existing allowlist-membership check in place. `deriveJob` sets `job.router` from `first.router`, falling back to the `defaultConfig()` values. `createJob` adds `router: { allowlist: resolved.routerModelAllowlist, maxInputTokens: resolved.routerMaxInputTokens, maxOutputTokens: resolved.routerMaxOutputTokens }` to `created`.

- [ ] **Step 4: Run the tests and the full suite**

Run: `node --test tests/superagent-config.test.mjs tests/superagent-store.test.mjs`, then `timeout 500 npm test`
Expected: PASS; summary `ℹ fail 0`.

- [ ] **Step 5: Commit** — `feat: validate superagent router config and snapshot router limits per job`

---

### Task 2: Router request builder and output validation (pure)

**Files:**
- Create: `src/superagent/router.js` (pure half)
- Modify: `src/superagent/sequencer.js` (export the two constants only)
- Test: `tests/superagent-router.test.mjs`

**Interfaces:**
- Produces (exports of `router.js`):
  - re-exports `ROUTER_ACTIONS` and `ROUTED_REASONS`, defined in `sequencer.js` (Task 2 adds them there, so the pure sequencer never imports the SDK): `ROUTER_ACTIONS = ['retry', 'retry-alternate', 'retry-handoff', 'escalate']`, `ROUTED_REASONS = new Set(['no-result', 'invalid-result', 'turn-cap', 'stalled', 'failed', 'blocked'])`
  - `ROUTER_OVERHEAD_TOKENS = 600`, `ROUTER_TIMEOUT_MS = 30_000`, `NOTE_MAX_WORDS = 30`
  - `ROUTER_SYSTEM_PROMPT: string`: the stable prefix. It states the router's job (choose how to recover a failed attempt; never judge the work), defines all four actions, says only the card's `allowed` actions may be chosen, and gives the output schema `{"action":"<allowed action>","note":"<= 30 words"}` with no prose or code fences.
  - `estimateTokens(text: string) => number` (`Math.ceil(Buffer.byteLength(text, 'utf8') / 3)`)
  - `allowedActions({ model, alternate, handoffExists }) => string[]`: always `retry` and `escalate`; plus `retry-alternate` when `alternate` is a non-empty string `!== model`; plus `retry-handoff` when `handoffExists`. Returned in `ROUTER_ACTIONS` order.
  - `buildRouterRequest(job, trigger, { maxInputTokens }) => { ok: true, system, card, estimatedTokens, truncated: string[] } | { ok: false, error: 'over-limit', estimatedTokens, truncated }`
    where `trigger = { attemptId, phase, task, role, reason, status, summary, question, signature, attemptsUsed, attemptsLeft, allowed, resultPath }`.
  - `validateRouterOutput(text: string, { allowed: string[], maxOutputTokens: number, outputTokens: number }) => { ok: true, action, note } | { ok: false, error: string }`

- [ ] **Step 1: Write the failing tests**

- `allowedActions offers alternate and handoff only when available`: `{ model: 'a', alternate: null, handoffExists: false }` → `['retry', 'escalate']`; `{ model: 'a', alternate: 'a' }` → no `retry-alternate`; `{ model: 'a', alternate: 'b', handoffExists: true }` → all four in order.
- `the card carries title, mode, phase, completed phases, last 5 decisions and the trigger`: a job with 2 completed phases (lines `"<phase>: done - <summary>"`, summary from that phase's last `done` attempt, cut to 60 words) and 7 `routerDecisions` → the card is JSON whose `decisions` has the last 5 (`{ action, note }`, note cut to 30 words) and whose `trigger` and `allowed` equal the input. `system === ROUTER_SYSTEM_PROMPT`. `estimatedTokens === 600 + estimateTokens(system) + estimateTokens(card)`. `truncated` is `[]`.
- `truncation drops completed-phase lines oldest first, then shortens notes, then the summary`: with `maxInputTokens` set just below the full size, the oldest phase line goes first (`truncated` starts with `'phases'`). Lower again: all phase lines are gone, then notes are cut to 8 words plus `…` (`'notes'`). Lower again: `trigger.summary` is cut to 20 words plus ` (full result: <resultPath>)` (`'summary'`). Each result satisfies `estimatedTokens <= maxInputTokens`.
- `over the limit after every step: no call, over-limit`: `maxInputTokens: 700` → `{ ok: false, error: 'over-limit' }`.
- `estimateTokens counts UTF-8 bytes`: `estimateTokens('abc') === 1`, `estimateTokens('漢字漢') === 3` (9 bytes), `estimateTokens('😀') === 2` (4 bytes).
- `adversarial job text stays bounded`: a 5,000-character title, a phase summary of 500 words and a trigger summary of 2,000 CJK characters → either `ok` with `estimatedTokens <= maxInputTokens` (6000), or `over-limit`; never an `ok` request above the limit. The title is cut to 200 characters in the card (a fixed bound, not a truncation step).
- `validateRouterOutput accepts exact JSON and one fenced block`: `'{"action":"retry","note":"x"}'` and the same wrapped in a ```` ```json ```` fence → ok.
- `validateRouterOutput rejects bad output`: non-JSON; an action not in `allowed`; an extra key; a missing or non-string note; a 31-word note; `outputTokens: 301` with `maxOutputTokens: 300`; `outputTokens` `undefined`, `NaN` or `Infinity`. Each returns `ok: false` with an error naming the problem (`unparseable`, `action-not-allowed`, `bad-shape`, `note-too-long`, `over-length`, `usage-missing`).

- [ ] **Step 2: Run them to verify they fail** — `node --test tests/superagent-router.test.mjs`, expected FAIL (module missing).

- [ ] **Step 3: Implement the pure half of `src/superagent/router.js`**

Card layout, stable keys first: `{ job: { title, mode, phase }, phases: [...lines], decisions: [...], trigger, allowed }`, serialised with `JSON.stringify(body, null, 1)`. Truncation runs in a loop in the spec's order and records each step name once in `truncated`.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Commit** — `feat: superagent router request builder, truncation and output validation`

---

### Task 3: The isolated router call

**Files:**
- Modify: `src/superagent/router.js` (I/O half)
- Test: `tests/superagent-router.test.mjs`

**Interfaces:**
- Consumes: Task 2's exports.
- Produces:
  - `readUserApiKeyHelper({ configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), readFileImpl = fs.readFile } = {}) => Promise<string | null>`: never throws.
  - `createRouter({ queryImpl = query, cwd = path.join(defaultSuperagentRoot(), 'router'), apiKeyHelper = readUserApiKeyHelper, timeoutMs = ROUTER_TIMEOUT_MS, now = Date.now, mkdirImpl = fs.mkdir, baseEnv = <the parent process environment> } = {}) => { decide }`
  - `decide({ model, allowlist, system, card, allowed, maxOutputTokens, signal }) => Promise<{ ok: true, action, note, usage, latencyMs, apiKeySource } | { ok: false, error, usage, latencyMs, apiKeySource }>`: never rejects. `usage = { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalInputTokens, costUsd } | null`, taken from `result.modelUsage[model]` (`totalInputTokens` = the three input fields summed). `signal` (optional `AbortSignal`) is linked to the call's own controller; abort at any point — during `mkdir`, helper loading or iteration — resolves `{ ok: false, error: 'aborted' }` promptly, even if the iterator never yields again. The whole operation (setup included) is raced against the timeout and the abort.

- [ ] **Step 1: Write the failing tests** (fake `queryImpl(args)` returning an async iterable of SDK messages, recording `args`)

- `decide passes exactly the isolation options`: `args.prompt === card` and `args.options` deep-equals `{ model, maxTurns: 1, tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true, systemPrompt: system, settings: { autoMemoryEnabled: false, apiKeyHelper: 'helper-cmd' }, persistSession: false, thinking: { type: 'disabled' }, cwd, abortController: <an AbortController>, env: { A: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '300' } }`, with `apiKeyHelper: async () => 'helper-cmd'`, `baseEnv: { A: '1' }`, `maxOutputTokens: 300`. The cwd directory was created.
- `no helper or unreadable settings: settings carry only autoMemoryEnabled`: with `apiKeyHelper` resolving `null` → `settings` deep-equals `{ autoMemoryEnabled: false }`. Also `readUserApiKeyHelper` with a missing file, corrupt JSON and a non-string value → `null`; with `{"apiKeyHelper":"x"}` → `'x'`; `CLAUDE_CONFIG_DIR` is honoured.
- `a good reply resolves ok with usage and latency`: init (`tools: []`, `mcp_servers: []`, `plugins: [{ name: 'cc-plugin-privacy', path: 'builtin', source: 'cc-plugin-privacy@builtin' }]`, `apiKeySource: 'apiKeyHelper'`), an assistant text `{"action":"retry","note":"n"}`, then a `result` with `subtype: 'success'` and `modelUsage: { [model]: { inputTokens: 2, outputTokens: 17, cacheReadInputTokens: 0, cacheCreationInputTokens: 2425, costUSD: 0.0004937 } }` → `{ ok: true, action: 'retry', note: 'n', usage: { inputTokens: 2, outputTokens: 17, cacheReadInputTokens: 0, cacheCreationInputTokens: 2425, totalInputTokens: 2427, costUsd: 0.0004937 }, apiKeySource: 'apiKeyHelper' }`.
- `a model off the allowlist is refused without a call`: `queryImpl` is never called; `error` starts with `model-not-allowed`.
- `an error result fails`: `result.subtype: 'error_during_execution'` or a thrown iterator error (`Not logged in · Please run /login`) → `ok: false`, and `error` contains the message.
- `an init listing a tool, an MCP server or a non-builtin plugin aborts as isolation-breach`: three separate cases — `tools: ['Bash']`; `mcp_servers: [{ name: 'x', status: 'connected' }]`; `plugins: [{ name: 'p', path: 'C:/x/p', source: 'p@market' }]` → each `error` starts with `isolation-breach` and names what leaked, and `abortController.signal.aborted` is true. Built-in plugins alone pass.
- `a call past the timeout fails with timeout`: an iterable that never yields and ignores its signal, with `timeoutMs: 20` → `error: 'timeout'`; the signal is aborted; `decide` settles.
- `an external abort settles the call as aborted`: (a) abort while `apiKeyHelper` is still pending → `error: 'aborted'`, `queryImpl` never called; (b) abort while an iterator that ignores its signal is pending → `error: 'aborted'` within one tick of the abort.
- `invalid output fails with the validator's error`: a reply naming an action not in `allowed` → `error: 'action-not-allowed'`, and `usage` is still filled in.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement `readUserApiKeyHelper` and `createRouter`** in `router.js`. Import `query` from `@anthropic-ai/claude-agent-sdk`. Collect assistant text blocks; take the first `result`. Race the whole operation (setup and iteration) against a timeout promise and an abort promise, each of which aborts the call's controller and settles the race; always clear the timer and remove the abort listener in `finally`, and best-effort `close()` the query. Validate with `validateRouterOutput`, using `outputTokens` from the usage.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Commit** — `feat: isolated superagent router call with inline apiKeyHelper auth`

---

### Task 4: Store and sequencer: route action and decision application

**Files:**
- Modify: `src/superagent/store.js` (`EVENT_TYPES`, `deriveJob`)
- Modify: `src/superagent/sequencer.js` (`authorAction`, `scopeAction`, `launch`, `stuckAction`, `nextAction`)
- Test: `tests/superagent-store.test.mjs`, `tests/superagent-sequencer.test.mjs`

**Interfaces:**
- Consumes: `ROUTED_REASONS` and `ROUTER_ACTIONS`, already in `sequencer.js` (Task 2). `sequencer.js` never imports `router.js`.
- Produces:
  - Event `router-decided` (shape in Decision 2). `job.routerDecisions: Array<{ forAttemptId, action, note, ok, error, model, request, usage, latencyMs, at }>`, first per `forAttemptId` wins. Attempt records gain `handoff` (string | null), read from `attempt-started.handoff`.
  - `nextAction(job, { now, liveSessions, maxConcurrentSessions, routing })`: when `routing` is true, the new action is `{ type: 'route', forAttemptId, phase, task, role, purpose, round, model, alternate, previousDir, reason, status, summary, question, signature, attemptsUsed, attemptsLeft }` (status mapping: Decision 11; accounting: Decision 12).
  - Launch actions gain `handoff: string | null`. `retry-alternate` sets `model` to the alternate.
  - Stuck detail gains optional `note` / `error`. New `why` values are `'router-escalated'` and `'router-failed'`.

- [ ] **Step 1: Write the failing tests**

`tests/superagent-store.test.mjs`:
- `router-decided is derived once per failed attempt`: two `router-decided` events for the same `forAttemptId` → `routerDecisions.length === 1`, and the first one's action is kept.
- `attempt-started handoff is kept`: `handoff: '/x/handoff.md'` → `attempt.handoff === '/x/handoff.md'`; absent → `null`.

`tests/superagent-sequencer.test.mjs` (author phase and review scope, built the way the existing tests build them):
- `an eligible failure with no decision returns route`: the last attempt is `failed`/`invalid-result`, the cap is not reached, back-off has passed, `routing: true` → `type: 'route'`, `forAttemptId` = that attempt, `role`/`model` of the next launch, `alternate` from `job.models[role].alternate ?? null`, `previousDir` = the attempt's `dir`, `status: null`, `question: null`, author phase `attemptsUsed: 1, attemptsLeft: 2`.
- `status is mapped from the reason`: reason `blocked` → `status: 'blocked'`, `summary` = the attempt's summary; reason `failed` → `'failed'`; `turn-cap` → `null`.
- `review scopes count failed attempts only`: a review phase with reviewer r1 `done` (changes), fix r1 `done`, reviewer r2 `failed` → `route` with `role` = the reviewer, `purpose: 'review'`, `round: 2`, `attemptsUsed: 1`, `attemptsLeft: 2`. Likewise a failed author fix (`role` = the phase's `author`, `purpose: 'fix'`), a failed task reviewer in a per-task scope (`attemptsLeft` against `attemptsPerTask`), and a failed verifier (`role: 'verifier'`, `alternate: null`).
- `routing off keeps Plan 3 behaviour`: the same job with `routing: false` → `type: 'launch'`.
- `launch-failed, interrupted and a routed test failure are not routed`: each → `launch` (or `route-test-failure`), never `route`.
- `each of the six reasons is routed`: a loop over `ROUTED_REASONS`.
- `cap, repeated-error and back-off win over routing`: at the cap → `needs-you/stuck` `attempt-cap`; two equal signatures → `repeated-error`; inside back-off → `wait`. None of them is `route`.
- `route is returned before the concurrency wait`: `liveSessions === maxConcurrentSessions` → `route`, not `wait`.
- `a recorded decision is applied, not re-routed`: `retry` → launch with the role's model and `handoff: null`; `retry-alternate` → launch with `model: 'claude-opus-5-5'` for the implementer; `retry-handoff` → launch with `handoff === path.join(previousDir, 'handoff.md')`; `escalate` → `needs-you`, `reason: 'stuck'`, `detail.why: 'router-escalated'`, `detail.note`; `ok: false` → `detail.why: 'router-failed'`, `detail.error`.
- `retry-alternate without an alternate is router-failed`: a stored decision `retry-alternate` for a role with no `alternate` → stuck `router-failed`.
- The same three applications for a per-task scope (implementer attempt `failed`).

- Migrations of existing exact-shape tests (keep every other assertion): add `handoff: null` to the full launch expectation in `tests/superagent-sequencer.test.mjs` (the deep-equal near line 22) and to any other whole-launch deep-equal the suite fails on.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

One helper, `routeOrApply(job, ctx, { last, role, launchArgs, stuck })`, is called by `authorAction` (after `retryGuard`, only when `retry` is true) and `scopeAction` (after `retryGuard`, only when `recovery` is true). It returns `null` (plain launch), a `route` action, a stuck action or a launch-arg override (`{ model, handoff }`). Concurrency stays after it. `launch()` takes optional `model` and `handoff` overrides.

- [ ] **Step 4: Run the sequencer, store and full suites** — expected PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit** — `feat: sequencer routes eligible failures to the router and applies its decision`

---

### Task 5: Handoff on the attempt and the card

**Files:**
- Modify: `src/superagent/runner.js` (`launch`: record `handoff` on `attempt-started`, pass it to `buildWorkerPrompt`)
- Modify: `src/superagent/prompts.js` (`buildWorkerPrompt` body: `handoff`)
- Modify: `prompts/superagent/contract.md` (one rule)
- Test: `tests/superagent-runner.test.mjs`, `tests/superagent-prompts.test.mjs`

**Interfaces:**
- Consumes: the launch action's `handoff` (Task 4).
- Produces: the card field `handoff: string | null`, placed right after `previousAttemptDir`.

- [ ] **Step 1: Write the failing tests**

- Runner: `launch records handoff on attempt-started`: a launch action with `handoff: '/w/a1/handoff.md'` → the appended `attempt-started.handoff` equals it; without it → `null`.
- Migrations (keep every other assertion): add `handoff` to the exact card key list in `tests/superagent-prompts.test.mjs` (near line 58) and `handoff: null` to the complete card expectation (near lines 147–151).
- Prompts: `the card carries handoff`: `attempt.handoff = '/w/a1/handoff.md'` → `parseCard(card).handoff === '/w/a1/handoff.md'`; absent → `null`. `contract.md mentions handoff`: the system text contains `` `handoff` `` and `read that file first`.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement.** Contract rule, appended under the recovery-note paragraph, verbatim: "If the job card's `handoff` is set, read that file first and continue from the state it describes; check the worktrees' git status before trusting it."

- [ ] **Step 4: Run the runner, prompts and full suites** — expected PASS.

- [ ] **Step 5: Commit** — `feat: retry-handoff attempts carry the previous handoff.md on their card`

---

### Task 6: Supervisor routing step

**Files:**
- Modify: `src/superagent/index.js`
- Test: `tests/superagent-pipeline.test.mjs` (scripted workers plus a fake router)

**Interfaces:**
- Consumes: `buildRouterRequest`, `allowedActions`, `ROUTER_SYSTEM_PROMPT` (Task 2); `createRouter().decide({ ..., signal })` (Task 3); the `route` action (Task 4).
- Produces: `createSuperagent({ ..., router = null })`. With a router: `nextAction` gets `routing: true`, and `route` actions run through `routeStep`. Internal: `routing: Map<jobId, { controller, promise }>`, `pendingDecisions: Map<jobId, event>` (Decisions 7, 9, 10).

- [ ] **Step 1: Write the failing tests** (the fake router is `{ decide: (req) => ... }`, recording requests; a pending fake resolves `{ ok: false, error: 'aborted' }` when `req.signal` aborts, like the real one; workers come from `scriptedWorker`)

- `a failed attempt is routed, then retried as decided`: the spec writer's first attempt publishes an invalid result and the fake router answers `retry` → one `router-decided` (`ok: true`, `forAttemptId` = attempt 1, `request.estimatedTokens > 0`), then attempt 2 launches and the job reaches `ready-to-try`. The router request's `allowed` is `['retry', 'escalate']`, `model` is `claude-haiku-5-5` and `maxOutputTokens` is 300.
- `retry-alternate launches the implementer on its alternate model`: the implementer fails once and the router answers `retry-alternate` → the second implement `attempt-started.model === 'claude-opus-5-5'`.
- `retry-handoff is offered only when handoff.md exists and passes it on`: the failed attempt wrote `handoff.md` in its dir → `allowed` includes `retry-handoff`; answering it → the next `attempt-started.handoff` is that path. Without the file → `allowed` lacks it.
- `escalate stops the job as stuck with the note`.
- `router failure escalates the job as stuck with the error`: `decide` resolves `{ ok: false, error: 'Not logged in · Please run /login' }` → job `needs-you`, `reason: 'stuck'`, `detail.why === 'router-failed'`, `detail.error` contains `Not logged in`. A `decide` that *rejects* has the same result.
- `an over-limit request makes no call and is stuck`: job `router.maxInputTokens = 700` → `decide` is never called; a `router-decided` with `ok: false`, `error` starting `over-limit`; job stuck `router-failed`.
- `the card built by the supervisor carries status and question`: a spec writer whose result is `status: 'blocked'` without a question → the recorded request's card `trigger.status === 'blocked'`, `trigger.question === null`, `trigger.summary` = its summary; an attempt with no result → `status: null`.
- `the tick does not wait on the router`: `decide` returns a pending deferred → `tick()` resolves while it is pending; a second tick neither launches nor calls `decide` again; resolving it appends the decision.
- `stop aborts an in-flight router call and records nothing`: pending `decide`, then `stop()` → `req.signal.aborted`, `stop()` resolves, no `router-decided` in events after the stop.
- `stopJob during a router call leaves no router-decided`.
- `stopping one job leaves another job's router call intact`: two jobs each with a pending `decide`; `stopJob(A)` → A's signal aborted, B's not; resolving B's call appends B's decision and B launches its retry.
- `stop during a pending budget check or handoff probe starts no call`: `budgetCheck` returns a pending deferred; `stop()`; resolve it → `decide` never called, nothing appended. The same with an over-limit job: no over-limit `router-decided` is appended after the stop.
- `a rejected decision append is retried without a second call`: (a) the store rejects the `router-decided` append before writing → next tick appends the kept event, `decide` called once, the retry launches; (b) the append writes and then rejects → `appendConfirmed` sees it landed, no duplicate event, `decide` called once. No unhandled rejection in either case (attach a `process.on('unhandledRejection')` spy for the test).
- `restart after a decision launches without calling the router`: an event log ending in `router-decided` → a fresh supervisor's start and tick launch the retry; `decide` is called 0 times.
- `the budget check runs before a router call`: `budgetCheck` refuses for a `route` action → `needs-you`, `question`, `kind: 'budget'`, and no `decide` call.
- Existing pipeline tests run unchanged with no router.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement in `index.js`**

`routeStep(jobId, job, action)` does the following:
1. Run `budgetCheck({ job, action })`, as `launchStep` does.
2. Set `handoffExists` from `fs.access(path.join(action.previousDir, 'handoff.md'))`.
3. Compute `allowed = allowedActions({ model: action.model, alternate: action.alternate, handoffExists })`.
4. Build `trigger` from the action, with `resultPath = path.join(action.previousDir, RESULT_FILE)`.
5. Call `buildRouterRequest(job, trigger, { maxInputTokens: job.router.maxInputTokens })`.
6. If over-limit, append the failed decision now.
7. Otherwise put `router.decide({ model: job.models.router.model, allowlist: job.router.allowlist, system, card, allowed, maxOutputTokens: job.router.maxOutputTokens })` into `routing` and return without awaiting it. Its continuation (`.then`/`.catch` mapped to `{ ok: false, error }`) appends `router-decided` via `withJob`, unless the supervisor is `stopping`, the job is in `stopRequested`, or the job is no longer `running`. It removes itself from `routing` in `finally`, and is tracked so `drain()` awaits it.

Register the job's `{ controller, promise }` in `routing` synchronously at the top of `routeStep`, and apply Decision 9's rechecks after each await. Append through `appendConfirmed`, keeping a non-landed event in `pendingDecisions` (Decision 10). Never append when the result is `aborted`. `stepJob` first retries any `pendingDecisions` entry for the job (after `reload`), then returns early when `routing.has(jobId)`. `stopJob(jobId)` aborts that job's controller before queueing on `withJob`; `stop()` aborts every controller before awaiting the tick, then awaits the routing promises in `drain()`.

- [ ] **Step 4: Run the pipeline and full suites** — expected PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit** — `feat: superagent supervisor routes failed attempts through the isolated router`

---

### Task 7: Manual probes and docs

**Files:**
- Create: `tests/superagent-router.manual.mjs`
- Modify: `tests/superagent-pipeline.manual.mjs` (pass `router: createRouter()`; print each `router-decided` with action, note, `request.estimatedTokens`, `usage.inputTokens` and `latencyMs`)
- Modify: `CLAUDE.md` (Superagent paragraph: the router exists, its auth route, `routing` default off without an injected router; remove "the router" from the "do not exist yet" list), `tests/README.md` (router section: what is unit-tested vs. the manual probe), spec `docs/superpowers/specs/2026-11-03-superagent-design.md` ("Isolation": add a short "Plan 4 outcome" paragraph pointing to S4b. Append it; do not rewrite the caveat.)

- [ ] **Step 1: Write `tests/superagent-router.manual.mjs`.** Three calls through the real `createRouter().decide` with the allowlisted Haiku and `allowed: ['retry', 'escalate']`: (1) a worst-case ASCII job (7 completed phases, 5 decisions, a 120-word summary); (2) the same with every summary in CJK characters; (3) an output-cap check: a card whose trigger summary asks for a 600-word note, `maxOutputTokens: 50` — print `usage.outputTokens` and the error (expected `over-length` or `note-too-long`; `outputTokens <= 50` means the env cap is honoured). Print each full result with `estimatedTokens`. Exit 1 unless calls 1 and 2 are `ok` with `usage.totalInputTokens <= estimatedTokens <= 6000`. Its header states that it is not run by `npm test`, makes three Haiku calls, and is run with `node tests/superagent-router.manual.mjs`.

- [ ] **Step 2: Syntax-check each probe** — `node --check tests/superagent-router.manual.mjs` and then `node --check tests/superagent-pipeline.manual.mjs` (one file per command). Expected: no output. Do NOT run them.

- [ ] **Step 3: Update the docs** as listed under Files.

- [ ] **Step 4: Full suite** — `timeout 500 npm test`, expected `ℹ fail 0`.

- [ ] **Step 5: Commit** — `docs: superagent router probes, CLAUDE.md and tests/README for Plan 4`

---

## Revision 2 changes

From the Codex review of revision 1 (`.superpowers/sdd/codex-p4-review.md`):
1. Job-scoped cancellation: `stopJob` aborts only its own job's router call; `abortAll` is removed from the router, and the supervisor owns one `AbortController` per routing job (Decision 7; Task 6 two-job test).
2. `routeStep` registers before its first await and rechecks stop, state and eligibility after every await, including before an over-limit append (Decision 9; Task 6 test).
3. Background decision appends are confirmed, and a non-landed decision is kept and retried without a second model call (Decision 10; Task 6 tests).
4. `decide` races its whole lifecycle against timeout and abort, so a signal-ignoring iterator cannot wedge `stop()` (Task 3).
5. Attempt accounting per scope: consuming for author/test, failed-only for review/per-task (Decision 12; Task 4 tests).
6. The trigger carries `status` and `question`, mapped from the attempt (Decision 11; Tasks 2, 4, 6).
7. Token policy restated honestly: the estimate uses UTF-8 bytes, is logged against real total input, gets an adversarial-input test, and the probe adds a Unicode card. Output gets a generation cap through `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (unverified, probed) on top of the post-call check, and missing usage is refused (Decisions 4, 5).
8. The isolation guard also rejects non-builtin plugins; skills are not guarded, and the plan says why (Decision 6; Task 3 tests).
9. The existing exact-shape test migrations for `handoff` are listed (Tasks 4, 5).
10. `node --check` is run once per probe (Task 7).

## Post-probe amendments

The first real run of `tests/superagent-router.manual.mjs` (2026-11-05, VERDICT: FAIL) and the controller's diagnostic (`.superpowers/sdd/2026-11-05-superagent-p4-router/router-probe-findings.md`; spike S4c) changed the following. The text above is left as written; these amendments win where they differ.

- **Decision 4 (token measurement).** The estimate is compared with the router's own request, `result.usage` (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`), not with the real **total** input from `modelUsage`: `modelUsage[model]` folds in a hidden second request of about 2,951 input and 21 output tokens on every call (origin unknown). The probe gates on `usage.requestInputTokens <= estimatedTokens <= 6000`.
- **Decision 5 (output length).** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is honoured as a hard API max (over it the call fails), and Haiku 5.5 always thinks, with thinking counted as output. So `routerMaxOutputTokens` limits the ANSWER, `result.usage.output_tokens - output_tokens_details.thinking_tokens` (absent thinking counts as 0; a missing, non-numeric or negative answer size is `usage-missing`), and the env cap is `String(maxOutputTokens + thinkingAllowance)` with `ROUTER_THINKING_ALLOWANCE = 1000` (`createRouter({ thinkingAllowance })`). `thinking: { type: 'disabled' }` stays in the options although Haiku 5.5 does not honour it. `routerMaxOutputTokens` is at most 4000 (config validation), and `decide` refuses a `maxOutputTokens` that is not a positive integer (`bad-limit: maxOutputTokens`) before any I/O.
- **Task 3 usage interface.** `decide`'s `usage` keeps the spend from `modelUsage[model]` (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `totalInputTokens`, `costUsd`) and adds the request from `result.usage`: `requestInputTokens`, `requestOutputTokens` and `thinkingTokens` (`?? 0`). A missing `modelUsage[model]` is still `usage-missing` (it is the implicit served-model guard).
- **Decision 6 (isolation guard).** A `result` before any `system/init` is `isolation-breach: no init`; an init whose `tools`, `mcp_servers` or `plugins` is not an array is `isolation-breach: <field> missing`.
- Also from the final review: the card caps characters as well as words (phase summary 400, decision note 200, shortened note 60, shortened summary 150) and the note limit adds 300 characters; the route action carries `lastModel` (the failed attempt's model), which the supervisor puts on the trigger as `model`; `hasAlternate` in `sequencer.js` is the one alternate predicate; and the supervisor drops a router result only when its own controller aborted or it is stopping, not on an `aborted` error string.
