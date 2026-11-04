import test from 'node:test';
import assert from 'node:assert/strict';
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
const AUTHOR_EXTRAS = { purpose: 'author', round: null, final: false, taskDef: null, reviewFindings: null, contested: null };

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
  n: 1, recovery: false, previousAttemptId: null, round: null, final: false, taskDef: null, reviewFindings: null, contested: null, ...over,
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
