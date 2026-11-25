// Superagent attempt results: where an attempt publishes result.json, how it
// is read, and whether it counts.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, "Worker
// contract"; plan builder decision 14 (summary truncated, not rejected;
// verdict/findings ignored outside review phases; required outputs must be
// committed by a listed commit and unchanged since). Plan 3 decisions 5, 12,
// 13, 15, 16 and 17 add tasks.json validation, per-purpose schemas, required
// and revise outputs and implement evidence, selected by the optional
// `attempt` passed to validateResult. Plan 5 decisions 4 and 11 add the
// brainstorm's `ask` and `answer` purposes and the brief headings check.
// A ledger job's outputs are never committed: they only have to exist, their
// SHA-256 is recorded, and no listed commit may touch `.superpowers/`.
//
// Everything in result.json is untrusted worker output. Identity is compared
// field by field against the attempt that was launched, so a result copied
// forward from an earlier attempt never counts. Commit shas must be plain hex
// before they reach git (no option injection), and every commit must be on
// the job branch but not reachable from the repo's base commit.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSafeSessionId } from '../safe-id.js';
import { failureSignature } from './sequencer.js';
import { defaultGit } from './worktree.js';
import { isTestPath } from './test-paths.js';
import { roundDir, roundOutputPaths, roundTestReportPaths, roundTriagePath } from './feedback.js';

export const RESULT_FILE = 'result.json';
export const BRAINSTORM_BATCH = 5;
export const ANSWER_TAGS = ['from-idea', 'from-project', 'assumed'];
export const BRIEF_HEADINGS = ['Assumptions made for you', 'Your answers'];

const IDENTITY_FIELDS = ['jobId', 'phaseId', 'taskId', 'attemptId'];
const STATUSES = ['done', 'blocked', 'failed'];
const VERDICTS = ['approve', 'changes'];
const SEVERITIES = ['blocker', 'major', 'minor'];
const SUMMARY_WORDS = 60;
const SHA_RE = /^[0-9a-f]{4,64}$/i;
const QUESTION_ID_RE = /^Q[1-9][0-9]*$/;

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

export function ledgerArtifactRoot(jobId) {
  return `.superpowers/superagent/${jobId}/artifacts`;
}

// The job's resolved artifact map, which deriveJob() always sets (today's
// table for a job without a workflow).
export function artifactPaths(job) {
  if (!isPlainObject(job?.artifacts)) throw new Error('superagent: artifactPaths needs a derived job (deriveJob sets job.artifacts)');
  return job.artifacts;
}

// The keys of reviewPaths, which are also the view's attempt artifact key kinds.
export const PHASE_ATTEMPT_KINDS = Object.freeze(['review', 'response', 'verify']);
export const TASK_ATTEMPT_KINDS = Object.freeze(['report', 'taskReview', 'taskVerify']);
// A workflow artifact key may not be one of these.
export const RESERVED_ARTIFACT_KEYS = Object.freeze([...PHASE_ATTEMPT_KINDS, ...TASK_ATTEMPT_KINDS, 'idea']);

// Decision 15. A key whose inputs were not given (no round, no taskId) is null.
// A feedback round keeps its phase review, response and verify files under its own folder.
export function reviewPaths(job, { phase = null, round = null, taskId = null, feedbackRound = 0 }) {
  const jobs = job.artifactRoot === 'ledger' ? ledgerArtifactRoot(job.jobId) : `docs/superpowers/jobs/${job.slug}`;
  const phaseBase = feedbackRound > 0 ? roundDir(job, feedbackRound) : jobs;
  const p = phase == null ? null : segment('phase', phase);
  const t = taskId == null ? null : segment('taskId', taskId);
  const r = Number.isInteger(round);
  // Plan 5 Decision 10: an extra-round verifier carries its round; the base one (round null) does not.
  const v = r ? `-r${round}` : '';
  return {
    review: p && r ? `${phaseBase}/reviews/${p}-r${round}.md` : null,
    response: p && r ? `${phaseBase}/reviews/${p}-r${round}-response.md` : null,
    verify: p ? `${phaseBase}/reviews/${p}-verify${v}.md` : null,
    report: t ? `${jobs}/tasks/${t}-report.md` : null,
    taskReview: t && r ? `${jobs}/tasks/${t}-review-r${round}.md` : null,
    taskVerify: t ? `${jobs}/tasks/${t}-verify${v}.md` : null,
  };
}

function outputPaths(job, keys) {
  const paths = artifactPaths(job);
  return keys.map((key) => {
    if (!paths[key]) throw new Error(`superagent: unknown output ${JSON.stringify(key)}`);
    return paths[key];
  });
}

const PURPOSE_OUTPUT = {
  review: () => 'review',
  fix: (scoped) => (scoped ? 'report' : 'response'),
  verify: (scoped) => (scoped ? 'taskVerify' : 'verify'),
  implement: () => 'report',
  'task-review': () => 'taskReview',
};

export function requiredOutputs(job, { phase, purpose, round = null, task = null, feedbackRound = 0, reportOrdinal = null }) {
  if (purpose === 'triage') return [roundTriagePath(job, feedbackRound)];
  if (purpose === 'feedback-plan') return Object.values(roundOutputPaths(job, feedbackRound, phase?.outputs ?? []));
  if (purpose === 'test' && feedbackRound > 0) {
    if (!Number.isInteger(reportOrdinal) || reportOrdinal < 1) throw new Error(`superagent: a round test attempt needs its report ordinal (got ${JSON.stringify(reportOrdinal)})`);
    return Object.values(roundTestReportPaths(job, feedbackRound, reportOrdinal));
  }
  if (purpose === 'author' || purpose === 'ask' || purpose === 'test') return outputPaths(job, phase?.outputs ?? []);
  if (purpose === 'answer') return [];
  if (!PURPOSE_OUTPUT[purpose]) throw new Error(`superagent: unknown attempt purpose ${JSON.stringify(purpose)}`);
  const key = PURPOSE_OUTPUT[purpose](task != null);
  const rel = reviewPaths(job, { phase: phase?.phase ?? null, round, taskId: task, feedbackRound })[key];
  if (!rel) throw new Error(`superagent: ${purpose} outputs need the phase, task and round they belong to (got round ${JSON.stringify(round)})`);
  return [rel];
}

export function reviseOutputs(job, phase, { feedbackRound = 0 } = {}) {
  const author = job.pipeline.find((p) => p.kind === 'author' && (p.outputs ?? []).includes(phase.target));
  if (!author) return [];
  return feedbackRound > 0 ? Object.values(roundOutputPaths(job, feedbackRound, author.outputs)) : outputPaths(job, author.outputs);
}

// Ids become path segments (tasks/<id>-report.md), so uniqueness and the
// reserved generated-fix pattern are compared case-insensitively: T1 and t1
// would share one report file on a case-insensitive filesystem.
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,11}$/i;
const FIX_TASK_ID_RE = /^F-[0-9a-f]{8}$/i;

// Iterative DFS; returns the ids on the first cycle found, in path order.
// Self and unknown dependencies are reported separately, so they are skipped.
function findCycle(deps) {
  const done = new Set();
  for (const root of deps.keys()) {
    if (done.has(root)) continue;
    const trail = [root];
    const next = [0];
    while (trail.length) {
      const id = trail[trail.length - 1];
      const ds = deps.get(id);
      const i = next[next.length - 1]++;
      if (i >= ds.length) {
        done.add(id);
        trail.pop();
        next.pop();
        continue;
      }
      const d = ds[i];
      if (d === id || !deps.has(d) || done.has(d)) continue;
      const back = trail.indexOf(d);
      if (back !== -1) return trail.slice(back);
      trail.push(d);
      next.push(0);
    }
  }
  return [];
}

// `existing` is the job's tasks so far: a round's ids may not collide with them
// (case-insensitively) and its dependsOn may name them.
export function parseTasks(text, job, { existing = [] } = {}) {
  let list;
  try {
    list = JSON.parse(typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, errors: [`tasks.json is not valid JSON: ${err.message}`] };
  }
  if (!Array.isArray(list)) return { ok: false, errors: ['tasks.json must be a JSON array'] };
  if (list.length === 0) return { ok: false, errors: ['tasks.json must list at least one task'] };
  const errors = [];
  const seen = new Set();
  const earlier = new Set(existing.map((t) => t.id.toLowerCase()));
  const known = new Set([...existing.map((t) => t.id), ...list.filter((t) => isPlainObject(t) && typeof t.id === 'string').map((t) => t.id)]);
  const deps = new Map();
  list.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!isPlainObject(t)) return errors.push(`${at} must be an object`);
    const idOk = typeof t.id === 'string' && TASK_ID_RE.test(t.id);
    if (!idOk) errors.push(`${at}.id must be 1-12 letters, digits or hyphens, starting with a letter or digit: ${JSON.stringify(t.id)}`);
    else if (FIX_TASK_ID_RE.test(t.id)) errors.push(`${at}.id: ${JSON.stringify(t.id)} is reserved for generated fix tasks (F-<8 hex>)`);
    else if (earlier.has(t.id.toLowerCase())) errors.push(`${at}.id: ${JSON.stringify(t.id)} collides with an existing task`);
    else if (seen.has(t.id.toLowerCase())) errors.push(`${at}.id: duplicate id ${JSON.stringify(t.id)}`);
    if (idOk) seen.add(t.id.toLowerCase());
    if (!isNonEmptyString(t.title)) errors.push(`${at}.title must be a non-empty string`);
    if (!isNonEmptyString(t.acceptance)) errors.push(`${at}.acceptance must be a non-empty string`);
    if (!Array.isArray(t.repos) || t.repos.length === 0) errors.push(`${at}.repos must be a non-empty array of repo ids`);
    else {
      for (const r of t.repos) if (!job.repos.some((repo) => repo.id === r)) errors.push(`${at}.repos: unknown repo ${JSON.stringify(r)}`);
    }
    if (!Array.isArray(t.dependsOn)) errors.push(`${at}.dependsOn must be an array of task ids`);
    else {
      for (const d of t.dependsOn) {
        if (d === t.id) errors.push(`${at}.dependsOn: ${JSON.stringify(d)} depends on itself`);
        else if (!known.has(d)) errors.push(`${at}.dependsOn: unknown task ${JSON.stringify(d)}`);
      }
      if (idOk && !deps.has(t.id)) deps.set(t.id, t.dependsOn);
    }
    if (typeof t.verify !== 'string') errors.push(`${at}.verify must be a string (may be empty)`);
  });
  const cycle = findCycle(deps);
  if (cycle.length) errors.push(`dependsOn: dependency cycle among ${cycle.map((id) => JSON.stringify(id)).join(', ')}`);
  if (errors.length) return { ok: false, errors };
  const tasks = list.map(({ id, title, repos, dependsOn, acceptance, verify }) => ({
    id, title, repos: [...repos], dependsOn: [...dependsOn], acceptance, verify, origin: 'plan', fromAttemptId: null,
  }));
  return { ok: true, tasks };
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

// `disposition: false` is a tester's finding (no disposition; an optional
// `repo` that must be one of the job's repos).
// `defaultOpen` (reviewers) lets a missing disposition stand for 'open'.
function findingErrors(findings, { job = null, disposition = true, defaultOpen = false } = {}) {
  if (!Array.isArray(findings)) return ['findings must be an array'];
  const errors = [];
  const seen = new Set();
  findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!isPlainObject(f)) return errors.push(`${at} must be an object`);
    if (!isNonEmptyString(f.id)) errors.push(`${at}.id must be a non-empty string`);
    else if (seen.has(f.id)) errors.push(`${at}: duplicate id ${JSON.stringify(f.id)}`);
    else seen.add(f.id);
    if (!SEVERITIES.includes(f.severity)) errors.push(`${at}.severity must be one of ${SEVERITIES.join('|')}`);
    if (!isNonEmptyString(f.text)) errors.push(`${at}.text must be a non-empty string`);
    if (disposition) {
      const d = f.disposition === undefined && defaultOpen ? 'open' : f.disposition;
      const declined = typeof d === 'string' ? /^declined:(.*)$/s.exec(d) : null;
      if (!(d === 'fixed' || d === 'open' || (declined && declined[1].trim() !== ''))) {
        errors.push(`${at}.disposition must be fixed, open or "declined: <reason>"`);
      }
    } else if (f.repo !== undefined && !job.repos.some((r) => r.id === f.repo)) {
      errors.push(`${at}.repo: unknown repo ${JSON.stringify(f.repo)}`);
    }
  });
  return errors;
}

function reviewErrors(value) {
  const errors = [];
  if (!VERDICTS.includes(value.verdict)) errors.push(`verdict must be one of ${VERDICTS.join('|')}`);
  return [...errors, ...findingErrors(value.findings, { defaultOpen: true })];
}

function verdictErrors(value) {
  const errors = reviewErrors(value);
  if (!Array.isArray(value.findings)) return errors;
  const openBlocker = value.findings.some((f) => isPlainObject(f) && f.severity === 'blocker' && (f.disposition ?? 'open') === 'open');
  if (value.verdict === 'approve' && openBlocker) errors.push('approve is not allowed with an open blocker finding');
  if (value.verdict === 'changes' && value.findings.length === 0) errors.push('changes must list at least one finding');
  return errors;
}

// attempt.reviewFindings is the round's review findings, as ids or finding
// objects. A finding the review graded blocker stays a blocker even if the fix
// result downgrades it.
function fixErrors(value, attempt) {
  const errors = findingErrors(value.findings);
  if (!Array.isArray(value.findings)) return errors;
  const reviewed = new Map();
  for (const f of attempt.reviewFindings ?? []) {
    if (typeof f === 'string') reviewed.set(f, null);
    else if (isPlainObject(f) && typeof f.id === 'string') reviewed.set(f.id, f.severity ?? null);
  }
  value.findings.forEach((f, i) => {
    if (!isPlainObject(f) || typeof f.id !== 'string') return;
    if (!reviewed.has(f.id)) return errors.push(`findings[${i}]: ${JSON.stringify(f.id)} is not a finding of the review`);
    const blocker = f.severity === 'blocker' || reviewed.get(f.id) === 'blocker';
    if (blocker && f.disposition === 'open' && !attempt.final) {
      errors.push(`findings[${i}]: blocker ${JSON.stringify(f.id)} may only stay open in the final fix`);
    }
  });
  return errors;
}

function verifyErrors(value, attempt) {
  if (!Array.isArray(value.verified)) return ['verified must be an array'];
  const errors = [];
  const seen = new Set();
  value.verified.forEach((v, i) => {
    const at = `verified[${i}]`;
    if (!isPlainObject(v)) return errors.push(`${at} must be an object`);
    if (!isNonEmptyString(v.id)) errors.push(`${at}.id must be a non-empty string`);
    else if (seen.has(v.id)) errors.push(`${at}: duplicate id ${JSON.stringify(v.id)}`);
    else seen.add(v.id);
    if (typeof v.verified !== 'boolean') errors.push(`${at}.verified must be a boolean`);
    if (!isNonEmptyString(v.evidence)) errors.push(`${at}.evidence must be a non-empty string`);
  });
  const contested = new Set(attempt.contested ?? []);
  for (const id of contested) if (!seen.has(id)) errors.push(`verified is missing contested id ${JSON.stringify(id)}`);
  for (const id of seen) if (!contested.has(id)) errors.push(`verified lists ${JSON.stringify(id)}, which is not contested`);
  return errors;
}

// Findings are checked whatever the status: a blocked tester's findings are
// stored on its attempt just the same.
function testErrors(value, job) {
  if (value.status === 'failed' && (!Array.isArray(value.findings) || value.findings.length === 0)) {
    return ['a failed test result must list at least one finding'];
  }
  if (value.findings === undefined || value.findings === null) return [];
  return findingErrors(value.findings, { job, disposition: false });
}

// A done ask either asks a batch of new questions or, with `questions: []`,
// publishes the brief.
function askErrors(value, attempt) {
  if (value.status === 'blocked') return ['the brainstormer asks through questions, not a blocked result'];
  if (value.status !== 'done') return [];
  if (!Array.isArray(value.questions)) return ['questions must be an array'];
  const errors = [];
  if (attempt.final && value.questions.length > 0) errors.push('a final brainstorm turn must write the brief, not ask questions');
  if (value.questions.length > BRAINSTORM_BATCH) errors.push(`questions may list at most ${BRAINSTORM_BATCH} per turn`);
  const asked = new Set(attempt.askedIds ?? []);
  const seen = new Set();
  value.questions.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (!isPlainObject(q)) return errors.push(`${at} must be an object`);
    if (typeof q.id !== 'string' || !QUESTION_ID_RE.test(q.id)) errors.push(`${at}.id must be Q<n>: ${JSON.stringify(q.id)}`);
    else if (seen.has(q.id)) errors.push(`${at}: duplicate id ${JSON.stringify(q.id)}`);
    else if (asked.has(q.id)) errors.push(`${at}: ${JSON.stringify(q.id)} was already asked`);
    if (typeof q.id === 'string') seen.add(q.id);
    if (!isNonEmptyString(q.text)) errors.push(`${at}.text must be a non-empty string`);
  });
  return errors;
}

// Decision 4: a stand-in escalates one open question as blocked, with a
// question for the user, and answers every other open question.
function answerErrors(value, attempt) {
  if (value.status !== 'done' && value.status !== 'blocked') return [];
  if (!Array.isArray(attempt.openQuestions)) throw new Error('superagent: validateResult needs attempt.openQuestions for answer attempts');
  const open = attempt.openQuestions.map((q) => q.id);
  const errors = [];
  let escalated = null;
  if (value.status === 'blocked') {
    if (!isNonEmptyString(value.question)) errors.push('a blocked answer result must carry a question for the user');
    if (!open.includes(value.escalated)) errors.push(`escalated must name an open question: ${JSON.stringify(value.escalated)}`);
    else escalated = value.escalated;
  } else if (value.escalated != null) {
    errors.push('escalated is only allowed with status blocked');
  }
  if (!Array.isArray(value.answers)) return [...errors, 'answers must be an array'];
  const seen = new Set();
  value.answers.forEach((a, i) => {
    const at = `answers[${i}]`;
    if (!isPlainObject(a)) return errors.push(`${at} must be an object`);
    if (!isNonEmptyString(a.id)) errors.push(`${at}.id must be a non-empty string`);
    else if (seen.has(a.id)) errors.push(`${at}: duplicate id ${JSON.stringify(a.id)}`);
    else if (a.id === escalated) errors.push(`${at}: ${JSON.stringify(a.id)} is escalated, so it is not answered`);
    else if (!open.includes(a.id)) errors.push(`${at}: ${JSON.stringify(a.id)} is not an open question`);
    if (typeof a.id === 'string') seen.add(a.id);
    if (!ANSWER_TAGS.includes(a.tag)) errors.push(`${at}.tag must be one of ${ANSWER_TAGS.join('|')}`);
    if (!isNonEmptyString(a.answer)) errors.push(`${at}.answer must be a non-empty string`);
    if (!isNonEmptyString(a.reason)) errors.push(`${at}.reason must be a non-empty string`);
  });
  for (const id of open) if (id !== escalated && !seen.has(id)) errors.push(`answers is missing open question ${JSON.stringify(id)}`);
  return errors;
}

const TRIAGE_ROUTES = ['fix', 'subplan', 'separate'];
const IDEA_MAX_CHARS = 4000;

// A done triage must carry its own decision fields, so a triage.md left by an
// earlier rejected result can never back it.
export function triageErrors(value, job) {
  const errors = [];
  if (!isNonEmptyString(value.brief)) errors.push('brief must be a non-empty string');
  if (!Array.isArray(value.requirementChanges) || value.requirementChanges.some((c) => !isNonEmptyString(c))) errors.push('requirementChanges must be an array of strings');
  if (!TRIAGE_ROUTES.includes(value.route)) errors.push(`route must be one of ${TRIAGE_ROUTES.join('|')}`);
  if (value.route === 'fix') {
    const t = value.task;
    if (!isPlainObject(t)) errors.push('task must be an object for route fix');
    else {
      if (!isNonEmptyString(t.title)) errors.push('task.title must be a non-empty string');
      if (!isNonEmptyString(t.acceptance)) errors.push('task.acceptance must be a non-empty string');
      if (typeof t.verify !== 'string') errors.push('task.verify must be a string (may be empty)');
      if (!Array.isArray(t.repos) || t.repos.length === 0) errors.push('task.repos must be a non-empty array of repo ids');
      else for (const r of t.repos) if (!job.repos.some((repo) => repo.id === r)) errors.push(`task.repos: unknown repo ${JSON.stringify(r)}`);
    }
  }
  if (value.route === 'separate') {
    const len = typeof value.idea === 'string' ? value.idea.trim().length : 0;
    if (len < 1 || len > IDEA_MAX_CHARS) errors.push(`idea must be 1-${IDEA_MAX_CHARS} characters for route separate`);
  }
  return errors;
}

function purposeErrors(value, { attempt, job }) {
  if (attempt.purpose === 'test') return testErrors(value, job);
  if (attempt.purpose === 'ask') return askErrors(value, attempt);
  if (attempt.purpose === 'answer') return answerErrors(value, attempt);
  if (attempt.purpose === 'triage' && value.status === 'done') return triageErrors(value, job);
  // A blocked worker publishes a question (or nothing) instead of its purpose fields.
  if (value.status === 'blocked') return [];
  switch (attempt.purpose) {
    case 'review':
    case 'task-review':
      return verdictErrors(value);
    case 'fix':
      return fixErrors(value, attempt);
    case 'verify':
      return verifyErrors(value, attempt);
    default:
      return [];
  }
}

const isTaskWork = (attempt) => attempt.purpose === 'implement' || (attempt.purpose === 'fix' && attempt.task != null);
const normalizeCmd = (cmd) => cmd.trim().replace(/\s+/g, ' ');

// Decision 17. Runs only on well-formed evidence, so commit indexes line up
// with evidence.commits. In a legacy job the primary repo carries the report
// file, so a primary commit is always allowed but only counts as code
// evidence when the task lists primary.
function taskEvidenceErrors(value, { attempt, job, commits }) {
  if (value.status !== 'done') return [];
  const { taskDef } = attempt;
  if (!isPlainObject(taskDef) || !Array.isArray(taskDef.repos)) {
    throw new Error('superagent: validateResult needs attempt.taskDef for implement and task fix attempts');
  }
  if (commits.length === 0) return ['evidence.commits must list at least one commit'];
  const errors = [];
  const reportRepo = job.artifactRoot === 'ledger' ? null : primaryRepo(job).id;
  const repos = taskDef.repos;
  commits.forEach(({ repo }, i) => {
    if (repo !== reportRepo && !repos.includes(repo)) {
      errors.push(`evidence.commits[${i}]: repo ${JSON.stringify(repo)} is not one of the task's repos (${repos.join(', ')})`);
    }
  });
  if (!commits.some((c) => repos.includes(c.repo))) errors.push(`evidence.commits must include a commit in one of the task's repos (${repos.join(', ')})`);
  const verify = typeof taskDef.verify === 'string' ? normalizeCmd(taskDef.verify) : '';
  const checks = value.evidence?.checks ?? [];
  if (verify && !checks.some((c) => c.exit === 0 && normalizeCmd(c.cmd) === verify)) {
    errors.push(`evidence.checks must include the task's verify command ${JSON.stringify(verify)} with exit 0`);
  }
  return errors;
}

function schemaErrors(value, { phase, job, attempt }) {
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
  if (attempt) errors.push(...purposeErrors(value, { attempt, job }));
  else if (phase?.kind === 'review') errors.push(...reviewErrors(value));
  if (attempt && isTaskWork(attempt) && evidence.errors.length === 0) errors.push(...taskEvidenceErrors(value, { attempt, job, commits: evidence.commits }));
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

// The files a commit changes: a merge against its first parent, a root commit
// in full. null when git cannot list them.
async function commitFiles(sha, { cwd, git }) {
  const res = await git(['diff-tree', '-z', '-r', '--root', '--diff-merges=first-parent', '--no-commit-id', '--name-only', sha], { cwd });
  return res.code === 0 ? res.stdout.split('\0').filter(Boolean) : null;
}

function forbiddenPathErrors(files, job, suffix = '') {
  const errors = [];
  const superagent = files.find((file) => file.startsWith('.superpowers/'));
  if (superagent) errors.push(`commit includes superagent files: ${superagent}${suffix}`);
  if (job.commitTests === false) {
    const test = files.find((file) => isTestPath(file, job.testPaths));
    if (test) errors.push(`commit includes test files: ${test}${suffix}`);
  }
  return errors;
}

// A listed commit may not carry superagent files, nor test files unless the job commits tests.
export async function commitPathErrors(commits, { job, git }) {
  const errors = [];
  for (const { repo: repoId, sha } of commits) {
    const repo = job.repos.find((r) => r.id === repoId);
    if (!repo?.worktree) {
      errors.push(`repo ${repoId} has no worktree to check commit ${sha}`);
      continue;
    }
    const files = await commitFiles(sha, { cwd: repo.worktree, git });
    if (!files) errors.push(`could not list the files of commit ${sha} in ${repoId}`);
    else errors.push(...forbiddenPathErrors(files, job));
  }
  return errors;
}

// The same rule for every other commit on the job branch since the base: a
// follow-up commit does not take an earlier one off the branch.
export async function branchPathErrors(listed, { job, git }) {
  const errors = [];
  for (const repo of job.repos) {
    if (!repo.worktree || !repo.baseSha) {
      errors.push(`repo ${repo.id} has no worktree or base commit to check the job branch`);
      continue;
    }
    const range = await git(['rev-list', '--reverse', `${repo.baseSha}..refs/heads/${job.branch}`], { cwd: repo.worktree });
    if (range.code !== 0) {
      errors.push(`could not list the commits of the job branch in ${repo.id}`);
      continue;
    }
    for (const sha of range.stdout.split(/\r?\n/).filter(Boolean)) {
      if (listed.some((c) => c.repo === repo.id && c.sha === sha)) continue;
      const files = await commitFiles(sha, { cwd: repo.worktree, git });
      if (!files) errors.push(`could not list the files of commit ${sha} in ${repo.id}`);
      else errors.push(...forbiddenPathErrors(files, job, ` (commit ${sha.slice(0, 7)} in ${repo.id}, already on the branch)`));
    }
  }
  return errors;
}

// Decision 16: the author may decline every finding, so the revised artifacts
// need only exist, be non-empty and (in a legacy job) be clean; no commit has
// to touch them.
async function reviseErrors({ phase, job, git, feedbackRound = 0 }) {
  const errors = [];
  const primary = primaryRepo(job);
  for (const rel of reviseOutputs(job, phase, { feedbackRound })) {
    let info;
    try {
      info = await stat(path.join(primary.worktree, ...rel.split('/')));
    } catch {
      errors.push(`missing revised output: ${rel}`);
      continue;
    }
    if (!info.isFile()) {
      errors.push(`revised output is not a file: ${rel}`);
      continue;
    }
    if (info.size === 0) {
      errors.push(`empty revised output: ${rel}`);
      continue;
    }
    if (job.artifactRoot === 'ledger') continue;
    const status = await git(['status', '--porcelain', '--', rel], { cwd: primary.worktree });
    if (status.code !== 0) errors.push(`could not check revised output status: ${rel}`);
    else if (status.stdout.trim() !== '') errors.push(`revised output has uncommitted changes: ${rel}`);
  }
  return errors;
}

async function outputErrors({ phase, job, commits, git, attempt }) {
  const errors = [];
  const outputs = {};
  const primary = primaryRepo(job);
  const paths = artifactPaths(job);
  const feedbackRound = attempt?.feedbackRound ?? 0;
  const required = attempt
    ? requiredOutputs(job, {
      phase, purpose: attempt.purpose, round: attempt.round ?? null, task: attempt.task ?? null, feedbackRound, reportOrdinal: attempt.reportOrdinal ?? null,
    }).map((rel) => ({ rel }))
    : (phase?.outputs ?? []).map((key) => ({ key, rel: paths[key] }));
  const changed = new Map();
  const filesIn = async (sha) => {
    if (!changed.has(sha)) changed.set(sha, (await commitFiles(sha, { cwd: primary.worktree, git })) ?? []);
    return changed.get(sha);
  };
  const primaryShas = commits.filter((c) => c.repo === primary.id).map((c) => c.sha);
  for (const { key, rel } of required) {
    if (!rel) {
      errors.push(`unknown output ${JSON.stringify(key)}`);
      continue;
    }
    const abs = path.join(primary.worktree, ...rel.split('/'));
    let info;
    try {
      info = await stat(abs);
    } catch {
      errors.push(`missing output: ${rel}`);
    }
    if (info && !info.isFile()) errors.push(`output is not a file: ${rel}`);
    else if (info && info.size === 0) errors.push(`empty output: ${rel}`);
    else if (info) outputs[rel] = createHash('sha256').update(await readFile(abs)).digest('hex');
    if (job.artifactRoot === 'ledger') continue;
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
  const reviewFix = attempt?.purpose === 'fix' && attempt.task == null && phase?.kind === 'review';
  if (reviewFix) errors.push(...(await reviseErrors({ phase, job, git, feedbackRound })));
  const tasksRel = feedbackRound > 0 && paths.tasks ? roundOutputPaths(job, feedbackRound, ['tasks']).tasks : paths.tasks;
  const publishesTasks = ((attempt?.purpose === 'author' || attempt?.purpose === 'feedback-plan') && (phase?.outputs ?? []).includes('tasks'))
    || (reviewFix && reviseOutputs(job, phase, { feedbackRound }).includes(tasksRel));
  if (publishesTasks && errors.length === 0) errors.push(...(await tasksFileErrors(job, tasksRel, feedbackRound > 0 ? (job.tasks ?? []) : [])));
  return { errors, outputs };
}

// Decision 5: a tasks.json that would deadlock the implement phase is refused
// whenever it is published, by the planner or by a planner fix.
async function tasksFileErrors(job, rel, existing) {
  let text;
  try {
    text = await readFile(path.join(primaryRepo(job).worktree, ...rel.split('/')), 'utf8');
  } catch (err) {
    return [`could not read ${rel}: ${err.message}`];
  }
  const parsed = parseTasks(text, job, { existing });
  return parsed.ok ? [] : parsed.errors.map((e) => `${rel}: ${e}`);
}

// A round may add files but never change what the job had when feedback was given.
// Baseline keys are relative to the job's ledger artifact root; the messages name
// the repo-relative path, like every other output error.
export async function baselineErrors(job, round) {
  const baseline = (job.feedbackRounds ?? []).find((r) => r.round === round)?.baseline ?? {};
  const root = ledgerArtifactRoot(job.jobId);
  const primary = primaryRepo(job);
  const errors = [];
  for (const [key, hash] of Object.entries(baseline)) {
    const rel = `${root}/${key}`;
    let data;
    try {
      data = await readFile(path.join(primary.worktree, ...rel.split('/')));
    } catch {
      errors.push(`missing since feedback was given: ${rel}`);
      continue;
    }
    if (createHash('sha256').update(data).digest('hex') !== hash) errors.push(`changed since feedback was given: ${rel}`);
  }
  return errors;
}

export function headingErrors(text, label) {
  return BRIEF_HEADINGS
    .filter((h) => !new RegExp(`^##\\s+${h}\\s*$`, 'm').test(text))
    .map((h) => `${label} is missing the heading "## ${h}"`);
}

const asksQuestions = (value, attempt) => attempt?.purpose === 'ask' && Array.isArray(value.questions) && value.questions.length > 0;

// Decision 11. The brief, and in a job that brainstorms the first output of
// the first author phase that takes the brief, must carry both brief
// headings. Fix rounds aren't checked.
function headingsTarget(job, phase, attempt) {
  if (attempt?.purpose === 'ask') return 'brief';
  if (attempt?.purpose !== 'author' || !job.pipeline.some((p) => p.kind === 'brainstorm')) return null;
  const briefReader = job.pipeline.find((p) => p.kind === 'author' && (p.inputs ?? []).includes('brief'));
  return briefReader && briefReader.phase === phase?.phase ? (briefReader.outputs?.[0] ?? null) : null;
}

async function artifactHeadingErrors(job, key) {
  const rel = artifactPaths(job)[key];
  let text;
  try {
    text = await readFile(path.join(primaryRepo(job).worktree, ...rel.split('/')), 'utf8');
  } catch (err) {
    return [`could not read ${rel}: ${err.message}`];
  }
  return headingErrors(text, key);
}

function truncateSummary(summary) {
  const words = summary.trim().split(/\s+/);
  if (words.length <= SUMMARY_WORDS) return summary;
  return summary.trim().match(new RegExp(`^(?:\\S+\\s+){${SUMMARY_WORDS - 1}}\\S+`))[0];
}

// `attempt` ({ purpose, round, final, task, taskDef?, contested?,
// reviewFindings?, askedIds?, openQuestions? }) selects the per-purpose schema
// and the required outputs; without it the Plan 2 rules apply unchanged.
export async function validateResult(value, { expected, phase, job, git = defaultGit, attempt = null }) {
  if (!isPlainObject(value)) return { ok: false, errors: ['result is not a JSON object'] };
  const errors = identityErrors(value, expected);
  const schema = schemaErrors(value, { phase, job, attempt });
  if ((attempt?.feedbackRound ?? 0) > 0) errors.push(...(await baselineErrors(job, attempt.feedbackRound)));
  errors.push(...schema.errors);
  if (errors.length) return { ok: false, errors };

  const { errors: commitErrors, resolved } = await resolveCommits(schema.commits, { job, git });
  if (commitErrors.length) return { ok: false, errors: commitErrors };
  const pathErrors = [...(await commitPathErrors(resolved, { job, git })), ...(await branchPathErrors(resolved, { job, git }))];
  if (pathErrors.length) return { ok: false, errors: pathErrors };

  let outputs = {};
  if (value.status === 'done' && !asksQuestions(value, attempt)) {
    const checked = await outputErrors({ phase, job, commits: resolved, git, attempt });
    if (checked.errors.length) return { ok: false, errors: checked.errors };
    outputs = checked.outputs;
    const key = headingsTarget(job, phase, attempt);
    const headings = key ? await artifactHeadingErrors(job, key) : [];
    if (headings.length) return { ok: false, errors: headings };
  }

  return {
    ok: true,
    result: { ...structuredClone(value), summary: truncateSummary(value.summary), question: value.question ?? null, commits: resolved, outputs },
  };
}

// Decision 13: a worker-reported failure carries a signature from the
// summary's first line, so repeated-error can trip on it.
export function outcomeForResult(result) {
  const extra = {};
  for (const key of ['verdict', 'findings', 'verified', 'questions', 'answers', 'escalated']) if (result[key] !== undefined) extra[key] = result[key];
  if (result.status === 'done') return { outcome: 'done', ...extra };
  if (result.status === 'blocked' && result.question) return { outcome: 'question', question: result.question, ...extra };
  const reason = result.status === 'blocked' ? 'blocked' : 'failed';
  return { outcome: 'failed', reason, signature: failureSignature(reason, result.summary ?? ''), ...extra };
}
