// Superagent sequencer: pure decisions over a derived JobState. No I/O, no
// timers, no clock - the caller passes `now` and live-session counts in.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, Decision 2 and
// section "Retry, stall and repetition limits". The stall deadline
// (limits.stallMinutes) is NOT enforced here: it needs the live registry row,
// so the runner owns it.

export const CONSUMING_OUTCOMES = new Set(['done', 'failed', 'question']);
export const RUNNABLE_KINDS = new Set(['author', 'human']);

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

export function nextAction(job, { now, liveSessions, maxConcurrentSessions }) {
  if (job.state !== 'running') return { type: 'none' };
  const phase = job.pipeline[job.phaseIndex];
  if (!phase) return { type: 'none' };
  if (phase.kind === 'human') return { type: 'needs-you', reason: 'ready-to-try', detail: { phase: phase.phase } };

  const attempts = attemptsFor(job, phase.phase);
  if (attempts.some((a) => !a.outcome)) return { type: 'none' };

  const last = attempts[attempts.length - 1];
  if (last?.outcome === 'question') {
    return { type: 'needs-you', reason: 'question', detail: { attemptId: last.attemptId, question: last.question } };
  }

  const limits = job.limits;
  const used = attempts.filter((a) => CONSUMING_OUTCOMES.has(a.outcome));
  const stuck = (why) => ({
    type: 'needs-you',
    reason: 'stuck',
    detail: { phase: phase.phase, task: null, why, lastReason: last?.reason ?? null, signature: last?.signature ?? null },
  });
  if (used.length >= attemptCap(limits, null)) return stuck('attempt-cap');

  const window = used.slice(-limits.repeatedErrorStop);
  if (
    window.length === limits.repeatedErrorStop &&
    window.every((a) => a.outcome === 'failed' && a.signature != null && a.signature === window[0].signature)
  ) {
    return stuck('repeated-error');
  }

  if (last?.outcome === 'failed') {
    const failedCount = used.filter((a) => a.outcome === 'failed').length;
    const until = last.endedAt + backoffMs(limits, failedCount);
    if (now < until) return { type: 'wait', until, why: 'backoff' };
  }

  if (liveSessions >= maxConcurrentSessions) return { type: 'wait', until: null, why: 'concurrency' };

  const model = job.models[phase.role];
  return {
    type: 'launch',
    phase: phase.phase,
    task: null,
    role: phase.role,
    model: model.model,
    effort: model.effort ?? null,
    maxTurns: model.maxTurns,
    n: used.length + 1,
    recovery: last != null,
    previousAttemptId: last?.attemptId ?? null,
  };
}
