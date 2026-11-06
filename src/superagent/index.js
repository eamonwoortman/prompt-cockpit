// Superagent supervisor: createSuperagent owns one heartbeat that reviews and
// advances every running job, plus job creation, accept and stop.
//
// Modelled on createAutopilot (src/autopilot.js): everything injected, one
// timer, a tick that never overlaps itself, an idempotent start/stop and a
// bounded wait for the in-flight tick on stop. It is a separate timer from
// auto-pilot's (spec Decision 1) and is not wired into src/server.js yet
// (plan 2, "Not in this plan").
//
// Per-job serialisation: tick's job step, createJob's provisioning, stopJob
// and accept all run on one promise chain per job (withJob), so a stop can
// never interleave with a launch. stopJob marks the job in stopRequested
// synchronously, before it queues, so a tick step already waiting on a budget
// check sees the stop on its recheck and launches nothing.
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
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURES, STAND_IN_ROLE, defaultSuperagentRoot, validateDefaults, validateMilestoneFixture } from './config.js';
import { hasTemplate } from './prompts.js';
import { RESULT_FILE, artifactPaths, attemptDir, parseTasks, primaryRepo } from './results.js';
import { allowedActions, buildRouterRequest } from './router.js';
import { createRunner } from './runner.js';
import { RUNNABLE_KINDS, buildFixTask, nextAction } from './sequencer.js';
import { BRANCH_PREFIX, archiveLedger, createWorktree, defaultGit, listOrphanWorktrees, repoIds, slugify } from './worktree.js';

export const TICK_MS = 15_000;

// Decision 14: MAX_PATH less its terminating NUL. Validation bounds phase ids
// at 24 characters and task ids at 12; attempt ids are uuids. On win32 the
// title part of the slug shrinks to fit, down to SLUG_BASE_MIN.
const WIN32_PATH_LIMIT = 259;
const TASK_ID_MAX = 12;
const ATTEMPT_ID_LENGTH = 36;
const SLUG_BASE_MAX = 40;
const SLUG_BASE_MIN = 8;

const messageOf = (err) => String(err?.message ?? err);
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
}) {
  const runner = createRunner({ registry, store, git, now, idImpl, logImpl });
  const known = new Set();
  const corrupt = new Map();
  const chains = new Map();
  const provisioningNow = new Set();
  const stopRequested = new Set();
  const routing = new Map();
  const pendingDecisions = new Map();
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

  function withJob(jobId, fn) {
    const prev = chains.get(jobId) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    chains.set(jobId, run);
    run.finally(() => {
      if (chains.get(jobId) === run) chains.delete(jobId);
    }).catch(() => {});
    return run;
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

  async function launchStep(jobId, job, action) {
    let verdict;
    try {
      verdict = await budgetCheck({ job, action });
    } catch (err) {
      log(`budget check for job ${jobId} failed, not launching`, err);
      return;
    }
    if (stopping || stopRequested.has(jobId) || store.get(jobId)?.state !== 'running') return;
    if (!verdict?.allow) {
      const text = verdict?.reason ?? 'budget check refused the launch';
      await store.append(jobId, { type: 'needs-you', reason: 'question', detail: { kind: 'budget', text } });
      return;
    }
    const result = await runner.launch(store.get(jobId), action);
    if (result?.error === 'store-failed') await reload(jobId);
  }

  async function loadTasksStep(jobId, job) {
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
    if (stopping || stopRequested.has(jobId) || store.get(jobId)?.state !== 'running') return;
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
    const scope = job.attempts.filter((a) => a.phase === action.phase && (a.task ?? null) === (action.task ?? null));
    return scope.at(-1)?.attemptId !== action.forAttemptId;
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
      } else if (action.type === 'route') {
        await routeStep(jobId, job, action);
      }
    } catch (err) {
      log(`tick failed for job ${jobId}`, err);
      await reload(jobId);
    }
  }

  async function runTick() {
    if (stopping) return;
    const jobs = [...known]
      .map((jobId) => store.get(jobId))
      .filter((job) => job?.state === 'running')
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const job of jobs) {
      if (stopping) return;
      await withJob(job.jobId, () => stepJob(job.jobId));
    }
  }

  function tick() {
    if (!ticking) {
      ticking = (async () => {
        try {
          await runTick();
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
    maxConcurrentSessions = config.resolve(null).maxConcurrentSessions;
    let jobIds = [];
    try {
      jobIds = await store.listJobIds();
    } catch (err) {
      log('could not list jobs', err);
    }
    for (const jobId of jobIds) await withJob(jobId, () => startJob(jobId));
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

  async function stop() {
    stopping = true;
    for (const { controller } of routing.values()) controller.abort();
    runner.setStopping(true);
    starting = null;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (unintercept) {
      unintercept();
      unintercept = null;
    }
    if (ticking) {
      let handle;
      const deadline = new Promise((resolve) => {
        handle = setTimeout(resolve, stopTickDeadlineMs);
      });
      await Promise.race([ticking, deadline]).finally(() => clearTimeout(handle));
    }
    await drain();
  }

  // Decision 11: a project override template (under projectDir) counts.
  async function resolvePipeline(resolved, fixture, projectDir) {
    if (fixture != null && !Object.hasOwn(FIXTURES, fixture)) {
      throw fail('ERR_UNKNOWN_FIXTURE', `superagent: unknown fixture ${JSON.stringify(fixture)}`);
    }
    const pipeline = fixture != null ? FIXTURES[fixture] : resolved.pipeline;
    const { errors } = fixture != null ? validateMilestoneFixture(resolved, fixture) : validateDefaults(resolved);
    if (errors.length > 0) {
      throw fail('ERR_INVALID_CONFIG', `superagent config is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { errors });
    }
    const unsupported = pipeline.filter((p) => !RUNNABLE_KINDS.has(p.kind));
    if (unsupported.length > 0) {
      throw fail('ERR_PHASE_KIND_UNSUPPORTED', `superagent: phase kinds not runnable yet: ${unsupported.map((p) => `${p.phase} (${p.kind})`).join(', ')}`);
    }
    const missing = [];
    for (const role of pipelineRoles(pipeline)) {
      if (!(await hasTemplate(role, { projectDir }))) missing.push(role);
    }
    if (missing.length > 0) {
      throw fail('ERR_NO_TEMPLATE', `superagent: no prompt template for role${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`, { roles: missing });
    }
    return pipeline;
  }

  // Built with the runner's own attemptDir, so the bound cannot drift from the
  // directories it actually creates.
  function longestAttemptPath(pipeline, { jobId, slug }) {
    const primaryWorktree = path.join(path.resolve(worktreesRoot), slug, 'primary');
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
  // only a root too long for SLUG_BASE_MIN characters is refused.
  function fitSlug(pipeline, { title, jobId }) {
    if (platform !== 'win32') return slugify(title, jobId);
    const bare = longestAttemptPath(pipeline, { jobId, slug: `-${String(jobId).slice(0, 8)}` }).length;
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

  async function provision(job) {
    try {
      for (const repo of job.repos) {
        const worktree = path.join(worktreesRoot, job.slug, repo.id);
        const made = await createWorktree({ git, origin: repo.origin, worktree, branch: job.branch, copyLocalClaudeSettings: job.copyLocalClaudeSettings });
        await store.append(job.jobId, { type: 'worktree-created', repo: repo.id, worktree: made.worktree, branch: made.branch, baseSha: made.baseSha, settingsCopy: made.settingsCopy });
      }
      await store.append(job.jobId, { type: 'job-provisioned' });
    } catch (err) {
      log(`provisioning job ${job.jobId} failed, worktrees kept`, err);
      await store.append(job.jobId, { type: 'job-failed', error: messageOf(err) });
    }
    return store.get(job.jobId);
  }

  async function createJob({ title, idea, primaryRepo: primaryPath, additionalRepos = [], mode = 'automatic', fixture = null }) {
    const origin = path.resolve(primaryPath);
    const resolved = config.resolve(origin);
    const pipeline = await resolvePipeline(resolved, fixture, origin);
    const jobId = idImpl();
    const slug = fitSlug(pipeline, { title, jobId });
    const created = {
      type: 'job-created',
      jobId,
      slug,
      title,
      idea,
      mode,
      branch: BRANCH_PREFIX + slug,
      createdDate: localDate(now()),
      repos: repoIds(origin, [...resolved.additionalRepos, ...additionalRepos].map((p) => path.resolve(p))),
      pipeline,
      models: resolved.models,
      limits: resolved.limits,
      router: { allowlist: resolved.routerModelAllowlist, maxInputTokens: resolved.routerMaxInputTokens, maxOutputTokens: resolved.routerMaxOutputTokens },
      workerPermissionMode: resolved.workerPermissionMode,
      copyLocalClaudeSettings: resolved.copyLocalClaudeSettings,
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

  function accept(jobId) {
    return withJob(jobId, async () => {
      const job = await requireJob(jobId);
      if (job.state !== 'needs-you' || job.reason !== 'ready-to-try') {
        throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} is ${job.state}${job.reason ? ` (${job.reason})` : ''}, not ready to try`);
      }
      const accepted = await appendConfirmed(jobId, { type: 'job-accepted' }, (j) => j.state === 'done');
      await archive(accepted);
      return accepted;
    });
  }

  function stopJob(jobId) {
    stopRequested.add(jobId);
    routing.get(jobId)?.controller.abort();
    return withJob(jobId, async () => {
      try {
        const job = await requireJob(jobId);
        if (job.state === 'stopped') return job;
        if (job.state === 'done' || job.state === 'failed') {
          throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} is already ${job.state}`);
        }
        await runner.stopAttempt(jobId);
        const stopped = await appendConfirmed(jobId, { type: 'job-stopped' }, (j) => j.state === 'stopped');
        pendingDecisions.delete(jobId);
        await archive(stopped);
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

  function getJob(jobId) {
    const bad = corrupt.get(jobId);
    return bad ? structuredClone(bad) : store.get(jobId);
  }

  async function orphanWorktrees() {
    const jobs = [...known].map((jobId) => store.get(jobId)).filter(Boolean);
    const repos = [...new Set(jobs.flatMap((j) => j.repos.map((r) => r.origin)))];
    const knownBranches = new Set(jobs.map((j) => j.branch));
    return listOrphanWorktrees({ git, repos, knownBranches });
  }

  return { start, stop, tick, drain, createJob, accept, stopJob, listJobs, getJob, orphanWorktrees };
}
