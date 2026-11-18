// In-place folders (Plan 7 spec, "In-place folders").
//
// checkInPlace is read-only: every command only reads, and status runs with
// --no-optional-locks so it never refreshes the user's index. A folder that
// fails is refused before job-created with nothing switched, created or
// written in it.
//
// provisionInPlace is the only code that changes the user's checkout: one
// `git switch -c` at the admitted HEAD, then the job's ledger directory and
// one local exclude line. Never reset, clean, stash, checkout -- ., a forced
// or discarding switch, and never an undo: a step after the switch that fails
// fails the job and leaves the folder as it is.
import fsp, { stat } from 'node:fs/promises';
import path from 'node:path';
import { BRANCH_PREFIX, defaultGit, repoToplevel } from './worktree.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

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

// A folder left on a superagent/* branch (by an earlier in-place job) would
// start a new job, in place or as a worktree origin, from that job's branch.
// Returns the current branch, or null for a detached HEAD.
export async function refuseJobBranch({ git = defaultGit, folder }) {
  const current = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: folder });
  if (current.code !== 0) return null;
  const branch = current.stdout.trim();
  if (branch.startsWith(BRANCH_PREFIX)) {
    throw fail('ERR_FOLDER_ON_JOB_BRANCH', `superagent: ${folder} is on ${branch}; switch this folder back to your own branch first`);
  }
  return branch;
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
  const onBranch = await refuseJobBranch({ git, folder });
  if (onBranch === null) throw fail('ERR_FOLDER_BUSY_GIT', `superagent: ${folder} has a detached HEAD; switch it to a branch first`);

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

function ledgerDirRel(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new Error(`superagent: unsafe job id ${JSON.stringify(jobId)} for a ledger directory`);
  return `.superpowers/superagent/${jobId}/`;
}

// The local exclude file (never committed or shared), found through git so a
// linked worktree gets its shared one. The line is added once, never removed.
export async function addLedgerExclude({ git = defaultGit, folder, jobId, fsImpl = fsp }) {
  const rule = `/${ledgerDirRel(jobId)}`;
  const res = await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: folder });
  const rel = res.stdout.trim();
  if (res.code !== 0 || rel === '') throw new Error(`superagent: could not find the exclude file of ${folder}: ${res.stderr.trim()}`);
  const file = path.resolve(folder, rel);
  let text = '';
  try {
    text = await fsImpl.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (text.split('\n').some((line) => line.trimEnd() === rule)) return;
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  await fsImpl.appendFile(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${rule}\n`);
}

// `folder` is the repo top level and `expectedHead` the HEAD admitted at
// createJob. Everything before the switch only reads, so a refusal there
// leaves nothing switched.
export async function provisionInPlace({ git = defaultGit, folder, branch, jobId, expectedHead }) {
  const ledgerRel = ledgerDirRel(jobId);
  if (typeof folder !== 'string' || folder === '' || typeof expectedHead !== 'string' || expectedHead === '') {
    throw fail('ERR_FOLDER_CHANGED', `superagent: in-place repo ${folder} has no recorded top level or admitted HEAD; nothing was switched`);
  }
  const { toplevel, head } = await checkInPlace({ git, folder, branch });
  if (normaliseTop(toplevel, process.platform) !== normaliseTop(folder, process.platform)) {
    throw fail('ERR_FOLDER_CHANGED', `superagent: ${folder} is no longer a repository top level (git reports ${toplevel}); nothing was switched`);
  }
  if (head !== expectedHead) {
    throw fail('ERR_FOLDER_CHANGED', `superagent: ${folder} changed since the job was created (HEAD is ${head}, admitted ${expectedHead}); nothing was switched`);
  }

  const switched = await git(['switch', '-c', branch], { cwd: folder });
  if (switched.code !== 0) throw new Error(`superagent: git switch -c ${branch} failed in ${folder}: ${switched.stderr.trim()}`);
  const after = await git(['rev-parse', '--verify', 'HEAD'], { cwd: folder });
  const baseSha = after.stdout.trim();
  if (after.code !== 0 || baseSha !== expectedHead) {
    throw fail('ERR_FOLDER_CHANGED', `superagent: ${folder} changed during the switch (HEAD is ${baseSha || 'unreadable'}, admitted ${expectedHead}); it is left on ${branch}`);
  }

  await fsp.mkdir(path.join(folder, ...ledgerRel.split('/').filter(Boolean)), { recursive: true });
  await addLedgerExclude({ git, folder, jobId });
  const probe = await git(['check-ignore', '-q', `${ledgerRel}probe`], { cwd: folder });
  if (probe.code !== 0) {
    throw new Error(`superagent: the job's ledger directory ${ledgerRel} is not ignored in ${folder} (a tracked path or a .gitignore negation there); it is left on ${branch}`);
  }
  return { worktree: folder, branch, baseSha, settingsCopy: 'in-place' };
}
