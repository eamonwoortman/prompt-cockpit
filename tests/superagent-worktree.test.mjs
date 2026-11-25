import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tempDir, initRepo } from './superagent-helpers.mjs';
import { slugify, repoIds, checkRepo, repoToplevel, createWorktree, inspectWorktree, archiveLedger, listOrphanWorktrees, defaultGit, createGit, removeAbortedWorktree, ensureRepo } from '../src/superagent/worktree.js';

const norm = (p) => realpathSync.native(path.resolve(p)).toLowerCase();
const SETTINGS = '{"permissions":{"allow":["Bash(npm test)"]}}';

async function setup(opts) {
  const root = await tempDir('sa-wt-');
  const origin = path.join(root, 'origin');
  const sha = await initRepo(origin, opts);
  return { root, origin, sha };
}

test('slugify caps the title base at 40 by default and at maxBase when given, trimming trailing hyphens after the cap', () => {
  const title = 'Add a hello endpoint and wire it into the router with tests';
  assert.equal(slugify(title, '12345678-aaaa'), 'add-a-hello-endpoint-and-wire-it-into-th-12345678');
  assert.equal(slugify(title, '12345678-aaaa', 40), slugify(title, '12345678-aaaa'));
  assert.equal(slugify(title, '12345678-aaaa', 12), 'add-a-hello-12345678', 'the cap lands after "hello-" and the hyphen is trimmed');
  assert.equal(slugify(title, '12345678-aaaa', 8), 'add-a-he-12345678');
  assert.equal(slugify('Add hello!', '12345678-aaaa', 12), 'add-hello-12345678');
});

test('createWorktree makes branch superagent/<slug> from HEAD and records the base', async () => {
  const { root, origin, sha } = await setup();
  const branch = `superagent/${slugify('Add hello!', '12345678-aaaa')}`;
  assert.equal(slugify('Add hello!', '12345678-aaaa'), 'add-hello-12345678');
  assert.equal(slugify('', 'abcdefgh-1'), 'job-abcdefgh');
  assert.deepEqual(repoIds('/a/app', ['/b/lib', '/c/lib']).map((r) => r.id), ['primary', 'lib', 'lib-2']);
  const worktree = path.join(root, 'wt');
  const res = await createWorktree({ origin, worktree, branch, copyLocalClaudeSettings: true });
  assert.equal(res.baseSha, sha);
  const info = await inspectWorktree({ worktree });
  assert.deepEqual(info, { exists: true, head: sha, branch: 'superagent/add-hello-12345678', dirty: false });
});

test('createWorktree refuses a non-repo, an unborn repo and an existing branch', async () => {
  const root = await tempDir('sa-wt-');
  await assert.rejects(createWorktree({ origin: root, worktree: path.join(root, 'w'), branch: 'superagent/x', copyLocalClaudeSettings: false }), { code: 'ERR_NOT_GIT_REPO' });
  const unborn = path.join(root, 'unborn');
  await fs.mkdir(unborn);
  execFileSync('git', ['init', '-q'], { cwd: unborn });
  await assert.rejects(createWorktree({ origin: unborn, worktree: path.join(root, 'w2'), branch: 'superagent/x', copyLocalClaudeSettings: false }), { code: 'ERR_NO_COMMITS' });
  const { root: r2, origin } = await setup();
  const w1 = path.join(r2, 'w1');
  await createWorktree({ origin, worktree: w1, branch: 'superagent/x', copyLocalClaudeSettings: false });
  await assert.rejects(createWorktree({ origin, worktree: path.join(r2, 'w2'), branch: 'superagent/x', copyLocalClaudeSettings: false }), { code: 'ERR_BRANCH_EXISTS' });
  await assert.rejects(createWorktree({ origin, worktree: w1, branch: 'superagent/y', copyLocalClaudeSettings: false }), { code: 'ERR_WORKTREE_PATH_EXISTS' });
  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: origin, encoding: 'utf8' }).toLowerCase();
  assert.ok(list.includes(path.basename(w1)));
});

test('local settings are copied only when the repo ignores them; the original is untouched', async () => {
  const src = async (origin) => {
    await fs.mkdir(path.join(origin, '.claude'), { recursive: true });
    const p = path.join(origin, '.claude', 'settings.local.json');
    await fs.writeFile(p, SETTINGS);
    return p;
  };
  const a = await setup();
  const srcPath = await src(a.origin);
  const before = await fs.stat(srcPath);
  const wa = path.join(a.root, 'wt');
  const res = await createWorktree({ origin: a.origin, worktree: wa, branch: 'superagent/a', copyLocalClaudeSettings: true });
  assert.equal(res.settingsCopy, 'copied');
  assert.equal(await fs.readFile(path.join(wa, '.claude', 'settings.local.json'), 'utf8'), SETTINGS);
  const after = await fs.stat(srcPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(srcPath, 'utf8'), SETTINGS);

  const b = await setup({ ignoreLocalSettings: false });
  await src(b.origin);
  const wb = path.join(b.root, 'wt');
  const rb = await createWorktree({ origin: b.origin, worktree: wb, branch: 'superagent/b', copyLocalClaudeSettings: true });
  assert.equal(rb.settingsCopy, 'skipped-not-ignored');
  await assert.rejects(fs.access(path.join(wb, '.claude', 'settings.local.json')));

  const c = await setup();
  await src(c.origin);
  const rc = await createWorktree({ origin: c.origin, worktree: path.join(c.root, 'wt'), branch: 'superagent/c', copyLocalClaudeSettings: false });
  assert.equal(rc.settingsCopy, 'disabled');

  const d = await setup();
  const rd = await createWorktree({ origin: d.origin, worktree: path.join(d.root, 'wt'), branch: 'superagent/d', copyLocalClaudeSettings: true });
  assert.equal(rd.settingsCopy, 'absent');
});

test('the ledger directory is ignored inside the worktree', async () => {
  const { root, origin } = await setup();
  const wt = path.join(root, 'wt');
  await createWorktree({ origin, worktree: wt, branch: 'superagent/l', copyLocalClaudeSettings: false });
  const f = path.join(wt, '.superpowers', 'superagent', 'j1', 'attempts', 'spec', 'a1', 'result.json');
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, '{}');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }), '');
});

test('inspectWorktree reports dirt and a missing path', async () => {
  const { root, origin } = await setup();
  const wt = path.join(root, 'wt');
  await createWorktree({ origin, worktree: wt, branch: 'superagent/i', copyLocalClaudeSettings: false });
  await fs.writeFile(path.join(wt, 'x.txt'), 'x');
  assert.equal((await inspectWorktree({ worktree: wt })).dirty, true);
  assert.deepEqual(await inspectWorktree({ worktree: path.join(root, 'nope') }), { exists: false, head: null, branch: null, dirty: false });
});

test('archiveLedger copies the job ledger and leaves the worktree intact', async () => {
  const { root, origin } = await setup();
  const wt = path.join(root, 'wt');
  await createWorktree({ origin, worktree: wt, branch: 'superagent/ar', copyLocalClaudeSettings: false });
  const f = path.join(wt, '.superpowers', 'superagent', 'j1', 'attempts', 'spec', 'a1', 'result.json');
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, '{"ok":true}');
  const destDir = path.join(root, 'archive');
  assert.deepEqual(await archiveLedger({ worktree: wt, jobId: 'j1', destDir }), { copied: true });
  assert.equal(await fs.readFile(path.join(destDir, 'attempts', 'spec', 'a1', 'result.json'), 'utf8'), '{"ok":true}');
  await fs.access(f);
  assert.deepEqual(await archiveLedger({ worktree: wt, jobId: 'j2', destDir: path.join(root, 'none') }), { copied: false });
});

test('listOrphanWorktrees lists superagent worktrees no job knows and removes nothing', async () => {
  const { root, origin } = await setup();
  const wa = path.join(root, 'wa');
  const wb = path.join(root, 'wb');
  const wo = path.join(root, 'wo');
  await createWorktree({ origin, worktree: wa, branch: 'superagent/a-11111111', copyLocalClaudeSettings: false });
  await createWorktree({ origin, worktree: wb, branch: 'superagent/b-22222222', copyLocalClaudeSettings: false });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/other', wo, 'HEAD'], { cwd: origin });
  const orphans = await listOrphanWorktrees({ repos: [origin], knownBranches: new Set(['superagent/a-11111111']) });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].branch, 'superagent/b-22222222');
  assert.equal(norm(orphans[0].worktree), norm(wb));
  assert.equal(norm(orphans[0].repo), norm(origin));
  for (const d of [wa, wb, wo]) await fs.access(d);
});

test('defaultGit runs git with core.fsmonitor forced off, whatever the repo config says', async () => {
  const { origin } = await setup();
  execFileSync('git', ['config', 'core.fsmonitor', 'true'], { cwd: origin });
  const res = await defaultGit(['config', '--get', 'core.fsmonitor'], { cwd: origin });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'false');
});

test('checkRepo reports each refusal with its code', async () => {
  const root = await tempDir('sa-wt-');
  const plain = path.join(root, 'plain');
  await fs.mkdir(plain);
  const fresh = (name) => ({ worktree: path.join(root, name), branch: `superagent/${name}` });
  await assert.rejects(checkRepo({ origin: plain, ...fresh('a') }), { code: 'ERR_NOT_GIT_REPO' });
  await assert.rejects(repoToplevel({ git: defaultGit, origin: plain }), { code: 'ERR_NOT_GIT_REPO' });
  const unborn = path.join(root, 'unborn');
  await initRepo(unborn, { commit: false });
  await assert.rejects(checkRepo({ origin: unborn, ...fresh('b') }), { code: 'ERR_NO_COMMITS' });
  const { root: r2, origin } = await setup();
  execFileSync('git', ['branch', 'superagent/taken'], { cwd: origin });
  await assert.rejects(checkRepo({ origin, worktree: path.join(r2, 'wt'), branch: 'superagent/taken' }), { code: 'ERR_BRANCH_EXISTS' });
  const occupied = path.join(r2, 'occupied');
  await fs.mkdir(occupied);
  await assert.rejects(checkRepo({ origin, worktree: occupied, branch: 'superagent/free' }), { code: 'ERR_WORKTREE_PATH_EXISTS' });
  const ok = await checkRepo({ origin, worktree: path.join(r2, 'wt'), branch: 'superagent/free' });
  assert.deepEqual(ok, { toplevel: await repoToplevel({ origin }) });
  assert.equal(norm(ok.toplevel), norm(origin));
});

test('ensureRepo inits a plain folder and commits what is in it, honouring .gitignore', async () => {
  const root = await tempDir('sa-wt-');
  const empty = path.join(root, 'empty');
  await fs.mkdir(empty);
  assert.deepEqual(await ensureRepo({ folder: empty }), { initialised: true, committed: true });
  assert.equal(gitOut(empty, 'log', '--format=%s'), 'Initial commit');
  assert.equal(gitOut(empty, 'ls-files'), '');

  const full = path.join(root, 'full');
  await fs.mkdir(path.join(full, 'lib'), { recursive: true });
  await fs.writeFile(path.join(full, 'lib', 'a.txt'), 'a');
  await fs.writeFile(path.join(full, 'secret.env'), 's');
  await fs.writeFile(path.join(full, '.gitignore'), '*.env\n');
  assert.deepEqual(await ensureRepo({ folder: full }), { initialised: true, committed: true });
  assert.deepEqual(gitOut(full, 'ls-files').split('\n').sort(), ['.gitignore', 'lib/a.txt']);
  await checkRepo({ origin: full, worktree: path.join(root, 'wt'), branch: 'superagent/full' });
});

test('ensureRepo commits in a repo with no commits and leaves a repo with commits alone', async () => {
  const root = await tempDir('sa-wt-');
  const unborn = path.join(root, 'unborn');
  await initRepo(unborn, { commit: false });
  assert.deepEqual(await ensureRepo({ folder: unborn }), { initialised: false, committed: true });
  assert.equal(gitOut(unborn, 'config', 'user.name'), 'Test', 'the repo identity is used, not the fallback');
  assert.equal(gitOut(unborn, 'log', '--format=%an'), 'Test');

  const { origin, sha } = await setup();
  assert.deepEqual(await ensureRepo({ folder: origin }), { initialised: false, committed: false });
  assert.equal(gitOut(origin, 'rev-parse', 'HEAD'), sha);
});

test('ensureRepo leaves a folder inside a parent repo with no commits, and a missing folder, alone', async () => {
  const root = await tempDir('sa-wt-');
  const parent = path.join(root, 'parent');
  await initRepo(parent, { commit: false });
  const inner = path.join(parent, 'inner');
  await fs.mkdir(inner);
  assert.deepEqual(await ensureRepo({ folder: inner }), { initialised: false, committed: false });
  assert.throws(() => gitOut(parent, 'rev-parse', '--verify', '--quiet', 'HEAD'));
  await assert.rejects(checkRepo({ origin: inner, worktree: path.join(root, 'wt'), branch: 'superagent/i' }), { code: 'ERR_NO_COMMITS' });
  assert.deepEqual(await ensureRepo({ folder: path.join(root, 'missing') }), { initialised: false, committed: false });
});

test('ensureRepo fills in only the identity git is missing', async () => {
  const root = await tempDir('sa-wt-');
  const folder = path.join(root, 'f');
  await fs.mkdir(folder);
  const calls = [];
  const git = async (args, opts) => {
    calls.push(args);
    if (args[0] === 'config' && args[2] === 'user.name') return { code: 0, stdout: 'Me\n', stderr: '' };
    if (args[0] === 'config' && args[2] === 'user.email') return { code: 1, stdout: '', stderr: '' };
    return defaultGit(args, opts);
  };
  await ensureRepo({ git, folder });
  const commit = calls.find((a) => a.includes('commit'));
  assert.deepEqual(commit.slice(0, commit.indexOf('commit')), ['-c', 'user.email=superagent@localhost']);
});

const gitOut = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasBranch = (cwd, branch) => {
  try {
    gitOut(cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};
const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

test('git: an abort while git runs kills the process tree of its pid and settles as aborted', async () => {
  const killed = [];
  let finish;
  const execFileImpl = (file, args, opts, cb) => {
    finish = cb;
    return { pid: 4242, kill: () => assert.fail('child.kill is only the fallback') };
  };
  const git = createGit({
    execFileImpl,
    killTree: (pid) => {
      killed.push(pid);
      finish(Object.assign(new Error('killed'), { code: 1 }), '', '');
      return true;
    },
  });
  const controller = new AbortController();
  const running = git(['worktree', 'add', '-b', 'b', 'wt', 'HEAD'], { cwd: '/repo', signal: controller.signal });
  controller.abort();
  assert.deepEqual(killed, [4242]);
  const res = await running;
  assert.equal(res.aborted, true);
  assert.notEqual(res.code, 0);
});

test('git: a failed tree kill falls back to killing the child itself', async () => {
  let finish;
  const kills = [];
  const git = createGit({
    execFileImpl: (file, args, opts, cb) => {
      finish = cb;
      return { pid: 7, kill: (sig) => { kills.push(sig); finish(Object.assign(new Error('killed'), { code: null, signal: sig }), '', ''); } };
    },
    killTree: () => false,
  });
  const controller = new AbortController();
  const running = git(['status'], { cwd: '/repo', signal: controller.signal });
  controller.abort();
  const res = await running;
  assert.deepEqual(kills, ['SIGKILL']);
  assert.equal(res.aborted, true);
  assert.notEqual(res.code, 0);
});

test('git: an already-aborted signal starts no process; defaultGit settles as aborted', async () => {
  let spawned = 0;
  const git = createGit({ execFileImpl: () => { spawned += 1; return { pid: 1 }; }, killTree: () => assert.fail('nothing to kill') });
  const res = await git(['status'], { cwd: '/repo', signal: AbortSignal.abort() });
  assert.equal(spawned, 0);
  assert.equal(res.aborted, true);
  assert.notEqual(res.code, 0);

  const { origin } = await setup();
  const real = await defaultGit(['status'], { cwd: origin, signal: AbortSignal.abort() });
  assert.equal(real.aborted, true);
  assert.notEqual(real.code, 0);
});

test('git: an abort kills a real hanging git and no process is left running', async () => {
  const { origin } = await setup();
  const pids = [];
  const git = createGit({ execFileImpl: (...a) => { const child = execFile(...a); pids.push(child.pid); return child; } });
  const controller = new AbortController();
  // hash-object --stdin waits on a stdin execFile never closes.
  const running = git(['hash-object', '--stdin'], { cwd: origin, signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!isRunning(pids[0]) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(isRunning(pids[0]), true);
  controller.abort();
  const res = await running;
  assert.equal(res.aborted, true);
  assert.equal(isRunning(pids[0]), false);
});

test('git: an abort after git has exited kills nothing (its pid may be reused)', async () => {
  const killTree = () => assert.fail('an exited git is never killed');
  let finish;
  const exited = createGit({
    execFileImpl: (file, args, opts, cb) => { finish = cb; return { pid: 5, exitCode: 0, signalCode: null, kill: () => assert.fail('no fallback kill') }; },
    killTree,
  });
  const controller = new AbortController();
  const running = exited(['status'], { cwd: '/repo', signal: controller.signal });
  controller.abort();
  finish(null, '', '');
  assert.equal((await running).aborted, true);

  const child = new EventEmitter();
  child.pid = 6;
  const evented = createGit({ execFileImpl: (file, args, opts, cb) => { finish = cb; return child; }, killTree });
  const second = new AbortController();
  const run2 = evented(['status'], { cwd: '/repo', signal: second.signal });
  child.emit('exit', 0, null);
  second.abort();
  finish(null, 'ok', '');
  const res = await run2;
  assert.equal(res.code, 0);
  assert.equal('aborted' in res, false, 'an abort after exit is not an abort of this run');
});

test('git: a run that is never aborted reports no aborted flag', async () => {
  const { origin } = await setup();
  const res = await defaultGit(['rev-parse', 'HEAD'], { cwd: origin, signal: new AbortController().signal });
  assert.equal(res.code, 0);
  assert.equal('aborted' in res, false);
});

test('createWorktree: an abort during worktree add rejects with ERR_ABORTED and the half-made worktree; before the add, nothing is made', async () => {
  const { root, origin, sha } = await setup();
  const controller = new AbortController();
  const seen = [];
  const git = (args, opts) => {
    seen.push({ args, signal: opts.signal });
    if (args[0] === 'worktree' && args[1] === 'add') {
      return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: '', aborted: true })));
    }
    return defaultGit(args, opts);
  };
  const worktree = path.join(root, 'wts', 'slug', 'primary');
  const making = createWorktree({ git, origin, worktree, branch: 'superagent/x', copyLocalClaudeSettings: false, signal: controller.signal });
  while (!seen.some((c) => c.args[1] === 'add')) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(making, (err) => {
    assert.equal(err.code, 'ERR_ABORTED');
    assert.deepEqual(err.partial, { worktree, branch: 'superagent/x', baseSha: sha });
    return true;
  });
  assert.deepEqual(seen.filter((c) => c.signal).map((c) => c.args[1]), ['add'], 'only worktree add gets the signal');

  const early = await setup();
  const calls = [];
  const spy = (args, opts) => { calls.push(args); return defaultGit(args, opts); };
  const wt2 = path.join(early.root, 'wts', 'slug', 'primary');
  await assert.rejects(createWorktree({ git: spy, origin: early.origin, worktree: wt2, branch: 'superagent/y', copyLocalClaudeSettings: false, signal: AbortSignal.abort() }), (err) => {
    assert.equal(err.code, 'ERR_ABORTED');
    assert.equal(err.partial, undefined);
    return true;
  });
  assert.equal(calls.some((a) => a[0] === 'worktree'), false);
  await assert.rejects(fs.access(path.join(early.root, 'wts')));
});

test('removeAbortedWorktree removes a locked half-made worktree and its branch while it is still at baseSha', async () => {
  const { root, origin, sha } = await setup();
  const worktreesRoot = path.join(root, 'wts');
  const worktree = path.join(worktreesRoot, 'slug', 'primary');
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  gitOut(origin, 'worktree', 'add', '-q', '-b', 'superagent/x', worktree, 'HEAD');
  gitOut(origin, 'worktree', 'lock', '--reason', 'initializing', worktree);
  const res = await removeAbortedWorktree({ origin, worktree, branch: 'superagent/x', baseSha: sha, worktreesRoot });
  assert.deepEqual(res, { worktreeRemoved: true, branchDeleted: true, notes: [] });
  await assert.rejects(fs.access(worktree));
  assert.equal(hasBranch(origin, 'superagent/x'), false);
  assert.ok(!gitOut(origin, 'worktree', 'list', '--porcelain').toLowerCase().includes('slug'));
});

test('removeAbortedWorktree keeps a branch that has moved past baseSha and says why', async () => {
  const { root, origin, sha } = await setup();
  const worktreesRoot = path.join(root, 'wts');
  const worktree = path.join(worktreesRoot, 'slug', 'primary');
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  gitOut(origin, 'worktree', 'add', '-q', '-b', 'superagent/x', worktree, 'HEAD');
  await fs.writeFile(path.join(worktree, 'work.txt'), 'work\n');
  gitOut(worktree, 'add', 'work.txt');
  gitOut(worktree, 'commit', '-q', '-m', 'work');
  const moved = gitOut(worktree, 'rev-parse', 'HEAD');
  const res = await removeAbortedWorktree({ origin, worktree, branch: 'superagent/x', baseSha: sha, worktreesRoot });
  assert.equal(res.worktreeRemoved, true);
  assert.equal(res.branchDeleted, false);
  assert.equal(res.notes.length, 1);
  assert.match(res.notes[0], new RegExp(`kept branch superagent/x.*${moved}`));
  assert.equal(gitOut(origin, 'rev-parse', 'refs/heads/superagent/x'), moved);
});

test('removeAbortedWorktree deletes an unregistered leftover folder inside the worktrees root and never prunes', async () => {
  const { root, origin, sha } = await setup();
  const worktreesRoot = path.join(root, 'wts');
  const worktree = path.join(worktreesRoot, 'slug', 'primary');
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, 'partial.txt'), 'x');
  const calls = [];
  const git = (args, opts) => { calls.push(args.join(' ')); return defaultGit(args, opts); };
  const res = await removeAbortedWorktree({ git, origin, worktree, branch: 'superagent/x', baseSha: sha, worktreesRoot });
  assert.equal(res.worktreeRemoved, true);
  assert.equal(res.branchDeleted, false);
  assert.equal(calls.some((c) => c.includes('prune')), false);
  assert.match(res.notes.join('\n'), /locked worktree entry .* may remain/);
  await assert.rejects(fs.access(worktree));
  await fs.access(path.join(worktreesRoot, 'slug'));
});

test('removeAbortedWorktree touches nothing outside the worktrees root, by path or through a link', async () => {
  const { root, origin, sha } = await setup();
  const worktreesRoot = path.join(root, 'wts');
  await fs.mkdir(worktreesRoot, { recursive: true });
  const calls = [];
  const git = (args, opts) => { calls.push(args.join(' ')); return defaultGit(args, opts); };

  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  for (const worktree of [outside, worktreesRoot, origin]) {
    const res = await removeAbortedWorktree({ git, origin, worktree, branch: 'superagent/x', baseSha: sha, worktreesRoot });
    assert.equal(res.worktreeRemoved, false);
    assert.equal(res.notes.length, 1);
  }
  assert.deepEqual(calls, []);

  const link = path.join(worktreesRoot, 'slug', 'primary');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(outside, link, 'junction');
  const res = await removeAbortedWorktree({ git, origin, worktree: link, branch: 'superagent/x', baseSha: sha, worktreesRoot });
  assert.equal(res.worktreeRemoved, false);
  assert.match(res.notes.join('\n'), /outside/);
  assert.deepEqual(calls, [], 'a link out of the root is refused before any git command');
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(gitOut(origin, 'rev-parse', 'HEAD'), sha);
});

test('removeAbortedWorktree refuses a link to a sibling job worktree inside the same root', async () => {
  const { root, origin, sha } = await setup();
  const worktreesRoot = path.join(root, 'wts');
  const sibling = path.join(worktreesRoot, 'other-job', 'primary');
  await fs.mkdir(path.dirname(sibling), { recursive: true });
  gitOut(origin, 'worktree', 'add', '-q', '-b', 'superagent/other', sibling, 'HEAD');
  const link = path.join(worktreesRoot, 'this-job', 'primary');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(sibling, link, 'junction');
  const calls = [];
  const git = (args, opts) => { calls.push(args.join(' ')); return defaultGit(args, opts); };
  const res = await removeAbortedWorktree({ git, origin, worktree: link, branch: 'superagent/other', baseSha: sha, worktreesRoot });
  assert.deepEqual([res.worktreeRemoved, res.branchDeleted], [false, false]);
  assert.match(res.notes.join('\n'), /a link/);
  assert.deepEqual(calls, []);
  await fs.access(path.join(sibling, 'README.md'));
  assert.equal(hasBranch(origin, 'superagent/other'), true);
});

test('removeAbortedWorktree never throws: a git that throws becomes notes', async () => {
  const { root, origin, sha } = await setup();
  const worktreesRoot = path.join(root, 'wts');
  const worktree = path.join(worktreesRoot, 'slug', 'primary');
  const git = async () => { throw new Error('spawn EPERM'); };
  const res = await removeAbortedWorktree({ git, origin, worktree, branch: 'superagent/x', baseSha: sha, worktreesRoot });
  assert.equal(res.worktreeRemoved, false);
  assert.equal(res.branchDeleted, false);
  assert.match(res.notes.join('\n'), /spawn EPERM/);
});
