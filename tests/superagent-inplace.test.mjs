import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, initRepo, sessionFactory, jobCreated, deferred, missingTranscripts, T0 } from './superagent-helpers.mjs';
import { MILESTONE_2_PIPELINE } from '../src/superagent/config.js';

process.env.COCKPIT_HOME = await tempDir('sa-inplace-home-');

const registry = await import('../src/session-registry.js');
const { createSuperagentStore } = await import('../src/superagent/store.js');
const { createSuperagentConfig } = await import('../src/superagent/config.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { workflowsDir } = await import('../src/superagent/workflows.js');
const { addLedgerExclude, checkGate, checkInPlace, normaliseTop } = await import('../src/superagent/inplace.js');
const { defaultGit } = await import('../src/superagent/worktree.js');

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

async function harness({ git, platform = process.platform, worktreesRoot: worktreesOverride, budgetCheck } = {}) {
  registry._reset();
  const root = await tempDir('sa-inplace-');
  const repo = path.join(root, 'repo');
  const baseSha = await initRepo(repo);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, '{}');
  const jobsRoot = path.join(root, 'jobs');
  const worktreesRoot = worktreesOverride ?? path.join(root, 'worktrees');
  let n = 0;
  const logs = [];

  async function build({ router = null, now = () => T0 } = {}) {
    const store = createSuperagentStore({ rootDir: jobsRoot, now: () => T0, logImpl: quiet });
    const config = createSuperagentConfig({ filePath: configFile });
    await config.load();
    const factory = sessionFactory(registry);
    const sa = createSuperagent({
      registry: factory.registry,
      store,
      config,
      worktreesRoot,
      now,
      idImpl: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      stopTickDeadlineMs: 20,
      logImpl: (line) => logs.push(line),
      platform,
      ...(git && { git }),
      ...(budgetCheck && { budgetCheck }),
      router,
      workflowDirs: { builtin: workflowsDir(), global: path.join(root, 'workflows') },
      transcripts: missingTranscripts(),
    });
    const events = (jobId) => readFileSync(path.join(jobsRoot, jobId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return {
      root, repo, baseSha, jobsRoot, worktreesRoot, store, sa, events, logs, factory,
      nextSlug: () => `add-hello-${String(n + 1).padStart(8, '0')}`,
      async restart(opts) {
        registry._reset();
        return build(opts);
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

test('checkInPlace ignores ignored files and reports pending changes, keeping at most 200 paths', async () => {
  const root = await tempDir('sa-inplace-direct-');
  const repo = path.join(root, 'repo');
  const head = await initRepo(repo);
  await fs.mkdir(path.join(repo, '.claude'));
  await fs.writeFile(path.join(repo, '.claude', 'settings.local.json'), '{}');
  const ok = await checkInPlace({ folder: repo, branch: 'superagent/x-1' });
  assert.equal(ok.head, head);
  assert.equal(normaliseTop(ok.toplevel, 'win32'), normaliseTop(gitIn(repo, 'rev-parse', '--show-toplevel'), 'win32'));
  assert.deepEqual(ok.pending, { paths: [], total: 0 });

  await fs.writeFile(path.join(repo, 'README.md'), '# edited\n');
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'mine\n');
  assert.deepEqual((await checkInPlace({ folder: repo, branch: 'superagent/x-1' })).pending, { paths: ['README.md', 'untracked.txt'], total: 2 });

  await fs.mkdir(path.join(repo, 'many'));
  for (let i = 0; i < 205; i++) await fs.writeFile(path.join(repo, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x');
  const { pending } = await checkInPlace({ folder: repo, branch: 'superagent/x-1' });
  assert.equal(pending.total, 207);
  assert.equal(pending.paths.length, 200);
});

test('a folder with pending changes is switched in place and keeps them', async () => {
  try {
    const h = await harness();
    await fs.writeFile(path.join(h.repo, 'README.md'), '# mine, not committed\n');
    await fs.writeFile(path.join(h.repo, 'notes.txt'), 'untracked\n');
    const before = gitIn(h.repo, 'status', '--porcelain', '--untracked-files=all');
    const job = await create(h, { inPlace: [h.repo] });
    assert.equal(job.state, 'running');
    assert.equal(gitIn(h.repo, 'symbolic-ref', '--short', 'HEAD'), job.branch);
    assert.equal(gitIn(h.repo, 'rev-parse', 'HEAD'), h.baseSha);
    assert.equal(gitIn(h.repo, 'status', '--porcelain', '--untracked-files=all'), before);
    assert.equal(readFileSync(path.join(h.repo, 'README.md'), 'utf8'), '# mine, not committed\n');
    const pendingChanges = { paths: ['README.md', 'notes.txt'], total: 2 };
    assert.deepEqual(h.events(job.jobId)[0].repos[0].pendingChanges, pendingChanges);
    assert.deepEqual(job.repos[0].pendingChanges, pendingChanges);
    await h.sa.stop();
  } finally { registry._reset(); }
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
    gitIn(h.repo, 'switch', '-q', '-');
    const again = await create(h, { inPlace: [h.repo] });
    assert.equal(again.state, 'running');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a refused createJob releases its reservation at once', async () => {
  try {
    const h = await harness();
    const own = gitIn(h.repo, 'symbolic-ref', '--short', 'HEAD');
    gitIn(h.repo, 'checkout', '-q', '--detach');
    await assert.rejects(create(h, { inPlace: [h.repo] }), { code: 'ERR_FOLDER_BUSY_GIT' });
    gitIn(h.repo, 'switch', '-q', own);
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

const currentBranch = (folder) => gitIn(folder, 'symbolic-ref', '--short', 'HEAD');
const excludeFile = (folder) => path.resolve(folder, gitIn(folder, 'rev-parse', '--git-path', 'info/exclude'));

function gitIgnoreFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter((rel) => path.basename(String(rel)) === '.gitignore');
}

test('a clean folder is switched in place', async () => {
  try {
    const h = await harness();
    const rootIgnore = readFileSync(path.join(h.repo, '.gitignore'), 'utf8');
    const job = await create(h, { inPlace: [h.repo] });
    assert.equal(job.state, 'running');
    const [repo] = job.repos;
    assert.equal(norm(repo.worktree), norm(h.repo));
    assert.equal(repo.worktree, repo.toplevel);
    assert.equal(repo.baseSha, h.baseSha);
    assert.equal(repo.settingsCopy, 'in-place');
    const created = h.events(job.jobId).find((e) => e.type === 'worktree-created');
    assert.equal(created.inPlace, true);
    assert.equal(created.settingsCopy, 'in-place');

    assert.equal(gitIn(h.repo, 'rev-parse', 'HEAD'), h.baseSha);
    assert.equal(currentBranch(h.repo), job.branch);
    assert.match(job.branch, /^superagent\/add-hello-/);
    assert.equal(existsSync(h.worktreesRoot), false);

    const ledger = path.join(h.repo, '.superpowers', 'superagent', job.jobId);
    assert.ok(existsSync(ledger));
    assert.deepEqual(gitIgnoreFilesUnder(path.join(h.repo, '.superpowers')), []);
    assert.equal(readFileSync(path.join(h.repo, '.gitignore'), 'utf8'), rootIgnore);
    await fs.writeFile(path.join(ledger, 'note.txt'), 'ledger\n');
    assert.equal(gitIn(h.repo, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.ok(readFileSync(excludeFile(h.repo), 'utf8').endsWith(`\n/.superpowers/superagent/${job.jobId}/\n`));
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a worktree job from a folder left on a job branch is refused until it is switched back', async () => {
  try {
    const h = await harness();
    const own = currentBranch(h.repo);
    const first = await create(h, { inPlace: [h.repo] });
    assert.equal((await h.sa.stopJob(first.jobId)).state, 'stopped');
    assert.equal(currentBranch(h.repo), first.branch);
    const jobDirs = await fs.readdir(h.jobsRoot);
    const branches = gitIn(h.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads');

    await assert.rejects(create(h), (err) => {
      assert.equal(err.code, 'ERR_FOLDER_ON_JOB_BRANCH');
      assert.match(err.message, new RegExp(`is on ${first.branch}; switch this folder back to your own branch first`));
      return true;
    });
    assert.deepEqual(await fs.readdir(h.jobsRoot), jobDirs);
    assert.equal(gitIn(h.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads'), branches);
    assert.equal(existsSync(h.worktreesRoot), false);
    assert.equal(h.sa.listJobs().length, 1);

    gitIn(h.repo, 'switch', '-q', own);
    const job = await create(h);
    assert.equal(job.state, 'running');
    assert.equal(job.repos[0].baseSha, h.baseSha);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an exclude file without a final newline keeps its last line', async () => {
  const root = await tempDir('sa-inplace-exclude-');
  const repo = path.join(root, 'repo');
  await initRepo(repo);
  const file = excludeFile(repo);
  await fs.writeFile(file, '# mine\n*.log');
  await addLedgerExclude({ folder: repo, jobId: 'j1' });
  assert.equal(readFileSync(file, 'utf8'), '# mine\n*.log\n/.superpowers/superagent/j1/\n');
  await addLedgerExclude({ folder: repo, jobId: 'j1' });
  assert.equal(readFileSync(file, 'utf8'), '# mine\n*.log\n/.superpowers/superagent/j1/\n');

  await fs.rm(path.dirname(file), { recursive: true, force: true });
  await addLedgerExclude({ folder: repo, jobId: 'j2' });
  assert.equal(readFileSync(file, 'utf8'), '/.superpowers/superagent/j2/\n');
});

test('the exclude rule of a linked worktree lands in the shared exclude file', async () => {
  const root = await tempDir('sa-inplace-linked-');
  const repo = path.join(root, 'repo');
  await initRepo(repo);
  const linked = path.join(root, 'linked');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'mine', linked);
  await addLedgerExclude({ folder: linked, jobId: 'j1' });
  assert.equal(norm(excludeFile(linked)), norm(path.join(repo, '.git', 'info', 'exclude')));
  assert.ok(readFileSync(excludeFile(linked), 'utf8').endsWith('/.superpowers/superagent/j1/\n'));
  assert.equal(tryGit(linked, 'check-ignore', '-q', '.superpowers/superagent/j1/probe'), '');
});

test('a nested negation makes provisioning fail before any launch', async () => {
  try {
    const h = await harness();
    await fs.mkdir(path.join(h.repo, '.superpowers', 'superagent'), { recursive: true });
    await fs.writeFile(path.join(h.repo, '.superpowers', 'superagent', '.gitignore'), '!*\n');
    gitIn(h.repo, 'add', '.superpowers/superagent/.gitignore');
    gitIn(h.repo, 'commit', '-q', '-m', 'track a negation');
    const job = await create(h, { inPlace: [h.repo] });
    assert.equal(job.state, 'failed');
    assert.match(job.detail.error, /not ignored/);
    assert.equal(currentBranch(h.repo), job.branch);
    assert.equal(h.events(job.jobId).some((e) => e.type === 'worktree-created'), false);
    await h.sa.tick();
    assert.equal(h.factory.calls.length, 0);
    assert.equal(registry.list().length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('the folder changed between checks and switch', async () => {
  try {
    const calls = [];
    let committed = false;
    // show-ref is the last admission check; the commit lands before provisioning.
    const git = async (args, opts) => {
      calls.push(args);
      const res = await defaultGit(args, opts);
      if (!committed && args[0] === 'show-ref') {
        committed = true;
        gitIn(opts.cwd, 'commit', '-q', '--allow-empty', '-m', 'meanwhile');
      }
      return res;
    };
    const h = await harness({ git });
    const branchBefore = currentBranch(h.repo);
    const job = await create(h, { inPlace: [h.repo] });
    assert.ok(committed);
    assert.equal(job.state, 'failed');
    assert.match(job.detail.error, /changed since the job was created/);
    assert.equal(calls.some((args) => args[0] === 'switch'), false);
    assert.equal(tryGit(h.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${job.branch}`), null);
    assert.equal(currentBranch(h.repo), branchBefore);
    assert.equal(existsSync(path.join(h.repo, '.superpowers')), false);
    assert.equal(h.factory.calls.length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('orphan listing skips in-place repos', async () => {
  try {
    const listed = [];
    const git = (args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'list') listed.push(norm(opts.cwd));
      return defaultGit(args, opts);
    };
    const h = await harness({ git });
    const lib = path.join(h.root, 'lib');
    await initRepo(lib);
    gitIn(lib, 'worktree', 'add', '-q', '-b', 'superagent/stray-lib', path.join(h.root, 'stray-lib'));
    gitIn(h.repo, 'worktree', 'add', '-q', '-b', 'superagent/stray-repo', path.join(h.root, 'stray-repo'));
    const job = await create(h, { additionalRepos: [lib], inPlace: [h.repo] });
    assert.equal(job.state, 'running');
    const orphans = await h.sa.orphanWorktrees();
    assert.deepEqual(listed, [norm(lib)]);
    assert.deepEqual(orphans.map((o) => o.branch), ['superagent/stray-lib']);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('the path-length check measures from the in-place folder', async () => {
  try {
    const probe = await harness();
    const longRoot = path.join(probe.root, 'x'.repeat(200), 'worktrees');
    const h = await harness({ platform: 'win32', worktreesRoot: longRoot });
    await assert.rejects(create(h), { code: 'ERR_PATH_TOO_LONG' });
    const job = await create(h, { inPlace: [h.repo] });
    assert.equal(job.state, 'running');
    assert.match(job.slug, /^add-hello-/);

    const deep = path.join(h.root, 'y'.repeat(220));
    await assert.rejects(create(h, { primaryRepo: deep, inPlace: [deep] }), (err) => {
      assert.equal(err.code, 'ERR_PATH_TOO_LONG');
      assert.ok(err.length > 259);
      assert.match(err.message, /shorter path/);
      assert.doesNotMatch(err.message, /COCKPIT_HOME/);
      return true;
    });
    await h.sa.stop();
  } finally { registry._reset(); }
});

const lastEvent = (h, jobId) => h.events(jobId).at(-1);
const pausedText = (from, branch) => `this folder is on ${from}; switch it back to ${branch} to continue`;

test('checkGate passes on the job branch and names what it found otherwise', async () => {
  const root = await tempDir('sa-inplace-gate-');
  const repo = path.join(root, 'repo');
  const baseSha = await initRepo(repo);
  const own = currentBranch(repo);
  const branch = 'superagent/x-1';
  gitIn(repo, 'switch', '-q', '-c', branch);
  assert.deepEqual(await checkGate({ folder: repo, branch, baseSha }), { ok: true });

  await fs.writeFile(path.join(repo, 'README.md'), '# edited\n');
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'mine\n');
  assert.deepEqual(await checkGate({ folder: repo, branch, baseSha }), { ok: true });
  gitIn(repo, 'checkout', '-q', '--', 'README.md');
  await fs.rm(path.join(repo, 'untracked.txt'));

  gitIn(repo, 'switch', '-q', own);
  assert.deepEqual(await checkGate({ folder: repo, branch, baseSha }), { ok: false, text: pausedText(own, branch) });
  gitIn(repo, 'checkout', '-q', '--detach', branch);
  assert.deepEqual(await checkGate({ folder: repo, branch, baseSha }), { ok: false, text: `this folder has a detached HEAD; switch it back to ${branch} to continue` });

  gitIn(repo, 'switch', '-q', own);
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
  const elsewhere = gitIn(repo, 'rev-parse', 'HEAD');
  gitIn(repo, 'switch', '-q', branch);
  assert.deepEqual(await checkGate({ folder: repo, branch, baseSha: elsewhere }), {
    ok: false,
    text: `${branch} no longer contains the commit the job started from (${elsewhere}); restore it to continue`,
  });

  await conflictingMerge(repo);
  assert.deepEqual(await checkGate({ folder: repo, branch, baseSha }), { ok: false, text: 'this folder has a git operation in progress (MERGE_HEAD); finish or abort it to continue' });

  const gone = await checkGate({ folder: path.join(root, 'missing'), branch, baseSha });
  assert.equal(gone.ok, false);
  assert.match(gone.text, /^could not check this folder: /);
});

test('the safety gate pauses and resumes', async () => {
  try {
    let budgetCalls = 0;
    const h = await harness({ budgetCheck: () => { budgetCalls++; return { allow: true }; } });
    const own = currentBranch(h.repo);
    const job = await create(h, { inPlace: [h.repo] });
    gitIn(h.repo, 'switch', '-q', own);
    await h.sa.tick();
    assert.equal(h.factory.calls.length, 0);
    assert.equal(budgetCalls, 0);
    const paused = h.sa.getJob(job.jobId);
    assert.deepEqual([paused.state, paused.reason], ['needs-you', 'folder-changed']);
    assert.deepEqual(paused.detail, { why: 'folder-changed', text: pausedText(own, job.branch), folder: job.repos[0].worktree });
    assert.deepEqual(paused.attempts, []);
    await assert.rejects(h.sa.answerQuestion(job.jobId, 'switched', { needsYouSeq: paused.needsYouSeq }), { code: 'ERR_INVALID_STATE' });
    await assert.rejects(h.sa.accept(job.jobId, { needsYouSeq: paused.needsYouSeq }), { code: 'ERR_INVALID_STATE' });
    const count = h.events(job.jobId).length;
    await h.sa.tick();
    assert.equal(h.events(job.jobId).length, count);
    assert.equal(currentBranch(h.repo), own);

    gitIn(h.repo, 'switch', '-q', job.branch);
    await h.sa.tick();
    assert.equal(lastEvent(h, job.jobId).type, 'folder-restored');
    assert.equal(h.sa.getJob(job.jobId).state, 'running');
    assert.equal(h.factory.calls.length, 0);

    gitIn(h.repo, 'switch', '-q', own);
    await h.sa.tick();
    const again = h.sa.getJob(job.jobId);
    assert.equal(again.reason, 'folder-changed');
    assert.notEqual(again.needsYouSeq, paused.needsYouSeq);
    gitIn(h.repo, 'switch', '-q', job.branch);
    await h.sa.tick();
    await h.sa.tick();
    assert.equal(h.factory.calls.length, 1);
    assert.equal(budgetCalls, 1);
    assert.equal(h.sa.getJob(job.jobId).attempts.length, 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a branch switch during a pending budget check still blocks the launch', async () => {
  try {
    const called = deferred();
    const pending = deferred();
    let first = true;
    const budgetCheck = () => {
      if (!first) return { allow: true };
      first = false;
      called.resolve();
      return pending.promise;
    };
    const h = await harness({ budgetCheck });
    const own = currentBranch(h.repo);
    const job = await create(h, { inPlace: [h.repo] });
    const ticking = h.sa.tick();
    await called.promise;
    gitIn(h.repo, 'switch', '-q', own);
    pending.resolve({ allow: true });
    await ticking;

    assert.equal(h.factory.calls.length, 0);
    assert.equal(registry.list().length, 0);
    const paused = h.sa.getJob(job.jobId);
    assert.deepEqual([paused.state, paused.reason, paused.detail.text], ['needs-you', 'folder-changed', pausedText(own, job.branch)]);
    const [gated] = paused.attempts;
    assert.deepEqual([gated.n, gated.outcome, gated.reason, gated.sessionId], [1, 'failed', 'folder-changed', null]);

    gitIn(h.repo, 'switch', '-q', job.branch);
    await h.sa.tick();
    await h.sa.tick();
    assert.equal(h.factory.calls.length, 1);
    const [, launched] = h.sa.getJob(job.jobId).attempts;
    assert.deepEqual([launched.n, launched.recovery, launched.previousAttemptId, launched.outcome], [1, false, null, null]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a paused folder that comes back in a different bad state refreshes the pause text once', async () => {
  try {
    const h = await harness();
    const own = currentBranch(h.repo);
    const job = await create(h, { inPlace: [h.repo] });
    gitIn(h.repo, 'switch', '-q', own);
    await h.sa.tick();
    const first = h.sa.getJob(job.jobId);
    assert.equal(first.detail.text, pausedText(own, job.branch));

    gitIn(h.repo, 'switch', '-q', job.branch);
    await conflictingMerge(h.repo);
    await h.sa.tick();
    const second = h.sa.getJob(job.jobId);
    assert.deepEqual([second.state, second.reason], ['needs-you', 'folder-changed']);
    assert.deepEqual(second.detail, { why: 'folder-changed', text: 'this folder has a git operation in progress (MERGE_HEAD); finish or abort it to continue', folder: job.repos[0].worktree });
    assert.notEqual(second.needsYouSeq, first.needsYouSeq);

    const count = h.events(job.jobId).length;
    await h.sa.tick();
    assert.equal(h.events(job.jobId).length, count);

    gitIn(h.repo, 'merge', '--abort');
    await h.sa.tick();
    assert.equal(lastEvent(h, job.jobId).type, 'folder-restored');
    assert.equal(h.events(job.jobId).filter((e) => e.type === 'needs-you').length, 2);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a stop during a pending restoration check appends no folder-restored', async () => {
  try {
    let hold = null;
    const git = async (args, opts) => {
      if (hold && args[0] === 'rev-parse' && args[1] === '--git-dir') {
        const held = hold;
        hold = null;
        held.reached.resolve();
        await held.release.promise;
      }
      return defaultGit(args, opts);
    };
    const h = await harness({ git });
    const own = currentBranch(h.repo);
    const job = await create(h, { inPlace: [h.repo] });
    gitIn(h.repo, 'switch', '-q', own);
    await h.sa.tick();
    assert.equal(h.sa.getJob(job.jobId).reason, 'folder-changed');
    gitIn(h.repo, 'switch', '-q', job.branch);

    hold = { reached: deferred(), release: deferred() };
    const { reached, release } = hold;
    const ticking = h.sa.tick();
    await reached.promise;
    const stopping = h.sa.stopJob(job.jobId);
    release.resolve();
    await ticking;
    assert.equal((await stopping).state, 'stopped');
    assert.equal(h.events(job.jobId).some((e) => e.type === 'folder-restored'), false);
    assert.equal(h.factory.calls.length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('uncommitted changes alone do not trip the gate', async () => {
  try {
    const h = await harness();
    const job = await create(h, { inPlace: [h.repo] });
    await fs.writeFile(path.join(h.repo, 'README.md'), '# left by an interrupted worker\n');
    await fs.writeFile(path.join(h.repo, 'scratch.txt'), 'untracked\n');
    await h.sa.tick();
    assert.equal(h.factory.calls.length, 1);
    assert.equal(h.sa.getJob(job.jobId).state, 'running');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('the gate runs after a restart', async () => {
  try {
    const h = await harness();
    const own = currentBranch(h.repo);
    const job = await create(h, { inPlace: [h.repo] });
    await h.sa.stop();
    gitIn(h.repo, 'switch', '-q', own);

    const fresh = await h.restart();
    await fresh.sa.start();
    await fresh.sa.tick();
    assert.equal(fresh.factory.calls.length, 0);
    const paused = fresh.sa.getJob(job.jobId);
    assert.deepEqual([paused.state, paused.reason, paused.detail.text], ['needs-you', 'folder-changed', pausedText(own, job.branch)]);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('the gate holds the task list read of a folder that changed', async () => {
  try {
    const h = await harness();
    const own = currentBranch(h.repo);
    const toplevel = path.resolve(gitIn(h.repo, 'rev-parse', '--show-toplevel'));
    const branch = 'superagent/t-jt';
    gitIn(h.repo, 'branch', branch);
    const repos = [{ id: 'primary', origin: h.repo, inPlace: true, toplevel, admittedHead: h.baseSha }];
    await h.store.append('jt', jobCreated({ jobId: 'jt', slug: 't-jt', branch, repos, pipeline: MILESTONE_2_PIPELINE }));
    await h.store.append('jt', { type: 'worktree-created', repo: 'primary', worktree: toplevel, branch, baseSha: h.baseSha, settingsCopy: 'in-place', inPlace: true });
    await h.store.append('jt', { type: 'job-provisioned' });
    for (const phase of ['spec', 'spec-review', 'plan', 'plan-review']) await h.store.append('jt', { type: 'phase-completed', phase, visit: 1, unresolved: [], verification: null });

    const fresh = await h.restart();
    await fresh.sa.start();
    await fresh.sa.tick();
    const paused = fresh.sa.getJob('jt');
    assert.deepEqual([paused.state, paused.reason, paused.detail.text], ['needs-you', 'folder-changed', pausedText(own, branch)]);
    assert.equal(paused.tasks, null);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('a gated attempt after a routed failure does not stall the route', async () => {
  try {
    const h = await harness();
    const toplevel = path.resolve(gitIn(h.repo, 'rev-parse', '--show-toplevel'));
    const branch = 'superagent/r-jg';
    gitIn(h.repo, 'switch', '-q', '-c', branch);
    const repos = [{ id: 'primary', origin: h.repo, inPlace: true, toplevel, admittedHead: h.baseSha }];
    await h.store.append('jg', jobCreated({ jobId: 'jg', slug: 'r-jg', branch, repos }));
    await h.store.append('jg', { type: 'worktree-created', repo: 'primary', worktree: toplevel, branch, baseSha: h.baseSha, settingsCopy: 'in-place', inPlace: true });
    await h.store.append('jg', { type: 'job-provisioned' });
    const started = (attemptId, n) => ({ type: 'attempt-started', attemptId, phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', n });
    await h.store.append('jg', started('x1', 1));
    await h.store.append('jg', { type: 'attempt-ended', attemptId: 'x1', outcome: 'failed', reason: 'no-result', signature: 'no-result|' });
    await h.store.append('jg', started('g1', 2));
    await h.store.append('jg', { type: 'attempt-ended', attemptId: 'g1', outcome: 'failed', reason: 'folder-changed', signature: 'folder-changed|moved' });

    const requests = [];
    const router = {
      decide(req) {
        requests.push(req);
        return Promise.resolve({ ok: true, action: 'escalate', note: 'enough', usage: null, latencyMs: 1 });
      },
    };
    const fresh = await h.restart({ router, now: () => T0 + 10 * 60_000 });
    await fresh.sa.start();
    await fresh.sa.tick();
    await fresh.sa.drain();
    assert.equal(requests.length, 1);
    const decided = fresh.events('jg').filter((e) => e.type === 'router-decided');
    assert.deepEqual(decided.map((d) => [d.forAttemptId, d.action]), [['x1', 'escalate']]);
    await fresh.sa.tick();
    const job = fresh.sa.getJob('jg');
    assert.deepEqual([job.state, job.reason, job.detail.why], ['needs-you', 'stuck', 'router-escalated']);
    assert.equal(fresh.factory.calls.length, 0);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

const branchThere = (folder, branch) => tryGit(folder, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) != null;

test('accept renames an in-place job branch the folder is on', async () => {
  try {
    const h = await harness();
    const job = await create(h, { inPlace: [h.repo] });
    await h.store.append(job.jobId, { type: 'needs-you', reason: 'ready-to-try', detail: null });
    const accepted = await h.sa.accept(job.jobId, { needsYouSeq: h.store.get(job.jobId).needsYouSeq, branch: 'bugfix/1-x' });
    assert.deepEqual([accepted.state, accepted.finalBranch], ['done', 'bugfix/1-x']);
    assert.equal(currentBranch(h.repo), 'bugfix/1-x');
    assert.equal(branchThere(h.repo, job.branch), false);
    assert.deepEqual(h.events(job.jobId).slice(-2).map((e) => e.type), ['branch-renamed', 'job-accepted']);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('accept renames by name, not the current branch', async () => {
  try {
    const h = await harness();
    const own = currentBranch(h.repo);
    const job = await create(h, { inPlace: [h.repo] });
    await h.store.append(job.jobId, { type: 'needs-you', reason: 'ready-to-try', detail: null });
    gitIn(h.repo, 'switch', '-q', own);
    const accepted = await h.sa.accept(job.jobId, { needsYouSeq: h.store.get(job.jobId).needsYouSeq, branch: 'bugfix/1-x' });
    assert.deepEqual([accepted.state, accepted.finalBranch], ['done', 'bugfix/1-x']);
    assert.ok(branchThere(h.repo, 'bugfix/1-x'));
    assert.equal(branchThere(h.repo, job.branch), false);
    assert.ok(branchThere(h.repo, own));
    assert.equal(currentBranch(h.repo), own);
    await h.sa.stop();
  } finally { registry._reset(); }
});
