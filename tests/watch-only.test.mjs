// Watch-only superagent worker sessions: the session routes over a bare http
// server and the ws input handler called directly, with `isWatchOnly` a Set
// lookup. Operator auth and the Origin/Host check live in server.js and are
// covered by server-auth.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cockpitHomeDir = await mkdtemp(path.join(tmpdir(), 'cockpit-watch-only-home-'));
process.env.COCKPIT_HOME = cockpitHomeDir;
process.env.COCKPIT_OPERATOR_TOKEN = process.env.COCKPIT_OPERATOR_TOKEN || 'test-operator-token-16plus';
after(() => rm(cockpitHomeDir, { recursive: true, force: true }));

const registry = await import('../src/session-registry.js');
const { createRouter } = await import('../src/router.js');
const { registerSessionRoutes } = await import('../src/routes/sessions.js');
const { registerSessionActionRoutes } = await import('../src/routes/session-actions.js');
const { handleClientMessage } = await import('../src/ws-input.js');

const WATCH_ONLY_BODY = { error: 'superagent worker sessions are watch only', code: 'ERR_WATCH_ONLY' };

// Every handle method (and every handle.query method) records its name in
// `calls`, so a refused request can be shown to have reached nothing.
function recordingStartSession(calls) {
  const record = (name, fn) => (...args) => { calls.push(name); return fn(...args); };
  return () => ({
    pushInput: record('pushInput', () => {}),
    close: record('close', () => {}),
    interrupt: record('interrupt', async () => {}),
    listQueue: () => [],
    setMode: record('setMode', async (m) => m),
    getMode: () => 'default',
    resolveApproval: record('resolveApproval', () => ({ resolved: true, toolName: 'Bash', scope: null })),
    rewind: record('rewind', async () => ({ canRewind: false })),
    query: {
      setModel: record('setModel', async () => {}),
      setEffort: record('setEffort', async () => {}),
      supportedModels: async () => [],
      supportedCommands: async () => [],
      supportedAgents: async () => [],
      setMaxThinkingTokens: record('setMaxThinkingTokens', async () => {}),
      mcpServerStatus: async () => [],
      toggleMcpServer: record('toggleMcpServer', async () => {}),
      reconnectMcpServer: record('reconnectMcpServer', async () => {}),
      reloadPlugins: record('reloadPlugins', async () => ({ plugins: [] })),
      setPluginEnabled: record('setPluginEnabled', async () => {}),
    },
  });
}

async function serve(t, { watchOnly, supervisorOwned = new Set() }) {
  const router = createRouter();
  registerSessionRoutes(router, { isSupervisorOwned: (id) => supervisorOwned.has(id), isWatchOnly: (id) => watchOnly.has(id) });
  registerSessionActionRoutes(router, { isWatchOnly: (id) => watchOnly.has(id) });
  const server = createServer((req, res) => {
    router.handle(req, res, new URL(req.url, 'http://127.0.0.1')).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, { method = 'GET', token, body } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

async function makeRow(t, calls = []) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'cockpit-watch-only-cwd-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const row = registry.createSession({ cwd, resume: 'transcript-watch-only', startSessionImpl: recordingStartSession(calls) });
  return { row, cwd, calls };
}

const MUTATING_ACTIONS = [
  ['POST', 'mode', { mode: 'plan' }],
  ['POST', 'interrupt', {}],
  ['POST', 'force-idle', {}],
  ['POST', 'mcp-toggle', { name: 'example', enabled: false }],
  ['POST', 'mcp-reconnect', { name: 'example' }],
  ['POST', 'reload-plugins', {}],
  ['POST', 'plugin-enabled', { pluginKey: 'formatter@anthropic-tools', enabled: false }],
  ['POST', 'git-guard', { mode: 'off' }],
  ['POST', 'handshake', { value: 'anything' }],
  ['POST', 'model', { model: 'claude-haiku-5-5' }],
  ['DELETE', 'permissions', { rule: 'Bash' }],
  ['POST', 'title', { title: 'Renamed' }],
  ['POST', 'effort', { effort: 'high' }],
  ['POST', 'thinking', { maxThinkingTokens: 1000 }],
  ['POST', 'auto-continue', { enabled: true }],
  ['POST', 'approval-decision', { requestId: 'r1', decision: 'allow' }],
  ['POST', 'rewind', { turnIndex: 1 }],
];

test('every mutating session action is refused for a watch-only session', async (t) => {
  registry._reset();
  const { row, cwd, calls } = await makeRow(t);
  const api = await serve(t, { watchOnly: new Set([row.id]) });
  const before = registry.toSummary(registry.get(row.id));
  for (const [method, action, body] of MUTATING_ACTIONS) {
    const res = await api(`/api/sessions/${row.id}/${action}`, { method, token: row.token, body });
    assert.equal(res.status, 403, `${method} ${action}`);
    assert.deepEqual(res.body, WATCH_ONLY_BODY, `${method} ${action}`);
  }
  assert.deepEqual(calls, [], 'no refused action reached the session handle');
  assert.deepEqual(registry.toSummary(registry.get(row.id)), before, 'no refused action changed the row');
  assert.deepEqual(await readdir(cwd), [], 'no refused action wrote project settings');
  assert.equal(registry.list().length, 1, 'rewind did not fork a new row');
});

test('a watch-only refusal still requires the session token first', async (t) => {
  registry._reset();
  const { row } = await makeRow(t);
  const api = await serve(t, { watchOnly: new Set([row.id]) });
  const res = await api(`/api/sessions/${row.id}/mode`, { method: 'POST', token: 'wrong', body: { mode: 'plan' } });
  assert.equal(res.status, 401);
});

test('reads stay allowed', async (t) => {
  registry._reset();
  const { row } = await makeRow(t);
  const api = await serve(t, { watchOnly: new Set([row.id]) });
  for (const action of ['models', 'diff', 'earlier-history']) {
    const res = await api(`/api/sessions/${row.id}/${action}`, { token: row.token });
    assert.notEqual(res.status, 403, `GET ${action}`);
  }
  const summary = await api(`/api/sessions/${row.id}`, { token: row.token });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.id, row.id);
  assert.equal(summary.body.watchOnly, true);
});

test('DELETE /api/sessions/:id is refused for a watch-only session', async (t) => {
  registry._reset();
  const { row, calls } = await makeRow(t);
  const api = await serve(t, { watchOnly: new Set([row.id]) });
  const res = await api(`/api/sessions/${row.id}`, { method: 'DELETE', token: row.token });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, WATCH_ONLY_BODY);
  assert.ok(registry.get(row.id), 'the row survives');
  assert.deepEqual(calls, []);
});

test('a session that is not watch-only is unaffected', async (t) => {
  registry._reset();
  const { row } = await makeRow(t);
  const api = await serve(t, { watchOnly: new Set(['some-other-session']) });
  const res = await api(`/api/sessions/${row.id}/title`, { method: 'POST', token: row.token, body: { title: 'Renamed' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { title: 'Renamed' });
  const summary = await api(`/api/sessions/${row.id}`, { token: row.token });
  assert.equal(summary.body.watchOnly, false);
});

test('attach-token admits a supervisor-owned session and reports watchOnly', async (t) => {
  registry._reset();
  const { row } = await makeRow(t);
  const api = await serve(t, { watchOnly: new Set([row.id]), supervisorOwned: new Set([row.id]) });
  const res = await api(`/api/sessions/${row.id}/attach-token`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: row.id, token: row.token, watchOnly: true });

  const refused = await serve(t, { watchOnly: new Set() });
  const denied = await refused(`/api/sessions/${row.id}/attach-token`);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'attach-token is only available for auto-pilot and superagent sessions');
});

function fakeWsRegistry() {
  const calls = [];
  const spy = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  return {
    calls,
    sendInput: spy('sendInput'),
    removeQueued: spy('removeQueued'),
    reorderQueue: spy('reorderQueue'),
    sendNow: spy('sendNow'),
    delegateTask: (...args) => { calls.push(['delegateTask', ...args]); },
  };
}

function fakeWs() {
  const sent = [];
  return { sent, send: (frame) => sent.push(JSON.parse(frame)) };
}

const REFUSED_PAYLOADS = [
  { type: 'input', text: 'hello' },
  { type: 'queue-remove', queueId: 'q1' },
  { type: 'queue-reorder', queueIds: ['q1', 'q2'] },
  { type: 'queue-send-now', queueId: 'q1' },
  { type: 'delegate', targetName: 'Other', text: 'hi' },
];

test('ws input is refused for a watch-only session', () => {
  const isWatchOnly = (id) => id === 'worker';
  for (const payload of REFUSED_PAYLOADS) {
    const reg = fakeWsRegistry();
    const ws = fakeWs();
    handleClientMessage({ id: 'worker', payload, ws, registry: reg, isWatchOnly });
    assert.deepEqual(reg.calls, [], payload.type);
    assert.deepEqual(ws.sent, [{ type: 'cockpit:watch-only', error: 'superagent worker sessions are watch only' }], payload.type);
  }

  const reg = fakeWsRegistry();
  const ws = fakeWs();
  handleClientMessage({ id: 'hand-driven', payload: { type: 'input', text: 'hello' }, ws, registry: reg, isWatchOnly });
  assert.deepEqual(reg.calls, [['sendInput', 'hand-driven', 'hello']]);
  assert.deepEqual(ws.sent, []);
});

test('ws input of other types on a watch-only session is ignored, not answered', () => {
  const reg = fakeWsRegistry();
  const ws = fakeWs();
  handleClientMessage({ id: 'worker', payload: { type: 'ping' }, ws, registry: reg, isWatchOnly: () => true });
  assert.deepEqual(reg.calls, []);
  assert.deepEqual(ws.sent, []);
});
