import { attemptCap, gatedOut, retriedAway, taskStatus } from './sequencer.js';
import { PHASE_ATTEMPT_KINDS, TASK_ATTEMPT_KINDS, artifactPaths, reviewPaths } from './results.js';
import { suggestBranch } from './branch-name.js';
import { currentRound, feedbackEligibility, feedbackShape, parseRoundKey, roundKey, roundOf, roundOutputPaths, roundTestReportPaths, roundTriagePath } from './feedback.js';

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

function plainAttemptKey(a) {
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

// A feedback round's phase-level review, response and verify files sit under
// the round prefix; its per-task files keep their task-scoped keys.
function attemptKey(a) {
  const key = plainAttemptKey(a);
  return key && a.task == null && roundOf(a) > 0 ? roundKey(roundOf(a), key) : key;
}

export function artifactKeys(job) {
  if (isCorrupt(job)) return [];
  const known = Object.keys(artifactPaths(job));
  const keys = new Set();
  // An attempt the in-place gate ended never launched, so it wrote nothing.
  const launched = (job.attempts ?? []).filter((a) => !gatedOut(a));
  for (const p of job.pipeline ?? []) {
    if (!launched.some((a) => a.phase === p.phase)) continue;
    for (const k of [...(p.outputs ?? []), ...(p.inputs ?? [])]) if (k === 'brief' && known.includes(k)) keys.add(k);
    for (const k of p.outputs ?? []) if (known.includes(k)) keys.add(k);
  }
  const knownSet = new Set(known);
  for (const a of launched) {
    const key = attemptKey(a);
    if (key) keys.add(key);
    if (roundOf(a) > 0 && a.task == null) for (const k of keysWritten(job, a, knownSet)) keys.add(k);
  }
  for (const alias of roundTestAliases(job, launched).keys()) keys.add(alias);
  return [...keys];
}

const AUTHORING_PURPOSES = new Set(['author', 'ask', 'test']);

// A feedback round attempt writes round keys (feedback:<N>:...); see Global
// Constraints for the forms.
function roundKeysWritten(job, a, phase, known) {
  const round = roundOf(a);
  if (a.purpose === 'triage') return [roundKey(round, 'triage')];
  const outs = (list) => list.filter((k) => known.has(k)).map((k) => roundKey(round, `out:${k}`));
  if (a.purpose === 'feedback-plan') return outs(phase?.outputs ?? []);
  if (a.purpose === 'test') {
    return Number.isInteger(a.reportOrdinal) ? (phase?.outputs ?? []).filter((k) => known.has(k)).map((k) => roundKey(round, `test:${k}:${a.reportOrdinal}`)) : [];
  }
  const keys = [attemptKey(a)].filter(Boolean);
  if (a.purpose === 'fix' && phase?.target) {
    const author = job.pipeline.find((p) => p.kind === 'author' && (p.outputs ?? []).includes(phase.target));
    keys.push(...outs(author?.outputs ?? []));
  }
  return keys;
}

// feedback:<N>:test:<key> -> the latest done round tester of round N.
function roundTestAliases(job, launched) {
  const aliases = new Map();
  const known = new Set(Object.keys(artifactPaths(job)));
  for (const a of launched) {
    if (a.purpose !== 'test' || roundOf(a) === 0 || a.outcome !== 'done') continue;
    const phase = (job.pipeline ?? []).find((p) => p.phase === a.phase);
    for (const k of phase?.outputs ?? []) if (known.has(k)) aliases.set(roundKey(roundOf(a), `test:${k}`), a);
  }
  return aliases;
}

// The keys an attempt writes (results.js requiredOutputs): its phase outputs
// when authoring, else its own review/response/report/verify file, plus, for a
// review phase's fix round, the reviewed author's outputs it revises
// (reviseOutputs).
function keysWritten(job, a, known) {
  if (a.purpose === 'answer') return [];
  const phase = (job.pipeline ?? []).find((p) => p.phase === a.phase);
  if (roundOf(a) > 0 && a.task == null) return roundKeysWritten(job, a, phase, known);
  if (AUTHORING_PURPOSES.has(a.purpose)) return (phase?.outputs ?? []).filter((k) => known.has(k));
  const keys = [attemptKey(a)].filter(Boolean);
  if (a.purpose === 'fix' && a.task == null && phase?.target) {
    const author = job.pipeline.find((p) => p.kind === 'author' && (p.outputs ?? []).includes(phase.target));
    keys.push(...(author?.outputs ?? []).filter((k) => known.has(k)));
  }
  return keys;
}

// key -> the latest launched (not gated) attempt that writes it.
export function artifactWriters(job) {
  const writers = new Map();
  if (isCorrupt(job) || !job.pipeline) return writers;
  const known = new Set(Object.keys(artifactPaths(job)));
  const launched = (job.attempts ?? []).filter((a) => !gatedOut(a));
  const writer = (a) => ({ attemptId: a.attemptId, phase: a.phase, task: a.task ?? null });
  for (const a of launched) for (const key of keysWritten(job, a, known)) writers.set(key, writer(a));
  for (const [alias, a] of roundTestAliases(job, launched)) writers.set(alias, writer(a));
  // artifactKeys also lists a brief that only a later phase reads.
  if (!writers.has('brief') && artifactKeys(job).includes('brief')) {
    const brainstorms = new Set(job.pipeline.filter((p) => p.kind === 'brainstorm').map((p) => p.phase));
    const latest = launched.findLast((a) => brainstorms.has(a.phase) && a.purpose !== 'answer');
    if (latest) writers.set('brief', writer(latest));
  }
  return writers;
}

// Only a writer that ended 'done' claimed to write the key; one that failed,
// stopped or asked a question without the file leaves it pending, not deleted.
export function writerEnded(job, writer) {
  return Boolean(writer && (job.attempts ?? []).find((a) => a.attemptId === writer.attemptId)?.outcome === 'done');
}

export function artifactWriterEnded(job, key) {
  return writerEnded(job, artifactWriters(job).get(key));
}

const ROUND = /^[1-9]\d{0,5}$/;

export function artifactPath(job, key) {
  if (isCorrupt(job) || typeof key !== 'string') return null;
  const paths = artifactPaths(job);
  if (Object.hasOwn(paths, key)) return paths[key];
  const parsed = parseRoundKey(key);
  return parsed ? roundArtifactPath(job, parsed) : reviewKeyPath(job, key, 0);
}

function roundArtifactPath(job, { round, key }) {
  if (!ROUND.test(String(round)) || round > currentRound(job)) return null;
  const shape = feedbackShape(job);
  if (!shape) return null;
  const [kind, ...rest] = key.split(':');
  try {
    if (kind === 'triage') return rest.length === 0 ? roundTriagePath(job, round) : null;
    if (kind === 'out') return rest.length === 1 && (shape.taskWriting.outputs ?? []).includes(rest[0]) ? roundOutputPaths(job, round, [rest[0]])[rest[0]] : null;
    if (kind === 'test') return roundTestPath(job, shape, round, rest);
    if (kind === 'review' || kind === 'response' || kind === 'verify') return reviewKeyPath(job, key, round);
  } catch {
    return null;
  }
  return null;
}

function roundTestPath(job, shape, round, [id, ordinal, ...more]) {
  if (more.length || !(shape.test.outputs ?? []).includes(id)) return null;
  if (ordinal === undefined) {
    const latest = (job.attempts ?? []).findLast((a) => a.purpose === 'test' && roundOf(a) === round && a.outcome === 'done' && !gatedOut(a) && Number.isInteger(a.reportOrdinal));
    return latest ? roundTestReportPaths(job, round, latest.reportOrdinal)[id] : null;
  }
  return ROUND.test(ordinal) ? roundTestReportPaths(job, round, Number(ordinal))[id] : null;
}

function reviewKeyPath(job, key, feedbackRound) {
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
  if (feedbackRound > 0 && !phaseKind) return null;
  try {
    const paths = reviewPaths(job, phaseKind ? { phase: id, round: n, feedbackRound } : { taskId: id, round: n });
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
    decisions: decisions.map((d) => ({
      forAttemptId: d.forAttemptId,
      action: d.action,
      note: d.note,
      ok: d.ok,
      error: d.error,
      at: d.at,
      model: d.model ?? null,
      cost: typeof d.usage?.costUsd === 'number' ? { usd: d.usage.costUsd, complete: true } : { usd: null, complete: false },
    })),
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
    retryable: job.reason === 'stuck',
  };
}

// After a feedback round the links name that round's files: its triage, then
// each input the latest round that rewrote it (the latest done tester's
// report, a sub-plan's outputs) has in place of the original, so a round that
// wrote neither (separate) keeps the earlier round's.
function readyInputs(job) {
  const last = (job.pipeline ?? []).findLast((p) => p.kind === 'human');
  const inputs = [...(last?.inputs ?? [])];
  const round = currentRound(job);
  if (round === 0) return inputs;
  const writers = artifactWriters(job);
  const latest = (key) => {
    for (let r = round; r > 0; r--) {
      const found = [`test:${key}`, `out:${key}`].map((k) => roundKey(r, k)).find((k) => writers.has(k));
      if (found) return found;
    }
    return key;
  };
  const swapped = inputs.map(latest);
  const triage = roundKey(round, 'triage');
  return writers.has(triage) ? [triage, ...swapped] : swapped;
}

function feedbackRoundsView(job) {
  return (job.feedbackRounds ?? []).map((entry) => {
    const triage = (job.attempts ?? []).find((a) => a.attemptId === entry.attemptId)?.triage ?? null;
    return {
      round: entry.round,
      text: entry.text,
      route: entry.route ?? null,
      summary: triage?.summary ?? null,
      requirementChanges: triage?.requirementChanges ?? [],
      idea: triage?.idea ?? null,
      at: entry.at ?? null,
    };
  });
}

// usd is null when no part of it was priced; complete is false when anything
// inside is unknown or unpriced.
const money = (usd, complete) => ({ usd, complete });

function sumMoney(list) {
  const priced = list.filter((m) => m.usd !== null);
  return money(priced.length ? priced.reduce((sum, m) => sum + m.usd, 0) : null, list.every((m) => m.complete));
}

function attemptCost(usage) {
  if (!usage || usage.state === 'unknown') return money(null, false);
  const priced = Object.values(usage.byModel ?? {}).some((m) => m.costUsd !== null);
  const nothingToPrice = usage.complete && (usage.unpricedModels ?? []).length === 0;
  return money(priced || nothingToPrice ? usage.knownCostUsd : null, usage.complete === true);
}

function group(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function spendView(job, costed) {
  const ran = costed.filter(({ attempt }) => !gatedOut(attempt));
  const attemptMoney = ({ cost }) => cost;
  const workers = sumMoney(ran.map(attemptMoney));
  const decisions = job.routerDecisions ?? [];
  const routerRows = [...group(decisions, (d) => d.model ?? 'unknown')].map(([model, ds]) => {
    const costs = ds.map((d) => (typeof d.usage?.costUsd === 'number' ? money(d.usage.costUsd, true) : money(null, false)));
    const tokens = ds.reduce((sum, d) => sum + (d.usage?.totalInputTokens ?? 0) + (d.usage?.outputTokens ?? 0), 0);
    return { model, source: 'router', tokens, ...sumMoney(costs) };
  });
  const router = sumMoney(routerRows.map(({ usd, complete }) => money(usd, complete)));
  const models = new Map();
  for (const { usage } of ran) {
    if (!usage || usage.state === 'unknown') continue;
    for (const [model, m] of Object.entries(usage.byModel ?? {})) {
      if (!models.has(model)) models.set(model, { costs: [], tokens: 0 });
      const entry = models.get(model);
      entry.costs.push(money(m.costUsd, m.costUsd !== null));
      entry.tokens += m.tokens ?? 0;
    }
  }
  const workerRows = [...models].map(([model, { costs, tokens }]) => ({ model, source: 'worker', tokens, ...sumMoney(costs) }));
  const total = sumMoney([workers, router]);
  return {
    total,
    workers,
    router,
    byPhase: [...group(ran, ({ attempt }) => `${attempt.phase}|${attempt.task ?? ''}`).values()].map((rows) => ({
      phase: rows[0].attempt.phase,
      task: rows[0].attempt.task ?? null,
      attempts: rows.length,
      ...sumMoney(rows.map(attemptMoney)),
    })),
    byTask: [...group(ran.filter(({ attempt }) => attempt.task != null), ({ attempt }) => attempt.task).entries()].map(([task, rows]) => ({ task, ...sumMoney(rows.map(attemptMoney)) })),
    byModel: [...workerRows, ...routerRows],
    complete: total.complete,
  };
}

const usageShape = (usage) => (usage && usage.state !== 'unknown'
  ? { state: usage.state, knownCostUsd: usage.knownCostUsd, tokens: usage.tokens, byModel: usage.byModel, unpricedModels: usage.unpricedModels, complete: usage.complete }
  : null);

export function jobDetail(job, { isLive = () => false, usageFor = () => null, transcriptFor = () => null, artifactStates = null } = {}) {
  const summary = jobSummary(job);
  if (isCorrupt(job)) {
    return { ...summary, idea: null, branch: null, repos: [], readyInputs: [], phases: [], tasks: null, attempts: [], artifacts: [], spend: spendView(job, []), router: routerView(job), needsYou: null, feedbackRounds: [], canGiveFeedback: false };
  }
  const limits = job.limits ?? {};
  const writers = artifactWriters(job);
  const costed = (job.attempts ?? []).map((attempt) => {
    const usage = gatedOut(attempt) ? null : usageFor(attempt);
    return { attempt, usage, cost: gatedOut(attempt) ? money(null, true) : attemptCost(usage) };
  });
  return {
    ...summary,
    idea: job.idea ?? null,
    branch: job.branch ?? null,
    finalBranch: job.finalBranch ?? null,
    branchSuggestion: job.reason === 'ready-to-try' ? suggestBranch(job) : null,
    repos: (job.repos ?? []).map((r) => ({ id: r.id, origin: r.origin, worktree: r.worktree ?? null, inPlace: r.inPlace === true })),
    readyInputs: readyInputs(job),
    phases: phaseChips(job),
    tasks: job.tasks == null ? null : job.tasks.map((t) => ({ id: t.id, title: t.title ?? t.id, done: taskStatus(job, t) === 'done' })),
    attempts: costed.map(({ attempt: a, usage, cost }) => ({
      attemptId: a.attemptId,
      phase: a.phase,
      task: a.task ?? null,
      role: a.role,
      model: a.model,
      n: a.n,
      cap: attemptCap(limits, a.task),
      round: a.round ?? null,
      feedbackRound: roundOf(a),
      purpose: a.purpose,
      outcome: a.outcome ?? null,
      pausedBeforeLaunch: gatedOut(a),
      retried: retriedAway(a),
      live: a.outcome == null && a.sessionId != null && isLive(a.sessionId) === true,
      sessionId: a.sessionId ?? null,
      startedAt: a.startedAt ?? null,
      endedAt: a.endedAt ?? null,
      durationMs: a.startedAt != null && a.endedAt != null ? a.endedAt - a.startedAt : null,
      summary: a.summary ?? null,
      reason: a.reason ?? null,
      verdict: a.verdict ?? null,
      findingsCount: Array.isArray(a.findings) ? a.findings.length : null,
      question: a.question ?? null,
      commits: (a.commits ?? []).length,
      usage: usageShape(usage),
      usageNote: gatedOut(a) || usageShape(usage) ? null : (usage?.note ?? 'unavailable'),
      cost,
      transcript: { available: transcriptFor(a)?.available === true },
    })),
    artifacts: artifactKeys(job).map((key) => ({
      key,
      label: key,
      phase: writers.get(key)?.phase ?? null,
      task: writers.get(key)?.task ?? null,
      state: artifactStates?.get(key) ?? null,
    })),
    spend: spendView(job, costed),
    router: routerView(job),
    needsYou: needsYouView(job),
    feedbackRounds: feedbackRoundsView(job),
    canGiveFeedback: feedbackEligibility(job).ok,
  };
}
