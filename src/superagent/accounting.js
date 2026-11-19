// Accounting queue (spec C): persists each ended attempt's spend, read from its
// Claude transcript through transcripts.js, into usage.json in Cockpit's own
// job directory. The supervisor owns it, so only the owner.lock holder writes.
// The heartbeat only enqueues (every known job, finished ones included, so past
// jobs are backfilled); items run one at a time, each racing itemBudgetMs, and
// a failed item is logged and retried on a later heartbeat. Items carry a kind:
// 'usage' or 'snapshot'.
//
// Provisional -> final: an ended attempt is written provisional with its
// fingerprint and refreshed whenever the fingerprint changes. It becomes final
// once its session is no longer live and a later run (a later heartbeat) sees
// the same fingerprint; final entries are never rescanned. A missing or
// ambiguous lookup writes nothing until the job is finished and the lookup has
// failed finalMissingAfter runs in a row; it is then recorded final-unknown, or
// a provisional entry already written is kept as final with its last spend.
// A gated attempt (sequencer's gatedOut) never launched a session and has no
// transcript, so it is not accounted.
//
// Snapshots (spec C2, R2-2): an attempt with an outcome, not gated and whose
// session is no longer live copies the artifacts it is the latest writer of
// (view-model's artifactWriters) into <jobDir>/artifacts, transcript or not.
// Progress is kept per key in usage.json's snapshots; a failed key is retried
// on a later heartbeat and done is final for that writer. A key whose recorded
// writer is newer than the item's view of the job is skipped, so a late retry
// never overwrites a newer snapshot.
//
// Cancellation (R2-1): every item gets an AbortSignal and every write goes
// through publish(), which does nothing once that signal is aborted or the
// queue is stopped. A timed-out item is aborted, not abandoned: it may keep
// running, but it can no longer write. stop({ deadline }) takes the caller's
// absolute deadline and adds no time of its own.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readJson, updateJson } from '../json-store.js';
import { ARTIFACT_MAX_BYTES, snapshotArtifact, snapshotDirFor } from './artifacts.js';
import { gatedOut } from './sequencer.js';
import { artifactWriters } from './view-model.js';

export const USAGE_FILE = 'usage.json';
const FINISHED_STATES = new Set(['done', 'stopped', 'failed']);
// A lookup that found nothing is reused for one heartbeat by usageForJob, so a
// polling view does not rescan every transcript on each request.
const LOOKUP_TTL_MS = 15_000;
const ABORTED = 'ERR_ACCOUNTING_ABORTED';
const OK = Symbol('ok');
const TIMED_OUT = Symbol('timed-out');
const STOPPED = Symbol('stopped');

const messageOf = (err) => String(err?.message ?? err);
const emptyUsage = () => ({ format: 1, attempts: {} });
const noTranscript = () => ({ available: false, claudeSessionId: null, cwd: null });
const foundFrom = (entry) => ({ status: 'found', claudeSessionId: entry.claudeSessionId, file: entry.file, cwd: entry.cwd ?? null });

function entryFrom(state, found, usage, scannedAt) {
  const tokens = { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    state,
    claudeSessionId: found.claudeSessionId,
    file: found.file,
    cwd: found.cwd ?? null,
    fingerprint: usage.fingerprint,
    knownCostUsd: usage.knownCostUsd,
    tokens,
    byModel: structuredClone(usage.byModel),
    unpricedModels: [...usage.unpricedModels],
    complete: usage.complete,
    conflicts: usage.conflicts,
    scannedAt,
  };
}

function usageView(state, entry) {
  const { knownCostUsd, tokens, byModel, unpricedModels, complete, claudeSessionId } = entry;
  return { state, knownCostUsd, tokens, byModel, unpricedModels, complete, claudeSessionId };
}

export function createAccounting({
  store,
  transcripts,
  isLive,
  now = Date.now,
  logImpl = console.error,
  itemBudgetMs = 10_000,
  finalMissingAfter = 3,
  statImpl = stat,
  snapshotImpl = snapshotArtifact,
  maxArtifactBytes = ARTIFACT_MAX_BYTES,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const pending = [];
  // Item keys pending or running, so a heartbeat never queues an attempt twice.
  const queued = new Set();
  const finals = new Set();
  // Attempt keys whose snapshot keys are all done (or taken over by a newer writer).
  const snapshotted = new Set();
  const misses = new Map();
  // attempt key -> { found, at }, shared by the queue and usageForJob.
  const lookups = new Map();
  // file + attempt -> { size, mtimeMs, ok }.
  const verified = new Map();
  let current = null;
  let pumping = null;
  let stopped = false;

  const attemptKey = (jobId, attemptId) => `${jobId}/${attemptId}`;
  const usageFile = (jobId) => path.join(store.jobDir(jobId), USAGE_FILE);
  const idsOf = (job, attempt) => ({ jobId: job.jobId, attemptId: attempt.attemptId });

  function log(message, err) {
    try {
      logImpl(`superagent: accounting: ${message}${err === undefined ? '' : `: ${messageOf(err)}`}`);
    } catch { /* logging must never break the queue */ }
  }

  const open = (signal) => !stopped && !signal.aborted;

  // fn receives check(), to call immediately before it writes.
  async function publish(signal, fn) {
    if (!open(signal)) return false;
    const check = () => {
      if (!open(signal)) throw Object.assign(new Error('accounting item aborted'), { code: ABORTED });
    };
    try {
      await fn(check);
      return true;
    } catch (err) {
      if (err?.code === ABORTED) return false;
      throw err;
    }
  }

  // updateJson may wait on the path lock, so the gate is checked again inside.
  function writeSection(signal, jobId, section, mutate) {
    return publish(signal, (check) => updateJson(usageFile(jobId), (doc) => {
      check();
      if (!doc[section] || typeof doc[section] !== 'object') doc[section] = {};
      mutate(doc[section]);
    }, { fallback: emptyUsage }));
  }

  async function readSection(jobId, section) {
    const doc = await readJson(usageFile(jobId), null);
    return doc?.[section] && typeof doc[section] === 'object' ? doc[section] : {};
  }

  const writeAttempts = (signal, jobId, mutate) => writeSection(signal, jobId, 'attempts', mutate);
  const readAttempts = (jobId) => readSection(jobId, 'attempts');

  async function verifyCached(entry, ids) {
    if (typeof entry?.file !== 'string') return false;
    let s;
    try {
      s = await statImpl(entry.file);
    } catch {
      return false;
    }
    const key = `${entry.file}\0${ids.jobId}\0${ids.attemptId}`;
    const hit = verified.get(key);
    if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.ok;
    const ok = await transcripts.verify(entry, ids);
    verified.set(key, { size: s.size, mtimeMs: s.mtimeMs, ok });
    return ok;
  }

  async function runUsage({ key, job, attempt }, signal) {
    const ids = idsOf(job, attempt);
    const stored = (await readAttempts(job.jobId))[attempt.attemptId];
    if (stored?.state === 'final') {
      finals.add(key);
      return;
    }
    const found = stored?.file && (await verifyCached(stored, ids)) ? foundFrom(stored) : await transcripts.find(job, attempt);
    if (signal.aborted) return;
    lookups.set(key, { found, at: now() });
    if (found.status !== 'found') {
      const count = (misses.get(key) ?? 0) + 1;
      misses.set(key, count);
      if (!FINISHED_STATES.has(job.state) || count < finalMissingAfter) return;
      const at = now();
      const wrote = await writeAttempts(signal, job.jobId, (attempts) => {
        attempts[attempt.attemptId] = stored ? { ...stored, state: 'final', scannedAt: at } : { state: 'final', unknown: found.status, scannedAt: at };
      });
      if (wrote) {
        finals.add(key);
        misses.delete(key);
      }
      return;
    }
    misses.delete(key);
    const usage = await transcripts.usage(found);
    if (signal.aborted) return;
    const unchanged = stored?.fingerprint === usage.fingerprint && stored?.file === found.file;
    const settled = unchanged && stored.state === 'provisional' && !isLive(attempt.sessionId);
    if (unchanged && !settled) return;
    const wrote = await writeAttempts(signal, job.jobId, (attempts) => {
      attempts[attempt.attemptId] = entryFrom(settled ? 'final' : 'provisional', found, usage, now());
    });
    if (wrote && settled) finals.add(key);
  }

  function ownKeys(writers, attempt) {
    return [...writers].filter(([, w]) => w.attemptId === attempt.attemptId).map(([k]) => k);
  }

  function writersOf(job) {
    try {
      return artifactWriters(job);
    } catch (err) {
      log(`could not list the artifact writers of job ${job.jobId}`, err);
      return new Map();
    }
  }

  async function runSnapshot({ key, job, attempt }, signal) {
    const progress = await readSection(job.jobId, 'snapshots');
    const order = new Map(job.attempts.map((a, i) => [a.attemptId, i]));
    const mine = order.get(attempt.attemptId);
    const snapshotDir = snapshotDirFor(store.jobDir(job.jobId));
    const results = {};
    let settled = true;
    for (const k of ownKeys(artifactWriters(job), attempt)) {
      const prev = progress[k];
      if (prev?.attemptId === attempt.attemptId && prev.state === 'done') continue;
      if (prev && prev.attemptId !== attempt.attemptId && !(order.get(prev.attemptId) < mine)) continue;
      let state = 'done';
      try {
        const wrote = await publish(signal, (check) => snapshotImpl(job, k, { snapshotDir, maxBytes: maxArtifactBytes, beforeWrite: check }));
        if (!wrote) return;
      } catch (err) {
        state = 'failed';
        settled = false;
        log(`could not snapshot artifact ${k} of attempt ${attempt.attemptId} of job ${job.jobId}, retrying on a later heartbeat`, err);
      }
      results[k] = { attemptId: attempt.attemptId, state, at: now() };
    }
    if (Object.keys(results).length > 0) {
      const wrote = await writeSection(signal, job.jobId, 'snapshots', (snapshots) => Object.assign(snapshots, results));
      if (!wrote) return;
    }
    if (settled) snapshotted.add(key);
  }

  const handlers = { usage: runUsage, snapshot: runSnapshot };

  async function runNext(item) {
    const controller = new AbortController();
    const settled = Promise.resolve()
      .then(() => handlers[item.kind](item, controller.signal))
      .then(() => OK, (err) => ({ err }));
    current = { controller, settled };
    let timer;
    const budget = new Promise((resolve) => {
      timer = setTimeoutImpl(() => resolve(TIMED_OUT), itemBudgetMs);
    });
    const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(STOPPED), { once: true }));
    const result = await Promise.race([settled, budget, aborted]);
    clearTimeoutImpl(timer);
    current = null;
    queued.delete(item.itemKey);
    const what = `${item.kind} for attempt ${item.attempt.attemptId} of job ${item.job.jobId}`;
    if (result === TIMED_OUT) {
      controller.abort();
      log(`${what} ran past its ${itemBudgetMs} ms budget and can no longer write`);
    } else if (result !== OK && result !== STOPPED) {
      log(`${what} failed, retrying on a later heartbeat`, result.err);
    }
  }

  // Never started empty: a loop that finished synchronously would clear
  // pumping before the assignment below and leave it set for good.
  function pump() {
    if (pumping || stopped || pending.length === 0) return;
    pumping = (async () => {
      try {
        while (!stopped && pending.length > 0) await runNext(pending.shift());
      } finally {
        pumping = null;
      }
    })();
  }

  function push(kind, key, job, attempt) {
    const itemKey = `${kind}:${key}`;
    if (queued.has(itemKey)) return;
    queued.add(itemKey);
    pending.push({ kind, itemKey, key, job, attempt });
  }

  function enqueue(jobs) {
    if (stopped) return;
    for (const job of jobs ?? []) {
      const writers = job ? writersOf(job) : new Map();
      for (const attempt of job?.attempts ?? []) {
        if (!attempt.outcome || gatedOut(attempt)) continue;
        const key = attemptKey(job.jobId, attempt.attemptId);
        if (!finals.has(key)) push('usage', key, job, attempt);
        if (!snapshotted.has(key) && !isLive(attempt.sessionId) && ownKeys(writers, attempt).length > 0) push('snapshot', key, job, attempt);
      }
    }
    pump();
  }

  // Resolves once the queue has nothing left to run.
  function idle() {
    return pumping ?? Promise.resolve();
  }

  function start() {
    stopped = false;
  }

  async function stop({ deadline } = {}) {
    stopped = true;
    pending.length = 0;
    queued.clear();
    const running = current;
    if (!running) return;
    running.controller.abort();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeoutImpl(resolve, Math.max(0, (deadline ?? now()) - now()));
    });
    await Promise.race([running.settled, timeout]);
    clearTimeoutImpl(timer);
  }

  async function lookup(job, attempt) {
    const key = attemptKey(job.jobId, attempt.attemptId);
    const cached = lookups.get(key);
    if (cached?.found.status === 'found') {
      if (await verifyCached(cached.found, idsOf(job, attempt))) return cached.found;
      const again = await transcripts.find(job, attempt);
      const found = again.status === 'missing' ? { status: 'missing', pruned: true } : again;
      lookups.set(key, { found, at: now() });
      return found;
    }
    if (cached && now() - cached.at < LOOKUP_TTL_MS) return cached.found;
    const found = await transcripts.find(job, attempt);
    lookups.set(key, { found, at: now() });
    return found;
  }

  async function attemptUsage(job, attempt, entry) {
    if (entry?.unknown) return { usage: { state: 'unknown', note: entry.unknown }, transcript: noTranscript() };
    if (entry) {
      const available = await verifyCached(entry, idsOf(job, attempt));
      return { usage: usageView(entry.state, entry), transcript: { available, claudeSessionId: entry.claudeSessionId ?? null, cwd: entry.cwd ?? null } };
    }
    const found = await lookup(job, attempt);
    if (found.status !== 'found') return { usage: { state: 'unknown', note: found.pruned ? 'pruned' : found.status }, transcript: noTranscript() };
    const scanned = entryFrom(null, found, await transcripts.usage(found), now());
    return { usage: usageView(attempt.outcome ? 'provisional' : 'live', scanned), transcript: { available: true, claudeSessionId: found.claudeSessionId, cwd: found.cwd ?? null } };
  }

  // Read-only: the usage.json entry, else a scan; never writes.
  async function usageForJob(job) {
    const out = new Map();
    const stored = await readAttempts(job.jobId);
    for (const attempt of job.attempts ?? []) {
      if (gatedOut(attempt)) continue;
      try {
        out.set(attempt.attemptId, await attemptUsage(job, attempt, stored[attempt.attemptId]));
      } catch (err) {
        log(`could not read the usage of attempt ${attempt.attemptId} of job ${job.jobId}`, err);
        out.set(attempt.attemptId, { usage: null, transcript: noTranscript() });
      }
    }
    return out;
  }

  async function transcriptFor(job, attempt) {
    const entry = (await readAttempts(job.jobId))[attempt.attemptId];
    if (entry?.file && (await verifyCached(entry, idsOf(job, attempt)))) return foundFrom(entry);
    return transcripts.find(job, attempt);
  }

  return { enqueue, idle, start, stop, usageForJob, transcriptFor };
}
