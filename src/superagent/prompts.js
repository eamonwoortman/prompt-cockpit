import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactPaths, ledgerArtifactRoot, reviewPaths, requiredOutputs, reviseOutputs as reviseSet, BRAINSTORM_BATCH } from './results.js';
import { attemptsFor, brainstormLog, DEFAULT_REVIEW_ROUNDS } from './sequencer.js';
import { feedbackShape, isRoundScoped, roundDir, roundOf, roundOutputPaths, roundTestReportPaths, roundTriagePath } from './feedback.js';
import { ROLE_NAME, resolvePromptPath, templatesDir } from './workflows.js';

export { templatesDir };

export const UNATTENDED_DENY_MESSAGE = 'You are running unattended. Put your question in `result.json` with `status: blocked`.';
export const RECOVERY_NOTE = 'check every worktree\'s git status and log, and the ledger, before repeating work; continue from `handoff.md` if present';
// Read-only roles cannot write result.json; they reply with it instead.
export const READ_ONLY_ROLES = new Set(['stand-in', 'triage']);
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const BRAINSTORMER_DENY_MESSAGE = 'You are running unattended. Put your questions in result.json\'s `questions` list; the stand-in answers them.';

export function denyMessageFor(phaseKind) {
  return phaseKind === 'brainstorm' ? BRAINSTORMER_DENY_MESSAGE : UNATTENDED_DENY_MESSAGE;
}

const CONTRACT_FILE = 'contract.md';
const REVIEW_PURPOSES = new Set(['review', 'task-review']);
const WORK_PURPOSES = new Set(['implement', 'fix']);
const TARGET_PURPOSES = new Set(['review', 'fix', 'verify']);

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function checkRole(role) {
  if (!ROLE_NAME.test(role ?? '')) throw Object.assign(new Error(`superagent: invalid role name ${JSON.stringify(role)}`), { code: 'ERR_NO_TEMPLATE' });
  if (`${role}.md` === CONTRACT_FILE) throw Object.assign(new Error('superagent: contract is not a role'), { code: 'ERR_NO_TEMPLATE' });
}

// `recordedPrompt` is the job's absolute workflow prompt path, or null for the
// built-in. An absolute promptField resolves to itself, so it stands in for
// the workflow file's prompt in the one lookup order.
async function resolveTemplate(role, projectDir, recordedPrompt) {
  checkRole(role);
  const found = await resolvePromptPath(role, { projectDir, workflowFile: recordedPrompt, promptField: recordedPrompt });
  if (found == null && recordedPrompt != null) {
    throw Object.assign(new Error(`superagent: the workflow prompt for role ${JSON.stringify(role)} is missing: ${recordedPrompt}`), { code: 'ERR_PROMPT_MISSING', path: recordedPrompt });
  }
  return found;
}

async function loadRoleTemplate(role, projectDir, recordedPrompt = null) {
  const found = await resolveTemplate(role, projectDir, recordedPrompt);
  return found == null ? null : readIfExists(found.path);
}

export async function hasTemplate(role, { projectDir, recordedPrompt = null }) {
  try {
    return (await resolveTemplate(role, projectDir, recordedPrompt)) != null;
  } catch (err) {
    if (err.code === 'ERR_NO_TEMPLATE' || err.code === 'ERR_PROMPT_MISSING') return false;
    throw err;
  }
}

const KEYED_BY_PHASE_OUTPUT = new Set(['author', 'ask', 'test', 'feedback-plan']);

function keyedOutputs(job, phase, { purpose, round, task, feedbackRound, reportOrdinal }) {
  const list = requiredOutputs(job, { phase, purpose, round, task, feedbackRound, reportOrdinal });
  if (purpose === 'answer') return {};
  if (purpose === 'triage') return { triage: list[0] };
  if (KEYED_BY_PHASE_OUTPUT.has(purpose)) return Object.fromEntries((phase.outputs ?? []).map((key, i) => [key, list[i]]));
  const paths = reviewPaths(job, { phase: phase.phase, round, taskId: task, feedbackRound });
  const key = Object.keys(paths).find((k) => paths[k] === list[0]);
  return { [key]: list[0] };
}

function settledExchanges(job, attempt) {
  const index = new Map(job.attempts.map((a, i) => [a.attemptId, i]));
  const own = index.get(attempt.attemptId) ?? job.attempts.length;
  return brainstormLog(job).filter((e) => e.tag !== null && (index.get(e.answeredBy) ?? Infinity) < own);
}

// A round-scoped phase hears only its own round's answers.
function userAnswersFor(job, phaseId, task, feedbackRound) {
  const scoped = isRoundScoped(job, phaseId);
  const asked = new Map(job.attempts.filter((a) => a.phase === phaseId && (a.task ?? null) === task && (!scoped || roundOf(a) === feedbackRound)).map((a) => [a.attemptId, a.question]));
  return (job.answers ?? []).filter((a) => asked.has(a.forAttemptId)).map((a) => ({ question: a.question ?? asked.get(a.forAttemptId), answer: a.answer }));
}

const roundEntry = (job, round) => (job.feedbackRounds ?? []).find((r) => r.round === round) ?? null;
const decisionOf = (job, entry) => (entry.attemptId == null ? null : (job.attempts.find((a) => a.attemptId === entry.attemptId)?.triage ?? null));

// Every round up to the attempt's, oldest first. A round not routed yet (the
// triage attempt's own) has no triage file or requirement changes; a subplan
// round also names its task-writing outputs.
function feedbackFor(job, feedbackRound) {
  const writes = feedbackShape(job)?.taskWriting.outputs ?? [];
  return (job.feedbackRounds ?? []).filter((r) => r.round <= feedbackRound).map((entry) => ({
    round: entry.round,
    text: entry.text,
    route: entry.route ?? null,
    triage: entry.route == null ? null : roundTriagePath(job, entry.round),
    requirementChanges: entry.route == null ? null : (decisionOf(job, entry)?.requirementChanges ?? null),
    pendingChanges: entry.pendingChanges ?? {},
    ...(entry.route === 'subplan' ? { outputs: roundOutputPaths(job, entry.round, writes) } : {}),
  }));
}

// Spec Flow 2: triage reads the feedback beside every earlier round's decision
// and files, and the latest test report a done tester wrote.
function triageFields(job, shape, feedbackRound) {
  const earlierRounds = (job.feedbackRounds ?? []).filter((r) => r.round < feedbackRound).map((entry) => {
    const decided = decisionOf(job, entry);
    return {
      round: entry.round,
      text: entry.text,
      route: entry.route,
      summary: decided?.summary ?? null,
      requirementChanges: decided?.requirementChanges ?? null,
      ...(decided?.idea != null ? { idea: decided.idea } : {}),
      triage: entry.route == null ? null : roundTriagePath(job, entry.round),
      folder: roundDir(job, entry.round),
    };
  });
  let latestTestReport = null;
  if (shape) {
    const last = job.attempts.filter((a) => a.phase === shape.test.phase && a.outcome === 'done').at(-1);
    const paths = artifactPaths(job);
    latestTestReport = last && roundOf(last) > 0 && Number.isInteger(last.reportOrdinal)
      ? roundTestReportPaths(job, roundOf(last), last.reportOrdinal)
      : Object.fromEntries((shape.test.outputs ?? []).map((key) => [key, paths[key]]));
  }
  return { feedbackText: roundEntry(job, feedbackRound)?.text ?? null, earlierRounds, latestTestReport };
}

// A round's card never names an original file the round replaces. Triage reads
// the job's requirement artifacts, plan, tasks and test report; the round's
// planner also reads the requirement artifacts; once a sub-plan is routed, its
// plan review and implementers read the round's files in place of the
// task-writing outputs; every routed round adds its triage.md. Returns the
// inputs and, apart, any original requirement artifact they do not name.
function cardInputs(job, phase, attempt) {
  const paths = artifactPaths(job);
  const resolve = (keys) => Object.fromEntries([...new Set(keys)].filter((k) => k in paths).map((k) => [k, paths[k]]));
  const own = (phase?.inputs ?? []).filter((k) => k !== 'idea');
  const feedbackRound = roundOf(attempt);
  const shape = feedbackRound > 0 ? feedbackShape(job) : null;
  if (!shape) return { inputs: resolve(own) };
  if (attempt.purpose === 'triage') return { inputs: resolve([...shape.requirementKeys, ...(shape.taskWriting.outputs ?? []), ...(shape.test.outputs ?? [])]) };
  const inputs = resolve(phase?.phase === shape.taskWriting.phase ? [...own, ...shape.requirementKeys] : own);
  const entry = roundEntry(job, feedbackRound);
  if (entry?.route === 'subplan' && (phase?.phase === shape.planReview?.phase || phase?.phase === shape.perTask.phase)) {
    const round = roundOutputPaths(job, feedbackRound, shape.taskWriting.outputs ?? []);
    for (const key of Object.keys(inputs)) if (key in round) inputs[key] = round[key];
  }
  if (entry?.route != null && !('triage' in inputs)) inputs.triage = roundTriagePath(job, feedbackRound);
  // Every role judges against the original requirement artifacts amended by
  // feedback: one that inputs lack, or name by a round file, goes here.
  const requirements = resolve(shape.requirementKeys.filter((k) => inputs[k] !== paths[k]));
  return { inputs, ...(Object.keys(requirements).length > 0 ? { requirements } : {}) };
}

function purposeFields(job, phase, attempt) {
  const { purpose } = attempt;
  const round = attempt.round ?? null;
  const task = attempt.task ?? null;
  const feedbackRound = roundOf(attempt);
  const reportOrdinal = attempt.reportOrdinal ?? null;
  const phaseId = attempt.phase ?? phase.phase;
  const shape = feedbackRound > 0 ? feedbackShape(job) : null;
  const done = attemptsFor(job, phaseId, task, feedbackRound).filter((a) => a.outcome === 'done');
  const reviewFile = (r) => {
    const paths = reviewPaths(job, { phase: phase.phase, round: r, taskId: task, feedbackRound });
    return task != null ? paths.taskReview : paths.review;
  };

  let previousFindings = null;
  if (purpose === 'fix' && done.some((a) => REVIEW_PURPOSES.has(a.purpose) && a.round === round)) previousFindings = reviewFile(round);
  else if (REVIEW_PURPOSES.has(purpose) && round > 1) previousFindings = reviewFile(round - 1);

  // An extra round (Decision 10) runs its fix before its review, so that fix shares the review's round.
  let previousResponse = null;
  if (purpose === 'review' && round > 1) {
    const fixRound = round > (phase.maxRounds ?? DEFAULT_REVIEW_ROUNDS) ? round : round - 1;
    previousResponse = reviewPaths(job, { phase: phase.phase, round: fixRound, feedbackRound }).response;
  }

  let reviewFindings = null;
  let reviseOutputs = null;
  if (purpose === 'fix') {
    reviewFindings = (attempt.reviewFindings ?? []).map((f) => (typeof f === 'string' ? { id: f } : { id: f.id, severity: f.severity, text: f.text }));
    if (task == null) {
      const paths = artifactPaths(job);
      const keyed = feedbackRound > 0 ? roundOutputPaths(job, feedbackRound, Object.keys(paths)) : paths;
      reviseOutputs = Object.fromEntries(reviseSet(job, phase, { feedbackRound }).map((rel) => [Object.keys(keyed).find((k) => keyed[k] === rel), rel]));
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

  const exchanges = phase.kind === 'brainstorm' ? settledExchanges(job, attempt) : null;
  const userAnswers = exchanges ? [] : userAnswersFor(job, phaseId, task, feedbackRound);

  let target = null;
  if (TARGET_PURPOSES.has(purpose) && task == null && phase.target) {
    target = shape && phase.phase === shape.planReview?.phase
      ? roundOutputPaths(job, feedbackRound, [phase.target])[phase.target]
      : (artifactPaths(job)[phase.target] ?? null);
  }
  return {
    purpose,
    round,
    final: attempt.final ?? false,
    target,
    outputs: keyedOutputs(job, phase, { purpose, round, task, feedbackRound, reportOrdinal }),
    reviseOutputs,
    task: attempt.taskDef ?? (task != null ? (job.tasks ?? []).find((t) => t.id === task) ?? null : null),
    taskCommits,
    previousFindings,
    ...(purpose === 'review' ? { previousResponse } : {}),
    reviewFindings,
    contested,
    ...(exchanges ? { exchanges } : {}),
    ...(purpose === 'answer' ? { openQuestions: attempt.openQuestions ?? [] } : {}),
    ...(purpose === 'ask' ? { maxQuestions: BRAINSTORM_BATCH } : {}),
    ...(userAnswers.length > 0 ? { userAnswers } : {}),
    ...(purpose === 'triage' ? triageFields(job, shape, feedbackRound) : {}),
  };
}

export async function buildWorkerPrompt({ role, job, phase, attempt, projectDir }) {
  const template = await loadRoleTemplate(role, projectDir, job.prompts?.[role] ?? null);
  if (template == null) throw Object.assign(new Error(`superagent: no prompt template for role ${JSON.stringify(role)}`), { code: 'ERR_NO_TEMPLATE' });
  const contract = await fs.readFile(path.join(templatesDir(), CONTRACT_FILE), 'utf8');

  const paths = artifactPaths(job);
  const resolve = (keys) => Object.fromEntries(keys.filter((k) => k in paths).map((k) => [k, paths[k]]));
  const { inputs, requirements } = cardInputs(job, phase, attempt);
  const outputs = resolve(phase?.outputs ?? []);
  const feedbackRound = roundOf(attempt);
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
    repos: primaryFirst.map((r) => ({
      id: r.id,
      worktree: r.worktree,
      branch: job.branch,
      ...(r.inPlace === true && { inPlace: true }),
      ...(r.inPlace === true && r.pendingChanges && { pendingChanges: r.pendingChanges }),
    })),
    inputs,
    ...(requirements ? { requirements } : {}),
    outputs,
    ...(job.artifactRoot === 'ledger' ? { artifactRoot: ledgerArtifactRoot(job.jobId) } : { artifactsCommitted: true }),
    commitTests: job.commitTests,
    testPaths: job.testPaths,
    attemptDir: attempt.dir,
    round: null,
    previousFindings: null,
    recoveryNote: attempt.recovery ? RECOVERY_NOTE : null,
    previousAttemptDir: previous?.dir ?? null,
    ...(previous?.outcome === 'failed' ? { previousFailure: { reason: previous.reason ?? null, detail: previous.detail ?? null } } : {}),
    handoff: attempt.handoff ?? null,
    ...(attempt.retryNote ? { retryNote: attempt.retryNote } : {}),
    ...(attempt.retryErrors != null ? { retryErrors: attempt.retryErrors } : {}),
    ...(READ_ONLY_ROLES.has(role) ? { resultVia: 'final-message' } : {}),
    ...(attempt.purpose ? purposeFields(job, phase, attempt) : {}),
    ...(feedbackRound > 0 ? { feedback: feedbackFor(job, feedbackRound) } : {}),
    ...(job.tasks ? { effectiveTasks: job.tasks.map(({ id, title, repos, acceptance, verify, origin }) => ({ id, title, repos, acceptance, verify, origin })) } : {}),
  };
  return {
    system: `${template.trimEnd()}\n\n${contract}`,
    card: `# Superagent job card\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`,
  };
}

function commitPathHint(error) {
  const tests = error.startsWith('commit includes test files: ');
  if (!tests && !error.startsWith('commit includes superagent files: ')) return '';
  const rewrite = 'A later commit does not take that commit off the branch: rewrite it (`git commit --amend`, or `git reset --soft` to before it), then re-commit by explicit path. If you did not make that commit (the user\'s own commit or a merge on the branch), do not rewrite it: publish `blocked` and name the commit.';
  return tests ? `${rewrite} What counts as a test comes from \`testPaths\` on your card; if a path is matched wrongly, say so in your result rather than renaming files.\n` : `${rewrite}\n`;
}

// `attempt.ledger` is true for a job whose artifacts live in the ledger.
export function nudgeText(kind, attempt) {
  if (kind === 'invalid-result') {
    const error = attempt.error || 'no reason given';
    if (attempt.readOnly) return `Your result was rejected: ${error}\nReply with only the corrected result JSON object as your final message.`;
    return `Your \`result.json\` in ${attempt.dir} was rejected: ${error}\n${commitPathHint(error)}Fix that, ${attempt.ledger ? 'write' : 'commit'} any output you change, then publish \`result.json\` again via \`result.json.tmp\` and rename.`;
  }
  if (attempt.readOnly) return 'No result was received. Reply with only the result JSON object as your final message.';
  if (kind === 'turn-cap') {
    return `The turn limit was reached. If only writing your outputs remains, do that now and publish \`result.json\` with \`status: done\`. Otherwise write \`handoff.md\` in ${attempt.dir} (current state and next steps). Either way, publish \`result.json\` there via \`result.json.tmp\` and rename.`;
  }
  return `No \`result.json\` was published. Publish it now in ${attempt.dir}: write \`result.json.tmp\`, then rename it to \`result.json\`.`;
}
