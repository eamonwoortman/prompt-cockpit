// The superagent and merged notification routes over a bare http server, with
// a fake host whose supervisor is a stub. Operator auth and the Origin/Host
// check live in server.js and are covered by autopilot-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { createRouter } from '../src/router.js';
import { registerSuperagentRoutes } from '../src/routes/superagent.js';
import { registerNotificationRoutes } from '../src/routes/notifications.js';

const job = (over = {}) => ({ jobId: 'job-1', title: 'Login page', state: 'running', phaseId: 'spec', pipeline: [], attempts: [], repos: [], artifacts: {}, ...over });

function fakeHost({ supervisor = {}, refusal = null, readable = true, notifications = [], notificationsReady = true } = {}) {
  return {
    status: () => ({ state: refusal?.state ?? 'ready', ownerPort: refusal?.ownerPort ?? null, error: null, router: 'off' }),
    admit: async (fn) => {
      if (refusal) throw Object.assign(new Error(`superagent is ${refusal.state}`), { code: 'ERR_SUPERAGENT_UNAVAILABLE', ...refusal });
      return fn(supervisor);
    },
    read: (fn) => (readable ? fn(supervisor) : null),
    notifications: () => (typeof notifications === 'function' ? notifications() : notifications),
    notificationsReady: () => notificationsReady,
  };
}

async function serve(t, { host, registry = { get: () => undefined }, autopilot = { notifications: async () => ({ entries: [] }) }, readArtifactImpl, logImpl }) {
  const router = createRouter();
  registerSuperagentRoutes(router, { host, registry, readArtifactImpl });
  registerNotificationRoutes(router, { autopilot, host, logImpl });
  const server = createServer((req, res) => {
    router.handle(req, res, new URL(req.url, 'http://127.0.0.1')).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, { method = 'GET', body } = {}) => {
    const res = await fetch(base + route, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
}

test('GET /api/superagent reports status and summaries', async (t) => {
  const api = await serve(t, { host: fakeHost({ supervisor: { listJobs: () => [job()] } }) });
  const { status, body } = await api('/api/superagent');
  assert.equal(status, 200);
  assert.deepEqual(body.status, { state: 'ready', ownerPort: null, error: null, router: 'off' });
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].jobId, 'job-1');
  assert.equal(body.jobs[0].title, 'Login page');
  assert.equal(body.jobs[0].status, 'running');

  const unreadable = await serve(t, { host: fakeHost({ readable: false, refusal: { status: 503, state: 'initialising' } }) });
  const off = await unreadable('/api/superagent');
  assert.equal(off.status, 200);
  assert.equal(off.body.status.state, 'initialising');
  assert.deepEqual(off.body.jobs, []);
});

test('GET /api/superagent/jobs/:id returns the detail, with live attempts from the registry', async (t) => {
  const attempt = { attemptId: 'a1', phase: 'spec', role: 'writer', model: 'm', n: 1, purpose: 'author', sessionId: 's1' };
  const supervisor = {
    getJob: (id) => (id === 'job-1' ? job({ attempts: [attempt] }) : undefined),
    usageForJob: async () => new Map(),
    artifactStates: async () => new Map(),
  };
  const api = await serve(t, { host: fakeHost({ supervisor }), registry: { get: (sid) => (sid === 's1' ? { id: 's1' } : undefined) } });
  const found = await api('/api/superagent/jobs/job-1');
  assert.equal(found.status, 200);
  assert.equal(found.body.jobId, 'job-1');
  assert.equal(found.body.attempts[0].live, true);

  const missing = await api('/api/superagent/jobs/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ERR_UNKNOWN_JOB');
});

test('GET job detail includes spend from usageForJob', async (t) => {
  const attempt = { attemptId: 'a1', phase: 'spec', role: 'writer', model: 'm', n: 1, purpose: 'author', sessionId: null, startedAt: 1000, endedAt: 3000, outcome: 'done' };
  const usage = { state: 'final', knownCostUsd: 0.5, tokens: { total: 10 }, byModel: { m: { costUsd: 0.5, tokens: 10 } }, unpricedModels: [], complete: true, claudeSessionId: 'c1' };
  const supervisor = {
    getJob: () => job({ attempts: [attempt] }),
    usageForJob: async () => new Map([['a1', { usage, transcript: { available: true, claudeSessionId: 'c1', cwd: '/w' } }]]),
    artifactStates: async () => new Map(),
  };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const { body } = await api('/api/superagent/jobs/job-1');
  assert.deepEqual(body.spend.total, { usd: 0.5, complete: true });
  assert.equal(body.attempts[0].durationMs, 2000);
  assert.deepEqual(body.attempts[0].cost, { usd: 0.5, complete: true });
  assert.deepEqual(body.attempts[0].transcript, { available: true });

  const broken = { getJob: () => job({ attempts: [attempt] }), usageForJob: async () => { throw new Error('boom'); } };
  const fallback = await (await serve(t, { host: fakeHost({ supervisor: broken }) }))('/api/superagent/jobs/job-1');
  assert.equal(fallback.status, 200);
  assert.deepEqual(fallback.body.spend.total, { usd: null, complete: false });
  assert.equal(fallback.body.attempts[0].usageNote, 'unavailable');
});

test('GET /api/superagent/jobs/:id answers with the host status while unreadable',async (t) => {
  const api = await serve(t, { host: fakeHost({ readable: false, refusal: { status: 503, state: 'initialising', ownerPort: null } }) });
  const res = await api('/api/superagent/jobs/job-1');
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ERR_SUPERAGENT_UNAVAILABLE');
  assert.equal(res.body.state, 'initialising');
});

test('POST /api/superagent/jobs passes fields through and defaults the title', async (t) => {
  const calls = [];
  const supervisor = { createJob: async (args) => { calls.push(args); return job({ title: args.title, state: 'provisioning' }); } };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const repo = process.cwd();
  const extra = path.join(process.cwd(), 'src');
  const res = await api('/api/superagent/jobs', {
    method: 'POST',
    body: { idea: 'Add a login page with remember me and more words here', primaryRepo: repo, additionalRepos: [extra] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.jobId, 'job-1');
  assert.equal(res.body.status, 'provisioning');
  assert.deepEqual(calls, [{
    title: 'Add a login page with remember me and',
    idea: 'Add a login page with remember me and more words here',
    primaryRepo: repo,
    additionalRepos: [extra],
    mode: 'automatic',
    fixture: null,
    workflow: null,
    inPlace: [],
  }]);

  await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'Short idea', title: '  Named  ', primaryRepo: repo } });
  assert.equal(calls[1].title, 'Named');
  assert.deepEqual(calls[1].additionalRepos, []);
});

test('POST /api/superagent/jobs refuses a missing folder', async (t) => {
  const calls = [];
  const api = await serve(t, { host: fakeHost({ supervisor: { createJob: async (args) => { calls.push(args); return job(); } } }) });
  const missing = path.join(process.cwd(), 'definitely-not-here');
  const primary = await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'x', primaryRepo: missing } });
  assert.equal(primary.status, 400);
  assert.equal(primary.body.error, `not a directory: ${missing}`);

  const additional = await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'x', primaryRepo: process.cwd(), additionalRepos: [missing] } });
  assert.equal(additional.status, 400);
  assert.equal(additional.body.error, `not a directory: ${missing}`);

  const noIdea = await api('/api/superagent/jobs', { method: 'POST', body: { idea: '   ', primaryRepo: process.cwd() } });
  assert.equal(noIdea.status, 400);
  assert.match(noIdea.body.error, /idea/);
  assert.equal(calls.length, 0);
});

test("createJob's coded errors come back as 400 with their code", async (t) => {
  const err = Object.assign(new Error('superagent: /a is the same repository as /b'), { code: 'ERR_DUPLICATE_REPO' });
  const api = await serve(t, { host: fakeHost({ supervisor: { createJob: async () => { throw err; } } }) });
  const res = await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'x', primaryRepo: process.cwd() } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: err.message, code: 'ERR_DUPLICATE_REPO' });
});

test('a second answer to the same question is a 409 and appends nothing', async (t) => {
  const appended = [];
  const supervisor = {
    answerQuestion: async (jobId, text, seen) => {
      if (appended.length) throw Object.assign(new Error('no question to answer'), { code: 'ERR_INVALID_STATE' });
      appended.push({ jobId, text, seen });
      return job({ jobId });
    },
  };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const first = await api('/api/superagent/jobs/job-1/answer', { method: 'POST', body: { text: 'Use cookies', needsYouSeq: 4 } });
  assert.equal(first.status, 200);
  assert.equal(first.body.jobId, 'job-1');
  const second = await api('/api/superagent/jobs/job-1/answer', { method: 'POST', body: { text: 'Use cookies', needsYouSeq: 4 } });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'ERR_INVALID_STATE');
  assert.deepEqual(appended, [{ jobId: 'job-1', text: 'Use cookies', seen: { needsYouSeq: 4 } }]);
});

test('an answer must name the needs-you it was written for; a stale one is a 409', async (t) => {
  const calls = [];
  const supervisor = {
    answerQuestion: async (jobId, text, { needsYouSeq }) => {
      calls.push(needsYouSeq);
      if (needsYouSeq !== 7) throw Object.assign(new Error('job job-1 no longer needs what was shown'), { code: 'ERR_INVALID_STATE' });
      return job({ jobId });
    },
    accept: async (jobId, seen) => { calls.push(seen); return job({ jobId, state: 'done' }); },
  };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  for (const needsYouSeq of [undefined, null, '7', 7.5]) {
    const res = await api('/api/superagent/jobs/job-1/answer', { method: 'POST', body: { text: 'Use cookies', needsYouSeq } });
    assert.equal(res.status, 400, String(needsYouSeq));
    assert.equal(res.body.code, 'ERR_INVALID_ANSWER');
  }
  assert.deepEqual(calls, [], 'nothing reaches the supervisor without a needs-you');
  const stale = await api('/api/superagent/jobs/job-1/answer', { method: 'POST', body: { text: 'Use cookies', needsYouSeq: 4 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'ERR_INVALID_STATE');
  const current = await api('/api/superagent/jobs/job-1/answer', { method: 'POST', body: { text: 'Use cookies', needsYouSeq: 7 } });
  assert.equal(current.status, 200);
  await api('/api/superagent/jobs/job-1/accept', { method: 'POST', body: { needsYouSeq: 9 } });
  assert.deepEqual(calls, [4, 7, { needsYouSeq: 9 }]);
});

test('retry passes the needs-you and note through, requires the needs-you, and maps refusals', async (t) => {
  const calls = [];
  const supervisor = {
    retryJob: async (jobId, opts) => {
      calls.push(opts);
      if (opts.needsYouSeq !== 7) throw Object.assign(new Error('not stuck'), { code: 'ERR_INVALID_STATE' });
      if (typeof opts.note === 'string' && opts.note.length > 4000) throw Object.assign(new Error('too long'), { code: 'ERR_INVALID_ANSWER' });
      return job({ jobId, state: 'running' });
    },
  };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  for (const needsYouSeq of [undefined, null, '7', 7.5]) {
    const res = await api('/api/superagent/jobs/job-1/retry', { method: 'POST', body: { needsYouSeq } });
    assert.equal(res.status, 400, String(needsYouSeq));
    assert.equal(res.body.code, 'ERR_INVALID_REQUEST');
  }
  assert.deepEqual(calls, []);
  const ok = await api('/api/superagent/jobs/job-1/retry', { method: 'POST', body: { needsYouSeq: 7, note: 'from code only' } });
  assert.deepEqual([ok.status, ok.body.status], [200, 'running']);
  const stale = await api('/api/superagent/jobs/job-1/retry', { method: 'POST', body: { needsYouSeq: 4 } });
  assert.deepEqual([stale.status, stale.body.code], [409, 'ERR_INVALID_STATE']);
  const long = await api('/api/superagent/jobs/job-1/retry', { method: 'POST', body: { needsYouSeq: 7, note: 'x'.repeat(4001) } });
  assert.deepEqual([long.status, long.body.code], [400, 'ERR_INVALID_ANSWER']);
  assert.deepEqual(calls.slice(0, 2), [{ needsYouSeq: 7, note: 'from code only' }, { needsYouSeq: 4, note: undefined }]);
});

test('accept and stop return the job summary; an unknown job is 404', async (t) => {
  const unknown = Object.assign(new Error('superagent: no job nope'), { code: 'ERR_UNKNOWN_JOB' });
  const supervisor = {
    accept: async (id) => { if (id === 'nope') throw unknown; return job({ jobId: id, state: 'done' }); },
    stopJob: async (id) => job({ jobId: id, state: 'stopped' }),
  };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const accepted = await api('/api/superagent/jobs/job-1/accept', { method: 'POST' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, 'done');
  const stopped = await api('/api/superagent/jobs/job-1/stop', { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopped');
  const missing = await api('/api/superagent/jobs/nope/accept', { method: 'POST' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ERR_UNKNOWN_JOB');
});

test('unavailable host answers with its status', async (t) => {
  const notOwner = await serve(t, { host: fakeHost({ refusal: { status: 409, state: 'not-owner', ownerPort: 4400 } }) });
  const refused = await notOwner('/api/superagent/jobs/job-1/stop', { method: 'POST' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ERR_SUPERAGENT_UNAVAILABLE');
  assert.equal(refused.body.state, 'not-owner');
  assert.equal(refused.body.ownerPort, 4400);
  assert.equal(typeof refused.body.error, 'string');

  const starting = await serve(t, { host: fakeHost({ refusal: { status: 503, state: 'initialising', ownerPort: null } }) });
  const created = await starting('/api/superagent/jobs', { method: 'POST', body: { idea: 'x', primaryRepo: process.cwd() } });
  assert.equal(created.status, 503);
  assert.equal(created.body.state, 'initialising');
  assert.equal(created.body.ownerPort, null);
});

test('artifact route maps reader errors', async (t) => {
  const reads = [];
  const failures = { outside: 'ERR_ARTIFACT_OUTSIDE', missing: 'ERR_ARTIFACT_MISSING', bogus: 'ERR_UNKNOWN_ARTIFACT' };
  const readArtifactImpl = async (j, key) => {
    reads.push([j.jobId, key]);
    if (failures[key]) throw Object.assign(new Error(`artifact ${key}`), { code: failures[key] });
    return { key, path: 'docs/spec.md', text: '# Spec', truncated: false };
  };
  const supervisor = { getJob: (id) => (id === 'job-1' ? job() : undefined), jobDir: (id) => path.join('/jobs', id) };
  const api = await serve(t, { host: fakeHost({ supervisor }), readArtifactImpl });

  const ok = await api('/api/superagent/jobs/job-1/artifacts/spec');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { key: 'spec', path: 'docs/spec.md', text: '# Spec', truncated: false });
  const outside = await api('/api/superagent/jobs/job-1/artifacts/outside');
  assert.equal(outside.status, 400);
  assert.equal(outside.body.code, 'ERR_ARTIFACT_OUTSIDE');
  const missing = await api('/api/superagent/jobs/job-1/artifacts/missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ERR_ARTIFACT_MISSING');
  const bogus = await api('/api/superagent/jobs/job-1/artifacts/bogus');
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.code, 'ERR_UNKNOWN_ARTIFACT');
  const noJob = await api('/api/superagent/jobs/nope/artifacts/spec');
  assert.equal(noJob.status, 404);
  assert.equal(noJob.body.code, 'ERR_UNKNOWN_JOB');
  assert.equal(reads.length, 4);
});

test('GET artifact answers 410 ERR_ARTIFACT_GONE, and passes the snapshot folder and whether the writer ended', async (t) => {
  const pipeline = [{ phase: 'spec', kind: 'author', role: 'writer', inputs: ['idea'], outputs: ['spec', 'plan'] }];
  const attempts = [{ attemptId: 'a1', phase: 'spec', task: null, purpose: 'author', outcome: 'done', reason: null }];
  const artifacts = { spec: 'docs/spec.md', plan: 'docs/plan.md' };
  const calls = [];
  const readArtifactImpl = async (j, key, options) => {
    calls.push([key, options]);
    if (key === 'plan') throw Object.assign(new Error('deleted from the workspace, no snapshot'), { code: 'ERR_ARTIFACT_GONE' });
    return { key, path: 'docs/spec.md', text: '# Spec', truncated: false, source: 'snapshot' };
  };
  const supervisor = { getJob: () => job({ pipeline, attempts, artifacts }), jobDir: (id) => path.join('/jobs', id) };
  const api = await serve(t, { host: fakeHost({ supervisor }), readArtifactImpl });

  const ok = await api('/api/superagent/jobs/job-1/artifacts/spec');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.source, 'snapshot');
  const gone = await api('/api/superagent/jobs/job-1/artifacts/plan');
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, 'ERR_ARTIFACT_GONE');
  assert.deepEqual(calls, [
    ['spec', { snapshotDir: path.join('/jobs', 'job-1', 'artifacts'), ended: true }],
    ['plan', { snapshotDir: path.join('/jobs', 'job-1', 'artifacts'), ended: true }],
  ]);

  calls.length = 0;
  attempts[0].outcome = null;
  await api('/api/superagent/jobs/job-1/artifacts/spec');
  assert.equal(calls[0][1].ended, false, 'a running writer has not ended');
});

test('GET artifact: a writer that ended failed without the file stays 404 ERR_ARTIFACT_MISSING (ended false)', async (t) => {
  const pipeline = [{ phase: 'spec', kind: 'author', role: 'writer', inputs: ['idea'], outputs: ['spec'] }];
  const attempts = [{ attemptId: 'a1', phase: 'spec', task: null, purpose: 'author', outcome: 'failed', reason: 'x' }];
  const calls = [];
  const readArtifactImpl = async (j, key, options) => {
    calls.push(options.ended);
    throw Object.assign(new Error('missing'), { code: 'ERR_ARTIFACT_MISSING' });
  };
  const supervisor = { getJob: () => job({ pipeline, attempts, artifacts: { spec: 'docs/spec.md' } }), jobDir: (id) => path.join('/jobs', id) };
  const api = await serve(t, { host: fakeHost({ supervisor }), readArtifactImpl });
  const res = await api('/api/superagent/jobs/job-1/artifacts/spec');
  assert.equal(res.status, 404);
  assert.deepEqual(calls, [false]);
});

test('GET transcript answers the session id and cwd, 404 when missing, 409 when ambiguous, 404 for an unknown attempt or job', async (t) => {
  const answers = {
    a1: { status: 'found', claudeSessionId: 'c1', file: '/p/c1.jsonl', cwd: '/w/own' },
    a2: { status: 'missing' },
    a3: { status: 'ambiguous', files: ['/p/x.jsonl', '/q/y.jsonl'] },
  };
  const supervisor = {
    getJob: (id) => (id === 'job-1' ? job() : undefined),
    transcriptFor: async (jobId, attemptId) => {
      if (!answers[attemptId]) throw Object.assign(new Error('unknown attempt'), { code: 'ERR_UNKNOWN_ATTEMPT' });
      return answers[attemptId];
    },
  };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const found = await api('/api/superagent/jobs/job-1/attempts/a1/transcript');
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { claudeSessionId: 'c1', cwd: '/w/own' });
  const missing = await api('/api/superagent/jobs/job-1/attempts/a2/transcript');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ERR_TRANSCRIPT_MISSING');
  const ambiguous = await api('/api/superagent/jobs/job-1/attempts/a3/transcript');
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.code, 'ERR_TRANSCRIPT_AMBIGUOUS');
  assert.equal((await api('/api/superagent/jobs/job-1/attempts/zz/transcript')).status, 404);
  assert.equal((await api('/api/superagent/jobs/nope/attempts/a1/transcript')).status, 404);
});

test('GET transcript goes through the host gate', async (t) => {
  const api = await serve(t, { host: fakeHost({ readable: false, refusal: { status: 503, state: 'initialising' } }) });
  const res = await api('/api/superagent/jobs/job-1/attempts/a1/transcript');
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ERR_SUPERAGENT_UNAVAILABLE');
});

test('notifications merge both sources', async (t) => {
  const pilotEntry = { kind: 'needs-input', pilotId: 'p1', message: 'waiting' };
  const superagentEntry = { kind: 'superagent', type: 'question', key: 'superagent:job-1:4', jobId: 'job-1', title: 'Login page', message: 'Which?' };
  const api = await serve(t, {
    host: fakeHost({ notifications: [superagentEntry] }),
    autopilot: { notifications: async () => ({ entries: [pilotEntry] }) },
  });
  const res = await api('/api/notifications');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { entries: [pilotEntry, superagentEntry], superagentReady: true });
});

test('notifications say when the superagent entries are not the full list yet', async (t) => {
  const pilotEntry = { kind: 'needs-input', pilotId: 'p1', message: 'waiting' };
  const api = await serve(t, {
    host: fakeHost({ notifications: [], notificationsReady: false }),
    autopilot: { notifications: async () => ({ entries: [pilotEntry] }) },
  });
  const res = await api('/api/notifications');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { entries: [pilotEntry], superagentReady: false });
});

test('one throwing notification source does not blank the other', async (t) => {
  const pilotEntry = { kind: 'needs-input', pilotId: 'p1', message: 'waiting' };
  const superagentEntry = { kind: 'superagent', type: 'stuck', key: 'superagent:job-1:9', jobId: 'job-1', title: 'Login page', message: 'stuck' };
  const logged = [];
  const logImpl = (m) => logged.push(m);

  const pilotsDown = await serve(t, {
    host: fakeHost({ notifications: [superagentEntry] }),
    autopilot: { notifications: async () => { throw new Error('pilots down'); } },
    logImpl,
  });
  const first = await pilotsDown('/api/notifications');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { entries: [superagentEntry], superagentReady: true });

  const superagentDown = await serve(t, {
    host: fakeHost({ notifications: () => { throw new Error('jobs down'); } }),
    autopilot: { notifications: async () => ({ entries: [pilotEntry] }) },
    logImpl,
  });
  const second = await superagentDown('/api/notifications');
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { entries: [pilotEntry], superagentReady: false });
  assert.deepEqual(logged, ['auto-pilot notifications failed: pilots down', 'superagent notifications failed: jobs down']);
});

test('GET /api/superagent/workflows lists entries without the file, with the default and its note', async (t) => {
  const calls = [];
  const entries = [
    { id: 'feature', name: 'Feature', description: 'd', source: 'built-in', file: '/c/workflows/feature.json', valid: true, errors: [] },
    { id: 'mine', name: 'Mine', description: '', source: 'project', file: '/p/.superpowers/superagent/workflows/mine.json', valid: true, errors: [] },
    { id: 'broken', name: 'broken', description: '', source: 'project', file: '/p/.superpowers/superagent/workflows/broken.json', valid: false, errors: [{ path: 'phases', message: 'missing' }] },
  ];
  const supervisor = { listWorkflows: async (primary) => { calls.push(primary); return { workflows: entries, default: 'feature', defaultNote: 'note' }; } };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const res = await api(`/api/superagent/workflows?primary=${encodeURIComponent(process.cwd())}`);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [process.cwd()]);
  assert.equal(res.body.default, 'feature');
  assert.equal(res.body.defaultNote, 'note');
  assert.deepEqual(res.body.workflows.map((w) => w.id), ['feature', 'mine', 'broken']);
  assert.deepEqual(Object.keys(res.body.workflows[2]).sort(), ['description', 'errors', 'id', 'name', 'source', 'valid']);
  assert.deepEqual(res.body.workflows[2].errors, [{ path: 'phases', message: 'missing' }]);
});

test('GET /api/superagent/workflows needs a folder primary and an admitting host', async (t) => {
  const supervisor = { listWorkflows: async () => ({ workflows: [], default: null, defaultNote: null }) };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const none = await api('/api/superagent/workflows');
  assert.equal(none.status, 400);
  const missing = path.join(process.cwd(), 'definitely-not-here');
  const bad = await api(`/api/superagent/workflows?primary=${encodeURIComponent(missing)}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, `not a directory: ${missing}`);

  for (const [state, status] of [['initialising', 503], ['not-owner', 409]]) {
    const refused = await serve(t, { host: fakeHost({ supervisor, refusal: { status, state, ownerPort: 4317 } }) });
    const res = await refused(`/api/superagent/workflows?primary=${encodeURIComponent(process.cwd())}`);
    assert.equal(res.status, status);
    assert.equal(res.body.code, 'ERR_SUPERAGENT_UNAVAILABLE');
  }
});

test('POST /api/superagent/jobs passes workflow and inPlace through', async (t) => {
  const calls = [];
  const supervisor = { createJob: async (args) => { calls.push(args); return job(); } };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const repo = process.cwd();
  const res = await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'Fix it', primaryRepo: repo, workflow: 'troubleshooting', inPlace: [repo] } });
  assert.equal(res.status, 200);
  assert.equal(calls[0].workflow, 'troubleshooting');
  assert.deepEqual(calls[0].inPlace, [repo]);

  await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'Plain', primaryRepo: repo } });
  assert.equal(calls[1].workflow, null);
  assert.deepEqual(calls[1].inPlace, []);
});

test('POST /api/superagent/jobs refuses a malformed workflow or inPlace', async (t) => {
  const calls = [];
  const api = await serve(t, { host: fakeHost({ supervisor: { createJob: async (args) => { calls.push(args); return job(); } } }) });
  const repo = process.cwd();
  for (const inPlace of ['yes', { a: 1 }, [repo, 3], [null], true]) {
    const res = await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'x', primaryRepo: repo, inPlace } });
    assert.equal(res.status, 400, JSON.stringify(inPlace));
    assert.equal(res.body.code, 'ERR_INVALID_REQUEST');
  }
  const wf = await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'x', primaryRepo: repo, workflow: 7 } });
  assert.equal(wf.status, 400);
  assert.equal(wf.body.code, 'ERR_INVALID_REQUEST');
  assert.deepEqual(calls, []);
});

test('POST /api/superagent/jobs maps the workflow and folder error codes', async (t) => {
  let code = null;
  const supervisor = { createJob: async () => { throw Object.assign(new Error(`boom ${code}`), { code }); } };
  const api = await serve(t, { host: fakeHost({ supervisor }) });
  const expected = {
    ERR_FOLDER_IN_USE: 409,
    ERR_UNKNOWN_WORKFLOW: 400,
    ERR_INVALID_WORKFLOW: 400,
    ERR_INVALID_REQUEST: 400,
    ERR_FOLDER_DIRTY: 400,
    ERR_FOLDER_BUSY_GIT: 400,
    ERR_FOLDER_ON_JOB_BRANCH: 400,
    ERR_FOLDER_CHANGED: 400,
  };
  for (const [name, status] of Object.entries(expected)) {
    code = name;
    const res = await api('/api/superagent/jobs', { method: 'POST', body: { idea: 'x', primaryRepo: process.cwd() } });
    assert.equal(res.status, status, name);
    assert.equal(res.body.code, name);
  }
});
