// Artifact reads for the view, and their snapshots (spec C2): the accounting
// queue copies each artifact into Cockpit's own job directory, so a file the
// operator deletes from the workspace stays readable. A read tries the
// workspace first, then the snapshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import { primaryRepo } from './results.js';
import { artifactKeys, artifactPath, artifactWriters, writerEnded } from './view-model.js';

export const ARTIFACT_MAX_BYTES = 1_000_000;
export const snapshotDirFor = (jobDir) => path.join(jobDir, 'artifacts');

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function isInside(root, file) {
  const rel = path.relative(fold(root), fold(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function realpathOrNull(file) {
  try {
    return await fs.realpath(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function knownPath(job, key) {
  const rel = artifactPath(job, key);
  if (rel === null) throw fail('ERR_UNKNOWN_ARTIFACT', `superagent: unknown artifact ${JSON.stringify(key)}`);
  return rel;
}

// The workspace file's real path, or null when it (or the whole worktree) is gone.
async function workspaceFile(job, key, rel) {
  const worktree = primaryRepo(job)?.worktree;
  const root = worktree ? await realpathOrNull(worktree) : null;
  const real = root && (await realpathOrNull(path.join(root, rel)));
  if (real && !isInside(root, real)) throw fail('ERR_ARTIFACT_OUTSIDE', `superagent: artifact ${key} resolves outside the worktree`);
  return real;
}

// encodeURIComponent leaves '.' alone, so the name is checked as well as the
// real path.
function snapshotName(root, key) {
  const file = path.join(root, encodeURIComponent(key));
  if (!isInside(root, file)) throw fail('ERR_ARTIFACT_OUTSIDE', `superagent: the snapshot of ${key} resolves outside the snapshot folder`);
  return file;
}

async function snapshotFile(snapshotDir, key) {
  const root = snapshotDir ? await realpathOrNull(snapshotDir) : null;
  const real = root && (await realpathOrNull(snapshotName(root, key)));
  if (real && !isInside(root, real)) throw fail('ERR_ARTIFACT_OUTSIDE', `superagent: the snapshot of ${key} resolves outside the snapshot folder`);
  return real;
}

// One byte past maxBytes, so the caller can tell the file was truncated.
async function readCapped(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// `ended`: the attempt that writes key has ended, so neither file means it was
// deleted (ERR_ARTIFACT_GONE) rather than not written yet.
export async function readArtifact(job, key, { maxBytes = ARTIFACT_MAX_BYTES, snapshotDir = null, ended = false } = {}) {
  const rel = knownPath(job, key);
  let source = 'workspace';
  let file = await workspaceFile(job, key, rel);
  if (!file) {
    source = 'snapshot';
    file = await snapshotFile(snapshotDir, key);
  }
  if (!file) {
    if (ended) throw fail('ERR_ARTIFACT_GONE', `superagent: artifact ${key} was deleted from the workspace and has no snapshot`);
    throw fail('ERR_ARTIFACT_MISSING', `superagent: artifact ${key} does not exist`);
  }
  const bytes = await readCapped(file, maxBytes);
  const truncated = bytes.length > maxBytes;
  return { key, path: rel, text: bytes.subarray(0, Math.min(bytes.length, maxBytes)).toString('utf8'), truncated, source };
}

// Copies key's workspace file to snapshotDir/<encodeURIComponent(key)>,
// overwriting an earlier snapshot. The copy keeps the byte past maxBytes so a
// read of it still reports truncated. beforeWrite runs right before the write
// and throws to refuse it.
export async function snapshotArtifact(job, key, { snapshotDir, maxBytes = ARTIFACT_MAX_BYTES, beforeWrite = () => {} }) {
  const source = await workspaceFile(job, key, knownPath(job, key));
  if (!source) return 'missing';
  const bytes = await readCapped(source, maxBytes);
  await fs.mkdir(snapshotDir, { recursive: true });
  const root = await fs.realpath(snapshotDir);
  const dest = snapshotName(root, key);
  const existing = await realpathOrNull(dest);
  if (existing && !isInside(root, existing)) throw fail('ERR_ARTIFACT_OUTSIDE', `superagent: the snapshot of ${key} resolves outside the snapshot folder`);
  beforeWrite();
  await fs.writeFile(dest, bytes);
  return 'copied';
}

// Stat only. A path that cannot be resolved counts as absent here; reading it
// reports the real error.
export async function artifactStates(job, { snapshotDir }) {
  const writers = artifactWriters(job);
  const absent = () => null;
  const states = new Map();
  for (const key of artifactKeys(job)) {
    const rel = artifactPath(job, key);
    let state;
    if (rel !== null && (await workspaceFile(job, key, rel).catch(absent))) state = 'workspace';
    else if (await snapshotFile(snapshotDir, key).catch(absent)) state = 'snapshot';
    else state = writerEnded(job, writers.get(key)) ? 'gone' : 'pending';
    states.set(key, state);
  }
  return states;
}
