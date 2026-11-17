import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MILESTONE_2_PIPELINE } from '../src/superagent/config.js';
import { artifactPaths, reviewPaths } from '../src/superagent/results.js';
import { deriveJob } from '../src/superagent/store.js';
import { superagentNotifications } from '../src/superagent/notifications.js';
import { artifactKeys, artifactPath, jobDetail, jobSummary } from '../src/superagent/view-model.js';
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
