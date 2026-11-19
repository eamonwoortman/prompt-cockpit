// Superagent's HTTP surface. Operator-gated by server.js's /api/ check, like
// routes/autopilot.js. Every action goes through host.admit and every read
// through host.read, so "not owner", "starting" and "stopping" are answered by
// the host (src/superagent-host.js), never by a route holding the supervisor.
import { respondJson, readJsonBody } from '../http-utils.js';
import { isValidCwd } from '../session-launcher.js';
import { artifactWriterEnded, jobSummary, jobDetail } from '../superagent/view-model.js';
import { readArtifact, snapshotDirFor } from '../superagent/artifacts.js';

const TITLE_WORDS = 8;

const BAD_REQUEST = new Set([
  'ERR_INVALID_ANSWER', 'ERR_UNKNOWN_ARTIFACT', 'ERR_ARTIFACT_OUTSIDE',
  'ERR_NOT_GIT_REPO', 'ERR_NO_COMMITS', 'ERR_BRANCH_EXISTS', 'ERR_WORKTREE_PATH_EXISTS', 'ERR_DUPLICATE_REPO',
  'ERR_INVALID_CONFIG', 'ERR_NO_TEMPLATE', 'ERR_PATH_TOO_LONG', 'ERR_PHASE_KIND_UNSUPPORTED', 'ERR_MODE_UNSUPPORTED',
  'ERR_UNKNOWN_WORKFLOW', 'ERR_INVALID_WORKFLOW', 'ERR_INVALID_REQUEST',
  'ERR_FOLDER_DIRTY', 'ERR_FOLDER_BUSY_GIT', 'ERR_FOLDER_ON_JOB_BRANCH', 'ERR_FOLDER_CHANGED',
]);

function statusFor(err) {
  if (err?.code === 'ERR_SUPERAGENT_UNAVAILABLE') return err.status;
  if (err?.code === 'ERR_UNKNOWN_JOB' || err?.code === 'ERR_UNKNOWN_ATTEMPT' || err?.code === 'ERR_ARTIFACT_MISSING' || err?.code === 'ERR_TRANSCRIPT_MISSING') return 404;
  if (err?.code === 'ERR_INVALID_STATE' || err?.code === 'ERR_FOLDER_IN_USE' || err?.code === 'ERR_TRANSCRIPT_AMBIGUOUS') return 409;
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

export function registerSuperagentRoutes(router, { host, registry, readArtifactImpl = readArtifact }) {
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
}
