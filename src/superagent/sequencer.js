// Superagent sequencer: pure decisions over a derived JobState. No I/O, no
// timers, no clock - the caller passes `now` and live-session counts in.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, Decision 2 and
// section "Retry, stall and repetition limits". The stall deadline
// (limits.stallMinutes) is NOT enforced here: it needs the live registry row,
// so the runner owns it.
//
// Plan 3 (docs/superpowers/plans/2026-11-04-superagent-p3-pipeline.md,
// Decisions 3-8 and 10): review and per-task phases run through reviewLoop(),
// which is evaluated BEFORE any launch guard and caps only failed attempts, so
// reviewer 1 -> fix 1 -> reviewer 2 is never stopped by a count of done
// attempts. Author phases and `test` keep Plan 2's consuming-attempt cap.
//
// Plan 4 (docs/superpowers/plans/2026-11-05-superagent-p4-router.md,
// Decisions 3, 11 and 12): with ctx.routing, a retry of a router-eligible
// failure first returns a `route` action, then applies the recorded
// router-decided for that attempt. Cap, repeated-error and back-off are
// evaluated before it; concurrency after it.
import path from 'node:path';
import { STAND_IN_ROLE } from './config.js';
import { ANSWER_TAGS } from './results.js';

export const CONSUMING_OUTCOMES = new Set(['done', 'failed', 'question']);
// createJob's gate (index.js).
export const RUNNABLE_KINDS = new Set(['author', 'brainstorm', 'review', 'per-task', 'human']);
export const ROUTER_ACTIONS = ['retry', 'retry-alternate', 'retry-handoff', 'escalate'];
export const ROUTED_REASONS = new Set(['no-result', 'invalid-result', 'turn-cap', 'stalled', 'failed', 'blocked']);

// The one alternate-model predicate: the router offers retry-alternate and the
// sequencer applies it under the same rule.
export function hasAlternate(model, alternate) {
  return typeof alternate === 'string' && alternate !== '' && alternate !== model;
}

const REVIEW_PURPOSES = new Set(['review', 'task-review']);
const DEFAULT_REVIEW_ROUNDS = 3;

export function attemptsFor(job, phase, task = null) {
  return job.attempts.filter((a) => a.phase === phase && (a.task ?? null) === task);
}

export function attemptCap(limits, task) {
  return task ? limits.attemptsPerTask : limits.attemptsPerPhase;
}

export function backoffMs(limits, failedCount) {
  const steps = limits.backoffMinutes;
  return steps[Math.min(failedCount - 1, steps.length - 1)] * 60_000;
}

export function failureSignature(reason, firstLine = '') {
  const line = String(firstLine)
    .split('\n')[0]
    .toLowerCase()
    .replace(/\b0x[0-9a-f]+\b/g, '#')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${reason}|${line}`;
}

// Plan 5 (docs/superpowers/plans/2026-11-06-superagent-p5-brainstorm.md,
// Decisions 8-10): an answered question resumes the scope that asked it, and a
// scope's answered questions are capped at limits.questionsPerScope.
const answerRecord = (job, attemptId) => (job.answers ?? []).find((a) => a.forAttemptId === attemptId) ?? null;

export function answerFor(job, attemptId) {
  return answerRecord(job, attemptId)?.answer ?? null;
}

export function answeredInScope(job, phaseId, taskId = null) {
  const scope = new Set(attemptsFor(job, phaseId, taskId).map((a) => a.attemptId));
  return (job.answers ?? []).filter((a) => scope.has(a.forAttemptId)).length;
}

// Decision 9: an answered question does not consume an attempt.
const consumes = (job, a) => CONSUMING_OUTCOMES.has(a.outcome) && !(a.outcome === 'question' && answerFor(job, a.attemptId) != null);
const questionCap = (job) => job.limits.questionsPerScope ?? 3;
const answerMap = (job) => new Map((job.answers ?? []).map((a) => [a.forAttemptId, a.answer]));

const finding = ({ id, severity, text }) => ({ id, severity, text });
const loopLaunch = (purpose, round, side, over = {}) => ({ type: 'launch', purpose, round, final: false, side, reviewFindings: null, contested: null, ...over });
// Deduplicated by id, the later entry winning.
const mergeById = (...lists) => [...new Map(lists.flat().map((f) => [f.id, f])).values()];

// Decision 7: at the cap, a last-round blocker is contested unless the final
// fix lists it as fixed; contested blockers go to one verifier attempt.
function capOutcome(reviewFindings, finalFix, verify, round = null) {
  const disposition = new Map((finalFix.findings ?? []).map((f) => [f.id, f.disposition]));
  const left = reviewFindings.filter((f) => disposition.get(f.id) !== 'fixed');
  const contested = left.filter((f) => f.severity === 'blocker');
  const statusOf = (f) => (String(disposition.get(f.id) ?? '').startsWith('declined') ? 'declined' : 'open');
  const unresolved = (blockerStatus) => left.map((f) => ({ ...finding(f), status: f.severity === 'blocker' ? blockerStatus : statusOf(f) }));
  if (contested.length === 0) return { type: 'complete', unresolved: unresolved(null), verification: [] };
  if (!verify) return loopLaunch('verify', round, 'verifier', { contested: contested.map((f) => f.id) });

  const verification = (verify.verified ?? []).map(({ id, verified, evidence }) => ({ id, verified, evidence }));
  const confirmed = contested
    .map((f) => ({ f, v: verification.find((v) => v.id === f.id && v.verified === true) }))
    .filter(({ v }) => v);
  if (confirmed.length > 0) {
    return {
      type: 'question',
      attemptId: verify.attemptId,
      question: confirmed.map(({ f }) => `The verifier confirmed blocker ${f.id}: ${f.text}`).join('\n'),
      evidence: confirmed.map(({ f, v }) => `${f.id}: ${v.evidence}`).join('\n'),
      blockers: confirmed.map(({ f }) => finding(f)),
      carried: unresolved('disputed-not-verified').filter((f) => !confirmed.some((c) => c.f.id === f.id)),
    };
  }
  return { type: 'complete', unresolved: unresolved('disputed-not-verified'), verification };
}

function loopState(done, { initial, maxRounds, answers = new Map() }) {
  if (initial && !done.some((a) => a.purpose === initial)) return loopLaunch(initial, null, 'initial');
  const reviewer = initial ? 'task-review' : 'review';
  const reviews = done.filter((a) => REVIEW_PURPOSES.has(a.purpose) && a.round <= maxRounds);
  const round = reviews.length;
  if (round === 0) return maxRounds > 0 ? loopLaunch(reviewer, 1, 'reviewer') : { type: 'complete', unresolved: [], verification: [] };

  const latest = reviews[round - 1];
  if (latest.verdict === 'approve') return { type: 'complete', unresolved: [], verification: [] };
  const findings = latest.findings ?? [];
  const fix = done.find((a) => a.purpose === 'fix' && a.round === round);
  if (!fix) return loopLaunch('fix', round, 'author', { final: round >= maxRounds, reviewFindings: findings.map(finding) });
  if (round < maxRounds) return loopLaunch(reviewer, round + 1, 'reviewer');

  // Decision 10: each answered confirmed blocker earns one extra round E.
  let outcome = capOutcome(findings, fix, done.findLast((a) => a.purpose === 'verify' && a.round == null));
  let carried = [];
  for (let n = 1; outcome.type === 'question' && answers.has(outcome.attemptId); n++) {
    carried = mergeById(carried, outcome.carried);
    const E = maxRounds + n;
    const fixE = done.find((a) => a.purpose === 'fix' && a.round === E);
    if (!fixE) return loopLaunch('fix', E, 'author', { final: true, reviewFindings: outcome.blockers });
    const reviewE = done.find((a) => REVIEW_PURPOSES.has(a.purpose) && a.round === E);
    if (!reviewE) return loopLaunch(reviewer, E, 'reviewer');
    if (reviewE.verdict === 'approve') return { type: 'complete', unresolved: carried, verification: [] };
    outcome = capOutcome(reviewE.findings ?? [], { findings: [] }, done.find((a) => a.purpose === 'verify' && a.round === E), E);
  }
  if (outcome.type === 'complete') return { ...outcome, unresolved: mergeById(carried, outcome.unresolved) };
  return outcome;
}

// `attempts` are one scope's (a review phase's, or one task's) in order.
// `initial: 'implement'` requires a done implementer attempt before the first
// review; `maxRounds: 0` means no reviewer at all (a task without taskReview).
// Only failed attempts count toward `failedCap`; repeated-error and back-off
// are the caller's (Plan 2 rules applied per scope). `answers` (attemptId ->
// answer) reopens a scope whose question was answered.
export function reviewLoop(attempts, { initial, maxRounds, failedCap, answers = new Map() }) {
  if (attempts.some((a) => !a.outcome)) return { type: 'pending' };
  const last = attempts[attempts.length - 1];
  if (last?.outcome === 'question' && !answers.has(last.attemptId)) return { type: 'question-open', attemptId: last.attemptId, question: last.question };
  const state = loopState(attempts.filter((a) => a.outcome === 'done'), { initial, maxRounds, answers });
  if (state.type !== 'launch') return state;
  if (attempts.filter((a) => a.outcome === 'failed').length >= failedCap) return { type: 'stuck', why: 'attempt-cap' };
  return state;
}

const perTaskPhase = (job) => job.pipeline.find((p) => p.kind === 'per-task') ?? null;

function taskLoopOptions(job, phase) {
  return {
    initial: 'implement',
    maxRounds: phase?.taskReview ? (phase.maxRounds ?? job.limits.taskReviewRounds) : 0,
    failedCap: attemptCap(job.limits, true),
    answers: answerMap(job),
  };
}

function taskLoop(job, phase, task) {
  return reviewLoop(attemptsFor(job, phase?.phase, task.id), taskLoopOptions(job, phase));
}

export function taskStatus(job, task, phase = perTaskPhase(job)) {
  return taskLoop(job, phase, task).type === 'complete' ? 'done' : 'open';
}

export function pickTask(job) {
  const tasks = job.tasks ?? [];
  const phase = perTaskPhase(job);
  const done = new Set(tasks.filter((t) => taskStatus(job, t, phase) === 'done').map((t) => t.id));
  const open = tasks.filter((t) => !done.has(t.id));
  if (open.length === 0) return null;
  return open.find((t) => (t.dependsOn ?? []).every((id) => done.has(id))) ?? { blocked: true };
}

// Decision 10: the last test attempt failed with findings and no task was
// routed from it yet. Dedupe is by fromAttemptId, never by task id. A blocked
// tester (reason 'blocked') ran no real test, so its findings are not routed.
export function routeTestFailure(job, phase) {
  if (!job.pipeline.some((p) => p.phase === 'implement')) return null;
  const attempts = attemptsFor(job, phase.phase);
  const last = attempts[attempts.length - 1];
  if (last?.outcome !== 'failed' || last.reason !== 'failed') return null;
  if (!Array.isArray(last.findings) || last.findings.length === 0) return null;
  if ((job.tasks ?? []).some((t) => t.fromAttemptId === last.attemptId)) return null;
  return { attemptId: last.attemptId, findings: last.findings };
}

// Non-object findings are ignored, not thrown on: a throw here would repeat
// on every tick for a bad stored event.
export function buildFixTask(job, attemptId, rawFindings) {
  const findings = rawFindings.filter((f) => f !== null && typeof f === 'object' && !Array.isArray(f));
  const known = new Set(job.repos.map((r) => r.id));
  const repos = [...new Set(findings.map((f) => f.repo).filter((repo) => known.has(repo)))];
  const short = attemptId.slice(0, 8);
  return {
    id: `F-${short}`,
    title: `Fix test failures from attempt ${short}`,
    repos: repos.length > 0 ? repos : ['primary'],
    dependsOn: [],
    acceptance: findings.map((f) => f.text).filter((text) => typeof text === 'string').join('\n'),
    verify: '',
    origin: 'test',
    fromAttemptId: attemptId,
  };
}

function launch(job, { phase, task = null, role, attempts, recovery, previousAttemptId, purpose, round = null, final = false, taskDef = null, reviewFindings = null, contested = null, model: modelOverride = null, handoff = null, openQuestions = null, askedIds = null }) {
  const model = job.models[role];
  return {
    type: 'launch',
    phase: phase.phase,
    task,
    role,
    model: modelOverride ?? model.model,
    effort: model.effort ?? null,
    maxTurns: model.maxTurns,
    n: attempts.filter((a) => CONSUMING_OUTCOMES.has(a.outcome)).length + 1,
    recovery,
    previousAttemptId,
    purpose,
    round,
    final,
    taskDef,
    reviewFindings,
    contested,
    handoff,
    openQuestions,
    askedIds,
  };
}

const stuckAction = (phase, task, why, last, extra = {}) => ({
  type: 'needs-you',
  reason: 'stuck',
  detail: { phase: phase.phase, task, why, lastReason: last?.reason ?? null, signature: last?.signature ?? null, ...extra },
});

// Plan 2's repeated-error and back-off rules over one scope's attempts.
function retryGuard(attempts, limits, now, onStuck) {
  const used = attempts.filter((a) => CONSUMING_OUTCOMES.has(a.outcome));
  const window = used.slice(-limits.repeatedErrorStop);
  if (
    window.length === limits.repeatedErrorStop &&
    window.every((a) => a.outcome === 'failed' && a.signature != null && a.signature === window[0].signature)
  ) {
    return onStuck('repeated-error');
  }
  const last = attempts[attempts.length - 1];
  if (last?.outcome === 'failed') {
    const failedCount = used.filter((a) => a.outcome === 'failed').length;
    const until = last.endedAt + backoffMs(limits, failedCount);
    if (now < until) return { type: 'wait', until, why: 'backoff' };
  }
  return null;
}

const TRIGGER_STATUS = { blocked: 'blocked', failed: 'failed' };

// Returns null (plain launch), a `route` action, a stuck action, or launch-arg
// overrides ({ model } or { handoff }) from the recorded decision.
function routeOrApply(job, ctx, { last, role, launchArgs, stuck }) {
  if (!ctx.routing || last?.outcome !== 'failed' || !ROUTED_REASONS.has(last.reason)) return null;
  const { model, alternate = null } = job.models[role];
  const decision = (job.routerDecisions ?? []).find((d) => d.forAttemptId === last.attemptId);
  if (!decision) {
    const { phase, task, attempts, purpose, round } = launchArgs;
    const byFailed = phase.kind !== 'author';
    const used = attempts.filter((a) => (byFailed ? a.outcome === 'failed' : consumes(job, a))).length;
    return {
      type: 'route',
      forAttemptId: last.attemptId,
      phase: phase.phase,
      task,
      role,
      purpose,
      round,
      model,
      alternate,
      lastModel: last.model,
      previousDir: last.dir,
      reason: last.reason,
      status: TRIGGER_STATUS[last.reason] ?? null,
      summary: last.summary,
      question: last.question,
      signature: last.signature,
      attemptsUsed: used,
      attemptsLeft: attemptCap(job.limits, task) - used,
    };
  }
  const failed = (error) => stuck('router-failed', { error });
  if (!decision.ok) return failed(decision.error);
  switch (decision.action) {
    case 'escalate': return stuck('router-escalated', { note: decision.note });
    case 'retry': return null;
    case 'retry-alternate':
      if (!hasAlternate(model, alternate)) return failed(`retry-alternate: role ${role} has no alternate model`);
      return { model: alternate };
    case 'retry-handoff':
      if (typeof last.dir !== 'string') return failed(`retry-handoff: attempt ${last.attemptId} has no directory`);
      return { handoff: path.join(last.dir, 'handoff.md') };
    default: return failed(`unknown router action ${JSON.stringify(decision.action)}`);
  }
}

function authorAction(job, phase, ctx) {
  const { now, liveSessions, maxConcurrentSessions } = ctx;
  const attempts = attemptsFor(job, phase.phase);
  if (attempts.some((a) => !a.outcome)) return { type: 'none' };

  const last = attempts[attempts.length - 1];
  const limits = job.limits;
  const stuck = (why, extra) => stuckAction(phase, null, why, last, extra);
  if (last?.outcome === 'question' && answerFor(job, last.attemptId) == null) {
    if (answeredInScope(job, phase.phase) >= questionCap(job)) return stuck('question-cap');
    return { type: 'needs-you', reason: 'question', detail: { attemptId: last.attemptId, question: last.question } };
  }

  const used = attempts.filter((a) => consumes(job, a));
  if (used.length >= attemptCap(limits, null)) return stuck('attempt-cap');

  const isTest = phase.phase === 'test';
  if (isTest) {
    const route = routeTestFailure(job, phase);
    if (route) return { type: 'route-test-failure', ...route };
  }

  // A routed tester failure was handed to a fix task, not left for a retry:
  // it still counts toward the cap above, but not toward repeated-error,
  // back-off or recovery.
  const routed = new Set(isTest ? (job.tasks ?? []).map((t) => t.fromAttemptId).filter(Boolean) : []);
  const guard = retryGuard(attempts.filter((a) => !routed.has(a.attemptId)), limits, now, stuck);
  if (guard) return guard;

  const retry = last != null && !routed.has(last.attemptId);
  const launchArgs = {
    phase,
    task: null,
    role: phase.role,
    attempts,
    recovery: retry,
    previousAttemptId: retry ? last.attemptId : null,
    purpose: isTest ? 'test' : 'author',
    round: null,
  };
  const override = retry ? routeOrApply(job, ctx, { last, role: phase.role, launchArgs, stuck }) : null;
  if (override?.type) return override;

  if (liveSessions >= maxConcurrentSessions) return { type: 'wait', until: null, why: 'concurrency' };
  return launch(job, { ...launchArgs, ...override });
}

// Guard order for one review scope (a review phase, or one task): in-flight,
// loop state, failed-attempt cap, repeated error, back-off, routing, concurrency.
function scopeAction(job, phase, ctx, { attempts, loop, task, roles, onComplete }) {
  const { now, liveSessions, maxConcurrentSessions } = ctx;
  if (loop.type === 'pending') return { type: 'none' };
  if (loop.type === 'complete') return onComplete(loop);
  const last = attempts[attempts.length - 1];
  const stuck = (why, extra) => stuckAction(phase, task?.id ?? null, why, last, extra);
  if (loop.type === 'question' || loop.type === 'question-open') {
    if (answeredInScope(job, phase.phase, task?.id ?? null) >= questionCap(job)) return stuck('question-cap');
    return {
      type: 'needs-you',
      reason: 'question',
      detail: { attemptId: loop.attemptId, question: loop.question, evidence: loop.evidence ?? null, phase: phase.phase, task: task?.id ?? null },
    };
  }
  if (loop.type === 'stuck') return stuck(loop.why);

  // Repeated-error reads Plan 2's consecutive window over the scope's consuming attempts.
  const guard = retryGuard(attempts, job.limits, now, stuck);
  if (guard) return guard;

  const role = roles[loop.side];
  const recovery = last != null && last.outcome !== 'done';
  const launchArgs = {
    phase,
    task: task?.id ?? null,
    role,
    attempts,
    recovery,
    previousAttemptId: recovery ? last.attemptId : null,
    purpose: loop.purpose,
    round: loop.round,
    final: loop.final,
    taskDef: task ?? null,
    reviewFindings: loop.reviewFindings,
    contested: loop.contested,
  };
  const override = recovery ? routeOrApply(job, ctx, { last, role, launchArgs, stuck }) : null;
  if (override?.type) return override;

  if (liveSessions >= maxConcurrentSessions) return { type: 'wait', until: null, why: 'concurrency' };
  return launch(job, { ...launchArgs, ...override });
}

const completePhase = (job, phase, unresolved, verification) => ({
  type: 'complete-phase',
  phase: phase.phase,
  visit: job.visits[phase.phase] ?? 1,
  unresolved,
  verification,
});

function reviewLoopOptions(job, phase) {
  return { initial: null, maxRounds: phase.maxRounds ?? DEFAULT_REVIEW_ROUNDS, failedCap: attemptCap(job.limits, null), answers: answerMap(job) };
}

function reviewAction(job, phase, ctx) {
  const attempts = attemptsFor(job, phase.phase);
  const loop = reviewLoop(attempts, reviewLoopOptions(job, phase));
  return scopeAction(job, phase, ctx, {
    attempts,
    loop,
    task: null,
    roles: { reviewer: phase.role, author: phase.author, verifier: 'verifier' },
    onComplete: ({ unresolved, verification }) => completePhase(job, phase, unresolved, verification),
  });
}

function perTaskAction(job, phase, ctx) {
  if (job.tasks === null) return { type: 'load-tasks' };
  if (job.attempts.some((a) => a.phase === phase.phase && !a.outcome)) return { type: 'none' };

  const loops = job.tasks.map((task) => ({ task, loop: taskLoop(job, phase, task) }));
  if (loops.every(({ loop }) => loop.type === 'complete')) {
    const tag = (key) => loops.flatMap(({ task, loop }) => loop[key].map((entry) => ({ ...entry, task: task.id })));
    return completePhase(job, phase, tag('unresolved'), tag('verification'));
  }

  const picked = pickTask(job);
  if (!picked || picked.blocked) return stuckAction(phase, null, 'tasks-blocked', null);
  return scopeAction(job, phase, ctx, {
    attempts: attemptsFor(job, phase.phase, picked.id),
    loop: loops.find(({ task }) => task === picked).loop,
    task: picked,
    roles: { initial: phase.role, author: phase.role, reviewer: phase.taskReview, verifier: 'verifier' },
    onComplete: () => ({ type: 'none' }),
  });
}

// Decisions 5 and 14: every brainstorm question in the order asked, settled by
// the stand-in's answers or, for an escalated one, by the user's.
function exchangesOf(job, attempts) {
  const entries = new Map();
  const settle = (id, fields) => {
    const entry = entries.get(id);
    if (entry && entry.tag === null) Object.assign(entry, fields);
  };
  for (const a of attempts) {
    if (a.purpose === 'ask' && a.outcome === 'done') {
      for (const q of a.questions ?? []) {
        entries.set(q.id, { id: q.id, text: q.text, askedBy: a.attemptId, askedSession: a.sessionId ?? null, answer: null, tag: null, reason: null, answeredBy: null, answeredSession: null, at: null });
      }
    } else if (a.purpose === 'answer' && (a.outcome === 'done' || a.outcome === 'question')) {
      for (const x of a.answers ?? []) {
        settle(x.id, { answer: x.answer, tag: x.tag, reason: x.reason, answeredBy: a.attemptId, answeredSession: a.sessionId ?? null, at: a.endedAt });
      }
      const user = a.escalated == null ? null : answerRecord(job, a.attemptId);
      if (user) settle(a.escalated, { answer: user.answer, tag: 'from-you', reason: null, answeredBy: a.attemptId, answeredSession: null, at: user.at });
    }
  }
  return [...entries.values()];
}

export function brainstormLog(job) {
  const phase = job.pipeline.find((p) => p.kind === 'brainstorm');
  return phase ? exchangesOf(job, attemptsFor(job, phase.phase)) : [];
}

// The latest done ask's questions the log has not settled yet.
function openQuestionsOf(log, attempts) {
  const ask = attempts.findLast((a) => a.purpose === 'ask' && a.outcome === 'done');
  return log.filter((e) => ask && e.askedBy === ask.attemptId && e.tag === null).map(({ id, text }) => ({ id, text }));
}

// Decision 1: open questions go to the stand-in as one batch; otherwise the
// brainstormer asks, on a final turn once the exchange or token cap is reached.
function brainstormTurn(job, phase, attempts) {
  const log = exchangesOf(job, attempts);
  const open = openQuestionsOf(log, attempts);
  if (open.length > 0) return { role: STAND_IN_ROLE, purpose: 'answer', final: false, openQuestions: open, askedIds: null };
  const { brainstormExchanges, brainstormTokens } = job.limits;
  const exchanges = log.filter((e) => ANSWER_TAGS.includes(e.tag)).length;
  const tokens = attempts.reduce((sum, a) => sum + (a.tokens ?? 0), 0);
  const final = exchanges >= brainstormExchanges || (brainstormTokens != null && tokens >= brainstormTokens);
  return { role: phase.role, purpose: 'ask', final, openQuestions: null, askedIds: log.map((e) => e.id) };
}

// Guard order mirrors scopeAction: in-flight, open escalation (question cap
// first), failed-attempt cap, repeated error, back-off, routing, concurrency.
function brainstormAction(job, phase, ctx) {
  const { now, liveSessions, maxConcurrentSessions } = ctx;
  const attempts = attemptsFor(job, phase.phase);
  if (attempts.some((a) => !a.outcome)) return { type: 'none' };

  const last = attempts[attempts.length - 1];
  const stuck = (why, extra) => stuckAction(phase, null, why, last, extra);
  if (last?.outcome === 'question' && answerFor(job, last.attemptId) == null) {
    if (answeredInScope(job, phase.phase) >= questionCap(job)) return stuck('question-cap');
    const entry = exchangesOf(job, attempts).find((e) => e.id === last.escalated) ?? null;
    return {
      type: 'needs-you',
      reason: 'question',
      detail: {
        kind: 'stand-in',
        attemptId: last.attemptId,
        question: last.question,
        brainstormQuestion: entry && { id: entry.id, text: entry.text },
        reason: last.summary,
        record: { jobId: job.jobId, questionId: last.escalated, askedBy: entry?.askedBy ?? null, attemptId: last.attemptId },
        phase: phase.phase,
        task: null,
      },
    };
  }

  if (attempts.filter((a) => a.outcome === 'failed').length >= attemptCap(job.limits, null)) return stuck('attempt-cap');
  const guard = retryGuard(attempts, job.limits, now, stuck);
  if (guard) return guard;

  // A settled turn (done, or an answered escalation) is not retried: the other side runs next.
  const recovery = last != null && last.outcome !== 'done' && last.outcome !== 'question';
  const { role, ...turn } = brainstormTurn(job, phase, attempts);
  const launchArgs = { phase, task: null, role, attempts, recovery, previousAttemptId: recovery ? last.attemptId : null, round: null, ...turn };
  const override = recovery ? routeOrApply(job, ctx, { last, role, launchArgs, stuck }) : null;
  if (override?.type) return override;

  if (liveSessions >= maxConcurrentSessions) return { type: 'wait', until: null, why: 'concurrency' };
  return launch(job, { ...launchArgs, ...override });
}

// The launch action's attempt context, rebuilt from the derived job for an
// attempt that has no live record (reconcile), so its result is validated by
// the same rules as a live finish. Only attempts before it in its scope count,
// as when the sequencer created the launch.
export function attemptContext(job, attempt) {
  const purpose = attempt.purpose ?? 'author';
  const task = attempt.task ?? null;
  const round = attempt.round ?? null;
  const at = job.attempts.findIndex((a) => a.attemptId === attempt.attemptId);
  const before = (at < 0 ? job.attempts : job.attempts.slice(0, at))
    .filter((a) => a.phase === attempt.phase && (a.task ?? null) === task);
  const done = before.filter((a) => a.outcome === 'done');
  const phase = job.pipeline.find((p) => p.phase === attempt.phase);

  const state = () => loopState(done, phase.kind === 'per-task' ? taskLoopOptions(job, phase) : reviewLoopOptions(job, phase));
  let reviewFindings = null;
  if (purpose === 'fix') {
    const review = done.findLast((a) => REVIEW_PURPOSES.has(a.purpose) && a.round === round);
    if (review) reviewFindings = (review.findings ?? []).map(finding);
    else if (phase) {
      // An extra-round fix (Decision 10) runs before its round's review.
      const launched = state();
      if (launched.type === 'launch' && launched.purpose === 'fix') reviewFindings = launched.reviewFindings;
    }
  }
  let contested = null;
  if (purpose === 'verify' && phase) {
    const launched = state();
    if (launched.type === 'launch' && launched.purpose === 'verify') contested = launched.contested;
  }
  let openQuestions = null;
  let askedIds = null;
  if (purpose === 'ask' || purpose === 'answer') {
    const log = exchangesOf(job, before);
    if (purpose === 'answer') openQuestions = openQuestionsOf(log, before);
    else askedIds = log.map((e) => e.id);
  }
  return {
    purpose,
    round,
    final: attempt.final ?? false,
    task,
    taskDef: task == null ? null : ((job.tasks ?? []).find((t) => t.id === task) ?? null),
    reviewFindings,
    contested,
    openQuestions,
    askedIds,
  };
}

export function nextAction(job, ctx) {
  if (job.state !== 'running') return { type: 'none' };
  const phase = job.pipeline[job.phaseIndex];
  if (!phase) return { type: 'none' };
  if (phase.kind === 'human') return { type: 'needs-you', reason: 'ready-to-try', detail: { phase: phase.phase } };
  if (phase.kind === 'review') return reviewAction(job, phase, ctx);
  if (phase.kind === 'per-task') return perTaskAction(job, phase, ctx);
  if (phase.kind === 'brainstorm') return brainstormAction(job, phase, ctx);
  return authorAction(job, phase, ctx);
}
