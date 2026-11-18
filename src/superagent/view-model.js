import { attemptCap, gatedOut, taskStatus } from './sequencer.js';
import { PHASE_ATTEMPT_KINDS, TASK_ATTEMPT_KINDS, artifactPaths, reviewPaths } from './results.js';

const CORRUPT_TITLE = 'corrupt event log';
const isCorrupt = (job) => job?.reason === 'corrupt-events' && !job.pipeline;

function statusOf(job) {
  if (job.state === 'needs-you' || job.state === 'done' || job.state === 'stopped' || job.state === 'failed' || job.state === 'provisioning') return job.state;
  return 'running';
}

const NEEDS_YOU_TYPES = new Set(['question', 'ready-to-try', 'stuck']);

// Plan 7 Decision 5: a folder-changed pause is shown as stuck.
export function needsYouType(job) {
  if (job?.state !== 'needs-you') return null;
  const type = job.reason === 'folder-changed' ? 'stuck' : job.reason;
  return NEEDS_YOU_TYPES.has(type) ? type : null;
}

const workflowView = (job) => (job.workflow ? { id: job.workflow.id, name: job.workflow.name } : null);

export function jobSummary(job) {
  const needsYou = needsYouType(job);
  return {
    jobId: job.jobId,
    title: isCorrupt(job) ? CORRUPT_TITLE : (job.title ?? job.jobId),
    state: job.state,
    reason: job.reason ?? null,
    phaseId: job.phaseId ?? null,
    status: statusOf(job),
    needsYou,
    workflow: workflowView(job),
    createdAt: job.createdAt ?? null,
  };
}

export function needsYouQuestionText(job) {
  const d = job.detail ?? {};
  return String(d.question ?? d.text ?? '');
}

function phaseChips(job) {
  const index = job.phaseIndex ?? 0;
  return (job.pipeline ?? []).map((p, i) => {
    let status = 'todo';
    if (job.state === 'done' || i < index) status = 'done';
    else if (i === index && job.state === 'running') status = 'running';
    else if (i === index && job.state === 'needs-you') status = 'waiting';
    return { phase: p.phase, kind: p.kind, status };
  });
}

function attemptKey(a) {
  const { phase, task, round, purpose } = a;
  const suffix = Number.isInteger(round) ? `:${round}` : '';
  if (task != null) {
    if (purpose === 'implement' || purpose === 'fix') return `report:${task}`;
    if (purpose === 'task-review' && suffix) return `taskReview:${task}${suffix}`;
    if (purpose === 'verify') return `taskVerify:${task}${suffix}`;
    return null;
  }
  if (purpose === 'review' && suffix) return `review:${phase}${suffix}`;
  if (purpose === 'fix' && suffix) return `response:${phase}${suffix}`;
  if (purpose === 'verify') return `verify:${phase}${suffix}`;
  return null;
}

export function artifactKeys(job) {
  if (isCorrupt(job)) return [];
  const known = Object.keys(artifactPaths(job));
  const keys = new Set();
  for (const p of job.pipeline ?? []) {
    if (!(job.attempts ?? []).some((a) => a.phase === p.phase && !gatedOut(a))) continue;
    for (const k of [...(p.outputs ?? []), ...(p.inputs ?? [])]) if (k === 'brief' && known.includes(k)) keys.add(k);
    for (const k of p.outputs ?? []) if (known.includes(k)) keys.add(k);
  }
  for (const a of job.attempts ?? []) {
    const key = attemptKey(a);
    if (key) keys.add(key);
  }
  return [...keys];
}

const ROUND = /^[1-9]\d{0,5}$/;

export function artifactPath(job, key) {
  if (isCorrupt(job) || typeof key !== 'string') return null;
  const paths = artifactPaths(job);
  if (Object.hasOwn(paths, key)) return paths[key];
  const [kind, id, round, ...rest] = key.split(':');
  if (rest.length || !id) return null;
  if (round !== undefined && !ROUND.test(round)) return null;
  const n = round === undefined ? null : Number(round);
  const phaseKind = PHASE_ATTEMPT_KINDS.includes(kind);
  const taskKind = TASK_ATTEMPT_KINDS.includes(kind);
  if (!phaseKind && !taskKind) return null;
  if (['review', 'response', 'taskReview'].includes(kind) && n === null) return null;
  if (['report'].includes(kind) && n !== null) return null;
  if (phaseKind && !(job.pipeline ?? []).some((p) => p.phase === id)) return null;
  try {
    const paths = reviewPaths(job, phaseKind ? { phase: id, round: n } : { taskId: id, round: n });
    return paths[kind] ?? null;
  } catch {
    return null;
  }
}

function routerView(job) {
  const decisions = job.routerDecisions ?? [];
  return {
    model: job.models?.router?.model ?? null,
    allowlist: job.router?.allowlist ?? [],
    maxInputTokens: job.router?.maxInputTokens ?? null,
    calls: decisions.length,
    lastRequestTokens: decisions.at(-1)?.request?.estimatedTokens ?? null,
    decisions: decisions.map((d) => ({ forAttemptId: d.forAttemptId, action: d.action, note: d.note, ok: d.ok, error: d.error, at: d.at })),
  };
}

function needsYouView(job) {
  if (job.state !== 'needs-you') return null;
  const d = job.detail ?? null;
  let text = null;
  if (job.reason === 'question') text = needsYouQuestionText(job);
  else if (job.reason === 'folder-changed') text = String(d?.text ?? '');
  return {
    type: job.reason === 'folder-changed' ? 'stuck' : job.reason,
    reason: job.reason,
    key: `superagent:${job.jobId}:${job.needsYouSeq}`,
    seq: job.needsYouSeq,
    text,
    detail: d,
    answerable: job.reason === 'question' && d?.kind !== 'budget',
  };
}

function readyInputs(job) {
  const last = (job.pipeline ?? []).findLast((p) => p.kind === 'human');
  return [...(last?.inputs ?? [])];
}

export function jobDetail(job, { isLive = () => false } = {}) {
  const summary = jobSummary(job);
  if (isCorrupt(job)) {
    return { ...summary, idea: null, branch: null, repos: [], readyInputs: [], phases: [], tasks: null, attempts: [], artifacts: [], router: routerView(job), needsYou: null };
  }
  const limits = job.limits ?? {};
  return {
    ...summary,
    idea: job.idea ?? null,
    branch: job.branch ?? null,
    repos: (job.repos ?? []).map((r) => ({ id: r.id, origin: r.origin, worktree: r.worktree ?? null, inPlace: r.inPlace === true })),
    readyInputs: readyInputs(job),
    phases: phaseChips(job),
    tasks: job.tasks == null ? null : job.tasks.map((t) => ({ id: t.id, title: t.title ?? t.id, done: taskStatus(job, t) === 'done' })),
    attempts: (job.attempts ?? []).map((a) => ({
      attemptId: a.attemptId,
      phase: a.phase,
      task: a.task ?? null,
      role: a.role,
      model: a.model,
      n: a.n,
      cap: attemptCap(limits, a.task),
      round: a.round ?? null,
      purpose: a.purpose,
      outcome: a.outcome ?? null,
      pausedBeforeLaunch: gatedOut(a),
      live: a.outcome == null && a.sessionId != null && isLive(a.sessionId) === true,
      sessionId: a.sessionId ?? null,
    })),
    artifacts: artifactKeys(job).map((key) => ({ key, label: key })),
    router: routerView(job),
    needsYou: needsYouView(job),
  };
}
