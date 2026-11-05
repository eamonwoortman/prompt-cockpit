import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTER_ACTIONS, ROUTED_REASONS, ROUTER_OVERHEAD_TOKENS, NOTE_MAX_WORDS, ROUTER_SYSTEM_PROMPT,
  estimateTokens, allowedActions, buildRouterRequest, validateRouterOutput,
} from '../src/superagent/router.js';
import * as sequencer from '../src/superagent/sequencer.js';

const w = (n, p = 'w') => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');

function makeJob({ decisions = 7, noteWords = 40, phaseWords = 80 } = {}) {
  return {
    title: 'Add widgets',
    mode: 'autonomous',
    phaseIndex: 3,
    phaseId: 'plan',
    pipeline: [
      { phase: 'spec', kind: 'author' },
      { phase: 'approve', kind: 'human' },
      { phase: 'spec-review', kind: 'review' },
      { phase: 'plan', kind: 'author' },
    ],
    attempts: [
      { phase: 'spec', outcome: 'failed', summary: 'old failure' },
      { phase: 'spec', outcome: 'done', summary: w(phaseWords, 's') },
      { phase: 'spec-review', outcome: 'done', summary: 'looks fine' },
      { phase: 'plan', outcome: 'done', summary: 'current phase, never listed' },
    ],
    routerDecisions: Array.from({ length: decisions }, (_, i) => ({ action: 'retry', note: `${i} ${w(noteWords, 'n')}` })),
  };
}

const trigger = (over = {}) => ({
  attemptId: 'a1', phase: 'plan', task: null, role: 'planner', reason: 'failed', status: 'failed',
  summary: w(100, 't'), question: null, signature: 'sig', attemptsUsed: 2, attemptsLeft: 1,
  allowed: ['retry', 'escalate'], resultPath: '/tmp/result.json', ...over,
});

test('constants live in the sequencer and are re-exported', () => {
  assert.equal(ROUTER_ACTIONS, sequencer.ROUTER_ACTIONS);
  assert.equal(ROUTED_REASONS, sequencer.ROUTED_REASONS);
  assert.deepEqual(ROUTER_ACTIONS, ['retry', 'retry-alternate', 'retry-handoff', 'escalate']);
  assert.deepEqual([...ROUTED_REASONS], ['no-result', 'invalid-result', 'turn-cap', 'stalled', 'failed', 'blocked']);
});

test('allowedActions offers alternate and handoff only when available', () => {
  assert.deepEqual(allowedActions({ model: 'a', alternate: null, handoffExists: false }), ['retry', 'escalate']);
  assert.deepEqual(allowedActions({ model: 'a', alternate: 'a' }), ['retry', 'escalate']);
  assert.deepEqual(allowedActions({ model: 'a', alternate: 'b', handoffExists: true }), ROUTER_ACTIONS);
});

test('estimateTokens counts UTF-8 bytes', () => {
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('漢字漢'), 3);
  assert.equal(estimateTokens('😀'), 2);
});

test('the card carries title, mode, phase, completed phases, last 5 decisions and the trigger', () => {
  const t = trigger();
  const r = buildRouterRequest(makeJob(), t, { maxInputTokens: 100000 });
  assert.equal(r.ok, true);
  const card = JSON.parse(r.card);
  assert.deepEqual(card.job, { title: 'Add widgets', mode: 'autonomous', phase: 'plan' });
  assert.equal(card.phases.length, 2);
  assert.equal(card.phases[0], `spec: done - ${w(60, 's')}`);
  assert.equal(card.phases[1], 'spec-review: done - looks fine');
  assert.equal(card.decisions.length, 5);
  assert.ok(card.decisions[0].note.startsWith('2 '));
  assert.equal(card.decisions[0].note.split(' ').length, NOTE_MAX_WORDS);
  assert.deepEqual(card.trigger, t);
  assert.deepEqual(card.allowed, t.allowed);
  assert.equal(r.system, ROUTER_SYSTEM_PROMPT);
  assert.equal(r.estimatedTokens, ROUTER_OVERHEAD_TOKENS + estimateTokens(r.system) + estimateTokens(r.card));
  assert.deepEqual(r.truncated, []);
});

test('a job without routerDecisions builds an empty decision list', () => {
  const job = makeJob();
  delete job.routerDecisions;
  assert.deepEqual(JSON.parse(buildRouterRequest(job, trigger(), { maxInputTokens: 100000 }).card).decisions, []);
});

test('truncation drops completed-phase lines oldest first, then shortens notes, then the summary', () => {
  const job = makeJob();
  const t = trigger();
  const full = buildRouterRequest(job, t, { maxInputTokens: 100000 });

  const one = buildRouterRequest(job, t, { maxInputTokens: full.estimatedTokens - 1 });
  assert.equal(one.ok, true);
  assert.deepEqual(one.truncated, ['phases']);
  assert.deepEqual(JSON.parse(one.card).phases, ['spec-review: done - looks fine']);
  assert.ok(one.estimatedTokens <= full.estimatedTokens - 1);

  const base = buildRouterRequest({ ...job, phaseIndex: 0 }, t, { maxInputTokens: 100000 });
  const notes = buildRouterRequest(job, t, { maxInputTokens: base.estimatedTokens - 1 });
  assert.equal(notes.ok, true);
  assert.deepEqual(notes.truncated, ['phases', 'notes']);
  const nc = JSON.parse(notes.card);
  assert.deepEqual(nc.phases, []);
  assert.ok(nc.decisions.every((d) => d.note.endsWith('…') && d.note.split(' ').length === 8));
  assert.equal(nc.trigger.summary, t.summary);
  assert.ok(notes.estimatedTokens <= base.estimatedTokens - 1);

  const cut = buildRouterRequest(job, t, { maxInputTokens: notes.estimatedTokens - 1 });
  assert.equal(cut.ok, true);
  assert.deepEqual(cut.truncated, ['phases', 'notes', 'summary']);
  assert.equal(JSON.parse(cut.card).trigger.summary, `${w(20, 't')} (full result: /tmp/result.json)`);
  assert.ok(cut.estimatedTokens <= notes.estimatedTokens - 1);
});

test('over the limit after every step: no call, over-limit', () => {
  const r = buildRouterRequest(makeJob(), trigger(), { maxInputTokens: 700 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'over-limit');
  assert.ok(r.estimatedTokens > 700);
  assert.ok(r.truncated.includes('summary'));
});

test('adversarial job text stays bounded', () => {
  const job = makeJob({ phaseWords: 500 });
  job.title = 'x'.repeat(5000);
  const r = buildRouterRequest(job, trigger({ summary: '漢'.repeat(2000) }), { maxInputTokens: 6000 });
  if (r.ok) {
    assert.ok(r.estimatedTokens <= 6000);
    assert.equal(JSON.parse(r.card).job.title.length, 200);
  } else {
    assert.equal(r.error, 'over-limit');
  }
});

const limits = { allowed: ['retry', 'escalate'], maxOutputTokens: 300, outputTokens: 20 };

test('validateRouterOutput accepts exact JSON and one fenced block', () => {
  const json = '{"action":"retry","note":"x"}';
  assert.deepEqual(validateRouterOutput(json, limits), { ok: true, action: 'retry', note: 'x' });
  assert.equal(validateRouterOutput('```json\n' + json + '\n```', limits).ok, true);
});

test('validateRouterOutput rejects bad output', () => {
  const bad = (text, over = {}) => validateRouterOutput(text, { ...limits, ...over }).error;
  assert.equal(bad('not json'), 'unparseable');
  assert.equal(bad('{"action":"retry-alternate","note":"x"}'), 'action-not-allowed');
  assert.equal(bad('{"action":"retry","note":"x","extra":1}'), 'bad-shape');
  assert.equal(bad('{"action":"retry"}'), 'bad-shape');
  assert.equal(bad('{"action":"retry","note":5}'), 'bad-shape');
  assert.equal(bad(`{"action":"retry","note":"${w(31)}"}`), 'note-too-long');
  assert.equal(validateRouterOutput(`{"action":"retry","note":"${w(30)}"}`, limits).ok, true);
  const ok = '{"action":"retry","note":"x"}';
  assert.equal(bad(ok, { outputTokens: 301 }), 'over-length');
  for (const v of [undefined, NaN, Infinity]) assert.equal(bad(ok, { outputTokens: v }), 'usage-missing');
});
