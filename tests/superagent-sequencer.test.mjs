import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveJob } from '../src/superagent/store.js';
import { outcomeForResult } from '../src/superagent/results.js';
import { attemptCap, attemptsFor, backoffMs, failureSignature, nextAction } from '../src/superagent/sequencer.js';
import { jobCreated, provisionedEvents } from './superagent-helpers.mjs';

const T0 = 1_000_000;
const ctx = (over = {}) => ({ now: T0, liveSessions: 0, maxConcurrentSessions: 3, ...over });
const limits = jobCreated().limits;

const started = (id, n, over = {}) => ({ type: 'attempt-started', attemptId: id, phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', n, recovery: n > 1, previousAttemptId: n > 1 ? `a${n - 1}` : null, dir: '/d', ...over });
const ended = (id, outcome, over = {}) => ({ type: 'attempt-ended', attemptId: id, outcome, ...over });
const build = (...events) => deriveJob([...provisionedEvents(), ...events].map((e, i) => ({ seq: i + 1, at: 1, ...e })));
const failedAt = (id, n, at, signature) => [started(id, n), ended(id, 'failed', { reason: 'no-result', signature, at })];

test('a fresh job launches attempt 1 of its first phase without a recovery note', () => {
  assert.deepEqual(nextAction(build(), ctx()), {
    type: 'launch', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', effort: null, maxTurns: 60, n: 1, recovery: false, previousAttemptId: null,
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
      type: 'launch', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', effort: null, maxTurns: 60, n: 1, recovery: true, previousAttemptId: 'a1',
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
