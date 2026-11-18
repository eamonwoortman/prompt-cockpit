import { needsYouQuestionText, needsYouType } from './view-model.js';

const QUESTION_MAX_CHARS = 120;

function firstLine(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > QUESTION_MAX_CHARS ? `${trimmed.slice(0, QUESTION_MAX_CHARS - 1)}…` : trimmed;
}

function messageFor(job) {
  if (job.reason === 'question') return `"${job.title}" has a question: ${firstLine(needsYouQuestionText(job))}`;
  if (job.reason === 'ready-to-try') return `"${job.title}" is ready to try`;
  if (job.reason === 'folder-changed') return `"${job.title}" is paused: ${job.detail?.text ?? ''}`;
  return `"${job.title}" is stuck: ${job.detail?.why ?? job.reason}`;
}

export function superagentNotifications(jobs) {
  return jobs
    .filter((job) => job?.title && needsYouType(job) !== null)
    .map((job) => ({
      kind: 'superagent',
      type: needsYouType(job),
      key: `superagent:${job.jobId}:${job.needsYouSeq}`,
      jobId: job.jobId,
      title: job.title,
      message: messageFor(job),
    }));
}
