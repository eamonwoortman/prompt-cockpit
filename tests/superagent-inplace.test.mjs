import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, initRepo, sessionFactory, jobCreated, T0 } from './superagent-helpers.mjs';

process.env.COCKPIT_HOME = await tempDir('sa-inplace-home-');

const registry = await import('../src/session-registry.js');
const { createSuperagentStore } = await import('../src/superagent/store.js');
const { createSuperagentConfig } = await import('../src/superagent/config.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { workflowsDir } = await import('../src/superagent/workflows.js');
const { checkInPlace, normaliseTop } = await import('../src/superagent/inplace.js');

const quiet = () => {};
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return gitIn(cwd, ...args);
  } catch {
    return null;
  }
};
const norm = (p) => realpathSync.native(path.resolve(p)).toLowerCase();

async function harness() {
  registry._reset();
  const root = await tempDir('sa-inplace-');
  const repo = path.join(root, 'repo');
  const baseSha = await initRepo(repo);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, '{}');
  const jobsRoot = path.join(root, 'jobs');
  const worktreesRoot = path.join(root, 'worktrees');
  let n = 0;
  const logs = [];

  async function build() {
    const store = createSuperagentStore({ rootDir: jobsRoot, now: () => T0, logImpl: quiet });
    const config = createSuperagentConfig({ filePath: configFile });
    await config.load();
    const factory = sessionFactory(registry);
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
      workflowDirs: { builtin: workflowsDir(), global: path.join(root, 'workflows') },
    });
    const events = (jobId) => readFileSync(path.join(jobsRoot, jobId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return {
      root, repo, baseSha, jobsRoot, worktreesRoot, store, sa, events, logs,
      nextSlug: () => `add-hello-${String(n + 1).padStart(8, '0')}`,
      async restart() {
        registry._reset();
        return build();
      },
    };
  }
  return build();
}

const create = (h, over = {}) => h.sa.createJob({ title: 'Add hello', idea: 'Add hello.txt', primaryRepo: h.repo, fixture: 'milestone-1', ...over });

const noJobDirs = async (jobsRoot) => {
  const entries = await fs.readdir(jobsRoot).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  assert.deepEqual(entries, []);
};

function snapshot(folder) {
  const index = path.join(folder, '.git', 'index');
  return {
    branches: tryGit(folder, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
    head: tryGit(folder, 'rev-parse', '--verify', '--quiet', 'HEAD'),
    status: tryGit(folder, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'),
    superpowers: existsSync(path.join(folder, '.superpowers')),
    index: existsSync(index) ? createHash('sha256').update(readFileSync(index)).digest('hex') : null,
    entries: readdirNames(folder),
  };
}

function readdirNames(folder) {
  try {
    return readdirSync(folder).sort();
  } catch {
    return null;
  }
}

async function conflictingMerge(repo) {
  gitIn(repo, 'switch', '-q', '-c', 'other');
  await fs.writeFile(path.join(repo, 'README.md'), '# other\n');
  gitIn(repo, 'commit', '-q', '-am', 'other');
  gitIn(repo, 'switch', '-q', '-');
  await fs.writeFile(path.join(repo, 'README.md'), '# mine\n');
  gitIn(repo, 'commit', '-q', '-am', 'mine');
  assert.equal(tryGit(repo, 'merge', '-q', 'other'), null);
  assert.ok(existsSync(path.join(repo, '.git', 'MERGE_HEAD')));
}

test('each in-place check refuses and leaves the folder unchanged', async () => {
  try {
    const h = await harness();
    const cases = [
      ['ERR_NOT_GIT_REPO', async (dir) => { await fs.mkdir(dir); }],
      ['ERR_NO_COMMITS', async (dir) => { await initRepo(dir, { commit: false }); }],
      ['ERR_FOLDER_BUSY_GIT', async (dir) => { await initRepo(dir); gitIn(dir, 'checkout', '-q', '--detach'); }],
      ['ERR_FOLDER_BUSY_GIT', async (dir) => { await initRepo(dir); await conflictingMerge(dir); }],
      ['ERR_FOLDER_ON_JOB_BRANCH', async (dir) => { await initRepo(dir); gitIn(dir, 'switch', '-q', '-c', 'superagent/x'); }],
      ['ERR_FOLDER_DIRTY', async (dir) => { await initRepo(dir); await fs.writeFile(path.join(dir, 'untracked.txt'), 'mine\n'); }],
      ['ERR_FOLDER_DIRTY', async (dir) => { await initRepo(dir); await fs.writeFile(path.join(dir, 'README.md'), '# edited\n'); }],
      ['ERR_BRANCH_EXISTS', async (dir) => { await initRepo(dir); gitIn(dir, 'branch', `superagent/${h.nextSlug()}`); }],
    ];
    for (const [i, [code, setup]] of cases.entries()) {
      const dir = path.join(h.root, `case-${i}`);
      await setup(dir);
      const before = snapshot(dir);
      await assert.rejects(create(h, { primaryRepo: dir, inPlace: [dir] }), (err) => {
        assert.equal(err.code, code, `case ${i}: ${err.message}`);
        return true;
      });
      assert.deepEqual(snapshot(dir), before, `case ${i} changed the folder`);
    }
    assert.deepEqual(h.sa.listJobs(), []);
    await noJobDirs(h.jobsRoot);
    assert.equal(existsSync(h.worktreesRoot), false);
  } finally { registry._reset(); }
});

test('checkInPlace ignores ignored files and lists at most 10 dirty paths', async () => {
  const root = await tempDir('sa-inplace-direct-');
  const repo = path.join(root, 'repo');
  const head = await initRepo(repo);
  await fs.mkdir(path.join(repo, '.claude'));
  await fs.writeFile(path.join(repo, '.claude', 'settings.local.json'), '{}');
  const ok = await checkInPlace({ folder: repo, branch: 'superagent/x-1' });
  assert.equal(ok.head, head);
  assert.equal(normaliseTop(ok.toplevel, 'win32'), normaliseTop(gitIn(repo, 'rev-parse', '--show-toplevel'), 'win32'));

  for (let i = 0; i < 12; i++) await fs.writeFile(path.join(repo, `f${String(i).padStart(2, '0')}.txt`), 'x');
  await assert.rejects(checkInPlace({ folder: repo, branch: 'superagent/x-1' }), (err) => {
    assert.equal(err.code, 'ERR_FOLDER_DIRTY');
    assert.match(err.message, /f09\.txt and 2 more$/);
    assert.doesNotMatch(err.message, /f10\.txt/);
    return true;
  });
});

test('normaliseTop folds case on win32 only', () => {
  assert.equal(normaliseTop('/A/b/', 'linux'), path.resolve('/A/b'));
  assert.equal(normaliseTop('/A/b', 'win32'), path.resolve('/A/b').toLowerCase());
});

test('overlapping createJob calls on one folder admit one', async () => {
  try {
    const h = await harness();
    const results = await Promise.allSettled([create(h, { inPlace: [h.repo] }), create(h, { inPlace: [h.repo] })]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'ERR_FOLDER_IN_USE');
    assert.equal(h.sa.listJobs().length, 1);
    assert.deepEqual(await fs.readdir(h.jobsRoot), [fulfilled[0].value.jobId]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an unfinished in-place job blocks a worktree job on that repo', async () => {
  try {
    const h = await harness();
    const job = await create(h, { inPlace: [h.repo] });
    assert.equal(job.state, 'running');
    await assert.rejects(create(h), { code: 'ERR_FOLDER_IN_USE' });
    await assert.rejects(create(h, { inPlace: [h.repo] }), { code: 'ERR_FOLDER_IN_USE' });
    const other = path.join(h.root, 'other');
    await initRepo(other);
    await assert.rejects(create(h, { primaryRepo: other, additionalRepos: [h.repo] }), { code: 'ERR_FOLDER_IN_USE' });
    assert.equal(h.sa.listJobs().length, 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('two worktree jobs on one origin coexist', async () => {
  try {
    const h = await harness();
    const a = await create(h);
    const b = await create(h);
    assert.notEqual(a.jobId, b.jobId);
    assert.deepEqual([a.state, b.state], ['running', 'running']);
    await assert.rejects(create(h, { inPlace: [h.repo] }), { code: 'ERR_FOLDER_IN_USE' });
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a finished in-place job releases its reservation', async () => {
  try {
    const h = await harness();
    const job = await create(h, { inPlace: [h.repo] });
    await assert.rejects(create(h, { inPlace: [h.repo] }), { code: 'ERR_FOLDER_IN_USE' });
    assert.equal((await h.sa.stopJob(job.jobId)).state, 'stopped');
    const again = await create(h, { inPlace: [h.repo] });
    assert.equal(again.state, 'running');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a refused createJob releases its reservation at once', async () => {
  try {
    const h = await harness();
    const scratch = path.join(h.repo, 'scratch.txt');
    await fs.writeFile(scratch, 'mine\n');
    await assert.rejects(create(h, { inPlace: [h.repo] }), { code: 'ERR_FOLDER_DIRTY' });
    await fs.rm(scratch);
    const job = await create(h, { inPlace: [h.repo] });
    assert.equal(job.state, 'running');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a subfolder of a repo records the repo top level', async () => {
  try {
    const h = await harness();
    const sub = path.join(h.repo, 'sub');
    await fs.mkdir(sub);
    const lib = path.join(h.root, 'lib');
    await initRepo(lib);
    const job = await create(h, { primaryRepo: sub, additionalRepos: [lib], inPlace: [sub] });
    const [created] = h.events(job.jobId);
    assert.equal(created.type, 'job-created');
    const [primary, extra] = created.repos;
    assert.equal(primary.origin, path.resolve(sub));
    assert.equal(primary.inPlace, true);
    assert.equal(norm(primary.toplevel), norm(h.repo));
    assert.equal(primary.admittedHead, h.baseSha);
    assert.equal(extra.inPlace, undefined);
    assert.equal(norm(extra.toplevel), norm(lib));
    assert.equal(extra.admittedHead, undefined);
    assert.deepEqual(h.sa.getJob(job.jobId).repos.map((r) => r.inPlace), [true, false]);
    await assert.rejects(create(h), { code: 'ERR_FOLDER_IN_USE' });
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an inPlace folder that is not one of the job\'s folders is refused', async () => {
  try {
    const h = await harness();
    const other = path.join(h.root, 'other');
    await initRepo(other);
    const before = snapshot(other);
    await assert.rejects(create(h, { inPlace: [other] }), (err) => {
      assert.equal(err.code, 'ERR_INVALID_REQUEST');
      assert.match(err.message, /inPlace folder is not one of the job's folders/);
      return true;
    });
    assert.deepEqual(snapshot(other), before);
    await noJobDirs(h.jobsRoot);
    const job = await create(h, { inPlace: [h.repo] });
    assert.equal(job.state, 'running');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('reservations are rebuilt on start', async () => {
  try {
    const h = await harness();
    const sub = path.join(h.repo, 'sub');
    await fs.mkdir(sub);
    const toplevel = path.resolve(gitIn(h.repo, 'rev-parse', '--show-toplevel'));
    const repos = [{ id: 'primary', origin: sub, inPlace: true, toplevel, admittedHead: h.baseSha }];
    await h.store.append('jr', jobCreated({ jobId: 'jr', slug: 'r-jr', branch: 'superagent/r-jr', repos }));
    await h.store.append('jr', { type: 'worktree-created', repo: 'primary', worktree: toplevel, branch: 'superagent/r-jr', baseSha: h.baseSha, settingsCopy: 'in-place' });
    await h.store.append('jr', { type: 'job-provisioned' });
    const done = [{ id: 'primary', origin: h.repo, inPlace: true, toplevel, admittedHead: h.baseSha }];
    await h.store.append('jd', jobCreated({ jobId: 'jd', slug: 'd-jd', branch: 'superagent/d-jd', repos: done }));
    await h.store.append('jd', { type: 'job-stopped' });

    const fresh = await h.restart();
    await fresh.sa.start();
    assert.equal(fresh.sa.getJob('jr').state, 'running');
    await assert.rejects(create(fresh, { inPlace: [fresh.repo] }), { code: 'ERR_FOLDER_IN_USE' });
    await assert.rejects(create(fresh), { code: 'ERR_FOLDER_IN_USE' });
    await fresh.sa.stopJob('jr');
    const job = await create(fresh, { inPlace: [fresh.repo] });
    assert.equal(job.state, 'running');
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test("a worktree repo's job-created carries toplevel but not inPlace", async () => {
  try {
    const h = await harness();
    const sub = path.join(h.repo, 'sub');
    await fs.mkdir(sub);
    const job = await create(h, { primaryRepo: sub });
    const [repo] = h.events(job.jobId)[0].repos;
    assert.equal(repo.origin, path.resolve(sub));
    assert.equal(norm(repo.toplevel), norm(h.repo));
    assert.equal(repo.toplevel, path.resolve(repo.toplevel));
    assert.equal('inPlace' in repo, false);
    assert.equal('admittedHead' in repo, false);
    assert.deepEqual(h.sa.getJob(job.jobId).repos.map((r) => r.inPlace), [false]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('after a restart an unfinished worktree job on a subfolder blocks an in-place job on its repo', async () => {
  try {
    const h = await harness();
    const sub = path.join(h.repo, 'sub');
    await fs.mkdir(sub);
    const job = await create(h, { primaryRepo: sub });
    assert.equal(job.state, 'running');
    await h.sa.stop();

    const fresh = await h.restart();
    await fresh.sa.start();
    await assert.rejects(create(fresh, { inPlace: [fresh.repo] }), { code: 'ERR_FOLDER_IN_USE' });
    const worktreeJob = await create(fresh);
    assert.equal(worktreeJob.state, 'running');
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('a job recorded without toplevel is resolved through git at start', async () => {
  try {
    const h = await harness();
    const sub = path.join(h.repo, 'sub');
    await fs.mkdir(sub);
    const toplevel = path.resolve(gitIn(h.repo, 'rev-parse', '--show-toplevel'));
    await h.store.append('jl', jobCreated({ jobId: 'jl', slug: 'l-jl', branch: 'superagent/l-jl', repos: [{ id: 'primary', origin: sub }] }));
    await h.store.append('jl', { type: 'worktree-created', repo: 'primary', worktree: toplevel, branch: 'superagent/l-jl', baseSha: h.baseSha, settingsCopy: null });
    await h.store.append('jl', { type: 'job-provisioned' });

    const fresh = await h.restart();
    await fresh.sa.start();
    assert.equal(fresh.sa.getJob('jl').repos[0].toplevel, null);
    await assert.rejects(create(fresh, { inPlace: [fresh.repo] }), { code: 'ERR_FOLDER_IN_USE' });
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('a job whose top level git cannot find keeps its folder reserved and is logged', async () => {
  try {
    const h = await harness();
    const plain = path.join(h.root, 'plain');
    await fs.mkdir(plain);
    await h.store.append('jg', jobCreated({ jobId: 'jg', slug: 'g-jg', branch: 'superagent/g-jg', repos: [{ id: 'primary', origin: plain }] }));
    await h.store.append('jg', { type: 'worktree-created', repo: 'primary', worktree: plain, branch: 'superagent/g-jg', baseSha: h.baseSha, settingsCopy: null });
    await h.store.append('jg', { type: 'job-provisioned' });

    const fresh = await h.restart();
    await fresh.sa.start();
    assert.ok(fresh.logs.some((line) => line.includes(`could not find the top level of ${plain} for job jg`)), fresh.logs.join('\n'));
    await initRepo(plain);
    await assert.rejects(create(fresh, { primaryRepo: plain, inPlace: [plain] }), { code: 'ERR_FOLDER_IN_USE' });
    await fresh.sa.stopJob('jg');
    const job = await create(fresh, { primaryRepo: plain, inPlace: [plain] });
    assert.equal(job.state, 'running');
    await fresh.sa.stop();
  } finally { registry._reset(); }
});
