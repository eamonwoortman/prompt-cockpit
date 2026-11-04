// Superagent attempt results: where an attempt publishes result.json, how it
// is read, and whether it counts.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, "Worker
// contract"; plan builder decision 14 (summary truncated, not rejected;
// verdict/findings ignored outside review phases; required outputs must be
// committed by a listed commit and unchanged since).
//
// Everything in result.json is untrusted worker output. Identity is compared
// field by field against the attempt that was launched, so a result copied
// forward from an earlier attempt never counts. Commit shas must be plain hex
// before they reach git (no option injection), and every commit must be on
// the job branch but not reachable from the repo's base commit.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSafeSessionId } from '../safe-id.js';
import { defaultGit } from './worktree.js';

export const RESULT_FILE = 'result.json';

const IDENTITY_FIELDS = ['jobId', 'phaseId', 'taskId', 'attemptId'];
const STATUSES = ['done', 'blocked', 'failed'];
const VERDICTS = ['approve', 'changes'];
const SEVERITIES = ['blocker', 'major', 'minor'];
const SUMMARY_WORDS = 60;
const SHA_RE = /^[0-9a-f]{4,64}$/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function segment(name, value) {
  if (!isSafeSessionId(value)) throw new Error(`superagent: unsafe ${name} ${JSON.stringify(value)} for an attempt directory`);
  return value;
}

export function attemptDir(primaryWorktree, { jobId, phase, task, attemptId }) {
  const parts = [segment('jobId', jobId), 'attempts', segment('phase', phase)];
  if (task != null) parts.push(segment('task', task));
  parts.push(segment('attemptId', attemptId));
  return path.join(primaryWorktree, '.superpowers', 'superagent', ...parts);
}

export function artifactPaths(job) {
  const { slug, createdDate } = job;
  return {
    brief: `docs/superpowers/jobs/${slug}/brief.md`,
    spec: `docs/superpowers/specs/${createdDate}-${slug}-design.md`,
    plan: `docs/superpowers/plans/${createdDate}-${slug}.md`,
    tasks: `docs/superpowers/jobs/${slug}/tasks.json`,
    testReport: `docs/superpowers/jobs/${slug}/test-report.md`,
  };
}

export async function readResult(dir) {
  let text;
  try {
    text = await readFile(path.join(dir, RESULT_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing' };
    if (err.code === 'EISDIR') return { state: 'unparseable', error: `${RESULT_FILE} is a directory` };
    throw err;
  }
  try {
    return { state: 'present', value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch (err) {
    return { state: 'unparseable', error: err.message };
  }
}

function staysInsideWorktree(p) {
  if (!isNonEmptyString(p) || p.includes('\0')) return false;
  const fwd = p.replace(/\\/g, '/');
  if (fwd.startsWith('/') || /^[a-zA-Z]:/.test(fwd)) return false;
  const norm = path.posix.normalize(fwd);
  return norm !== '..' && !norm.startsWith('../');
}

export function primaryRepo(job) {
  return job.repos.find((r) => r.id === 'primary') ?? job.repos[0];
}

function identityErrors(value, expected) {
  const errors = [];
  for (const key of IDENTITY_FIELDS) {
    const want = key === 'taskId' ? (expected.taskId ?? null) : expected[key];
    if (!(typeof want === 'string' || (key === 'taskId' && want === null))) {
      throw new Error(`superagent: validateResult needs expected.${key}`);
    }
    if (value[key] !== want) errors.push(`identity mismatch: ${key}`);
  }
  return errors;
}

// Returns errors plus the commit list as [{ repo, sha }] with sha still as
// written (possibly abbreviated); git resolution happens later.
function evidenceErrors(evidence, job) {
  const errors = [];
  const commits = [];
  if (evidence === undefined || evidence === null) return { errors, commits };
  if (!isPlainObject(evidence)) return { errors: ['evidence must be an object'], commits };
  if (evidence.commits !== undefined) {
    if (!Array.isArray(evidence.commits)) errors.push('evidence.commits must be an array');
    else {
      evidence.commits.forEach((entry, i) => {
        const at = `evidence.commits[${i}]`;
        const { repo, sha } = typeof entry === 'string' ? { repo: primaryRepo(job).id, sha: entry } : (isPlainObject(entry) ? entry : {});
        if (typeof repo !== 'string' || typeof sha !== 'string') return errors.push(`${at} must be a sha or { repo, sha }`);
        if (!job.repos.some((r) => r.id === repo)) return errors.push(`${at}: unknown repo ${JSON.stringify(repo)}`);
        if (!SHA_RE.test(sha)) return errors.push(`${at}: not a commit sha: ${JSON.stringify(sha)}`);
        commits.push({ repo, sha });
      });
    }
  }
  if (evidence.checks !== undefined) {
    if (!Array.isArray(evidence.checks)) errors.push('evidence.checks must be an array');
    else {
      evidence.checks.forEach((c, i) => {
        if (!isPlainObject(c) || typeof c.cmd !== 'string' || !Number.isInteger(c.exit)) {
          errors.push(`evidence.checks[${i}] must be { cmd: string, exit: integer }`);
        }
      });
    }
  }
  return { errors, commits };
}

function reviewErrors(value) {
  const errors = [];
  if (!VERDICTS.includes(value.verdict)) errors.push(`verdict must be one of ${VERDICTS.join('|')}`);
  if (!Array.isArray(value.findings)) return [...errors, 'findings must be an array'];
  value.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!isPlainObject(f)) return errors.push(`${at} must be an object`);
    if (!isNonEmptyString(f.id)) errors.push(`${at}.id must be a non-empty string`);
    if (!SEVERITIES.includes(f.severity)) errors.push(`${at}.severity must be one of ${SEVERITIES.join('|')}`);
    if (!isNonEmptyString(f.text)) errors.push(`${at}.text must be a non-empty string`);
    const d = f.disposition;
    const declined = typeof d === 'string' ? /^declined:(.*)$/s.exec(d) : null;
    if (!(d === 'fixed' || d === 'open' || (declined && declined[1].trim() !== ''))) {
      errors.push(`${at}.disposition must be fixed, open or "declined: <reason>"`);
    }
  });
  return errors;
}

function schemaErrors(value, { phase, job }) {
  const errors = [];
  if (!STATUSES.includes(value.status)) errors.push(`status must be one of ${STATUSES.join('|')}`);
  if (!Array.isArray(value.artifacts)) errors.push('artifacts must be an array');
  else {
    value.artifacts.forEach((p, i) => {
      if (!staysInsideWorktree(p)) errors.push(`artifacts[${i}] must be a relative path inside the primary worktree: ${JSON.stringify(p)}`);
    });
  }
  if (!isNonEmptyString(value.summary)) errors.push('summary must be a non-empty string');
  const question = value.question ?? null;
  if (question !== null && !isNonEmptyString(question)) errors.push('question must be null or a non-empty string');
  else if (question !== null && value.status !== 'blocked') errors.push('question is only allowed with status blocked');
  const evidence = evidenceErrors(value.evidence, job);
  errors.push(...evidence.errors);
  if (phase?.kind === 'review') errors.push(...reviewErrors(value));
  return { errors, commits: evidence.commits };
}

async function resolveCommits(commits, { job, git }) {
  const errors = [];
  const resolved = [];
  for (const { repo: repoId, sha } of commits) {
    const repo = job.repos.find((r) => r.id === repoId);
    if (!repo.worktree) {
      errors.push(`repo ${repoId} has no worktree to check commit ${sha}`);
      continue;
    }
    const cwd = repo.worktree;
    const rev = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd });
    const full = rev.stdout.trim();
    if (rev.code !== 0 || !SHA_RE.test(full)) {
      errors.push(`commit not found in ${repoId}: ${sha}`);
      continue;
    }
    const onBranch = await git(['merge-base', '--is-ancestor', full, `refs/heads/${job.branch}`], { cwd });
    if (onBranch.code !== 0) {
      errors.push(`commit not on the job branch in ${repoId}: ${sha}`);
      continue;
    }
    if (!repo.baseSha) {
      errors.push(`repo ${repoId} has no base commit to check ${sha} against`);
      continue;
    }
    const fromBase = await git(['merge-base', '--is-ancestor', full, repo.baseSha], { cwd });
    if (fromBase.code === 0) {
      errors.push(`commit predates the job in ${repoId}: ${sha}`);
      continue;
    }
    if (fromBase.code !== 1) {
      errors.push(`could not check commit ${sha} against the base of ${repoId}`);
      continue;
    }
    if (!resolved.some((c) => c.repo === repoId && c.sha === full)) resolved.push({ repo: repoId, sha: full });
  }
  return { errors, resolved };
}

async function outputErrors({ phase, job, commits, git }) {
  const errors = [];
  const primary = primaryRepo(job);
  const paths = artifactPaths(job);
  const changed = new Map();
  const filesIn = async (sha) => {
    if (!changed.has(sha)) {
      const res = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { cwd: primary.worktree });
      changed.set(sha, res.code === 0 ? res.stdout.split(/\r?\n/) : []);
    }
    return changed.get(sha);
  };
  const primaryShas = commits.filter((c) => c.repo === primary.id).map((c) => c.sha);
  for (const key of phase?.outputs ?? []) {
    const rel = paths[key];
    if (!rel) {
      errors.push(`unknown output ${JSON.stringify(key)}`);
      continue;
    }
    let info;
    try {
      info = await stat(path.join(primary.worktree, ...rel.split('/')));
    } catch {
      errors.push(`missing output: ${rel}`);
    }
    if (info && !info.isFile()) errors.push(`output is not a file: ${rel}`);
    else if (info && info.size === 0) errors.push(`empty output: ${rel}`);
    let committed = false;
    for (const sha of primaryShas) {
      if ((await filesIn(sha)).includes(rel)) {
        committed = true;
        break;
      }
    }
    if (!committed) {
      errors.push(`output not committed by a listed commit: ${rel}`);
      continue;
    }
    const status = await git(['status', '--porcelain', '--', rel], { cwd: primary.worktree });
    if (status.code !== 0) errors.push(`could not check output status: ${rel}`);
    else if (status.stdout.trim() !== '') errors.push(`output changed after its commit: ${rel}`);
  }
  return errors;
}

function truncateSummary(summary) {
  const words = summary.trim().split(/\s+/);
  return words.length > SUMMARY_WORDS ? words.slice(0, SUMMARY_WORDS).join(' ') : summary;
}

export async function validateResult(value, { expected, phase, job, git = defaultGit }) {
  if (!isPlainObject(value)) return { ok: false, errors: ['result is not a JSON object'] };
  const errors = identityErrors(value, expected);
  const schema = schemaErrors(value, { phase, job });
  errors.push(...schema.errors);
  if (errors.length) return { ok: false, errors };

  const { errors: commitErrors, resolved } = await resolveCommits(schema.commits, { job, git });
  if (commitErrors.length) return { ok: false, errors: commitErrors };

  if (value.status === 'done') {
    const missing = await outputErrors({ phase, job, commits: resolved, git });
    if (missing.length) return { ok: false, errors: missing };
  }

  return {
    ok: true,
    result: { ...structuredClone(value), summary: truncateSummary(value.summary), question: value.question ?? null, commits: resolved },
  };
}

export function outcomeForResult(result) {
  if (result.status === 'done') return { outcome: 'done' };
  if (result.status === 'blocked' && result.question) return { outcome: 'question', question: result.question };
  return { outcome: 'failed', reason: result.status === 'blocked' ? 'blocked' : 'failed' };
}
