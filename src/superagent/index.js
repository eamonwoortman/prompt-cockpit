// Superagent supervisor: createSuperagent owns one heartbeat that reviews and
// advances every running job, plus job creation, accept, giveFeedback,
// answerQuestion, retryJob, renameJob and stop.
//
// Modelled on createAutopilot (src/autopilot.js): everything injected, one
// timer, a tick that never overlaps itself, an idempotent start/stop and a
// bounded wait for the in-flight tick on stop. It is a separate timer from
// auto-pilot's (spec Decision 1); src/superagent-host.js wires it into
// src/server.js.
//
// Per-job serialisation: tick's job step, createJob's provisioning, stopJob,
// accept, giveFeedback, answerQuestion, retryJob and renameJob all run on one promise chain per job (withJob),
// so a stop can never interleave with a launch. stopJob marks the job in
// stopRequested synchronously, before it queues, so a tick step already
// waiting on a budget check sees the stop on its recheck and launches nothing.
// It also aborts the job's provisioning controller before it queues: that
// kills a running `git worktree add`, whose half-made worktree is removed,
// and provision() records job-stopped itself, so the queued stop finds the
// job already stopped.
//
// A rejected store append may still have landed, and store.get() keeps
// serving the last good state until the next append or load re-reads. Every
// job step that sees a rejection reloads before anything decides again, and an
// attempt the store shows in flight with no live runner entry is reconciled,
// never launched beside.
//
// Routing (Plan 4, Decisions 7, 9 and 10): with a router injected, a `route`
// action's model call runs in the background, never awaited by the tick. The
// job's { controller, promise } sits in `routing` from the first line of
// routeStep until the call settles, and stepJob skips a job with an entry.
// stopJob aborts that job's controller and stop() aborts all of them, before
// anything is awaited. A decision whose append did not land waits in
// pendingDecisions and is appended again on the next tick, so the model is
// never called twice for one attempt.
//
// In-place safety gate (Plan 7): a launch, and the task-list read, of a job
// with an in-place repo first checks every such folder (inPlaceGate). A failed
// check pauses the job with needs-you folder-changed; runTick re-checks a
// paused job every heartbeat and appends folder-restored once it passes. The
// runner checks again immediately before createSession.
//
// Accounting (spec C): after each tick every known job is handed to the
// accounting queue (accounting.js), never awaited; stop() gives it the same
// absolute deadline as the in-flight tick. The queue also snapshots each
// attempt's artifacts into <jobDir>/artifacts (artifacts.js).
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAccounting } from './accounting.js';
import { artifactStates as readArtifactStates, snapshotDirFor } from './artifacts.js';
import { isValidBranchName } from './branch-name.js';
import { FIXTURES, STAND_IN_ROLE, defaultSuperagentRoot, resolveEngineModel, templateFor, validateMilestoneFixture } from './config.js';
import { currentRound, feedbackEligibility, feedbackShape, roundOf, roundOutputPaths } from './feedback.js';
import { checkGate, checkInPlace, folderChangedEvent, normaliseTop, provisionInPlace, readPendingChanges, refuseJobBranch } from './inplace.js';
import { hasTemplate } from './prompts.js';
import { RESULT_FILE, artifactPaths, attemptDir, ledgerArtifactRoot, parseTasks, primaryRepo } from './results.js';
import { allowedActions, buildRouterRequest } from './router.js';
import { createRunner } from './runner.js';
import { RUNNABLE_KINDS, attemptsFor, buildFixTask, gatedOut, nextAction } from './sequencer.js';
import { legacyPipeline } from './store.js';
import { createTranscriptIndex } from './transcripts.js';
import { CONFIG_PIPELINE_ID, ROLE_NAME, loadWorkflows, resolvePromptPath, resolveWorkflowModels, sameWorkflowId, substituteArtifacts, workflowsDir } from './workflows.js';
import { BRANCH_PREFIX, archiveLedger, checkRepo, createWorktree, defaultGit, ensureRepo, listOrphanWorktrees, removeAbortedWorktree, repoIds, repoToplevel, slugify } from './worktree.js';

export const TICK_MS = 15_000;
const ANSWER_MAX_CHARS = 4000;
export const TITLE_MAX_CHARS = 200;
const FINISHED_STATES = new Set(['done', 'stopped', 'failed']);

// Decision 14: MAX_PATH less its terminating NUL. Validation bounds phase ids
// at 24 characters and task ids at 12; attempt ids are uuids. On win32 the
// title part of the slug shrinks to fit, down to SLUG_BASE_MIN.
const WIN32_PATH_LIMIT = 259;
const TASK_ID_MAX = 12;
const ATTEMPT_ID_LENGTH = 36;
const SLUG_BASE_MAX = 40;
const SLUG_BASE_MIN = 8;

const messageOf = (err) => String(err?.message ?? err);
const hasInPlace = (job) => (job?.repos ?? []).some((r) => r.inPlace === true);
const pausedForFolder = (job) => job?.state === 'needs-you' && job.reason === 'folder-changed';
const pad = (n) => String(n).padStart(2, '0');

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pipelineRoles(pipeline) {
  const roles = [];
  for (const p of pipeline) {
    if (p.kind !== 'human') roles.push(p.role);
    if (p.kind === 'brainstorm') roles.push(STAND_IN_ROLE);
    if (p.kind === 'review') roles.push(p.author);
    if (p.kind === 'per-task' && p.taskReview !== undefined) roles.push(p.taskReview);
  }
  if (pipeline.some((p) => p.kind === 'review' || p.kind === 'per-task')) roles.push('verifier');
  return [...new Set(roles)];
}

// A blocker the verifier confirmed reaches the sequencer as a question that
// carries evidence; an attempt's own question carries none.
function needsYouDetail({ reason, detail }) {
  if (reason !== 'question' || detail?.evidence == null) return detail;
  const { attemptId, question, evidence, phase, task } = detail;
  return { kind: 'blocker', text: question, evidence, attemptId, phase, task };
}

const hasDecision = (job, attemptId) => (job?.routerDecisions ?? []).some((d) => d.forAttemptId === attemptId);
const roundEntry = (job, round) => (job?.feedbackRounds ?? []).find((r) => r.round === round) ?? null;

// Saved tests come and go as workers restore and remove them; the current
// round's own folder is what the round is about to write.
const SAVED_TESTS_RE = /^tasks\/[^/]+-tests\//;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const ledgerDir = (job) => path.join(primaryRepo(job).worktree, ...ledgerArtifactRoot(job.jobId).split('/'));
const baselineCopyDir = (jobDir, round) => path.join(jobDir, 'feedback', `round-${round}`, 'baseline');

// Every file under the job's ledger artifact root, keyed relative to it, with
// the SHA-256 of its bytes: what no attempt in the round may change. The same
// bytes are copied under `copyDir`, out of the workers' reach, for Retry.
async function feedbackBaseline(job, round, copyDir) {
  const root = ledgerDir(job);
  let names;
  try {
    names = await readdir(root, { recursive: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
  const roundPrefix = `feedback/round-${round}/`;
  const baseline = {};
  for (const name of names.map((n) => n.split(path.sep).join('/')).sort()) {
    if (name.toLowerCase().startsWith(roundPrefix) || SAVED_TESTS_RE.test(name)) continue;
    const file = path.join(root, ...name.split('/'));
    if (!(await stat(file)).isFile()) continue;
    const data = await readFile(file);
    const copy = path.join(copyDir, ...name.split('/'));
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, data);
    baseline[name] = sha256(data);
  }
  return baseline;
}

// Retry in a round puts back every baseline file a worker changed or removed,
// from the copy taken when feedback was given. A copy that is missing or no
// longer matches its recorded hash is skipped: the round then stays refused
// on that file, as it would without the copy.
async function restoreBaseline(job, round, copyDir, log) {
  const baseline = (job.feedbackRounds ?? []).find((r) => r.round === round)?.baseline ?? {};
  const root = ledgerDir(job);
  for (const [name, hash] of Object.entries(baseline)) {
    const file = path.join(root, ...name.split('/'));
    const current = await readFile(file).catch(() => null);
    if (current && sha256(current) === hash) continue;
    const copy = await readFile(path.join(copyDir, ...name.split('/'))).catch(() => null);
    if (!copy || sha256(copy) !== hash) {
      log(`job ${job.jobId} round ${round}: no good copy of ${name} to restore`);
      continue;
    }
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, copy);
    } catch (err) {
      log(`job ${job.jobId} round ${round}: could not restore ${name}`, err);
    }
  }
}

// The id of a feedback round's fix task, unique per triage attempt and
// reserved in parseTasks (FEEDBACK_TASK_ID_RE).
function feedbackFixTask(round, attemptId, task) {
  return { id: `B${round}-${attemptId.slice(0, 8)}`, title: task.title, repos: [...task.repos], dependsOn: [], acceptance: task.acceptance, verify: task.verify ?? '' };
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function createSuperagent({
  registry,
  store,
  config,
  git = defaultGit,
  worktreesRoot = path.join(defaultSuperagentRoot(), 'worktrees'),
  now = Date.now,
  idImpl = randomUUID,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  budgetCheck = () => ({ allow: true }),
  stopTickDeadlineMs = 2_000,
  logImpl = console.error,
  platform = process.platform,
  router = null,
  workflowDirs = { builtin: workflowsDir(), global: path.join(defaultSuperagentRoot(), 'workflows') },
  transcripts = createTranscriptIndex(),
}) {
  const runner = createRunner({ registry, store, git, now, idImpl, logImpl, beforeSession: inPlaceGate });
  const accounting = createAccounting({ store, transcripts, isLive: (sessionId) => sessionId != null && registry.get(sessionId) != null, now, logImpl });
  const known = new Set();
  const corrupt = new Map();
  const chains = new Map();
  const provisioningNow = new Set();
  const stopRequested = new Set();
  const routing = new Map();
  // jobId -> the AbortController of its running provision().
  const provisioning = new Map();
  const pendingDecisions = new Map();
  // Decision 7: normalised top level -> [{ jobId, inPlace }], held from the
  // start of createJob's folder preflight until the job is finished.
  const reservations = new Map();
  let maxConcurrentSessions = config.resolve(null).maxConcurrentSessions;
  let stopping = false;
  let timer = null;
  let unintercept = null;
  let starting = null;
  let ticking = null;

  function log(message, err) {
    try {
      logImpl(`superagent: ${message}${err === undefined ? '' : `: ${messageOf(err)}`}`);
    } catch { /* logging must never break the supervisor */ }
  }

  // Registered once, here: a removal between stop() and start() must still
  // reach the runner (same reason as src/autopilot.js's constructor).
  registry.addSessionRemovedListener(runner.onSessionRemoved);

  // Every in-place repo of the job, in order; the first failure wins.
  async function inPlaceGate(job) {
    for (const repo of job.repos) {
      if (repo.inPlace !== true) continue;
      const check = await checkGate({ git, folder: repo.worktree, branch: job.branch, baseSha: repo.baseSha });
      if (!check.ok) return { ok: false, text: check.text, folder: repo.worktree };
    }
    return { ok: true };
  }

  function withJob(jobId, fn) {
    const prev = chains.get(jobId) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    chains.set(jobId, run);
    run.finally(() => {
      if (chains.get(jobId) === run) chains.delete(jobId);
    }).catch(() => {});
    return run;
  }

  function holder(key, { jobId, inPlace }) {
    return (reservations.get(key) ?? []).find((r) => r.jobId !== jobId && (inPlace || r.inPlace)) ?? null;
  }

  function hold(key, { jobId, inPlace }) {
    const entries = reservations.get(key) ?? [];
    const own = entries.find((r) => r.jobId === jobId);
    if (own) own.inPlace ||= inPlace;
    else reservations.set(key, [...entries, { jobId, inPlace }]);
  }

  // All or nothing: a conflict on any key takes none of them.
  function reserve(jobId, wanted) {
    for (const { key, folder, inPlace } of wanted) {
      const other = holder(key, { jobId, inPlace });
      if (other) throw fail('ERR_FOLDER_IN_USE', `superagent: ${folder} is in use by job ${other.jobId}, which is not finished`);
    }
    for (const { key, inPlace } of wanted) hold(key, { jobId, inPlace });
  }

  function release(jobId) {
    for (const [key, entries] of reservations) {
      const kept = entries.filter((r) => r.jobId !== jobId);
      if (kept.length === 0) reservations.delete(key);
      else if (kept.length !== entries.length) reservations.set(key, kept);
    }
  }

  function releaseIfFinished(jobId) {
    if (FINISHED_STATES.has(store.get(jobId)?.state)) release(jobId);
  }

  // A repo recorded before Plan 7 has no toplevel and is asked git for it; a
  // git failure keeps the origin key alone. Keys are held only after every
  // lookup, for jobs still unfinished then, so a stop meanwhile is not undone.
  async function rebuildReservations() {
    const wanted = [];
    for (const jobId of known) {
      const job = store.get(jobId);
      if (!job || FINISHED_STATES.has(job.state)) continue;
      for (const repo of job.repos) {
        const keys = [normaliseTop(repo.origin, platform)];
        let toplevel = repo.toplevel;
        if (!toplevel) {
          try {
            toplevel = await repoToplevel({ git, origin: repo.origin });
          } catch (err) {
            log(`could not find the top level of ${repo.origin} for job ${jobId}, reserving the folder itself`, err);
          }
        }
        if (toplevel) keys.push(normaliseTop(toplevel, platform));
        wanted.push({ jobId, keys, inPlace: repo.inPlace });
      }
    }
    for (const { jobId, keys, inPlace } of wanted) {
      if (FINISHED_STATES.has(store.get(jobId)?.state)) continue;
      for (const key of keys) hold(key, { jobId, inPlace });
    }
  }

  async function reload(jobId) {
    try {
      return await store.load(jobId);
    } catch (err) {
      log(`could not reload job ${jobId}`, err);
      return store.get(jobId);
    }
  }

  // Appends, and on a rejection re-reads to see whether the event landed.
  async function appendConfirmed(jobId, event, landed) {
    try {
      await store.append(jobId, event);
    } catch (err) {
      const job = await store.load(jobId).catch(() => null);
      if (!job || !landed(job)) throw err;
      log(`a ${event.type} append for job ${jobId} reported failure but landed`, err);
    }
    return store.get(jobId);
  }

  async function archive(job) {
    const primary = primaryRepo(job);
    if (!primary?.worktree) return;
    try {
      await archiveLedger({ worktree: primary.worktree, jobId: job.jobId, destDir: path.join(store.jobDir(job.jobId), 'ledger') });
    } catch (err) {
      log(`could not archive the ledger of job ${job.jobId}`, err);
    }
  }

  async function requireJob(jobId) {
    if (corrupt.has(jobId)) throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} has a corrupt event log`);
    const job = store.get(jobId) ?? (await store.load(jobId).catch(() => null));
    if (!job) throw fail('ERR_UNKNOWN_JOB', `superagent: no job ${jobId}`);
    known.add(jobId);
    return job;
  }

  const stepStale = (jobId) => stopping || stopRequested.has(jobId) || store.get(jobId)?.state !== 'running';

  // True when the job may go on: a failed gate pauses it (unless it was
  // stopped or moved on during the check).
  async function passGate(jobId, job) {
    const check = await inPlaceGate(job);
    if (stepStale(jobId)) return false;
    if (check.ok) return true;
    await store.append(jobId, folderChangedEvent(check));
    return false;
  }

  async function launchStep(jobId, job, action) {
    if (hasInPlace(job) && !(await passGate(jobId, job))) return;
    let verdict;
    try {
      verdict = await budgetCheck({ job, action });
    } catch (err) {
      log(`budget check for job ${jobId} failed, not launching`, err);
      return;
    }
    if (stepStale(jobId)) return;
    if (!verdict?.allow) {
      const text = verdict?.reason ?? 'budget check refused the launch';
      await store.append(jobId, { type: 'needs-you', reason: 'question', detail: { kind: 'budget', text } });
      return;
    }
    const result = await runner.launch(store.get(jobId), action);
    if (result?.error === 'store-failed') await reload(jobId);
  }

  async function loadTasksStep(jobId, job) {
    if (hasInPlace(job) && !(await passGate(jobId, job))) return;
    const rel = artifactPaths(job).tasks;
    let parsed;
    try {
      parsed = parseTasks(await readFile(path.join(primaryRepo(job).worktree, ...rel.split('/')), 'utf8'), job);
    } catch (err) {
      // Anything but a missing file (EBUSY, EPERM...) may pass: the step's
      // catch logs and reloads, and the next tick retries.
      if (err?.code !== 'ENOENT') throw err;
      parsed = { ok: false, errors: [`could not read ${rel}: ${messageOf(err)}`] };
    }
    if (stepStale(jobId)) return;
    if (parsed.ok) {
      await store.append(jobId, { type: 'tasks-loaded', tasks: parsed.tasks });
    } else {
      await store.append(jobId, { type: 'needs-you', reason: 'stuck', detail: { why: 'tasks-invalid', errors: parsed.errors } });
    }
  }

  // deriveJob ignores a second test-routed for the same attempt, so a replay
  // after a rejected append that landed is harmless.
  async function routeTestFailureStep(jobId, job, { attemptId, findings }) {
    const event = { type: 'test-routed', attemptId, task: buildFixTask(job, attemptId, findings) };
    await appendConfirmed(jobId, event, (j) => (j.tasks ?? []).some((t) => t.fromAttemptId === attemptId));
  }

  // The done triage's decision, recorded once per round: deriveJob ignores a
  // second feedback-routed for a round already routed.
  async function routeFeedbackStep(jobId, job, { round, attemptId }) {
    const decision = job.attempts.find((a) => a.attemptId === attemptId)?.triage;
    if (!decision) throw new Error(`superagent: triage attempt ${attemptId} has no decision to route`);
    const event = {
      type: 'feedback-routed',
      round,
      attemptId,
      route: decision.route,
      ...(decision.route === 'fix' && { task: feedbackFixTask(round, attemptId, decision.task) }),
    };
    await appendConfirmed(jobId, event, (j) => roundEntry(j, round)?.route != null);
  }

  // A subplan round's tasks, checked against the tasks the job had before them
  // (loadTasksStep's gate and read rules). deriveJob ignores a second
  // tasks-appended for the round.
  async function appendRoundTasksStep(jobId, job, { round }) {
    if (hasInPlace(job) && !(await passGate(jobId, job))) return;
    const rel = roundOutputPaths(job, round, ['tasks']).tasks;
    let parsed;
    try {
      parsed = parseTasks(await readFile(path.join(primaryRepo(job).worktree, ...rel.split('/')), 'utf8'), job, { existing: job.tasks ?? [] });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      parsed = { ok: false, errors: [`could not read ${rel}: ${messageOf(err)}`] };
    }
    if (stepStale(jobId)) return;
    if (parsed.ok) {
      const tasks = parsed.tasks.map((t) => ({ ...t, origin: 'feedback', round }));
      await appendConfirmed(jobId, { type: 'tasks-appended', round, tasks }, (j) => roundEntry(j, round)?.tasksAppended === true);
    } else {
      await store.append(jobId, { type: 'needs-you', reason: 'stuck', detail: { why: 'tasks-invalid', errors: parsed.errors, round } });
    }
  }

  // A decision that did not land is kept for the next tick (Decision 10).
  async function appendDecision(jobId, event) {
    try {
      await appendConfirmed(jobId, event, (j) => hasDecision(j, event.forAttemptId));
      pendingDecisions.delete(jobId);
    } catch (err) {
      pendingDecisions.set(jobId, event);
      log(`could not record the router decision for job ${jobId}, retrying next tick`, err);
      await reload(jobId);
    }
  }

  async function retryPendingDecision(jobId) {
    const event = pendingDecisions.get(jobId);
    const job = await reload(jobId);
    if (stopping || stopRequested.has(jobId)) return;
    if (job?.state !== 'running' || hasDecision(job, event.forAttemptId)) {
      pendingDecisions.delete(jobId);
      return;
    }
    await appendDecision(jobId, event);
  }

  // Decision 9: the routed attempt is still its scope's last and undecided.
  function routeStale(jobId, controller, action) {
    if (stopping || stopRequested.has(jobId) || controller.signal.aborted) return true;
    const job = store.get(jobId);
    if (job?.state !== 'running' || hasDecision(job, action.forAttemptId)) return true;
    return attemptsFor(job, action.phase, action.task ?? null).at(-1)?.attemptId !== action.forAttemptId;
  }

  function decisionEvent(job, action, request, result) {
    const ok = result?.ok === true;
    return {
      type: 'router-decided',
      forAttemptId: action.forAttemptId,
      action: ok ? result.action : 'escalate',
      note: ok ? (result.note ?? null) : null,
      ok,
      error: ok ? null : String(result?.error ?? 'router returned no result'),
      model: job.models.router.model,
      request: { estimatedTokens: request.estimatedTokens, truncated: request.truncated },
      usage: result?.usage ?? null,
      latencyMs: result?.latencyMs ?? null,
    };
  }

  function callRouter(jobId, job, action, request, allowed, controller) {
    return (async () => {
      let result;
      try {
        result = await router.decide({
          model: job.models.router.model,
          allowlist: job.router.allowlist,
          system: request.system,
          card: request.card,
          allowed,
          maxOutputTokens: job.router.maxOutputTokens,
          signal: controller.signal,
        });
      } catch (err) {
        result = { ok: false, error: messageOf(err), usage: null, latencyMs: 0 };
      }
      // Only an abort this supervisor caused is dropped; an 'aborted' error
      // from anywhere else is a router failure and is recorded as one.
      if (controller.signal.aborted || stopping) return;
      const event = decisionEvent(job, action, request, result);
      await withJob(jobId, async () => {
        if (routeStale(jobId, controller, action)) return;
        await appendDecision(jobId, event);
      });
    })();
  }

  // Awaited by the tick up to the model call, which is handed off to `routing`.
  async function routeStep(jobId, job, action) {
    const controller = new AbortController();
    const entry = { controller, promise: null };
    routing.set(jobId, entry);
    try {
      let verdict;
      try {
        verdict = await budgetCheck({ job, action });
      } catch (err) {
        log(`budget check for job ${jobId} failed, not routing`, err);
        return;
      }
      if (routeStale(jobId, controller, action)) return;
      if (!verdict?.allow) {
        const text = verdict?.reason ?? 'budget check refused the router call';
        await store.append(jobId, { type: 'needs-you', reason: 'question', detail: { kind: 'budget', text } });
        return;
      }
      const dir = action.previousDir ?? null;
      const handoffExists = dir !== null && (await fileExists(path.join(dir, 'handoff.md')));
      if (routeStale(jobId, controller, action)) return;

      const current = store.get(jobId);
      const allowed = allowedActions({ model: action.model, alternate: action.alternate, handoffExists });
      const trigger = {
        attemptId: action.forAttemptId,
        phase: action.phase,
        task: action.task,
        role: action.role,
        model: action.lastModel ?? null,
        reason: action.reason,
        status: action.status,
        summary: action.summary,
        question: action.question,
        signature: action.signature,
        detail: action.detail ?? null,
        attemptsUsed: action.attemptsUsed,
        attemptsLeft: action.attemptsLeft,
        allowed,
        resultPath: dir === null ? null : path.join(dir, RESULT_FILE),
      };
      const { maxInputTokens } = current.router;
      const request = buildRouterRequest(current, trigger, { maxInputTokens });
      if (!request.ok) {
        const error = `over-limit: estimated ${request.estimatedTokens} tokens > ${maxInputTokens}`;
        await appendDecision(jobId, { ...decisionEvent(current, action, request, { ok: false, error }), usage: null, latencyMs: 0 });
        return;
      }
      entry.promise = callRouter(jobId, current, action, request, allowed, controller)
        .catch((err) => log(`routing failed for job ${jobId}`, err))
        .finally(() => {
          if (routing.get(jobId) === entry) routing.delete(jobId);
        });
    } finally {
      if (entry.promise === null && routing.get(jobId) === entry) routing.delete(jobId);
    }
  }

  async function stepJob(jobId) {
    if (stopping || provisioningNow.has(jobId)) return;
    let job = store.get(jobId);
    if (job?.state !== 'running') return;
    try {
      if (pendingDecisions.has(jobId)) {
        await retryPendingDecision(jobId);
        return;
      }
      if (routing.has(jobId)) return;
      await runner.review(job);
      job = store.get(jobId);
      if (job?.state !== 'running') return;
      if (job.attempts.some((a) => !a.outcome) && !runner.isLive(jobId)) {
        try {
          await runner.reconcile(job);
        } catch (err) {
          log(`could not reconcile job ${jobId}`, err);
          await reload(jobId);
          return;
        }
        job = store.get(jobId);
        if (job?.state !== 'running') return;
      }
      if (stopping || stopRequested.has(jobId)) return;
      const action = nextAction(job, { now: now(), liveSessions: runner.liveCount(), maxConcurrentSessions, routing: router !== null });
      if (action.type === 'needs-you') {
        await store.append(jobId, { type: 'needs-you', reason: action.reason, detail: needsYouDetail(action) });
      } else if (action.type === 'launch') {
        await launchStep(jobId, job, action);
      } else if (action.type === 'load-tasks') {
        await loadTasksStep(jobId, job);
      } else if (action.type === 'complete-phase') {
        const { phase, visit, unresolved, verification } = action;
        await store.append(jobId, { type: 'phase-completed', phase, visit, unresolved, verification });
      } else if (action.type === 'route-test-failure') {
        await routeTestFailureStep(jobId, job, action);
      } else if (action.type === 'route-feedback') {
        await routeFeedbackStep(jobId, job, action);
      } else if (action.type === 'load-round-tasks') {
        await appendRoundTasksStep(jobId, job, action);
      } else if (action.type === 'route') {
        await routeStep(jobId, job, action);
      }
    } catch (err) {
      log(`tick failed for job ${jobId}`, err);
      await reload(jobId);
    }
  }

  // A restored job launches on the next tick, not this one. A folder still in
  // a bad state, but a different one, refreshes the pause so it names the
  // current problem.
  async function restoreStep(jobId) {
    if (stopping || stopRequested.has(jobId)) return;
    try {
      const check = await inPlaceGate(store.get(jobId));
      const job = store.get(jobId);
      if (stopping || stopRequested.has(jobId) || !pausedForFolder(job)) return;
      if (!check.ok) {
        if (check.text !== job.detail?.text || check.folder !== job.detail?.folder) await store.append(jobId, folderChangedEvent(check));
        return;
      }
      await store.append(jobId, { type: 'folder-restored' });
    } catch (err) {
      log(`restoring job ${jobId} failed`, err);
      await reload(jobId);
    }
  }

  async function runTick() {
    if (stopping) return;
    const jobs = [...known]
      .map((jobId) => store.get(jobId))
      .filter((job) => job?.state === 'running' || pausedForFolder(job))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const job of jobs) {
      if (stopping) return;
      await withJob(job.jobId, () => (pausedForFolder(store.get(job.jobId)) ? restoreStep(job.jobId) : stepJob(job.jobId)));
    }
  }

  function tick() {
    if (!ticking) {
      ticking = (async () => {
        try {
          await runTick();
          accounting.enqueue([...known].map((jobId) => store.get(jobId)).filter(Boolean));
        } catch (err) {
          log('tick failed', err);
        } finally {
          ticking = null;
        }
      })();
    }
    return ticking;
  }

  async function startJob(jobId) {
    let job;
    try {
      job = await store.load(jobId);
    } catch (err) {
      if (err?.code === 'ERR_EVENTS_CORRUPT') {
        corrupt.set(jobId, { jobId, state: 'failed', reason: 'corrupt-events' });
        known.delete(jobId);
      }
      log(`could not load job ${jobId}`, err);
      return;
    }
    corrupt.delete(jobId);
    known.add(jobId);
    try {
      if (job.state === 'provisioning' && !provisioningNow.has(jobId)) {
        await store.append(jobId, { type: 'job-failed', error: 'provisioning was interrupted (restart)' });
      } else if (job.state === 'running') {
        await runner.reconcile(job);
      }
    } catch (err) {
      log(`could not recover job ${jobId} at start`, err);
      await reload(jobId);
    }
  }

  async function doStart() {
    stopping = false;
    runner.setStopping(false);
    accounting.start();
    maxConcurrentSessions = config.resolve(null).maxConcurrentSessions;
    let jobIds = [];
    try {
      jobIds = await store.listJobIds();
    } catch (err) {
      log('could not list jobs', err);
    }
    for (const jobId of jobIds) await withJob(jobId, () => startJob(jobId));
    await rebuildReservations();
    if (stopping) return;
    if (!unintercept) unintercept = registry.addApprovalInterceptor(runner.onApprovalRequest);
    if (timer === null) timer = setIntervalImpl(() => { tick(); }, TICK_MS);
  }

  function start() {
    if (!starting) starting = doStart();
    return starting;
  }

  async function drain() {
    await Promise.allSettled([...routing.values()].map((entry) => entry.promise).filter(Boolean));
    await runner.drain();
    await store.flush();
  }

  // One deadline, taken once, bounds both the in-flight tick and the
  // accounting queue.
  async function stop() {
    const deadline = now() + stopTickDeadlineMs;
    stopping = true;
    for (const { controller } of routing.values()) controller.abort();
    runner.setStopping(true);
    starting = null;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (ticking) {
      let handle;
      const timeout = new Promise((resolve) => {
        handle = setTimeout(resolve, Math.max(0, deadline - now()));
      });
      await Promise.race([ticking, timeout]).finally(() => clearTimeout(handle));
    }
    await accounting.stop({ deadline });
    await drain();
  }

  // Not part of stop(): shutdown closes worker rows after stop(), and their
  // asks must stay denied until then.
  function dispose() {
    if (!unintercept) return;
    unintercept();
    unintercept = null;
  }

  // Read once per call; an invalid entry lists as one invalid user workflow and contributes nothing.
  const validFolders = (entries) => entries.filter((e) => !e.error).map((e) => e.resolved);

  function loadWorkflowList(origin, fileConfig, entries) {
    return loadWorkflows({ builtinDir: workflowDirs.builtin, globalDir: workflowDirs.global, userFolders: entries, projectDir: origin, fileConfig, projectPath: origin, platform });
  }

  async function isDirectory(dir) {
    try {
      return (await stat(dir)).isDirectory();
    } catch {
      return false;
    }
  }

  const withoutDoc = ({ doc, source, folder, ...rest }) => rest;

  function workflowItem(entry, shadowedBy = null) {
    const { shadowedBy: _s, ...rest } = withoutDoc(entry);
    const status = shadowedBy ? 'shadowed' : entry.valid ? 'used' : 'invalid';
    return { ...rest, status, shadowedBy };
  }

  // A prompt's status comes from the same lookup a launch uses, so case-insensitive
  // filesystems and unreadable files agree with what a worker would get.
  async function promptItems(folder, userPromptsDirs) {
    let entries;
    try {
      entries = await readdir(path.join(folder, 'prompts'), { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { prompts: [], note: null };
      return { prompts: [], note: `the prompts folder could not be read: ${err.message}` };
    }
    let note = null;
    const prompts = [];
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (const file of files) {
      const role = file.slice(0, -3);
      if (role === 'contract') {
        prompts.push({ file, role, status: 'ignored', shadowedBy: null, reason: 'the contract is built in' });
        continue;
      }
      if (!ROLE_NAME.test(role)) {
        prompts.push({ file, role, status: 'ignored', shadowedBy: null, reason: 'not a role name' });
        continue;
      }
      try {
        const found = await resolvePromptPath(role, { userPromptsDirs });
        const winner = found?.source === 'user' ? found.folder : null;
        prompts.push(winner === folder ? { file, role, status: 'used', shadowedBy: null, reason: null } : { file, role, status: 'shadowed', shadowedBy: winner, reason: null });
      } catch (err) {
        note ??= `a prompt could not be read: ${err.message}`;
        prompts.push({ file, role, status: 'ignored', shadowedBy: null, reason: `could not be read: ${err.message}` });
      }
    }
    return { prompts, note };
  }

  async function settings() {
    const r = config.userFolders();
    const { workflows, shadowed } = await loadWorkflowList(null, config.raw(), r.entries);
    const shadowOf = (w) => w.shadowedBy.folder ?? (w.shadowedBy.source === 'global' ? workflowDirs.global : w.shadowedBy.source);
    const itemsFor = (source, folder) => [
      ...workflows.filter((w) => w.source === source && w.folder === folder).map((w) => workflowItem(w)),
      ...shadowed.filter((w) => w.source === source && w.folder === folder).map((w) => workflowItem(w, shadowOf(w))),
    ];
    const userPromptsDirs = validFolders(r.entries).map((f) => path.join(f, 'prompts'));
    const folders = [];
    for (const entry of r.entries) {
      const base = { index: entry.index, configured: entry.raw, resolved: entry.resolved, error: entry.error, fixed: false };
      if (entry.error) {
        folders.push({ ...base, exists: false, workflows: [], prompts: [], note: null });
        continue;
      }
      const { prompts, note } = await promptItems(entry.resolved, userPromptsDirs);
      folders.push({ ...base, exists: await isDirectory(entry.resolved), workflows: itemsFor('user', entry.resolved), prompts, note });
    }
    const globalWorkflows = itemsFor('global', null);
    folders.push({ index: null, configured: null, resolved: workflowDirs.global, error: null, fixed: true, exists: await isDirectory(workflowDirs.global), workflows: globalWorkflows, prompts: [], note: null });
    return { isDefault: r.isDefault, default: r.default, error: r.error, folders };
  }

  // One chain, so a POST's plan, folder creation and write finish before the next one plans.
  let settingsChain = Promise.resolve();
  function setUserFolders(list) {
    const run = settingsChain.then(() => applyUserFolders(list));
    settingsChain = run.catch(() => {});
    return run;
  }

  async function applyUserFolders(list) {
    if (list === null) {
      await config.setUserFolders(null);
      return settings();
    }
    const plan = config.planUserFolders(list);
    if (plan.error) throw fail('ERR_INVALID_REQUEST', plan.error);
    for (const entry of plan.entries.filter((e) => e.isNew)) {
      let current = entry.resolved;
      try {
        await mkdir(current, { recursive: true });
        for (const sub of ['workflows', 'prompts']) {
          current = path.join(entry.resolved, sub);
          await mkdir(current, { recursive: true });
        }
      } catch (err) {
        throw fail('ERR_INVALID_FOLDER', `could not create ${current}: ${err.message}`);
      }
    }
    await config.setUserFolders(plan.entries.map((e) => e.configured));
    return settings();
  }

  async function listWorkflows(primaryPath) {
    const { workflows, default: preselected, defaultNote } = await loadWorkflowList(primaryPath == null ? null : path.resolve(primaryPath), config.raw(), config.userFolders().entries);
    return { workflows: workflows.map(({ doc, ...entry }) => entry), default: preselected, defaultNote };
  }

  function fixturePlan(resolved, fixture) {
    if (!Object.hasOwn(FIXTURES, fixture)) throw fail('ERR_UNKNOWN_FIXTURE', `superagent: unknown fixture ${JSON.stringify(fixture)}`);
    const { errors } = validateMilestoneFixture(resolved, fixture);
    if (errors.length > 0) {
      throw fail('ERR_INVALID_CONFIG', `superagent config is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { errors });
    }
    return { pipeline: FIXTURES[fixture], models: resolved.models, recorded: null };
  }

  // Validation already ran in the loader (config-pipeline's with composition on),
  // so a declared prompt exists or a project override covers it. It is recorded
  // either way, so removing that override later can never reach the built-in.
  async function workflowPlan(id, origin, folder) {
    const fileConfig = config.raw();
    const { workflows, default: preselected } = await loadWorkflowList(origin, fileConfig, folder);
    const wanted = id ?? preselected;
    const entry = workflows.find((w) => sameWorkflowId(w.id, wanted));
    if (!entry) throw fail('ERR_UNKNOWN_WORKFLOW', `superagent: unknown workflow ${JSON.stringify(wanted)}`);
    if (!entry.valid) {
      throw fail('ERR_INVALID_WORKFLOW', `superagent: workflow ${JSON.stringify(wanted)} is invalid: ${entry.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { errors: entry.errors });
    }
    const { doc } = entry;
    const pipeline = entry.id === CONFIG_PIPELINE_ID ? legacyPipeline(doc.phases) : doc.phases;
    const prompts = {};
    for (const role of pipelineRoles(pipeline)) {
      const promptField = doc.roles?.[role]?.prompt;
      prompts[role] = entry.file !== null && typeof promptField === 'string' && promptField.length > 0 ? path.resolve(path.dirname(entry.file), promptField) : null;
    }
    return {
      pipeline,
      models: resolveWorkflowModels(doc, fileConfig, origin),
      recorded: { workflow: { id: entry.id, name: entry.name, source: entry.source, file: entry.file }, artifacts: doc.artifacts, prompts },
    };
  }

  // Decision 11: a project override template (under projectDir) counts.
  async function resolvePipeline(resolved, { fixture, workflow }, projectDir, folder) {
    const plan = fixture != null ? fixturePlan(resolved, fixture) : await workflowPlan(workflow, projectDir, folder);
    const unsupported = plan.pipeline.filter((p) => !RUNNABLE_KINDS.has(p.kind));
    if (unsupported.length > 0) {
      throw fail('ERR_PHASE_KIND_UNSUPPORTED', `superagent: phase kinds not runnable yet: ${unsupported.map((p) => `${p.phase} (${p.kind})`).join(', ')}`);
    }
    const missing = [];
    for (const role of pipelineRoles(plan.pipeline)) {
      if (!(await hasTemplate(role, { projectDir, recordedPrompt: plan.recorded?.prompts[role] ?? null, userFolders: validFolders(folder) }))) missing.push(role);
    }
    if (missing.length > 0) {
      throw fail('ERR_NO_TEMPLATE', `superagent: no prompt template for role${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`, { roles: missing });
    }
    return plan;
  }

  // Built with the runner's own attemptDir, so the bound cannot drift from the
  // directories it actually creates.
  function longestAttemptPath(pipeline, { jobId, primaryWorktree }) {
    const attemptId = 'f'.repeat(ATTEMPT_ID_LENGTH);
    let longest = '';
    for (const p of pipeline) {
      if (p.kind === 'human') continue;
      const task = p.kind === 'per-task' ? 'f'.repeat(TASK_ID_MAX) : null;
      const file = path.join(attemptDir(primaryWorktree, { jobId, phase: p.phase, task, attemptId }), `${RESULT_FILE}.tmp`);
      if (file.length > longest.length) longest = file;
    }
    return longest;
  }

  // Decision 14: on win32 the slug's title part is cut to whatever still fits;
  // only a root too long for SLUG_BASE_MIN characters is refused. An in-place
  // primary keeps its attempts in the folder itself, where the slug plays no
  // part; the folder (its top level or deeper) bounds the path from above.
  function fitSlug(pipeline, { title, jobId, inPlaceFolder }) {
    if (platform !== 'win32') return slugify(title, jobId);
    if (inPlaceFolder) {
      const length = longestAttemptPath(pipeline, { jobId, primaryWorktree: path.resolve(inPlaceFolder) }).length;
      if (length > WIN32_PATH_LIMIT) {
        throw fail(
          'ERR_PATH_TOO_LONG',
          `superagent: attempt paths for this job would reach ${length} characters, over the ${WIN32_PATH_LIMIT}-character Windows limit. Use a folder with a shorter path than ${path.resolve(inPlaceFolder)}.`,
          { length, limit: WIN32_PATH_LIMIT },
        );
      }
      return slugify(title, jobId);
    }
    const primaryWorktree = path.join(path.resolve(worktreesRoot), `-${String(jobId).slice(0, 8)}`, 'primary');
    const bare = longestAttemptPath(pipeline, { jobId, primaryWorktree }).length;
    const maxBase = Math.min(SLUG_BASE_MAX, WIN32_PATH_LIMIT - bare);
    if (maxBase < SLUG_BASE_MIN) {
      const length = bare + SLUG_BASE_MIN;
      throw fail(
        'ERR_PATH_TOO_LONG',
        `superagent: attempt paths for this job would reach ${length} characters with an ${SLUG_BASE_MIN}-character title, over the ${WIN32_PATH_LIMIT}-character Windows limit. Set COCKPIT_HOME to a shorter directory (worktrees live under ${path.resolve(worktreesRoot)}).`,
        { length, limit: WIN32_PATH_LIMIT },
      );
    }
    return slugify(title, jobId, maxBase);
  }

  // Every folder is checked before job-created, so a bad or repeated folder
  // never leaves a failed job and a kept worktree behind. Each folder's real
  // top level is reserved as soon as it is known, before its slower checks.
  // A folder that is not a repo, or a repo with no commits, is made one first
  // and stays so even when a later check refuses the job.
  async function checkRepos(jobId, repos, { slug, branch }) {
    const seen = new Map();
    const checked = [];
    for (const repo of repos) {
      const made = await ensureRepo({ git, folder: repo.origin });
      if (made.initialised) log(`job ${jobId}: ran git init in ${repo.origin}`);
      if (made.committed) log(`job ${jobId}: made the first commit in ${repo.origin}`);
      const key = normaliseTop(await repoToplevel({ git, origin: repo.origin }), platform);
      if (seen.has(key)) throw fail('ERR_DUPLICATE_REPO', `superagent: ${repo.origin} is the same repository as ${seen.get(key)}`);
      seen.set(key, repo.origin);
      reserve(jobId, [{ key, folder: repo.origin, inPlace: repo.inPlace }]);
      if (repo.inPlace) {
        checked.push(await checkInPlace({ git, folder: repo.origin, branch }));
      } else {
        await refuseJobBranch({ git, folder: repo.origin });
        checked.push({ ...(await checkRepo({ git, origin: repo.origin, worktree: path.join(worktreesRoot, slug, repo.id), branch })), head: null });
      }
    }
    return checked;
  }

  // Only the worktree this run was creating goes; worktrees of repos already
  // provisioned are kept, as for any stopped job.
  async function removeHalfMade(jobId, { origin }, { worktree, branch, baseSha }) {
    const { worktreeRemoved, branchDeleted, notes } = await removeAbortedWorktree({ git, origin, worktree, branch, baseSha, worktreesRoot });
    log(`stopping job ${jobId} cancelled git worktree add; ${worktreeRemoved ? 'removed' : 'could not remove'} ${worktree}, ${branchDeleted ? 'deleted' : 'did not delete'} ${branch}`);
    for (const note of notes) log(`job ${jobId}: ${note}`);
  }

  // What every confirmed job-stopped is followed by.
  async function afterStopped(jobId, stopped) {
    releaseIfFinished(jobId);
    pendingDecisions.delete(jobId);
    await archive(stopped);
  }

  // A failed append is left to the stopJob queued behind this provisioning,
  // which finds the job unfinished and records the stop itself.
  async function recordProvisioningStop(jobId) {
    let stopped;
    try {
      stopped = await appendConfirmed(jobId, { type: 'job-stopped' }, (j) => j.state === 'stopped');
    } catch (err) {
      log(`could not record the stop of job ${jobId} during provisioning`, err);
      await reload(jobId);
      return;
    }
    await afterStopped(jobId, stopped);
  }

  // stopJob aborts the controller before it queues behind this. An in-place
  // switch never gets the signal (killing it could leave index.lock in the
  // user's folder); the stop takes effect once it returns.
  async function provision(job) {
    const { jobId } = job;
    const controller = new AbortController();
    provisioning.set(jobId, controller);
    const stopped = () => stopRequested.has(jobId) || controller.signal.aborted;
    try {
      for (const repo of job.repos) {
        if (stopped()) break;
        const inPlace = repo.inPlace === true;
        let made;
        try {
          made = inPlace
            ? await provisionInPlace({ git, folder: repo.toplevel, branch: job.branch, jobId, expectedHead: repo.admittedHead })
            : await createWorktree({ git, origin: repo.origin, worktree: path.join(worktreesRoot, job.slug, repo.id), branch: job.branch, copyLocalClaudeSettings: job.copyLocalClaudeSettings, signal: controller.signal });
        } catch (err) {
          if (err?.partial) await removeHalfMade(jobId, repo, err.partial);
          throw err;
        }
        await store.append(jobId, { type: 'worktree-created', repo: repo.id, worktree: made.worktree, branch: made.branch, baseSha: made.baseSha, settingsCopy: made.settingsCopy, ...(inPlace && { inPlace: true }) });
      }
      if (stopped()) await recordProvisioningStop(jobId);
      else await store.append(jobId, { type: 'job-provisioned' });
    } catch (err) {
      if (stopped()) {
        if (err?.code !== 'ERR_ABORTED') log(`provisioning job ${jobId} failed while stopping, recorded as stopped`, err);
        await recordProvisioningStop(jobId);
      } else {
        log(`provisioning job ${jobId} failed, worktrees kept`, err);
        await store.append(jobId, { type: 'job-failed', error: messageOf(err) });
      }
    } finally {
      provisioning.delete(jobId);
    }
    return store.get(jobId);
  }

  function inPlaceOrigins(inPlace, repos) {
    if (!Array.isArray(inPlace) || inPlace.some((p) => typeof p !== 'string' || p.length === 0)) {
      throw fail('ERR_INVALID_REQUEST', 'superagent: inPlace must be an array of folder paths');
    }
    const origins = new Set(repos.map((r) => r.origin));
    const wanted = new Set();
    for (const p of inPlace) {
      const folder = path.resolve(p);
      if (!origins.has(folder)) throw fail('ERR_INVALID_REQUEST', `superagent: inPlace folder is not one of the job's folders: ${folder}`);
      wanted.add(folder);
    }
    return wanted;
  }

  async function createJob({ title, idea, primaryRepo: primaryPath, additionalRepos = [], mode = 'automatic', fixture = null, workflow = null, inPlace = [], commitTests }) {
    const origin = path.resolve(primaryPath);
    const resolved = config.resolve(origin);
    const folder = config.userFolders().entries;
    const { pipeline, models, recorded } = await resolvePipeline(resolved, { fixture, workflow }, origin, folder);
    if (mode === 'manual' && pipeline.some((p) => p.kind === 'brainstorm')) throw fail('ERR_MODE_UNSUPPORTED', 'superagent: manual mode is not built yet');
    const jobId = idImpl();
    const folders = repoIds(origin, [...resolved.additionalRepos, ...additionalRepos].map((p) => path.resolve(p)));
    const inPlaceSet = inPlaceOrigins(inPlace, folders);
    const slug = fitSlug(pipeline, { title, jobId, inPlaceFolder: inPlaceSet.has(origin) ? origin : null });
    const branch = BRANCH_PREFIX + slug;
    const marked = folders.map((repo) => ({ ...repo, inPlace: inPlaceSet.has(repo.origin) }));
    reserve(jobId, marked.map((repo) => ({ key: normaliseTop(repo.origin, platform), folder: repo.origin, inPlace: repo.inPlace })));
    try {
      return await admitJob(jobId, marked, { title, idea, mode, slug, branch, pipeline, models, recorded, resolved, commitTests, userFolders: validFolders(folder) });
    } finally {
      if (store.get(jobId)) releaseIfFinished(jobId);
      else release(jobId);
    }
  }

  async function admitJob(jobId, marked, { title, idea, mode, slug, branch, pipeline, models, recorded, resolved, commitTests, userFolders }) {
    const checked = await checkRepos(jobId, marked, { slug, branch });
    const repos = marked.map(({ inPlace, ...repo }, i) => ({
      ...repo,
      toplevel: path.resolve(checked[i].toplevel),
      ...(inPlace && { inPlace: true, admittedHead: checked[i].head }),
      ...(inPlace && checked[i].pending.total > 0 && { pendingChanges: checked[i].pending }),
    }));
    const createdDate = localDate(now());
    const created = {
      type: 'job-created',
      jobId,
      slug,
      title,
      idea,
      mode,
      branch,
      createdDate,
      repos,
      pipeline,
      artifactRoot: 'ledger',
      userFolders,
      ...(recorded && { workflow: recorded.workflow, artifacts: substituteArtifacts(recorded.artifacts, { slug, date: createdDate }), prompts: recorded.prompts }),
      models,
      limits: resolved.limits,
      router: { allowlist: resolved.routerModelAllowlist, maxInputTokens: resolved.routerMaxInputTokens, maxOutputTokens: resolved.routerMaxOutputTokens },
      workerPermissionMode: resolved.workerPermissionMode,
      copyLocalClaudeSettings: resolved.copyLocalClaudeSettings,
      commitTests: commitTests ?? resolved.commitTests,
      testPaths: resolved.testPaths,
      branchTemplate: templateFor(resolved.branchTemplates, recorded?.workflow?.id ?? null),
    };
    provisioningNow.add(jobId);
    known.add(jobId);
    try {
      return await withJob(jobId, async () => {
        try {
          await store.append(jobId, created);
        } catch (err) {
          if (!(await store.load(jobId).catch(() => null))) throw err;
        }
        return provision(store.get(jobId));
      });
    } catch (err) {
      if (!store.get(jobId)) known.delete(jobId);
      throw err;
    } finally {
      provisioningNow.delete(jobId);
    }
  }

  // `needsYouSeq`, when given, is the needs-you the caller saw (the view
  // sends it): a job that has since moved on is refused, never acted on.
  // Feedback passes `required`, so an omitted one is a bad request there.
  function requireSeen(job, needsYouSeq, { required = false } = {}) {
    if (required && !Number.isInteger(needsYouSeq)) {
      throw fail('ERR_INVALID_REQUEST', 'superagent: needsYouSeq must be the integer seq of the needs-you this was written for');
    }
    if (needsYouSeq !== undefined && needsYouSeq !== job.needsYouSeq) {
      throw fail('ERR_INVALID_STATE', `superagent: job ${job.jobId} no longer needs what was shown (needs-you ${needsYouSeq}, now ${job.needsYouSeq ?? 'none'})`);
    }
  }

  function requireReadyToTry(job) {
    if (job.state !== 'needs-you' || job.reason !== 'ready-to-try') {
      throw fail('ERR_INVALID_STATE', `superagent: job ${job.jobId} is ${job.state}${job.reason ? ` (${job.reason})` : ''}, not ready to try`);
    }
  }

  const branchThere = async (cwd, name) => (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd })).code === 0;

  // Renames `from` to `to` in every repo, or in none: everything is checked
  // before the first rename, and a failed rename renames the repos already
  // done back. A repo with `to` and without `from` was renamed by an earlier
  // accept that stopped before its event was appended, and is skipped.
  async function renameBranch(job, from, to) {
    const missing = job.repos.find((r) => !r.worktree);
    if (missing) throw fail('ERR_INVALID_STATE', `superagent: repo ${missing.id} of job ${job.jobId} has no folder to rename the branch in`);
    const valid = isValidBranchName(to) && (await git(['check-ref-format', '--branch', to], { cwd: primaryRepo(job).worktree })).code === 0;
    if (!valid) throw fail('ERR_INVALID_BRANCH', `superagent: ${to} is not a valid branch name`);
    const pending = [];
    for (const repo of job.repos) {
      const [hasFrom, hasTo] = [await branchThere(repo.worktree, from), await branchThere(repo.worktree, to)];
      if (hasTo && hasFrom) throw fail('ERR_BRANCH_EXISTS', `superagent: branch ${to} already exists in ${repo.id} (${repo.worktree})`);
      if (hasTo) continue;
      if (!hasFrom) throw fail('ERR_RENAME_FAILED', `superagent: branch ${from} is not in ${repo.id} (${repo.worktree}); nothing was renamed`);
      pending.push(repo);
    }
    const done = [];
    for (const repo of pending) {
      const res = await git(['branch', '-m', from, to], { cwd: repo.worktree });
      if (res.code === 0) {
        done.push(repo);
        continue;
      }
      const left = [];
      for (const back of done.reverse()) {
        if ((await git(['branch', '-m', to, from], { cwd: back.worktree })).code !== 0) left.push(back.id);
      }
      const after = left.length > 0
        ? `; renaming back failed, so these repos are still renamed to ${to}: ${left.join(', ')}`
        : done.length > 0 ? '; the repos already renamed were renamed back' : '';
      throw fail('ERR_RENAME_FAILED', `superagent: could not rename ${from} to ${to} in ${repo.id}: ${res.stderr.trim() || `git exited ${res.code}`}${after}`);
    }
  }

  // `branch`, when given and different, is the name the job's branch takes
  // in every repo before the job is accepted.
  function accept(jobId, { needsYouSeq, branch } = {}) {
    return withJob(jobId, async () => {
      const job = await requireJob(jobId);
      requireSeen(job, needsYouSeq);
      requireReadyToTry(job);
      if (branch != null && typeof branch !== 'string') throw fail('ERR_INVALID_BRANCH', 'superagent: a branch name must be text');
      const from = job.finalBranch ?? job.branch;
      const to = branch?.trim() || from;
      if (to !== from) {
        await renameBranch(job, from, to);
        await appendConfirmed(jobId, { type: 'branch-renamed', from, to }, (j) => j.finalBranch === to);
      }
      const accepted = await appendConfirmed(jobId, { type: 'job-accepted' }, (j) => j.state === 'done');
      releaseIfFinished(jobId);
      await archive(accepted);
      return accepted;
    });
  }

  // Give feedback on a ready-to-try job: starts round N+1 (triage first). The
  // triage model comes from config only, so a job created before triage
  // existed, or whose workflow file is gone, still gets one. The baseline and
  // every repo's pending changes are read now, under the job's queue, so the
  // round is judged against what the user had when they asked; the baseline
  // files are copied under the job dir for retryJob to restore.
  function giveFeedback(jobId, { needsYouSeq, text } = {}) {
    return withJob(jobId, async () => {
      const job = await requireJob(jobId);
      requireSeen(job, needsYouSeq, { required: true });
      requireReadyToTry(job);
      const body = typeof text === 'string' ? text.trim() : '';
      if (body.length < 1 || body.length > ANSWER_MAX_CHARS) {
        throw fail('ERR_INVALID_REQUEST', `superagent: feedback must be 1-${ANSWER_MAX_CHARS} characters`);
      }
      const eligible = feedbackEligibility(job);
      if (!eligible.ok) throw fail('ERR_FEEDBACK_UNSUPPORTED', `superagent: job ${jobId} cannot take feedback (${eligible.why})`, { why: eligible.why });
      const round = currentRound(job) + 1;
      const pendingChanges = {};
      for (const repo of job.repos) {
        if (repo.worktree) pendingChanges[repo.id] = await readPendingChanges({ git, folder: repo.worktree });
      }
      const event = {
        type: 'feedback-given',
        round,
        forNeedsYouSeq: needsYouSeq,
        text: body,
        triageModel: resolveEngineModel(config.raw(), primaryRepo(job).origin, 'triage'),
        baseline: await feedbackBaseline(job, round, baselineCopyDir(store.jobDir(jobId), round)),
        pendingChanges,
      };
      return appendConfirmed(jobId, event, (j) => (j.feedbackRounds ?? []).some((r) => r.forNeedsYouSeq === needsYouSeq));
    });
  }

  // Plan 5: an answer resumes the scope that asked. A budget refusal has no
  // asking attempt and is not answerable.
  function answerQuestion(jobId, text, { needsYouSeq } = {}) {
    return withJob(jobId, async () => {
      const job = await requireJob(jobId);
      requireSeen(job, needsYouSeq);
      const forAttemptId = job.detail?.attemptId ?? null;
      if (
        job.state !== 'needs-you' || job.reason !== 'question' || forAttemptId == null
        || job.detail.kind === 'budget' || (job.answers ?? []).some((a) => a.forAttemptId === forAttemptId)
      ) {
        throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} is ${job.state}${job.reason ? ` (${job.reason})` : ''}, with no question to answer`);
      }
      const answer = typeof text === 'string' ? text.trim() : '';
      if (answer.length < 1 || answer.length > ANSWER_MAX_CHARS) {
        throw fail('ERR_INVALID_ANSWER', `superagent: an answer must be 1-${ANSWER_MAX_CHARS} characters`);
      }
      return appendConfirmed(jobId, { type: 'question-answered', forAttemptId, answer }, (j) => j.answers.some((a) => a.forAttemptId === forAttemptId));
    });
  }

  // Retry on a stuck job: the stuck scope's failed attempts stop counting and
  // the next attempt resumes from its last one, with that attempt's
  // handoff.md when it wrote one and the user's optional note. Only the
  // current feedback round's attempts are looked at. A round's invalid task
  // list reopens its task-writing phase (and its plan review) instead, as a
  // recovery of the round's last done feedback-plan attempt with the parse
  // errors on its card: reading the same file again would only go stuck again.
  // In a round, Retry first puts back any baseline file a worker changed.
  function retryJob(jobId, { needsYouSeq, note } = {}) {
    return withJob(jobId, async () => {
      const job = await requireJob(jobId);
      requireSeen(job, needsYouSeq);
      if (job.state !== 'needs-you' || job.reason !== 'stuck') {
        throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} is ${job.state}${job.reason ? ` (${job.reason})` : ''}, not stuck`);
      }
      if (note != null && typeof note !== 'string') throw fail('ERR_INVALID_ANSWER', 'superagent: a retry note must be text');
      const text = (note ?? '').trim();
      if (text.length > ANSWER_MAX_CHARS) throw fail('ERR_INVALID_ANSWER', `superagent: a retry note must be at most ${ANSWER_MAX_CHARS} characters`);
      const feedbackRound = currentRound(job);
      const reopen = job.detail?.why === 'tasks-invalid' && Number.isInteger(job.detail.round) && job.detail.round > 0;
      const writing = reopen ? feedbackShape(job)?.taskWriting.phase : null;
      if (reopen && !writing) throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} has no task-writing phase to reopen`);
      const phase = writing ?? job.detail?.phase ?? job.phaseId;
      const task = reopen ? null : (job.detail?.task ?? null);
      const inRound = (a) => a.phase === phase && (a.task ?? null) === task && roundOf(a) === feedbackRound;
      const last = (reopen
        ? job.attempts.findLast((a) => inRound(a) && a.purpose === 'feedback-plan' && a.outcome === 'done')
        : job.attempts.findLast((a) => inRound(a) && !gatedOut(a))) ?? null;
      const handoffFile = last?.dir ? path.join(last.dir, 'handoff.md') : null;
      if (feedbackRound > 0) {
        await restoreBaseline(job, feedbackRound, baselineCopyDir(store.jobDir(jobId), feedbackRound), log)
          .catch((err) => log(`could not restore the baseline of job ${jobId} round ${feedbackRound}`, err));
      }
      const event = {
        type: 'job-retried',
        needsYouSeq: job.needsYouSeq,
        phase,
        task,
        fromAttemptId: last?.attemptId ?? null,
        handoff: handoffFile && (await fileExists(handoffFile)) ? handoffFile : null,
        note: text || null,
        feedbackRound,
        ...(reopen && { reopen: true, errors: job.detail.errors ?? [] }),
      };
      return appendConfirmed(jobId, event, (j) => (j.retries ?? []).some((r) => r.needsYouSeq === event.needsYouSeq));
    });
  }

  // Any state: a rename changes the shown title and later attempts' job
  // cards, never the slug, branch or artifact paths.
  function renameJob(jobId, title) {
    return withJob(jobId, async () => {
      const job = await requireJob(jobId);
      const text = typeof title === 'string' ? title.trim() : '';
      if (text.length < 1 || text.length > TITLE_MAX_CHARS) {
        throw fail('ERR_INVALID_REQUEST', `superagent: a job title must be 1-${TITLE_MAX_CHARS} characters`);
      }
      if (text === job.title) return job;
      return appendConfirmed(jobId, { type: 'job-renamed', title: text }, (j) => j.title === text);
    });
  }

  function stopJob(jobId) {
    stopRequested.add(jobId);
    routing.get(jobId)?.controller.abort();
    provisioning.get(jobId)?.abort();
    return withJob(jobId, async () => {
      try {
        const job = await requireJob(jobId);
        if (job.state === 'stopped') return job;
        if (job.state === 'done' || job.state === 'failed') {
          throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} is already ${job.state}`);
        }
        await runner.stopAttempt(jobId);
        const stopped = await appendConfirmed(jobId, { type: 'job-stopped' }, (j) => j.state === 'stopped');
        await afterStopped(jobId, stopped);
        return stopped;
      } finally {
        stopRequested.delete(jobId);
      }
    });
  }

  function listJobs() {
    const jobs = [...known].map((jobId) => store.get(jobId)).filter(Boolean);
    return [...jobs, ...corrupt.values()].map((j) => structuredClone(j));
  }

  // A corrupt job has no attempts to account.
  function jobForRead(jobId) {
    if (corrupt.has(jobId)) return { jobId, attempts: [] };
    const job = store.get(jobId);
    if (!job) throw fail('ERR_UNKNOWN_JOB', `superagent: no job ${jobId}`);
    return job;
  }

  async function usageForJob(jobId) {
    return accounting.usageForJob(jobForRead(jobId));
  }

  async function transcriptFor(jobId, attemptId) {
    const job = jobForRead(jobId);
    const attempt = job.attempts.find((a) => a.attemptId === attemptId);
    if (!attempt) throw fail('ERR_UNKNOWN_ATTEMPT', `superagent: job ${jobId} has no attempt ${attemptId}`);
    return accounting.transcriptFor(job, attempt);
  }

  // Stat only: where each of the job's artifacts can be read from right now.
  async function artifactStates(jobId) {
    if (corrupt.has(jobId)) return new Map();
    return readArtifactStates(jobForRead(jobId), { snapshotDir: snapshotDirFor(store.jobDir(jobId)) });
  }

  function getJob(jobId) {
    const bad = corrupt.get(jobId);
    return bad ? structuredClone(bad) : store.get(jobId);
  }

  async function orphanWorktrees() {
    const jobs = [...known].map((jobId) => store.get(jobId)).filter(Boolean);
    const repos = [...new Set(jobs.flatMap((j) => j.repos.filter((r) => !r.inPlace).map((r) => r.origin)))];
    const knownBranches = new Set(jobs.flatMap((j) => [j.branch, j.finalBranch].filter(Boolean)));
    return listOrphanWorktrees({ git, repos, knownBranches });
  }

  return { start, stop, dispose, ownsSession: runner.ownsSession, tick, drain, createJob, listWorkflows, settings, setUserFolders, accept, giveFeedback, answerQuestion, retryJob, renameJob, stopJob, listJobs, getJob, orphanWorktrees, usageForJob, transcriptFor, artifactStates, jobDir: store.jobDir };
}
