import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, initRepo, sessionFactory, deferred, missingTranscripts, T0 } from './superagent-helpers.mjs';

process.env.COCKPIT_HOME = await tempDir('sa-stop-prov-home-');

const registry = await import('../src/session-registry.js');
const { createSuperagentStore } = await import('../src/superagent/store.js');
const { createSuperagentConfig } = await import('../src/superagent/config.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { workflowsDir } = await import('../src/superagent/workflows.js');
const { createGit, defaultGit } = await import('../src/superagent/worktree.js');

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasBranch = (cwd, branch) => {
  try {
    gitIn(cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};
const isAdd = (args) => args.includes('worktree') && args.includes('add');
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function harness({ git } = {}) {
  registry._reset();
  const root = await tempDir('sa-stop-prov-');
  const repo = path.join(root, 'repo');
  const baseSha = await initRepo(repo);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, '{}');
  const jobsRoot = path.join(root, 'jobs');
  const worktreesRoot = path.join(root, 'worktrees');
  const logs = [];
  const store = createSuperagentStore({ rootDir: jobsRoot, now: () => T0, logImpl: () => {} });
  const config = createSuperagentConfig({ filePath: configFile });
  await config.load();
  const factory = sessionFactory(registry);
  let n = 0;
  const sa = createSuperagent({
    registry: factory.registry,
    store,
    config,
    worktreesRoot,
    now: () => T0,
    idImpl: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`,
    setIntervalImpl: () => 'timer',
    clearIntervalImpl: () => {},
    stopTickDeadlineMs: 20,
    logImpl: (line) => logs.push(line),
    platform: process.platform,
    ...(git && { git }),
    workflowDirs: { builtin: workflowsDir(), global: path.join(root, 'workflows') },
    transcripts: missingTranscripts(),
  });
  const events = (jobId) => readFileSync(path.join(jobsRoot, jobId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const jobId = async () => (await store.listJobIds())[0];
  return { root, repo, baseSha, jobsRoot, worktreesRoot, store, sa, factory, events, logs, jobId };
}

const create = (h, over = {}) => h.sa.createJob({ title: 'Add hello', idea: 'Add hello.txt', primaryRepo: h.repo, fixture: 'milestone-1', ...over });

test('Stop during git worktree add kills the git tree, removes the half-made worktree and branch, and stops the job', async () => {
  try {
    const killed = [];
    const ran = [];
    const reached = deferred();
    let finishAdd;
    // Real git for everything; worktree add really runs, is left locked the
    // way a killed one is, and then "hangs" as a fake child until killed.
    const execFileImpl = (file, args, opts, cb) => {
      ran.push(args.join(' '));
      if (!isAdd(args)) return execFile(file, args, opts, cb);
      execFileSync(file, args, { cwd: opts.cwd, stdio: 'ignore' });
      execFileSync('git', ['worktree', 'lock', '--reason', 'initializing', args.at(-2)], { cwd: opts.cwd, stdio: 'ignore' });
      finishAdd = cb;
      reached.resolve();
      return { pid: 4242, kill: () => assert.fail('the tree kill succeeded') };
    };
    const killTree = (pid) => {
      killed.push(pid);
      finishAdd(Object.assign(new Error('killed'), { code: 1 }), '', '');
      return true;
    };
    const h = await harness({ git: createGit({ execFileImpl, killTree }) });
    const creating = create(h);
    await reached.promise;
    const jobId = await h.jobId();
    const worktree = path.join(h.worktreesRoot, h.store.get(jobId).slug, 'primary');
    const branch = h.store.get(jobId).branch;
    assert.ok(existsSync(worktree));

    const stopping = h.sa.stopJob(jobId);
    assert.deepEqual(killed, [4242], 'the kill happens before stopJob waits on the job');
    const again = h.sa.stopJob(jobId);
    const [created, stopped, stoppedAgain] = await Promise.all([creating, stopping, again]);

    assert.equal(created.state, 'stopped');
    assert.equal(stopped.state, 'stopped');
    assert.equal(stoppedAgain.state, 'stopped');
    assert.equal((await h.sa.stopJob(jobId)).state, 'stopped');
    const types = h.events(jobId).map((e) => e.type);
    assert.deepEqual(types, ['job-created', 'job-stopped']);
    assert.equal(existsSync(worktree), false);
    assert.equal(hasBranch(h.repo, branch), false);
    assert.ok(!gitIn(h.repo, 'worktree', 'list', '--porcelain').toLowerCase().includes(h.store.get(jobId).slug));
    assert.equal(ran.some((a) => a.includes('prune')), false, 'cleanup never prunes the user repo');

    await h.sa.tick();
    assert.equal(h.factory.impls.size, 0);
    assert.equal(registry.list().length, 0);

    // The reservation is gone: an in-place job may take the folder now.
    const next = await create(h, { inPlace: [h.repo] });
    assert.equal(next.state, 'running');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('Stop during worktree add keeps the branch once it has moved past the base commit', async () => {
  try {
    const reached = deferred();
    const git = async (args, opts) => {
      if (!isAdd(args)) return defaultGit(args, opts);
      const res = await defaultGit(args, { cwd: opts.cwd });
      const wt = args.at(-2);
      await fs.writeFile(path.join(wt, 'work.txt'), 'work\n');
      gitIn(wt, 'add', 'work.txt');
      gitIn(wt, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'work');
      assert.equal(res.code, 0);
      reached.resolve();
      await new Promise((resolve) => opts.signal.addEventListener('abort', resolve));
      return { code: 1, stdout: '', stderr: '', aborted: true };
    };
    const h = await harness({ git });
    const creating = create(h);
    await reached.promise;
    const jobId = await h.jobId();
    const { slug, branch } = h.store.get(jobId);
    const moved = gitIn(h.repo, 'rev-parse', `refs/heads/${branch}`);
    const [created, stopped] = await Promise.all([creating, h.sa.stopJob(jobId)]);
    assert.equal(created.state, 'stopped');
    assert.equal(stopped.state, 'stopped');
    assert.equal(existsSync(path.join(h.worktreesRoot, slug, 'primary')), false);
    assert.equal(gitIn(h.repo, 'rev-parse', `refs/heads/${branch}`), moved);
    assert.ok(h.logs.some((l) => l.includes(`kept branch ${branch}`)), h.logs.join('\n'));
  } finally { registry._reset(); }
});

test('a cleanup failure is logged and the job is still stopped', async () => {
  try {
    const reached = deferred();
    const git = async (args, opts) => {
      if (isAdd(args)) {
        await fs.mkdir(args.at(-2), { recursive: true });
        reached.resolve();
        await new Promise((resolve) => opts.signal.addEventListener('abort', resolve));
        return { code: 1, stdout: '', stderr: '', aborted: true };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') return { code: 128, stdout: '', stderr: 'fatal: injected remove failure' };
      if (args[0] === 'worktree' && args[1] === 'prune') assert.fail('cleanup never prunes the user repo');
      return defaultGit(args, opts);
    };
    const h = await harness({ git });
    const creating = create(h);
    await reached.promise;
    const jobId = await h.jobId();
    const [created, stopped] = await Promise.all([creating, h.sa.stopJob(jobId)]);
    assert.equal(created.state, 'stopped');
    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(h.events(jobId).map((e) => e.type), ['job-created', 'job-stopped']);
    const text = h.logs.join('\n');
    assert.match(text, /injected remove failure/);
    assert.match(text, /a locked worktree entry .* may remain/);
  } finally { registry._reset(); }
});

test('Stop between repos keeps the finished worktree and never switches the in-place repo after it', async () => {
  try {
    const root = await tempDir('sa-stop-prov-lib-');
    const lib = path.join(root, 'lib');
    await initRepo(lib);
    const libBranch = gitIn(lib, 'symbolic-ref', '--short', 'HEAD');
    const reached = deferred();
    const gate = deferred();
    const libCalls = [];
    const git = async (args, opts) => {
      if (path.resolve(opts.cwd) === path.resolve(lib)) libCalls.push(args.join(' '));
      if (isAdd(args)) {
        // The add finishes as the stop arrives: it ignores the signal.
        const res = await defaultGit(args, { cwd: opts.cwd });
        reached.resolve();
        await gate.promise;
        return res;
      }
      return defaultGit(args, opts);
    };
    const h = await harness({ git });
    const creating = create(h, { additionalRepos: [lib], inPlace: [lib] });
    await reached.promise;
    const jobId = await h.jobId();
    const { slug, branch } = h.store.get(jobId);
    const before = libCalls.length;
    const stopping = h.sa.stopJob(jobId);
    gate.resolve();
    const [created, stopped] = await Promise.all([creating, stopping]);
    assert.equal(created.state, 'stopped');
    assert.equal(stopped.state, 'stopped');
    const evs = h.events(jobId);
    assert.deepEqual(evs.map((e) => e.type), ['job-created', 'worktree-created', 'job-stopped']);
    assert.equal(evs[1].repo, 'primary');
    assert.ok(existsSync(path.join(h.worktreesRoot, slug, 'primary')));
    assert.ok(hasBranch(h.repo, branch));
    assert.deepEqual(libCalls.slice(before), [], 'nothing runs in the in-place folder after the stop');
    assert.equal(gitIn(lib, 'symbolic-ref', '--short', 'HEAD'), libBranch);
    assert.equal(hasBranch(lib, branch), false);
  } finally { registry._reset(); }
});

test('in place: Stop during the branch switch waits for it, runs no cleanup in the folder and leaves it on the job branch', async () => {
  try {
    const reached = deferred();
    const gate = deferred();
    const calls = [];
    let switchSignal = 'unset';
    const git = async (args, opts) => {
      calls.push({ args: args.join(' '), cwd: path.resolve(opts.cwd) });
      if (args[0] === 'switch' && args[1] === '-c') {
        switchSignal = opts.signal;
        reached.resolve();
        await gate.promise;
      }
      return defaultGit(args, opts);
    };
    const h = await harness({ git });
    const creating = create(h, { inPlace: [h.repo] });
    await reached.promise;
    const jobId = await h.jobId();
    const { branch } = h.store.get(jobId);
    let settled = false;
    const stopping = h.sa.stopJob(jobId).finally(() => { settled = true; });
    for (let i = 0; i < 20; i++) await turn();
    assert.equal(settled, false, 'the stop waits for the switch');
    const switchAt = calls.length;
    gate.resolve();
    const [created, stopped] = await Promise.all([creating, stopping]);
    assert.equal(switchSignal, undefined, 'the switch is never given the abort signal');
    assert.equal(created.state, 'stopped');
    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(h.events(jobId).map((e) => e.type), ['job-created', 'worktree-created', 'job-stopped']);
    assert.equal(gitIn(h.repo, 'symbolic-ref', '--short', 'HEAD'), branch);
    assert.ok(existsSync(path.join(h.jobsRoot, jobId, 'ledger')), 'a provisioning stop archives the ledger like any stop');
    const after = calls.slice(switchAt).map((c) => c.args);
    assert.equal(after.some((a) => /^(worktree|branch|reset|clean|stash|checkout|switch)\b/.test(a)), false, after.join('\n'));
    // The folder reservation is released: the folder can be named again (and
    // is refused only for being on the job's branch).
    await assert.rejects(create(h, { inPlace: [h.repo] }), { code: 'ERR_FOLDER_ON_JOB_BRANCH' });
  } finally { registry._reset(); }
});
