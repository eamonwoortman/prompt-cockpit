import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deriveJob } from '../src/superagent/store.js';
import {
  currentRound, feedbackEligibility, feedbackShape, isRoundScoped, parseRoundKey, roundDir, roundKey, roundOf, roundOutputPaths, roundRoute,
  roundTestReportPaths, roundTriagePath,
} from '../src/superagent/feedback.js';
import { provisionedEvents } from './superagent-helpers.mjs';

const load = async (name) => JSON.parse(await fs.readFile(new URL(`../workflows/${name}.json`, import.meta.url), 'utf8'));
const feature = await load('feature');
const troubleshooting = await load('troubleshooting');
const ROOT = '.superpowers/superagent/J/artifacts';

const readyToTry = [{ type: 'needs-you', reason: 'ready-to-try', detail: { phase: 'accept' } }];
const jobFor = (workflow, { over = {}, events = readyToTry } = {}) => deriveJob(
  [...provisionedEvents({ jobId: 'J', pipeline: workflow.phases, workflow: { id: workflow.id }, artifacts: workflow.artifacts, artifactRoot: 'ledger', ...over }), ...events].map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e })),
);
const withPhases = (phases, artifacts = feature.artifacts) => ({ phases, artifacts, id: 'custom' });
const clone = (v) => structuredClone(v);

test('shape of the built-in workflows', () => {
  const f = feedbackShape(jobFor(feature));
  assert.deepEqual([f.taskWriting.phase, f.planReview.phase, f.perTask.phase, f.test.phase, f.human.phase, f.requirementKeys], ['plan', 'plan-review', 'implement', 'test', 'accept', ['spec']]);
  const t = feedbackShape(jobFor(troubleshooting));
  assert.deepEqual([t.taskWriting.phase, t.planReview.phase, t.perTask.phase, t.test.phase, t.human.phase, t.requirementKeys], ['investigate', 'diagnosis-review', 'fix', 'verify', 'accept', ['diagnosis']]);
});

test('shape is null without a single task-writing phase', () => {
  const two = clone(feature.phases);
  two.splice(1, 0, { phase: 'extra', kind: 'author', role: 'x', outputs: ['tasks'] });
  assert.equal(feedbackShape({ pipeline: two }), null);
  const none = feature.phases.map((p) => (p.phase === 'plan' ? { ...p, outputs: ['plan'] } : p));
  assert.equal(feedbackShape({ pipeline: none }), null);
});

test('shape requires the back-to-back layout', () => {
  const extra = clone(feature.phases);
  extra.splice(5, 0, { phase: 'extra', kind: 'author', role: 'x', outputs: ['plan'] });
  assert.equal(feedbackShape({ pipeline: extra }), null);
  const wrongTarget = feature.phases.map((p) => (p.phase === 'plan-review' ? { ...p, target: 'spec' } : p));
  assert.equal(feedbackShape({ pipeline: wrongTarget }), null);
  const noReview = feature.phases.filter((p) => p.phase !== 'plan-review');
  const shape = feedbackShape({ pipeline: noReview });
  assert.equal(shape.planReview, null);
  assert.equal(shape.perTask.phase, 'implement');
  const noHuman = feature.phases.filter((p) => p.kind !== 'human');
  assert.equal(feedbackShape({ pipeline: noHuman }), null);
});

test('output keys that differ only in case are refused', () => {
  const phases = feature.phases.map((p) => (p.phase === 'plan' ? { ...p, outputs: ['plan', 'Plan', 'tasks'] } : p));
  const artifacts = { ...feature.artifacts, Plan: 'rollout.md', plan: 'design.md' };
  assert.deepEqual(feedbackEligibility(jobFor(withPhases(phases, artifacts))), { ok: false, why: 'output-keys-clash' });
});

test('a legacy ledger job qualifies', () => {
  const events = [...provisionedEvents({ jobId: 'J', pipeline: feature.phases, artifactRoot: 'ledger' }), ...readyToTry].map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e }));
  const job = deriveJob(events);
  assert.equal(job.workflow, null);
  assert.deepEqual(feedbackEligibility(job), { ok: true });
});

test('eligibility accepts a ready-to-try ledger job', () => {
  assert.deepEqual(feedbackEligibility(jobFor(feature)), { ok: true });
  assert.deepEqual(feedbackEligibility(jobFor(troubleshooting)), { ok: true });
});

test('eligibility refuses', () => {
  const legacy = deriveJob([...provisionedEvents({ jobId: 'J', pipeline: feature.phases, workflow: { id: 'feature' }, artifacts: feature.artifacts }), ...readyToTry].map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e })));
  assert.deepEqual(feedbackEligibility(legacy), { ok: false, why: 'legacy-artifacts' });
  for (const rel of ['feedback/notes.md', 'Feedback/x.md']) {
    const job = jobFor({ ...feature, artifacts: { ...feature.artifacts, notes: rel } });
    assert.deepEqual(feedbackEligibility(job), { ok: false, why: 'feedback-path-in-use' }, rel);
  }
  assert.deepEqual(feedbackEligibility(jobFor(feature, { events: [] })), { ok: false, why: 'not-ready' });
  const odd = { ...feature, phases: feature.phases.filter((p) => p.kind !== 'human') };
  assert.deepEqual(feedbackEligibility(jobFor(odd)), { ok: false, why: 'workflow-shape' });
});

test('round paths', () => {
  const job = jobFor(feature);
  assert.equal(roundDir(job, 2), `${ROOT}/feedback/round-2`);
  assert.deepEqual(roundOutputPaths(job, 2, ['plan', 'tasks']), { plan: `${ROOT}/feedback/round-2/outputs/plan.md`, tasks: `${ROOT}/feedback/round-2/outputs/tasks.json` });
  assert.deepEqual(roundTestReportPaths(job, 2, 3), { testReport: `${ROOT}/feedback/round-2/tests/testReport-3.md` });
  assert.equal(roundTriagePath(job, 2), `${ROOT}/feedback/round-2/triage.md`);
});

test('round keys round-trip', () => {
  assert.deepEqual(parseRoundKey(roundKey(3, 'review:plan-review:1')), { round: 3, key: 'review:plan-review:1' });
  assert.equal(parseRoundKey('plan'), null);
  assert.equal(parseRoundKey('feedback:x:plan'), null);
});

test('a workflow key named triage cannot collide', () => {
  const phases = feature.phases.map((p) => (p.phase === 'plan' ? { ...p, outputs: ['triage', 'tasks'] } : p));
  const job = jobFor(withPhases(phases, { ...feature.artifacts, triage: 'triage.md' }));
  const out = roundOutputPaths(job, 1, ['triage', 'tasks']);
  assert.equal(out.triage, `${ROOT}/feedback/round-1/outputs/triage.md`);
  assert.notEqual(out.triage, roundTriagePath(job, 1));
  assert.equal(roundKey(1, 'out:triage'), 'feedback:1:out:triage');
  assert.notEqual(roundKey(1, 'out:triage'), roundKey(1, 'triage'));
});

test('round scoping, current round and route', () => {
  const job = jobFor(feature);
  assert.deepEqual(['plan', 'plan-review', 'test', 'accept', 'implement', 'spec'].map((p) => isRoundScoped(job, p)), [true, true, true, true, false, false]);
  assert.deepEqual([currentRound(job), roundOf({}), roundOf({ feedbackRound: 2 })], [0, 0, 2]);
  assert.equal(roundRoute(job, 1), null);
  assert.equal(roundRoute({ feedbackRounds: [{ round: 1, route: 'fix' }] }, 1), 'fix');
});
