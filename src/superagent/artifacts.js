import fs from 'node:fs/promises';
import path from 'node:path';
import { primaryRepo } from './results.js';
import { artifactPath } from './view-model.js';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function isInside(root, file) {
  const rel = path.relative(fold(root), fold(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function realpathOrMissing(file, key) {
  try {
    return await fs.realpath(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw fail('ERR_ARTIFACT_MISSING', `superagent: artifact ${key} does not exist`);
    throw err;
  }
}

export async function readArtifact(job, key, { maxBytes = 1_000_000 } = {}) {
  const rel = artifactPath(job, key);
  if (rel === null) throw fail('ERR_UNKNOWN_ARTIFACT', `superagent: unknown artifact ${JSON.stringify(key)}`);
  const root = await fs.realpath(primaryRepo(job).worktree);
  const real = await realpathOrMissing(path.join(root, rel), key);
  if (!isInside(root, real)) throw fail('ERR_ARTIFACT_OUTSIDE', `superagent: artifact ${key} resolves outside the worktree`);
  const handle = await fs.open(real, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    return { key, path: rel, text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'), truncated };
  } finally {
    await handle.close();
  }
}
