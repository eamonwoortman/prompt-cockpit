import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MILESTONE_2_PIPELINE } from '../src/superagent/config.js';
import { artifactPaths, reviewPaths } from '../src/superagent/results.js';
import { deriveJob } from '../src/superagent/store.js';
import { superagentNotifications } from '../src/superagent/notifications.js';
import { artifactKeys, artifactPath, artifactWriterEnded, artifactWriters, jobDetail, jobSummary } from '../src/superagent/view-model.js';
import { jobCreated, provisionedEvents } from './superagent-helpers.mjs';

const stamp = (events) => events.map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e }));
const m2 = (extra = [], over = {}) => deriveJob(stamp([...provisionedEvents({ pipeline: MILESTONE_2_PIPELINE, ...over }), ...extra]));
const start = (attemptId, phase, over = {}) => ({ type: 'attempt-started', attemptId, phase, role: 'r', model: 'm', n: 1, purpose: 'author', ...over });
const done = (attemptId) => ({ type: 'attempt-ended', attemptId, outcome: 'done' });
const phaseDone = (phase) => ({ type: 'phase-completed', phase, visit: 1 });
const needsYou = (reason, detail = {}) => ({ type: 'needs-you', reason, detail });
const toPlanReview = () => [phaseDone('spec'), phaseDone('spec-review'), phaseDone('plan')];
const notLive = { isLive: () => false };

test('jobSummary maps states and needs-you reasons', () => {
  const m1 = (extra) => deriveJob(stamp([...provisionedEvents(), ...extra]));
  assert.equal(jobSummary(m1([needsYou('question', { question: 'q' })])).needsYou, 'question');
  assert.equal(jobSummary(m1([needsYou('ready-to-try')])).needsYou, 'ready-to-try');
  assert.equal(jobSummary(m1([needsYou('stuck', { why: 'x' })])).needsYou, 'stuck');
  const running = jobSummary(m1([]));
  assert.equal(running.needsYou, null);
  assert.equal(running.status, 'running');
  assert.equal(jobSummary(m1([needsYou('stuck')])).status, 'needs-you');
  assert.equal(jobSummary(deriveJob(stamp([jobCreated()]))).status, 'provisioning');
});

test('phase chips', () => {
  const job = m2(toPlanReview());
  assert.equal(job.phaseId, 'plan-review');
  const status = (j) => Object.fromEntries(jobDetail(j, notLive).phases.map((p) => [p.phase, p.status]));
  assert.deepEqual(status(job), { spec: 'done', 'spec-review': 'done', plan: 'done', 'plan-review': 'running', implement: 'todo', test: 'todo', accept: 'todo' });
  assert.equal(status(m2([...toPlanReview(), needsYou('stuck')]))['plan-review'], 'waiting');
});

test('attempts carry their cap and live flag', () => {
  const job = m2([
    start('a1', 'spec'), { type: 'attempt-session', attemptId: 'a1', sessionId: 's1' },
    start('a2', 'implement', { task: 'T1', purpose: 'implement' }), { type: 'attempt-session', attemptId: 'a2', sessionId: 's2' },
  ]);
  const { attempts } = jobDetail(job, { isLive: (id) => id === 's1' });
  const byId = Object.fromEntries(attempts.map((a) => [a.attemptId, a]));
  assert.equal(byId.a1.cap, job.limits.attemptsPerPhase);
  assert.equal(byId.a2.cap, job.limits.attemptsPerTask);
  assert.equal(byId.a1.live, true);
  assert.equal(byId.a2.live, false);
  assert.equal(byId.a2.sessionId, 's2');
});

test('needsYou.answerable is false for a budget question and true for any other question', () => {
  const budget = m2([needsYou('question', { kind: 'budget', text: 'over budget' })]);
  const asked = m2([needsYou('question', { question: 'which?' })]);
  assert.equal(jobDetail(budget, notLive).needsYou.answerable, false);
  const d = jobDetail(asked, notLive);
  assert.equal(d.needsYou.answerable, true);
  assert.equal(d.needsYou.key, `superagent:${asked.jobId}:${asked.needsYouSeq}`);
  assert.equal(d.needsYou.seq, asked.needsYouSeq);
  assert.equal(d.needsYou.text, 'which?');
  assert.equal(jobDetail(m2([]), notLive).needsYou, null);
});

test('artifactPath maps known keys and refuses others', () => {
  const job = m2(toPlanReview());
  assert.equal(artifactPath(job, 'spec'), artifactPaths(job).spec);
  assert.equal(artifactPath(job, 'review:spec-review:2'), reviewPaths(job, { phase: 'spec-review', round: 2 }).review);
  assert.equal(artifactPath(job, 'response:spec-review:2'), reviewPaths(job, { phase: 'spec-review', round: 2 }).response);
  assert.equal(artifactPath(job, 'verify:plan-review'), reviewPaths(job, { phase: 'plan-review' }).verify);
  assert.equal(artifactPath(job, 'verify:plan-review:2'), reviewPaths(job, { phase: 'plan-review', round: 2 }).verify);
  assert.equal(artifactPath(job, 'report:T1'), reviewPaths(job, { taskId: 'T1' }).report);
  assert.equal(artifactPath(job, 'taskReview:T1:1'), reviewPaths(job, { taskId: 'T1', round: 1 }).taskReview);
  for (const bad of ['../etc/passwd', 'review:x', 'review:spec-review', 'brief/../x', 'review:../x:1', 'review:nope:1', 'review:spec-review:0', 'report:T1:1', 'a:b:c:d', '', null]) {
    assert.equal(artifactPath(job, bad), null, String(bad));
  }
});

test('artifactKeys lists only keys the attempts imply', () => {
  const job = m2([
    start('a1', 'spec'), done('a1'),
    start('a2', 'spec-review', { purpose: 'review', round: 1 }), done('a2'),
    start('a3', 'spec-review', { purpose: 'fix', round: 1 }), done('a3'),
  ]);
  const keys = artifactKeys(job);
  assert.ok(keys.includes('review:spec-review:1'));
  assert.ok(keys.includes('response:spec-review:1'));
  assert.ok(keys.includes('spec'));
  assert.ok(!keys.includes('review:spec-review:2'));
  assert.ok(!keys.includes('plan'));
});

const needing = (jobId, reason, detail) => m2([needsYou(reason, detail)], { jobId, slug: jobId });

test('notification entries: one per needs-you job, typed', () => {
  const jobs = [
    needing('j1', 'question', { question: 'q?' }),
    needing('j2', 'ready-to-try', {}),
    needing('j3', 'stuck', { why: 'attempt-cap' }),
    m2([], { jobId: 'j4', slug: 'j4' }),
    needing('j5', 'question', { kind: 'budget', text: 'over' }),
  ];
  const entries = superagentNotifications(jobs);
  assert.deepEqual(entries.map((e) => [e.jobId, e.type, e.kind]), [['j1', 'question', 'superagent'], ['j2', 'ready-to-try', 'superagent'], ['j3', 'stuck', 'superagent'], ['j5', 'question', 'superagent']]);
  assert.equal(entries[3].message, '"Add hello" has a question: over');
});

test('notification text uses the first line, cut to 120 characters', () => {
  const [multi] = superagentNotifications([needing('j1', 'question', { question: 'Line one\nLine two' })]);
  assert.equal(multi.message, '"Add hello" has a question: Line one');
  const [long] = superagentNotifications([needing('j1', 'question', { question: 'x'.repeat(300) })]);
  const part = long.message.slice('"Add hello" has a question: '.length);
  assert.equal(part.length, 120);
  assert.ok(part.endsWith('…'));
  const [ready] = superagentNotifications([needing('j2', 'ready-to-try', {})]);
  assert.equal(ready.message, '"Add hello" is ready to try');
  const [why] = superagentNotifications([needing('j3', 'stuck', { why: 'attempt-cap' })]);
  assert.equal(why.message, '"Add hello" is stuck: attempt-cap');
  const [noWhy] = superagentNotifications([needing('j3', 'stuck', {})]);
  assert.equal(noWhy.message, '"Add hello" is stuck: stuck');
});

test('the key changes with a new needs-you', () => {
  const job = needing('j1', 'stuck', {});
  const a = superagentNotifications([{ ...job, needsYouSeq: 7 }])[0].key;
  const b = superagentNotifications([{ ...job, needsYouSeq: 12 }])[0].key;
  assert.equal(a, 'superagent:j1:7');
  assert.notEqual(a, b);
});

test('a corrupt job summarises without throwing', () => {
  const corrupt = { jobId: 'bad', state: 'failed', reason: 'corrupt-events' };
  const s = jobSummary(corrupt);
  assert.equal(s.title, 'corrupt event log');
  assert.equal(s.status, 'failed');
  const d = jobDetail(corrupt, { isLive: () => true });
  assert.deepEqual([d.phases, d.attempts, d.artifacts], [[], [], []]);
  assert.equal(artifactPath(corrupt, 'spec'), null);
  assert.deepEqual(superagentNotifications([corrupt]), []);
});

test('workflow artifact keys are listed', () => {
  const pipeline = [
    { phase: 'diagnose', kind: 'author', role: 'investigator', inputs: ['idea'], outputs: ['diagnosis', 'tasks'] },
    { phase: 'fix', kind: 'per-task', role: 'fixer', inputs: ['tasks'] },
    { phase: 'verify', kind: 'author', role: 'verifier-tester', inputs: ['diagnosis', 'tasks'], outputs: ['testReport'], test: true },
    { phase: 'accept', kind: 'human', inputs: ['testReport'] },
  ];
  const workflow = { id: 'troubleshoot', name: 'Troubleshooting', source: 'built-in', file: '/w/troubleshoot.json' };
  const artifacts = { diagnosis: 'docs/jobs/x/diagnosis.md', tasks: 'docs/jobs/x/tasks.json', testReport: 'docs/jobs/x/report.md' };
  const job = deriveJob(stamp([...provisionedEvents({ pipeline, workflow, artifacts }), start('a1', 'diagnose')]));
  assert.deepEqual(artifactKeys(job), ['diagnosis', 'tasks']);
  assert.deepEqual(jobDetail(job, notLive).artifacts, [
    { key: 'diagnosis', label: 'diagnosis', phase: 'diagnose', task: null, state: null },
    { key: 'tasks', label: 'tasks', phase: 'diagnose', task: null, state: null },
  ]);
  assert.equal(artifactPath(job, 'diagnosis'), 'docs/jobs/x/diagnosis.md');
  assert.equal(artifactPath(job, 'testReport'), 'docs/jobs/x/report.md');
  for (const unknown of ['spec', 'brief', 'plan', 'constructor', '__proto__', 'toString']) assert.equal(artifactPath(job, unknown), null, unknown);
});

test('the brief is listed when the job has one', () => {
  const brainstorming = [
    { phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] },
    { phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['brief'], outputs: ['spec'] },
    { phase: 'accept', kind: 'human', inputs: ['spec'] },
  ];
  const job = deriveJob(stamp([...provisionedEvents({ pipeline: brainstorming }), phaseDone('brainstorm'), start('a1', 'spec')]));
  assert.deepEqual(artifactKeys(job), ['brief', 'spec']);
  assert.equal(artifactPath(job, 'brief'), artifactPaths(job).brief);
});

test('folder-changed is a stuck bell entry with its text', () => {
  const text = 'this folder is on main; switch it back to superagent/j1 to continue';
  const pause = needsYou('folder-changed', { why: 'folder-changed', text, folder: '/repo' });
  const paused = needing('j1', 'folder-changed', { why: 'folder-changed', text, folder: '/repo' });
  const [entry] = superagentNotifications([paused]);
  assert.deepEqual(entry, { kind: 'superagent', type: 'stuck', key: `superagent:j1:${paused.needsYouSeq}`, jobId: 'j1', title: 'Add hello', message: `"Add hello" is paused: ${text}` });

  assert.equal(jobSummary(paused).needsYou, 'stuck');
  assert.equal(jobSummary(paused).reason, 'folder-changed');
  const view = jobDetail(paused, notLive).needsYou;
  assert.deepEqual([view.type, view.reason, view.text, view.answerable, view.seq], ['stuck', 'folder-changed', text, false, paused.needsYouSeq]);

  const restored = m2([pause, { type: 'folder-restored' }], { jobId: 'j1', slug: 'j1' });
  assert.deepEqual(superagentNotifications([restored]), []);
  assert.equal(jobDetail(restored, notLive).needsYou, null);
  const again = m2([pause, { type: 'folder-restored' }, pause], { jobId: 'j1', slug: 'j1' });
  const [fresh] = superagentNotifications([again]);
  assert.notEqual(fresh.key, entry.key);
  assert.equal(fresh.message, entry.message);
});

test('summary and detail carry the workflow, repo in-place flags and readyInputs', () => {
  const pipeline = [
    { phase: 'diagnose', kind: 'author', role: 'investigator', inputs: ['idea'], outputs: ['diagnosis'] },
    { phase: 'accept', kind: 'human', inputs: ['diagnosis', 'testReport'] },
  ];
  const workflow = { id: 'troubleshoot', name: 'Troubleshooting', source: 'built-in', file: '/w/troubleshoot.json' };
  const artifacts = { diagnosis: 'd.md', testReport: 'r.md' };
  const repos = [{ id: 'primary', origin: '/repo', inPlace: true }, { id: 'extra', origin: '/other' }];
  const job = deriveJob(stamp([...provisionedEvents({ pipeline, workflow, artifacts, repos })]));
  assert.deepEqual(jobSummary(job).workflow, { id: 'troubleshoot', name: 'Troubleshooting' });
  const detail = jobDetail(job, notLive);
  assert.deepEqual(detail.workflow, { id: 'troubleshoot', name: 'Troubleshooting' });
  assert.deepEqual(detail.repos.map((r) => [r.id, r.inPlace]), [['primary', true], ['extra', false]]);
  assert.deepEqual(detail.readyInputs, ['diagnosis', 'testReport']);

  const legacy = m2([]);
  assert.equal(jobSummary(legacy).workflow, null);
  assert.equal(jobDetail(legacy, notLive).workflow, null);
  assert.deepEqual(jobDetail(legacy, notLive).readyInputs, MILESTONE_2_PIPELINE.at(-1).inputs);
});

test('an attempt the in-place gate ended is marked paused before launch', () => {
  const gated = (attemptId) => ({ type: 'attempt-ended', attemptId, outcome: 'failed', reason: 'folder-changed' });
  const job = m2([
    start('a1', 'spec'), gated('a1'),
    needsYou('folder-changed', { why: 'folder-changed', text: 'moved', folder: '/repo' }), { type: 'folder-restored' },
    start('a2', 'spec'), { type: 'attempt-ended', attemptId: 'a2', outcome: 'failed', reason: 'no-result' },
    start('a3', 'spec', { n: 2 }),
  ]);
  const flags = jobDetail(job, notLive).attempts.map((a) => [a.attemptId, a.n, a.pausedBeforeLaunch]);
  assert.deepEqual(flags, [['a1', 1, true], ['a2', 1, false], ['a3', 2, false]]);
});

test('a phase whose only attempt the in-place gate ended lists no artifacts', () => {
  const gatedSpec = m2([start('a1', 'spec'), { type: 'attempt-ended', attemptId: 'a1', outcome: 'failed', reason: 'folder-changed' }]);
  assert.deepEqual(artifactKeys(gatedSpec), []);
  const ranSpec = m2([start('a1', 'spec'), { type: 'attempt-ended', attemptId: 'a1', outcome: 'failed', reason: 'no-result' }]);
  assert.deepEqual(artifactKeys(ranSpec), ['spec']);
});

test('a gated review or per-task attempt lists no artifact of its own', () => {
  const gated = (attemptId) => ({ type: 'attempt-ended', attemptId, outcome: 'failed', reason: 'folder-changed' });
  const job = m2([
    ...toPlanReview(),
    start('r1', 'plan-review', { purpose: 'review', round: 1 }), gated('r1'),
    start('i1', 'implement', { task: 'T1', purpose: 'implement' }), gated('i1'),
    start('t1', 'implement', { task: 'T1', purpose: 'task-review', round: 1 }), gated('t1'),
  ]);
  const keys = artifactKeys(job);
  assert.ok(!keys.includes('review:plan-review:1'), keys.join(','));
  assert.ok(!keys.includes('report:T1'), keys.join(','));
  assert.ok(!keys.includes('taskReview:T1:1'), keys.join(','));
});

test('only a stuck entry is retryable, and a retried-away attempt is marked', () => {
  const failed = { type: 'attempt-ended', attemptId: 'a1', outcome: 'failed', reason: 'failed' };
  const stuck = m2([start('a1', 'spec'), failed, needsYou('stuck', { phase: 'spec', task: null, why: 'attempt-cap' })]);
  assert.equal(jobDetail(stuck, notLive).needsYou.retryable, true);
  for (const other of [m2([needsYou('question', { question: 'q' })]), m2([needsYou('ready-to-try')]), m2([needsYou('folder-changed', { text: 't' })])]) {
    assert.equal(jobDetail(other, notLive).needsYou.retryable, false, other.reason);
  }
  const retried = m2([start('a1', 'spec'), failed, needsYou('stuck', { phase: 'spec', task: null, why: 'attempt-cap' }),
    { type: 'job-retried', needsYouSeq: stuck.needsYouSeq, phase: 'spec', task: null, fromAttemptId: 'a1', handoff: null, note: null }, start('a2', 'spec')]);
  assert.deepEqual(jobDetail(retried, notLive).attempts.map((a) => [a.attemptId, a.retried]), [['a1', true], ['a2', false]]);
});

const troubleshooting = () => {
  const pipeline = [
    { phase: 'investigate', kind: 'author', role: 'investigator', inputs: ['idea'], outputs: ['diagnosis', 'tasks'] },
    { phase: 'diagnosis-review', kind: 'review', role: 'diagnosis-reviewer', author: 'investigator', target: 'diagnosis', inputs: ['tasks'], maxRounds: 3 },
    { phase: 'fix', kind: 'per-task', role: 'fixer', taskReview: 'fix-reviewer', inputs: ['diagnosis', 'tasks'] },
    { phase: 'verify', kind: 'author', role: 'verifier-tester', inputs: ['diagnosis', 'tasks'], outputs: ['testReport'], test: true },
    { phase: 'accept', kind: 'human', inputs: ['testReport'] },
  ];
  const artifacts = { diagnosis: 'docs/jobs/x/diagnosis.md', tasks: 'docs/jobs/x/tasks.json', testReport: 'docs/jobs/x/test-report.md' };
  const workflow = { id: 'troubleshooting', name: 'Troubleshooting', source: 'built-in', file: '/w/troubleshooting.json' };
  return { pipeline, artifacts, workflow };
};
const ended = (attemptId, outcome = 'done', reason = null) => ({ type: 'attempt-ended', attemptId, outcome, reason });

test('artifactWriters attributes a revised diagnosis to the review fix round', () => {
  const job = deriveJob(stamp([
    ...provisionedEvents(troubleshooting()),
    start('i1', 'investigate'), ended('i1'), phaseDone('investigate'),
    start('r1', 'diagnosis-review', { purpose: 'review', round: 1 }), ended('r1'),
    start('f1', 'diagnosis-review', { purpose: 'fix', round: 1 }), ended('f1'),
    start('r2', 'diagnosis-review', { purpose: 'review', round: 2 }),
  ]));
  const writers = artifactWriters(job);
  assert.deepEqual(writers.get('diagnosis'), { attemptId: 'f1', phase: 'diagnosis-review', task: null });
  assert.deepEqual(writers.get('tasks'), { attemptId: 'f1', phase: 'diagnosis-review', task: null });
  assert.deepEqual(writers.get('review:diagnosis-review:1'), { attemptId: 'r1', phase: 'diagnosis-review', task: null });
  assert.deepEqual(writers.get('response:diagnosis-review:1'), { attemptId: 'f1', phase: 'diagnosis-review', task: null });
  assert.deepEqual(writers.get('review:diagnosis-review:2'), { attemptId: 'r2', phase: 'diagnosis-review', task: null });
  assert.equal(artifactWriterEnded(job, 'diagnosis'), true);
  assert.equal(artifactWriterEnded(job, 'review:diagnosis-review:2'), false, 'r2 is still running');
  assert.equal(artifactWriterEnded(job, 'testReport'), false, 'nothing wrote it');
});

test('artifactWriters covers per-task attempts and the test phase', () => {
  const job = deriveJob(stamp([
    ...provisionedEvents(troubleshooting()),
    start('i1', 'investigate'), ended('i1'), phaseDone('investigate'), phaseDone('diagnosis-review'),
    start('x1', 'fix', { task: 'T1', purpose: 'implement' }), ended('x1'),
    start('x2', 'fix', { task: 'T1', purpose: 'task-review', round: 1 }), ended('x2'),
    start('x3', 'fix', { task: 'T1', purpose: 'fix', round: 1 }), ended('x3'),
    start('v1', 'verify', { purpose: 'test' }),
  ]));
  const writers = artifactWriters(job);
  assert.equal(writers.get('report:T1').attemptId, 'x3');
  assert.deepEqual(writers.get('taskReview:T1:1'), { attemptId: 'x2', phase: 'fix', task: 'T1' });
  assert.equal(writers.get('testReport').attemptId, 'v1');
  assert.equal(writers.get('diagnosis').attemptId, 'i1', 'a per-task fix does not revise the diagnosis');
});

test('a gated attempt writes nothing', () => {
  const gated = (attemptId) => ended(attemptId, 'failed', 'folder-changed');
  const job = deriveJob(stamp([
    ...provisionedEvents(troubleshooting()),
    start('i1', 'investigate'), ended('i1'), phaseDone('investigate'),
    start('r1', 'diagnosis-review', { purpose: 'review', round: 1 }), ended('r1'),
    start('f1', 'diagnosis-review', { purpose: 'fix', round: 1 }), gated('f1'),
  ]));
  const writers = artifactWriters(job);
  assert.equal(writers.get('diagnosis').attemptId, 'i1');
  assert.equal(writers.has('response:diagnosis-review:1'), false);
  assert.ok(![...writers.values()].some((w) => w.attemptId === 'f1'));
});

test('the legacy brief is attributed to the brainstorm phase', () => {
  const brainstorming = (brainstormOutputs) => [
    { phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], ...brainstormOutputs },
    { phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['brief'], outputs: ['spec'] },
    { phase: 'accept', kind: 'human', inputs: ['spec'] },
  ];
  const events = [
    start('b1', 'brainstorm', { purpose: 'ask' }), ended('b1'),
    start('b2', 'brainstorm', { role: 'stand-in', purpose: 'answer' }), ended('b2'),
    start('b3', 'brainstorm', { purpose: 'ask' }), ended('b3'),
    start('b4', 'brainstorm', { role: 'stand-in', purpose: 'answer' }), ended('b4'),
    phaseDone('brainstorm'), start('s1', 'spec'),
  ];
  for (const outputs of [{ outputs: ['brief'] }, {}]) {
    const job = deriveJob(stamp([...provisionedEvents({ pipeline: brainstorming(outputs) }), ...events]));
    assert.equal(job.workflow, null);
    assert.ok(artifactKeys(job).includes('brief'));
    assert.deepEqual(artifactWriters(job).get('brief'), { attemptId: 'b3', phase: 'brainstorm', task: null }, JSON.stringify(outputs));
    assert.equal(artifactWriters(job).get('spec').attemptId, 's1');
  }
});

const fin = (byModel, over = {}) => {
  const costs = Object.values(byModel).map((m) => m.costUsd);
  const known = costs.reduce((sum, c) => sum + (c ?? 0), 0);
  const unpriced = Object.entries(byModel).filter(([, m]) => m.costUsd === null).map(([k]) => k);
  return { state: 'final', knownCostUsd: known, tokens: { total: 0 }, byModel, unpricedModels: unpriced, complete: unpriced.length === 0, claudeSessionId: 'c', ...over };
};
const spendJob = () => m2([
  start('a1', 'spec'), { type: 'attempt-ended', attemptId: 'a1', outcome: 'done', summary: 'S', reason: 'R', verdict: 'v', findings: [1, 2], commits: ['c1'], question: 'Q' },
  start('t1', 'implement', { task: 'T1', purpose: 'implement', model: 'x' }), done('t1'),
  start('t2', 'implement', { task: 'T1', purpose: 'fix', round: 1 }), done('t2'),
]);
const withUsage = (map) => ({ isLive: () => false, usageFor: (a) => map[a.attemptId] ?? null });

test('jobDetail exposes attempt result fields', () => {
  const [a] = jobDetail(spendJob(), notLive).attempts;
  assert.equal(a.summary, 'S');
  assert.equal(a.reason, 'R');
  assert.equal(a.verdict, 'v');
  assert.equal(a.findingsCount, 2);
  assert.equal(a.question, 'Q');
  assert.equal(a.commits, 1);
  assert.equal(typeof a.durationMs, 'number');
  assert.equal(a.durationMs, a.endedAt - a.startedAt);
});

test('jobDetail sums known spend by phase, task and model', () => {
  const spend = jobDetail(spendJob(), withUsage({
    a1: fin({ opus: { costUsd: 1, tokens: 100 } }),
    t1: fin({ opus: { costUsd: 0.5, tokens: 50 }, haiku: { costUsd: 0.25, tokens: 5 } }),
    t2: fin({ haiku: { costUsd: 0.25, tokens: 5 } }),
  })).spend;
  assert.deepEqual(spend.total, { usd: 2, complete: true });
  assert.deepEqual(spend.workers, { usd: 2, complete: true });
  assert.deepEqual(spend.router, { usd: null, complete: true });
  assert.deepEqual(spend.byPhase, [
    { phase: 'spec', task: null, attempts: 1, usd: 1, complete: true },
    { phase: 'implement', task: 'T1', attempts: 2, usd: 1, complete: true },
  ]);
  assert.deepEqual(spend.byTask, [{ task: 'T1', usd: 1, complete: true }]);
  assert.deepEqual(spend.byModel, [
    { model: 'opus', source: 'worker', tokens: 150, usd: 1.5, complete: true },
    { model: 'haiku', source: 'worker', tokens: 10, usd: 0.5, complete: true },
  ]);
  assert.equal(spend.complete, true);
});

test('jobDetail with no usage marks spend incomplete and never sums null', () => {
  const d = jobDetail(spendJob(), notLive);
  assert.deepEqual(d.spend.total, { usd: null, complete: false });
  assert.equal(d.spend.complete, false);
  assert.deepEqual(d.attempts[0].cost, { usd: null, complete: false });
  assert.equal(d.attempts[0].usage, null);
  assert.equal(d.attempts[0].usageNote, 'unavailable');
  const unknown = jobDetail(spendJob(), withUsage({ a1: { state: 'unknown', note: 'pruned' } })).attempts[0];
  assert.equal(unknown.usageNote, 'pruned');
  assert.equal(unknown.usage, null);
});

test('a partially priced attempt makes spend incomplete', () => {
  const map = { a1: fin({ opus: { costUsd: 1, tokens: 1 }, mystery: { costUsd: null, tokens: 2 } }), t1: fin({}), t2: fin({}) };
  const d = jobDetail(spendJob(), withUsage(map));
  assert.deepEqual(d.attempts[0].cost, { usd: 1, complete: false });
  assert.deepEqual(d.spend.total, { usd: 1, complete: false });
  assert.deepEqual(d.spend.byModel.find((m) => m.model === 'mystery'), { model: 'mystery', source: 'worker', tokens: 2, usd: null, complete: false });
});

test('an all unpriced attempt has usd null; a genuinely zero cost has usd 0 and is complete', () => {
  const unpriced = jobDetail(spendJob(), withUsage({ a1: fin({ mystery: { costUsd: null, tokens: 2 } }) })).attempts[0];
  assert.deepEqual(unpriced.cost, { usd: null, complete: false });
  const zero = jobDetail(spendJob(), withUsage({ a1: fin({ opus: { costUsd: 0, tokens: 0 } }) })).attempts[0];
  assert.deepEqual(zero.cost, { usd: 0, complete: true });
});

test('a router decision with usage null or costUsd null makes spend incomplete; a numeric one lands in byModel with source router', () => {
  const decided = (forAttemptId, model, usage) => ({ type: 'router-decided', forAttemptId, action: 'retry', ok: true, model, usage });
  const all = { a1: fin({ opus: { costUsd: 1, tokens: 1 } }) };
  const numeric = m2([start('a1', 'spec'), done('a1'), decided('a1', 'haiku', { costUsd: 0.1, totalInputTokens: 10, outputTokens: 2 })]);
  const ok = jobDetail(numeric, withUsage(all)).spend;
  assert.deepEqual(ok.router, { usd: 0.1, complete: true });
  assert.deepEqual(ok.byModel.at(-1), { model: 'haiku', source: 'router', tokens: 12, usd: 0.1, complete: true });
  assert.equal(ok.total.usd, 1.1);
  for (const usage of [null, { costUsd: null }]) {
    const bad = jobDetail(m2([start('a1', 'spec'), done('a1'), decided('a1', 'haiku', usage)]), withUsage(all)).spend;
    assert.deepEqual(bad.router, { usd: null, complete: false });
    assert.equal(bad.complete, false);
    assert.equal(bad.total.usd, 1);
  }
  const two = m2([start('a1', 'spec'), done('a1'), decided('a1', 'haiku', { costUsd: 0.1 }), start('a2', 'spec'), done('a2'), decided('a2', 'sonnet', { costUsd: 0.2 })]);
  const routers = jobDetail(two, withUsage({})).spend.byModel.filter((m) => m.source === 'router');
  assert.deepEqual(routers.map((m) => [m.model, m.usd]), [['haiku', 0.1], ['sonnet', 0.2]]);
});

test('a gated attempt does not make spend incomplete', () => {
  const job = m2([
    start('a1', 'spec'), done('a1'),
    start('g1', 'spec-review', { purpose: 'review', round: 1 }), { type: 'attempt-ended', attemptId: 'g1', outcome: 'failed', reason: 'folder-changed' },
  ]);
  const d = jobDetail(job, withUsage({ a1: fin({ opus: { costUsd: 1, tokens: 1 } }) }));
  assert.deepEqual(d.spend.total, { usd: 1, complete: true });
  assert.equal(d.spend.byPhase.length, 1);
  const gated = d.attempts.find((a) => a.attemptId === 'g1');
  assert.equal(gated.usageNote, null);
  assert.equal(gated.usage, null);
});

test('pruned history keeps final spend but disables Inspect', () => {
  const job = spendJob();
  const usage = { a1: fin({ opus: { costUsd: 1, tokens: 1 } }) };
  const d = jobDetail(job, { usageFor: (a) => usage[a.attemptId] ?? null, transcriptFor: () => ({ available: false, claudeSessionId: 'c', cwd: null }) });
  assert.equal(d.attempts[0].transcript.available, false);
  assert.deepEqual(d.attempts[0].cost, { usd: 1, complete: true });
  const kept = jobDetail(job, { transcriptFor: () => ({ available: true, claudeSessionId: 'c', cwd: '/w' }) });
  assert.equal(kept.attempts[0].transcript.available, true);
});

test('jobDetail artifacts carry phase, task and state', () => {
  const job = deriveJob(stamp([
    ...provisionedEvents(troubleshooting()),
    start('i1', 'investigate'), ended('i1'), phaseDone('investigate'), phaseDone('diagnosis-review'),
    start('x1', 'fix', { task: 'T1', purpose: 'implement' }), ended('x1'),
  ]));
  const states = new Map([['diagnosis', 'snapshot'], ['report:T1', 'workspace']]);
  const artifacts = jobDetail(job, { artifactStates: states }).artifacts;
  assert.deepEqual(artifacts.find((a) => a.key === 'diagnosis'), { key: 'diagnosis', label: 'diagnosis', phase: 'investigate', task: null, state: 'snapshot' });
  assert.deepEqual(artifacts.find((a) => a.key === 'report:T1'), { key: 'report:T1', label: 'report:T1', phase: 'fix', task: 'T1', state: 'workspace' });
  assert.equal(artifacts.find((a) => a.key === 'tasks').state, null);
});

test('artifactWriterEnded is true only for a writer that ended done', () => {
  for (const [outcome, expected] of [['done', true], ['failed', false], ['stopped', false], ['question', false], ['interrupted', false]]) {
    const job = deriveJob(stamp([...provisionedEvents(troubleshooting()), start('i1', 'investigate'), ended('i1', outcome)]));
    assert.equal(artifactWriterEnded(job, 'diagnosis'), expected, outcome);
  }
});
