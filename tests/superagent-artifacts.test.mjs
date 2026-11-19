import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { artifactStates, readArtifact, snapshotArtifact } from '../src/superagent/artifacts.js';
import { MILESTONE_2_PIPELINE } from '../src/superagent/config.js';
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
  assert.deepEqual(await readArtifact(job, 'spec'), { key: 'spec', path: specRel, text: 'the spec', truncated: false, source: 'workspace' });
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

async function writeSpec(specFile, text) {
  await fs.mkdir(path.dirname(specFile), { recursive: true });
  await fs.writeFile(specFile, text);
}

const snapshotDirOf = (worktree) => path.join(path.dirname(worktree), 'job', 'artifacts');

test('a snapshot copies the workspace file under its encoded key', async (t) => {
  const { job, worktree, specFile } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  await writeSpec(specFile, 'the spec');
  assert.equal(await snapshotArtifact(job, 'spec', { snapshotDir }), 'copied');
  assert.equal(await fs.readFile(path.join(snapshotDir, 'spec'), 'utf8'), 'the spec');
  await writeSpec(specFile, 'the revised spec');
  await snapshotArtifact(job, 'spec', { snapshotDir });
  assert.equal(await fs.readFile(path.join(snapshotDir, 'spec'), 'utf8'), 'the revised spec', 'a later copy overwrites');
});

test('a snapshot of a missing workspace file writes nothing', async (t) => {
  const { job, worktree } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  assert.equal(await snapshotArtifact(job, 'spec', { snapshotDir }), 'missing');
  await assert.rejects(fs.stat(path.join(snapshotDir, 'spec')), { code: 'ENOENT' });
});

test('a snapshot write refused by beforeWrite leaves no file', async (t) => {
  const { job, worktree, specFile } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  await writeSpec(specFile, 'the spec');
  const refused = Object.assign(new Error('refused'), { code: 'ERR_REFUSED' });
  await rejectsWith(snapshotArtifact(job, 'spec', { snapshotDir, beforeWrite: () => { throw refused; } }), 'ERR_REFUSED');
  await assert.rejects(fs.stat(path.join(snapshotDir, 'spec')), { code: 'ENOENT' });
});

test('readArtifact prefers the workspace file', async (t) => {
  const { job, worktree, specFile, specRel } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  await writeSpec(specFile, 'old');
  await snapshotArtifact(job, 'spec', { snapshotDir });
  await writeSpec(specFile, 'new');
  assert.deepEqual(await readArtifact(job, 'spec', { snapshotDir, ended: true }), { key: 'spec', path: specRel, text: 'new', truncated: false, source: 'workspace' });
});

test('readArtifact falls back to the snapshot after the workspace file is deleted', async (t) => {
  const { job, worktree, specFile, specRel } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  await writeSpec(specFile, 'the spec');
  await snapshotArtifact(job, 'spec', { snapshotDir });
  await fs.rm(specFile);
  assert.deepEqual(await readArtifact(job, 'spec', { snapshotDir, ended: true }), { key: 'spec', path: specRel, text: 'the spec', truncated: false, source: 'snapshot' });
  await fs.rm(worktree, { recursive: true, force: true });
  assert.equal((await readArtifact(job, 'spec', { snapshotDir })).source, 'snapshot', 'a removed worktree falls back too');
});

test('a snapshot keeps the size cap and still reads as truncated', async (t) => {
  const { job, worktree, specFile } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  await writeSpec(specFile, 'x'.repeat(50));
  await snapshotArtifact(job, 'spec', { snapshotDir, maxBytes: 10 });
  assert.ok((await fs.stat(path.join(snapshotDir, 'spec'))).size <= 11);
  await fs.rm(specFile);
  const r = await readArtifact(job, 'spec', { snapshotDir, maxBytes: 10 });
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, true);
});

test('readArtifact throws ERR_ARTIFACT_GONE when ended and both are missing', async (t) => {
  const { job, worktree } = await setup(t);
  await rejectsWith(readArtifact(job, 'spec', { snapshotDir: snapshotDirOf(worktree), ended: true }), 'ERR_ARTIFACT_GONE');
  await rejectsWith(readArtifact(job, 'spec', { ended: true }), 'ERR_ARTIFACT_GONE');
});

test('readArtifact keeps ERR_ARTIFACT_MISSING before the writer ended', async (t) => {
  const { job, worktree } = await setup(t);
  await rejectsWith(readArtifact(job, 'spec', { snapshotDir: snapshotDirOf(worktree), ended: false }), 'ERR_ARTIFACT_MISSING');
});

test('a snapshot path cannot escape snapshotDir', async (t) => {
  const { job, worktree } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  job.artifacts['..'] = 'docs/escape.md';
  await writeSpec(path.join(worktree, 'docs', 'escape.md'), 'escape');
  await rejectsWith(snapshotArtifact(job, '..', { snapshotDir }), 'ERR_ARTIFACT_OUTSIDE');
  await fs.rm(path.join(worktree, 'docs', 'escape.md'));
  await rejectsWith(readArtifact(job, '..', { snapshotDir, ended: true }), 'ERR_ARTIFACT_OUTSIDE');
  assert.deepEqual(await fs.readdir(path.dirname(snapshotDir)), ['artifacts']);
});

test('a linked snapshot pointing outside is refused', async (t) => {
  const { job, worktree, outside } = await setup(t);
  const snapshotDir = snapshotDirOf(worktree);
  if (!(await link(t, outside, path.join(snapshotDir, 'spec'), 'junction'))) return;
  await rejectsWith(readArtifact(job, 'spec', { snapshotDir }), 'ERR_ARTIFACT_OUTSIDE');
});

test('artifactStates reports workspace, snapshot, gone and pending by stat alone', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-artifacts-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const worktree = path.join(base, 'worktree');
  const snapshotDir = path.join(base, 'job', 'artifacts');
  await fs.mkdir(worktree);
  const started = (attemptId, phase, over = {}) => ({ type: 'attempt-started', attemptId, phase, role: 'r', model: 'm', n: 1, purpose: 'author', ...over });
  const ended = (attemptId) => ({ type: 'attempt-ended', attemptId, outcome: 'done' });
  const events = [
    ...provisionedEvents({ pipeline: MILESTONE_2_PIPELINE }),
    started('s1', 'spec'), ended('s1'), { type: 'phase-completed', phase: 'spec', visit: 1 },
    started('r1', 'spec-review', { purpose: 'review', round: 1 }), ended('r1'),
    started('f1', 'spec-review', { purpose: 'fix', round: 1 }), ended('f1'),
    started('r2', 'spec-review', { purpose: 'review', round: 2 }),
  ];
  const job = deriveJob(events.map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e })));
  primaryRepo(job).worktree = worktree;
  await writeSpec(path.join(worktree, artifactPaths(job).spec), 'spec');
  await writeSpec(path.join(snapshotDir, encodeURIComponent('review:spec-review:1')), 'review');
  assert.deepEqual(Object.fromEntries(await artifactStates(job, { snapshotDir })), {
    spec: 'workspace',
    'review:spec-review:1': 'snapshot',
    'response:spec-review:1': 'gone',
    'review:spec-review:2': 'pending',
  });
});

test('artifactStates keeps a key pending when its latest writer failed, stopped or asked a question', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-artifacts-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const worktree = path.join(base, 'worktree');
  await fs.mkdir(worktree);
  const started = (attemptId, phase) => ({ type: 'attempt-started', attemptId, phase, role: 'r', model: 'm', n: 1, purpose: 'author' });
  for (const outcome of ['failed', 'stopped', 'question', 'interrupted']) {
    const events = [...provisionedEvents({ pipeline: MILESTONE_2_PIPELINE }), started('s1', 'spec'), { type: 'attempt-ended', attemptId: 's1', outcome }];
    const job = deriveJob(events.map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e })));
    primaryRepo(job).worktree = worktree;
    assert.equal((await artifactStates(job, { snapshotDir: path.join(base, 'none') })).get('spec'), 'pending', outcome);
  }
});
