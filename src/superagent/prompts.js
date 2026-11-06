import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactPaths, reviewPaths, requiredOutputs, reviseOutputs as reviseSet } from './results.js';

export const UNATTENDED_DENY_MESSAGE = 'You are running unattended. Put your question in `result.json` with `status: blocked`.';
export const RECOVERY_NOTE = 'check every worktree\'s git status and log, and the ledger, before repeating work; continue from `handoff.md` if present';
// Read-only roles cannot write result.json; they reply with it instead.
export const READ_ONLY_ROLES = new Set(['stand-in']);
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const BRAINSTORMER_DENY_MESSAGE = 'You are running unattended. Put your questions in result.json\'s `questions` list; the stand-in answers them.';

export function denyMessageFor(role) {
  return role === 'brainstormer' ? BRAINSTORMER_DENY_MESSAGE : UNATTENDED_DENY_MESSAGE;
}

const CONTRACT_FILE = 'contract.md';
const REVIEW_PURPOSES = new Set(['review', 'task-review']);
const WORK_PURPOSES = new Set(['implement', 'fix']);
const TARGET_PURPOSES = new Set(['review', 'fix', 'verify']);

export function templatesDir() {
  return fileURLToPath(new URL('../../prompts/superagent/', import.meta.url));
}

function overrideDir(projectDir) {
  return path.join(projectDir, '.superpowers', 'superagent', 'prompts');
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function roleFile(role) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(role ?? '')) throw Object.assign(new Error(`superagent: invalid role name ${JSON.stringify(role)}`), { code: 'ERR_NO_TEMPLATE' });
  return `${role}.md`;
}

async function loadRoleTemplate(role, projectDir) {
  const file = roleFile(role);
  if (file === CONTRACT_FILE) throw Object.assign(new Error('superagent: contract is not a role'), { code: 'ERR_NO_TEMPLATE' });
  return (await readIfExists(path.join(overrideDir(projectDir), file))) ?? (await readIfExists(path.join(templatesDir(), file)));
}

export async function hasTemplate(role, { projectDir }) {
  try {
    return (await loadRoleTemplate(role, projectDir)) != null;
  } catch (err) {
    if (err.code === 'ERR_NO_TEMPLATE') return false;
    throw err;
  }
}

function keyedOutputs(job, phase, purpose, round, task) {
  const list = requiredOutputs(job, { phase, purpose, round, task });
  if (purpose === 'author' || purpose === 'test') return Object.fromEntries((phase.outputs ?? []).map((key, i) => [key, list[i]]));
  const paths = reviewPaths(job, { phase: phase.phase, round, taskId: task });
  const key = Object.keys(paths).find((k) => paths[k] === list[0]);
  return { [key]: list[0] };
}

function purposeFields(job, phase, attempt) {
  const { purpose } = attempt;
  const round = attempt.round ?? null;
  const task = attempt.task ?? null;
  const done = job.attempts.filter((a) => a.outcome === 'done' && a.phase === (attempt.phase ?? phase.phase) && (a.task ?? null) === task);
  const reviewFile = (r) => {
    const paths = reviewPaths(job, { phase: phase.phase, round: r, taskId: task });
    return task != null ? paths.taskReview : paths.review;
  };

  let previousFindings = null;
  if (purpose === 'fix') previousFindings = reviewFile(round);
  else if (REVIEW_PURPOSES.has(purpose) && round > 1) previousFindings = reviewFile(round - 1);

  let reviewFindings = null;
  let reviseOutputs = null;
  if (purpose === 'fix') {
    reviewFindings = (attempt.reviewFindings ?? []).map((f) => (typeof f === 'string' ? { id: f } : { id: f.id, severity: f.severity, text: f.text }));
    if (task == null) {
      const paths = artifactPaths(job);
      reviseOutputs = Object.fromEntries(reviseSet(job, phase).map((rel) => [Object.keys(paths).find((k) => paths[k] === rel), rel]));
    }
  }

  let taskCommits = null;
  if (purpose === 'task-review' || (purpose === 'verify' && task != null)) {
    const seen = new Set();
    taskCommits = [];
    for (const a of done) {
      if (!WORK_PURPOSES.has(a.purpose)) continue;
      for (const { repo, sha } of a.commits ?? []) {
        if (seen.has(`${repo}:${sha}`)) continue;
        seen.add(`${repo}:${sha}`);
        taskCommits.push({ repo, sha });
      }
    }
  }

  let contested = null;
  if (purpose === 'verify') {
    const lastReview = done.filter((a) => REVIEW_PURPOSES.has(a.purpose)).at(-1);
    const finalFix = done.filter((a) => a.purpose === 'fix' && a.final).at(-1);
    const findings = new Map((lastReview?.findings ?? []).map((f) => [f.id, f]));
    const dispositions = new Map((finalFix?.findings ?? []).map((f) => [f.id, f.disposition]));
    contested = (attempt.contested ?? []).map((id) => ({ id, text: findings.get(id)?.text ?? null, disposition: dispositions.get(id) ?? null }));
  }

  const target = TARGET_PURPOSES.has(purpose) && task == null && phase.target ? (artifactPaths(job)[phase.target] ?? null) : null;
  return {
    purpose,
    round,
    final: attempt.final ?? false,
    target,
    outputs: keyedOutputs(job, phase, purpose, round, task),
    reviseOutputs,
    task: attempt.taskDef ?? (task != null ? (job.tasks ?? []).find((t) => t.id === task) ?? null : null),
    taskCommits,
    previousFindings,
    reviewFindings,
    contested,
  };
}

export async function buildWorkerPrompt({ role, job, phase, attempt, projectDir }) {
  const template = await loadRoleTemplate(role, projectDir);
  if (template == null) throw Object.assign(new Error(`superagent: no prompt template for role ${JSON.stringify(role)}`), { code: 'ERR_NO_TEMPLATE' });
  const contract = await fs.readFile(path.join(templatesDir(), CONTRACT_FILE), 'utf8');

  const paths = artifactPaths(job);
  const resolve = (keys) => Object.fromEntries(keys.filter((k) => k in paths).map((k) => [k, paths[k]]));
  const inputs = resolve((phase?.inputs ?? []).filter((k) => k !== 'idea'));
  const outputs = resolve(phase?.outputs ?? []);
  const previous = attempt.previousAttemptId ? job.attempts.find((a) => a.attemptId === attempt.previousAttemptId) : null;
  const primaryFirst = [...job.repos].sort((a, b) => (a.id === 'primary' ? -1 : 0) - (b.id === 'primary' ? -1 : 0));
  const body = {
    jobId: job.jobId,
    phaseId: attempt.phase ?? phase.phase,
    taskId: attempt.task ?? null,
    attemptId: attempt.attemptId,
    title: job.title,
    mode: job.mode,
    idea: job.idea,
    repos: primaryFirst.map((r) => ({ id: r.id, worktree: r.worktree, branch: job.branch })),
    inputs,
    outputs,
    attemptDir: attempt.dir,
    round: null,
    previousFindings: null,
    recoveryNote: attempt.recovery ? RECOVERY_NOTE : null,
    previousAttemptDir: previous?.dir ?? null,
    handoff: attempt.handoff ?? null,
    ...(READ_ONLY_ROLES.has(role) ? { resultVia: 'final-message' } : {}),
    ...(attempt.purpose ? purposeFields(job, phase, attempt) : {}),
    ...(job.tasks ? { effectiveTasks: job.tasks.map(({ id, title, repos, acceptance, verify, origin }) => ({ id, title, repos, acceptance, verify, origin })) } : {}),
  };
  return {
    system: `${template.trimEnd()}\n\n${contract}`,
    card: `# Superagent job card\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`,
  };
}

export function nudgeText(kind, attempt) {
  if (attempt.readOnly) return 'No result was received. Reply with only the result JSON object as your final message.';
  if (kind === 'turn-cap') {
    return `The turn limit was reached. Write \`handoff.md\` in ${attempt.dir} (current state and next steps), then publish \`result.json\` there via \`result.json.tmp\` and rename.`;
  }
  return `No \`result.json\` was published. Publish it now in ${attempt.dir}: write \`result.json.tmp\`, then rename it to \`result.json\`.`;
}
