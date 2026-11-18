// In-place folder checks (Plan 7 spec, "In-place folders", "Checks, before
// job-created"). Read-only: every command here only reads, and status runs
// with --no-optional-locks so it never refreshes the user's index. A folder
// that fails is refused before job-created with nothing switched, created or
// written in it.
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { BRANCH_PREFIX, defaultGit, repoToplevel } from './worktree.js';

const BUSY_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
const DIRTY_PATHS_SHOWN = 10;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// The one comparison of repo top levels, shared by ERR_DUPLICATE_REPO and the
// folder reservation.
export function normaliseTop(p, platform) {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function checkInPlace({ git = defaultGit, folder, branch }) {
  const toplevel = await repoToplevel({ git, origin: folder });
  const head = await git(['rev-parse', '--verify', 'HEAD'], { cwd: folder });
  if (head.code !== 0) throw fail('ERR_NO_COMMITS', `superagent: ${folder} has no commits`);

  const gitDir = await git(['rev-parse', '--git-dir'], { cwd: folder });
  if (gitDir.code !== 0) throw fail('ERR_NOT_GIT_REPO', `superagent: ${folder} is not a git repository`);
  const dir = path.resolve(folder, gitDir.stdout.trim());
  for (const marker of BUSY_MARKERS) {
    if (await exists(path.join(dir, marker))) {
      throw fail('ERR_FOLDER_BUSY_GIT', `superagent: ${folder} has a git operation in progress (${marker}); finish or abort it first`);
    }
  }
  const current = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: folder });
  if (current.code !== 0) throw fail('ERR_FOLDER_BUSY_GIT', `superagent: ${folder} has a detached HEAD; switch it to a branch first`);
  const currentBranch = current.stdout.trim();
  if (currentBranch.startsWith(BRANCH_PREFIX)) {
    throw fail('ERR_FOLDER_ON_JOB_BRANCH', `superagent: ${folder} is on ${currentBranch}; switch this folder back to your own branch first`);
  }

  const status = await git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], { cwd: folder });
  const changed = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
  if (status.code !== 0 && changed.length === 0) {
    throw fail('ERR_FOLDER_DIRTY', `superagent: could not read the git status of ${folder}: ${status.stderr.trim()}`);
  }
  if (changed.length > 0) {
    const more = changed.length > DIRTY_PATHS_SHOWN ? ` and ${changed.length - DIRTY_PATHS_SHOWN} more` : '';
    throw fail('ERR_FOLDER_DIRTY', `superagent: ${folder} has uncommitted or untracked changes: ${changed.slice(0, DIRTY_PATHS_SHOWN).join(', ')}${more}`);
  }

  const ref = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: folder });
  if (ref.code === 0) throw fail('ERR_BRANCH_EXISTS', `superagent: branch ${branch} already exists`);
  return { toplevel, head: head.stdout.trim() };
}
