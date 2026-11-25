// Give feedback: which workflows support it, and where a round's files live.
// Everything here is pure; the store, sequencer and supervisor call it.
import path from 'node:path';
import { artifactPaths, ledgerArtifactRoot } from './results.js';

const NONE = Object.freeze({ taskWriting: -1, planReview: -1, perTask: -1, test: -1, human: -1 });

// The layout a round re-enters: task-writing phase, its optional plan review,
// the per-task phase, the test phase and the final human phase, back to back.
// Takes anything with a `pipeline` (a derived job or { pipeline }).
export function feedbackShape(job) {
  const pipeline = job?.pipeline ?? [];
  const writers = pipeline.flatMap((p, i) => (p.kind === 'author' && (p.outputs ?? []).includes('tasks') ? [i] : []));
  if (writers.length !== 1) return null;
  const [taskWriting] = writers;
  const writer = pipeline[taskWriting];
  const after = pipeline[taskWriting + 1];
  const hasReview = after?.kind === 'review';
  if (hasReview && !(after.author === writer.role && (writer.outputs ?? []).includes(after.target))) return null;
  const perTask = taskWriting + (hasReview ? 2 : 1);
  const test = perTask + 1;
  const human = test + 1;
  if (pipeline[perTask]?.kind !== 'per-task' || pipeline.filter((p) => p.kind === 'per-task').length !== 1) return null;
  if (pipeline[test]?.kind !== 'author' || pipeline[test].test !== true || pipeline.filter((p) => p.kind === 'author' && p.test === true).length !== 1) return null;
  if (pipeline[human]?.kind !== 'human' || human !== pipeline.length - 1) return null;
  return {
    taskWriting: writer,
    planReview: hasReview ? after : null,
    perTask: pipeline[perTask],
    test: pipeline[test],
    human: pipeline[human],
    requirementKeys: (pipeline[test].inputs ?? []).filter((key) => key !== 'tasks'),
    indexes: { taskWriting, planReview: hasReview ? taskWriting + 1 : -1, perTask, test, human },
  };
}

export function feedbackIndexes(job) {
  return feedbackShape(job)?.indexes ?? NONE;
}

function relativeToRoot(job, value) {
  const prefix = `${ledgerArtifactRoot(job.jobId)}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function feedbackEligibility(job) {
  if (job.state !== 'needs-you' || job.reason !== 'ready-to-try') return { ok: false, why: 'not-ready' };
  if (job.artifactRoot !== 'ledger') return { ok: false, why: 'legacy-artifacts' };
  const shape = feedbackShape(job);
  if (!shape) return { ok: false, why: 'workflow-shape' };
  const inUse = Object.values(artifactPaths(job)).some((value) => {
    const rel = relativeToRoot(job, String(value)).replaceAll('\\', '/').toLowerCase();
    return rel === 'feedback' || rel.startsWith('feedback/');
  });
  if (inUse) return { ok: false, why: 'feedback-path-in-use' };
  const keys = (shape.taskWriting.outputs ?? []).map((key) => key.toLowerCase());
  if (new Set(keys).size !== keys.length) return { ok: false, why: 'output-keys-clash' };
  return { ok: true };
}

export const currentRound = (job) => job.feedbackRound ?? 0;
export const roundOf = (attempt) => attempt.feedbackRound ?? 0;

export function isRoundScoped(job, phaseId) {
  const shape = feedbackShape(job);
  if (!shape) return false;
  return [shape.taskWriting, shape.planReview, shape.test, shape.human].some((p) => p?.phase === phaseId);
}

export const roundDir = (job, round) => `${ledgerArtifactRoot(job.jobId)}/feedback/round-${round}`;

const extensionOf = (job, key) => {
  const value = artifactPaths(job)[key];
  if (!value) throw new Error(`superagent: unknown output ${JSON.stringify(key)}`);
  return path.posix.extname(value);
};

export function roundOutputPaths(job, round, keys) {
  return Object.fromEntries(keys.map((key) => [key, `${roundDir(job, round)}/outputs/${key}${extensionOf(job, key)}`]));
}

export function roundTestReportPaths(job, round, reportOrdinal) {
  const keys = feedbackShape(job)?.test.outputs ?? [];
  return Object.fromEntries(keys.map((key) => [key, `${roundDir(job, round)}/tests/${key}-${reportOrdinal}${extensionOf(job, key)}`]));
}

export const roundTriagePath = (job, round) => `${roundDir(job, round)}/triage.md`;

export const roundKey = (round, key) => `feedback:${round}:${key}`;

export function parseRoundKey(key) {
  const m = /^feedback:(\d+):(.+)$/.exec(String(key));
  return m ? { round: Number(m[1]), key: m[2] } : null;
}

export function roundRoute(job, round) {
  return (job.feedbackRounds ?? []).find((r) => r.round === round)?.route ?? null;
}
