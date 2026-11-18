import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { tempDir, initRepo, sessionFactory, jobCreated, deferred, taskCreated, ev, T0 } from './superagent-helpers.mjs';
import { createSuperagentStore } from '../src/superagent/store.js';
import { createSuperagentConfig, defaultConfig, MILESTONE_1_PIPELINE, MILESTONE_2_PIPELINE } from '../src/superagent/config.js';
import { RESULT_FILE, artifactPaths, attemptDir } from '../src/superagent/results.js';
import { createWorktree, defaultGit, slugify } from '../src/superagent/worktree.js';
import { createSuperagent, TICK_MS } from '../src/superagent/index.js';
import { workflowsDir } from '../src/superagent/workflows.js';

const quiet = () => {};
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const branchExists = (repo, branch) => {
  try {
    gitIn(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

async function harness({ configJson = {}, ...over } = {}) {
  registry._reset();
  const root = await tempDir('sa-index-');
  const repo = path.join(root, 'repo');
  const baseSha = await initRepo(repo);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(typeof configJson === 'function' ? configJson(repo) : configJson));
  const jobsRoot = path.join(root, 'jobs');
  const worktreesRoot = path.join(root, 'worktrees');
  const globalWorkflows = path.join(root, 'workflows');
  const clock = { t: T0 };

  async function build({ storeOpts = {}, ...opts } = {}) {
    const store = createSuperagentStore({ rootDir: jobsRoot, now: () => clock.t, logImpl: quiet, ...storeOpts });
    const config = createSuperagentConfig({ filePath: configFile });
    await config.load();
    const factory = sessionFactory(registry);
    const sa = createSuperagent({
      registry: factory.registry,
      store,
      config,
      worktreesRoot,
      now: () => clock.t,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      stopTickDeadlineMs: 20,
      logImpl: quiet,
      platform: 'linux',
      workflowDirs: { builtin: workflowsDir(), global: globalWorkflows },
      ...opts,
    });
    const events = (jobId) => readFileSync(path.join(jobsRoot, jobId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const inputs = () => [...factory.impls.values()].flatMap((impl) => impl.allInputs ?? []);
    return {
      root, repo, baseSha, jobsRoot, worktreesRoot, globalWorkflows, configFile, clock, store, config, factory, sa, events, inputs,
      dirFor: (job, attemptId) => attemptDir(job.repos[0].worktree, { jobId: job.jobId, phase: 'spec', task: null, attemptId }),
      started: (jobId) => events(jobId).filter((e) => e.type === 'attempt-started'),
      async restart(opts2 = {}) {
        registry._reset();
        return build(opts2);
      },
    };
  }
  return build(over);
}

// Plays the spec-writer: commits the spec in the worktree and publishes a
// valid result.json via result.json.tmp + rename.
async function publishSpec(job, attempt) {
  const wt = job.repos[0].worktree;
  const rel = artifactPaths(job).spec;
  await fs.mkdir(path.dirname(path.join(wt, ...rel.split('/'))), { recursive: true });
  await fs.writeFile(path.join(wt, ...rel.split('/')), '# Hello design\n');
  gitIn(wt, 'add', '--', rel);
  gitIn(wt, 'commit', '-q', '-m', 'spec');
  const sha = gitIn(wt, 'rev-parse', 'HEAD');
  await fs.mkdir(attempt.dir, { recursive: true });
  const body = {
    jobId: job.jobId,
    phaseId: 'spec',
    taskId: null,
    attemptId: attempt.attemptId,
    status: 'done',
    artifacts: [rel],
    summary: 'Wrote the hello design.',
    question: null,
    evidence: { commits: [sha] },
  };
  await fs.writeFile(path.join(attempt.dir, `${RESULT_FILE}.tmp`), JSON.stringify(body));
  await fs.rename(path.join(attempt.dir, `${RESULT_FILE}.tmp`), path.join(attempt.dir, RESULT_FILE));
  return sha;
}

function rejectionSpy() {
  const seen = [];
  const on = (reason) => seen.push(reason);
  process.on('unhandledRejection', on);
  return {
    seen,
    async stop() {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      process.off('unhandledRejection', on);
    },
  };
}

const create = (h, over = {}) => h.sa.createJob({ title: 'Add hello', idea: 'Add hello.txt', primaryRepo: h.repo, fixture: 'milestone-1', ...over });

test('the heartbeat is 15 seconds', () => {
  assert.equal(TICK_MS, 15_000);
});

test('reconcile: started without a result becomes interrupted and relaunches uncounted', async () => {
  try {
    const h = await harness();
    const job = await h.sa.createJob({ title: 'Add hello', idea: 'Add hello.txt', primaryRepo: h.repo, fixture: 'milestone-1' });
    // Crash right after attempt-started: no session was ever created.
    await h.store.append(job.jobId, { type: 'attempt-started', attemptId: 'a1', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', n: 1, recovery: false, previousAttemptId: null, dir: h.dirFor(job, 'a1') });
    const fresh = await h.restart();
    await fresh.sa.start();
    assert.equal(fresh.events(job.jobId).at(-1).type, 'attempt-ended');
    assert.equal(fresh.events(job.jobId).at(-1).outcome, 'interrupted');
    await fresh.sa.tick();
    const started = fresh.events(job.jobId).filter((e) => e.type === 'attempt-started');
    assert.equal(started.length, 2);
    assert.deepEqual([started[1].n, started[1].recovery, started[1].previousAttemptId], [1, true, 'a1']);
    assert.match(fresh.inputs().at(-1), /check every worktree's git status and log/);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('two-phase pipeline end to end: spec-writer to ready-to-try to done', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    const wtEvents = h.events(job.jobId).filter((e) => e.type === 'worktree-created');
    assert.equal(wtEvents.length, 1);
    assert.equal(wtEvents[0].settingsCopy, 'absent');
    assert.equal(wtEvents[0].baseSha, h.baseSha);
    assert.equal(wtEvents[0].branch, job.branch);
    assert.equal(job.state, 'running');
    assert.deepEqual(job.pipeline, JSON.parse(JSON.stringify(MILESTONE_1_PIPELINE)));

    await h.sa.tick();
    assert.equal(registry.list().length, 1);
    const attempt = h.store.get(job.jobId).attempts.at(-1);
    await publishSpec(job, attempt);
    const impl = h.factory.impls.get(attempt.sessionId);
    impl.emitMessage({ type: 'result', subtype: 'success' });
    impl.emitState('idle');

    await h.sa.tick();
    const tail = h.events(job.jobId).slice(-2);
    assert.equal(tail[0].type, 'attempt-ended');
    assert.equal(tail[0].outcome, 'done');
    assert.equal(tail[1].type, 'needs-you');
    assert.equal(tail[1].reason, 'ready-to-try');
    assert.equal(h.sa.getJob(job.jobId).state, 'needs-you');
    assert.equal(registry.list().length, 0);

    const accepted = await h.sa.accept(job.jobId);
    assert.equal(accepted.state, 'done');
    assert.ok(existsSync(path.join(h.jobsRoot, job.jobId, 'ledger', 'attempts', 'spec', attempt.attemptId, RESULT_FILE)));
    assert.ok(existsSync(job.repos[0].worktree));
    assert.ok(branchExists(h.repo, job.branch));
    assert.deepEqual(await h.sa.orphanWorktrees(), []);
    await assert.rejects(h.sa.accept(job.jobId), { code: 'ERR_INVALID_STATE' });
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('stopJob closes the live attempt and archives the ledger', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    await h.sa.tick();
    assert.equal(registry.list().length, 1);
    const stopped = await h.sa.stopJob(job.jobId);
    assert.equal(stopped.state, 'stopped');
    const evs = h.events(job.jobId);
    const ended = evs.filter((e) => e.type === 'attempt-ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].outcome, 'stopped');
    assert.equal(evs.at(-1).type, 'job-stopped');
    assert.equal(registry.list().length, 0);
    assert.ok(existsSync(path.join(h.jobsRoot, job.jobId, 'ledger')));
    await h.sa.tick();
    assert.equal(h.started(job.jobId).length, 1);
    assert.equal(registry.list().length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('createJob refuses pipelines this plan cannot run', async () => {
  try {
    const h = await harness({ configJson: (repo) => ({ projects: { [repo]: { models: { 'spec-writer': { provider: 'grok' } } } } }) });
    // The config's models feed the default workflow's validation.
    await assert.rejects(create(h, { fixture: undefined }), { code: 'ERR_INVALID_WORKFLOW' });
    await assert.rejects(create(h, { fixture: 'milestone-9' }), { code: 'ERR_UNKNOWN_FIXTURE' });
    await assert.rejects(create(h), { code: 'ERR_INVALID_CONFIG' });

    const plain = await harness();
    await assert.rejects(create(plain, { fixture: 'milestone-9' }), { code: 'ERR_UNKNOWN_FIXTURE' });
    for (const jobsRoot of [h.jobsRoot, plain.jobsRoot]) {
      const entries = await fs.readdir(jobsRoot).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
      assert.deepEqual(entries, []);
    }
    assert.deepEqual(plain.sa.listJobs(), []);
  } finally { registry._reset(); }
});

test('a provisioning failure records job-failed and keeps the worktrees already made', async () => {
  try {
    const root = await tempDir('sa-index-extra-');
    const extra = path.join(root, 'lib');
    await initRepo(extra);
    const git = async (args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add' && path.resolve(opts.cwd) === path.resolve(extra)) return { code: 128, stdout: '', stderr: 'fatal: injected' };
      return defaultGit(args, opts);
    };
    const h = await harness({ git });
    const job = await create(h, { additionalRepos: [extra] });
    assert.equal(job.state, 'failed');
    assert.match(job.detail.error, /git worktree add failed: fatal: injected/);
    assert.ok(existsSync(path.join(h.worktreesRoot, job.slug, 'primary')));
    assert.ok(branchExists(h.repo, job.branch));
    await h.sa.tick();
    assert.equal(h.started(job.jobId).length, 0);
  } finally { registry._reset(); }
});

test('provisioning gate: a tick during worktree creation launches nothing', async () => {
  try {
    const gate = deferred();
    const reached = deferred();
    const git = async (args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        reached.resolve();
        await gate.promise;
      }
      return defaultGit(args, opts);
    };
    const h = await harness({ git });
    const creating = create(h);
    await reached.promise;
    const [jobId] = await h.store.listJobIds();
    assert.equal(h.events(jobId)[0].type, 'job-created');
    await h.sa.tick();
    assert.equal(h.started(jobId).length, 0);
    assert.equal(h.sa.getJob(jobId).state, 'provisioning');
    gate.resolve();
    const job = await creating;
    assert.equal(job.state, 'running');
    assert.ok(h.events(jobId).some((e) => e.type === 'job-provisioned'));
    await h.sa.tick();
    assert.equal(h.started(jobId).length, 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('restart during provisioning fails the job and keeps its worktrees', async () => {
  try {
    const h = await harness();
    const second = path.join(h.root, 'lib');
    await initRepo(second);
    await h.store.append('ja', jobCreated({ jobId: 'ja', slug: 'a-ja', branch: 'superagent/a-ja', repos: [{ id: 'primary', origin: h.repo }] }));
    const repos = [{ id: 'primary', origin: h.repo }, { id: 'lib', origin: second }];
    await h.store.append('jb', jobCreated({ jobId: 'jb', slug: 'b-jb', branch: 'superagent/b-jb', repos }));
    const worktree = path.join(h.worktreesRoot, 'b-jb', 'primary');
    const made = await createWorktree({ origin: h.repo, worktree, branch: 'superagent/b-jb', copyLocalClaudeSettings: true });
    await h.store.append('jb', { type: 'worktree-created', repo: 'primary', ...made });

    const fresh = await h.restart();
    await fresh.sa.start();
    for (const jobId of ['ja', 'jb']) {
      assert.equal(fresh.events(jobId).at(-1).type, 'job-failed');
      assert.equal(fresh.sa.getJob(jobId).state, 'failed');
    }
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(h.repo, 'superagent/b-jb'));
    await fresh.sa.tick();
    assert.equal(fresh.started('ja').length + fresh.started('jb').length, 0);
    assert.equal(registry.list().length, 0);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('stop while a budget check is pending launches nothing', async () => {
  const spy = rejectionSpy();
  try {
    const budget = deferred();
    const asked = deferred();
    const h = await harness({ budgetCheck: () => { asked.resolve(); return budget.promise; } });
    const job = await create(h);
    const t = h.sa.tick();
    await asked.promise;
    // The check is still pending: stop() can only return through its deadline.
    await h.sa.stop();
    budget.resolve({ allow: true });
    await t;
    await h.sa.drain();
    assert.equal(h.started(job.jobId).length, 0);
    assert.equal(registry.list().length, 0);
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('stopJob while a budget check is pending: no attempt-started, job stopped', async () => {
  const spy = rejectionSpy();
  try {
    const budget = deferred();
    const asked = deferred();
    const h = await harness({ budgetCheck: () => { asked.resolve(); return budget.promise; } });
    const job = await create(h);
    const t = h.sa.tick();
    await asked.promise;
    const s = h.sa.stopJob(job.jobId);
    budget.resolve({ allow: true });
    const [, stopped] = await Promise.all([t, s]);
    assert.equal(h.started(job.jobId).length, 0);
    assert.equal(h.events(job.jobId).at(-1).type, 'job-stopped');
    assert.equal(stopped.state, 'stopped');
    assert.equal(h.sa.getJob(job.jobId).state, 'stopped');
    assert.equal(registry.list().length, 0);
    await h.sa.stop();
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('overlapping ticks launch one attempt', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    const first = h.sa.tick();
    const second = h.sa.tick();
    assert.equal(first, second, 'a tick while one is in flight joins it');
    await Promise.all([first, second]);
    assert.equal(h.started(job.jobId).length, 1);
    assert.equal(registry.list().length, 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('reconcile: started with a valid result is processed, not re-run', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    const dir = h.dirFor(job, 'a1');
    await h.store.append(job.jobId, { type: 'attempt-started', attemptId: 'a1', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', n: 1, recovery: false, previousAttemptId: null, dir });
    await h.store.append(job.jobId, { type: 'attempt-session', attemptId: 'a1', sessionId: 's-gone' });
    await publishSpec(job, { attemptId: 'a1', dir });
    const other = await create(h, { title: 'Other job' });
    await h.store.append(other.jobId, { type: 'needs-you', reason: 'question', detail: { attemptId: null, question: 'Which colour?' } });
    const otherCount = h.events(other.jobId).length;

    const fresh = await h.restart();
    await fresh.sa.start();
    assert.equal(fresh.events(other.jobId).length, otherCount, 'a needs-you job is left as it is');
    await fresh.sa.tick();
    const evs = fresh.events(job.jobId);
    const ended = evs.filter((e) => e.type === 'attempt-ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].attemptId, 'a1');
    assert.equal(ended[0].outcome, 'done');
    assert.equal(evs.at(-1).type, 'needs-you');
    assert.equal(evs.at(-1).reason, 'ready-to-try');
    assert.equal(fresh.started(job.jobId).length, 1);
    assert.equal(fresh.events(other.jobId).length, otherCount);
    assert.equal(registry.list().length, 0);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('budget denial before launch asks the user and starts nothing', async () => {
  try {
    const h = await harness({ budgetCheck: () => ({ allow: false, reason: 'job budget of $5 reached' }) });
    const job = await create(h);
    await h.sa.tick();
    const last = h.events(job.jobId).at(-1);
    assert.equal(last.type, 'needs-you');
    assert.equal(last.reason, 'question');
    assert.deepEqual(last.detail, { kind: 'budget', text: 'job budget of $5 reached' });
    assert.equal(h.started(job.jobId).length, 0);
    assert.equal(registry.list().length, 0);
    assert.equal(h.sa.getJob(job.jobId).state, 'needs-you');
  } finally { registry._reset(); }
});

test('a rejected attempt-started that landed is reconciled, never launched beside', async () => {
  const spy = rejectionSpy();
  try {
    let armed = 0;
    let failNextAppend = false;
    // The line reaches the file, then datasync fails: the store rejects and
    // keeps serving the last good state until something re-reads.
    const openImpl = async (file, flags) => {
      const fh = await fs.open(file, flags);
      if (flags !== 'a' || !failNextAppend) return fh;
      failNextAppend = false;
      return {
        write: (buf) => fh.write(buf),
        datasync: async () => {
          await fh.datasync();
          throw new Error('injected datasync failure');
        },
        close: () => fh.close(),
      };
    };
    const h = await harness({
      storeOpts: { openImpl },
      budgetCheck: () => {
        if (armed++ === 0) failNextAppend = true;
        return { allow: true };
      },
    });
    const job = await create(h);
    await h.sa.tick();
    const [first] = h.started(job.jobId);
    assert.equal(h.started(job.jobId).length, 1, 'the rejected attempt-started is on disk');
    assert.equal(registry.list().length, 0, 'no session for it');
    assert.equal(h.sa.getJob(job.jobId).attempts.length, 1, 'the job was reloaded after the rejection');

    await h.sa.tick();
    const evs = h.events(job.jobId);
    const ended = evs.filter((e) => e.type === 'attempt-ended');
    assert.deepEqual(ended.map((e) => [e.attemptId, e.outcome]), [[first.attemptId, 'interrupted']]);
    const started = h.started(job.jobId);
    assert.equal(started.length, 2);
    assert.deepEqual([started[1].n, started[1].recovery, started[1].previousAttemptId], [1, true, first.attemptId]);
    assert.equal(registry.list().length, 1);
    await h.sa.tick();
    assert.equal(h.started(job.jobId).length, 2, 'the live attempt is not launched beside');
    await h.sa.stop();
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('start, stop and dispose are idempotent and own exactly one interceptor until disposed', async () => {
  try {
    const counts = { interceptors: 0, interceptorAdds: 0, removalAdds: 0, timers: 0, cleared: 0 };
    const factory = sessionFactory(registry);
    const reg = {
      ...factory.registry,
      addApprovalInterceptor(fn) {
        counts.interceptorAdds++;
        counts.interceptors++;
        const off = registry.addApprovalInterceptor(fn);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          counts.interceptors--;
          off();
        };
      },
      addSessionRemovedListener(fn) {
        counts.removalAdds++;
        return registry.addSessionRemovedListener(fn);
      },
    };
    const h = await harness({
      registry: reg,
      setIntervalImpl: () => { counts.timers++; return 'timer'; },
      clearIntervalImpl: () => { counts.cleared++; },
    });
    assert.equal(counts.removalAdds, 1, 'the removal listener is registered once, in the constructor');
    await Promise.all([h.sa.start(), h.sa.start()]);
    await h.sa.start();
    assert.deepEqual([counts.interceptors, counts.interceptorAdds, counts.timers], [1, 1, 1]);
    await h.sa.stop();
    await h.sa.stop();
    assert.deepEqual([counts.interceptors, counts.cleared], [1, 1], 'stop keeps the interceptor');
    h.sa.dispose();
    h.sa.dispose();
    assert.equal(counts.interceptors, 0);
    await h.sa.start();
    assert.deepEqual([counts.interceptors, counts.interceptorAdds, counts.timers], [1, 2, 2]);
    await h.sa.stop();
    h.sa.dispose();
    assert.equal(counts.interceptors, 0);
    assert.equal(counts.removalAdds, 1);
  } finally { registry._reset(); }
});

test('an ask during stop is denied until dispose', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    await h.sa.start();
    await h.sa.tick();
    const { sessionId } = h.store.get(job.jobId).attempts.at(-1);
    const worker = h.factory.impls.get(sessionId);
    await h.sa.stop();
    assert.ok(registry.get(sessionId), 'stop leaves the row for shutdown to close');
    const asked = worker.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion');
    assert.equal(registry.get(sessionId).pendingApprovals.length, 0, 'nothing reaches the human during stop');
    assert.equal((await asked).behavior, 'deny');
    h.sa.dispose();
    worker.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion');
    assert.equal(registry.get(sessionId).pendingApprovals.length, 1, 'after dispose the registry default applies');
  } finally { registry._reset(); }
});

test('ownsSession is true from launch until removal', async () => {
  try {
    const factory = sessionFactory(registry);
    const h = await harness({ registry: { ...factory.registry, closeSession: () => false } });
    const job = await create(h);
    await h.sa.start();
    assert.equal(h.sa.ownsSession('not-a-session'), false);
    await h.sa.tick();
    const attempt = h.store.get(job.jobId).attempts.at(-1);
    assert.ok(h.events(job.jobId).some((e) => e.type === 'attempt-session' && e.sessionId === attempt.sessionId));
    assert.equal(h.sa.ownsSession(attempt.sessionId), true);
    await h.sa.stopJob(job.jobId);
    assert.ok(registry.get(attempt.sessionId), 'the row lingers');
    assert.equal(h.sa.ownsSession(attempt.sessionId), true);
    registry.closeSession(attempt.sessionId);
    assert.equal(h.sa.ownsSession(attempt.sessionId), false);
    await h.sa.stop();
    h.sa.dispose();
  } finally { registry._reset(); }
});

test('a corrupt job is listed as failed and never appended to', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    const file = path.join(h.jobsRoot, job.jobId, 'events.jsonl');
    await fs.appendFile(file, 'not json\n{"seq":99}\n');
    const before = await fs.readFile(file, 'utf8');
    const fresh = await h.restart();
    await fresh.sa.start();
    assert.deepEqual(fresh.sa.getJob(job.jobId), { jobId: job.jobId, state: 'failed', reason: 'corrupt-events' });
    assert.deepEqual(fresh.sa.listJobs(), [{ jobId: job.jobId, state: 'failed', reason: 'corrupt-events' }]);
    await fresh.sa.tick();
    await fresh.sa.stop();
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally { registry._reset(); }
});

const createM2 = (h, over = {}) => create(h, { fixture: 'milestone-2', ...over });

let synthetic = 0;
const syntheticId = () => `${(++synthetic).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

// Records a finished attempt straight into the store, as if a worker had run.
async function recordAttempt(h, job, { phase, purpose = 'author', round = null, final = false, task = null, outcome = 'done', ...end }) {
  const attemptId = syntheticId();
  await h.store.append(job.jobId, { type: 'attempt-started', attemptId, phase, task, role: 'stand-in', model: 'claude-opus-5-5', n: 1, recovery: false, previousAttemptId: null, dir: null, purpose, round, final });
  await h.store.append(job.jobId, { type: 'attempt-ended', attemptId, outcome, ...end });
  return attemptId;
}

const M2_STEPS = {
  spec: (h, job) => recordAttempt(h, job, { phase: 'spec' }),
  'spec-review': (h, job) => h.store.append(job.jobId, ev.phaseCompleted('spec-review', 1)),
  plan: (h, job) => recordAttempt(h, job, { phase: 'plan' }),
  'plan-review': (h, job) => h.store.append(job.jobId, ev.phaseCompleted('plan-review', 1)),
  implement: async (h, job) => {
    await h.store.append(job.jobId, ev.tasksLoaded([taskCreated('T1')]));
    await h.store.append(job.jobId, ev.phaseCompleted('implement', 1));
  },
};

async function advanceTo(h, job, phaseId) {
  while (h.store.get(job.jobId).phaseId !== phaseId) await M2_STEPS[h.store.get(job.jobId).phaseId](h, job);
}

const BLOCKER = { id: 'B1', severity: 'blocker', text: 'the spec omits error handling' };
const MAJOR = { id: 'M1', severity: 'major', text: 'name the config file' };

// Three review rounds whose fixes decline both findings, then one verifier.
async function reviewToVerdict(h, job, verified) {
  for (let round = 1; round <= 3; round++) {
    await recordAttempt(h, job, { phase: 'spec-review', purpose: 'review', round, verdict: 'changes', findings: [BLOCKER, MAJOR] });
    await recordAttempt(h, job, {
      phase: 'spec-review',
      purpose: 'fix',
      round,
      final: round === 3,
      findings: [{ ...BLOCKER, disposition: 'declined: out of scope' }, { ...MAJOR, disposition: 'declined: kept as is' }],
    });
  }
  await recordAttempt(h, job, { phase: 'spec-review', purpose: 'verify', verified: [{ id: 'B1', verified, evidence: 'src/app.js:12 throws on a missing file' }] });
}

function failingAppendOpen() {
  const arm = { next: false };
  const openImpl = async (file, flags) => {
    const fh = await fs.open(file, flags);
    if (flags !== 'a' || !arm.next) return fh;
    arm.next = false;
    return {
      write: (buf) => fh.write(buf),
      datasync: async () => {
        await fh.datasync();
        throw new Error('injected datasync failure');
      },
      close: () => fh.close(),
    };
  };
  return { arm, openImpl };
}

const noJobDirs = async (jobsRoot) => {
  const entries = await fs.readdir(jobsRoot).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  assert.deepEqual(entries, []);
};

const writeTasksFile = async (job, text) => {
  const file = path.join(job.repos[0].worktree, ...artifactPaths(job).tasks.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

test('createJob with the milestone-2 fixture provisions and validates', async () => {
  try {
    const h = await harness();
    const job = await createM2(h);
    assert.equal(job.state, 'running');
    assert.equal(job.pipeline.length, 7);
    assert.deepEqual(job.pipeline, JSON.parse(JSON.stringify(MILESTONE_2_PIPELINE)));
    assert.deepEqual(h.events(job.jobId)[0].pipeline, job.pipeline);
    assert.equal(job.phaseId, 'spec');
  } finally { registry._reset(); }
});

test('createJob rejects a pipeline whose role has no template with ERR_NO_TEMPLATE, and the default pipeline passes the template check', async () => {
  try {
    const plain = await harness();
    assert.equal((await create(plain, { fixture: undefined })).state, 'running');

    const ghost = { provider: 'claude', model: 'claude-opus-5-5', maxTurns: 10 };
    const pipeline = defaultConfig().pipeline.map((p) => {
      if (p.phase === 'spec-review') return { ...p, author: 'ghost-writer' };
      if (p.phase === 'implement') return { ...p, taskReview: 'ghost-reviewer' };
      return p;
    });
    const h = await harness({ configJson: (repo) => ({ projects: { [repo]: { pipeline, models: { 'ghost-writer': ghost, 'ghost-reviewer': ghost } } } }) });
    await assert.rejects(create(h, { fixture: undefined }), (err) => {
      assert.equal(err.code, 'ERR_NO_TEMPLATE');
      assert.deepEqual(err.roles, ['ghost-writer', 'ghost-reviewer']);
      return true;
    });
    await noJobDirs(h.jobsRoot);
    assert.deepEqual(h.sa.listJobs(), []);
  } finally { registry._reset(); }
});

test('createJob refuses manual mode on a pipeline with a brainstorm; a fixture without one is unaffected', async () => {
  try {
    const h = await harness();
    await assert.rejects(create(h, { fixture: undefined, mode: 'manual' }), { code: 'ERR_MODE_UNSUPPORTED', message: 'superagent: manual mode is not built yet' });
    await noJobDirs(h.jobsRoot);
    assert.deepEqual(h.sa.listJobs(), []);
    const job = await create(h, { mode: 'manual' });
    assert.deepEqual([job.state, job.mode], ['running', 'manual']);
  } finally { registry._reset(); }
});

test('a project override template satisfies the check', async () => {
  try {
    const h = await harness();
    const overrides = path.join(h.repo, '.superpowers', 'superagent', 'prompts');
    await fs.mkdir(overrides, { recursive: true });
    await fs.writeFile(path.join(overrides, 'spec-writer.md'), '# Custom spec writer');
    const job = await create(h, { fixture: undefined });
    assert.equal(job.state, 'running');
    assert.equal(job.pipeline[0].role, 'brainstormer');
  } finally { registry._reset(); }
});

// --- Plan 7: jobs are created from a workflow ---

const NOTE_PROMPT = '# Note writer\n\nNOTE-WRITER-MARKER\n';
const QUICK = {
  format: 1,
  id: 'quick',
  name: 'Quick note',
  artifacts: { note: 'docs/notes/{date}-{slug}.md' },
  phases: [
    { phase: 'write', kind: 'author', role: 'note-writer', inputs: ['idea'], outputs: ['note'] },
    { phase: 'accept', kind: 'human', inputs: ['note'] },
  ],
  roles: { 'note-writer': { prompt: 'prompts/note-writer.md', model: 'claude-sonnet-5-5', maxTurns: 12 } },
};

async function writeWorkflow(dir, doc, { file = `${doc.id}.json`, prompts = { 'note-writer.md': NOTE_PROMPT } } = {}) {
  await fs.mkdir(path.join(dir, 'prompts'), { recursive: true });
  await fs.writeFile(path.join(dir, file), JSON.stringify(doc));
  for (const [name, text] of Object.entries(prompts)) await fs.writeFile(path.join(dir, 'prompts', name), text);
}

const projectWorkflows = (repo) => path.join(repo, '.superpowers', 'superagent', 'workflows');
const createFrom = (h, workflow, over = {}) => create(h, { fixture: null, workflow, ...over });
// As a pre-Plan-7 config.json wrote it: no `test` flag.
const shortPipeline = () => defaultConfig().pipeline.map(({ test, ...p }) => (p.phase === 'spec-review' ? { ...p, maxRounds: 1 } : p));

test('createJob with a workflow records it', async () => {
  try {
    const h = await harness({
      configJson: (repo) => ({
        defaults: { models: { 'note-writer': { maxTurns: 30 } } },
        projects: { [repo]: { models: { 'note-writer': { alternate: 'claude-opus-5-5' } } } },
      }),
    });
    await writeWorkflow(h.globalWorkflows, QUICK);
    const job = await createFrom(h, 'quick');
    assert.equal(job.state, 'running');
    const created = h.events(job.jobId)[0];
    assert.deepEqual(created.workflow, { id: 'quick', name: 'Quick note', source: 'global', file: path.join(h.globalWorkflows, 'quick.json') });
    assert.deepEqual(created.artifacts, { note: `docs/notes/${created.createdDate}-${job.slug}.md` });
    assert.deepEqual(created.prompts, { 'note-writer': path.join(h.globalWorkflows, 'prompts', 'note-writer.md') });
    assert.deepEqual(created.pipeline, QUICK.phases);
    assert.deepEqual(created.models['note-writer'], { provider: 'claude', model: 'claude-sonnet-5-5', maxTurns: 30, alternate: 'claude-opus-5-5' });
    assert.deepEqual(created.models['spec-writer'], defaultConfig().models['spec-writer']);
    assert.deepEqual([job.workflow, job.artifacts, job.prompts], [created.workflow, created.artifacts, created.prompts]);

    await h.sa.tick();
    assert.equal(h.started(job.jobId).at(-1).role, 'note-writer');
    assert.match(h.factory.calls.at(-1).sdkOptions.appendSystemPrompt, /NOTE-WRITER-MARKER/);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a declared workflow prompt shadowed by a project override is still recorded', async () => {
  try {
    const h = await harness();
    await writeWorkflow(h.globalWorkflows, QUICK, { prompts: {} });
    const overrides = path.join(h.repo, '.superpowers', 'superagent', 'prompts');
    await fs.mkdir(overrides, { recursive: true });
    await fs.writeFile(path.join(overrides, 'note-writer.md'), '# Override\n');
    const job = await createFrom(h, 'quick');
    assert.deepEqual(h.events(job.jobId)[0].prompts, { 'note-writer': path.join(h.globalWorkflows, 'prompts', 'note-writer.md') });
  } finally { registry._reset(); }
});

test('createJob finds a workflow by id in any case and records the listed spelling', async () => {
  try {
    const h = await harness();
    await writeWorkflow(h.globalWorkflows, QUICK);
    const job = await createFrom(h, 'QUICK');
    assert.equal(h.events(job.jobId)[0].workflow.id, 'quick');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('createJob refuses an unknown or invalid workflow before the job exists', async () => {
  try {
    const h = await harness();
    await writeWorkflow(h.globalWorkflows, { ...QUICK, id: 'broken', phases: QUICK.phases.slice(0, 1) });
    await assert.rejects(createFrom(h, 'nope'), { code: 'ERR_UNKNOWN_WORKFLOW' });
    await assert.rejects(createFrom(h, 'broken'), (err) => {
      assert.equal(err.code, 'ERR_INVALID_WORKFLOW');
      assert.ok(err.errors.length > 0);
      return true;
    });

    // A broken project `feature` shadows the built-in, also when it is the default.
    await writeWorkflow(projectWorkflows(h.repo), { ...QUICK, id: 'feature', phases: QUICK.phases.slice(0, 1) });
    await assert.rejects(createFrom(h, null), { code: 'ERR_INVALID_WORKFLOW' });
    await assert.rejects(createFrom(h, 'feature'), { code: 'ERR_INVALID_WORKFLOW' });
    await noJobDirs(h.jobsRoot);
    assert.deepEqual(h.sa.listJobs(), []);
  } finally { registry._reset(); }
});

test('a raw config pipeline is offered and pre-selected', async () => {
  try {
    const plain = await harness();
    const none = await plain.sa.listWorkflows(plain.repo);
    assert.equal(none.workflows.some((w) => w.id === 'config-pipeline'), false);
    assert.equal(none.default, 'feature');
    assert.ok(none.workflows.every((w) => !('doc' in w)));

    const global = await harness({ configJson: { defaults: { pipeline: defaultConfig().pipeline } } });
    const listed = await global.sa.listWorkflows(global.repo);
    const entry = listed.workflows.find((w) => w.id === 'config-pipeline');
    assert.deepEqual([entry.name, entry.valid, listed.default], ['custom (config.json)', true, 'config-pipeline']);
    assert.ok(listed.workflows.some((w) => w.id === 'feature'));

    const scoped = await harness({ configJson: (repo) => ({ defaults: { workflow: 'feature' }, projects: { [repo]: { pipeline: shortPipeline() } } }) });
    assert.equal((await scoped.sa.listWorkflows(scoped.repo)).default, 'config-pipeline');
    const job = await createFrom(scoped, 'config-pipeline');
    const created = scoped.events(job.jobId)[0];
    assert.equal(created.pipeline.find((p) => p.phase === 'spec-review').maxRounds, 1);
    assert.deepEqual(created.workflow, { id: 'config-pipeline', name: 'custom (config.json)', source: 'config', file: null });
    assert.equal(created.artifacts.spec, `docs/superpowers/specs/${created.createdDate}-${job.slug}-design.md`);
    assert.equal(created.pipeline.find((p) => p.phase === 'test').test, true);
  } finally { registry._reset(); }
});

test('createJob without workflow uses the default', async () => {
  try {
    const h = await harness();
    const job = await createFrom(h, undefined);
    const created = h.events(job.jobId)[0];
    assert.deepEqual(created.workflow, { id: 'feature', name: 'Feature', source: 'built-in', file: path.join(workflowsDir(), 'feature.json') });
    assert.deepEqual(created.pipeline, JSON.parse(JSON.stringify(defaultConfig().pipeline)));
    assert.equal(created.artifacts.brief, `docs/superpowers/jobs/${job.slug}/brief.md`);
    assert.ok(Object.keys(created.prompts).includes('spec-writer'));
    assert.ok(Object.values(created.prompts).every((p) => p === null));
  } finally { registry._reset(); }
});

test('createJob with fixture keeps the legacy shape', async () => {
  try {
    const h = await harness();
    await writeWorkflow(h.globalWorkflows, QUICK);
    const job = await create(h, { workflow: 'quick' });
    const created = h.events(job.jobId)[0];
    for (const key of ['workflow', 'artifacts', 'prompts']) assert.equal(key in created, false, key);
    assert.deepEqual(created.pipeline, JSON.parse(JSON.stringify(MILESTONE_1_PIPELINE)));
    assert.equal(job.workflow, null);
  } finally { registry._reset(); }
});

test('an edited workflow file does not change an existing job', async () => {
  try {
    const h = await harness();
    await writeWorkflow(h.globalWorkflows, QUICK);
    const job = await createFrom(h, 'quick');
    const edited = { ...QUICK, phases: [{ ...QUICK.phases[0], phase: 'draft' }, QUICK.phases[1]], roles: { 'note-writer': { ...QUICK.roles['note-writer'], maxTurns: 99 } } };
    await writeWorkflow(h.globalWorkflows, edited);
    const fresh = await h.restart();
    await fresh.sa.start();
    const got = fresh.sa.getJob(job.jobId);
    assert.deepEqual(got.pipeline, QUICK.phases);
    assert.equal(got.models['note-writer'].maxTurns, 12);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

// The win32 guard's arithmetic, written out independently of index.js:
// <root>/<slug>/primary/.superpowers/superagent/<jobId>/attempts/<phase>
// [/<12-char task>]/<36-char attempt id>/result.json.tmp. milestone-1's
// longest phase is spec; milestone-2's is implement with a task segment.
const FIXED_JOB = '0123abcd-0000-4000-8000-000000000000';
const M1_LONGEST = ['spec'];
const M2_LONGEST = ['implement', 'f'.repeat(12)];
const longestPath = (root, slug, segments) => path.join(path.resolve(root), slug, 'primary', '.superpowers', 'superagent', FIXED_JOB, 'attempts', ...segments, 'f'.repeat(36), 'result.json.tmp').length;
// A root under the harness's temp dir for which the longest path is `length`.
const rootFor = (base, slug, segments, length) => {
  const pad = length - longestPath(base, slug, segments) - 1;
  assert.ok(pad > 0, 'the temp dir leaves room for the boundary root');
  const root = path.join(base, 'w'.repeat(pad));
  assert.equal(longestPath(root, slug, segments), length);
  return root;
};
const win32 = (worktreesRoot) => harness({ platform: 'win32', worktreesRoot, idImpl: () => FIXED_JOB });

test('createJob on win32: an attempt path of exactly 259 characters passes and 260 is refused', async () => {
  try {
    const probe = await harness();
    const slug = 'abcdefgh-0123abcd';
    const atLimit = rootFor(probe.root, slug, M1_LONGEST, 259);
    const fits = await win32(atLimit);
    const job = await create(fits, { title: 'abcdefgh' });
    assert.equal(job.state, 'running');
    assert.equal(job.slug, slug);

    const over = await win32(`${atLimit}w`);
    await assert.rejects(create(over, { title: 'abcdefgh' }), (err) => {
      assert.equal(err.code, 'ERR_PATH_TOO_LONG');
      assert.deepEqual([err.length, err.limit], [260, 259]);
      assert.match(err.message, /COCKPIT_HOME/);
      return true;
    });
    await noJobDirs(over.jobsRoot);
  } finally { registry._reset(); }
});

test('createJob on win32 cuts a long title to fit the root and creates the job', async () => {
  try {
    const probe = await harness();
    const title = 'Add a hello endpoint and wire it into the router with tests';
    // Twelve title characters fit: the cut lands after "hello-", which is trimmed.
    const root = rootFor(probe.root, '-0123abcd', M1_LONGEST, 259 - 12);
    const h = await win32(root);
    const job = await create(h, { title });
    assert.equal(job.state, 'running');
    assert.equal(job.slug, 'add-a-hello-0123abcd');
    assert.ok(longestPath(root, job.slug, M1_LONGEST) <= 259);
    assert.equal(job.branch, 'superagent/add-a-hello-0123abcd');
  } finally { registry._reset(); }
});

test('createJob on win32 with a 59-character worktrees root (the default COCKPIT_HOME here) accepts milestone-2 with a normal title', async (t) => {
  const probe = await harness();
  const pad = 59 - path.resolve(probe.root).length - 1;
  if (pad < 1) {
    t.skip(`the temp dir ${probe.root} is longer than a 59-character root`);
    return;
  }
  try {
    const root = path.join(path.resolve(probe.root), 'w'.repeat(pad));
    assert.equal(root.length, 59);
    const title = 'Add a hello endpoint and wire it into the router with tests';
    const h = await win32(root);
    const job = await createM2(h, { title });
    assert.equal(job.state, 'running');
    const maxBase = 259 - longestPath(root, '-0123abcd', M2_LONGEST);
    assert.ok(maxBase >= 30 && maxBase < 40, `${maxBase} title characters fit`);
    assert.equal(job.slug, slugify(title, FIXED_JOB, maxBase));
    assert.ok(longestPath(root, job.slug, M2_LONGEST) <= 259);
  } finally { registry._reset(); }
});

test('createJob on win32 refuses a root too long for an 8-character title, writing nothing', async () => {
  try {
    const probe = await harness();
    // Seven title characters would fit: one short of the minimum.
    const tight = await win32(rootFor(probe.root, '-0123abcd', M1_LONGEST, 259 - 7));
    await assert.rejects(create(tight), { code: 'ERR_PATH_TOO_LONG', length: 260, limit: 259 });
    await noJobDirs(tight.jobsRoot);

    const longRoot = path.join(probe.root, 'x'.repeat(150), 'worktrees');
    const long = await win32(longRoot);
    await assert.rejects(create(long), (err) => {
      assert.equal(err.code, 'ERR_PATH_TOO_LONG');
      assert.match(err.message, /COCKPIT_HOME/);
      return true;
    });
    await noJobDirs(long.jobsRoot);
    assert.deepEqual(long.sa.listJobs(), []);

    // Off win32 the preflight is skipped and the job is created (on a Windows
    // host its provisioning then fails on the real path limit).
    const elsewhere = await harness({ worktreesRoot: longRoot });
    assert.ok(['running', 'failed'].includes((await create(elsewhere)).state));
    assert.equal((await elsewhere.store.listJobIds()).length, 1);
  } finally { registry._reset(); }
});

test('tick: a finished review loop appends phase-completed and the phase index advances', async () => {
  try {
    const h = await harness();
    const job = await createM2(h);
    await advanceTo(h, job, 'spec-review');
    await recordAttempt(h, job, { phase: 'spec-review', purpose: 'review', round: 1, verdict: 'approve', findings: [] });
    await h.sa.tick();
    const last = h.events(job.jobId).at(-1);
    assert.equal(last.type, 'phase-completed');
    assert.deepEqual({ phase: last.phase, visit: last.visit, unresolved: last.unresolved, verification: last.verification }, { phase: 'spec-review', visit: 1, unresolved: [], verification: [] });
    const got = h.sa.getJob(job.jobId);
    assert.equal(got.phaseIndex, 2);
    assert.equal(got.phaseId, 'plan');
    assert.deepEqual(got.completions, [{ phase: 'spec-review', visit: 1, unresolved: [], verification: [] }]);
    assert.equal(h.started(job.jobId).length, 2, 'the completing tick launches nothing');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('tick: load-tasks appends tasks-loaded once; an invalid tasks.json parks the job needs-you stuck with the errors', async () => {
  try {
    const h = await harness();
    const job = await createM2(h);
    await advanceTo(h, job, 'implement');
    await writeTasksFile(job, JSON.stringify([{ id: 'T1', title: 'One', repos: ['primary'], dependsOn: [], acceptance: 'it works', verify: '' }]));
    await h.sa.tick();
    const loaded = () => h.events(job.jobId).filter((e) => e.type === 'tasks-loaded');
    assert.equal(loaded().length, 1);
    assert.deepEqual(loaded()[0].tasks, [taskCreated('T1', { title: 'One' })]);
    assert.deepEqual(h.sa.getJob(job.jobId).tasks, [taskCreated('T1', { title: 'One' })]);

    await h.sa.tick();
    assert.equal(loaded().length, 1);
    const launched = h.started(job.jobId).at(-1);
    assert.deepEqual([launched.phase, launched.task, launched.purpose], ['implement', 'T1', 'implement']);
    await h.sa.stop();

    const missing = await harness();
    const missingJob = await createM2(missing);
    await advanceTo(missing, missingJob, 'implement');
    await missing.sa.tick();
    const parked = missing.events(missingJob.jobId).at(-1);
    assert.deepEqual([parked.type, parked.reason, parked.detail.why], ['needs-you', 'stuck', 'tasks-invalid']);
    assert.equal(parked.detail.errors.length, 1);
    assert.match(parked.detail.errors[0], /tasks\.json/);
    assert.equal(missing.sa.getJob(missingJob.jobId).state, 'needs-you');

    const bad = await harness();
    const badJob = await createM2(bad);
    await advanceTo(bad, badJob, 'implement');
    await writeTasksFile(badJob, '{"id":"T1"}');
    await bad.sa.tick();
    const invalid = bad.events(badJob.jobId).at(-1);
    assert.deepEqual([invalid.type, invalid.reason, invalid.detail], ['needs-you', 'stuck', { why: 'tasks-invalid', errors: ['tasks.json must be a JSON array'] }]);
    assert.equal(bad.events(badJob.jobId).filter((e) => e.type === 'tasks-loaded').length, 0);
    assert.equal(bad.sa.getJob(badJob.jobId).tasks, null);
  } finally { registry._reset(); }
});

test('tick: a tasks.json read error other than a missing file is logged and retried, not parked', async () => {
  try {
    const logs = [];
    const h = await harness({ logImpl: (line) => logs.push(line) });
    const job = await createM2(h);
    await advanceTo(h, job, 'implement');
    // A directory where the file should be: readFile fails with EISDIR.
    const file = path.join(job.repos[0].worktree, ...artifactPaths(job).tasks.split('/'));
    await fs.mkdir(file, { recursive: true });
    const before = h.events(job.jobId).length;
    await h.sa.tick();
    assert.equal(h.events(job.jobId).length, before, 'nothing appended');
    assert.equal(h.sa.getJob(job.jobId).state, 'running');
    assert.ok(logs.some((line) => /tick failed for job/.test(line) && /EISDIR/.test(line)), logs.join('\n'));

    await fs.rm(file, { recursive: true });
    await writeTasksFile(job, JSON.stringify([{ id: 'T1', title: 'One', repos: ['primary'], dependsOn: [], acceptance: 'it works', verify: '' }]));
    await h.sa.tick();
    assert.equal(h.events(job.jobId).at(-1).type, 'tasks-loaded');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('tick: route-test-failure appends one test-routed event; replaying the tick after a rejected-but-landed append appends nothing more', async () => {
  const spy = rejectionSpy();
  try {
    const { arm, openImpl } = failingAppendOpen();
    const h = await harness({ storeOpts: { openImpl } });
    const job = await createM2(h);
    await advanceTo(h, job, 'test');
    const findings = [{ id: 'F1', severity: 'major', text: 'GET /hello returns 500' }];
    const testAttempt = await recordAttempt(h, job, { phase: 'test', purpose: 'test', outcome: 'failed', reason: 'failed', signature: 'failed|tests fail', findings });

    arm.next = true;
    await h.sa.tick();
    assert.equal(arm.next, false, 'the injected failure fired');
    const routed = () => h.events(job.jobId).filter((e) => e.type === 'test-routed');
    assert.equal(routed().length, 1);
    assert.equal(routed()[0].attemptId, testAttempt);
    const short = testAttempt.slice(0, 8);
    assert.deepEqual(routed()[0].task, {
      id: `F-${short}`,
      title: `Fix test failures from attempt ${short}`,
      repos: ['primary'],
      dependsOn: [],
      acceptance: 'GET /hello returns 500',
      verify: '',
      origin: 'test',
      fromAttemptId: testAttempt,
    });
    const got = h.sa.getJob(job.jobId);
    assert.equal(got.phaseId, 'implement');
    assert.equal(got.visits.implement, 2);
    assert.equal(got.tasks.filter((t) => t.fromAttemptId === testAttempt).length, 1);

    await h.sa.tick();
    await h.sa.tick();
    assert.equal(routed().length, 1);
    await h.sa.stop();
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('getJob exposes completions with unresolved findings and verifier evidence after a restart', async () => {
  try {
    const h = await harness();
    const job = await createM2(h);
    await advanceTo(h, job, 'spec-review');
    await reviewToVerdict(h, job, false);
    await h.sa.tick();
    assert.equal(h.events(job.jobId).at(-1).type, 'phase-completed');
    await h.sa.stop();

    const fresh = await h.restart();
    await fresh.sa.start();
    const got = fresh.sa.getJob(job.jobId);
    const evidence = 'src/app.js:12 throws on a missing file';
    assert.deepEqual(got.completions, [{
      phase: 'spec-review',
      visit: 1,
      unresolved: [{ ...BLOCKER, status: 'disputed-not-verified' }, { ...MAJOR, status: 'declined' }],
      verification: [{ id: 'B1', verified: false, evidence }],
    }]);
    assert.deepEqual(got.visits, { spec: 1, 'spec-review': 1, plan: 1 });
    assert.equal(got.tasks, null);
    const review = got.attempts.filter((a) => a.phase === 'spec-review');
    assert.deepEqual(review.map((a) => [a.purpose, a.round, a.final]), [
      ['review', 1, false], ['fix', 1, false], ['review', 2, false], ['fix', 2, false], ['review', 3, false], ['fix', 3, true], ['verify', null, false],
    ]);
    assert.equal(review[0].verdict, 'changes');
    assert.deepEqual(review[0].findings, [BLOCKER, MAJOR]);
    assert.deepEqual(review.at(-1).verified, [{ id: 'B1', verified: false, evidence }]);
    const listed = fresh.sa.listJobs().find((j) => j.jobId === job.jobId);
    assert.deepEqual(listed.completions, got.completions);
    assert.deepEqual(listed.attempts, got.attempts);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('a verified blocker parks the job needs-you with the blocker text and evidence', async () => {
  try {
    const h = await harness();
    const job = await createM2(h);
    await advanceTo(h, job, 'spec-review');
    await reviewToVerdict(h, job, true);
    const verifyId = h.store.get(job.jobId).attempts.at(-1).attemptId;
    await h.sa.tick();
    const last = h.events(job.jobId).at(-1);
    assert.equal(last.type, 'needs-you');
    assert.equal(last.reason, 'question');
    assert.deepEqual(last.detail, {
      kind: 'blocker',
      text: `The verifier confirmed blocker B1: ${BLOCKER.text}`,
      evidence: 'B1: src/app.js:12 throws on a missing file',
      attemptId: verifyId,
      phase: 'spec-review',
      task: null,
    });
    const got = h.sa.getJob(job.jobId);
    assert.equal(got.state, 'needs-you');
    assert.equal(got.completions.length, 0);
    assert.equal(got.phaseId, 'spec-review');
  } finally { registry._reset(); }
});

const lineCount = (h, jobId) => readFileSync(path.join(h.jobsRoot, jobId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;

test('createJob refuses a bad folder before the job exists', async () => {
  try {
    const h = await harness();
    const plain = path.join(h.root, 'plain');
    await fs.mkdir(plain);
    await assert.rejects(create(h, { primaryRepo: plain }), (err) => err.code === 'ERR_NOT_GIT_REPO');
    const unborn = path.join(h.root, 'unborn');
    await initRepo(unborn, { commit: false });
    await assert.rejects(create(h, { additionalRepos: [unborn] }), (err) => err.code === 'ERR_NO_COMMITS');
    assert.deepEqual(h.sa.listJobs(), []);
    await noJobDirs(h.jobsRoot);
    assert.equal(existsSync(h.worktreesRoot), false);
  } finally { registry._reset(); }
});

test('createJob refuses the same repo twice before the job exists', async () => {
  try {
    const h = await harness();
    await assert.rejects(create(h, { additionalRepos: [h.repo] }), (err) => {
      assert.equal(err.code, 'ERR_DUPLICATE_REPO');
      assert.equal(err.message, `superagent: ${path.resolve(h.repo)} is the same repository as ${path.resolve(h.repo)}`);
      return true;
    });
    const sub = path.join(h.repo, 'sub');
    await fs.mkdir(sub);
    await assert.rejects(create(h, { additionalRepos: [sub] }), { code: 'ERR_DUPLICATE_REPO' });
    const lib = path.join(h.root, 'lib');
    await initRepo(lib);
    await fs.mkdir(path.join(lib, 'inner'));
    await assert.rejects(create(h, { additionalRepos: [lib, path.join(lib, 'inner')] }), { code: 'ERR_DUPLICATE_REPO' });
    assert.deepEqual(h.sa.listJobs(), []);
    await noJobDirs(h.jobsRoot);
    assert.equal(existsSync(h.worktreesRoot), false);
  } finally { registry._reset(); }
});

test('repeated answer, accept and stop append nothing', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    await h.store.append(job.jobId, { type: 'needs-you', reason: 'question', detail: { attemptId: 'a1', question: 'Which file?' } });
    assert.equal((await h.sa.answerQuestion(job.jobId, 'hello.txt')).state, 'running');
    let lines = lineCount(h, job.jobId);
    await assert.rejects(h.sa.answerQuestion(job.jobId, 'hello.txt'), { code: 'ERR_INVALID_STATE' });
    assert.equal(lineCount(h, job.jobId), lines);

    await h.store.append(job.jobId, { type: 'needs-you', reason: 'ready-to-try', detail: null });
    assert.equal((await h.sa.accept(job.jobId)).state, 'done');
    lines = lineCount(h, job.jobId);
    await assert.rejects(h.sa.accept(job.jobId), { code: 'ERR_INVALID_STATE' });
    assert.equal(lineCount(h, job.jobId), lines);

    const other = await create(h);
    const stopped = await h.sa.stopJob(other.jobId);
    assert.equal(stopped.state, 'stopped');
    lines = lineCount(h, other.jobId);
    const again = await h.sa.stopJob(other.jobId);
    assert.equal(again.state, 'stopped');
    assert.equal(again.lastSeq, stopped.lastSeq);
    assert.equal(lineCount(h, other.jobId), lines);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an answer or accept for a needs-you the job has left is refused and appends nothing', async () => {
  try {
    const h = await harness();
    const job = await create(h);
    await h.store.append(job.jobId, { type: 'needs-you', reason: 'question', detail: { attemptId: 'a1', question: 'Which file?' } });
    const first = h.store.get(job.jobId).needsYouSeq;
    await h.store.append(job.jobId, { type: 'needs-you', reason: 'question', detail: { attemptId: 'a2', question: 'Which folder?' } });
    const second = h.store.get(job.jobId).needsYouSeq;
    assert.notEqual(first, second);

    let lines = lineCount(h, job.jobId);
    await assert.rejects(h.sa.answerQuestion(job.jobId, 'hello.txt', { needsYouSeq: first }), { code: 'ERR_INVALID_STATE' });
    assert.equal(lineCount(h, job.jobId), lines);
    const answered = await h.sa.answerQuestion(job.jobId, 'src/', { needsYouSeq: second });
    assert.deepEqual(answered.answers.map((a) => [a.forAttemptId, a.answer]), [['a2', 'src/']]);

    await h.store.append(job.jobId, { type: 'needs-you', reason: 'ready-to-try', detail: null });
    const ready = h.store.get(job.jobId).needsYouSeq;
    lines = lineCount(h, job.jobId);
    await assert.rejects(h.sa.accept(job.jobId, { needsYouSeq: second }), { code: 'ERR_INVALID_STATE' });
    assert.equal(lineCount(h, job.jobId), lines);
    assert.equal((await h.sa.accept(job.jobId, { needsYouSeq: ready })).state, 'done');
    await h.sa.stop();
  } finally { registry._reset(); }
});
