// The cockpit's own MCP endpoint (src/cockpit-mcp.js + routes/mcp.js) that lets
// a Codex session call ask_session: JSON-RPC handling, per-session bearer auth,
// and the Codex thread config that points at it. Real Codex behavior (the model
// actually choosing the tool) is covered by ask-session-codex.manual.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpMessage } from '../src/cockpit-mcp.js';
import { cockpitMcpThreadConfig } from '../src/codex-session.js';
import * as registry from '../src/session-registry.js';
import { fakeStartSession } from './test-helpers.mjs';
import { useTestSubscriptionSettings } from './helpers/subscription-settings.mjs';

useTestSubscriptionSettings();

process.env.COCKPIT_OPERATOR_TOKEN = process.env.COCKPIT_OPERATOR_TOKEN || 'test-operator-token-16plus';
process.env.PORT = process.env.PORT || '4320';
const { server, PORT, HOST } = await import('../src/server.js');
const { setCockpitBaseUrl } = await import('../src/cockpit-endpoint.js');
const BASE = `http://${HOST}:${PORT}`;

before(() => new Promise((resolve) => server.listen(PORT, HOST, () => { setCockpitBaseUrl(BASE); resolve(); })));
after(() => new Promise((resolve) => { setCockpitBaseUrl(null); server.close(resolve); }));

const peers = {
  listPeers: () => [{ name: 'Claude', provider: 'claude', cwd: '/tmp/proj', state: 'idle' }],
  ask: async (name, text) => ({ ok: true, text: `${name} says re: ${text}` }),
};
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('handleMcpMessage answers initialize, ping and notifications', async () => {
  const init = await handleMcpMessage(peers, rpc('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(init.result.protocolVersion, '2025-06-18', 'must echo the client\'s protocol version');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual((await handleMcpMessage(peers, rpc('ping'))).result, {});
  assert.equal(await handleMcpMessage(peers, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handleMcpMessage(peers, rpc('nope'))).error.code, -32601);
});

test('tools/list advertises both tools with JSON schemas, ask_session requiring session and prompt', async () => {
  const { tools } = (await handleMcpMessage(peers, rpc('tools/list'))).result;
  assert.deepEqual(tools.map((t) => t.name), ['list_sessions', 'ask_session']);
  const ask = tools.find((t) => t.name === 'ask_session');
  assert.equal(ask.inputSchema.type, 'object');
  assert.deepEqual(ask.inputSchema.required.sort(), ['prompt', 'session']);
});

test('tools/call runs the tool, and rejects bad arguments and unknown tools as JSON-RPC errors', async () => {
  const ok = await handleMcpMessage(peers, rpc('tools/call', { name: 'ask_session', arguments: { session: 'Claude', prompt: 'hi' } }));
  assert.equal(ok.result.content[0].text, 'Claude says re: hi');
  const list = await handleMcpMessage(peers, rpc('tools/call', { name: 'list_sessions', arguments: {} }));
  assert.match(list.result.content[0].text, /"name": "Claude"/);
  assert.equal((await handleMcpMessage(peers, rpc('tools/call', { name: 'ask_session', arguments: { session: 'x' } }))).error.code, -32602);
  assert.equal((await handleMcpMessage(peers, rpc('tools/call', { name: 'nope', arguments: {} }))).error.code, -32602);
});

test('/mcp/:id requires the session bearer token, accepts POST only, and answers 202 to notifications', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp/proj', name: 'Codex', startSessionImpl: fakeStartSession() });
  const post = (body, token) => fetch(`${BASE}/mcp/${row.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await post(rpc('ping'))).status, 401, 'no token');
  assert.equal((await post(rpc('ping'), 'wrong')).status, 401, 'wrong token');
  assert.equal((await fetch(`${BASE}/mcp/does-not-exist`, { method: 'POST', headers: { authorization: `Bearer ${row.token}` } })).status, 401, 'unknown session');

  const res = await post(rpc('tools/list'), row.token);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result.tools.map((t) => t.name), ['list_sessions', 'ask_session']);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, row.token)).status, 202);
  assert.equal((await fetch(`${BASE}/mcp/${row.id}`, { headers: { authorization: `Bearer ${row.token}` } })).status, 405);
});

test('a session started while the server is up is handed its own MCP url and token', () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp/proj', name: 'Codex', startSessionImpl: impl });
  assert.deepEqual(impl.lastOpts.cockpitMcp, { url: `${BASE}/mcp/${row.id}`, token: row.token });
});

test('cockpitMcpThreadConfig registers the endpoint as a Codex MCP server with a long tool timeout; no endpoint means no config', () => {
  assert.deepEqual(cockpitMcpThreadConfig(undefined), {});
  const { config } = cockpitMcpThreadConfig({ url: 'http://127.0.0.1:1/mcp/x', token: 't0k' });
  assert.equal(config.mcp_servers.cockpit.url, 'http://127.0.0.1:1/mcp/x');
  assert.equal(config.mcp_servers.cockpit.http_headers.Authorization, 'Bearer t0k');
  assert.ok(config.mcp_servers.cockpit.tool_timeout_sec >= 600, 'ask_session blocks for a whole turn of the other session');
});
