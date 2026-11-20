import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSuperagentStore, deriveJob } from '../src/superagent/store.js';
import { tempDir, jobCreated, provisionedEvents, taskCreated, ev } from './superagent-helpers.mjs';
import { MILESTONE_2_PIPELINE, defaultConfig } from '../src/superagent/config.js';
import { artifactPaths } from '../src/superagent/results.js';

const quiet = () => {};
const stamp = (events) => events.map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e }));

test('a torn final line is ignored and the next append starts on a fresh line', async () => {
  const rootDir = await tempDir('sa-store-');
  const a = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  await a.append('j1', jobCreated());
  await a.append('j1', { type: 'needs-you', reason: 'stuck', detail: {} });
  const file = path.join(rootDir, 'j1', 'events.jsonl');
  await fs.appendFile(file, '{"seq":3,"type":"job-acc');
  const logs = [];
  const b = createSuperagentStore({ rootDir, now: () => 2000, logImpl: (m) => logs.push(m) });
  assert.equal((await b.load('j1')).state, 'needs-you');
  const ev = await b.append('j1', { type: 'job-stopped' });
  assert.equal(ev.seq, 3);
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) JSON.parse(line);
  assert.equal((await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1')).state, 'stopped');
  assert.deepEqual(logs, [`superagent: dropped a torn final line in ${file}`]);
});

test('append assigns increasing seq and at, and load returns the same events', async () => {
  const rootDir = await tempDir('sa-store-');
  let t = 5000;
  const store = createSuperagentStore({ rootDir, now: () => t++, logImpl: quiet });
  const evs = [];
  for (const e of provisionedEvents()) evs.push(await store.append('j1', e));
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(evs.map((e) => e.at), [5000, 5001, 5002]);
  assert.equal(evs[2].type, 'job-provisioned');
  const job = await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1');
  assert.equal(job.lastSeq, 3);
  assert.equal(job.createdAt, 5000);
  assert.equal(job.state, 'running');
  assert.deepEqual(job, deriveJob(evs));
});

test('a corrupt middle line is refused and left on disk', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  for (const e of provisionedEvents()) await store.append('j1', e);
  await store.flush();
  const file = path.join(rootDir, 'j1', 'events.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).split('\n');
  lines[1] = 'nope';
  await fs.writeFile(file, lines.join('\n'));
  const before = await fs.readFile(file);
  const fresh = createSuperagentStore({ rootDir, logImpl: quiet });
  await assert.rejects(fresh.load('j1'), { code: 'ERR_EVENTS_CORRUPT', line: 2 });
  await assert.rejects(fresh.append('j1', { type: 'job-stopped' }), { code: 'ERR_EVENTS_CORRUPT', line: 2 });
  await fresh.flush();
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(fresh.get('j1'), null);
});

test('deriveJob tracks provisioning, attempts, outcomes and phase advance', () => {
  const events = [jobCreated()];
  assert.equal(deriveJob(stamp(events)).state, 'provisioning');
  const [, worktree, provisioned] = provisionedEvents();
  events.push(worktree);
  let job = deriveJob(stamp(events));
  assert.equal(job.state, 'provisioning');
  assert.equal(job.repos[0].worktree, worktree.worktree);
  assert.equal(job.repos[0].baseSha, 'base');
  events.push(provisioned);
  assert.equal(deriveJob(stamp(events)).state, 'running');
  const started = { type: 'attempt-started', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', dir: '/d' };
  events.push(
    { ...started, attemptId: 'a1', n: 1, recovery: false, previousAttemptId: null },
    { type: 'attempt-session', attemptId: 'a1', sessionId: 's1' },
    { type: 'attempt-ended', attemptId: 'a1', outcome: 'failed', reason: 'no-result' },
    { ...started, attemptId: 'a2', n: 2, recovery: true, previousAttemptId: 'a1' },
    { type: 'attempt-ended', attemptId: 'a2', outcome: 'done', summary: 'wrote the spec' },
  );
  job = deriveJob(stamp(events));
  assert.equal(job.attempts.length, 2);
  assert.equal(job.attempts[0].sessionId, 's1');
  assert.equal(job.attempts[0].reason, 'no-result');
  assert.equal(job.attempts[1].recovery, true);
  assert.equal(job.attempts[1].previousAttemptId, 'a1');
  assert.equal(job.attempts[1].summary, 'wrote the spec');
  assert.equal(job.phaseIndex, 1);
  assert.equal(job.phaseId, 'accept');
  assert.equal(job.state, 'running');
  events.push({ type: 'needs-you', reason: 'ready-to-try', detail: { text: 'try it' } });
  job = deriveJob(stamp(events));
  assert.equal(job.state, 'needs-you');
  assert.equal(job.reason, 'ready-to-try');
  assert.deepEqual(job.detail, { text: 'try it' });
  events.push({ type: 'job-accepted' });
  job = deriveJob(stamp(events));
  assert.equal(job.state, 'done');
  assert.equal(job.lastSeq, events.length);
  assert.throws(() => deriveJob(stamp([{ type: 'job-provisioned' }])));
});

test('state.json mirrors deriveJob and a stale state.json is ignored on load', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  const events = [];
  for (const e of provisionedEvents()) events.push(await store.append('j1', e));
  await store.flush();
  const stateFile = path.join(rootDir, 'j1', 'state.json');
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), deriveJob(events));
  assert.deepEqual(store.get('j1'), deriveJob(events));
  await fs.writeFile(stateFile, JSON.stringify({ state: 'done' }));
  assert.equal((await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1')).state, 'running');
});

test('concurrent appends to one job land in call order with unique seq', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  await store.append('j1', jobCreated());
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    store.append('j1', { type: 'needs-you', reason: 'question', detail: { i } })));
  assert.deepEqual(results.map((e) => e.seq), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const lines = (await fs.readFile(path.join(rootDir, 'j1', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.slice(1).map((e) => [e.seq, e.detail.i]), Array.from({ length: 10 }, (_, i) => [i + 2, i]));
  await store.flush();
});

test('job ids must be safe path segments and listJobIds returns only those directories', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  assert.deepEqual(await store.listJobIds(), []);
  await store.append('j1', jobCreated());
  await store.append('j2', jobCreated({ jobId: 'j2' }));
  await fs.writeFile(path.join(rootDir, 'stray.txt'), '');
  assert.deepEqual(await store.listJobIds(), ['j1', 'j2']);
  assert.throws(() => store.jobDir('../escape'));
  await assert.rejects(store.append('..', jobCreated()));
  await assert.rejects(store.append('j1', { type: 'not-a-type' }));
  await store.flush();
});

test('a short write rejects the append, keeps get() on the last good state and the next append repairs the tail', async () => {
  const rootDir = await tempDir('sa-store-');
  let shortNext = false;
  const openImpl = async (file, flags) => {
    const fh = await fs.open(file, flags);
    if (flags !== 'a' || !shortNext) return fh;
    shortNext = false;
    return {
      write: (buf) => fh.write(buf, 0, Math.floor(buf.length / 2)),
      datasync: () => fh.datasync(),
      close: () => fh.close(),
    };
  };
  const logs = [];
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: (m) => logs.push(m), openImpl });
  for (const e of provisionedEvents()) await store.append('j1', e);
  shortNext = true;
  await assert.rejects(store.append('j1', { type: 'needs-you', reason: 'stuck', detail: {} }), /short write/);
  const kept = store.get('j1');
  assert.notEqual(kept, null);
  assert.equal(kept.state, 'running');
  assert.equal(kept.lastSeq, 3);
  const ev = await store.append('j1', { type: 'job-stopped' });
  assert.equal(ev.seq, 4);
  await store.flush();
  const file = path.join(rootDir, 'j1', 'events.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(logs, [`superagent: dropped a torn final line in ${file}`]);
  assert.equal(store.get('j1').state, 'stopped');
  assert.equal((await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1')).state, 'stopped');
});

test('an append rejected inside the chain does not disturb the next append', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  await store.append('j1', jobCreated());
  const [rejected, next] = await Promise.allSettled([
    store.append('j1', jobCreated()),
    store.append('j1', { type: 'job-provisioned' }),
  ]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(next.status, 'fulfilled');
  assert.equal(next.value.seq, 2);
  assert.equal(store.get('j1').state, 'running');
  await store.flush();
  const lines = (await fs.readFile(path.join(rootDir, 'j1', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.seq, e.type]), [[1, 'job-created'], [2, 'job-provisioned']]);
});

const m2 = (...more) => stamp([jobCreated({ pipeline: MILESTONE_2_PIPELINE }), { type: 'job-provisioned' }, ...more]);
const started = (attemptId, phase, over = {}) => ({ type: 'attempt-started', attemptId, phase, task: null, role: 'r', model: 'm', n: 1, ...over });
const ended = (attemptId, outcome = 'done', over = {}) => ({ type: 'attempt-ended', attemptId, outcome, ...over });

test('a Plan 2 attempt without purpose derives as purpose author, round null', () => {
  const job = deriveJob(m2(started('a1', 'spec'), ended('a1')));
  const a = job.attempts[0];
  assert.deepEqual([a.purpose, a.round, a.final, a.verdict, a.findings, a.commits, a.verified], ['author', null, false, null, null, [], null]);
});

test('attempt-started purpose and round are kept; attempt-ended verdict, findings, commits and verified are kept', () => {
  const job = deriveJob(m2(
    started('a1', 'spec-review', { purpose: 'review', round: 2, final: true }),
    ended('a1', 'done', { verdict: 'fail', findings: [{ id: 'f1' }], commits: ['abc'], verified: true }),
  ));
  const a = job.attempts[0];
  assert.deepEqual([a.purpose, a.round, a.final], ['review', 2, true]);
  assert.deepEqual([a.verdict, a.findings, a.commits, a.verified], ['fail', [{ id: 'f1' }], ['abc'], true]);
});

test('tasks-loaded sets tasks; a second tasks-loaded is ignored', () => {
  assert.equal(deriveJob(m2()).tasks, null);
  const job = deriveJob(m2(ev.tasksLoaded([taskCreated('t1')]), ev.tasksLoaded([taskCreated('t2'), taskCreated('t3')])));
  assert.deepEqual(job.tasks.map((t) => t.id), ['t1']);
});

// plan phases done through implement -> current phase is test (index 5)
const toTest = [ev.tasksLoaded([taskCreated('t1')]), ...[0, 1, 2, 3, 4].map((i) => ev.phaseCompleted(MILESTONE_2_PIPELINE[i].phase, 1))];

test('test-routed appends the fix task and rewinds to implement in one event; a second for the same attemptId is ignored; outside test it is ignored', () => {
  const fix = taskCreated('fix1', { origin: 'test', fromAttemptId: 'tt1' });
  let job = deriveJob(m2(ev.tasksLoaded([taskCreated('t1')]), ev.testRouted('tt1', fix)));
  assert.equal(job.tasks.length, 1, 'ignored while the current phase is spec');
  assert.equal(job.phaseId, 'spec');
  job = deriveJob(m2(...toTest, ev.testRouted('tt1', fix)));
  assert.deepEqual(job.tasks.map((t) => t.id), ['t1', 'fix1']);
  assert.equal(job.phaseId, 'implement');
  assert.equal(job.visits.implement, 2);
  job = deriveJob(m2(...toTest, ev.testRouted('tt1', fix), ev.testRouted('tt1', taskCreated('fix2', { origin: 'test', fromAttemptId: 'tt1' }))));
  assert.equal(job.tasks.length, 2);
  assert.equal(job.visits.implement, 2);
});

test('a Plan-2-style log (no purpose/final) derives visits of 1 for every reached phase', () => {
  const job = deriveJob(m2(started('a1', 'spec'), ended('a1')));
  assert.deepEqual(job.visits, { spec: 1, 'spec-review': 1 });
  assert.deepEqual(job.completions, []);
});

test('phase-completed advances only when it names the current phase and the current visit', () => {
  let job = deriveJob(m2(ev.phaseCompleted('plan', 1)));
  assert.equal(job.phaseId, 'spec');
  job = deriveJob(m2(ev.phaseCompleted('spec', 2)));
  assert.equal(job.phaseId, 'spec');
  job = deriveJob(m2({ ...ev.phaseCompleted('spec', 1, ['x']), verification: { ok: true } }));
  assert.equal(job.phaseId, 'spec-review');
  assert.deepEqual(job.completions, [{ phase: 'spec', visit: 1, unresolved: ['x'], verification: { ok: true } }]);
});

test('two test-failure cycles: a replayed phase-completed for a stale visit is ignored, the current visit advances', () => {
  const fix = taskCreated('fix1', { origin: 'test', fromAttemptId: 'tt1' });
  const base = [...toTest, ev.testRouted('tt1', fix)];
  let job = deriveJob(m2(...base, ev.phaseCompleted('implement', 1)));
  assert.equal(job.phaseId, 'implement');
  assert.equal(job.completions.length, 5);
  job = deriveJob(m2(...base, ev.phaseCompleted('implement', 2)));
  assert.equal(job.phaseId, 'test');
  assert.deepEqual(job.completions.at(-1), { phase: 'implement', visit: 2, unresolved: [], verification: null });
});

test('a done review or per-task attempt does not advance phaseIndex, a done author attempt does', () => {
  let job = deriveJob(m2(started('a1', 'spec'), ended('a1')));
  assert.equal(job.phaseId, 'spec-review');
  job = deriveJob(m2(ev.phaseCompleted('spec', 1), started('a2', 'spec-review', { purpose: 'review', round: 1 }), ended('a2')));
  assert.equal(job.phaseId, 'spec-review');
  const toImplement = [0, 1, 2, 3].map((i) => ev.phaseCompleted(MILESTONE_2_PIPELINE[i].phase, 1));
  job = deriveJob(m2(...toImplement, started('a3', 'implement', { task: 't1' }), ended('a3')));
  assert.equal(job.phaseId, 'implement');
});

test('store.append accepts the new event types and persists them across load', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, logImpl: quiet });
  for (const e of provisionedEvents({ pipeline: MILESTONE_2_PIPELINE })) await store.append('j1', e);
  await store.append('j1', ev.tasksLoaded([taskCreated('t1')]));
  await store.append('j1', ev.phaseCompleted('spec', 1));
  const job = await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1');
  assert.equal(job.tasks.length, 1);
  assert.equal(job.phaseId, 'spec-review');
});

test('deriveJob keeps the router snapshot and defaults it for older logs', () => {
  const router = { allowlist: ['m'], maxInputTokens: 10, maxOutputTokens: 5 };
  assert.deepEqual(deriveJob(stamp([jobCreated({ router })])).router, router);
  assert.deepEqual(deriveJob(stamp([jobCreated()])).router, { allowlist: ['claude-haiku-5-5'], maxInputTokens: 6000, maxOutputTokens: 300 });
});

test('router-decided is derived once per failed attempt', () => {
  const decided = (action, over = {}) => ({
    type: 'router-decided', forAttemptId: 'a1', action, note: `${action} note`, ok: true, error: null,
    model: 'claude-haiku-5-5', request: { estimatedTokens: 900, truncated: [] }, usage: { inputTokens: 800 }, latencyMs: 12, ...over,
  });
  assert.deepEqual(deriveJob(m2()).routerDecisions, []);
  const job = deriveJob(m2(started('a1', 'spec'), ended('a1', 'failed', { reason: 'no-result' }), decided('retry'), decided('escalate')));
  assert.equal(job.routerDecisions.length, 1);
  assert.deepEqual(job.routerDecisions[0], {
    forAttemptId: 'a1', action: 'retry', note: 'retry note', ok: true, error: null, model: 'claude-haiku-5-5',
    request: { estimatedTokens: 900, truncated: [] }, usage: { inputTokens: 800 }, latencyMs: 12, at: 1004,
  });
  const failed = deriveJob(m2(decided('escalate', { forAttemptId: 'a2', ok: false, error: 'timeout: no answer', note: null, usage: null })));
  assert.deepEqual([failed.routerDecisions[0].ok, failed.routerDecisions[0].error], [false, 'timeout: no answer']);
});

test('attempt-started handoff is kept', () => {
  const job = deriveJob(m2(started('a1', 'spec', { handoff: '/x/handoff.md' }), started('a2', 'spec')));
  assert.equal(job.attempts[0].handoff, '/x/handoff.md');
  assert.equal(job.attempts[1].handoff, null);
});

test('store.append accepts router-decided', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, logImpl: quiet });
  for (const e of provisionedEvents()) await store.append('j1', e);
  await store.append('j1', { type: 'router-decided', forAttemptId: 'a1', action: 'retry', note: 'go', ok: true, error: null, model: 'm', request: { estimatedTokens: 1, truncated: [] }, usage: null, latencyMs: 1 });
  await store.flush();
  assert.equal((await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1')).routerDecisions[0].action, 'retry');
});

const asked = [{ type: 'needs-you', reason: 'question', detail: { attemptId: 'a1', question: 'Q?' } }];

test('question-answered returns the job to running and survives replay', async () => {
  const events = stamp([jobCreated(), { type: 'job-provisioned' }, ...asked, { type: 'question-answered', forAttemptId: 'a1', answer: 'yes' }]);
  const job = deriveJob(events);
  assert.equal(job.state, 'running');
  assert.equal(job.reason, null);
  assert.deepEqual(job.answers, [{ forAttemptId: 'a1', answer: 'yes', question: 'Q?', at: events[events.length - 1].at }]);
  const blocker = deriveJob(stamp([jobCreated(), { type: 'job-provisioned' }, { type: 'needs-you', reason: 'question', detail: { kind: 'blocker', text: 'B?', attemptId: 'v1' } }, { type: 'question-answered', forAttemptId: 'v1', answer: 'no' }]));
  assert.equal(blocker.answers[0].question, 'B?', 'a verifier-confirmed blocker keeps its detail text');
  const bare = deriveJob(stamp([jobCreated(), { type: 'job-provisioned' }, { type: 'needs-you', reason: 'question', detail: { attemptId: 'a1' } }, { type: 'question-answered', forAttemptId: 'a1', answer: 'no' }]));
  assert.equal(bare.answers[0].question, null);
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, logImpl: quiet });
  const written = [];
  for (const { seq, at, ...e } of events) written.push(await store.append('j1', e));
  const fresh = await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1');
  assert.deepEqual(fresh, deriveJob(written));
  assert.equal(fresh.state, 'running');
  assert.deepEqual(fresh.answers.map((x) => x.answer), ['yes']);
});

test('question-answered is ignored unless it answers the open question', () => {
  const base = [jobCreated(), { type: 'job-provisioned' }];
  const wrongId = deriveJob(stamp([...base, ...asked, { type: 'question-answered', forAttemptId: 'zz', answer: 'x' }]));
  assert.equal(wrongId.state, 'needs-you');
  assert.deepEqual(wrongId.answers, []);
  const running = deriveJob(stamp([...base, { type: 'question-answered', forAttemptId: 'a1', answer: 'x' }]));
  assert.equal(running.state, 'running');
  assert.deepEqual(running.answers, []);
  const stuck = deriveJob(stamp([...base, { type: 'needs-you', reason: 'stuck', detail: { attemptId: 'a1' } }, { type: 'question-answered', forAttemptId: 'a1', answer: 'x' }]));
  assert.equal(stuck.state, 'needs-you');
  assert.equal(stuck.reason, 'stuck');
  assert.deepEqual(stuck.answers, []);
  const twice = deriveJob(stamp([...base, ...asked, { type: 'question-answered', forAttemptId: 'a1', answer: 'one' }, { type: 'question-answered', forAttemptId: 'a1', answer: 'two' }]));
  assert.equal(twice.answers.length, 1);
  assert.equal(twice.answers[0].answer, 'one');
});

test('attempt-ended carries brainstorm fields and tokens', () => {
  const qs = [{ id: 'Q1', text: 't' }];
  const job = deriveJob(stamp([jobCreated(), { type: 'job-provisioned' }, started('a1', 'brainstorm'), ended('a1', 'done', { questions: qs, answers: null, escalated: null, tokens: 1234 }), started('a2', 'brainstorm'), ended('a2')]));
  const [a1, a2] = job.attempts;
  assert.deepEqual([a1.questions, a1.answers, a1.escalated, a1.tokens], [qs, null, null, 1234]);
  assert.deepEqual([a2.questions, a2.answers, a2.escalated, a2.tokens], [null, null, null, null]);
});

test('a brainstorm phase advances only on an ask with no questions', () => {
  const pipeline = defaultConfig().pipeline;
  const run = (...more) => deriveJob(stamp([jobCreated({ pipeline }), { type: 'job-provisioned' }, ...more]));
  const ask = (id, over) => [started(id, 'brainstorm', { role: 'brainstormer', purpose: 'ask' }), ended(id, 'done', over)];
  assert.equal(run(...ask('a1', { questions: [{ id: 'Q1', text: 't' }] })).phaseIndex, 0);
  assert.equal(run(started('a1', 'brainstorm', { purpose: 'answer' }), ended('a1')).phaseIndex, 0);
  const done = run(...ask('a1', { questions: [] }));
  assert.equal(done.phaseIndex, 1);
  assert.equal(done.phaseId, 'spec');
});

test('needsYouSeq tracks the needs-you that set the state', () => {
  const upTo = (n, filler) => Array.from({ length: n }, () => filler);
  const asked7 = [jobCreated(), { type: 'job-provisioned' }, ...upTo(4, { type: 'precompact', attemptId: 'none' }), ...asked];
  const events = stamp(asked7);
  assert.equal(events.at(-1).seq, 7);
  assert.equal(deriveJob(stamp([jobCreated(), { type: 'job-provisioned' }])).needsYouSeq, null);
  assert.equal(deriveJob(events).needsYouSeq, 7);
  const answered = [...asked7, { type: 'question-answered', forAttemptId: 'a1', answer: 'yes' }];
  assert.equal(deriveJob(stamp(answered)).needsYouSeq, null);
  const again = [...answered, ...upTo(3, { type: 'precompact', attemptId: 'none' }), { type: 'needs-you', reason: 'ready-to-try', detail: null }];
  assert.equal(stamp(again).at(-1).seq, 12);
  assert.equal(deriveJob(stamp(again)).needsYouSeq, 12);
  assert.equal(deriveJob(stamp([...again, { type: 'job-stopped' }])).needsYouSeq, null);
});

const withoutTestFlag = (pipeline) => pipeline.map(({ test: _flag, ...phase }) => ({ ...phase }));

test('a legacy job derives the old artifacts and test flag', () => {
  const legacy = (...more) => deriveJob(stamp([jobCreated({ pipeline: withoutTestFlag(MILESTONE_2_PIPELINE) }), { type: 'job-provisioned' }, ...more]));
  const job = legacy();
  assert.equal(job.workflow, null);
  assert.deepEqual(job.prompts, {});
  assert.deepEqual(job.artifacts, {
    brief: 'docs/superpowers/jobs/add-hello/brief.md',
    spec: 'docs/superpowers/specs/2026-11-04-add-hello-design.md',
    plan: 'docs/superpowers/plans/2026-11-04-add-hello.md',
    tasks: 'docs/superpowers/jobs/add-hello/tasks.json',
    testReport: 'docs/superpowers/jobs/add-hello/test-report.md',
  });
  assert.deepEqual(artifactPaths(job), job.artifacts);
  assert.deepEqual(job.pipeline.filter((p) => p.test === true).map((p) => p.phase), ['test']);
  assert.deepEqual(job.repos.map(({ inPlace, toplevel, admittedHead, pendingChanges }) => ({ inPlace, toplevel, admittedHead, pendingChanges })), [{ inPlace: false, toplevel: null, admittedHead: null, pendingChanges: null }]);

  const toLegacyTest = [ev.tasksLoaded([taskCreated('t1')]), ...['spec', 'spec-review', 'plan', 'plan-review', 'implement'].map((phase) => ev.phaseCompleted(phase, 1))];
  assert.equal(legacy(...toLegacyTest).phaseId, 'test');
  const routed = legacy(...toLegacyTest, ev.testRouted('tt1', taskCreated('fix1', { origin: 'test', fromAttemptId: 'tt1' })));
  assert.deepEqual([routed.phaseIndex, routed.phaseId, routed.visits.implement], [4, 'implement', 2]);
});

test('a workflow job keeps its recorded artifacts and phases', () => {
  const pipeline = [
    { phase: 'diagnose', kind: 'author', role: 'investigator', inputs: ['idea'], outputs: ['diagnosis', 'tasks'] },
    { phase: 'fix', kind: 'per-task', role: 'fixer', inputs: ['tasks'] },
    { phase: 'verify', kind: 'author', role: 'verifier-tester', inputs: ['diagnosis', 'tasks'], outputs: ['testReport'], test: true },
    { phase: 'test', kind: 'author', role: 'tester', inputs: ['testReport'], outputs: ['testReport'] },
    { phase: 'accept', kind: 'human', inputs: ['testReport'] },
  ];
  const workflow = { id: 'troubleshoot', name: 'Troubleshooting', source: 'built-in', file: '/cockpit/workflows/troubleshoot.json' };
  const artifacts = { diagnosis: 'd.md', tasks: 't.json', testReport: 'r.md' };
  const prompts = { investigator: '/cockpit/workflows/investigator.md', fixer: null };
  const pendingChanges = { paths: ['notes.txt'], total: 1 };
  const repos = [{ id: 'primary', origin: '/repo', inPlace: true, toplevel: '/repo', admittedHead: 'abc123', pendingChanges }];
  const created = jobCreated({ pipeline, workflow, artifacts, prompts, repos });
  const wf = (...more) => deriveJob(stamp([created, { type: 'job-provisioned' }, ...more]));
  const job = wf();
  assert.deepEqual(job.workflow, workflow);
  assert.deepEqual(job.prompts, prompts);
  assert.deepEqual(artifactPaths(job), artifacts);
  assert.deepEqual(job.pipeline, pipeline, 'a workflow job is not normalised: the phase named test gains no flag');
  assert.deepEqual(job.repos.map(({ inPlace, toplevel, admittedHead, pendingChanges }) => ({ inPlace, toplevel, admittedHead, pendingChanges })), [{ inPlace: true, toplevel: '/repo', admittedHead: 'abc123', pendingChanges }]);
  job.repos[0].pendingChanges.paths.push('changed.txt');
  assert.deepEqual(created.repos[0].pendingChanges.paths, ['notes.txt'], 'the derived job does not alias pendingChanges');
  job.artifacts.diagnosis = 'changed.md';
  job.workflow.id = 'changed';
  assert.deepEqual([created.artifacts.diagnosis, created.workflow.id], ['d.md', 'troubleshoot'], 'the derived job does not alias job-created');

  const toVerify = [ev.phaseCompleted('diagnose', 1), ev.tasksLoaded([taskCreated('t1')]), ev.phaseCompleted('fix', 1)];
  assert.equal(wf(...toVerify).phaseId, 'verify');
  const fix = taskCreated('fix1', { origin: 'test', fromAttemptId: 'v1' });
  const routed = wf(...toVerify, ev.testRouted('v1', fix));
  assert.deepEqual([routed.phaseIndex, routed.phaseId, routed.visits.fix], [1, 'fix', 2]);
  assert.deepEqual(routed.tasks.map((t) => t.id), ['t1', 'fix1']);
  const atTest = wf(...toVerify, ev.phaseCompleted('verify', 1));
  assert.equal(atTest.phaseId, 'test');
  assert.equal(wf(...toVerify, ev.phaseCompleted('verify', 1), ev.testRouted('v2', fix)).phaseId, 'test', 'the unflagged phase named test does not route');
});

test('folder-restored only resumes a folder-changed job', () => {
  const base = [jobCreated(), { type: 'job-provisioned' }];
  const pause = { type: 'needs-you', reason: 'folder-changed', detail: { why: 'folder-changed', text: 'this folder is on main; switch it back to superagent/add-hello to continue' } };
  const restored = deriveJob(stamp([...base, pause, { type: 'folder-restored' }]));
  assert.deepEqual([restored.state, restored.reason, restored.detail, restored.needsYouSeq], ['running', null, null, null]);

  const others = [
    { type: 'needs-you', reason: 'stuck', detail: { why: 'attempt-cap' } },
    { type: 'needs-you', reason: 'question', detail: { attemptId: 'a1', question: 'Q?' } },
    { type: 'needs-you', reason: 'ready-to-try', detail: null },
  ];
  for (const other of others) {
    const job = deriveJob(stamp([...base, other, { type: 'folder-restored' }]));
    assert.deepEqual([job.state, job.reason, job.needsYouSeq], ['needs-you', other.reason, 3], other.reason);
  }
  for (const finished of [{ type: 'job-stopped' }, { type: 'job-failed', error: 'x' }, { type: 'job-accepted' }]) {
    const job = deriveJob(stamp([...base, pause, finished, { type: 'folder-restored' }]));
    assert.notEqual(job.state, 'running', finished.type);
  }
  assert.equal(deriveJob(stamp([jobCreated(), { type: 'folder-restored' }])).state, 'provisioning');

  const again = deriveJob(stamp([...base, pause, { type: 'folder-restored' }, pause]));
  assert.deepEqual([again.state, again.reason, again.needsYouSeq], ['needs-you', 'folder-changed', 5]);
});

test('store.append accepts folder-restored', async () => {
  const store = createSuperagentStore({ rootDir: await tempDir('sa-store-restored-'), logImpl: quiet });
  for (const e of [jobCreated(), { type: 'job-provisioned' }, { type: 'needs-you', reason: 'folder-changed', detail: { why: 'folder-changed', text: 't' } }]) await store.append('j1', e);
  await store.append('j1', { type: 'folder-restored' });
  assert.equal(store.get('j1').state, 'running');
  assert.equal((await store.load('j1')).state, 'running');
});

test('job-renamed changes the title only; slug and branch keep the created title', async () => {
  const store = createSuperagentStore({ rootDir: await tempDir('sa-store-renamed-'), logImpl: quiet });
  for (const e of [jobCreated(), { type: 'job-provisioned' }]) await store.append('j1', e);
  const before = store.get('j1');
  await store.append('j1', { type: 'job-renamed', title: 'A better name' });
  const after = (await store.load('j1'));
  assert.equal(after.title, 'A better name');
  assert.deepEqual([after.slug, after.branch, after.state], [before.slug, before.branch, 'running']);
  assert.equal(deriveJob(stamp([jobCreated(), { type: 'job-renamed', title: '' }])).title, jobCreated().title);
});
