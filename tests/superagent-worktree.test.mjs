import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, initRepo } from './superagent-helpers.mjs';
import { slugify, repoIds, createWorktree, inspectWorktree, archiveLedger, listOrphanWorktrees } from '../src/superagent/worktree.js';

const norm = (p) => realpathSync.native(path.resolve(p)).toLowerCase();
const SETTINGS = '{"permissions":{"allow":["Bash(npm test)"]}}';

async function setup(opts) {
  const root = await tempDir('sa-wt-');
  const origin = path.join(root, 'origin');
  const sha = await initRepo(origin, opts);
  return { root, origin, sha };
}

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
