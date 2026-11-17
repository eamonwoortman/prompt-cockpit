import { needsYouQuestionText } from './view-model.js';

const QUESTION_MAX_CHARS = 120;
const TYPES = new Set(['question', 'ready-to-try', 'stuck']);

function firstLine(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > QUESTION_MAX_CHARS ? `${trimmed.slice(0, QUESTION_MAX_CHARS - 1)}…` : trimmed;
}

function messageFor(job) {
  if (job.reason === 'question') return `"${job.title}" has a question: ${firstLine(needsYouQuestionText(job))}`;
  if (job.reason === 'ready-to-try') return `"${job.title}" is ready to try`;
  return `"${job.title}" is stuck: ${job.detail?.why ?? job.reason}`;
}

export function superagentNotifications(jobs) {
  return jobs
    .filter((job) => job?.state === 'needs-you' && job.title && TYPES.has(job.reason))
    .map((job) => ({
      kind: 'superagent',
      type: job.reason,
      key: `superagent:${job.jobId}:${job.needsYouSeq}`,
      jobId: job.jobId,
      title: job.title,
      message: messageFor(job),
    }));
}
