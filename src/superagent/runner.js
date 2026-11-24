// Superagent runner: launches one attempt at a time per job as a registry
// session, watches it, and records exactly one attempt-ended for it.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md.
// - Worker contract (completion detection): an attempt is finished when its
//   turn has ended (row idle, nothing queued, a `result` seen since the last
//   prompt) and result.json is read. A missing or rejected result gets one
//   nudge (a rejected one with the validator's error); a second miss fails the
//   attempt (turn-cap, invalid-result or no-result). No worker
//   progress for limits.stallMinutes fails it as stalled; only PROGRESS_TYPES
//   count as progress, so telemetry (rate-limit, status) cannot keep a dead
//   worker alive.
// - Permissions (spike S1): every ask from a worker is denied with
//   denyMessageFor(phase kind), whatever the permission mode, including the
//   brainstormer's AskUserQuestion: no question reaches the user except through
//   needs-you. The session is started with interceptEveryPermission so asks
//   reach the interceptor at all.
// - Read-only roles (the stand-in) run with READ_ONLY_TOOLS and no MCP, so they
//   reply with their result JSON as the final message. review() writes it to
//   result.json as soon as scan sees it (materialize, not a claimer), so
//   removal, stall, stop and reconcile all judge the on-disk file. A reply
//   whose row is removed, or whose cockpit dies, before the next scan is lost.
// - Tokens: attempt-ended carries the row's usage totals at finish, the last
//   scan's snapshot once the row is removed, or null with no live record
//   (reconcile).
// - Context drift (spike S2): PreCompact is an observation point only. The hook
//   logs a `precompact` event and lets compaction continue.
//
// One finish per attempt: every path that may end an attempt (turn end,
// stall, removal, stopAttempt, launch failure) calls claim() before its first
// await. claim() is synchronous and refuses if live.finishing is already set,
// so two paths racing on one attempt can never both append attempt-ended. The
// nudge is the only non-terminal claimer: it releases the claim and replays a
// removal recorded meanwhile.
//
// In-place safety gate (Plan 7): beforeSession(job) is the last await before
// createSession for a job with an in-place repo, since the budget check,
// attempt start and prompt reads all await first and an earlier pass of the
// gate may be stale. A failure ends the attempt without a session (failed,
// folder-changed, which the sequencer leaves out of its scope) and pauses the
// job with needs-you folder-changed.
//
// live.sessionId is stamped synchronously right after createSession, before
// the first await: the approval interceptor and the removal listener look the
// attempt up by session id and either can fire during that await (same reason
// as src/autopilot.js:517).
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../json-store.js';
import { RESULT_FILE, attemptDir, outcomeForResult, primaryRepo, readResult, validateResult } from './results.js';
import { READ_ONLY_ROLES, READ_ONLY_TOOLS, buildWorkerPrompt, denyMessageFor, nudgeText } from './prompts.js';
import { folderChangedEvent } from './inplace.js';
import { attemptContext, failureSignature } from './sequencer.js';
import { defaultGit } from './worktree.js';

export const PROGRESS_TYPES = new Set(['assistant', 'user', 'result']);

export const FAILURE_DETAIL_CHARS = 500;
// The signature is normalised for repeated-error matching; `detail` keeps the
// readable text so the router and the next attempt can see what went wrong.
const failed = (reason, detail) => {
  const text = String(detail ?? '').trim();
  return { outcome: 'failed', reason, signature: failureSignature(reason, detail), ...(text && { detail: text.slice(0, FAILURE_DETAIL_CHARS) }) };
};
const messageOf = (err) => String(err?.message ?? err);
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const sumTokens = (totals) => (totals && TOKEN_KEYS.every((k) => Number.isFinite(totals[k])) ? TOKEN_KEYS.reduce((sum, k) => sum + totals[k], 0) : null);

// A read-only worker's final message: a fenced ```json block if present, else
// the first `{` to the last `}`. Only a JSON object counts, so a reply that is
// wholly JSON of another shape (an array) is refused rather than sliced.
export function extractResultJson(text) {
  if (typeof text !== 'string') return null;
  const parse = (candidate) => {
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      return null;
    }
  };
  const fenced = /```json\s*([\s\S]*?)```/.exec(text);
  const parsed = fenced ? parse(fenced[1]) : (parse(text) ?? parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  const value = parsed?.value;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function createRunner({
  registry,
  store,
  results = { readResult, validateResult },
  git = defaultGit,
  now = Date.now,
  idImpl = randomUUID,
  logImpl = console.error,
  projectDirFor = (job) => primaryRepo(job).origin,
  writeJsonImpl = writeJsonAtomic,
  beforeSession = null,
}) {
  const lives = new Map();
  const bySession = new Map();
  // Session id -> the phase kind its deny message is chosen by.
  const ownedPhaseKinds = new Map();
  const tracked = new Set();
  let stopping = false;

  function log(message, err) {
    try {
      logImpl(`superagent runner: ${message}${err === undefined ? '' : `: ${messageOf(err)}`}`);
    } catch { /* logging must never break the runner */ }
  }

  function track(promise) {
    const settled = promise.catch((err) => log('unexpected failure', err));
    tracked.add(settled);
    settled.finally(() => tracked.delete(settled));
    return settled;
  }

  function claim(live, work) {
    if (live.finishing) return null;
    live.finishing = track(Promise.resolve().then(work));
    return live.finishing;
  }

  function drop(live) {
    if (lives.get(live.jobId) === live) lives.delete(live.jobId);
    if (live.sessionId && bySession.get(live.sessionId) === live) bySession.delete(live.sessionId);
  }

  function closeRow(live) {
    if (!live.sessionId || !registry.get(live.sessionId)) return;
    try {
      registry.closeSession(live.sessionId);
    } catch (err) {
      log(`could not close session ${live.sessionId}`, err);
    }
  }

  const endedEvent = (live, payload) => ({ type: 'attempt-ended', attemptId: live.attemptId, ...payload });

  // A removed row is gone from the registry, so fall back to the last scan's snapshot.
  function tokensOf(live) {
    const row = registry.get(live.sessionId);
    return row ? sumTokens(row.usageAcc?.totals) : live.tokens;
  }

  async function finish(live, outcome) {
    live.intended = true;
    const payload = { ...outcome, tokens: tokensOf(live) };
    try {
      await store.append(live.jobId, endedEvent(live, payload));
      live.pendingEnd = null;
      drop(live);
    } catch (err) {
      live.pendingEnd = payload;
      log(`could not record the end of attempt ${live.attemptId}, will retry`, err);
    }
    closeRow(live);
  }

  // A rejected append may still have landed, so look before appending again.
  function retryPendingEnd(live) {
    if (!live.retrying) {
      live.retrying = track((async () => {
        try {
          const job = await store.load(live.jobId);
          const landed = job.attempts.some((a) => a.attemptId === live.attemptId && a.outcome);
          if (!landed) await store.append(live.jobId, endedEvent(live, live.pendingEnd));
          live.pendingEnd = null;
          drop(live);
          closeRow(live);
        } catch (err) {
          log(`could not record the end of attempt ${live.attemptId}, will retry`, err);
        } finally {
          live.retrying = null;
        }
      })());
    }
    return live.retrying;
  }

  async function safeRead(dir) {
    try {
      return await results.readResult(dir);
    } catch (err) {
      return { state: 'unparseable', error: messageOf(err) };
    }
  }

  const contextOf = ({ purpose, round, final, task, taskDef, reviewFindings, contested, openQuestions, askedIds }) => ({ purpose, round, final, task, taskDef, reviewFindings, contested, openQuestions, askedIds });

  // Not a claimer: a failed write leaves materialized false for the next scan.
  async function materialize(live) {
    if (!live.readOnly || live.finalText == null || live.materialized) return;
    const text = live.finalText;
    const value = extractResultJson(text);
    if (!value) return;
    try {
      await writeJsonImpl(path.join(live.dir, RESULT_FILE), { ...value, jobId: live.jobId, phaseId: live.phase, taskId: live.task, attemptId: live.attemptId });
      if (live.finalText === text) live.materialized = true;
    } catch (err) {
      log(`could not write the result of attempt ${live.attemptId}, will retry`, err);
    }
  }

  // { read, payload } for a valid result, { read, invalid } for a present but
  // invalid one, { read } otherwise. `context` is the live record's attempt
  // context, or attemptContext() rebuilt from the job on reconcile.
  async function judge(attempt, job, context) {
    const read = await safeRead(attempt.dir);
    if (read.state !== 'present') return { read };
    let verdict;
    try {
      verdict = await results.validateResult(read.value, {
        expected: { jobId: attempt.jobId, phaseId: attempt.phase, taskId: attempt.task ?? null, attemptId: attempt.attemptId },
        phase: job?.pipeline.find((p) => p.phase === attempt.phase),
        job,
        git,
        attempt: context,
      });
    } catch (err) {
      verdict = { ok: false, errors: [messageOf(err)] };
    }
    if (!verdict.ok) return { read, invalid: failed('invalid-result', verdict.errors?.[0] ?? '') };
    const r = verdict.result;
    return {
      read,
      payload: {
        summary: r.summary,
        artifacts: r.artifacts,
        commits: r.commits ?? [],
        outputs: r.outputs ?? {},
        question: r.question ?? null,
        verdict: r.verdict ?? null,
        findings: r.findings ?? null,
        verified: r.verified ?? null,
        questions: r.questions ?? null,
        answers: r.answers ?? null,
        escalated: r.escalated ?? null,
        ...outcomeForResult(r),
      },
    };
  }

  function releaseClaim(live) {
    live.finishing = null;
    const reason = live.removedReason;
    if (reason == null) return;
    live.removedReason = null;
    if (lives.get(live.jobId) === live) removed(live, reason);
  }

  function removed(live, reason) {
    if (live.intended) return;
    if (stopping) {
      drop(live);
      return;
    }
    if (live.finishing) {
      live.removedReason = reason;
      return;
    }
    claim(live, async () => {
      await materialize(live);
      const verdict = await judge(live, store.get(live.jobId), contextOf(live));
      await finish(live, verdict.payload ?? failed('no-result', `session ${reason}`));
    });
  }

  async function nudge(live, rejected = null) {
    const kind = rejected ? 'invalid-result' : live.lastResultSubtype === 'error_max_turns' ? 'turn-cap' : 'result';
    live.nudge = kind;
    try {
      await store.append(live.jobId, { type: 'attempt-nudged', attemptId: live.attemptId, kind });
    } catch (err) {
      log(`could not record the nudge for attempt ${live.attemptId}`, err);
    }
    const row = registry.get(live.sessionId);
    if (row && !stopping) {
      live.promptSeq = row.eventLog.nextSeq - 1;
      live.sawResult = false;
      try {
        await registry.sendInput(row.id, nudgeText(kind, { dir: live.dir, readOnly: live.readOnly, ledger: store.get(live.jobId)?.artifactRoot === 'ledger', error: rejected?.detail ?? null }));
      } catch (err) {
        // Row gone: the removal path owns the attempt. Row still there: the
        // stall deadline ends it.
        if (registry.get(row.id)) log(`could not nudge attempt ${live.attemptId}`, err);
      }
    }
    releaseClaim(live);
  }

  async function processTurnEnd(live) {
    await materialize(live);
    const verdict = await judge(live, store.get(live.jobId), contextOf(live));
    if (verdict.payload) return finish(live, verdict.payload);
    if (verdict.invalid) return live.nudge === null ? nudge(live, verdict.invalid) : finish(live, verdict.invalid);
    if (live.nudge === null) return nudge(live);
    if (live.sawMaxTurns) return finish(live, failed('turn-cap', 'turn limit reached'));
    if (verdict.read.state === 'unparseable') return finish(live, failed('invalid-result', verdict.read.error));
    return finish(live, failed('no-result', `no ${RESULT_FILE} after a nudge`));
  }

  function scan(live, row) {
    for (const { seq, message } of row.eventLog.entries) {
      if (seq <= live.scannedThrough) continue;
      live.scannedThrough = seq;
      if (!PROGRESS_TYPES.has(message?.type)) continue;
      live.lastProgressAt = now();
      if (message.type === 'result' && seq > live.promptSeq) {
        live.sawResult = true;
        live.lastResultSubtype = message.subtype ?? null;
        live.sawMaxTurns ||= message.subtype === 'error_max_turns';
        live.finalText = typeof message.result === 'string' ? message.result : null;
        live.materialized = false;
      }
    }
    live.tokens = sumTokens(row.usageAcc?.totals);
  }

  async function review(job) {
    const live = lives.get(job.jobId);
    if (!live) return;
    if (live.pendingEnd) return retryPendingEnd(live);
    if (stopping || live.finishing || !live.sessionId) return;
    const row = registry.get(live.sessionId);
    if (!row) return;
    scan(live, row);
    if (live.readOnly && live.finalText != null && !live.materialized) {
      await materialize(live);
      if (stopping || live.finishing) return;
    }
    if (row.state === 'idle' && row.queue.length === 0 && live.sawResult) {
      await claim(live, () => processTurnEnd(live));
      return;
    }
    const stallMinutes = job.limits.stallMinutes;
    if (row.pendingApprovals.length === 0 && now() - live.lastProgressAt >= stallMinutes * 60_000) {
      await claim(live, () => finish(live, failed('stalled', `no worker progress for ${stallMinutes} minutes`)));
    }
  }

  async function endLaunch(live, err) {
    log(`launch of attempt ${live.attemptId} failed`, err);
    const claimed = claim(live, () => finish(live, failed('launch-failed', messageOf(err))));
    if (claimed) await claimed;
    return { error: 'launch-failed' };
  }

  // Spec "What a job records": a recorded workflow prompt that disappeared is
  // never replaced by the built-in; the job goes stuck instead.
  async function endPromptMissing(live, err) {
    log(`launch of attempt ${live.attemptId} failed`, err);
    const claimed = claim(live, async () => {
      await finish(live, failed('prompt-missing', err.path));
      if (live.pendingEnd) return;
      await store.append(live.jobId, { type: 'needs-you', reason: 'stuck', detail: { why: 'prompt-missing', path: err.path, phase: live.phase, task: live.task ?? null, role: live.role } });
    });
    if (claimed) await claimed;
    return { error: 'launch-failed' };
  }

  // Re-checked after every await before the attempt gets a session.
  async function gate(live) {
    if (live.finishing) return { error: 'job-not-running' };
    if (stopping) {
      drop(live);
      return { error: 'stopping' };
    }
    if (store.get(live.jobId)?.state !== 'running') {
      await claim(live, () => finish(live, { outcome: 'stopped' }));
      return { error: 'job-not-running' };
    }
    return null;
  }

  async function folderGate(live, job) {
    if (!beforeSession || !job.repos.some((r) => r.inPlace === true)) return null;
    let check;
    try {
      check = await beforeSession(job);
    } catch (err) {
      check = { ok: false, text: `could not check this folder: ${messageOf(err)}` };
    }
    const blocked = await gate(live);
    if (blocked || check?.ok === true) return blocked;
    const claimed = claim(live, async () => {
      await finish(live, failed('folder-changed', check?.text ?? ''));
      if (live.pendingEnd) return;
      await store.append(live.jobId, folderChangedEvent({ text: check?.text ?? '', folder: check?.folder ?? null }));
    });
    if (claimed) await claimed;
    return { error: 'folder-changed' };
  }

  function preCompactHook(jobId, attemptId) {
    return async (input) => {
      try {
        await store.append(jobId, { type: 'precompact', attemptId, trigger: input?.trigger ?? null });
      } catch (err) {
        log(`could not record a precompact for attempt ${attemptId}`, err);
      }
      return { continue: true };
    };
  }

  async function launch(job, action) {
    if (stopping) return { error: 'stopping' };
    const { jobId } = job;
    if (lives.has(jobId)) return { error: 'busy' };
    const task = action.task ?? null;
    const phaseDef = job.pipeline.find((p) => p.phase === action.phase);
    let attemptId;
    let dir;
    try {
      attemptId = idImpl();
      dir = attemptDir(primaryRepo(job).worktree, { jobId, phase: action.phase, task, attemptId });
    } catch (err) {
      log(`could not prepare an attempt for job ${jobId}`, err);
      return { error: 'launch-failed' };
    }
    const live = {
      jobId,
      attemptId,
      role: action.role,
      phase: action.phase,
      // Only the phase's own worker gets its kind: the stand-in also runs in the brainstorm phase.
      phaseKind: phaseDef?.role === action.role ? phaseDef.kind : null,
      task,
      dir,
      purpose: action.purpose ?? 'author',
      round: action.round ?? null,
      final: action.final ?? false,
      taskDef: action.taskDef ?? null,
      reviewFindings: action.reviewFindings ?? null,
      contested: action.contested ?? null,
      openQuestions: action.openQuestions ?? null,
      askedIds: action.askedIds ?? null,
      readOnly: READ_ONLY_ROLES.has(action.role),
      finalText: null,
      materialized: false,
      tokens: null,
      sessionId: null,
      scannedThrough: 0,
      lastProgressAt: now(),
      promptSeq: 0,
      sawResult: false,
      sawMaxTurns: false,
      lastResultSubtype: null,
      nudge: null,
      finishing: null,
      removedReason: null,
      pendingEnd: null,
      intended: false,
      retrying: null,
    };
    lives.set(jobId, live);

    try {
      await mkdir(dir, { recursive: true });
      await store.append(jobId, {
        type: 'attempt-started',
        attemptId,
        phase: action.phase,
        task,
        role: action.role,
        model: action.model,
        n: action.n,
        recovery: action.recovery,
        previousAttemptId: action.previousAttemptId,
        handoff: action.handoff ?? null,
        ...(action.retryNote ? { retryNote: action.retryNote } : {}),
        dir,
        purpose: live.purpose,
        round: live.round,
        final: live.final,
      });
    } catch (err) {
      drop(live);
      log(`could not record the start of attempt ${attemptId}`, err);
      return { error: 'store-failed' };
    }
    let blocked = await gate(live);
    if (blocked) return blocked;

    let prompt;
    try {
      const current = store.get(jobId) ?? job;
      prompt = await buildWorkerPrompt({
        role: action.role,
        job: current,
        phase: current.pipeline.find((p) => p.phase === action.phase),
        attempt: {
          attemptId,
          phase: action.phase,
          role: action.role,
          n: action.n,
          recovery: action.recovery,
          previousAttemptId: action.previousAttemptId,
          handoff: action.handoff ?? null,
          retryNote: action.retryNote ?? null,
          dir,
          ...contextOf(live),
        },
        projectDir: projectDirFor(current),
      });
    } catch (err) {
      return err?.code === 'ERR_PROMPT_MISSING' ? endPromptMissing(live, err) : endLaunch(live, err);
    }
    blocked = await gate(live);
    if (blocked) return blocked;
    blocked = await folderGate(live, store.get(jobId) ?? job);
    if (blocked) return blocked;

    const current = store.get(jobId) ?? job;
    const primary = primaryRepo(current);
    let row;
    try {
      row = registry.createSession({
        cwd: primary.worktree,
        provider: 'claude',
        model: action.model,
        effort: action.effort ?? undefined,
        permissionMode: current.workerPermissionMode,
        name: null,
        sdkOptions: {
          additionalDirectories: current.repos.filter((r) => r !== primary).map((r) => r.worktree),
          maxTurns: action.maxTurns,
          appendSystemPrompt: prompt.system,
          interceptEveryPermission: true,
          hooks: { PreCompact: [{ hooks: [preCompactHook(jobId, attemptId)] }] },
          ...(live.readOnly ? { tools: [...READ_ONLY_TOOLS], disallowedTools: ['mcp__*'] } : {}),
        },
      });
    } catch (err) {
      return endLaunch(live, err);
    }
    ownedPhaseKinds.set(row.id, live.phaseKind);
    live.sessionId = row.id;
    live.promptSeq = live.scannedThrough = row.eventLog.nextSeq - 1;
    live.lastProgressAt = now();
    bySession.set(row.id, live);

    try {
      await store.append(jobId, { type: 'attempt-session', attemptId, sessionId: row.id });
    } catch (err) {
      return endLaunch(live, err);
    }
    // A removal or stop during that await owns the attempt. While stopping,
    // shutdown closes the row and the attempt stays in flight for reconcile.
    if (live.finishing || !registry.get(row.id) || stopping) return { attemptId };

    try {
      await registry.sendInput(row.id, prompt.card);
    } catch (err) {
      if (!registry.get(row.id)) return { attemptId };
      return endLaunch(live, err);
    }
    return { attemptId };
  }

  async function reconcile(job) {
    for (const attempt of job.attempts) {
      if (attempt.outcome) continue;
      if (lives.get(job.jobId)?.attemptId === attempt.attemptId) continue;
      const verdict = attempt.dir ? await judge({ ...attempt, jobId: job.jobId }, job, attemptContext(job, attempt)) : {};
      await store.append(job.jobId, { type: 'attempt-ended', attemptId: attempt.attemptId, ...(verdict.payload ?? verdict.invalid ?? { outcome: 'interrupted' }), tokens: null });
    }
  }

  async function stopAttempt(jobId) {
    for (;;) {
      const live = lives.get(jobId);
      if (!live) return;
      if (live.pendingEnd) {
        await retryPendingEnd(live);
        return;
      }
      if (live.finishing) {
        const before = live.finishing;
        await before;
        if (lives.get(jobId) === live && live.finishing === before && !live.pendingEnd) return;
        continue;
      }
      await claim(live, () => finish(live, { outcome: 'stopped' }));
      return;
    }
  }

  // In `auto` mode the SDK does not call canUseTool for ordinary tools
  // (confirmed by the 2026-11-04 probe), so this deny rule only covers the
  // asks the SDK actually makes. Ownership outlives the attempt: a row whose
  // close failed, or that shutdown has yet to close, is still denied.
  function onApprovalRequest({ row }) {
    const phaseKind = ownedPhaseKinds.get(row?.id);
    if (phaseKind === undefined) return null;
    return { behavior: 'deny', message: denyMessageFor(phaseKind) };
  }

  function onSessionRemoved({ id, reason }) {
    ownedPhaseKinds.delete(id);
    const live = bySession.get(id);
    if (!live) return;
    removed(live, reason);
  }

  async function drain() {
    while (tracked.size) await Promise.allSettled([...tracked]);
  }

  return {
    launch,
    review,
    reconcile,
    stopAttempt,
    onApprovalRequest,
    onSessionRemoved,
    ownsSession: (sessionId) => ownedPhaseKinds.has(sessionId),
    liveCount: () => lives.size,
    isLive: (jobId) => lives.has(jobId),
    setStopping(flag) {
      stopping = Boolean(flag);
    },
    drain,
  };
}
