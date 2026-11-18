// Superagent git worktrees: one worktree and one new branch per repo per job.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, Decisions 10-12
// (isolated worktree per job, ignored local ledger, local settings copy only
// when the repo ignores that file). Never delete automatically: nothing in this
// module pushes, removes a worktree, deletes a branch or prunes, except
// removeAbortedWorktree, which removes only the half-made worktree of a
// provisioning a Stop cancelled. Orphans are only listed; the operator decides.
import { execFile } from 'node:child_process';
import { cp, copyFile, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { killProcessTree } from '../child-tracker.js';

export const BRANCH_PREFIX = 'superagent/';

export function slugify(title, jobId, maxBase = 40) {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxBase)
    .replace(/-+$/g, '');
  return `${base || 'job'}-${String(jobId).slice(0, 8)}`;
}

// A system-level core.fsmonitor=true would start a never-exiting
// `git fsmonitor--daemon` per job worktree. This covers superagent's own git
// calls only; the workers' git commands are not covered.
//
// Resolves { code, stdout, stderr }, never rejects. With `signal`, an abort
// kills git's whole process tree (git worktree add runs git-lfs under a
// shell) and the result also carries `aborted: true` with a non-zero code; an
// already-aborted signal starts no process at all. On POSIX killProcessTree
// signals only git's own pid.
//
// The abort stops listening at 'exit', not at the callback (which waits for
// 'close'): Node releases the pid at exit, and a kill after that could hit a
// process that reused it. An abort after exit is not an abort of this run.
export function createGit({ execFileImpl = execFile, killTree = killProcessTree } = {}) {
  return function git(args, { cwd, signal } = {}) {
    if (signal?.aborted) return Promise.resolve({ code: 1, stdout: '', stderr: 'superagent: git was not started: aborted', aborted: true });
    return new Promise((resolve) => {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        if (child.exitCode != null || child.signalCode != null) return;
        if (!killTree(child.pid)) child.kill?.('SIGKILL');
      };
      const child = execFileImpl('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        signal?.removeEventListener('abort', onAbort);
        let code = 0;
        if (err) code = typeof err.code === 'number' ? err.code : 1;
        if (aborted && code === 0) code = 1;
        const res = { code, stdout: stdout ?? '', stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') };
        resolve(aborted ? { ...res, aborted: true } : res);
      });
      if (!signal) return;
      signal.addEventListener('abort', onAbort, { once: true });
      child.once?.('exit', () => signal.removeEventListener('abort', onAbort));
    });
  };
}

export const defaultGit = createGit();

export function repoIds(primary, additional) {
  const seen = new Map();
  const out = [{ id: 'primary', origin: primary }];
  for (const origin of additional) {
    const name = path.basename(origin) || 'repo';
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.push({ id: n === 1 ? name : `${name}-${n}`, origin });
  }
  return out;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function repoToplevel({ git = defaultGit, origin }) {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: origin });
  if (top.code !== 0) throw fail('ERR_NOT_GIT_REPO', `superagent: ${origin} is not a git repository`);
  return top.stdout.trim();
}

async function preflight({ git, origin, worktree, branch }) {
  const toplevel = await repoToplevel({ git, origin });
  const head = await git(['rev-parse', '--verify', 'HEAD'], { cwd: origin });
  if (head.code !== 0) throw fail('ERR_NO_COMMITS', `superagent: ${origin} has no commits`);
  const ref = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: origin });
  if (ref.code === 0) throw fail('ERR_BRANCH_EXISTS', `superagent: branch ${branch} already exists`);
  if (await exists(worktree)) throw fail('ERR_WORKTREE_PATH_EXISTS', `superagent: ${worktree} already exists`);
  return { toplevel, baseSha: head.stdout.trim() };
}

export async function checkRepo({ git = defaultGit, origin, worktree, branch }) {
  const { toplevel } = await preflight({ git, origin, worktree, branch });
  return { toplevel };
}

// `signal` reaches only `git worktree add`, the one long step. An abort
// rejects with ERR_ABORTED; once the add has started, `err.partial` names the
// half-made worktree for removeAbortedWorktree.
export async function createWorktree({ git = defaultGit, origin, worktree, branch, copyLocalClaudeSettings, signal }) {
  const { baseSha } = await preflight({ git, origin, worktree, branch });
  if (signal?.aborted) throw fail('ERR_ABORTED', `superagent: provisioning of ${worktree} was stopped before git worktree add`);

  await mkdir(path.dirname(worktree), { recursive: true });
  const add = await git(['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: origin, ...(signal && { signal }) });
  if (add.aborted) {
    throw Object.assign(fail('ERR_ABORTED', `superagent: git worktree add of ${worktree} was stopped`), { partial: { worktree, branch, baseSha } });
  }
  if (add.code !== 0) throw new Error(`superagent: git worktree add failed: ${add.stderr.trim()}`);

  const ledgerRoot = path.join(worktree, '.superpowers', 'superagent');
  await mkdir(ledgerRoot, { recursive: true });
  await writeFile(path.join(ledgerRoot, '.gitignore'), '*\n');

  let settingsCopy;
  const source = path.join(origin, '.claude', 'settings.local.json');
  if (!copyLocalClaudeSettings) settingsCopy = 'disabled';
  else if (!(await exists(source))) settingsCopy = 'absent';
  else {
    const ignored = await git(['check-ignore', '-q', '.claude/settings.local.json'], { cwd: worktree });
    if (ignored.code !== 0) settingsCopy = 'skipped-not-ignored';
    else {
      await mkdir(path.join(worktree, '.claude'), { recursive: true });
      await copyFile(source, path.join(worktree, '.claude', 'settings.local.json'));
      settingsCopy = 'copied';
    }
  }
  return { worktree, branch, baseSha, settingsCopy };
}

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function isStrictlyInside(root, p) {
  const rel = path.relative(fold(root), fold(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function realpathOrNull(p) {
  try {
    return await realpath(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// The real path a target must have: its own place under the real worktrees
// root, so a link to anywhere else (a sibling job's worktree included) fails.
async function isExactTarget(worktreesRoot, worktree, real) {
  const expected = path.join(await realpath(worktreesRoot), path.relative(path.resolve(worktreesRoot), path.resolve(worktree)));
  return fold(real) === fold(expected);
}

// The half-made worktree of a provisioning a Stop cancelled, and nothing else:
// `worktree` must lie strictly inside `worktreesRoot` and (when it exists)
// really be that path, or nothing runs. No prune: it would act on every
// missing worktree of the user's repo, and never on ours, which a killed add
// leaves locked. The branch goes only while it still points at `baseSha`, so
// a branch with a commit is never deleted. Never throws; whatever could not
// be done is described in `notes`.
export async function removeAbortedWorktree({ git = defaultGit, origin, worktree, branch, baseSha, worktreesRoot }) {
  const notes = [];
  const result = { worktreeRemoved: false, branchDeleted: false, notes };
  const step = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      notes.push(`${what}: ${String(err?.message ?? err)}`);
      return null;
    }
  };

  const contained = await step(`could not check ${worktree}`, async () => {
    if (!isStrictlyInside(path.resolve(worktreesRoot), path.resolve(worktree))) return false;
    const real = await realpathOrNull(worktree);
    return real === null || isExactTarget(worktreesRoot, worktree, real);
  });
  if (contained !== true) {
    if (contained === false) notes.push(`${worktree} is not its own path under ${worktreesRoot} (outside it, or a link); nothing removed`);
    return result;
  }

  const removed = await step('git worktree remove failed', () => git(['worktree', 'remove', '--force', '--force', worktree], { cwd: origin }));
  if (removed?.code === 0) result.worktreeRemoved = true;
  else {
    if (removed) notes.push(`git worktree remove failed: ${removed.stderr.trim()}`);
    notes.push(`a locked worktree entry for ${worktree} may remain in ${origin}`);
    await step(`could not delete ${worktree}`, async () => {
      const real = await realpathOrNull(worktree);
      if (real === null) return;
      if (!(await isExactTarget(worktreesRoot, worktree, real))) {
        notes.push(`${worktree} now resolves outside its own path under ${worktreesRoot}; kept`);
        return;
      }
      await rm(real, { recursive: true, force: true });
      result.worktreeRemoved = true;
    });
  }

  const ref = await step(`could not read branch ${branch}`, () => git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: origin }));
  if (ref?.code !== 0) return result;
  const head = ref.stdout.trim();
  if (head !== baseSha) {
    notes.push(`kept branch ${branch}: it points at ${head}, not the base commit ${baseSha}`);
    return result;
  }
  const deleted = await step(`git branch -D ${branch} failed`, () => git(['branch', '-D', branch], { cwd: origin }));
  if (deleted?.code === 0) result.branchDeleted = true;
  else if (deleted) notes.push(`git branch -D ${branch} failed: ${deleted.stderr.trim()}`);
  return result;
}

export async function inspectWorktree({ git = defaultGit, worktree }) {
  if (!(await exists(worktree))) return { exists: false, head: null, branch: null, dirty: false };
  const head = await git(['rev-parse', 'HEAD'], { cwd: worktree });
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worktree });
  const status = await git(['status', '--porcelain'], { cwd: worktree });
  return {
    exists: true,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    dirty: status.code === 0 && status.stdout.trim() !== '',
  };
}

export async function archiveLedger({ worktree, jobId, destDir }) {
  const src = path.join(worktree, '.superpowers', 'superagent', jobId);
  if (!(await exists(src))) return { copied: false };
  await mkdir(destDir, { recursive: true });
  await cp(src, destDir, { recursive: true });
  return { copied: true };
}

function parseWorktrees(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let wt = null;
    let branch = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wt = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
    }
    if (wt) out.push({ worktree: wt, branch });
  }
  return out;
}

export async function listOrphanWorktrees({ git = defaultGit, repos, knownBranches }) {
  const orphans = [];
  for (const repo of repos) {
    const res = await git(['worktree', 'list', '--porcelain'], { cwd: repo });
    if (res.code !== 0) continue;
    for (const entry of parseWorktrees(res.stdout)) {
      if (entry.branch?.startsWith(BRANCH_PREFIX) && !knownBranches.has(entry.branch)) {
        orphans.push({ repo, worktree: entry.worktree, branch: entry.branch });
      }
    }
  }
  return orphans;
}
