// Superagent job store: one append-only events.jsonl per job, a pure
// deriveJob() over it, and a state.json mirror for humans and tooling.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, section
// "Restart and recovery": "`events.jsonl` is the source of truth; `state.json`
// is a derived cache". state.json is written after every append and never
// read back - load() always rebuilds from events.jsonl.
//
// Torn tail: a hard kill mid-append can leave a final line without its '\n'.
// That line is ignored on read and truncated away before the next append.
// Any other unparseable line is corruption and is refused, never rewritten.
//
// A rejected append is not proof the event is absent: the write can land and
// datasync or close fail afterwards. The store re-reads the file before the
// next append, so seq stays correct, but a caller that retries a rejected
// append must tolerate the event appearing twice.
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../json-store.js';
import { isSafeSessionId } from '../safe-id.js';
import { defaultConfig, defaultSuperagentRoot } from './config.js';
import { ledgerArtifactRoot } from './results.js';
import { LEDGER_LEGACY_ARTIFACTS, LEGACY_ARTIFACTS, substituteArtifacts } from './workflows.js';

export const EVENT_TYPES = ['job-created', 'worktree-created', 'job-provisioned', 'job-failed', 'attempt-started', 'attempt-session', 'attempt-nudged', 'attempt-ended', 'needs-you', 'job-accepted', 'job-stopped', 'precompact', 'tasks-loaded', 'test-routed', 'phase-completed', 'router-decided', 'question-answered', 'folder-restored', 'job-retried', 'job-renamed'];

const NEWLINE = 0x0a;

function routerDefaults() {
  const d = defaultConfig();
  return { allowlist: d.routerModelAllowlist, maxInputTokens: d.routerMaxInputTokens, maxOutputTokens: d.routerMaxOutputTokens };
}

// Plan 7 Decision 3: a job-created without `workflow` (pre-Plan-7, or a
// fixture job) reads with today's artifact table and its `test` author phase
// flagged. The event log itself is never rewritten.
export function legacyPipeline(pipeline) {
  return pipeline.map((p) => (p.kind === 'author' && p.phase === 'test' ? { ...p, test: true } : p));
}

function resolveArtifacts(first, legacy) {
  if (first.artifactRoot !== 'ledger') return legacy ? substituteArtifacts(LEGACY_ARTIFACTS, { slug: first.slug, date: first.createdDate }) : structuredClone(first.artifacts ?? {});
  const base = legacy ? LEDGER_LEGACY_ARTIFACTS : first.artifacts ?? {};
  const root = ledgerArtifactRoot(first.jobId);
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, `${root}/${value}`]));
}

export function deriveJob(events) {
  const first = events[0];
  if (first?.type !== 'job-created') throw new Error('superagent: events must start with job-created');
  const legacy = first.workflow == null;
  const pipeline = structuredClone(first.pipeline ?? []);
  const job = {
    jobId: first.jobId,
    slug: first.slug,
    title: first.title,
    idea: first.idea,
    mode: first.mode,
    branch: first.branch,
    createdAt: first.at ?? null,
    createdDate: first.createdDate,
    repos: (first.repos ?? []).map((r) => ({
      id: r.id,
      origin: r.origin,
      inPlace: r.inPlace === true,
      toplevel: r.toplevel ?? null,
      admittedHead: r.admittedHead ?? null,
      pendingChanges: r.pendingChanges ? structuredClone(r.pendingChanges) : null,
      worktree: null,
      baseSha: null,
      settingsCopy: null,
    })),
    workflow: legacy ? null : structuredClone(first.workflow),
    artifactRoot: first.artifactRoot === 'ledger' ? 'ledger' : null,
    artifacts: resolveArtifacts(first, legacy),
    prompts: structuredClone(first.prompts ?? {}),
    pipeline: legacy ? legacyPipeline(pipeline) : pipeline,
    models: structuredClone(first.models ?? {}),
    limits: structuredClone(first.limits ?? {}),
    router: structuredClone(first.router ?? routerDefaults()),
    workerPermissionMode: first.workerPermissionMode,
    copyLocalClaudeSettings: first.copyLocalClaudeSettings,
    state: 'provisioning',
    reason: null,
    detail: null,
    needsYouSeq: null,
    phaseIndex: 0,
    phaseId: null,
    attempts: [],
    tasks: null,
    visits: {},
    completions: [],
    routerDecisions: [],
    answers: [],
    retries: [],
    lastSeq: first.seq ?? null,
  };
  const attempt = (id) => job.attempts.find((a) => a.attemptId === id);
  const setState = (state, reason = null, detail = null) => {
    job.state = state;
    job.reason = reason;
    job.detail = detail;
    job.needsYouSeq = null;
  };
  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    switch (ev.type) {
      case 'job-created':
        throw new Error(`superagent: a second job-created at seq ${ev.seq}`);
      case 'worktree-created': {
        const repo = job.repos.find((r) => r.id === ev.repo);
        if (repo) Object.assign(repo, { worktree: ev.worktree ?? null, baseSha: ev.baseSha ?? null, settingsCopy: ev.settingsCopy ?? null });
        break;
      }
      case 'job-provisioned': setState('running'); break;
      case 'job-failed': setState('failed', 'job-failed', { error: ev.error }); break;
      case 'needs-you':
        setState('needs-you', ev.reason ?? null, ev.detail ?? null);
        job.needsYouSeq = ev.seq ?? null;
        break;
      case 'question-answered':
        if (job.state !== 'needs-you' || job.reason !== 'question' || job.detail?.attemptId !== ev.forAttemptId) break;
        if (job.answers.some((x) => x.forAttemptId === ev.forAttemptId)) break;
        // A verifier-confirmed blocker's question lives only in the detail.
        job.answers.push({ forAttemptId: ev.forAttemptId, answer: ev.answer, question: job.detail?.question ?? job.detail?.text ?? null, at: ev.at ?? null });
        setState('running');
        break;
      // A rename changes the title only: slug, branch and paths keep the
      // created title's.
      case 'job-renamed':
        if (typeof ev.title === 'string' && ev.title) job.title = ev.title;
        break;
      case 'folder-restored':
        if (job.state === 'needs-you' && job.reason === 'folder-changed') setState('running');
        break;
      // Retry on a stuck job: the scope's failed attempts are retried away
      // (out of its caps, repeated-error, back-off and routing) and the next
      // attempt in the scope resumes from fromAttemptId.
      case 'job-retried': {
        if (job.state !== 'needs-you' || job.reason !== 'stuck') break;
        const task = ev.task ?? null;
        for (const a of job.attempts) {
          if (a.phase === ev.phase && a.task === task && a.outcome === 'failed') a.retried = true;
        }
        job.retries.push({
          needsYouSeq: ev.needsYouSeq ?? null,
          phase: ev.phase,
          task,
          fromAttemptId: ev.fromAttemptId ?? null,
          handoff: ev.handoff ?? null,
          note: ev.note ?? null,
          at: ev.at ?? null,
          consumedBy: null,
        });
        setState('running');
        break;
      }
      case 'job-accepted': setState('done'); break;
      case 'job-stopped': setState('stopped'); break;
      case 'attempt-started': {
        const pending = job.retries.findLast((r) => r.phase === ev.phase && r.task === (ev.task ?? null) && r.consumedBy === null);
        if (pending) pending.consumedBy = ev.attemptId;
        job.attempts.push({
          attemptId: ev.attemptId,
          phase: ev.phase,
          task: ev.task ?? null,
          role: ev.role,
          model: ev.model,
          n: ev.n,
          recovery: ev.recovery ?? false,
          previousAttemptId: ev.previousAttemptId ?? null,
          dir: ev.dir ?? null,
          handoff: ev.handoff ?? null,
          sessionId: null,
          startedAt: ev.at ?? null,
          endedAt: null,
          outcome: null,
          reason: null,
          signature: null,
          detail: null,
          summary: null,
          question: null,
          nudges: [],
          precompacts: [],
          purpose: ev.purpose ?? 'author',
          round: ev.round ?? null,
          final: ev.final ?? false,
          verdict: null,
          findings: null,
          commits: [],
          verified: null,
          questions: null,
          answers: null,
          escalated: null,
          tokens: null,
          retryNote: ev.retryNote ?? null,
          retried: false,
        });
        break;
      }
      case 'attempt-session': {
        const a = attempt(ev.attemptId);
        if (a) a.sessionId = ev.sessionId;
        break;
      }
      case 'attempt-nudged':
        attempt(ev.attemptId)?.nudges.push({ kind: ev.kind, at: ev.at ?? null });
        break;
      case 'precompact':
        attempt(ev.attemptId)?.precompacts.push({ trigger: ev.trigger ?? null, at: ev.at ?? null });
        break;
      case 'attempt-ended': {
        const a = attempt(ev.attemptId);
        if (!a) break;
        Object.assign(a, {
          endedAt: ev.at ?? null,
          outcome: ev.outcome,
          reason: ev.reason ?? null,
          signature: ev.signature ?? null,
          detail: ev.detail ?? null,
          summary: ev.summary ?? null,
          question: ev.question ?? null,
          verdict: ev.verdict ?? null,
          findings: ev.findings ?? null,
          commits: ev.commits ?? [],
          verified: ev.verified ?? null,
          questions: ev.questions ?? null,
          answers: ev.answers ?? null,
          escalated: ev.escalated ?? null,
          tokens: ev.tokens ?? null,
        });
        const current = job.pipeline[job.phaseIndex];
        if (ev.outcome === 'done' && current?.kind === 'author' && a.phase === current.phase) job.phaseIndex++;
        if (ev.outcome === 'done' && current?.kind === 'brainstorm' && a.phase === current.phase && a.purpose === 'ask' && (ev.questions ?? []).length === 0) job.phaseIndex++;
        break;
      }
      case 'tasks-loaded':
        if (job.tasks === null) job.tasks = structuredClone(ev.tasks ?? []);
        break;
      case 'test-routed': {
        const perTaskIndex = job.pipeline.findIndex((p) => p.kind === 'per-task');
        if (job.pipeline[job.phaseIndex]?.test !== true || perTaskIndex < 0) break;
        if ((job.tasks ?? []).some((t) => t.fromAttemptId === ev.attemptId)) break;
        const perTaskId = job.pipeline[perTaskIndex].phase;
        job.tasks = [...(job.tasks ?? []), structuredClone(ev.task)];
        job.phaseIndex = perTaskIndex;
        job.visits[perTaskId] = (job.visits[perTaskId] ?? 1) + 1;
        break;
      }
      case 'phase-completed': {
        if (job.pipeline[job.phaseIndex]?.phase !== ev.phase || ev.visit !== (job.visits[ev.phase] ?? 1)) break;
        job.completions.push({ phase: ev.phase, visit: ev.visit, unresolved: ev.unresolved ?? [], verification: ev.verification ?? null });
        job.phaseIndex++;
        break;
      }
      case 'router-decided':
        // A rejected append that landed may be replayed: the first decision wins.
        if (job.routerDecisions.some((d) => d.forAttemptId === ev.forAttemptId)) break;
        job.routerDecisions.push({
          forAttemptId: ev.forAttemptId,
          action: ev.action,
          note: ev.note ?? null,
          ok: ev.ok === true,
          error: ev.error ?? null,
          model: ev.model ?? null,
          request: structuredClone(ev.request ?? null),
          usage: structuredClone(ev.usage ?? null),
          latencyMs: ev.latencyMs ?? null,
          at: ev.at ?? null,
        });
        break;
      default:
        break;
    }
    job.lastSeq = ev.seq ?? job.lastSeq;
  }
  for (let p = 0; p <= job.phaseIndex && p < job.pipeline.length; p++) job.visits[job.pipeline[p].phase] ??= 1;
  job.phaseId = job.pipeline[job.phaseIndex]?.phase ?? null;
  return job;
}

function corruptError(file, line) {
  const err = new Error(`superagent: ${file} line ${line} is not valid JSON - refusing to read or append. Fix the file by hand.`);
  err.code = 'ERR_EVENTS_CORRUPT';
  err.line = line;
  return err;
}

// keepBytes is the length up to and including the last '\n'; tornBytes is
// whatever follows it (a torn final line). Throws ENOENT for a missing file.
async function readEvents(file) {
  const buf = await readFile(file);
  const keepBytes = buf.length === 0 || buf[buf.length - 1] === NEWLINE ? buf.length : buf.lastIndexOf(NEWLINE) + 1;
  const lines = buf.subarray(0, keepBytes).toString('utf8').split('\n');
  lines.pop();
  const events = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw corruptError(file, i + 1);
    }
  });
  return { events, keepBytes, tornBytes: buf.length - keepBytes };
}

export function createSuperagentStore({ rootDir = path.join(defaultSuperagentRoot(), 'jobs'), now = Date.now, logImpl = console.error, openImpl = open } = {}) {
  // jobId -> { events, job, keepBytes, tornBytes, stale } once read in this
  // process. `stale` means a failed append may have left bytes on disk: get()
  // keeps serving the last good job, the next append or load re-reads first.
  const cache = new Map();
  const chains = new Map();

  function jobDir(jobId) {
    if (!isSafeSessionId(jobId)) throw new Error(`superagent: unsafe job id ${JSON.stringify(jobId)}`);
    return path.join(rootDir, jobId);
  }
  const eventsFile = (jobId) => path.join(jobDir(jobId), 'events.jsonl');

  function enqueue(jobId, work) {
    const prev = chains.get(jobId) || Promise.resolve();
    const run = prev.catch(() => {}).then(work);
    chains.set(jobId, run);
    run.finally(() => {
      if (chains.get(jobId) === run) chains.delete(jobId);
    }).catch(() => {});
    return run;
  }

  async function prime(jobId, { missingOk }) {
    const cached = cache.get(jobId);
    if (cached && !cached.stale) return cached;
    const file = eventsFile(jobId);
    let read;
    try {
      read = await readEvents(file);
    } catch (err) {
      if (err.code !== 'ENOENT' || !missingOk) throw err;
      read = { events: [], keepBytes: 0, tornBytes: 0 };
    }
    const fresh = { ...read, job: read.events.length ? deriveJob(read.events) : null, stale: false };
    if (!cached) {
      cache.set(jobId, fresh);
      return fresh;
    }
    return Object.assign(cached, fresh);
  }

  async function repairTornTail(jobId, entry) {
    if (!entry.tornBytes) return;
    const file = eventsFile(jobId);
    const fh = await openImpl(file, 'r+');
    try {
      await fh.truncate(entry.keepBytes);
      await fh.datasync();
    } finally {
      await fh.close();
    }
    entry.tornBytes = 0;
    logImpl(`superagent: dropped a torn final line in ${file}`);
  }

  function append(jobId, event) {
    let dir;
    try {
      dir = jobDir(jobId);
      if (!event || !EVENT_TYPES.includes(event.type)) throw new Error(`superagent: unknown event type ${JSON.stringify(event?.type)}`);
      if ('seq' in event || 'at' in event) throw new Error('superagent: events must not carry their own seq or at');
      if (event.type === 'job-created' && event.jobId !== jobId) throw new Error(`superagent: job-created for ${event.jobId} appended to ${jobId}`);
    } catch (err) {
      return Promise.reject(err);
    }
    const written = enqueue(jobId, async () => {
      const entry = await prime(jobId, { missingOk: true });
      const stamped = { seq: (entry.job?.lastSeq ?? 0) + 1, at: now(), ...event };
      const events = [...entry.events, stamped];
      const job = deriveJob(events);
      await repairTornTail(jobId, entry);
      await mkdir(dir, { recursive: true });
      const line = Buffer.from(JSON.stringify(stamped) + '\n', 'utf8');
      try {
        const fh = await openImpl(eventsFile(jobId), 'a');
        try {
          const { bytesWritten } = await fh.write(line);
          if (bytesWritten !== line.length) throw new Error(`superagent: short write to ${eventsFile(jobId)} (${bytesWritten} of ${line.length} bytes)`);
          await fh.datasync();
        } finally {
          await fh.close();
        }
      } catch (err) {
        entry.stale = true;
        throw err;
      }
      Object.assign(entry, { events, job, keepBytes: entry.keepBytes + line.length });
      return stamped;
    });
    enqueue(jobId, async () => {
      try {
        await written;
      } catch {
        return;
      }
      const entry = cache.get(jobId);
      if (!entry?.job) return;
      try {
        await writeJsonAtomic(path.join(dir, 'state.json'), entry.job);
      } catch (err) {
        logImpl(`superagent: could not write state.json for ${jobId}: ${err.message}`);
      }
    });
    return written;
  }

  function load(jobId) {
    try {
      jobDir(jobId);
    } catch (err) {
      return Promise.reject(err);
    }
    return enqueue(jobId, async () => {
      const entry = await prime(jobId, { missingOk: false });
      if (!entry.job) throw new Error(`superagent: ${eventsFile(jobId)} has no events`);
      return structuredClone(entry.job);
    });
  }

  function get(jobId) {
    const job = cache.get(jobId)?.job;
    return job ? structuredClone(job) : null;
  }

  async function listJobIds() {
    let entries;
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((e) => e.isDirectory() && isSafeSessionId(e.name)).map((e) => e.name).sort();
  }

  async function flush() {
    while (chains.size) {
      await Promise.allSettled([...chains.values()]);
    }
  }

  return { append, load, get, listJobIds, jobDir, flush };
}
