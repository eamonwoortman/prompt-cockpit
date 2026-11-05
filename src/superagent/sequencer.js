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

export const CONSUMING_OUTCOMES = new Set(['done', 'failed', 'question']);
// createJob's gate (index.js).
export const RUNNABLE_KINDS = new Set(['author', 'review', 'per-task', 'human']);
export const ROUTER_ACTIONS = ['retry', 'retry-alternate', 'retry-handoff', 'escalate'];
export const ROUTED_REASONS = new Set(['no-result', 'invalid-result', 'turn-cap', 'stalled', 'failed', 'blocked']);

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

const finding = ({ id, severity, text }) => ({ id, severity, text });
const loopLaunch = (purpose, round, side, over = {}) => ({ type: 'launch', purpose, round, final: false, side, reviewFindings: null, contested: null, ...over });

// Decision 7: at the cap, a last-round blocker is contested unless the final
// fix lists it as fixed; contested blockers go to one verifier attempt.
function capOutcome(reviewFindings, finalFix, verify) {
  const disposition = new Map((finalFix.findings ?? []).map((f) => [f.id, f.disposition]));
  const left = reviewFindings.filter((f) => disposition.get(f.id) !== 'fixed');
  const contested = left.filter((f) => f.severity === 'blocker');
  const statusOf = (f) => (String(disposition.get(f.id) ?? '').startsWith('declined') ? 'declined' : 'open');
  const unresolved = (blockerStatus) => left.map((f) => ({ ...finding(f), status: f.severity === 'blocker' ? blockerStatus : statusOf(f) }));
  if (contested.length === 0) return { type: 'complete', unresolved: unresolved(null), verification: [] };
  if (!verify) return loopLaunch('verify', null, 'verifier', { contested: contested.map((f) => f.id) });

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
    };
  }
  return { type: 'complete', unresolved: unresolved('disputed-not-verified'), verification };
}

function loopState(done, { initial, maxRounds }) {
  if (initial && !done.some((a) => a.purpose === initial)) return loopLaunch(initial, null, 'initial');
  const reviewer = initial ? 'task-review' : 'review';
  const reviews = done.filter((a) => REVIEW_PURPOSES.has(a.purpose));
  const round = reviews.length;
  if (round === 0) return maxRounds > 0 ? loopLaunch(reviewer, 1, 'reviewer') : { type: 'complete', unresolved: [], verification: [] };

  const latest = reviews[round - 1];
  if (latest.verdict === 'approve') return { type: 'complete', unresolved: [], verification: [] };
  const findings = latest.findings ?? [];
  const fix = done.find((a) => a.purpose === 'fix' && a.round === round);
  if (!fix) return loopLaunch('fix', round, 'author', { final: round >= maxRounds, reviewFindings: findings.map(finding) });
  if (round < maxRounds) return loopLaunch(reviewer, round + 1, 'reviewer');
  return capOutcome(findings, fix, done.findLast((a) => a.purpose === 'verify'));
}

// `attempts` are one scope's (a review phase's, or one task's) in order.
// `initial: 'implement'` requires a done implementer attempt before the first
// review; `maxRounds: 0` means no reviewer at all (a task without taskReview).
// Only failed attempts count toward `failedCap`; repeated-error and back-off
// are the caller's (Plan 2 rules applied per scope).
export function reviewLoop(attempts, { initial, maxRounds, failedCap }) {
  if (attempts.some((a) => !a.outcome)) return { type: 'pending' };
  const last = attempts[attempts.length - 1];
  if (last?.outcome === 'question') return { type: 'question-open', attemptId: last.attemptId, question: last.question };
  const state = loopState(attempts.filter((a) => a.outcome === 'done'), { initial, maxRounds });
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

function launch(job, { phase, task = null, role, attempts, recovery, previousAttemptId, purpose, round = null, final = false, taskDef = null, reviewFindings = null, contested = null }) {
  const model = job.models[role];
  return {
    type: 'launch',
    phase: phase.phase,
    task,
    role,
    model: model.model,
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
  };
}

const stuckAction = (phase, task, why, last) => ({
  type: 'needs-you',
  reason: 'stuck',
  detail: { phase: phase.phase, task, why, lastReason: last?.reason ?? null, signature: last?.signature ?? null },
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

function authorAction(job, phase, { now, liveSessions, maxConcurrentSessions }) {
  const attempts = attemptsFor(job, phase.phase);
  if (attempts.some((a) => !a.outcome)) return { type: 'none' };

  const last = attempts[attempts.length - 1];
  if (last?.outcome === 'question') {
    return { type: 'needs-you', reason: 'question', detail: { attemptId: last.attemptId, question: last.question } };
  }

  const limits = job.limits;
  const stuck = (why) => stuckAction(phase, null, why, last);
  const used = attempts.filter((a) => CONSUMING_OUTCOMES.has(a.outcome));
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

  if (liveSessions >= maxConcurrentSessions) return { type: 'wait', until: null, why: 'concurrency' };

  const retry = last != null && !routed.has(last.attemptId);
  return launch(job, {
    phase,
    role: phase.role,
    attempts,
    recovery: retry,
    previousAttemptId: retry ? last.attemptId : null,
    purpose: isTest ? 'test' : 'author',
  });
}

// Guard order for one review scope (a review phase, or one task): in-flight,
// loop state, failed-attempt cap, repeated error, back-off, concurrency.
function scopeAction(job, phase, { now, liveSessions, maxConcurrentSessions }, { attempts, loop, task, roles, onComplete }) {
  if (loop.type === 'pending') return { type: 'none' };
  if (loop.type === 'complete') return onComplete(loop);
  if (loop.type === 'question' || loop.type === 'question-open') {
    return {
      type: 'needs-you',
      reason: 'question',
      detail: { attemptId: loop.attemptId, question: loop.question, evidence: loop.evidence ?? null, phase: phase.phase, task: task?.id ?? null },
    };
  }
  const last = attempts[attempts.length - 1];
  const stuck = (why) => stuckAction(phase, task?.id ?? null, why, last);
  if (loop.type === 'stuck') return stuck(loop.why);

  // Repeated-error reads Plan 2's consecutive window over the scope's consuming attempts.
  const guard = retryGuard(attempts, job.limits, now, stuck);
  if (guard) return guard;

  if (liveSessions >= maxConcurrentSessions) return { type: 'wait', until: null, why: 'concurrency' };

  const recovery = last != null && last.outcome !== 'done';
  return launch(job, {
    phase,
    task: task?.id ?? null,
    role: roles[loop.side],
    attempts,
    recovery,
    previousAttemptId: recovery ? last.attemptId : null,
    purpose: loop.purpose,
    round: loop.round,
    final: loop.final,
    taskDef: task ?? null,
    reviewFindings: loop.reviewFindings,
    contested: loop.contested,
  });
}

const completePhase = (job, phase, unresolved, verification) => ({
  type: 'complete-phase',
  phase: phase.phase,
  visit: job.visits[phase.phase] ?? 1,
  unresolved,
  verification,
});

function reviewLoopOptions(job, phase) {
  return { initial: null, maxRounds: phase.maxRounds ?? DEFAULT_REVIEW_ROUNDS, failedCap: attemptCap(job.limits, null) };
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

// The launch action's attempt context, rebuilt from the derived job for an
// attempt that has no live record (reconcile), so its result is validated by
// the same rules as a live finish. Only attempts before it in its scope count,
// as when the sequencer created the launch.
export function attemptContext(job, attempt) {
  const purpose = attempt.purpose ?? 'author';
  const task = attempt.task ?? null;
  const round = attempt.round ?? null;
  const at = job.attempts.findIndex((a) => a.attemptId === attempt.attemptId);
  const done = (at < 0 ? job.attempts : job.attempts.slice(0, at))
    .filter((a) => a.phase === attempt.phase && (a.task ?? null) === task && a.outcome === 'done');
  const phase = job.pipeline.find((p) => p.phase === attempt.phase);

  let reviewFindings = null;
  if (purpose === 'fix') {
    const review = done.findLast((a) => REVIEW_PURPOSES.has(a.purpose) && a.round === round);
    if (review) reviewFindings = (review.findings ?? []).map(finding);
  }
  let contested = null;
  if (purpose === 'verify' && phase) {
    const state = loopState(done, phase.kind === 'per-task' ? taskLoopOptions(job, phase) : reviewLoopOptions(job, phase));
    if (state.type === 'launch' && state.purpose === 'verify') contested = state.contested;
  }
  return {
    purpose,
    round,
    final: attempt.final ?? false,
    task,
    taskDef: task == null ? null : ((job.tasks ?? []).find((t) => t.id === task) ?? null),
    reviewFindings,
    contested,
  };
}

export function nextAction(job, ctx) {
  if (job.state !== 'running') return { type: 'none' };
  const phase = job.pipeline[job.phaseIndex];
  if (!phase) return { type: 'none' };
  if (phase.kind === 'human') return { type: 'needs-you', reason: 'ready-to-try', detail: { phase: phase.phase } };
  if (phase.kind === 'review') return reviewAction(job, phase, ctx);
  if (phase.kind === 'per-task') return perTaskAction(job, phase, ctx);
  return authorAction(job, phase, ctx);
}
