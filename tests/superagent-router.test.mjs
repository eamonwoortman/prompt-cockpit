import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ROUTER_ACTIONS, ROUTED_REASONS, ROUTER_OVERHEAD_TOKENS, NOTE_MAX_WORDS, ROUTER_SYSTEM_PROMPT,
  estimateTokens, allowedActions, buildRouterRequest, validateRouterOutput,
  readUserApiKeyHelper, createRouter,
} from '../src/superagent/router.js';
import * as sequencer from '../src/superagent/sequencer.js';

const w = (n, p = 'w') => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');

function makeJob({ decisions = 7, noteWords = 40, phaseWords = 80 } = {}) {
  return {
    title: 'Add widgets',
    mode: 'autonomous',
    phaseIndex: 3,
    phaseId: 'plan',
    pipeline: [
      { phase: 'spec', kind: 'author' },
      { phase: 'approve', kind: 'human' },
      { phase: 'spec-review', kind: 'review' },
      { phase: 'plan', kind: 'author' },
    ],
    attempts: [
      { phase: 'spec', outcome: 'failed', summary: 'old failure' },
      { phase: 'spec', outcome: 'done', summary: w(phaseWords, 's') },
      { phase: 'spec-review', outcome: 'done', summary: 'looks fine' },
      { phase: 'plan', outcome: 'done', summary: 'current phase, never listed' },
    ],
    routerDecisions: Array.from({ length: decisions }, (_, i) => ({ action: 'retry', note: `${i} ${w(noteWords, 'n')}` })),
  };
}

const trigger = (over = {}) => ({
  attemptId: 'a1', phase: 'plan', task: null, role: 'planner', reason: 'failed', status: 'failed',
  summary: w(100, 't'), question: null, signature: 'sig', attemptsUsed: 2, attemptsLeft: 1,
  allowed: ['retry', 'escalate'], resultPath: '/tmp/result.json', ...over,
});

test('constants live in the sequencer and are re-exported', () => {
  assert.equal(ROUTER_ACTIONS, sequencer.ROUTER_ACTIONS);
  assert.equal(ROUTED_REASONS, sequencer.ROUTED_REASONS);
  assert.deepEqual(ROUTER_ACTIONS, ['retry', 'retry-alternate', 'retry-handoff', 'escalate']);
  assert.deepEqual([...ROUTED_REASONS], ['no-result', 'invalid-result', 'turn-cap', 'stalled', 'failed', 'blocked']);
});

test('allowedActions offers alternate and handoff only when available', () => {
  assert.deepEqual(allowedActions({ model: 'a', alternate: null, handoffExists: false }), ['retry', 'escalate']);
  assert.deepEqual(allowedActions({ model: 'a', alternate: 'a' }), ['retry', 'escalate']);
  assert.deepEqual(allowedActions({ model: 'a', alternate: 'b', handoffExists: true }), ROUTER_ACTIONS);
});

test('estimateTokens counts UTF-8 bytes', () => {
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('漢字漢'), 3);
  assert.equal(estimateTokens('😀'), 2);
});

test('the card carries title, mode, phase, completed phases, last 5 decisions and the trigger', () => {
  const t = trigger();
  const r = buildRouterRequest(makeJob(), t, { maxInputTokens: 100000 });
  assert.equal(r.ok, true);
  const card = JSON.parse(r.card);
  assert.deepEqual(card.job, { title: 'Add widgets', mode: 'autonomous', phase: 'plan' });
  assert.equal(card.phases.length, 2);
  assert.equal(card.phases[0], `spec: done - ${w(60, 's')}`);
  assert.equal(card.phases[1], 'spec-review: done - looks fine');
  assert.equal(card.decisions.length, 5);
  assert.ok(card.decisions[0].note.startsWith('2 '));
  assert.equal(card.decisions[0].note.split(' ').length, NOTE_MAX_WORDS);
  assert.deepEqual(card.trigger, t);
  assert.deepEqual(card.allowed, t.allowed);
  assert.equal(r.system, ROUTER_SYSTEM_PROMPT);
  assert.equal(r.estimatedTokens, ROUTER_OVERHEAD_TOKENS + estimateTokens(r.system) + estimateTokens(r.card));
  assert.deepEqual(r.truncated, []);
});

test('a job without routerDecisions builds an empty decision list', () => {
  const job = makeJob();
  delete job.routerDecisions;
  assert.deepEqual(JSON.parse(buildRouterRequest(job, trigger(), { maxInputTokens: 100000 }).card).decisions, []);
});

test('truncation drops completed-phase lines oldest first, then shortens notes, then the summary', () => {
  const job = makeJob();
  const t = trigger();
  const full = buildRouterRequest(job, t, { maxInputTokens: 100000 });

  const one = buildRouterRequest(job, t, { maxInputTokens: full.estimatedTokens - 1 });
  assert.equal(one.ok, true);
  assert.deepEqual(one.truncated, ['phases']);
  assert.deepEqual(JSON.parse(one.card).phases, ['spec-review: done - looks fine']);
  assert.ok(one.estimatedTokens <= full.estimatedTokens - 1);

  const base = buildRouterRequest({ ...job, phaseIndex: 0 }, t, { maxInputTokens: 100000 });
  const notes = buildRouterRequest(job, t, { maxInputTokens: base.estimatedTokens - 1 });
  assert.equal(notes.ok, true);
  assert.deepEqual(notes.truncated, ['phases', 'notes']);
  const nc = JSON.parse(notes.card);
  assert.deepEqual(nc.phases, []);
  assert.ok(nc.decisions.every((d) => d.note.endsWith('…') && d.note.split(' ').length === 8));
  assert.equal(nc.trigger.summary, t.summary);
  assert.ok(notes.estimatedTokens <= base.estimatedTokens - 1);

  const cut = buildRouterRequest(job, t, { maxInputTokens: notes.estimatedTokens - 1 });
  assert.equal(cut.ok, true);
  assert.deepEqual(cut.truncated, ['phases', 'notes', 'summary']);
  assert.equal(JSON.parse(cut.card).trigger.summary, `${w(20, 't')} (full result: /tmp/result.json)`);
  assert.ok(cut.estimatedTokens <= notes.estimatedTokens - 1);
});

test('over the limit after every step: no call, over-limit', () => {
  const r = buildRouterRequest(makeJob(), trigger(), { maxInputTokens: 700 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'over-limit');
  assert.ok(r.estimatedTokens > 700);
  assert.ok(r.truncated.includes('summary'));
});

test('adversarial job text stays bounded', () => {
  const job = makeJob({ phaseWords: 500 });
  job.title = 'x'.repeat(5000);
  const r = buildRouterRequest(job, trigger({ summary: '漢'.repeat(2000) }), { maxInputTokens: 6000 });
  if (r.ok) {
    assert.ok(r.estimatedTokens <= 6000);
    assert.equal(JSON.parse(r.card).job.title.length, 200);
  } else {
    assert.equal(r.error, 'over-limit');
  }
});

const limits = { allowed: ['retry', 'escalate'], maxOutputTokens: 300, outputTokens: 20 };

test('validateRouterOutput accepts exact JSON and one fenced block', () => {
  const json = '{"action":"retry","note":"x"}';
  assert.deepEqual(validateRouterOutput(json, limits), { ok: true, action: 'retry', note: 'x' });
  assert.equal(validateRouterOutput('```json\n' + json + '\n```', limits).ok, true);
});

test('validateRouterOutput rejects bad output', () => {
  const bad = (text, over = {}) => validateRouterOutput(text, { ...limits, ...over }).error;
  assert.equal(bad('not json'), 'unparseable');
  assert.equal(bad('{"action":"retry-alternate","note":"x"}'), 'action-not-allowed');
  assert.equal(bad('{"action":"retry","note":"x","extra":1}'), 'bad-shape');
  assert.equal(bad('{"action":"retry"}'), 'bad-shape');
  assert.equal(bad('{"action":"retry","note":5}'), 'bad-shape');
  assert.equal(bad(`{"action":"retry","note":"${w(31)}"}`), 'note-too-long');
  assert.equal(validateRouterOutput(`{"action":"retry","note":"${w(30)}"}`, limits).ok, true);
  const ok = '{"action":"retry","note":"x"}';
  assert.equal(bad(ok, { outputTokens: 301 }), 'over-length');
  for (const v of [undefined, NaN, Infinity]) assert.equal(bad(ok, { outputTokens: v }), 'usage-missing');
});

const MODEL = 'claude-haiku-5-5';
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-router-'));
after(() => fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {}));

const init = (over = {}) => ({
  type: 'system', subtype: 'init', tools: [], mcp_servers: [],
  plugins: [{ name: 'cc-plugin-privacy', path: 'builtin', source: 'cc-plugin-privacy@builtin' }],
  apiKeySource: 'apiKeyHelper', ...over,
});
const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const resultMsg = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: '',
  modelUsage: { [MODEL]: { inputTokens: 2, outputTokens: 17, cacheReadInputTokens: 0, cacheCreationInputTokens: 2425, costUSD: 0.0004937 } },
  ...over,
});
const goodReply = (text = '{"action":"retry","note":"n"}') => [init(), assistant(text), resultMsg()];
const never = () => new Promise(() => {});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function fakeQuery(messages = goodReply(), { hang = false, throwError = null } = {}) {
  const calls = [];
  const closed = [];
  const impl = (args) => {
    calls.push(args);
    const gen = (async function* () {
      for (const m of messages) yield m;
      if (throwError) throw throwError;
      if (hang) await never();
    })();
    return Object.assign(gen, { close() { closed.push(true); }, async interrupt() {} });
  };
  return { impl, calls, closed };
}

const decideArgs = (over = {}) => ({
  model: MODEL, allowlist: [MODEL], system: 'sys', card: '{"card":1}',
  allowed: ['retry', 'escalate'], maxOutputTokens: 300, ...over,
});
const makeRouter = (queryImpl, over = {}) => createRouter({
  queryImpl, cwd: path.join(tmpRoot, 'unused'), apiKeyHelper: async () => 'helper-cmd',
  mkdirImpl: async () => {}, baseEnv: { A: '1' }, ...over,
});

test('decide passes exactly the isolation options', async () => {
  const q = fakeQuery();
  const cwd = path.join(tmpRoot, 'iso', 'router');
  const r = await createRouter({ queryImpl: q.impl, cwd, apiKeyHelper: async () => 'helper-cmd', baseEnv: { A: '1' } })
    .decide(decideArgs());
  assert.equal(r.ok, true);
  assert.equal(q.calls.length, 1);
  const { prompt, options } = q.calls[0];
  assert.equal(prompt, '{"card":1}');
  assert.ok(options.abortController instanceof AbortController);
  assert.deepEqual(options, {
    model: MODEL, maxTurns: 1, tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
    systemPrompt: 'sys', settings: { autoMemoryEnabled: false, apiKeyHelper: 'helper-cmd' },
    persistSession: false, thinking: { type: 'disabled' }, cwd, abortController: options.abortController,
    env: { A: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '300' },
  });
  assert.ok((await fs.stat(cwd)).isDirectory());
  assert.equal(q.closed.length, 1);
});

test('no helper or unreadable settings: settings carry only autoMemoryEnabled', async () => {
  const q = fakeQuery();
  await makeRouter(q.impl, { apiKeyHelper: async () => null }).decide(decideArgs());
  assert.deepEqual(q.calls[0].options.settings, { autoMemoryEnabled: false });

  const dir = await fs.mkdtemp(path.join(tmpRoot, 'cfg-'));
  const file = path.join(dir, 'settings.json');
  assert.equal(await readUserApiKeyHelper({ configDir: dir }), null);
  await fs.writeFile(file, '{not json');
  assert.equal(await readUserApiKeyHelper({ configDir: dir }), null);
  await fs.writeFile(file, '{"apiKeyHelper":5}');
  assert.equal(await readUserApiKeyHelper({ configDir: dir }), null);
  await fs.writeFile(file, '{"apiKeyHelper":"x"}');
  assert.equal(await readUserApiKeyHelper({ configDir: dir }), 'x');

  const env = process.env;
  const saved = env.CLAUDE_CONFIG_DIR;
  env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.equal(await readUserApiKeyHelper(), 'x');
    const read = [];
    assert.equal(await readUserApiKeyHelper({ readFileImpl: async (p) => { read.push(p); throw new Error('nope'); } }), null);
    assert.deepEqual(read, [file]);
  } finally {
    if (saved === undefined) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('a good reply resolves ok with usage and latency', async () => {
  let t = 1000;
  const r = await makeRouter(fakeQuery().impl, { now: () => (t += 5) }).decide(decideArgs());
  assert.deepEqual(r, {
    ok: true, action: 'retry', note: 'n',
    usage: { inputTokens: 2, outputTokens: 17, cacheReadInputTokens: 0, cacheCreationInputTokens: 2425, totalInputTokens: 2427, costUsd: 0.0004937 },
    latencyMs: 5, apiKeySource: 'apiKeyHelper',
  });
});

test('a model off the allowlist is refused without a call', async () => {
  const q = fakeQuery();
  const r = await makeRouter(q.impl).decide(decideArgs({ model: 'claude-opus-5-5' }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'model-not-allowed: claude-opus-5-5');
  assert.equal(r.usage, null);
  assert.equal(r.apiKeySource, null);
  assert.equal(q.calls.length, 0);
});

test('an error result fails', async () => {
  const errResult = resultMsg({ subtype: 'error_during_execution', is_error: true, errors: ['boom happened'] });
  const a = await makeRouter(fakeQuery([init(), errResult]).impl).decide(decideArgs());
  assert.equal(a.ok, false);
  assert.match(a.error, /boom happened/);
  assert.equal(a.usage.outputTokens, 17);

  const b = await makeRouter(fakeQuery([], { throwError: new Error('Not logged in · Please run /login') }).impl)
    .decide(decideArgs());
  assert.equal(b.ok, false);
  assert.match(b.error, /Not logged in · Please run \/login/);
  assert.equal(b.usage, null);

  const c = await makeRouter(fakeQuery([init(), assistant('{"action":"retry","note":"n"}')]).impl).decide(decideArgs());
  assert.equal(c.ok, false);
  assert.equal(c.error, 'no-result');
});

test('an init listing a tool, an MCP server or a non-builtin plugin aborts as isolation-breach', async () => {
  const cases = [
    [{ tools: ['Bash'] }, 'isolation-breach: tool Bash'],
    [{ mcp_servers: [{ name: 'x', status: 'connected' }] }, 'isolation-breach: mcp server x'],
    [{ plugins: [{ name: 'p', path: 'C:/x/p', source: 'p@market' }] }, 'isolation-breach: plugin p@market'],
  ];
  for (const [over, error] of cases) {
    const q = fakeQuery([init(over), assistant('{"action":"retry","note":"n"}'), resultMsg()]);
    const r = await makeRouter(q.impl).decide(decideArgs());
    assert.equal(r.ok, false);
    assert.equal(r.error, error);
    assert.equal(r.apiKeySource, 'apiKeyHelper');
    assert.equal(q.calls[0].options.abortController.signal.aborted, true);
  }
  const builtins = init({ plugins: [
    { name: 'cc-plugin-privacy', path: 'builtin', source: 'cc-plugin-privacy@builtin' },
    { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
  ] });
  const ok = await makeRouter(fakeQuery([builtins, assistant('{"action":"retry","note":"n"}'), resultMsg()]).impl)
    .decide(decideArgs());
  assert.equal(ok.ok, true);
});

test('a call past the timeout fails with timeout', async () => {
  const q = fakeQuery([init()], { hang: true });
  const r = await makeRouter(q.impl, { timeoutMs: 20 }).decide(decideArgs());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.equal(r.usage, null);
  assert.equal(r.apiKeySource, 'apiKeyHelper');
  assert.equal(q.calls[0].options.abortController.signal.aborted, true);
  assert.equal(q.closed.length, 1);
});

const settlesWithinATick = (p) => Promise.race([p, nextTurn().then(() => 'late')]);

test('an external abort settles the call as aborted', async () => {
  const a = fakeQuery();
  const ca = new AbortController();
  let helperCalled;
  const helperStarted = new Promise((resolve) => { helperCalled = resolve; });
  let releaseHelper;
  const pa = makeRouter(a.impl, {
    apiKeyHelper: () => { helperCalled(); return new Promise((resolve) => { releaseHelper = resolve; }); },
  }).decide(decideArgs({ signal: ca.signal }));
  await helperStarted;
  ca.abort();
  const ra = await settlesWithinATick(pa);
  assert.notEqual(ra, 'late');
  assert.equal(ra.ok, false);
  assert.equal(ra.error, 'aborted');
  releaseHelper('helper-cmd');
  await nextTurn();
  assert.equal(a.calls.length, 0);

  const b = fakeQuery([init()], { hang: true });
  const cb = new AbortController();
  const pb = makeRouter(b.impl).decide(decideArgs({ signal: cb.signal }));
  while (b.calls.length === 0) await nextTurn();
  await nextTurn();
  cb.abort();
  const rb = await settlesWithinATick(pb);
  assert.notEqual(rb, 'late');
  assert.equal(rb.error, 'aborted');
  assert.equal(rb.apiKeySource, 'apiKeyHelper');
  assert.equal(b.calls[0].options.abortController.signal.aborted, true);

  const pre = new AbortController();
  pre.abort();
  const c = fakeQuery();
  assert.equal((await makeRouter(c.impl).decide(decideArgs({ signal: pre.signal }))).error, 'aborted');
  assert.equal(c.calls.length, 0);
});

test('invalid output fails with the validator\'s error', async () => {
  const r = await makeRouter(fakeQuery(goodReply('{"action":"retry-alternate","note":"n"}')).impl).decide(decideArgs());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'action-not-allowed');
  assert.equal(r.usage.totalInputTokens, 2427);
  assert.equal(r.apiKeySource, 'apiKeyHelper');
});
