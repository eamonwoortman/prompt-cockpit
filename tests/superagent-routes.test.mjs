// The superagent and merged notification routes over a bare http server, with
// a fake host whose supervisor is a stub. Operator auth and the Origin/Host
// check live in server.js and are covered by autopilot-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRouter } from '../src/router.js';
import { MILESTONE_2_PIPELINE, defaultConfig } from '../src/superagent/config.js';
import { tempDir } from './superagent-helpers.mjs';
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

async function serve(t, { host, registry = { get: () => undefined }, autopilot = { notifications: async () => ({ entries: [] }) }, readArtifactImpl, logImpl, retrospective }) {
  const router = createRouter();
  registerSuperagentRoutes(router, { host, registry, readArtifactImpl, retrospective });
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

// --- POST /api/superagent/jobs/:id/retrospective ---

const cardText = (attemptId) => `# Superagent job card\n\n\`\`\`json\n${JSON.stringify({ jobId: 'job-1', attemptId }, null, 2)}\n\`\`\`\n`;

function fakeRegistry({ taken = [], sendError = null } = {}) {
  const created = [];
  const sent = [];
  const closed = [];
  return {
    created,
    sent,
    closed,
    get: () => undefined,
    createSession(args) {
      if (taken.includes(args.name)) throw Object.assign(new Error(`a session named "${args.name}" already exists in this project`), { code: 'ERR_NAME_TAKEN' });
      created.push(args);
      return { id: `sess-${created.length}`, token: `tok-${created.length}`, name: args.name, cwd: args.cwd };
    },
    sendInput: async (id, text) => {
      if (sendError) throw sendError;
      sent.push({ id, text });
    },
    closeSession: (id) => {
      closed.push(id);
      return true;
    },
  };
}

// A worktree job (its primary worktree lives under the superagent root, Ruling
// 13) with a second, in-place folder, one plugin with a dev clone and a copy
// under plugins/cache, and transcripts for every attempt except a3.
async function retroWorld(t, { registry = fakeRegistry(), defaults = null, seedDefaults, refusal = null } = {}) {
  const base = await fs.realpath(await tempDir('sa-retro-route-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const superagentRoot = path.join(home, '.prompt-cockpit', 'superagent');
  const claudeHome = path.join(home, '.claude');
  const cockpitRoot = path.join(base, 'cockpit');
  await fs.mkdir(path.join(cockpitRoot, 'prompts', 'superagent'), { recursive: true });
  await fs.writeFile(path.join(cockpitRoot, 'prompts', 'superagent', 'retrospective.md'), '# Retro template\n');
  const worktree = path.join(superagentRoot, 'worktrees', 'login', 'app');
  const inPlace = path.join(base, 'src', 'lib');
  const clone = path.join(base, 'clones', 'tool-plugin');
  const cached = path.join(claudeHome, 'plugins', 'cache', 'market', 'tool-plugin');
  for (const dir of [worktree, inPlace, clone, cached]) await fs.mkdir(dir, { recursive: true });
  const jobDir = path.join(superagentRoot, 'jobs', 'job-1');
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, 'events.jsonl'), '{}\n');

  const projects = path.join(base, 'projects');
  await fs.mkdir(projects, { recursive: true });
  const transcript = async (attemptId) => {
    const file = path.join(projects, `c-${attemptId}.jsonl`);
    const rows = [
      { type: 'user', cwd: worktree, message: { role: 'user', content: cardText(attemptId) } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'tool-plugin:do-thing' } }] } },
    ];
    await fs.writeFile(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return { status: 'found', claudeSessionId: `c-${attemptId}`, file, cwd: worktree };
  };
  const attempts = [
    { attemptId: 'a1', phase: 'spec', role: 'spec-writer', model: 'm', n: 1, purpose: 'author', outcome: 'done', sessionId: 's1' },
    { attemptId: 'a2', phase: 'implement', task: 't1', role: 'implementer', model: 'm', n: 1, purpose: 'author', outcome: 'failed', reason: 'turn-cap', sessionId: 's2' },
    { attemptId: 'a3', phase: 'implement', task: 't2', role: 'implementer', model: 'm', n: 1, purpose: 'author', outcome: 'done', sessionId: 's3' },
    { attemptId: 'a4', phase: 'implement', task: 't1', role: 'implementer', model: 'm', n: 2, purpose: 'author', outcome: 'done', sessionId: 's4' },
  ];
  const theJob = job({
    pipeline: MILESTONE_2_PIPELINE,
    limits: defaultConfig().limits,
    attempts,
    tasks: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }],
    repos: [{ id: 'app', origin: path.join(base, 'origin'), worktree }, { id: 'lib', origin: inPlace, worktree: inPlace, inPlace: true }],
  });
  const found = { a1: await transcript('a1'), a2: await transcript('a2'), a4: await transcript('a4') };
  const transcriptCalls = [];
  const supervisor = {
    getJob: (id) => (id === 'job-1' ? theJob : undefined),
    transcriptFor: async (jobId, attemptId) => {
      transcriptCalls.push(attemptId);
      return found[attemptId] ?? { status: 'missing' };
    },
    jobDir: () => jobDir,
    usageForJob: async () => new Map(),
  };
  const seeded = [];
  const resolveCalls = [];
  let ids = 0;
  const retrospective = {
    cockpitRoot,
    superagentRoot,
    claudeHome,
    newId: () => `retro-${++ids}`,
    readDefaults: async (cwd) => (cwd === cockpitRoot ? defaults : null),
    seedDefaults: seedDefaults ?? (async (row) => { seeded.push(row.id); }),
    resolvePluginsImpl: async (names, opts) => {
      resolveCalls.push({ names, opts });
      return names.map((plugin) => ({ plugin, marketplace: 'market', installPath: cached, sourceUrl: 'https://example.test/o/tool-plugin', clones: [clone, cached] }));
    },
    log: () => {},
  };
  const api = await serve(t, {
    host: fakeHost({ supervisor, refusal }),
    registry,
    retrospective,
    readArtifactImpl: async () => { throw Object.assign(new Error('not written'), { code: 'ERR_ARTIFACT_MISSING' }); },
  });
  const post = (body) => api('/api/superagent/jobs/job-1/retrospective', { method: 'POST', body });
  return { base, api, post, registry, seeded, resolveCalls, transcriptCalls, superagentRoot, cockpitRoot, worktree, inPlace, clone, cached };
}

test('retrospective creates one session in the cockpit root with additionalDirectories from grantedDirectories and sends the prompt', async (t) => {
  const w = await retroWorld(t);
  const res = await w.post({ attemptId: 'a1' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { id: 'sess-1', token: 'tok-1', name: 'Retro: Login page · spec' });
  assert.equal(w.registry.created.length, 1);
  const [args] = w.registry.created;
  const snapshotDir = path.join(w.superagentRoot, 'retros', 'retro-1');
  assert.equal(args.cwd, w.cockpitRoot);
  assert.equal(args.provider, 'claude');
  assert.deepEqual(args.sdkOptions, { additionalDirectories: [snapshotDir, w.worktree, w.inPlace, w.clone] });

  assert.deepEqual(w.resolveCalls.map((c) => c.names), [['tool-plugin']]);
  const roots = w.resolveCalls[0].opts.searchRoots;
  for (const dir of [w.cockpitRoot, w.worktree, w.inPlace]) {
    assert.ok(roots.includes(path.dirname(dir)), `parent of ${dir}`);
    assert.ok(roots.includes(path.dirname(path.dirname(dir))), `grandparent of ${dir}`);
  }
  assert.equal(w.resolveCalls[0].opts.pluginsRoot, path.join(w.base, 'home', '.claude', 'plugins'));

  assert.equal(w.registry.sent.length, 1);
  const { id, text } = w.registry.sent[0];
  assert.equal(id, 'sess-1');
  assert.match(text, /^# Retro template/);
  for (const needle of [snapshotDir, w.cockpitRoot, w.clone, '"attemptId": "a1"']) assert.ok(text.includes(needle), needle);
  assert.ok(text.includes(`${w.cached}\`: outside the allowed folders`), 'the cached copy is reported, not granted');
  assert.deepEqual(await fs.readdir(path.join(snapshotDir, 'transcripts')), ['a1']);
});

test('retrospective passes no model', async (t) => {
  const w = await retroWorld(t);
  await w.post({ phase: 'spec' });
  assert.equal(w.registry.created.length, 1);
  assert.ok(!('model' in w.registry.created[0]), 'the SDK default model');
  assert.ok(!('permissionMode' in w.registry.created[0]), "the cwd's normal permission mode");
});

test('retrospective uses the persisted effort and seeds defaults', async (t) => {
  const w = await retroWorld(t, { defaults: { effort: 'high', autoContinue: true } });
  const res = await w.post({ attemptId: 'a1' });
  assert.equal(res.status, 200);
  assert.equal(w.registry.created[0].effort, 'high');
  assert.deepEqual(w.seeded, ['sess-1']);

  const bogus = await retroWorld(t, { defaults: { effort: 'turbo' } });
  await bogus.post({ attemptId: 'a1' });
  assert.equal(bogus.registry.created[0].effort, undefined);
});

test("retrospective name follows 'Retro: <title> · <phase> / <task> #n'; a collision picks #2", async (t) => {
  const registry = fakeRegistry({ taken: ['Retro: Login page · implement / t1'] });
  const w = await retroWorld(t, { registry });
  const res = await w.post({ phase: 'implement', task: 't1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Retro: Login page · implement / t1 #2');
  assert.deepEqual(registry.created.map((a) => a.name), ['Retro: Login page · implement / t1 #2']);

  const stage = await (await retroWorld(t)).post({ phase: 'implement' });
  assert.equal(stage.body.name, 'Retro: Login page · implement');
  const ofAttempt = await (await retroWorld(t)).post({ attemptId: 'a4' });
  assert.equal(ofAttempt.body.name, 'Retro: Login page · implement / t1');
});

test('retrospective gives up after #20 with 409 ERR_NAME_TAKEN and leaves no snapshot behind', async (t) => {
  const base = 'Retro: Login page · spec';
  const registry = fakeRegistry({ taken: [base, ...Array.from({ length: 19 }, (_, i) => `${base} #${i + 2}`)] });
  const w = await retroWorld(t, { registry });
  const res = await w.post({ attemptId: 'a1' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ERR_NAME_TAKEN');
  assert.deepEqual(registry.created, []);
  assert.deepEqual(await fs.readdir(path.join(w.superagentRoot, 'retros')), []);
});

test('retrospective answers 409 ERR_TRANSCRIPT_MISSING when no selected attempt has a transcript', async (t) => {
  const w = await retroWorld(t);
  const res = await w.post({ attemptId: 'a3' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ERR_TRANSCRIPT_MISSING');
  assert.deepEqual(w.registry.created, []);
  await assert.rejects(fs.stat(path.join(w.superagentRoot, 'retros')), { code: 'ENOENT' });
});

test("retrospective { phase, task } selects that task's attempts only", async (t) => {
  const w = await retroWorld(t);
  const res = await w.post({ phase: 'implement', task: 't1' });
  assert.equal(res.status, 200);
  assert.deepEqual(w.transcriptCalls, ['a2', 'a4']);
  const snapshotDir = path.join(w.superagentRoot, 'retros', 'retro-1');
  assert.deepEqual((await fs.readdir(path.join(snapshotDir, 'transcripts'))).sort(), ['a2', 'a4']);
  const { text } = w.registry.sent[0];
  assert.ok(text.includes('"attemptId": "a2"') && text.includes('"attemptId": "a4"'));
  assert.ok(!text.includes('`a3`'), 'the other task is left out');

  const whole = await retroWorld(t);
  await whole.post({ phase: 'implement' });
  assert.deepEqual(whole.transcriptCalls, ['a2', 'a3', 'a4']);
});

test('retrospective refuses a malformed or mixed selector with 400 ERR_INVALID_REQUEST before any work', async (t) => {
  const w = await retroWorld(t);
  const bad = [{}, { attemptId: 3 }, { attemptId: '' }, { attemptId: 'a1', phase: 'spec' }, { phase: 'spec', extra: 1 }, { task: 't1' }, { phase: 'implement', task: 7 }, { attemptId: 'a1', task: 't1' }, { phase: ['spec'] }];
  for (const body of bad) {
    const res = await w.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'ERR_INVALID_REQUEST', JSON.stringify(body));
  }
  assert.deepEqual(w.transcriptCalls, []);
  assert.deepEqual(w.registry.created, []);
  await assert.rejects(fs.stat(path.join(w.superagentRoot, 'retros')), { code: 'ENOENT' });
});

test('retrospective answers 404 ERR_UNKNOWN_SELECTION for an unknown attempt, phase or task, and a task on a non-task phase', async (t) => {
  const w = await retroWorld(t);
  for (const body of [{ attemptId: 'zz' }, { phase: 'nope' }, { phase: 'spec', task: 't1' }, { phase: 'implement', task: 't9' }, { phase: 'plan' }]) {
    const res = await w.post(body);
    assert.equal(res.status, 404, JSON.stringify(body));
    assert.equal(res.body.code, 'ERR_UNKNOWN_SELECTION', JSON.stringify(body));
  }
  const unknownJob = await w.api('/api/superagent/jobs/nope/retrospective', { method: 'POST', body: { attemptId: 'a1' } });
  assert.equal(unknownJob.status, 404);
  assert.equal(unknownJob.body.code, 'ERR_UNKNOWN_JOB');
  assert.deepEqual(w.transcriptCalls, []);
  assert.deepEqual(w.registry.created, []);
});

test('retrospective ignores a failing seed of the session defaults', async (t) => {
  const w = await retroWorld(t, { seedDefaults: async () => { throw new Error('settings.local.json is corrupt'); } });
  const res = await w.post({ attemptId: 'a1' });
  assert.equal(res.status, 200);
  assert.equal(w.registry.sent.length, 1);
  assert.deepEqual(w.registry.closed, []);
});

test('retrospective closes the new session when sending the prompt fails', async (t) => {
  const registry = fakeRegistry({ sendError: new Error('the session ended') });
  const w = await retroWorld(t, { registry });
  const res = await w.post({ attemptId: 'a1' });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /the session ended/);
  assert.deepEqual(registry.closed, ['sess-1']);
});

test('retrospective goes through the host gate', async (t) => {
  const w = await retroWorld(t, { refusal: { status: 503, state: 'stopping', ownerPort: null } });
  const res = await w.post({ attemptId: 'a1' });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ERR_SUPERAGENT_UNAVAILABLE');
  assert.equal(res.body.state, 'stopping');
  assert.deepEqual(w.transcriptCalls, []);
  assert.deepEqual(w.registry.created, []);
});
