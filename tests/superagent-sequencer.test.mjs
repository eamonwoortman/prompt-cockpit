import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { deriveJob } from '../src/superagent/store.js';
import { outcomeForResult } from '../src/superagent/results.js';
import * as sequencer from '../src/superagent/sequencer.js';
import { MILESTONE_2_PIPELINE } from '../src/superagent/config.js';
import { ev, jobCreated, provisionedEvents, taskCreated } from './superagent-helpers.mjs';

const { attemptCap, attemptsFor, backoffMs, failureSignature, nextAction } = sequencer;
const { reviewLoop, pickTask, taskStatus, routeTestFailure, buildFixTask } = sequencer;

const T0 = 1_000_000;
const ctx = (over = {}) => ({ now: T0, liveSessions: 0, maxConcurrentSessions: 3, ...over });
const limits = jobCreated().limits;
const AUTHOR_EXTRAS = { purpose: 'author', round: null, final: false, taskDef: null, reviewFindings: null, contested: null, handoff: null };

const started = (id, n, over = {}) => ({ type: 'attempt-started', attemptId: id, phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', n, recovery: n > 1, previousAttemptId: n > 1 ? `a${n - 1}` : null, dir: '/d', ...over });
const ended = (id, outcome, over = {}) => ({ type: 'attempt-ended', attemptId: id, outcome, ...over });
const build = (...events) => deriveJob([...provisionedEvents(), ...events].map((e, i) => ({ seq: i + 1, at: 1, ...e })));
const failedAt = (id, n, at, signature) => [started(id, n), ended(id, 'failed', { reason: 'no-result', signature, at })];

test('a fresh job launches attempt 1 of its first phase without a recovery note', () => {
  assert.deepEqual(nextAction(build(), ctx()), {
    type: 'launch', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', effort: null, maxTurns: 60, n: 1, recovery: false, previousAttemptId: null, ...AUTHOR_EXTRAS,
  });
});

test('a done attempt moves to the human phase, which needs the user', () => {
  const job = build(started('a1', 1), ended('a1', 'done'));
  assert.deepEqual(nextAction(job, ctx()), { type: 'needs-you', reason: 'ready-to-try', detail: { phase: 'accept' } });
});

test('a live attempt blocks any further launch', () => {
  assert.deepEqual(nextAction(build(started('a1', 1)), ctx()), { type: 'none' });
});

test('back-off is 1 minute after the first failure and 5 after the second', () => {
  const one = build(...failedAt('a1', 1, T0, 'sig-one'));
  assert.deepEqual(nextAction(one, ctx({ now: T0 + 59_999 })), { type: 'wait', until: T0 + 60_000, why: 'backoff' });
  const launch = nextAction(one, ctx({ now: T0 + 60_000 }));
  assert.equal(launch.type, 'launch');
  assert.equal(launch.n, 2);
  assert.equal(launch.recovery, true);
  assert.equal(launch.previousAttemptId, 'a1');
  const T1 = T0 + 100_000;
  const two = build(...failedAt('a1', 1, T0, 'sig-one'), ...failedAt('a2', 2, T1, 'sig-two'));
  assert.deepEqual(nextAction(two, ctx({ now: T1 + 1 })), { type: 'wait', until: T1 + 300_000, why: 'backoff' });
});

test('three consuming attempts reach the phase cap', () => {
  const job = build(...failedAt('a1', 1, T0, 's1'), ...failedAt('a2', 2, T0, 's2'), ...failedAt('a3', 3, T0, 's3'));
  const action = nextAction(job, ctx({ now: T0 + 10_000_000 }));
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'stuck');
  assert.equal(action.detail.why, 'attempt-cap');
  assert.equal(action.detail.phase, 'spec');
  assert.equal(action.detail.signature, 's3');
});

test('the same failure signature twice stops retrying before the cap', () => {
  const sig = 'invalid-result|identity mismatch: attemptid';
  const job = build(...failedAt('a1', 1, T0, sig), ...failedAt('a2', 2, T0, sig));
  const action = nextAction(job, ctx({ now: T0 + 10_000_000 }));
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'stuck');
  assert.equal(action.detail.why, 'repeated-error');
  assert.equal(action.detail.signature, sig);
});

test('interrupted and stopped attempts do not consume', () => {
  for (const outcome of ['interrupted', 'stopped']) {
    const job = build(started('a1', 1), ended('a1', outcome, { at: T0 }));
    assert.deepEqual(nextAction(job, ctx({ now: T0 })), {
      type: 'launch', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', effort: null, maxTurns: 60, n: 1, recovery: true, previousAttemptId: 'a1', ...AUTHOR_EXTRAS,
    });
  }
});

test('a question outcome asks the user', () => {
  const job = build(started('a1', 1), ended('a1', 'question', { question: 'Which DB?' }));
  assert.deepEqual(nextAction(job, ctx()), { type: 'needs-you', reason: 'question', detail: { attemptId: 'a1', question: 'Which DB?' } });
});

test('concurrency: no launch when live sessions are at the limit', () => {
  assert.deepEqual(nextAction(build(), ctx({ liveSessions: 3 })), { type: 'wait', until: null, why: 'concurrency' });
  assert.equal(nextAction(build(), ctx({ liveSessions: 2 })).type, 'launch');
});

test('a provisioning job launches nothing', () => {
  assert.deepEqual(nextAction(deriveJob([jobCreated()]), ctx()), { type: 'none' });
});

test('failure signatures are stable across addresses, hashes and counters', () => {
  assert.equal(failureSignature('failed', 'Error at 0x1f3a9c2d line 42\nmore'), 'failed|error at # line #');
  const same = [
    ['Error at 0x7ffe line 9', 'Error at 0x1f3a9c2d line 42'],
    ['commit 3f9a1c2 missing', 'commit 88ab12e0d missing'],
    ['attempt-12 timed out', 'attempt-7 timed out'],
  ];
  for (const [a, b] of same) assert.equal(failureSignature('failed', a), failureSignature('failed', b));
  assert.notEqual(failureSignature('failed', 'ENOENT spec.md'), failureSignature('failed', 'EACCES spec.md'));
  assert.equal(failureSignature('no-result'), 'no-result|');
});

test('helpers: attemptCap, attemptsFor and outcomeForResult', () => {
  assert.equal(attemptCap(limits, null), 3);
  assert.equal(attemptCap(limits, 'T1'), 2);
  assert.equal(backoffMs(limits, 1), 60_000);
  assert.equal(backoffMs(limits, 9), 300_000);
  const job = build(started('a1', 1), started('a2', 1, { task: 'T1' }));
  assert.deepEqual(attemptsFor(job, 'spec').map((a) => a.attemptId), ['a1']);
  assert.deepEqual(attemptsFor(job, 'spec', 'T1').map((a) => a.attemptId), ['a2']);
  assert.deepEqual(outcomeForResult({ status: 'done' }), { outcome: 'done' });
  const failed = outcomeForResult({ status: 'failed' });
  assert.equal(failed.reason, 'failed');
  assert.equal(typeof failed.signature, 'string');
  assert.deepEqual(outcomeForResult({ status: 'blocked', question: 'Q?' }), { outcome: 'question', question: 'Q?' });
  const blocked = outcomeForResult({ status: 'blocked' });
  assert.equal(blocked.reason, 'blocked');
  assert.equal(typeof blocked.signature, 'string');
});

// Plan 3: review loops, per-task selection, test-failure routing.

const MIN = 60_000;
const m2 = (...events) => deriveJob([...provisionedEvents({ pipeline: MILESTONE_2_PIPELINE }), ...events].map((e, i) => ({ seq: i + 1, at: 1, ...e })));
const upTo = (phaseId) => MILESTONE_2_PIPELINE.slice(0, MILESTONE_2_PIPELINE.findIndex((p) => p.phase === phaseId)).map((p) => ev.phaseCompleted(p.phase, 1));
const testPhase = MILESTONE_2_PIPELINE.find((p) => p.phase === 'test');

let nextId = 0;
// One attempt as events; `outcome: null` leaves it in flight. Anything not
// consumed by attempt-started goes onto attempt-ended.
function attempt({ purpose, round = null, final = false, outcome = 'done', phase = 'spec-review', task = null, id = `x${++nextId}`, ...ended }) {
  const started = { type: 'attempt-started', attemptId: id, phase, task, role: 'r', model: 'm', n: 1, purpose, round, final, dir: '/d' };
  return outcome == null ? [started] : [started, { type: 'attempt-ended', attemptId: id, outcome, at: T0, ...ended }];
}
const scope = (...specs) => attemptsFor(m2(...specs.flatMap(attempt)), 'spec-review');
const F = (id, severity = 'minor') => ({ id, severity, text: `${id} text` });
const rev = (round, verdict, findings = []) => ({ purpose: 'review', round, verdict, findings });
const trev = (round, verdict, findings = []) => ({ ...rev(round, verdict, findings), purpose: 'task-review' });
const fix = (round, dispositions = {}, final = false) => ({
  purpose: 'fix', round, final, findings: Object.entries(dispositions).map(([id, disposition]) => ({ ...F(id), disposition })),
});
const ver = (verified) => ({ purpose: 'verify', verified });
let nextSig = 0;
const fail = (purpose, round = null, signature = `sig-${++nextSig}`) => ({ purpose, round, outcome: 'failed', reason: 'failed', signature });
const L = (purpose, round, side, over = {}) => ({ type: 'launch', purpose, round, final: false, side, reviewFindings: null, contested: null, ...over });
const COMPLETE = { type: 'complete', unresolved: [], verification: [] };
const PHASE_LOOP = { initial: null, maxRounds: 3, failedCap: 3 };
const TASK_LOOP = { initial: 'implement', maxRounds: 2, failedCap: 2 };

test('reviewLoop: no attempts launches reviewer round 1; initial implement launches the initial attempt first', () => {
  assert.deepEqual(reviewLoop([], PHASE_LOOP), L('review', 1, 'reviewer'));
  assert.deepEqual(reviewLoop([], TASK_LOOP), L('implement', null, 'initial'));
  assert.deepEqual(reviewLoop(scope({ purpose: 'implement' }), TASK_LOOP), L('task-review', 1, 'reviewer'));
  assert.deepEqual(reviewLoop(scope({ purpose: 'implement' }), { ...TASK_LOOP, maxRounds: 0 }), COMPLETE);
});

test('reviewLoop: approve completes with no unresolved', () => {
  const attempts = scope(rev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'fixed' }), rev(2, 'approve', [F('m1')]));
  assert.deepEqual(reviewLoop(attempts, PHASE_LOOP), COMPLETE);
});

test('reviewLoop: changes launches the author fix for the same round; after the fix launches reviewer round n+1', () => {
  const r1 = rev(1, 'changes', [F('b1', 'blocker'), F('m1')]);
  assert.deepEqual(reviewLoop(scope(r1), PHASE_LOOP), L('fix', 1, 'author', { reviewFindings: [F('b1', 'blocker'), F('m1')] }));
  assert.deepEqual(reviewLoop(scope(r1, fix(1, { b1: 'fixed', m1: 'fixed' })), PHASE_LOOP), L('review', 2, 'reviewer'));
});

test('reviewLoop: at maxRounds the fix is final and no reviewer pass follows it', () => {
  const opts = { ...PHASE_LOOP, maxRounds: 2 };
  const head = [rev(1, 'changes', [F('m1')]), fix(1, { m1: 'fixed' }), rev(2, 'changes', [F('m2')])];
  assert.deepEqual(reviewLoop(scope(...head), opts), L('fix', 2, 'author', { final: true, reviewFindings: [F('m2')] }));
  assert.deepEqual(reviewLoop(scope(...head, fix(2, { m2: 'fixed' }, true)), opts), COMPLETE);
});

test('reviewLoop: cap with only minors completes and lists them as open or declined', () => {
  const attempts = scope(
    rev(1, 'changes', [F('m1'), F('m2', 'major'), F('m3'), F('m4')]),
    fix(1, { m1: 'open', m2: 'declined: out of scope', m3: 'fixed' }, true),
  );
  assert.deepEqual(reviewLoop(attempts, { ...PHASE_LOOP, maxRounds: 1 }), {
    type: 'complete',
    unresolved: [
      { ...F('m1'), status: 'open' },
      { ...F('m2', 'major'), status: 'declined' },
      { ...F('m4'), status: 'open' },
    ],
    verification: [],
  });
});

test('reviewLoop: cap with a fixed blocker completes without a verifier', () => {
  const attempts = scope(rev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'fixed' }, true));
  assert.deepEqual(reviewLoop(attempts, { ...PHASE_LOOP, maxRounds: 1 }), COMPLETE);
});

const contestedRun = [
  rev(1, 'changes', [F('b1', 'blocker'), F('b2', 'blocker'), F('b3', 'blocker'), F('b4', 'blocker'), F('m1')]),
  fix(1, { b1: 'declined: not a bug', b2: 'fixed', b4: 'open', m1: 'fixed' }, true),
];

test('reviewLoop: cap with a declined or unlisted blocker launches the verifier with exactly the contested ids', () => {
  assert.deepEqual(reviewLoop(scope(...contestedRun), { ...PHASE_LOOP, maxRounds: 1 }), L('verify', null, 'verifier', { contested: ['b1', 'b3', 'b4'] }));
});

test('reviewLoop: verifier verified:true on any blocker returns question with evidence; all false completes with disputed-not-verified', () => {
  const opts = { ...PHASE_LOOP, maxRounds: 1 };
  const verified = (b3) => [
    { id: 'b1', verified: false, evidence: 'b1 is fine' },
    { id: 'b3', verified: b3, evidence: 'b3 reproduced' },
    { id: 'b4', verified: false, evidence: 'b4 is fine' },
  ];
  const asked = reviewLoop(scope(...contestedRun, { ...ver(verified(true)), id: 'v1' }), opts);
  assert.equal(asked.type, 'question');
  assert.equal(asked.attemptId, 'v1');
  assert.match(asked.question, /b3 text/);
  assert.doesNotMatch(asked.question, /b1 text|b4 text/);
  assert.match(asked.evidence, /b3 reproduced/);
  assert.doesNotMatch(asked.evidence, /is fine/);
  assert.deepEqual(reviewLoop(scope(...contestedRun, ver(verified(false))), opts), {
    type: 'complete',
    unresolved: ['b1', 'b3', 'b4'].map((id) => ({ ...F(id, 'blocker'), status: 'disputed-not-verified' })),
    verification: verified(false),
  });
});

test('reviewLoop: failed attempts do not advance rounds and stop at failedCap with stuck', () => {
  const opts = { ...PHASE_LOOP, failedCap: 2 };
  const r1 = rev(1, 'changes', [F('m1')]);
  assert.deepEqual(reviewLoop(scope(fail('review', 1)), opts), L('review', 1, 'reviewer'));
  assert.deepEqual(reviewLoop(scope(fail('review', 1), r1), opts), L('fix', 1, 'author', { reviewFindings: [F('m1')] }));
  assert.deepEqual(reviewLoop(scope(fail('review', 1), r1, fail('fix', 1)), opts), { type: 'stuck', why: 'attempt-cap' });
  for (const outcome of ['interrupted', 'stopped']) {
    assert.deepEqual(reviewLoop(scope(fail('review', 1), { purpose: 'review', round: 1, outcome }), opts), L('review', 1, 'reviewer'));
  }
});

test('reviewLoop: an in-flight attempt returns pending; a question outcome returns question-open', () => {
  assert.deepEqual(reviewLoop(scope({ purpose: 'review', round: 1, outcome: null }), PHASE_LOOP), { type: 'pending' });
  assert.deepEqual(
    reviewLoop(scope({ purpose: 'review', round: 1, outcome: 'question', question: 'Which DB?', id: 'q1' }), PHASE_LOOP),
    { type: 'question-open', attemptId: 'q1', question: 'Which DB?' },
  );
});

test('reviewLoop: an always-changes reviewer with maxRounds 3 yields exactly 3 reviewer launches and 3 fix launches, the third fix final, then complete', () => {
  const specs = [];
  const launches = [];
  let result;
  for (let i = 0; i < 20; i++) {
    result = reviewLoop(scope(...specs), PHASE_LOOP);
    if (result.type !== 'launch') break;
    launches.push(result);
    const id = `m${result.round}`;
    specs.push(result.purpose === 'review' ? rev(result.round, 'changes', [F(id)]) : fix(result.round, { [id]: 'open' }, result.final));
  }
  assert.deepEqual(launches.map((l) => l.purpose), ['review', 'fix', 'review', 'fix', 'review', 'fix']);
  assert.deepEqual(launches.map((l) => l.round), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(launches.filter((l) => l.purpose === 'fix').map((l) => l.final), [false, false, true]);
  assert.deepEqual(result, { type: 'complete', unresolved: [{ ...F('m3'), status: 'open' }], verification: [] });
});

test('reviewLoop: injected failures - two failed reviewers before the first success neither advance the round nor stop under failedCap 3; a third failure returns stuck', () => {
  const twoFails = [fail('review', 1), fail('review', 1)];
  const r1 = rev(1, 'changes', [F('m1')]);
  assert.deepEqual(reviewLoop(scope(...twoFails), PHASE_LOOP), L('review', 1, 'reviewer'));
  assert.deepEqual(reviewLoop(scope(...twoFails, r1), PHASE_LOOP), L('fix', 1, 'author', { reviewFindings: [F('m1')] }));
  assert.deepEqual(reviewLoop(scope(...twoFails, r1, fail('fix', 1)), PHASE_LOOP), { type: 'stuck', why: 'attempt-cap' });
});

const atReview = (...specs) => m2(...upTo('spec-review'), ...specs.flatMap(attempt));
const launchOf = (job, role, over) => ({
  type: 'launch', task: null, role, model: job.models[role].model, effort: job.models[role].effort ?? null, maxTurns: job.models[role].maxTurns,
  n: 1, recovery: false, previousAttemptId: null, round: null, final: false, taskDef: null, reviewFindings: null, contested: null, handoff: null, ...over,
});

test('nextAction: with defaults (attemptsPerPhase 3) reviewer 1, fix 1, reviewer 2 is NOT stopped by the cap', () => {
  const job = atReview(rev(1, 'changes', [F('m1')]), fix(1, { m1: 'fixed' }), rev(2, 'changes', [F('m2')]));
  assert.equal(job.limits.attemptsPerPhase, 3);
  assert.deepEqual(nextAction(job, ctx()), launchOf(job, 'spec-writer', { phase: 'spec-review', purpose: 'fix', round: 2, n: 4, reviewFindings: [F('m2')] }));
});

test('nextAction: review phase launches reviewer with the reviewer role and model; fix uses the author role; verify uses verifier', () => {
  const fresh = atReview();
  assert.deepEqual(nextAction(fresh, ctx()), launchOf(fresh, 'spec-reviewer', { phase: 'spec-review', purpose: 'review', round: 1 }));
  const r1 = rev(1, 'changes', [F('b1', 'blocker')]);
  const fixing = atReview(r1);
  assert.deepEqual(nextAction(fixing, ctx()), launchOf(fixing, 'spec-writer', { phase: 'spec-review', purpose: 'fix', round: 1, n: 2, reviewFindings: [F('b1', 'blocker')] }));
  const capped = atReview(r1, fix(1, { b1: 'open' }), rev(2, 'changes', [F('b1', 'blocker')]), fix(2, { b1: 'open' }), rev(3, 'changes', [F('b1', 'blocker')]), fix(3, { b1: 'declined: no' }, true));
  assert.deepEqual(nextAction(capped, ctx()), launchOf(capped, 'verifier', { phase: 'spec-review', purpose: 'verify', n: 7, contested: ['b1'] }));
});

test('nextAction: a finished review loop returns complete-phase for the current visit; a verified blocker or a question needs you', () => {
  assert.deepEqual(nextAction(atReview(rev(1, 'approve')), ctx()), { type: 'complete-phase', phase: 'spec-review', visit: 1, unresolved: [], verification: [] });
  const capped = [rev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'open' }), rev(2, 'changes', [F('b1', 'blocker')]), fix(2, { b1: 'open' }), rev(3, 'changes', [F('b1', 'blocker')]), fix(3, { b1: 'open' }, true)];
  const verified = atReview(...capped, { ...ver([{ id: 'b1', verified: true, evidence: 'reproduced on main' }]), id: 'v1' });
  const asked = nextAction(verified, ctx());
  assert.equal(asked.type, 'needs-you');
  assert.equal(asked.reason, 'question');
  assert.equal(asked.detail.attemptId, 'v1');
  assert.equal(asked.detail.phase, 'spec-review');
  assert.match(asked.detail.question, /b1 text/);
  assert.match(asked.detail.evidence, /reproduced on main/);
  const disputed = atReview(...capped, ver([{ id: 'b1', verified: false, evidence: 'not reproducible' }]));
  assert.deepEqual(nextAction(disputed, ctx()), {
    type: 'complete-phase', phase: 'spec-review', visit: 1,
    unresolved: [{ ...F('b1', 'blocker'), status: 'disputed-not-verified' }],
    verification: [{ id: 'b1', verified: false, evidence: 'not reproducible' }],
  });
  const open = nextAction(atReview({ purpose: 'review', round: 1, outcome: 'question', question: 'Which DB?', id: 'q1' }), ctx());
  assert.equal(open.type, 'needs-you');
  assert.equal(open.reason, 'question');
  assert.equal(open.detail.attemptId, 'q1');
  assert.equal(open.detail.question, 'Which DB?');
  assert.deepEqual(nextAction(atReview({ purpose: 'review', round: 1, outcome: null }), ctx()), { type: 'none' });
});

test('nextAction: review phase guard order - loop state, failed cap, repeated error, back-off, concurrency', () => {
  const stuckWhy = (job) => {
    const action = nextAction(job, ctx({ now: T0 + 60 * MIN }));
    assert.equal(action.type, 'needs-you');
    assert.equal(action.reason, 'stuck');
    assert.equal(action.detail.phase, 'spec-review');
    assert.equal(action.detail.task, null);
    return action.detail.why;
  };
  assert.equal(stuckWhy(atReview(fail('review', 1, 'a'), fail('review', 1, 'b'), fail('review', 1, 'c'))), 'attempt-cap');
  assert.equal(stuckWhy(atReview(fail('review', 1, 'same'), fail('review', 1, 'same'))), 'repeated-error');
  assert.deepEqual(
    nextAction(atReview(fail('review', 1, 'a'), fail('review', 1, 'b'), fail('review', 1, 'c'), rev(1, 'approve')), ctx()),
    { type: 'complete-phase', phase: 'spec-review', visit: 1, unresolved: [], verification: [] },
  );
  const once = atReview({ ...fail('review', 1, 'a'), id: 'f1' });
  assert.deepEqual(nextAction(once, ctx({ now: T0 + 1 })), { type: 'wait', until: T0 + MIN, why: 'backoff' });
  assert.deepEqual(nextAction(once, ctx({ now: T0 + MIN })), launchOf(once, 'spec-reviewer', { phase: 'spec-review', purpose: 'review', round: 1, n: 2, recovery: true, previousAttemptId: 'f1' }));
  assert.deepEqual(nextAction(atReview(), ctx({ liveSessions: 3 })), { type: 'wait', until: null, why: 'concurrency' });
});

const atImplement = (tasks, ...specs) => m2(...upTo('implement'), ...(tasks ? [ev.tasksLoaded(tasks)] : []), ...specs.flatMap(attempt));
const forTask = (id, specs) => specs.map((s) => ({ phase: 'implement', task: id, ...s }));
const doneTask = (id) => forTask(id, [{ purpose: 'implement' }, trev(1, 'approve')]);

test('pickTask: respects dependsOn, plan order, returns blocked when nothing is runnable, null when all done', () => {
  const T1 = taskCreated('T1', { dependsOn: ['T2'] });
  const T2 = taskCreated('T2');
  const T3 = taskCreated('T3');
  assert.equal(pickTask(atImplement([T1, T2, T3])).id, 'T2');
  assert.equal(pickTask(atImplement([T1, T2, T3], ...forTask('T2', [{ purpose: 'implement' }]))).id, 'T2');
  const t2done = atImplement([T1, T2, T3], ...doneTask('T2'));
  assert.equal(taskStatus(t2done, T2), 'done');
  assert.notEqual(taskStatus(t2done, T1), 'done');
  assert.equal(pickTask(t2done).id, 'T1');
  assert.equal(pickTask(atImplement([T1, T2, T3], ...doneTask('T2'), ...doneTask('T1'))).id, 'T3');
  assert.equal(pickTask(atImplement([T1, T2, T3], ...doneTask('T2'), ...doneTask('T1'), ...doneTask('T3'))), null);
  const A = taskCreated('A', { dependsOn: ['B'] });
  const B = taskCreated('B', { dependsOn: ['A'] });
  assert.deepEqual(pickTask(atImplement([A, B])), { blocked: true });
  assert.deepEqual(pickTask(atImplement([taskCreated('C', { dependsOn: ['ghost'] })])), { blocked: true });
});

test('nextAction: implement phase returns load-tasks when job.tasks is null; launches the first runnable task; complete-phase when every task is done; needs-you stuck when blocked', () => {
  assert.deepEqual(nextAction(atImplement(null), ctx()), { type: 'load-tasks' });
  const T1 = taskCreated('T1');
  const T2 = taskCreated('T2', { dependsOn: ['T1'] });
  const fresh = atImplement([T1, T2]);
  assert.deepEqual(nextAction(fresh, ctx()), launchOf(fresh, 'implementer', { phase: 'implement', task: 'T1', purpose: 'implement', taskDef: T1 }));
  const reviewing = atImplement([T1, T2], ...forTask('T1', [{ purpose: 'implement' }]));
  assert.deepEqual(nextAction(reviewing, ctx()), launchOf(reviewing, 'task-reviewer', { phase: 'implement', task: 'T1', purpose: 'task-review', round: 1, n: 2, taskDef: T1 }));
  const fixing = atImplement([T1, T2], ...forTask('T1', [{ purpose: 'implement' }, trev(1, 'changes', [F('m1')])]));
  assert.deepEqual(nextAction(fixing, ctx()), launchOf(fixing, 'implementer', { phase: 'implement', task: 'T1', purpose: 'fix', round: 1, n: 3, reviewFindings: [F('m1')], taskDef: T1 }));
  assert.deepEqual(nextAction(atImplement([T1, T2], ...forTask('T1', [{ purpose: 'implement', outcome: null }])), ctx()), { type: 'none' });

  const t2capped = forTask('T2', [{ purpose: 'implement' }, trev(1, 'changes', [F('m1')]), fix(1, { m1: 'open' }), trev(2, 'changes', [F('m1')]), fix(2, { m1: 'open' }, true)]);
  assert.deepEqual(nextAction(atImplement([T1, T2], ...doneTask('T1'), ...t2capped), ctx()), {
    type: 'complete-phase', phase: 'implement', visit: 1, unresolved: [{ ...F('m1'), status: 'open', task: 'T2' }], verification: [],
  });

  const blocked = atImplement([taskCreated('A', { dependsOn: ['B'] }), taskCreated('B', { dependsOn: ['A'] })]);
  assert.deepEqual(nextAction(blocked, ctx()), { type: 'needs-you', reason: 'stuck', detail: { phase: 'implement', task: null, why: 'tasks-blocked', lastReason: null, signature: null } });

  const taskStuck = atImplement([T1, T2], ...forTask('T1', [fail('implement', null, 'a'), fail('implement', null, 'b')]));
  const action = nextAction(taskStuck, ctx({ now: T0 + 60 * MIN }));
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'stuck');
  assert.equal(action.detail.task, 'T1');
  assert.equal(action.detail.why, 'attempt-cap');
});

const testFail = (id, findings, signature = `sig-${id}`) => attempt({ id, phase: 'test', purpose: 'test', outcome: 'failed', reason: 'failed', signature, findings });
const TF = [{ id: 'f1', severity: 'blocker', text: 'login fails', repo: 'primary' }];
const atTest = (...events) => m2(...upTo('implement'), ev.tasksLoaded([taskCreated('T1')]), ev.phaseCompleted('implement', 1), ...events);

test('buildFixTask: id is F- plus the first 8 attempt id chars, dependsOn is [], repos come from findings, defaults to primary', () => {
  const job = deriveJob([...provisionedEvents({ pipeline: MILESTONE_2_PIPELINE, repos: [{ id: 'primary', origin: '/repo' }, { id: 'lib', origin: '/lib' }] })].map((e, i) => ({ seq: i + 1, at: 1, ...e })));
  const findings = [
    { id: 'f1', severity: 'blocker', text: 'login fails', repo: 'lib' },
    { id: 'f2', severity: 'minor', text: 'typo', repo: 'lib' },
    { id: 'f3', severity: 'major', text: 'crash', repo: 'ghost' },
    { id: 'f4', severity: 'major', text: 'slow', repo: 'primary' },
  ];
  assert.deepEqual(buildFixTask(job, '0123456789abcdef', findings), {
    id: 'F-01234567',
    title: 'Fix test failures from attempt 01234567',
    repos: ['lib', 'primary'],
    dependsOn: [],
    acceptance: 'login fails\ntypo\ncrash\nslow',
    verify: '',
    origin: 'test',
    fromAttemptId: '0123456789abcdef',
  });
  assert.deepEqual(buildFixTask(job, 'feedc0de-1', [{ id: 'f1', severity: 'minor', text: 'x' }]).repos, ['primary']);
  assert.deepEqual(buildFixTask(job, 'feedc0de-1', [{ id: 'f1', severity: 'minor', text: 'x', repo: 'ghost' }]).repos, ['primary']);
});

test('routeTestFailure: returns the findings once; returns null after a task with that fromAttemptId exists; null when the failure has no findings', () => {
  const failed = atTest(...testFail('t1', TF));
  assert.deepEqual(routeTestFailure(failed, testPhase), { attemptId: 't1', findings: TF });
  const routed = atTest(...testFail('t1', TF), ev.testRouted('t1', buildFixTask(failed, 't1', TF)), ev.phaseCompleted('implement', 2));
  assert.equal(routed.phaseId, 'test');
  assert.equal(routeTestFailure(routed, testPhase), null);
  assert.equal(routeTestFailure(atTest(...testFail('t1', null)), testPhase), null);
  assert.equal(routeTestFailure(atTest(...testFail('t1', [])), testPhase), null);
  assert.equal(routeTestFailure(atTest(), testPhase), null);
});

test('routeTestFailure with a planned task already named like the generated id still returns the failure once (id is not the dedupe key; fromAttemptId is)', () => {
  const attemptId = 'abcdef12-3456';
  const head = [...upTo('implement'), ev.tasksLoaded([taskCreated('F-abcdef12')]), ev.phaseCompleted('implement', 1), ...testFail(attemptId, TF)];
  const job = m2(...head);
  assert.deepEqual(routeTestFailure(job, testPhase), { attemptId, findings: TF });
  const after = m2(...head, ev.testRouted(attemptId, buildFixTask(job, attemptId, TF)), ev.phaseCompleted('implement', 2));
  assert.deepEqual(after.tasks.map((t) => [t.id, t.fromAttemptId]), [['F-abcdef12', null], ['F-abcdef12', attemptId]]);
  assert.equal(routeTestFailure(after, testPhase), null);
});

test('nextAction: test phase with a routable failure returns route-test-failure; at attemptsPerPhase consumed attempts returns stuck', () => {
  const fresh = atTest();
  assert.deepEqual(nextAction(fresh, ctx()), launchOf(fresh, 'tester', { phase: 'test', purpose: 'test' }));
  const failed = atTest(...testFail('t1', TF));
  assert.deepEqual(nextAction(failed, ctx()), { type: 'route-test-failure', attemptId: 't1', findings: TF });
  const cycle = (id, visit) => [...testFail(id, TF), ev.testRouted(id, buildFixTask(failed, id, TF)), ev.phaseCompleted('implement', visit)];
  const back = atTest(...cycle('t1', 2));
  assert.deepEqual(nextAction(back, ctx({ now: T0 + 10 * MIN })), launchOf(back, 'tester', { phase: 'test', purpose: 'test', n: 2 }));
  const capped = atTest(...cycle('t1', 2), ...cycle('t2', 3), ...testFail('t3', TF));
  const action = nextAction(capped, ctx({ now: T0 + 60 * MIN }));
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'stuck');
  assert.equal(action.detail.phase, 'test');
  assert.equal(action.detail.why, 'attempt-cap');
});

test('nextAction: routed tester failures with the same signature neither trip repeated-error nor back-off nor recovery; the cap still counts them', () => {
  const sig = 'failed|# tests failed';
  const failed = atTest(...testFail('t1', TF, sig));
  const cycle = (id, visit) => [...testFail(id, TF, sig), ev.testRouted(id, buildFixTask(failed, id, TF)), ev.phaseCompleted('implement', visit)];
  const twice = atTest(...cycle('t1', 2), ...cycle('t2', 3));
  assert.equal(twice.phaseId, 'test');
  assert.deepEqual(nextAction(twice, ctx({ now: T0 })), launchOf(twice, 'tester', { phase: 'test', purpose: 'test', n: 3 }));
  const third = atTest(...cycle('t1', 2), ...cycle('t2', 3), ...testFail('t3', TF, sig));
  const action = nextAction(third, ctx({ now: T0 + 60 * MIN }));
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'stuck');
  assert.equal(action.detail.why, 'attempt-cap');
});

test('nextAction: un-routed failed tester attempts keep Plan 2 repeated-error, back-off and recovery', () => {
  const sig = 'failed|# tests failed';
  const once = atTest(...testFail('t1', null, sig));
  assert.deepEqual(nextAction(once, ctx({ now: T0 + 1 })), { type: 'wait', until: T0 + MIN, why: 'backoff' });
  assert.deepEqual(nextAction(once, ctx({ now: T0 + MIN })), launchOf(once, 'tester', { phase: 'test', purpose: 'test', n: 2, recovery: true, previousAttemptId: 't1' }));
  const twice = atTest(...testFail('t1', null, sig), ...testFail('t2', null, sig));
  const action = nextAction(twice, ctx({ now: T0 + 60 * MIN }));
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'stuck');
  assert.equal(action.detail.why, 'repeated-error');
  assert.equal(action.detail.signature, sig);
});

test('nextAction: a task review that hits the cap with a contested blocker launches the verifier; disputed completes tagged with the task; verified needs you', () => {
  const T1 = taskCreated('T1');
  const capped = forTask('T1', [
    { purpose: 'implement' },
    trev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'fixed' }),
    trev(2, 'changes', [F('b1', 'blocker')]), fix(2, { b1: 'declined: works as intended' }, true),
  ]);
  const verifying = atImplement([T1], ...capped);
  assert.deepEqual(nextAction(verifying, ctx()), launchOf(verifying, 'verifier', { phase: 'implement', task: 'T1', purpose: 'verify', n: 6, contested: ['b1'], taskDef: T1 }));
  const disputed = atImplement([T1], ...capped, ...forTask('T1', [ver([{ id: 'b1', verified: false, evidence: 'behaves as specified' }])]));
  const done = nextAction(disputed, ctx());
  assert.equal(done.type, 'complete-phase');
  assert.equal(done.phase, 'implement');
  assert.deepEqual(done.verification, [{ id: 'b1', verified: false, evidence: 'behaves as specified', task: 'T1' }]);
  assert.deepEqual(done.unresolved, [{ ...F('b1', 'blocker'), status: 'disputed-not-verified', task: 'T1' }]);
  const confirmed = atImplement([T1], ...capped, ...forTask('T1', [{ ...ver([{ id: 'b1', verified: true, evidence: 'crashes on empty input' }]), id: 'tv1' }]));
  const asked = nextAction(confirmed, ctx());
  assert.equal(asked.type, 'needs-you');
  assert.equal(asked.reason, 'question');
  assert.equal(asked.detail.task, 'T1');
  assert.equal(asked.detail.attemptId, 'tv1');
  assert.match(asked.detail.evidence, /crashes on empty input/);
});

test('nextAction: author phases of milestone-2 launch as in Plan 2 with purpose author', () => {
  const job = m2(...upTo('plan'));
  assert.deepEqual(nextAction(job, ctx()), launchOf(job, 'planner', { phase: 'plan', purpose: 'author' }));
});

const contextOf = (job, id) => sequencer.attemptContext(job, job.attempts.find((a) => a.attemptId === id));

test('attemptContext rebuilds taskDef, contested and reviewFindings from the job', () => {
  const T1 = taskCreated('T1', { verify: 'npm test' });
  const T2 = taskCreated('T2');

  const author = m2(started('a1', 1));
  assert.deepEqual(contextOf(author, 'a1'), { purpose: 'author', round: null, final: false, task: null, taskDef: null, reviewFindings: null, contested: null });

  const implementing = atImplement([T1, T2], ...forTask('T2', [{ purpose: 'implement', outcome: null, id: 'i1' }]));
  assert.deepEqual(contextOf(implementing, 'i1'), { purpose: 'implement', round: null, final: false, task: 'T2', taskDef: T2, reviewFindings: null, contested: null });

  const reviewed = [{ purpose: 'implement' }, trev(1, 'changes', [{ ...F('m1', 'blocker'), disposition: 'open' }, F('m2')])];
  const taskFix = atImplement([T1], ...forTask('T1', [...reviewed, { purpose: 'fix', round: 1, outcome: null, id: 'tf1' }]));
  const before = atImplement([T1], ...forTask('T1', reviewed));
  assert.deepEqual(contextOf(taskFix, 'tf1'), { purpose: 'fix', round: 1, final: false, task: 'T1', taskDef: T1, reviewFindings: [F('m1', 'blocker'), F('m2')], contested: null });
  assert.deepEqual(contextOf(taskFix, 'tf1').reviewFindings, nextAction(before, ctx()).reviewFindings, 'the same findings the launch action carried');

  const phaseFix = atReview(rev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'fixed' }), rev(2, 'changes', [F('b2', 'major')]), { purpose: 'fix', round: 2, outcome: null, id: 'pf2' });
  assert.deepEqual(contextOf(phaseFix, 'pf2').reviewFindings, [F('b2', 'major')], 'the findings of the same round, not an earlier one');
  assert.equal(contextOf(phaseFix, 'pf2').taskDef, null);

  const capped = [rev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'open' }), rev(2, 'changes', [F('b1', 'blocker')]), fix(2, { b1: 'open' }), rev(3, 'changes', [F('b1', 'blocker'), F('b2', 'blocker')]), fix(3, { b1: 'declined: no', b2: 'fixed' }, true)];
  const verifying = atReview(...capped, { purpose: 'verify', outcome: null, id: 'v1' });
  assert.deepEqual(contextOf(verifying, 'v1'), { purpose: 'verify', round: null, final: false, task: null, taskDef: null, reviewFindings: null, contested: ['b1'] });
  assert.deepEqual(contextOf(verifying, 'v1').contested, nextAction(atReview(...capped), ctx()).contested);

  const taskCapped = forTask('T1', [{ purpose: 'implement' }, trev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'fixed' }), trev(2, 'changes', [F('b1', 'blocker')]), fix(2, { b1: 'declined: works as intended' }, true)]);
  const taskVerifying = atImplement([T1], ...taskCapped, ...forTask('T1', [{ purpose: 'verify', outcome: null, id: 'tv1' }]));
  assert.deepEqual(contextOf(taskVerifying, 'tv1'), { purpose: 'verify', round: null, final: false, task: 'T1', taskDef: T1, reviewFindings: null, contested: ['b1'] });

  const finalFix = atReview(rev(1, 'changes', [F('b1', 'blocker')]), { purpose: 'fix', round: 1, final: true, outcome: null, id: 'ff1' });
  assert.equal(contextOf(finalFix, 'ff1').final, true);
});

test('routeTestFailure and nextAction: a blocked tester with valid findings and no question is not routed', () => {
  const blocked = atTest(...attempt({ id: 'tb', phase: 'test', purpose: 'test', outcome: 'failed', reason: 'blocked', signature: 'blocked|server down', findings: TF }));
  assert.equal(routeTestFailure(blocked, testPhase), null);
  const action = nextAction(blocked, ctx({ now: T0 + 60 * MIN }));
  assert.notEqual(action.type, 'route-test-failure');
  assert.equal(action.type, 'launch');
  assert.equal(action.recovery, true);
});

test('buildFixTask tolerates malformed findings: a null entry or a string is ignored, never thrown on', () => {
  const job = atTest();
  const task = buildFixTask(job, 'abcdef1234', [null, 'npm test failed', { id: 'f1', severity: 'major', text: 'login fails' }]);
  assert.equal(task.acceptance, 'login fails');
  assert.deepEqual(task.repos, ['primary']);
  assert.doesNotThrow(() => buildFixTask(job, 'abcdef1234', [null]));
});

// Plan 4: route eligible failures to the router and apply its recorded decision.

const { ROUTED_REASONS } = sequencer;
const routing = (over = {}) => ctx({ now: T0 + 10 * MIN, routing: true, ...over });
const authorFail = (id, reason, over = {}) => [started(id, 1), ended(id, 'failed', { reason, signature: `${reason}|x`, at: T0, ...over })];
const decided = (forAttemptId, action, over = {}) => ({
  type: 'router-decided', forAttemptId, action, note: `${action} because`, ok: true, error: null,
  model: 'claude-haiku-5-5', request: { estimatedTokens: 900, truncated: [] }, usage: null, latencyMs: 10, ...over,
});
const routeOf = (over) => ({
  type: 'route', task: null, round: null, alternate: null, previousDir: '/d', status: null, summary: null, question: null, ...over,
});

test('route: an eligible failure with no decision returns route', () => {
  const job = build(...authorFail('a1', 'invalid-result'));
  assert.deepEqual(nextAction(job, routing()), routeOf({
    forAttemptId: 'a1', phase: 'spec', role: 'spec-writer', purpose: 'author', model: 'claude-opus-5-5', lastModel: 'claude-opus-5-5',
    reason: 'invalid-result', signature: 'invalid-result|x', attemptsUsed: 1, attemptsLeft: 2,
  }));
});

test('route: lastModel is the failed attempt\'s own model, not the role default', () => {
  const job = m2(...upTo('implement'), ev.tasksLoaded([taskCreated('T1')]),
    { type: 'attempt-started', attemptId: 'i1', phase: 'implement', task: 'T1', role: 'implementer', model: 'claude-opus-5-5', n: 1, purpose: 'implement', dir: '/d' },
    { type: 'attempt-ended', attemptId: 'i1', outcome: 'failed', reason: 'turn-cap', signature: 'turn-cap|', at: T0 });
  const action = nextAction(job, routing());
  assert.deepEqual([action.type, action.model, action.alternate, action.lastModel], ['route', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
});

test('hasAlternate is the one alternate predicate', () => {
  assert.equal(sequencer.hasAlternate('a', 'b'), true);
  for (const alt of ['a', '', null, undefined]) assert.equal(sequencer.hasAlternate('a', alt), false);
});

test('route: status is mapped from the reason', () => {
  const statusOf = (reason) => nextAction(build(...authorFail('a1', reason, { summary: `${reason} summary` })), routing());
  const blocked = statusOf('blocked');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.summary, 'blocked summary');
  assert.equal(statusOf('failed').status, 'failed');
  assert.equal(statusOf('turn-cap').status, null);
});

// atReview/atImplement turn every argument into an attempt; these append raw events after the attempts.
const reviewWith = (specs, ...events) => m2(...upTo('spec-review'), ...specs.flatMap(attempt), ...events);
const implementWith = (tasks, specs, ...events) => m2(...upTo('implement'), ev.tasksLoaded(tasks), ...specs.flatMap(attempt), ...events);
const reviewFail = (purpose, round, id, reason = 'invalid-result') => ({ purpose, round, id, outcome: 'failed', reason, signature: `${reason}|${id}` });

test('route: review scopes count failed attempts only', () => {
  const reviewer = atReview(rev(1, 'changes', [F('m1')]), fix(1, { m1: 'fixed' }), reviewFail('review', 2, 'r2'));
  assert.deepEqual(nextAction(reviewer, routing()), routeOf({
    forAttemptId: 'r2', phase: 'spec-review', role: 'spec-reviewer', purpose: 'review', round: 2, model: 'claude-opus-5-5', lastModel: 'm',
    reason: 'invalid-result', signature: 'invalid-result|r2', attemptsUsed: 1, attemptsLeft: 2,
  }));

  const fixer = nextAction(atReview(rev(1, 'changes', [F('m1')]), reviewFail('fix', 1, 'f1', 'failed')), routing());
  assert.deepEqual([fixer.type, fixer.role, fixer.purpose, fixer.round, fixer.status], ['route', 'spec-writer', 'fix', 1, 'failed']);

  const T1 = taskCreated('T1');
  const taskReviewer = nextAction(atImplement([T1], ...forTask('T1', [{ purpose: 'implement' }, reviewFail('task-review', 1, 'tr1', 'stalled')])), routing());
  assert.deepEqual(taskReviewer, routeOf({
    forAttemptId: 'tr1', phase: 'implement', task: 'T1', role: 'task-reviewer', purpose: 'task-review', round: 1, model: 'claude-sonnet-5-5', lastModel: 'm',
    reason: 'stalled', signature: 'stalled|tr1', attemptsUsed: 1, attemptsLeft: 1,
  }));

  const capped = [rev(1, 'changes', [F('b1', 'blocker')]), fix(1, { b1: 'open' }), rev(2, 'changes', [F('b1', 'blocker')]), fix(2, { b1: 'open' }), rev(3, 'changes', [F('b1', 'blocker')]), fix(3, { b1: 'declined: no' }, true)];
  const verifier = nextAction(atReview(...capped, reviewFail('verify', null, 'v1', 'no-result')), routing());
  assert.deepEqual(
    [verifier.type, verifier.role, verifier.purpose, verifier.round, verifier.alternate, verifier.attemptsUsed, verifier.attemptsLeft],
    ['route', 'verifier', 'verify', null, null, 1, 2],
  );
});

test('route: routing off keeps Plan 3 behaviour', () => {
  const job = build(...authorFail('a1', 'invalid-result'));
  assert.deepEqual(nextAction(job, routing({ routing: false })), nextAction(job, ctx({ now: T0 + 10 * MIN })));
  assert.equal(nextAction(job, routing({ routing: false })).type, 'launch');
  const reviewer = atReview(reviewFail('review', 1, 'r1'));
  assert.equal(nextAction(reviewer, routing({ routing: false })).type, 'launch');
});

test('route: launch-failed, interrupted and a routed test failure are not routed', () => {
  assert.equal(nextAction(build(...authorFail('a1', 'launch-failed')), routing()).type, 'launch');
  assert.equal(nextAction(build(started('a1', 1), ended('a1', 'interrupted', { at: T0 })), routing()).type, 'launch');
  assert.equal(nextAction(atReview(reviewFail('review', 1, 'r1', 'launch-failed')), routing()).type, 'launch');
  assert.equal(nextAction(atReview({ purpose: 'review', round: 1, outcome: 'interrupted' }), routing()).type, 'launch');
  const failed = atTest(...testFail('t1', TF));
  assert.equal(nextAction(failed, routing()).type, 'route-test-failure');
  const back = atTest(...testFail('t1', TF), ev.testRouted('t1', buildFixTask(failed, 't1', TF)), ev.phaseCompleted('implement', 2));
  const relaunch = nextAction(back, routing());
  assert.equal(relaunch.type, 'launch');
  assert.equal(relaunch.recovery, false);
});

test('route: each of the six reasons is routed', () => {
  assert.equal(ROUTED_REASONS.size, 6);
  for (const reason of ROUTED_REASONS) {
    const action = nextAction(build(...authorFail('a1', reason)), routing());
    assert.equal(action.type, 'route', reason);
    assert.equal(action.reason, reason);
  }
});

test('route: cap, repeated-error and back-off win over routing', () => {
  const capped = build(...failedAt('a1', 1, T0, 's1'), ...failedAt('a2', 2, T0, 's2'), ...failedAt('a3', 3, T0, 's3'));
  const cap = nextAction(capped, routing());
  assert.deepEqual([cap.type, cap.reason, cap.detail.why], ['needs-you', 'stuck', 'attempt-cap']);
  const repeated = nextAction(build(...failedAt('a1', 1, T0, 'same'), ...failedAt('a2', 2, T0, 'same')), routing());
  assert.deepEqual([repeated.type, repeated.reason, repeated.detail.why], ['needs-you', 'stuck', 'repeated-error']);
  assert.deepEqual(nextAction(build(...failedAt('a1', 1, T0, 's1')), routing({ now: T0 + 1 })), { type: 'wait', until: T0 + MIN, why: 'backoff' });
  const reviewCap = nextAction(atReview(reviewFail('review', 1, 'r1'), reviewFail('review', 1, 'r2'), reviewFail('review', 1, 'r3')), routing());
  assert.deepEqual([reviewCap.type, reviewCap.detail.why], ['needs-you', 'attempt-cap']);
  assert.deepEqual(nextAction(atReview(reviewFail('review', 1, 'r1')), routing({ now: T0 + 1 })), { type: 'wait', until: T0 + MIN, why: 'backoff' });
});

test('route: the per-task cap wins over routing', () => {
  assert.equal(limits.attemptsPerTask, 2);
  const T1 = taskCreated('T1');
  const job = atImplement([T1], ...forTask('T1', [
    { purpose: 'implement', id: 'i1', outcome: 'failed', reason: 'turn-cap', signature: 'turn-cap|one' },
    { purpose: 'implement', id: 'i2', outcome: 'failed', reason: 'stalled', signature: 'stalled|two' },
  ]));
  const action = nextAction(job, routing());
  assert.deepEqual([action.type, action.reason, action.detail.why, action.detail.task], ['needs-you', 'stuck', 'attempt-cap', 'T1']);
});

test('route: a review scope\'s repeated error wins over routing', () => {
  const job = atReview({ ...reviewFail('review', 1, 'r1'), signature: 'invalid-result|same' }, { ...reviewFail('review', 1, 'r2'), signature: 'invalid-result|same' });
  const action = nextAction(job, routing());
  assert.deepEqual([action.type, action.reason, action.detail.why, action.detail.phase], ['needs-you', 'stuck', 'repeated-error', 'spec-review']);
});

test('route: route is returned before the concurrency wait', () => {
  assert.equal(nextAction(build(...authorFail('a1', 'no-result')), routing({ liveSessions: 3 })).type, 'route');
  assert.equal(nextAction(atReview(reviewFail('review', 1, 'r1')), routing({ liveSessions: 3 })).type, 'route');
  const applied = build(...authorFail('a1', 'no-result'), decided('a1', 'retry'));
  assert.deepEqual(nextAction(applied, routing({ liveSessions: 3 })), { type: 'wait', until: null, why: 'concurrency' });
});

test('route: a recorded decision is applied, not re-routed', () => {
  const head = authorFail('a1', 'invalid-result', { summary: 'half done' });
  const retried = nextAction(build(...head, decided('a1', 'retry')), routing());
  assert.deepEqual(retried, {
    type: 'launch', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', effort: null, maxTurns: 60, n: 2,
    recovery: true, previousAttemptId: 'a1', ...AUTHOR_EXTRAS,
  });
  const handoff = nextAction(build(...head, decided('a1', 'retry-handoff')), routing());
  assert.equal(handoff.type, 'launch');
  assert.equal(handoff.handoff, path.join('/d', 'handoff.md'));
  assert.equal(handoff.model, 'claude-opus-5-5');

  const escalated = nextAction(build(...head, decided('a1', 'escalate', { note: 'the spec needs a human call' })), routing());
  assert.deepEqual(escalated, {
    type: 'needs-you', reason: 'stuck',
    detail: { phase: 'spec', task: null, why: 'router-escalated', lastReason: 'invalid-result', signature: 'invalid-result|x', note: 'the spec needs a human call' },
  });
  const failed = nextAction(build(...head, decided('a1', 'escalate', { ok: false, note: null, error: 'timeout: no answer in 30s' })), routing());
  assert.deepEqual(failed, {
    type: 'needs-you', reason: 'stuck',
    detail: { phase: 'spec', task: null, why: 'router-failed', lastReason: 'invalid-result', signature: 'invalid-result|x', error: 'timeout: no answer in 30s' },
  });

  const reviewer = nextAction(reviewWith([reviewFail('review', 1, 'r1')], decided('r1', 'escalate', { note: 'reviewer keeps crashing' })), routing());
  assert.deepEqual([reviewer.detail.why, reviewer.detail.phase, reviewer.detail.note], ['router-escalated', 'spec-review', 'reviewer keeps crashing']);
  const reviewRetry = nextAction(reviewWith([reviewFail('review', 1, 'r1')], decided('r1', 'retry')), routing());
  assert.deepEqual([reviewRetry.type, reviewRetry.role, reviewRetry.recovery, reviewRetry.handoff], ['launch', 'spec-reviewer', true, null]);
});

test('route: only the decision for the last attempt applies, and the first per attempt wins', () => {
  const older = build(...authorFail('a1', 'no-result'), decided('a1', 'retry'), started('a2', 2), ended('a2', 'failed', { reason: 'stalled', signature: 'stalled|y', at: T0 }));
  const action = nextAction(older, routing());
  assert.deepEqual([action.type, action.forAttemptId, action.attemptsUsed, action.attemptsLeft], ['route', 'a2', 2, 1]);
  const twice = build(...authorFail('a1', 'no-result'), decided('a1', 'retry'), decided('a1', 'escalate'));
  assert.equal(nextAction(twice, routing()).type, 'launch');
});

test('route: retry-alternate without an alternate is router-failed', () => {
  const action = nextAction(build(...authorFail('a1', 'failed'), decided('a1', 'retry-alternate')), routing());
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'stuck');
  assert.equal(action.detail.why, 'router-failed');
  assert.match(action.detail.error, /alternate/);
});

test('route: a per-task scope routes the implementer and applies retry, retry-alternate and retry-handoff', () => {
  const T1 = taskCreated('T1');
  const failedImpl = forTask('T1', [{ purpose: 'implement', id: 'i1', outcome: 'failed', reason: 'turn-cap', signature: 'turn-cap|' }]);
  const job = atImplement([T1], ...failedImpl);
  assert.deepEqual(nextAction(job, routing()), routeOf({
    forAttemptId: 'i1', phase: 'implement', task: 'T1', role: 'implementer', purpose: 'implement', model: 'claude-sonnet-5-5', alternate: 'claude-opus-5-5', lastModel: 'm',
    reason: 'turn-cap', signature: 'turn-cap|', attemptsUsed: 1, attemptsLeft: 1,
  }));
  const applied = (action) => nextAction(implementWith([T1], failedImpl, decided('i1', action)), routing());
  const base = { phase: 'implement', task: 'T1', purpose: 'implement', taskDef: T1, n: 2, recovery: true, previousAttemptId: 'i1' };
  assert.deepEqual(applied('retry'), launchOf(job, 'implementer', base));
  assert.deepEqual(applied('retry-alternate'), launchOf(job, 'implementer', { ...base, model: 'claude-opus-5-5' }));
  assert.deepEqual(applied('retry-handoff'), launchOf(job, 'implementer', { ...base, handoff: path.join('/d', 'handoff.md') }));
});

// Plan 5: the answer path, the per-scope question cap and the extra review round.

const { answerFor, answeredInScope } = sequencer;
const answered = (forAttemptId, answer = 'A') => [
  { type: 'needs-you', reason: 'question', detail: { attemptId: forAttemptId } },
  { type: 'question-answered', forAttemptId, answer },
];
const withLimits = (over, ...events) => deriveJob([...provisionedEvents({ limits: { ...limits, ...over } }), ...events].map((e, i) => ({ seq: i + 1, at: 1, ...e })));
const asked = (id, n, phase = 'spec', question = `${id}?`) => [started(id, n, { phase }), ended(id, 'question', { question, at: T0 })];

test('answerFor and answeredInScope read job.answers by attempt and scope', () => {
  const job = implementWith([taskCreated('T1'), taskCreated('T2')], [
    { phase: 'spec', purpose: 'author', id: 's1', outcome: 'question', question: 'S?' },
    { phase: 'implement', task: 'T1', purpose: 'implement', id: 'i1', outcome: 'question', question: 'I?' },
    { phase: 'implement', task: 'T2', purpose: 'implement', id: 'i2', outcome: 'question', question: 'J?' },
  ], ...answered('s1', 'Postgres'), ...answered('i1', 'yes'));
  assert.equal(answerFor(job, 's1'), 'Postgres');
  assert.equal(answerFor(job, 'i2'), null);
  assert.equal(answerFor({ answers: undefined }, 's1'), null);
  assert.equal(answeredInScope(job, 'spec'), 1);
  assert.equal(answeredInScope(job, 'implement'), 0);
  assert.equal(answeredInScope(job, 'implement', 'T1'), 1);
  assert.equal(answeredInScope(job, 'implement', 'T2'), 0);
});

test('an answered author question relaunches the phase', () => {
  const open = build(...asked('a1', 1, 'spec', 'Which DB?'));
  assert.deepEqual(nextAction(open, ctx()), { type: 'needs-you', reason: 'question', detail: { attemptId: 'a1', question: 'Which DB?' } });
  const job = build(...asked('a1', 1), ...answered('a1'));
  assert.equal(job.state, 'running');
  assert.deepEqual(nextAction(job, ctx()), {
    type: 'launch', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', effort: null, maxTurns: 60, n: 2, recovery: true, previousAttemptId: 'a1', ...AUTHOR_EXTRAS,
  });
});

test('an answered question does not consume the attempt cap', () => {
  const events = [...failedAt('a1', 1, T0, 'sig-one'), ...asked('a2', 2), ...answered('a2')];
  const action = nextAction(withLimits({ attemptsPerPhase: 2 }, ...events), ctx({ now: T0 + 60 * MIN }));
  assert.equal(action.type, 'launch');
  assert.equal(action.phase, 'spec');
  assert.equal(action.previousAttemptId, 'a2');
});

test('question cap turns the next question into stuck', () => {
  const twoAnswered = [...asked('a1', 1), ...answered('a1'), ...asked('a2', 2), ...answered('a2')];
  const capped = nextAction(withLimits({ questionsPerScope: 2 }, ...twoAnswered, ...asked('a3', 3)), ctx());
  assert.equal(capped.type, 'needs-you');
  assert.equal(capped.reason, 'stuck');
  assert.equal(capped.detail.why, 'question-cap');
  assert.equal(capped.detail.phase, 'spec');

  const { questionsPerScope, ...noCap } = limits;
  const legacy = (...events) => deriveJob([...provisionedEvents({ limits: noCap }), ...events].map((e, i) => ({ seq: i + 1, at: 1, ...e })));
  assert.equal(legacy().limits.questionsPerScope, undefined);
  assert.equal(nextAction(legacy(...twoAnswered, ...asked('a3', 3)), ctx()).reason, 'question');
  const third = [...twoAnswered, ...asked('a3', 3), ...answered('a3'), ...asked('a4', 4)];
  assert.equal(nextAction(legacy(...third), ctx()).detail.why, 'question-cap');
});

test('answered questions in other scopes do not count', () => {
  const events = [...asked('p1', 1, 'plan'), ...answered('p1'), ...asked('p2', 2, 'plan'), ...answered('p2'), ...asked('a3', 1)];
  const action = nextAction(withLimits({ questionsPerScope: 2 }, ...events), ctx());
  assert.equal(action.type, 'needs-you');
  assert.equal(action.reason, 'question');
  assert.equal(action.detail.attemptId, 'a3');
});

test('an answered reviewer question relaunches the same purpose and round', () => {
  const specs = [rev(1, 'changes', [F('m1')]), fix(1, { m1: 'fixed' }), { purpose: 'review', round: 2, outcome: 'question', question: 'Q?', id: 'q2' }];
  assert.equal(nextAction(reviewWith(specs), ctx()).reason, 'question');
  const job = reviewWith(specs, ...answered('q2'));
  assert.deepEqual(nextAction(job, ctx()), launchOf(job, 'spec-reviewer', { phase: 'spec-review', purpose: 'review', round: 2, n: 4, recovery: true, previousAttemptId: 'q2' }));
  const loop = (answers) => reviewLoop(attemptsFor(job, 'spec-review'), { ...PHASE_LOOP, answers });
  assert.equal(loop(undefined).type, 'question-open');
  assert.deepEqual(loop(new Map([['q2', 'A']])), L('review', 2, 'reviewer'));
});

// Spec-review and implement capped at one round, so the extra round is round 2.
const ONE_ROUND = MILESTONE_2_PIPELINE.map((p) => (p.phase === 'spec-review' || p.phase === 'implement' ? { ...p, maxRounds: 1 } : p));
const oneRound = (over, ...events) => deriveJob([...provisionedEvents({ pipeline: ONE_ROUND, limits: { ...limits, ...over } }), ...events].map((e, i) => ({ seq: i + 1, at: 1, ...e })));
// Raw events (with a `type`) pass through; anything else is an attempt spec.
const items = (list) => list.flatMap((x) => (x.type ? [x] : attempt(x)));
const extra = (...list) => oneRound({}, ...upTo('spec-review'), ...items(list));
const B1 = F('B1', 'blocker');
const B2 = F('B2', 'blocker');
const M1 = F('M1');
const confirms = (id, attemptId, round = null) => ({ ...ver([{ id, verified: true, evidence: `${id} reproduced` }]), id: attemptId, round });
const disputes = (id, round = null) => ({ ...ver([{ id, verified: false, evidence: `${id} is fine` }]), round });
const confirmedB1 = [rev(1, 'changes', [B1]), fix(1, { B1: 'declined: no' }, true), confirms('B1', 'v1')];
const pick = (action, ...keys) => Object.fromEntries(keys.map((k) => [k, action[k]]));

test('an answered confirmed blocker gets one extra round', () => {
  assert.equal(nextAction(extra(...confirmedB1), ctx()).reason, 'question');
  const afterAnswer = [...confirmedB1, ...answered('v1')];
  assert.deepEqual(
    pick(nextAction(extra(...afterAnswer), ctx()), 'type', 'role', 'purpose', 'round', 'final', 'reviewFindings'),
    { type: 'launch', role: 'spec-writer', purpose: 'fix', round: 2, final: true, reviewFindings: [B1] },
  );
  const fixed = [...afterAnswer, fix(2, { B1: 'fixed' }, true)];
  assert.deepEqual(pick(nextAction(extra(...fixed), ctx()), 'type', 'role', 'purpose', 'round'), { type: 'launch', role: 'spec-reviewer', purpose: 'review', round: 2 });
  assert.deepEqual(nextAction(extra(...fixed, rev(2, 'approve')), ctx()), { type: 'complete-phase', phase: 'spec-review', visit: 1, unresolved: [], verification: [] });

  const raised = [...fixed, rev(2, 'changes', [B2])];
  assert.deepEqual(
    pick(nextAction(extra(...raised), ctx()), 'type', 'role', 'purpose', 'round', 'contested'),
    { type: 'launch', role: 'verifier', purpose: 'verify', round: 2, contested: ['B2'] },
  );
  const again = nextAction(extra(...raised, confirms('B2', 'v2', 2)), ctx());
  assert.deepEqual(pick(again, 'type', 'reason'), { type: 'needs-you', reason: 'question' });
  assert.equal(again.detail.attemptId, 'v2');
  assert.match(again.detail.question, /B2 text/);
  assert.deepEqual(nextAction(extra(...raised, disputes('B2', 2)), ctx()), {
    type: 'complete-phase', phase: 'spec-review', visit: 1,
    unresolved: [{ ...B2, status: 'disputed-not-verified' }],
    verification: [{ id: 'B2', verified: false, evidence: 'B2 is fine' }],
  });

  const third = nextAction(extra(...raised, confirms('B2', 'v2', 2), ...answered('v2')), ctx());
  assert.deepEqual(pick(third, 'purpose', 'round', 'final', 'reviewFindings'), { purpose: 'fix', round: 3, final: true, reviewFindings: [B2] });
  const capped = nextAction(oneRound({ questionsPerScope: 1 }, ...upTo('spec-review'), ...items([...raised, confirms('B2', 'v2', 2)])), ctx());
  assert.deepEqual(pick(capped, 'type', 'reason'), { type: 'needs-you', reason: 'stuck' });
  assert.equal(capped.detail.why, 'question-cap');
});

test('carried minors survive the extra round', () => {
  const head = [rev(1, 'changes', [B1, M1]), fix(1, { B1: 'declined: no', M1: 'open' }, true), confirms('B1', 'v1'), ...answered('v1'), fix(2, { B1: 'fixed' }, true)];
  const approved = nextAction(extra(...head, rev(2, 'approve')), ctx());
  assert.equal(approved.type, 'complete-phase');
  assert.deepEqual(approved.unresolved, [{ ...M1, status: 'open' }]);
  const disputed = nextAction(extra(...head, rev(2, 'changes', [B2]), disputes('B2', 2)), ctx());
  assert.equal(disputed.type, 'complete-phase');
  assert.deepEqual(disputed.unresolved, [{ ...M1, status: 'open' }, { ...B2, status: 'disputed-not-verified' }]);
});

test('blockers the base verifier disputed survive the extra round', () => {
  const B3 = F('B3', 'blocker');
  const split = { ...ver([{ id: 'B1', verified: true, evidence: 'B1 reproduced' }, { id: 'B3', verified: false, evidence: 'B3 is fine' }]), id: 'v1' };
  const head = [rev(1, 'changes', [B1, B3, M1]), fix(1, { B1: 'declined: no', B3: 'declined: no', M1: 'open' }, true), split, ...answered('v1')];
  assert.deepEqual(pick(nextAction(extra(...head), ctx()), 'purpose', 'round', 'reviewFindings'), { purpose: 'fix', round: 2, reviewFindings: [B1] });
  const approved = nextAction(extra(...head, fix(2, { B1: 'fixed' }, true), rev(2, 'approve')), ctx());
  assert.equal(approved.type, 'complete-phase');
  assert.deepEqual(approved.unresolved, [{ ...B3, status: 'disputed-not-verified' }, { ...M1, status: 'open' }]);
});

test('route: attemptsUsed in an author phase excludes an answered question', () => {
  const job = build(...asked('a1', 1), ...answered('a1'), ...authorFail('a2', 'invalid-result'));
  const action = nextAction(job, routing());
  assert.equal(action.type, 'route');
  assert.equal(action.forAttemptId, 'a2');
  assert.equal(action.attemptsUsed, 1);
  assert.equal(action.attemptsLeft, 2);
});

test('the extra round in a task loop', () => {
  const T1 = taskCreated('T1');
  const task = (...list) => oneRound({}, ...upTo('implement'), ev.tasksLoaded([T1]), ...items(list.map((x) => (x.type ? x : { phase: 'implement', task: 'T1', ...x }))));
  const head = [{ purpose: 'implement' }, trev(1, 'changes', [B1]), fix(1, { B1: 'declined: no' }, true), confirms('B1', 'tv1'), ...answered('tv1')];
  assert.deepEqual(
    pick(nextAction(task(...head), ctx()), 'type', 'role', 'task', 'purpose', 'round', 'final', 'reviewFindings'),
    { type: 'launch', role: 'implementer', task: 'T1', purpose: 'fix', round: 2, final: true, reviewFindings: [B1] },
  );
  const fixed = [...head, fix(2, { B1: 'fixed' }, true)];
  assert.deepEqual(pick(nextAction(task(...fixed), ctx()), 'type', 'role', 'task', 'purpose', 'round'), { type: 'launch', role: 'task-reviewer', task: 'T1', purpose: 'task-review', round: 2 });
  assert.deepEqual(pick(nextAction(task(...fixed, trev(2, 'approve')), ctx()), 'type', 'phase', 'unresolved'), { type: 'complete-phase', phase: 'implement', unresolved: [] });
  const raised = [...fixed, trev(2, 'changes', [B2])];
  assert.deepEqual(pick(nextAction(task(...raised), ctx()), 'type', 'role', 'purpose', 'round', 'contested'), { type: 'launch', role: 'verifier', purpose: 'verify', round: 2, contested: ['B2'] });
  const again = nextAction(task(...raised, confirms('B2', 'tv2', 2)), ctx());
  assert.deepEqual(pick(again, 'type', 'reason'), { type: 'needs-you', reason: 'question' });
  assert.equal(again.detail.task, 'T1');
  assert.equal(again.detail.attemptId, 'tv2');
});

test('attemptContext rebuilds the extra-round fix', () => {
  const fixing = extra(...confirmedB1, ...answered('v1'), { purpose: 'fix', round: 2, final: true, outcome: null, id: 'xf2' });
  assert.deepEqual(contextOf(fixing, 'xf2'), { purpose: 'fix', round: 2, final: true, task: null, taskDef: null, reviewFindings: [B1], contested: null });
  const verifying = extra(...confirmedB1, ...answered('v1'), fix(2, { B1: 'fixed' }, true), rev(2, 'changes', [B2]), { purpose: 'verify', round: 2, outcome: null, id: 'xv2' });
  assert.deepEqual(contextOf(verifying, 'xv2').contested, ['B2']);
});
