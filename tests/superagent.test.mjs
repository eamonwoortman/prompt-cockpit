import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { tempDir, initRepo, sessionFactory, jobCreated, deferred, T0 } from './superagent-helpers.mjs';
import { createSuperagentStore } from '../src/superagent/store.js';
import { createSuperagentConfig, MILESTONE_1_PIPELINE } from '../src/superagent/config.js';
import { RESULT_FILE, artifactPaths, attemptDir } from '../src/superagent/results.js';
import { createWorktree, defaultGit } from '../src/superagent/worktree.js';
import { createSuperagent, TICK_MS } from '../src/superagent/index.js';

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
      ...opts,
    });
    const events = (jobId) => readFileSync(path.join(jobsRoot, jobId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const inputs = () => [...factory.impls.values()].flatMap((impl) => impl.allInputs ?? []);
    return {
      root, repo, baseSha, jobsRoot, worktreesRoot, clock, store, config, factory, sa, events, inputs,
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
    await assert.rejects(create(h, { fixture: undefined }), { code: 'ERR_INVALID_CONFIG' });
    await assert.rejects(create(h, { fixture: 'milestone-2' }), { code: 'ERR_UNKNOWN_FIXTURE' });
    await assert.rejects(create(h), { code: 'ERR_INVALID_CONFIG' });

    const plain = await harness();
    await assert.rejects(create(plain, { fixture: undefined }), { code: 'ERR_PHASE_KIND_UNSUPPORTED' });
    await assert.rejects(create(plain, { fixture: 'milestone-2' }), { code: 'ERR_UNKNOWN_FIXTURE' });
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
    const extra = path.join(root, 'notarepo');
    await fs.mkdir(extra, { recursive: true });
    const h = await harness();
    const job = await create(h, { additionalRepos: [extra] });
    assert.equal(job.state, 'failed');
    assert.match(job.detail.error, /not a git repository/);
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

test('start and stop are idempotent and own exactly one interceptor while started', async () => {
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
    assert.deepEqual([counts.interceptors, counts.cleared], [0, 1]);
    await h.sa.start();
    assert.deepEqual([counts.interceptors, counts.interceptorAdds, counts.timers], [1, 2, 2]);
    await h.sa.stop();
    assert.equal(counts.interceptors, 0);
    assert.equal(counts.removalAdds, 1);
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
