// Routes plus the operator-token gate, following server-auth.test.mjs's
// harness. Everything under /api/ already requires the operator token
// (src/server.js:75-78), so these inherit process-level auth; they are
// operator-gated but not session-token-gated, like /api/browse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.COCKPIT_OPERATOR_TOKEN = process.env.COCKPIT_OPERATOR_TOKEN || 'test-operator-token-16plus';
process.env.PORT = process.env.PORT || '4321';

const home = await mkdtemp(path.join(tmpdir(), 'cockpit-autopilot-home-'));
process.env.COCKPIT_HOME = home;

const { server, PORT, HOST, superagentHost } = await import('../src/server.js');
const { getOperatorToken } = await import('../src/operator-auth.js');
const ORIGIN = `http://${HOST}:${PORT}`;

function api(pathAndQuery, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (!headers.has('x-cockpit-operator')) headers.set('x-cockpit-operator', getOperatorToken());
  if (opts.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${ORIGIN}${pathAndQuery}`, { ...opts, headers });
}

before(() => new Promise((resolve) => server.listen(PORT, HOST, resolve)));
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

function pilotBody(over = {}) {
  return JSON.stringify({
    name: 'RouteTest',
    cwd: process.cwd(),
    provider: 'claude',
    mode: 'acceptEdits',
    prompt: 'do the thing',
    schedule: { everyMinutes: 30 },
    ...over,
  });
}

test('every auto-pilot route 401s without the operator token', async () => {
  const routes = [
    ['GET', '/api/autopilots'],
    ['POST', '/api/autopilots'],
    ['POST', '/api/autopilots/x'],
    ['DELETE', '/api/autopilots/x'],
    ['POST', '/api/autopilots/x/toggle'],
    ['POST', '/api/autopilots/x/run-now'],
    ['GET', '/api/autopilots/x/logs'],
    ['GET', '/api/notifications'],
    ['POST', '/api/autopilot-settings'],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${ORIGIN}${route}`, { method });
    assert.equal(res.status, 401, `${method} ${route}`);
  }
});

test('GET /api/autopilots returns pilots, settings, live status and today\'s spend', async () => {
  const res = await api('/api/autopilots');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.pilots));
  assert.equal(typeof body.settings.maxConcurrentRuns, 'number');
  assert.ok(Array.isArray(body.running));
  assert.equal(typeof body.spend.costUsd, 'number');
});

test('POST /api/autopilots creates, and rejects a duplicate name with 409', async () => {
  const created = await api('/api/autopilots', { method: 'POST', body: pilotBody() });
  assert.equal(created.status, 201);
  const pilot = await created.json();
  assert.equal(pilot.name, 'RouteTest');

  const dupe = await api('/api/autopilots', { method: 'POST', body: pilotBody({ name: 'routetest' }) });
  assert.equal(dupe.status, 409);

  // Cleanup so later tests start clean.
  assert.equal((await api(`/api/autopilots/${pilot.id}`, { method: 'DELETE' })).status, 200);
});

test('POST /api/autopilots rejects a bad payload with 400 and a usable message', async () => {
  const cases = [
    [pilotBody({ prompt: '' }), /prompt/i],
    [pilotBody({ cwd: path.join(process.cwd(), 'definitely-not-here') }), /not a directory/i],
    [pilotBody({ provider: 'gemini' }), /unknown provider/i],
    [pilotBody({ provider: 'claude', effort: 'nonsense' }), /effort/i],
    [pilotBody({ model: 'oops & calc' }), /model/i],
    [pilotBody({ mode: 'nope' }), /mode/i],
  ];
  for (const [body, pattern] of cases) {
    const res = await api('/api/autopilots', { method: 'POST', body });
    assert.equal(res.status, 400, body);
    assert.match((await res.json()).error, pattern);
  }
});

test('Task 8 (cheap item 1): a literal JSON null body is 400, not a 500 from dereferencing a null body', async () => {
  // readJsonBody (src/http-utils.js) normalizes any non-object JSON value -
  // null, an array, a bare number - to {} before a route ever sees it, so
  // this exercises validateAgainstProviders' body.cwd/body.provider reads
  // with nothing supplied, same as an empty object would.
  const res = await api('/api/autopilots', { method: 'POST', body: 'null' });
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('update, toggle, logs and delete round-trip', async () => {
  const pilot = await (await api('/api/autopilots', { method: 'POST', body: pilotBody({ name: 'RoundTrip' }) })).json();

  const updated = await (await api(`/api/autopilots/${pilot.id}`, {
    method: 'POST', body: JSON.stringify({ prompt: 'changed' }),
  })).json();
  assert.equal(updated.prompt, 'changed');
  assert.equal(updated.name, 'RoundTrip');

  const toggled = await (await api(`/api/autopilots/${pilot.id}/toggle`, {
    method: 'POST', body: JSON.stringify({ enabled: false }),
  })).json();
  assert.equal(toggled.enabled, false);

  const logs = await (await api(`/api/autopilots/${pilot.id}/logs`)).json();
  assert.ok(Array.isArray(logs.entries));

  assert.equal((await api(`/api/autopilots/${pilot.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/autopilots/${pilot.id}`, { method: 'DELETE' })).status, 404);
});

test('an unknown pilot id is 404 on every :id route', async () => {
  for (const [method, route] of [
    ['POST', '/api/autopilots/missing'],
    ['DELETE', '/api/autopilots/missing'],
    ['POST', '/api/autopilots/missing/toggle'],
    ['POST', '/api/autopilots/missing/run-now'],
    ['GET', '/api/autopilots/missing/logs'],
  ]) {
    const res = await api(route, { method, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 404, `${method} ${route}`);
  }
});

test('POST /api/autopilot-settings validates', async () => {
  const ok = await api('/api/autopilot-settings', { method: 'POST', body: JSON.stringify({ dailyCostCapUsd: 42 }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dailyCostCapUsd, 42);

  const bad = await api('/api/autopilot-settings', { method: 'POST', body: JSON.stringify({ maxConcurrentRuns: 0 }) });
  assert.equal(bad.status, 400);
});

test('GET /api/notifications returns a derived list', async () => {
  const res = await api('/api/notifications');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entries: [], superagentReady: false });
});

test('importing the server leaves the superagent host off and the superagent folder untouched', async () => {
  assert.equal(superagentHost.status().state, 'off');
  const res = await api('/api/superagent');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: { state: 'off', ownerPort: null, error: null, router: null }, jobs: [] });
  const refused = await api('/api/superagent/jobs/x/stop', { method: 'POST' });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).state, 'off');
  assert.equal((await fetch(`${ORIGIN}/api/superagent`)).status, 401);
  await assert.rejects(stat(path.join(home, '.prompt-cockpit', 'superagent')), { code: 'ENOENT' });
});

test('the retrospective route needs the operator token', async () => {
  const route = '/api/superagent/jobs/x/retrospective';
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: 'a1' }) };
  assert.equal((await fetch(`${ORIGIN}${route}`, init)).status, 401);
  const withToken = await api(route, init);
  assert.equal(withToken.status, 503, 'past the operator gate, the host (off here) answers');
  await assert.rejects(stat(path.join(home, '.prompt-cockpit', 'superagent')), { code: 'ENOENT' });
});

test('a null entry in autopilots.json survives list/create/update/toggle/logs/delete over HTTP', async () => {
  // Mirrors autopilot-store.test.mjs's null-entry coverage, but through the
  // route layer: proves routes/autopilot.js's delegation to the store
  // doesn't reintroduce a crash or a silent drop that the store itself
  // already guards against.
  const filePath = path.join(home, '.prompt-cockpit', 'autopilots.json');
  const created = await (await api('/api/autopilots', { method: 'POST', body: pilotBody({ name: 'NullSurvivor' }) })).json();

  const raw = JSON.parse(await readFile(filePath, 'utf-8'));
  raw.pilots.unshift(null);
  await writeFile(filePath, JSON.stringify(raw));

  // GET /api/autopilots surfaces store.read()'s pilots verbatim (it does not
  // normalize - see autopilot.js's notifications(), which filters nulls out
  // itself rather than relying on the store to have done so), so the null
  // entry rides along in the JSON response as literal `null`. That is not a
  // crash, just an array a consumer must be null-aware over - same shape a
  // hand-edited file always has.
  const list = await (await api('/api/autopilots')).json();
  assert.ok(list.pilots.some((p) => p === null), 'the null row rides along, unnormalized, exactly as store.read() returned it');
  assert.ok(list.pilots.some((p) => p && p.id === created.id));

  const updated = await (await api(`/api/autopilots/${created.id}`, {
    method: 'POST', body: JSON.stringify({ prompt: 'updated' }),
  })).json();
  assert.equal(updated.prompt, 'updated');

  const toggled = await (await api(`/api/autopilots/${created.id}/toggle`, {
    method: 'POST', body: JSON.stringify({ enabled: false }),
  })).json();
  assert.equal(toggled.enabled, false);

  const logs = await (await api(`/api/autopilots/${created.id}/logs`)).json();
  assert.ok(Array.isArray(logs.entries));

  assert.equal((await api(`/api/autopilots/${created.id}`, { method: 'DELETE' })).status, 200);

  const rawAfter = JSON.parse(await readFile(filePath, 'utf-8'));
  assert.ok(rawAfter.pilots.some((p) => p === null), 'the null row must survive every route operation on the unrelated pilot');
});

test('GET /api/sessions/:id/attach-token is not shadowed by the :action catch-all', async () => {
  const res = await api('/api/sessions/does-not-exist/attach-token');
  assert.equal(res.status, 404);
  // routes/session-actions.js:23 answers 404 with the BYTE-IDENTICAL body
  // `{ error: "unknown session: <id>" }`, so matching on that proves nothing
  // about which handler ran. The attach-token handler tags its own 404 for
  // exactly this reason - if this assertion fails, the catch-all swallowed
  // the route and the registration order in server.js has been changed.
  assert.match((await res.json()).error, /\(attach-token\)/);
});
