import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { tempDir } from './superagent-helpers.mjs';
import { createTranscriptIndex, projectDirName, readJobCard, summarizeUsage } from '../src/superagent/transcripts.js';

const WORKTREE = path.join(path.sep, 'work', 'tree-1');

const card = (jobId, attemptId) => `# Superagent job card\n\n\`\`\`json\n${JSON.stringify({ jobId, attemptId }, null, 2)}\n\`\`\`\n`;
const userLine = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const asst = (id, model, usage) => ({ type: 'assistant', message: { id, model, usage } });
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 };

async function writeTranscript(dir, sessionId, lines, { sub } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  if (sub) {
    const subDir = path.join(dir, sessionId, 'subagents');
    await fs.mkdir(subDir, { recursive: true });
    for (const [name, subLines] of Object.entries(sub)) await fs.writeFile(path.join(subDir, `${name}.jsonl`), subLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return file;
}

async function setup() {
  const root = await tempDir('transcripts-');
  const dir = path.join(root, projectDirName(WORKTREE));
  const job = { jobId: 'j1', repos: [{ id: 'primary', worktree: WORKTREE }] };
  return { root, dir, job, index: createTranscriptIndex({ projectsRoot: root }) };
}

test('projectDirName replaces every non-alphanumeric character', () => {
  assert.equal(projectDirName('C:\\workspace\\git\\FallGuys'), 'C--workspace-git-FallGuys');
});

test('readJobCard parses the first json fence after the marker', () => {
  assert.deepEqual(readJobCard(`intro\n${card('j', 'a')}\n\`\`\`json\n{"x":1}\n\`\`\``), { jobId: 'j', attemptId: 'a' });
  assert.equal(readJobCard('no marker'), null);
  assert.equal(readJobCard('# Superagent job card\n\n```json\n{bad\n```'), null);
});

test('find matches the card own attemptId, not a quoted earlier one', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'), { cwd: WORKTREE })]);
  await writeTranscript(dir, 'B', [userLine(card('j1', 'a2')), userLine('earlier "attemptId": "a1" quoted')]);
  const found = await index.find(job, { attemptId: 'a1' });
  assert.equal(found.status, 'found');
  assert.equal(found.claudeSessionId, 'A');
});

test('find reads a card from an array of content blocks', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [{ type: 'user', message: { content: [{ type: 'text', text: card('j1', 'a1') }] } }]);
  assert.equal((await index.find(job, { attemptId: 'a1' })).status, 'found');
});

test('find requires jobId to match too', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [userLine(card('other', 'a1'))]);
  assert.deepEqual(await index.find(job, { attemptId: 'a1' }), { status: 'missing' });
});

test('find returns ambiguous for two matching files', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'))]);
  await writeTranscript(dir, 'B', [userLine(card('j1', 'a1'))]);
  const found = await index.find(job, { attemptId: 'a1' });
  assert.equal(found.status, 'ambiguous');
  assert.equal(found.files.length, 2);
});

test('find skips files older than the attempt startedAt', async () => {
  const { dir, job, index } = await setup();
  const file = await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'))]);
  const old = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(file, old, old);
  assert.equal((await index.find(job, { attemptId: 'a1', startedAt: Date.parse('2021-01-01T00:00:00Z') })).status, 'missing');
  assert.equal((await index.find(job, { attemptId: 'a1', startedAt: Date.parse('2019-01-01T00:00:00Z') })).status, 'found');
});

test('find falls back to all project dirs when the cwd dir has no match', async () => {
  const { root, dir, job, index } = await setup();
  await writeTranscript(dir, 'unrelated', [userLine(card('j1', 'zzz'))]);
  await writeTranscript(path.join(root, 'elsewhere'), 'A', [userLine(card('j1', 'a1'))]);
  assert.equal((await index.find(job, { attemptId: 'a1' })).claudeSessionId, 'A');
});

test('find falls back when the cwd dir does not exist', async () => {
  const { root, job, index } = await setup();
  await writeTranscript(path.join(root, 'elsewhere'), 'A', [userLine(card('j1', 'a1'))]);
  assert.equal((await index.find(job, { attemptId: 'a1' })).claudeSessionId, 'A');
});

test('fallback match reports the transcript own cwd', async () => {
  const { root, job, index } = await setup();
  await writeTranscript(path.join(root, 'elsewhere'), 'A', [userLine(card('j1', 'a1'), { cwd: '/real/cwd' })]);
  assert.equal((await index.find(job, { attemptId: 'a1' })).cwd, '/real/cwd');
});

test('find falls back to the worktree when the transcript records no cwd', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'))]);
  assert.equal((await index.find(job, { attemptId: 'a1' })).cwd, WORKTREE);
});

test('find ignores unrelated sessions in the same project dir', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'chat', [userLine('hello'), asst('m1', 'claude-opus-5-5', USAGE)]);
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'))]);
  assert.equal((await index.find(job, { attemptId: 'a1' })).claudeSessionId, 'A');
});

const row = (id, model, usage) => ({ id, model, usage });
const OPUS = 'claude-opus-5-5';

test('summarizeUsage counts a repeated message.id once', () => {
  const one = summarizeUsage([row('m', OPUS, USAGE)], { truncated: false });
  const three = summarizeUsage([row('m', OPUS, USAGE), row('m', OPUS, USAGE), row('m', OPUS, USAGE)], { truncated: false });
  assert.equal(three.outputTokens, 20);
  assert.equal(three.knownCostUsd, one.knownCostUsd);
  assert.equal(three.conflicts, 0);
  assert.equal(three.complete, true);
  assert.equal(three.byModel[OPUS].tokens, 38);
});

test('summarizeUsage keeps the largest output_tokens row for conflicting repeats and counts a conflict', () => {
  const s = summarizeUsage([row('m', OPUS, { ...USAGE, output_tokens: 5 }), row('m', OPUS, { ...USAGE, output_tokens: 50 }), row('m', OPUS, { ...USAGE, output_tokens: 7 })], { truncated: false });
  assert.equal(s.outputTokens, 50);
  assert.equal(s.conflicts, 1);
  assert.equal(s.complete, true);
});

test('summarizeUsage counts an id-less row once and as a conflict', () => {
  const s = summarizeUsage([row(null, OPUS, USAGE)], { truncated: false });
  assert.equal(s.outputTokens, 20);
  assert.equal(s.conflicts, 1);
});

test('find and usage destroy every stream they open', async () => {
  const { dir, job, root } = await setup();
  const streams = [];
  const index = createTranscriptIndex({ projectsRoot: root, fsImpl: { createReadStream: (...a) => { const st = createReadStream(...a); streams.push(st); return st; } } });
  const many = [userLine('x'), ...Array.from({ length: 60 }, () => userLine('filler'))];
  await writeTranscript(dir, 'nocard', many);
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1')), asst('m1', OPUS, USAGE)]);
  const found = await index.find(job, { attemptId: 'a1' });
  await index.usage(found);
  await index.verify(found, { jobId: 'j1', attemptId: 'a1' });
  assert.ok(streams.length >= 4);
  assert.ok(streams.every((s) => s.destroyed));
});

test('summarizeUsage reports an unpriced model as incomplete with tokens but no cost', () => {
  const s = summarizeUsage([row('m', 'mystery-model', USAGE)], { truncated: false });
  assert.deepEqual(s.unpricedModels, ['mystery-model']);
  assert.equal(s.complete, false);
  assert.equal(s.knownCostUsd, 0);
  assert.equal(s.byModel['mystery-model'].costUsd, null);
  assert.equal(s.byModel['mystery-model'].tokens, 38);
});

test('summarizeUsage marks a truncated input incomplete', () => {
  assert.equal(summarizeUsage([row('m', OPUS, USAGE)], { truncated: true }).complete, false);
});

test('usage sums main and subagent files and flags a truncated line', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1')), asst('m1', OPUS, USAGE), asst('m1', OPUS, USAGE)], { sub: { s1: [asst('m2', OPUS, USAGE)] } });
  const found = await index.find(job, { attemptId: 'a1' });
  const usage = await index.usage(found);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.complete, true);
  assert.ok(usage.knownCostUsd > 0);

  await fs.appendFile(found.file, '{"type":"assistant","mess');
  assert.equal((await index.usage(found)).complete, false);
});

test('usage caches by fingerprint and re-reads when a file changes', async () => {
  const { dir, job, root } = await setup();
  let reads = 0;
  const index = createTranscriptIndex({ projectsRoot: root, fsImpl: { createReadStream: (...a) => { reads += 1; return createReadStream(...a); } } });
  const file = await writeTranscript(dir, 'A', [userLine(card('j1', 'a1')), asst('m1', OPUS, USAGE)]);
  const found = await index.find(job, { attemptId: 'a1' });
  const before = reads;
  const first = await index.usage(found);
  const afterFirst = reads;
  assert.equal(afterFirst, before + 1);
  const again = await index.usage(found);
  assert.equal(reads, afterFirst);
  assert.equal(again.fingerprint, first.fingerprint);
  await fs.appendFile(file, JSON.stringify(asst('m2', OPUS, USAGE)) + '\n');
  assert.equal((await index.usage(found)).outputTokens, 40);
});

test('adding or deleting a subagent invalidates the fingerprint while reusing the same match', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1')), asst('m1', OPUS, USAGE)]);
  const found = await index.find(job, { attemptId: 'a1' });
  const base = await index.usage(found);

  const subDir = path.join(dir, 'A', 'subagents');
  await fs.mkdir(subDir, { recursive: true });
  const subFile = path.join(subDir, 's1.jsonl');
  await fs.writeFile(subFile, JSON.stringify(asst('m2', OPUS, USAGE)) + '\n');
  const added = await index.usage(found);
  assert.notEqual(added.fingerprint, base.fingerprint);
  assert.equal(added.outputTokens, 40);

  await fs.rm(subFile);
  const removed = await index.usage(found);
  assert.equal(removed.fingerprint, base.fingerprint);
  assert.equal(removed.outputTokens, 20);
});

test('verify is true for a still-matching file', async () => {
  const { dir, job, index } = await setup();
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'))]);
  const found = await index.find(job, { attemptId: 'a1' });
  assert.equal(await index.verify(found, { jobId: 'j1', attemptId: 'a1' }), true);
});

test('verify is false when the file is deleted', async () => {
  const { dir, job, index } = await setup();
  const file = await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'))]);
  const found = await index.find(job, { attemptId: 'a1' });
  await fs.rm(file);
  assert.equal(await index.verify(found, { jobId: 'j1', attemptId: 'a1' }), false);
});

test('verify is false when the card no longer matches', async () => {
  const { dir, job, index } = await setup();
  const file = await writeTranscript(dir, 'A', [userLine(card('j1', 'a1'))]);
  const found = await index.find(job, { attemptId: 'a1' });
  await writeTranscript(dir, 'A', [userLine(card('j1', 'a2'))]);
  assert.equal(await index.verify(found, { jobId: 'j1', attemptId: 'a1' }), false);
  assert.equal(file, found.file);
});
