// Superagent's HTTP surface. Operator-gated by server.js's /api/ check, like
// routes/autopilot.js. Every action goes through host.admit and every read
// through host.read, so "not owner", "starting" and "stopping" are answered by
// the host (src/superagent-host.js), never by a route holding the supervisor.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondJson, readJsonBody } from '../http-utils.js';
import { isValidCwd } from '../session-launcher.js';
import { readSessionDefaults } from '../session-defaults.js';
import { CLAUDE_EFFORTS } from '../provider-registry.js';
import { artifactWriterEnded, jobSummary, jobDetail } from '../superagent/view-model.js';
import { readArtifact, snapshotDirFor } from '../superagent/artifacts.js';
import { defaultSuperagentRoot } from '../superagent/config.js';
import { gatedOut } from '../superagent/sequencer.js';
import { buildSnapshot, foldersWithin, grantedDirectories, renderRetrospectivePrompt, resolvePlugins } from '../superagent/retrospective.js';

const TITLE_WORDS = 8;
// The folder holding cockpit's package.json.
const COCKPIT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const RETRO_NAME_TRIES = 20;

const BAD_REQUEST = new Set([
  'ERR_INVALID_ANSWER', 'ERR_UNKNOWN_ARTIFACT', 'ERR_ARTIFACT_OUTSIDE',
  'ERR_NOT_GIT_REPO', 'ERR_NO_COMMITS', 'ERR_BRANCH_EXISTS', 'ERR_WORKTREE_PATH_EXISTS', 'ERR_DUPLICATE_REPO',
  'ERR_INVALID_CONFIG', 'ERR_NO_TEMPLATE', 'ERR_PATH_TOO_LONG', 'ERR_PHASE_KIND_UNSUPPORTED', 'ERR_MODE_UNSUPPORTED',
  'ERR_UNKNOWN_WORKFLOW', 'ERR_INVALID_WORKFLOW', 'ERR_INVALID_REQUEST',
  'ERR_FOLDER_DIRTY', 'ERR_FOLDER_BUSY_GIT', 'ERR_FOLDER_ON_JOB_BRANCH', 'ERR_FOLDER_CHANGED',
]);

function statusFor(err) {
  if (err?.code === 'ERR_SUPERAGENT_UNAVAILABLE') return err.status;
  if (err?.code === 'ERR_UNKNOWN_JOB' || err?.code === 'ERR_UNKNOWN_ATTEMPT' || err?.code === 'ERR_UNKNOWN_SELECTION' || err?.code === 'ERR_ARTIFACT_MISSING' || err?.code === 'ERR_TRANSCRIPT_MISSING') return 404;
  if (err?.code === 'ERR_INVALID_STATE' || err?.code === 'ERR_FOLDER_IN_USE' || err?.code === 'ERR_TRANSCRIPT_AMBIGUOUS' || err?.code === 'ERR_NAME_TAKEN') return 409;
  if (err?.code === 'ERR_ARTIFACT_GONE') return 410;
  if (BAD_REQUEST.has(err?.code)) return 400;
  return 500;
}

function respondError(res, err) {
  const body = { error: String(err?.message || err), code: err?.code };
  if (err?.code === 'ERR_SUPERAGENT_UNAVAILABLE') Object.assign(body, { state: err.state, ownerPort: err.ownerPort });
  return respondJson(res, statusFor(err), body);
}

const coded = (code, message) => Object.assign(new Error(message), { code });

// read() is null exactly where admit() refuses, so admit's refusal answers an
// unreadable host with the same status and body an action would get.
async function readJob(host, id) {
  const found = host.read((supervisor) => ({ job: supervisor.getJob(id) }));
  if (!found) await host.admit(() => null);
  if (!found?.job) throw coded('ERR_UNKNOWN_JOB', `unknown job: ${id}`);
  return found.job;
}

function validateCreate(body) {
  if (body.workflow != null && typeof body.workflow !== 'string') return { code: 'ERR_INVALID_REQUEST', error: 'workflow must be a workflow id' };
  if (body.inPlace !== undefined && (!Array.isArray(body.inPlace) || body.inPlace.some((p) => typeof p !== 'string'))) {
    return { code: 'ERR_INVALID_REQUEST', error: 'inPlace must be a list of folder paths' };
  }
  if (typeof body.idea !== 'string' || !body.idea.trim()) return { error: 'an idea is required' };
  if (body.additionalRepos !== undefined && !Array.isArray(body.additionalRepos)) return { error: 'additionalRepos must be a list of folders' };
  for (const folder of [body.primaryRepo, ...(body.additionalRepos ?? [])]) {
    if (!isValidCwd(folder)) return { error: `not a directory: ${folder}` };
  }
  return null;
}

function titleFor(body) {
  const given = typeof body.title === 'string' ? body.title.trim() : '';
  return given || body.idea.trim().split(/\s+/).slice(0, TITLE_WORDS).join(' ');
}

// A supervisor that cannot answer must not break the detail route.
async function settled(read) {
  try {
    return (await read()) ?? null;
  } catch {
    return null;
  }
}

// The body is exactly { attemptId }, { phase } or { phase, task }, all strings.
function parseSelector(body) {
  const keys = Object.keys(body).sort().join(',');
  if (!['attemptId', 'phase', 'phase,task'].includes(keys)) return null;
  return Object.values(body).every((v) => typeof v === 'string' && v) ? body : null;
}

// A stage covers every attempt that ran in it; a gated one never launched.
function selectAttempts(job, selector) {
  const unknown = (what) => coded('ERR_UNKNOWN_SELECTION', `job ${job.jobId} has no ${what}`);
  const attempts = job.attempts ?? [];
  if (selector.attemptId) {
    const attempt = attempts.find((a) => a.attemptId === selector.attemptId);
    if (!attempt) throw unknown(`attempt ${selector.attemptId}`);
    return { phase: attempt.phase, task: attempt.task ?? null, attempts: [attempt] };
  }
  const phase = (job.pipeline ?? []).find((p) => p.phase === selector.phase);
  if (!phase) throw unknown(`phase ${selector.phase}`);
  const task = selector.task ?? null;
  if (task !== null && phase.kind !== 'per-task') throw unknown(`tasks in phase ${selector.phase}`);
  const chosen = attempts.filter((a) => a.phase === selector.phase && (task === null || a.task === task) && !gatedOut(a));
  if (!chosen.length) throw unknown(`attempts in ${task === null ? selector.phase : `${selector.phase} / ${task}`}`);
  return { phase: selector.phase, task, attempts: chosen };
}

// The parent and grandparent of each folder, where dev clones are looked for.
function cloneSearchRoots(folders) {
  const roots = folders.flatMap((f) => [path.dirname(f), path.dirname(path.dirname(f))]);
  return [...new Map(roots.map((r) => [process.platform === 'win32' ? r.toLowerCase() : r, r])).values()];
}

async function persistedEffort(readDefaults, cwd) {
  const persisted = await readDefaults(cwd).catch(() => null);
  return persisted?.effort && CLAUDE_EFFORTS.includes(persisted.effort) ? persisted.effort : undefined;
}

// Spec F: a snapshot of what the selected attempts left, then a normal Claude
// session in cockpit's own repo (not supervisor-owned, so not watch only) that
// may also open the job's folders and the plugins' dev clones, and is sent the
// first prompt. Everything the supervisor holds is read inside admit.
function retrospectiveRoute({ host, registry, readArtifactImpl, options }) {
  const {
    cockpitRoot = COCKPIT_ROOT,
    superagentRoot = defaultSuperagentRoot(),
    claudeHome = path.join(os.homedir(), '.claude'),
    newId = randomUUID,
    readDefaults = readSessionDefaults,
    seedDefaults = async () => {},
    resolvePluginsImpl = resolvePlugins,
    log = (...args) => console.error(...args),
  } = options;
  const forbiddenRoots = [
    path.join(claudeHome, 'plugins', 'cache'),
    path.join(claudeHome, 'plugins', 'marketplaces'),
    path.join(claudeHome, 'projects'),
    path.dirname(superagentRoot),
    path.join(os.homedir(), '.prompt-cockpit'),
  ];
  const worktreesRoot = path.join(superagentRoot, 'worktrees');

  async function prepare(supervisor, jobId, selector) {
    const job = supervisor.getJob(jobId);
    if (!job) throw coded('ERR_UNKNOWN_JOB', `unknown job: ${jobId}`);
    const { phase, task, attempts } = selectAttempts(job, selector);
    const found = new Map();
    for (const a of attempts) found.set(a.attemptId, await supervisor.transcriptFor(jobId, a.attemptId));
    if (![...found.values()].some((f) => f?.status === 'found')) {
      throw coded('ERR_TRANSCRIPT_MISSING', 'none of the selected attempts has a transcript');
    }
    const usage = await settled(() => supervisor.usageForJob(jobId));
    const spend = Object.fromEntries(jobDetail(job, { usageFor: (a) => usage?.get(a.attemptId)?.usage ?? null }).attempts.map((a) => [a.attemptId, a.cost]));
    const snapshot = await buildSnapshot({ job, jobDir: supervisor.jobDir(jobId), attempts, found, root: superagentRoot, retroId: newId(), readArtifactFn: readArtifactImpl });
    return { job, phase, task, attempts, spend, snapshot };
  }

  async function createSession({ job, phase, task, attempts, spend, snapshot }) {
    const folders = (job.repos ?? []).map((r) => r.worktree).filter(Boolean);
    const plugins = await resolvePluginsImpl(snapshot.plugins, {
      pluginsRoot: path.join(claudeHome, 'plugins'),
      searchRoots: cloneSearchRoots([cockpitRoot, ...folders]),
      exclude: [...forbiddenRoots, worktreesRoot],
    });
    // Only a job's own worktree is exempt from the forbidden roots (Ruling 19).
    const { granted, dropped } = await grantedDirectories(
      [snapshot.dir, ...folders, ...plugins.flatMap((p) => p.clones)],
      { forbiddenRoots, allow: [snapshot.dir, ...(await foldersWithin(folders, worktreesRoot))] },
    );
    const template = await fs.readFile(path.join(cockpitRoot, 'prompts', 'superagent', 'retrospective.md'), 'utf8');
    const prompt = renderRetrospectivePrompt({ template, job, attempts, snapshot, plugins, cockpitRoot, spend, cards: snapshot.cards, dropped });
    const effort = await persistedEffort(readDefaults, cockpitRoot);
    const base = `Retro: ${job.title} · ${task === null ? phase : `${phase} / ${task}`}`;
    for (let n = 1; n <= RETRO_NAME_TRIES; n += 1) {
      try {
        return { row: registry.createSession({ cwd: cockpitRoot, name: n === 1 ? base : `${base} #${n}`, provider: 'claude', effort, sdkOptions: { additionalDirectories: granted } }), prompt };
      } catch (err) {
        if (err.code !== 'ERR_NAME_TAKEN') throw err;
      }
    }
    throw coded('ERR_NAME_TAKEN', `"${base}" and #2 to #${RETRO_NAME_TRIES} are all taken in this project`);
  }

  return async (req, res, url, { id }) => {
    const selector = parseSelector(await readJsonBody(req));
    if (!selector) return respondJson(res, 400, { error: 'the body must be { attemptId }, { phase } or { phase, task }', code: 'ERR_INVALID_REQUEST' });
    let prepared;
    let made;
    try {
      prepared = await host.admit((supervisor) => prepare(supervisor, id, selector));
      made = await createSession(prepared);
    } catch (err) {
      if (prepared) await fs.rm(prepared.snapshot.dir, { recursive: true, force: true }).catch(() => {});
      // On this route a missing transcript is a conflict with the request, not an unknown resource.
      if (err?.code === 'ERR_TRANSCRIPT_MISSING') return respondJson(res, 409, { error: err.message, code: err.code });
      return respondError(res, err);
    }
    const { row, prompt } = made;
    try {
      await seedDefaults(row);
    } catch (err) {
      log(`retrospective ${row.id}: could not apply the session defaults`, err);
    }
    try {
      await registry.sendInput(row.id, prompt);
    } catch (err) {
      registry.closeSession(row.id);
      return respondJson(res, 500, { error: `the retrospective prompt could not be sent: ${err?.message || err}` });
    }
    return respondJson(res, 200, { id: row.id, token: row.token, name: row.name });
  };
}

export function registerSuperagentRoutes(router, { host, registry, readArtifactImpl = readArtifact, retrospective = {} }) {
  const isLive = (sessionId) => Boolean(registry.get(sessionId));

  router.get('/api/superagent', async (req, res) => {
    const jobs = host.read((supervisor) => supervisor.listJobs().map(jobSummary)) ?? [];
    return respondJson(res, 200, { status: host.status(), jobs });
  });

  router.get('/api/superagent/jobs/:id', async (req, res, url, { id }) => {
    try {
      const job = await readJob(host, id);
      const usage = await settled(() => host.read((sv) => sv.usageForJob(id)));
      const states = await settled(() => host.read((sv) => sv.artifactStates(id)));
      return respondJson(res, 200, jobDetail(job, {
        isLive,
        usageFor: (a) => usage?.get(a.attemptId)?.usage ?? null,
        transcriptFor: (a) => usage?.get(a.attemptId)?.transcript ?? null,
        artifactStates: states,
      }));
    } catch (err) {
      return respondError(res, err);
    }
  });

  router.get('/api/superagent/workflows', async (req, res, url) => {
    const primary = url.searchParams.get('primary');
    if (!primary || !isValidCwd(primary)) return respondJson(res, 400, { error: primary ? `not a directory: ${primary}` : 'primary is required' });
    try {
      const listing = await host.admit((supervisor) => supervisor.listWorkflows(primary));
      return respondJson(res, 200, {
        workflows: listing.workflows.map(({ id, name, description, source, valid, errors }) => ({ id, name, description, source, valid, errors })),
        default: listing.default,
        defaultNote: listing.defaultNote ?? null,
      });
    } catch (err) {
      return respondError(res, err);
    }
  });

  router.post('/api/superagent/jobs', async (req, res) => {
    const body = await readJsonBody(req);
    const problem = validateCreate(body);
    if (problem) return respondJson(res, 400, problem);
    try {
      const job = await host.admit((supervisor) => supervisor.createJob({
        title: titleFor(body),
        idea: body.idea,
        primaryRepo: body.primaryRepo,
        additionalRepos: body.additionalRepos ?? [],
        mode: 'automatic',
        fixture: null,
        workflow: body.workflow?.trim() || null,
        inPlace: body.inPlace ?? [],
      }));
      return respondJson(res, 200, jobSummary(job));
    } catch (err) {
      return respondError(res, err);
    }
  });

  // An answer names the needs-you it was written for (`needsYouSeq`, from the
  // detail's needsYou.seq), so text a stale view wrote for one question can
  // never reach the next one: the supervisor refuses a mismatch with 409
  // ERR_INVALID_STATE before appending anything. Accept checks it when given;
  // retry requires it too.
  const actions = {
    answer: (supervisor, id, body) => supervisor.answerQuestion(id, body.text, { needsYouSeq: body.needsYouSeq }),
    accept: (supervisor, id, body) => supervisor.accept(id, { needsYouSeq: body.needsYouSeq }),
    retry: (supervisor, id, body) => supervisor.retryJob(id, { needsYouSeq: body.needsYouSeq, note: body.note }),
    stop: (supervisor, id) => supervisor.stopJob(id),
  };
  for (const [name, act] of Object.entries(actions)) {
    router.post(`/api/superagent/jobs/:id/${name}`, async (req, res, url, { id }) => {
      const body = await readJsonBody(req);
      if (name === 'answer' && !Number.isInteger(body.needsYouSeq)) {
        return respondJson(res, 400, { error: 'needsYouSeq is required: the needs-you this answer was written for', code: 'ERR_INVALID_ANSWER' });
      }
      if (name === 'retry' && !Number.isInteger(body.needsYouSeq)) {
        return respondJson(res, 400, { error: 'needsYouSeq is required: the stuck entry this retry was made for', code: 'ERR_INVALID_REQUEST' });
      }
      try {
        return respondJson(res, 200, jobSummary(await host.admit((supervisor) => act(supervisor, id, body))));
      } catch (err) {
        return respondError(res, err);
      }
    });
  }

  router.get('/api/superagent/jobs/:id/artifacts/:key', async (req, res, url, { id, key }) => {
    try {
      const job = await readJob(host, id);
      const snapshotDir = host.read((supervisor) => snapshotDirFor(supervisor.jobDir(id)));
      return respondJson(res, 200, await readArtifactImpl(job, key, { snapshotDir, ended: artifactWriterEnded(job, key) }));
    } catch (err) {
      return respondError(res, err);
    }
  });
  // The cwd is the transcript's own, which the history route needs to find the
  // file; it can differ from the attempt's worktree.
  router.get('/api/superagent/jobs/:id/attempts/:attemptId/transcript', async (req, res, url, { id, attemptId }) => {
    try {
      await readJob(host, id);
      const found = await host.read((supervisor) => supervisor.transcriptFor(id, attemptId));
      if (found?.status === 'found') return respondJson(res, 200, { claudeSessionId: found.claudeSessionId, cwd: found.cwd });
      if (found?.status === 'ambiguous') throw coded('ERR_TRANSCRIPT_AMBIGUOUS', 'more than one transcript matches this attempt');
      throw coded('ERR_TRANSCRIPT_MISSING', 'no transcript was found for this attempt');
    } catch (err) {
      return respondError(res, err);
    }
  });

  router.post('/api/superagent/jobs/:id/retrospective', retrospectiveRoute({ host, registry, readArtifactImpl, options: retrospective }));
}
