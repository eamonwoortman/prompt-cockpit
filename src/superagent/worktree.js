// Superagent git worktrees: one worktree and one new branch per repo per job.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, Decisions 10-12
// (isolated worktree per job, ignored local ledger, local settings copy only
// when the repo ignores that file). Never delete automatically: nothing in this
// module pushes, removes a worktree, deletes a branch or prunes. Orphans are
// only listed; the operator decides.
import { execFile } from 'node:child_process';
import { cp, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
export function defaultGit(args, { cwd }) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: stdout ?? '', stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') });
    });
  });
}

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

export async function createWorktree({ git = defaultGit, origin, worktree, branch, copyLocalClaudeSettings }) {
  const { baseSha } = await preflight({ git, origin, worktree, branch });

  await mkdir(path.dirname(worktree), { recursive: true });
  const add = await git(['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: origin });
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
