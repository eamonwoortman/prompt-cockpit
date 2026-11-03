# Superagent Plan 1 — Spikes and Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the four open SDK questions the superagent design depends on, and land the registry/session foundations (multi-listener hooks, rate-limit transition events, a durable provider-cooldown store, session option pass-through, 5.5 pricing) without changing any behaviour of hand-driven sessions or auto-pilot.

**Architecture:** Registry hooks become multi-listener with the existing `set*` functions kept as a legacy single slot, so `src/autopilot.js` needs no changes to keep working. A new `src/provider-cooldowns.js` store persists rate-limit hits under `~/.prompt-cockpit/` and is fed by a new registry rate-limit listener; auto-pilot's back-off additionally consults it. `createSession` → `startSession` gain an opt-in `sdkOptions` pass-through for the superagent runner (Plan 2+).

**Tech Stack:** Node 18+ ESM, no framework, no bundler; `@anthropic-ai/claude-agent-sdk` 0.3.231; tests with `node --test` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-03-superagent-design.md` — this plan covers "Spikes before or during milestone 1" (all four) and sequencing step 0, narrowed: attach-flow ownership and the notification projection move to the Plan for milestone 3 (UI), where they are first used.

## Global Constraints

- Work only on branch `feature/superagent` in `C:\workspace\git\prompt-cockpit-superagent`. `feature/auto-pilot` is not modified (spec Decision 1).
- No new npm dependencies; plain ESM; no build step.
- Hand-driven sessions and auto-pilot behave exactly as before unless they opt in. The existing 681 tests stay green after every task.
- State files live under `path.join(process.env.COCKPIT_HOME || homedir(), '.prompt-cockpit')` — same convention as `src/autopilot-store.js:38-42`.
- Claude-only for anything superagent-specific (spec Decision 13).
- Manual probes (`tests/*.manual.mjs`) are never run by `npm test`; each states its cost in its header comment, matching `tests/thinking-default-probe.manual.mjs`.
- Use `fileURLToPath(new URL('..', import.meta.url))` for the repo cwd in probes (Windows; see the comment in `tests/thinking-default-probe.manual.mjs:16-24`).
- Commit messages: conventional prefix (`feat:`, `test:`, `docs:`, `chore:`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Another supervisor's interceptor returning `null` must not swallow a human's question.** With two interceptors registered and both returning `null`, the request must reach `pendingApprovals` and the broadcast exactly as today. (Task 3, test `approval falls through when every interceptor returns null`.)
2. **A throwing interceptor or listener must not stop the others or the fall-through.** (Task 3, tests `a throwing interceptor does not block later interceptors` and `a throwing removed-listener does not block later listeners`; Task 4, test `a throwing rate-limit listener does not break message handling`.)
3. **Unsubscribing twice, or from inside a dispatch, is harmless.** (Task 3, test `unsubscribe is idempotent and safe during dispatch`.)
4. **A missing or corrupt cooldown file must not crash startup.** The store starts empty and the next write repairs it. (Task 5, test `load tolerates a missing or corrupt file`.)
5. **A hand-driven session's SDK options are byte-for-byte unchanged when no `sdkOptions` are passed.** (Task 7, test `no sdkOptions leaves query options exactly as before`.)

---

### Task 1: Spike probes — `auto` permission mode and an isolated router call

**Files:**
- Create: `tests/superagent-auto-mode-probe.manual.mjs`
- Create: `tests/superagent-router-isolation-probe.manual.mjs`
- Create: `docs/superpowers/spikes/2026-11-03-superagent-spikes.md`

**Interfaces:**
- Consumes: `startSession` from `src/session.js:186` (for the auto-mode probe); `query` from `@anthropic-ai/claude-agent-sdk` (for the router probe).
- Produces: findings doc sections `S1 auto mode` and `S4 router isolation`, each with **Question / Probe / Observed (verbatim excerpts) / Impact on design**. Plans 2+ read these.

- [ ] **Step 1: Write `tests/superagent-auto-mode-probe.manual.mjs`**

Starts a real session via `startSession` in a fresh temp directory (`fs.mkdtempSync(path.join(os.tmpdir(), 'sa-auto-'))`) with `permissionMode: 'auto'`, `model: 'claude-sonnet-5-5'`, and a logging `onApprovalRequest`. Sends three prompts in sequence, waiting for `idle` between them:
1. "Create a file named hello.txt containing 'hi' in the current directory." (expected: allowed silently)
2. "Run this exact shell command: `curl -s https://example.com -o ../outside-cwd.html`" (a write outside cwd plus network — the kind of action `auto` may block)
3. "Use the AskUserQuestion tool to ask me which colour I prefer, with options Red and Blue."

Logs, per prompt: every `onApprovalRequest` call (toolName, input), every `system`/`assistant`/`user` message whose content mentions a denial, any `tool_result` with `is_error: true`, and the final `result` message. Closes the session at the end. Header comment: purpose, "NOT run by npm test", "Run by hand: `node tests/superagent-auto-mode-probe.manual.mjs`", "Costs a few cents (Sonnet 5.5)".

- [ ] **Step 2: Run it and record S1**

Run: `node tests/superagent-auto-mode-probe.manual.mjs`
Expected: completes without hanging (if prompt 3 parks, the probe must time out after 120 s, log `PARKED`, and close). Record in the findings doc under **S1 auto mode**: for prompts 2 and 3, whether `canUseTool`/`onApprovalRequest` was called, whether the tool was denied with a message the model could see, or whether the session parked. **Impact on design** must state one of: "auto denies and the worker continues — no interceptor conversion needed" or "auto surfaces a prompt — the superagent interceptor must deny it with the unattended message (spec §Permissions)", plus the same for `AskUserQuestion`.

- [ ] **Step 3: Write `tests/superagent-router-isolation-probe.manual.mjs`**

Calls `query()` once with:

```js
{
  prompt: 'Reply with exactly: {"action":"retry","note":"probe"}',
  options: {
    model: 'claude-haiku-5-5',
    maxTurns: 1,
    tools: [],
    settingSources: [],
    mcpServers: {},
    systemPrompt: 'You are a router. Reply with one JSON object and nothing else.',
    cwd: CWD,
  },
}
```

Logs the `system` `init` message in full (tools, mcp_servers, slash_commands, skills/plugins fields, model, cwd), the assistant text, and the `result` message's `usage` (input/output/cache tokens) and `total_cost_usd`. Header comment as in Step 1, cost "well under a cent (Haiku 5.5)".

- [ ] **Step 4: Run it and record S4**

Run: `node tests/superagent-router-isolation-probe.manual.mjs`
Expected: one assistant reply, `num_turns` 1. Record under **S4 router isolation**: the init message's tool list, MCP servers, skills/plugins/slash commands, and the measured input-token count. **Impact on design** must state whether the option set above is sufficient isolation (no tools, no MCP, no CLAUDE.md, no skills/plugins) or which additional option is required, and give the measured baseline input tokens for an empty card (spec default `routerMaxInputTokens` is 6000).

- [ ] **Step 5: Commit**

```bash
git add tests/superagent-auto-mode-probe.manual.mjs tests/superagent-router-isolation-probe.manual.mjs docs/superpowers/spikes/2026-11-03-superagent-spikes.md
git commit -m "test: spike probes for auto mode and isolated router calls"
```

---

### Task 2: Spike probes — `PreCompact` hook and subagent usage

**Files:**
- Create: `tests/superagent-precompact-probe.manual.mjs`
- Create: `tests/superagent-subagent-usage-probe.manual.mjs`
- Modify: `docs/superpowers/spikes/2026-11-03-superagent-spikes.md` (append S2, S3)

**Interfaces:**
- Consumes: `query` from `@anthropic-ai/claude-agent-sdk` directly (not `startSession`, which filters subagent messages at `src/session.js:381`).
- Produces: findings sections `S2 PreCompact` and `S3 subagent usage`.

- [ ] **Step 1: Write `tests/superagent-precompact-probe.manual.mjs`**

Streams input (an async iterable, like `src/session.js`'s input queue) into one `query()` with `model: 'claude-sonnet-5-5'`, `permissionMode: 'acceptEdits'`, a temp cwd, and `hooks: { PreCompact: [{ hooks: [async (input) => { log(input); return { continue: true }; }] }] }`. Turn 1: "Read package.json and summarise it in one line." Turn 2: the literal input `/compact`. Logs the full hook `input` object, every message between the `/compact` input and the next `result` (especially any `compact_boundary` system message), and whether the session accepts a turn 3 ("What file did you read earlier?") afterwards. Header comment as in Task 1, cost "a few cents".

- [ ] **Step 2: Run it and record S2**

Run: `node tests/superagent-precompact-probe.manual.mjs`
Record under **S2 PreCompact**: whether the hook fired, its input fields (e.g. `trigger`, `custom_instructions`), whether a hook return value can influence the compaction, and whether the model could still take an action (like writing a file) at that point. **Impact on design** must state either "usable as a mid-turn checkpoint trigger: <how>" or "not usable; keep the post-turn handoff backstop only (spec §Context drift for workers)".

- [ ] **Step 3: Write `tests/superagent-subagent-usage-probe.manual.mjs`**

One `query()` with `model: 'claude-sonnet-5-5'`, `permissionMode: 'acceptEdits'`, repo cwd, prompt: "Use the Agent tool to spawn one general-purpose subagent that counts the .js files in src/ and reports the number. Then tell me the number." Logs, for every message: `type`, `parent_tool_use_id`, and `message.usage` if present; then the `result` message's `usage`, `modelUsage` and `total_cost_usd`. Prints two sums: usage from top-level assistant messages only, and usage from messages with `parent_tool_use_id` set. Header comment as in Task 1, cost "a few cents".

- [ ] **Step 4: Run it and record S3**

Run: `node tests/superagent-subagent-usage-probe.manual.mjs`
Record under **S3 subagent usage**: whether subagent messages carry `usage`, whether the `result` message's `usage`/`modelUsage`/`total_cost_usd` already include the subagent's spend (compare the two sums against the result totals). **Impact on design** must name the source the usage ledger (spec §Budget and usage ledger) should read: per-message usage including `parent_tool_use_id` messages, or the `result` message's aggregate.

- [ ] **Step 5: Commit**

```bash
git add tests/superagent-precompact-probe.manual.mjs tests/superagent-subagent-usage-probe.manual.mjs docs/superpowers/spikes/2026-11-03-superagent-spikes.md
git commit -m "test: spike probes for PreCompact and subagent usage"
```

---

### Task 3: Multi-listener registry hooks

**Files:**
- Modify: `src/session-registry.js:36-87` (hook state, `set*`, `removeSession`), `:407-411` (`_reset`), `:1455-1490` (`handleApprovalRequest`)
- Test: `tests/session-registry.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function addSessionRemovedListener(fn: ({ id, reason }) => void): () => void` — returns an idempotent unsubscribe.
  - `export function addApprovalInterceptor(fn: ({ row, request }) => PermissionResult | null): () => void` — returns an idempotent unsubscribe. Interceptors are consulted in registration order; the **first non-null** decision wins; must stay synchronous (existing contract comment at `:56-71` applies to each).
  - `setSessionRemovedListener(fn)` / `setApprovalInterceptor(fn)` keep their exact current semantics as a **legacy single slot**: each call replaces the previous legacy registration (and `null` removes it) without touching listeners added via `add*`. Auto-pilot keeps calling these unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test('addApprovalInterceptor: first non-null decision wins, in registration order', () => {
  registry._reset();
  const calls = [];
  registry.addApprovalInterceptor(() => { calls.push('a'); return null; });
  registry.addApprovalInterceptor(() => { calls.push('b'); return { behavior: 'deny', message: 'from b' }; });
  registry.addApprovalInterceptor(() => { calls.push('c'); return { behavior: 'allow' }; });
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  impl.emitApprovalRequest({});
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(row.pendingApprovals.length, 0);
  registry._reset();
});

test('approval falls through when every interceptor returns null', () => {
  registry._reset();
  registry.addApprovalInterceptor(() => null);
  registry.setApprovalInterceptor(() => null);
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  impl.emitApprovalRequest({});
  assert.equal(row.pendingApprovals.length, 1);
  registry._reset();
});

test('a throwing interceptor does not block later interceptors', () => {
  registry._reset();
  registry.addApprovalInterceptor(() => { throw new Error('boom'); });
  registry.addApprovalInterceptor(() => ({ behavior: 'deny', message: 'second' }));
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  impl.emitApprovalRequest({});
  assert.equal(row.pendingApprovals.length, 0);
  registry._reset();
});

test('setApprovalInterceptor replaces only the legacy slot', () => {
  registry._reset();
  const seen = [];
  registry.addApprovalInterceptor(() => { seen.push('added'); return null; });
  registry.setApprovalInterceptor(() => { seen.push('legacy-1'); return null; });
  registry.setApprovalInterceptor(() => { seen.push('legacy-2'); return null; });
  const impl = fakeStartSession();
  registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  impl.emitApprovalRequest({});
  assert.deepEqual(seen, ['added', 'legacy-2']);
  registry.setApprovalInterceptor(null);
  seen.length = 0;
  impl.emitApprovalRequest({});
  assert.deepEqual(seen, ['added']);
  registry._reset();
});

test('addSessionRemovedListener: every listener fires; a throwing one does not block later ones', () => {
  registry._reset();
  const seen = [];
  registry.addSessionRemovedListener(() => { throw new Error('boom'); });
  registry.addSessionRemovedListener((e) => seen.push(['added', e.reason]));
  registry.setSessionRemovedListener((e) => seen.push(['legacy', e.reason]));
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  registry.closeSession(row.id);
  assert.deepEqual(seen, [['added', 'closed'], ['legacy', 'closed']]);
  registry._reset();
});

test('unsubscribe is idempotent and safe during dispatch', () => {
  registry._reset();
  const seen = [];
  let off2;
  registry.addSessionRemovedListener(() => { seen.push(1); off2(); });
  off2 = registry.addSessionRemovedListener(() => seen.push(2));
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  registry.closeSession(row.id);
  off2();
  const row2 = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  registry.closeSession(row2.id);
  assert.deepEqual(seen, [1, 2, 1]);
  registry._reset();
});
```

(Dispatch iterates a snapshot, so a listener removed mid-dispatch still receives the in-flight event, then nothing after. `fakeStartSession().emitApprovalRequest(input)` always reports `toolName: 'ExitPlanMode'` (`tests/test-helpers.mjs:163-168`); the hooks are tool-agnostic, so that is fine.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/session-registry.test.mjs`
Expected: FAIL — `registry.addApprovalInterceptor is not a function`.

- [ ] **Step 3: Implement in `src/session-registry.js`**

Replace the two module-level slots with `const removedListeners = new Set()` and `const approvalInterceptors = []` plus `let legacyRemovedListener = null` / `let legacyApprovalInterceptor = null` holding the function currently installed through the `set*` slot. `add*` push and return an unsubscribe that removes that exact registration once. `set*` remove the previous legacy registration (if any) and add the new one (if a function). `removeSession` iterates `[...removedListeners]`, each call in its own try/catch with the existing `console.error` message. `handleApprovalRequest` iterates a snapshot of `approvalInterceptors`, each in its own try/catch, stopping at the first non-null decision, then continues with the existing resolve/fall-through code unchanged. `_reset()` clears both collections and both legacy slots. Update the two existing comment blocks (`:36-50`, `:56-71`) to describe multiple listeners and the legacy slot; keep their reasoning.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 687 tests (681 + 6), 0 failures — including every existing `setSessionRemovedListener`/`setApprovalInterceptor` and `tests/autopilot.test.mjs` test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/session-registry.js tests/session-registry.test.mjs
git commit -m "feat: multi-listener session-removed and approval hooks with legacy slot"
```

---

### Task 4: Rate-limit transition listener

**Files:**
- Modify: `src/session-registry.js:893-926` (both `rateLimitHit` assignment sites), plus a new exported function next to the Task 3 hooks; `_reset` clears it
- Test: `tests/session-registry.test.mjs` (append)

**Interfaces:**
- Consumes: Task 3's listener pattern (Set + snapshot dispatch + per-call try/catch).
- Produces: `export function addRateLimitListener(fn: (event: { id: string, provider: string, cwd: string, rateLimitHit: { resetsAt: number|null, rateLimitType: string|null } | null }) => void): () => void`. Fired **after** `row.rateLimitHit` is updated: on every set (both the `rate_limit_event` `rejected` path and the session-limit-text path), and on the clear path (`rateLimitHit` non-null → `null`) with `rateLimitHit: null`. Not fired when an allowed event arrives and nothing was set.

- [ ] **Step 1: Write the failing tests**

```js
test('addRateLimitListener fires on a rejected rate_limit_event and on its clear', () => {
  registry._reset();
  const seen = [];
  registry.addRateLimitListener((e) => seen.push(e));
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  impl.emitMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour' } });
  impl.emitMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  impl.emitMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.deepEqual(seen, [
    { id: row.id, provider: row.provider, cwd: '/tmp', rateLimitHit: { resetsAt: 1900000000 * 1000, rateLimitType: 'five_hour' } },
    { id: row.id, provider: row.provider, cwd: '/tmp', rateLimitHit: null },
  ]);
  registry._reset();
});

test('addRateLimitListener fires on the session-limit text path', () => {
  registry._reset();
  const seen = [];
  registry.addRateLimitListener((e) => seen.push(e));
  const impl = fakeStartSession();
  registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  impl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 2:10am (Europe/Paris)" }] } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].rateLimitHit.rateLimitType, 'session_limit_text');
  assert.equal(typeof seen[0].rateLimitHit.resetsAt, 'number');
  registry._reset();
});

test('a throwing rate-limit listener does not break message handling', () => {
  registry._reset();
  registry.addRateLimitListener(() => { throw new Error('boom'); });
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });
  impl.emitMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour' } });
  assert.equal(row.rateLimitHit.rateLimitType, 'five_hour');
  registry._reset();
});
```

The text in the second test matches `SESSION_LIMIT_TEXT_RE` (`src/session-registry.js:1317`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/session-registry.test.mjs`
Expected: FAIL — `registry.addRateLimitListener is not a function`.

- [ ] **Step 3: Implement `addRateLimitListener` and a private `notifyRateLimit(id, row)` in `src/session-registry.js`**

`notifyRateLimit` builds the event from `row.provider`, `row.cwd`, `row.rateLimitHit` and dispatches over a snapshot with per-call try/catch (`console.error('rate-limit listener failed for ${id}:', err)`). Call it at the three transition points: after the `rejected` assignment (`:901`), inside the `else if (row.rateLimitHit)` clear branch after `row.rateLimitHit = null` (`:904`), and after the text-path assignment (`:923`). `_reset()` clears the listener set.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 690 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/session-registry.js tests/session-registry.test.mjs
git commit -m "feat: rate-limit transition listener on the session registry"
```

---

### Task 5: Durable provider-cooldown store

**Files:**
- Create: `src/provider-cooldowns.js`
- Test: `tests/provider-cooldowns.test.mjs`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` from `src/json-store.js:17,40`.
- Produces:

```js
export function defaultCooldownsPath(): string  // <COCKPIT_HOME|homedir>/.prompt-cockpit/provider-cooldowns.json
export function createProviderCooldowns({ filePath = defaultCooldownsPath(), now = Date.now } = {}): {
  load(): Promise<void>,                       // reads file into memory; missing/corrupt → empty
  record(provider: string, hit: { resetsAt: number|null, rateLimitType: string|null }): Promise<void>,
  clear(provider: string): Promise<void>,
  get(provider: string): { resetsAt: number|null, rateLimitType: string|null, firstSeenAt: number, lastSeenAt: number } | null,
  activeProviders(at?: number): Set<string>,   // synchronous; resetsAt == null OR resetsAt > at
}
```

File shape: `{ "providers": { "<provider>": { "resetsAt": number|null, "rateLimitType": string|null, "firstSeenAt": number, "lastSeenAt": number } } }`. `record` keeps `firstSeenAt` when the provider already has an entry and updates the rest. Writes are serialised (chain each write on the previous write's promise) so concurrent `record`/`clear` calls land in call order. `get` returns `null` for an entry whose non-null `resetsAt` has passed.

- [ ] **Step 1: Write the failing tests** (use a temp dir per test via `fs.mkdtempSync`, and an injected `now`)

```js
test('record then activeProviders reports the provider until resetsAt passes', async () => {
  let t = 1000;
  const store = createProviderCooldowns({ filePath: tmpFile(), now: () => t });
  await store.record('claude', { resetsAt: 5000, rateLimitType: 'five_hour' });
  assert.deepEqual([...store.activeProviders(4999)], ['claude']);
  assert.deepEqual([...store.activeProviders(5000)], []);
});

test('a null resetsAt stays active until cleared', async () => {
  const store = createProviderCooldowns({ filePath: tmpFile(), now: () => 1000 });
  await store.record('claude', { resetsAt: null, rateLimitType: null });
  assert.ok(store.activeProviders(10 ** 13).has('claude'));
  await store.clear('claude');
  assert.equal(store.activeProviders(1000).size, 0);
});

test('record keeps firstSeenAt and updates lastSeenAt', async () => {
  let t = 1000;
  const store = createProviderCooldowns({ filePath: tmpFile(), now: () => t });
  await store.record('claude', { resetsAt: 9000, rateLimitType: 'five_hour' });
  t = 2000;
  await store.record('claude', { resetsAt: 9500, rateLimitType: 'five_hour' });
  assert.deepEqual(store.get('claude'), { resetsAt: 9500, rateLimitType: 'five_hour', firstSeenAt: 1000, lastSeenAt: 2000 });
});

test('state survives a reload from disk', async () => {
  const filePath = tmpFile();
  const a = createProviderCooldowns({ filePath, now: () => 1000 });
  await a.record('claude', { resetsAt: 9000, rateLimitType: 'seven_day' });
  const b = createProviderCooldowns({ filePath, now: () => 1000 });
  await b.load();
  assert.equal(b.get('claude').rateLimitType, 'seven_day');
});

test('load tolerates a missing or corrupt file', async () => {
  const missing = createProviderCooldowns({ filePath: tmpFile() });
  await missing.load();
  assert.equal(missing.activeProviders().size, 0);
  const filePath = tmpFile();
  fs.writeFileSync(filePath, '{not json');
  const corrupt = createProviderCooldowns({ filePath, now: () => 1000 });
  await corrupt.load();
  assert.equal(corrupt.activeProviders().size, 0);
  await corrupt.record('claude', { resetsAt: 9000, rateLimitType: null });
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).providers.claude.resetsAt, 9000);
});

test('concurrent writes land in call order', async () => {
  const filePath = tmpFile();
  const store = createProviderCooldowns({ filePath, now: () => 1000 });
  await Promise.all([
    store.record('claude', { resetsAt: 9000, rateLimitType: null }),
    store.clear('claude'),
  ]);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).providers.claude, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/provider-cooldowns.test.mjs`
Expected: FAIL — cannot find module `../src/provider-cooldowns.js`.

- [ ] **Step 3: Implement `src/provider-cooldowns.js`** per the Interfaces block, with a header comment naming spec §Usage cap and why the store exists (rows clear `rateLimitHit` on the next allowed event and vanish on error, `src/session-registry.js:903-905`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 696 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/provider-cooldowns.js tests/provider-cooldowns.test.mjs
git commit -m "feat: durable provider-cooldown store"
```

---

### Task 6: Wire cooldowns into the server and auto-pilot back-off

**Files:**
- Modify: `src/server.js:44-47` (create, load, subscribe; pass to `createAutopilot`)
- Modify: `src/autopilot.js` — `createAutopilot` destructuring (accept optional `cooldowns`), `rateLimitedProviders()` at `:185-197`
- Test: `tests/autopilot.test.mjs` (append)

**Interfaces:**
- Consumes: `addRateLimitListener` (Task 4), `createProviderCooldowns` (Task 5).
- Produces: `createAutopilot({ ..., cooldowns })` where `cooldowns` is optional `{ activeProviders(at): Set<string> }`; when absent, behaviour is identical to today. `rateLimitedProviders()` returns the union of today's row-derived set and `cooldowns.activeProviders(now())`.

- [ ] **Step 1: Write the failing tests** in `tests/autopilot.test.mjs`, using that file's existing harness (`api` fake registry at `:60-75` and its existing rate-limit precondition tests as the pattern — search the file for `rateLimitHit`)

- `cooldown store blocks a due pilot on that provider even when no row is rate-limited` — fake `cooldowns.activeProviders = () => new Set(['claude'])`, a due Claude pilot, no rows with `rateLimitHit`; after one tick the pilot did not fire and its logged skip reason is the same rate-limit reason today's row-based path logs.
- `cooldown store for another provider does not block` — `activeProviders` returns `new Set(['grok'])`; the Claude pilot fires.
- `no cooldowns dependency behaves exactly as before` — construct without `cooldowns`; an existing row-based rate-limit test's expectations hold (reuse its setup).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/autopilot.test.mjs`
Expected: FAIL on the first new test (pilot fires).

- [ ] **Step 3: Implement**

In `src/autopilot.js`, accept `cooldowns` in `createAutopilot`'s options and, in `rateLimitedProviders()`, add every provider from `cooldowns?.activeProviders(at)` to `blocked` after the row loop; extend the function's comment with one sentence on the durable store. In `src/server.js`, after `const tracker`/registry setup: `const cooldowns = createProviderCooldowns();`, `cooldowns.load().catch((err) => console.error('provider cooldowns failed to load:', err));`, `registry.addRateLimitListener(({ provider, rateLimitHit }) => { (rateLimitHit ? cooldowns.record(provider, rateLimitHit) : cooldowns.clear(provider)).catch((err) => console.error('provider cooldown write failed:', err)); });`, and pass `cooldowns` into `createAutopilot`. Export `cooldowns` alongside the existing server exports (`:214`) for Plan 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 699 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot.js src/server.js tests/autopilot.test.mjs
git commit -m "feat: persist rate-limit hits and let auto-pilot back off on them"
```

---

### Task 7: Session option pass-through (`sdkOptions`)

**Files:**
- Modify: `src/session-registry.js:103` (`createSession` signature) and `:282-305` (`startSessionImpl` call)
- Modify: `src/session.js:186` (`startSession` signature) and `:238-250` (query options)
- Test: `tests/session.test.mjs`, `tests/session-registry.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `createSession({ ..., sdkOptions })` forwards `sdkOptions` unchanged to `startSessionImpl({ ..., sdkOptions })`.
  - `startSession({ ..., sdkOptions })` in `src/session.js`: exported constant `SDK_PASSTHROUGH_KEYS = ['additionalDirectories', 'maxTurns', 'allowedTools', 'disallowedTools', 'tools', 'settingSources']`. Each key present (not `undefined`) in `sdkOptions` is copied onto the `query()` options; any other key is ignored. `sdkOptions.appendSystemPrompt` (string) is appended to the preset's `append` as `ASK_SYSTEM_PROMPT_APPEND + '\n\n' + appendSystemPrompt`. Grok/Codex `startSession` implementations receive and ignore `sdkOptions` (no change needed there).

- [ ] **Step 1: Write the failing tests**

In `tests/session.test.mjs`, using `startFakeSession` (`:112-127`, returns `{ handle, session, messages, states, getOptions }`):

```js
test('sdkOptions passes whitelisted keys through to query options', () => {
  const { getOptions } = startFakeSession({
    sdkOptions: { additionalDirectories: ['/x', '/y'], maxTurns: 40, disallowedTools: ['Write'], settingSources: ['project'], bogus: 1 },
  });
  assert.deepEqual(getOptions().additionalDirectories, ['/x', '/y']);
  assert.equal(getOptions().maxTurns, 40);
  assert.deepEqual(getOptions().disallowedTools, ['Write']);
  assert.deepEqual(getOptions().settingSources, ['project']);
  assert.equal('bogus' in getOptions(), false);
});

test('sdkOptions.appendSystemPrompt is appended after the cockpit append', () => {
  const { getOptions } = startFakeSession({ sdkOptions: { appendSystemPrompt: 'ROLE: planner' } });
  assert.ok(getOptions().systemPrompt.append.endsWith('\n\nROLE: planner'));
});

test('no sdkOptions leaves query options exactly as before', () => {
  const { getOptions } = startFakeSession();
  for (const key of ['additionalDirectories', 'maxTurns', 'allowedTools', 'disallowedTools', 'tools', 'settingSources']) {
    assert.equal(key in getOptions(), false, key);
  }
});
```

In `tests/session-registry.test.mjs`:

```js
test('createSession forwards sdkOptions to the provider start function', () => {
  registry._reset();
  const impl = fakeStartSession();
  registry.createSession({ cwd: '/tmp', startSessionImpl: impl, sdkOptions: { maxTurns: 5 } });
  assert.deepEqual(impl.lastOpts.sdkOptions, { maxTurns: 5 });
  registry._reset();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/session.test.mjs tests/session-registry.test.mjs`
Expected: FAIL — `maxTurns` undefined / `sdkOptions` undefined.

- [ ] **Step 3: Implement** per the Interfaces block. In `src/session.js`, build the pass-through with a small loop over `SDK_PASSTHROUGH_KEYS` and spread it into the options object after the existing fields; keep `systemPrompt`'s shape (`{ type: 'preset', preset: 'claude_code', append }`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 703 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/session.js src/session-registry.js tests/session.test.mjs tests/session-registry.test.mjs
git commit -m "feat: opt-in SDK option pass-through for supervisor-launched sessions"
```

---

### Task 8: Pricing for the 5.5 models

**Files:**
- Modify: `src/pricing.json` (`models`)
- Test: `tests/usage.test.mjs` (append)

**Interfaces:**
- Consumes: `costForUsage(model, usage)` from `src/usage.js:34`.
- Produces: priced entries for `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.

Rates (USD per 1M tokens). Input, output and the Opus/Sonnet cache-read values come from Anthropic's published model table (cached 2026-10-06); **the cells marked "verify" must be checked against the page `pricing.json` already cites (`platform.claude.com/docs/en/about-claude/pricing`) before committing**, and the `_comment` verification date updated:

| Model | input | output | cache_write_5m | cache_write_1h | cache_read |
|---|---|---|---|---|---|
| claude-opus-5-5 | 4 | 20 | verify | verify | 0.20 |
| claude-sonnet-5-5 | 2 | 10 | verify | verify | 0.20 |
| claude-haiku-5-5 | 0.10 | 0.50 | verify | verify | verify |

Haiku 5.5's rates apply to prompts up to 100K tokens ($0.50 / $2.50 beyond). `costForUsage` is flat-rate, so record the ≤100K rate and say so in the entry's `confidence` field (superagent router requests are capped at 6K tokens).

- [ ] **Step 1: Write the failing test**

```js
test('5.5 models are priced', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(costForUsage('claude-opus-5-5', usage), 24);
  assert.equal(costForUsage('claude-sonnet-5-5', usage), 12);
  assert.equal(costForUsage('claude-haiku-5-5', usage), 0.6);
});
```

(If `costForUsage` returns floating-point noise for Haiku, compare with `Math.abs(x - 0.6) < 1e-9`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/usage.test.mjs`
Expected: FAIL — `null !== 24`.

- [ ] **Step 3: Verify the "verify" cells against the cited pricing page, then add the three entries** in the existing entry format, each with a `confidence` note naming the source and date.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 704 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/pricing.json tests/usage.test.mjs
git commit -m "chore: price Opus 5.5, Sonnet 5.5 and Haiku 5.5"
```

---

## After this plan

- Update the spec's "Spikes" section with a one-line outcome per spike and a link to `docs/superpowers/spikes/2026-11-03-superagent-spikes.md`; if any spike changes a decision, revise the spec (new revision note) before writing Plan 2.
- Plan 2 (milestone 1: config, store, worktrees, results, sequencer, runner) is written against the code this plan leaves behind.
