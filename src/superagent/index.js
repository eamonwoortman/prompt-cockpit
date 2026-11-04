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
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MILESTONE_1_PIPELINE, defaultSuperagentRoot, validateDefaults, validateMilestoneFixture } from './config.js';
import { primaryRepo } from './results.js';
import { createRunner } from './runner.js';
import { RUNNABLE_KINDS, nextAction } from './sequencer.js';
import { BRANCH_PREFIX, archiveLedger, createWorktree, defaultGit, listOrphanWorktrees, repoIds, slugify } from './worktree.js';

export const TICK_MS = 15_000;

const FIXTURES = { 'milestone-1': MILESTONE_1_PIPELINE };
const messageOf = (err) => String(err?.message ?? err);
const pad = (n) => String(n).padStart(2, '0');

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
}) {
  const runner = createRunner({ registry, store, git, now, idImpl, logImpl });
  const known = new Set();
  const corrupt = new Map();
  const chains = new Map();
  const provisioningNow = new Set();
  const stopRequested = new Set();
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

  async function stepJob(jobId) {
    if (stopping || provisioningNow.has(jobId)) return;
    let job = store.get(jobId);
    if (job?.state !== 'running') return;
    try {
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
      const action = nextAction(job, { now: now(), liveSessions: runner.liveCount(), maxConcurrentSessions });
      if (action.type === 'needs-you') {
        await store.append(jobId, { type: 'needs-you', reason: action.reason, detail: action.detail });
      } else if (action.type === 'launch') {
        await launchStep(jobId, job, action);
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
    await runner.drain();
    await store.flush();
  }

  async function stop() {
    stopping = true;
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

  function resolvePipeline(resolved, fixture) {
    if (fixture != null && !Object.hasOwn(FIXTURES, fixture)) {
      throw fail('ERR_UNKNOWN_FIXTURE', `superagent: unknown fixture ${JSON.stringify(fixture)}`);
    }
    const pipeline = fixture != null ? FIXTURES[fixture] : resolved.pipeline;
    const { errors } = fixture != null ? validateMilestoneFixture(resolved) : validateDefaults(resolved);
    if (errors.length > 0) {
      throw fail('ERR_INVALID_CONFIG', `superagent config is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { errors });
    }
    const unsupported = pipeline.filter((p) => !RUNNABLE_KINDS.has(p.kind));
    if (unsupported.length > 0) {
      throw fail('ERR_PHASE_KIND_UNSUPPORTED', `superagent: phase kinds not runnable yet: ${unsupported.map((p) => `${p.phase} (${p.kind})`).join(', ')}`);
    }
    return pipeline;
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
    const pipeline = resolvePipeline(resolved, fixture);
    const jobId = idImpl();
    const slug = slugify(title, jobId);
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
    return withJob(jobId, async () => {
      try {
        const job = await requireJob(jobId);
        if (job.state === 'stopped') return job;
        if (job.state === 'done' || job.state === 'failed') {
          throw fail('ERR_INVALID_STATE', `superagent: job ${jobId} is already ${job.state}`);
        }
        await runner.stopAttempt(jobId);
        const stopped = await appendConfirmed(jobId, { type: 'job-stopped' }, (j) => j.state === 'stopped');
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
