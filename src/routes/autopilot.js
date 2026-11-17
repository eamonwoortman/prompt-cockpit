// Auto-pilot's HTTP surface, registered alongside the existing four route
// modules. Everything under /api/ already requires the operator token
// (src/server.js:75-78), so these inherit process-level auth: operator-gated
// but not session-token-gated, like /api/browse and /api/resumable.
//
// POST for update rather than PUT/PATCH because src/router.js exposes
// get/post/delete/any only (src/router.js:69-75).
import { respondJson, readJsonBody } from '../http-utils.js';
import { parseProvider } from '../provider-registry.js';
import { isValidCwd } from '../session-launcher.js';
import { isSafeGrokArg } from '../grok-acp.js';

// Validation that needs to know about providers and the filesystem, which
// autopilot-store.js deliberately does not (it would drag the agent SDK into
// a plain data store). Returns an error string, or null.
function validateAgainstProviders(body, existing = null) {
  const cwd = body.cwd ?? existing?.cwd;
  if (cwd !== undefined && !isValidCwd(cwd)) return `not a directory: ${cwd}`;

  const providerId = body.provider ?? existing?.provider;
  let descriptor;
  try {
    descriptor = parseProvider(providerId);
  } catch (err) {
    return err.message;
  }

  const model = body.model ?? existing?.model;
  if (model && !isSafeGrokArg(model)) return `invalid model: ${model}`;

  const effort = body.effort ?? existing?.effort;
  if (effort && !descriptor.efforts.includes(effort)) {
    return `invalid effort for ${descriptor.label}: ${effort}`;
  }
  return null;
}

function statusFor(err) {
  if (err?.code === 'ERR_NAME_TAKEN') return 409;
  if (err?.code === 'ERR_INVALID_PILOT') return 400;
  return 500;
}

export function registerAutopilotRoutes(router, { store, log, supervisor, registry, now = () => Date.now() }) {
  router.get('/api/autopilots', async (req, res) => {
    const { settings, pilots } = await store.read();
    const spend = await log.dailyCostUsd(now());
    return respondJson(res, 200, {
      settings,
      pilots,
      running: supervisor.status(),
      spend,
    });
  });

  router.post('/api/autopilots', async (req, res) => {
    const body = await readJsonBody(req);
    const problem = validateAgainstProviders(body);
    if (problem) return respondJson(res, 400, { error: problem });
    try {
      return respondJson(res, 201, await store.createPilot(body));
    } catch (err) {
      return respondJson(res, statusFor(err), { error: String(err.message || err) });
    }
  });

  router.post('/api/autopilots/:id', async (req, res, url, { id }) => {
    const existing = await store.getPilot(id);
    if (!existing) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const body = await readJsonBody(req);
    const problem = validateAgainstProviders(body, existing);
    if (problem) return respondJson(res, 400, { error: problem });
    try {
      // An edit applies from the NEXT firing: a run in flight is untouched,
      // because its session was already created with the old model/mode and
      // cannot adopt new ones coherently.
      return respondJson(res, 200, await store.updatePilot(id, body));
    } catch (err) {
      return respondJson(res, statusFor(err), { error: String(err.message || err) });
    }
  });

  router.delete('/api/autopilots/:id', async (req, res, url, { id }) => {
    const existing = await store.getPilot(id);
    if (!existing) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    // Force-close the live run FIRST, then remove the record - otherwise the
    // supervisor is left holding a lock for a pilot that no longer exists.
    const live = supervisor.status().find((r) => r.pilotId === id);
    if (live) {
      // Drop the run from the supervisor's map FIRST. Otherwise
      // closeSession's synchronous removal listener classifies it as
      // `closed-externally` and writes both a log entry and a recordRun
      // against a pilot we delete two statements later - a phantom outcome in
      // the Logs tab for what was actually a delete.
      await supervisor.abandonRun(id);
      // Final fix wave, item 7: match reviewRuns' own closeSession call sites
      // (src/autopilot.js:646-651) - the lock is already released above, so a
      // throw here must not abort the delete itself.
      try {
        registry.closeSession(live.sessionId);
      } catch { /* best effort - the delete must proceed regardless */ }
    }
    await supervisor.drain();
    await store.deletePilot(id);
    return respondJson(res, 200, { deleted: true, closedSessionId: live?.sessionId ?? null });
  });

  router.post('/api/autopilots/:id/toggle', async (req, res, url, { id }) => {
    const existing = await store.getPilot(id);
    if (!existing) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const body = await readJsonBody(req);
    const enabled = body.enabled === undefined ? !existing.enabled : Boolean(body.enabled);
    const pilot = await store.setEnabled(id, enabled);
    // Re-enabling by hand is the documented recovery from an auto-disable, so
    // clear the back-off that got it there.
    if (enabled && (pilot.consecutiveFailures || 0) > 0) {
      return respondJson(res, 200, await store.recordRun(id, { consecutiveFailures: 0 }));
    }
    return respondJson(res, 200, pilot);
  });

  router.post('/api/autopilots/:id/run-now', async (req, res, url, { id }) => {
    if (!(await store.getPilot(id))) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const result = await supervisor.runNow(id);
    if (result.fired) return respondJson(res, 200, result);
    // `error` as well as `reason`: every existing panel's client error path
    // reads `error`, and the auto-pilot panel a later task adds will too -
    // without it the pane renders a bare status code instead of "already
    // running".
    //
    // Fix round 1 (cheap item 4): "the session could not be created" is
    // createSession itself failing (a bad cwd, a CLI that refuses to start)
    // - a real internal failure, not a conflict with another run - so it
    // gets its own 500-class status rather than being lumped in with the
    // honest 409 refusals above it (already running, at the concurrency cap,
    // rate limited, spend-capped, gate failed, deleted, not started).
    // Final fix wave, item 7: keyed off `internalError`, a sentinel field
    // runNow() sets, rather than string-matching `result.reason` against the
    // exact createSession-failure prose (a copy-edit there would have
    // silently misrouted this to 409).
    const status = result.internalError ? 500 : 409;
    return respondJson(res, status, { error: result.reason, ...result });
  });

  router.get('/api/autopilots/:id/logs', async (req, res, url, { id }) => {
    if (!(await store.getPilot(id))) return respondJson(res, 404, { error: `unknown pilot: ${id}` });
    const limit = Number(url.searchParams.get('limit')) || 200;
    return respondJson(res, 200, { entries: await log.tail({ pilotId: id, limit }) });
  });

  // Every pilot's history interleaved, for the panel's Logs tab.
  router.get('/api/autopilot-logs', async (req, res, url) => {
    const limit = Number(url.searchParams.get('limit')) || 200;
    return respondJson(res, 200, { entries: await log.tail({ limit }) });
  });

  router.post('/api/autopilot-settings', async (req, res) => {
    const body = await readJsonBody(req);
    try {
      return respondJson(res, 200, await store.updateSettings(body));
    } catch (err) {
      return respondJson(res, statusFor(err), { error: String(err.message || err) });
    }
  });
}
