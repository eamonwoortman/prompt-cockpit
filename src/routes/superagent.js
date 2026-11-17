// Superagent's HTTP surface. Operator-gated by server.js's /api/ check, like
// routes/autopilot.js. Every action goes through host.admit and every read
// through host.read, so "not owner", "starting" and "stopping" are answered by
// the host (src/superagent-host.js), never by a route holding the supervisor.
import { respondJson, readJsonBody } from '../http-utils.js';
import { isValidCwd } from '../session-launcher.js';
import { jobSummary, jobDetail } from '../superagent/view-model.js';
import { readArtifact } from '../superagent/artifacts.js';

const TITLE_WORDS = 8;

const BAD_REQUEST = new Set([
  'ERR_INVALID_ANSWER', 'ERR_UNKNOWN_ARTIFACT', 'ERR_ARTIFACT_OUTSIDE',
  'ERR_NOT_GIT_REPO', 'ERR_NO_COMMITS', 'ERR_BRANCH_EXISTS', 'ERR_WORKTREE_PATH_EXISTS', 'ERR_DUPLICATE_REPO',
  'ERR_INVALID_CONFIG', 'ERR_NO_TEMPLATE', 'ERR_PATH_TOO_LONG', 'ERR_PHASE_KIND_UNSUPPORTED', 'ERR_MODE_UNSUPPORTED',
]);

function statusFor(err) {
  if (err?.code === 'ERR_SUPERAGENT_UNAVAILABLE') return err.status;
  if (err?.code === 'ERR_UNKNOWN_JOB' || err?.code === 'ERR_ARTIFACT_MISSING') return 404;
  if (err?.code === 'ERR_INVALID_STATE') return 409;
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
  if (typeof body.idea !== 'string' || !body.idea.trim()) return 'an idea is required';
  if (body.additionalRepos !== undefined && !Array.isArray(body.additionalRepos)) return 'additionalRepos must be a list of folders';
  for (const folder of [body.primaryRepo, ...(body.additionalRepos ?? [])]) {
    if (!isValidCwd(folder)) return `not a directory: ${folder}`;
  }
  return null;
}

function titleFor(body) {
  const given = typeof body.title === 'string' ? body.title.trim() : '';
  return given || body.idea.trim().split(/\s+/).slice(0, TITLE_WORDS).join(' ');
}

export function registerSuperagentRoutes(router, { host, registry, readArtifactImpl = readArtifact }) {
  const isLive = (sessionId) => Boolean(registry.get(sessionId));

  router.get('/api/superagent', async (req, res) => {
    const jobs = host.read((supervisor) => supervisor.listJobs().map(jobSummary)) ?? [];
    return respondJson(res, 200, { status: host.status(), jobs });
  });

  router.get('/api/superagent/jobs/:id', async (req, res, url, { id }) => {
    try {
      return respondJson(res, 200, jobDetail(await readJob(host, id), { isLive }));
    } catch (err) {
      return respondError(res, err);
    }
  });

  router.post('/api/superagent/jobs', async (req, res) => {
    const body = await readJsonBody(req);
    const problem = validateCreate(body);
    if (problem) return respondJson(res, 400, { error: problem });
    try {
      const job = await host.admit((supervisor) => supervisor.createJob({
        title: titleFor(body),
        idea: body.idea,
        primaryRepo: body.primaryRepo,
        additionalRepos: body.additionalRepos ?? [],
        mode: 'automatic',
        fixture: null,
      }));
      return respondJson(res, 200, jobSummary(job));
    } catch (err) {
      return respondError(res, err);
    }
  });

  // An answer names the needs-you it was written for (`needsYouSeq`, from the
  // detail's needsYou.seq), so text a stale view wrote for one question can
  // never reach the next one: the supervisor refuses a mismatch with 409
  // ERR_INVALID_STATE before appending anything. Accept checks it when given.
  const actions = {
    answer: (supervisor, id, body) => supervisor.answerQuestion(id, body.text, { needsYouSeq: body.needsYouSeq }),
    accept: (supervisor, id, body) => supervisor.accept(id, { needsYouSeq: body.needsYouSeq }),
    stop: (supervisor, id) => supervisor.stopJob(id),
  };
  for (const [name, act] of Object.entries(actions)) {
    router.post(`/api/superagent/jobs/:id/${name}`, async (req, res, url, { id }) => {
      const body = await readJsonBody(req);
      if (name === 'answer' && !Number.isInteger(body.needsYouSeq)) {
        return respondJson(res, 400, { error: 'needsYouSeq is required: the needs-you this answer was written for', code: 'ERR_INVALID_ANSWER' });
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
      return respondJson(res, 200, await readArtifactImpl(await readJob(host, id), key));
    } catch (err) {
      return respondError(res, err);
    }
  });
}
