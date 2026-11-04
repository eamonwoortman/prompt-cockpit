import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactPaths } from './results.js';

export const UNATTENDED_DENY_MESSAGE = 'You are running unattended. Put your question in `result.json` with `status: blocked`.';
export const RECOVERY_NOTE = 'check every worktree\'s git status and log, and the ledger, before repeating work; continue from `handoff.md` if present';

const CONTRACT_FILE = 'contract.md';

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

export async function buildWorkerPrompt({ role, job, phase, attempt, projectDir }) {
  const template = await loadRoleTemplate(role, projectDir);
  if (template == null) throw Object.assign(new Error(`superagent: no prompt template for role ${JSON.stringify(role)}`), { code: 'ERR_NO_TEMPLATE' });
  const contract = await fs.readFile(path.join(templatesDir(), CONTRACT_FILE), 'utf8');

  const { idea: _idea, ...inputs } = artifactPaths(job);
  const { spec, plan, tasks, testReport } = inputs;
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
    outputs: { spec, plan, tasks, testReport },
    attemptDir: attempt.dir,
    round: null,
    previousFindings: null,
    recoveryNote: attempt.recovery ? RECOVERY_NOTE : null,
    previousAttemptDir: previous?.dir ?? null,
  };
  return {
    system: `${template.trimEnd()}\n\n${contract}`,
    card: `# Superagent job card\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`,
  };
}

export function nudgeText(kind, attempt) {
  if (kind === 'turn-cap') {
    return `The turn limit was reached. Write \`handoff.md\` in ${attempt.dir} (current state and next steps), then publish \`result.json\` there via \`result.json.tmp\` and rename.`;
  }
  return `No \`result.json\` was published. Publish it now in ${attempt.dir}: write \`result.json.tmp\`, then rename it to \`result.json\`.`;
}
