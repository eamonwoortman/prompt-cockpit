import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readArtifact } from '../src/superagent/artifacts.js';
import { artifactPaths, primaryRepo } from '../src/superagent/results.js';
import { deriveJob } from '../src/superagent/store.js';
import { provisionedEvents } from './superagent-helpers.mjs';

async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-artifacts-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const worktree = path.join(base, 'worktree');
  const outside = path.join(base, 'outside');
  await fs.mkdir(worktree);
  await fs.mkdir(outside);
  const events = provisionedEvents().map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e }));
  const job = deriveJob(events);
  primaryRepo(job).worktree = worktree;
  const specRel = artifactPaths(job).spec;
  return { job, worktree, outside, specFile: path.join(worktree, specRel), specRel };
}

async function link(t, target, file, type) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.symlink(target, file, type);
    return true;
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    t.skip('symlink needs privilege');
    return false;
  }
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => err.code === code);
}

test('reads a known artifact', async (t) => {
  const { job, specFile, specRel } = await setup(t);
  await fs.mkdir(path.dirname(specFile), { recursive: true });
  await fs.writeFile(specFile, 'the spec');
  assert.deepEqual(await readArtifact(job, 'spec'), { key: 'spec', path: specRel, text: 'the spec', truncated: false });
});

test('refuses an unknown key', async (t) => {
  const { job } = await setup(t);
  await rejectsWith(readArtifact(job, 'nope'), 'ERR_UNKNOWN_ARTIFACT');
});

test('a missing file', async (t) => {
  const { job } = await setup(t);
  await rejectsWith(readArtifact(job, 'spec'), 'ERR_ARTIFACT_MISSING');
});

test('a linked file pointing outside is refused', async (t) => {
  const { job, outside, specFile } = await setup(t);
  const secret = path.join(outside, 'secret.md');
  await fs.writeFile(secret, 'secret');
  if (!(await link(t, secret, specFile, 'file'))) return;
  await rejectsWith(readArtifact(job, 'spec'), 'ERR_ARTIFACT_OUTSIDE');
});

test('a linked parent directory pointing outside is refused', async (t) => {
  const { job, worktree, outside } = await setup(t);
  await fs.writeFile(path.join(outside, 'brief.md'), 'secret');
  const dir = path.join(worktree, path.dirname(artifactPaths(job).brief));
  if (!(await link(t, outside, dir, 'junction'))) return;
  await rejectsWith(readArtifact(job, 'brief'), 'ERR_ARTIFACT_OUTSIDE');
});

test('a large file is truncated at maxBytes', async (t) => {
  const { job, specFile } = await setup(t);
  await fs.mkdir(path.dirname(specFile), { recursive: true });
  await fs.writeFile(specFile, 'x'.repeat(50));
  const r = await readArtifact(job, 'spec', { maxBytes: 10 });
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, true);
});

test('a file of exactly maxBytes is not truncated', async (t) => {
  const { job, specFile } = await setup(t);
  await fs.mkdir(path.dirname(specFile), { recursive: true });
  await fs.writeFile(specFile, 'x'.repeat(10));
  const r = await readArtifact(job, 'spec', { maxBytes: 10 });
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, false);
});
