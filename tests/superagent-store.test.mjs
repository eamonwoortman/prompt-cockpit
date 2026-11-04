import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSuperagentStore, deriveJob } from '../src/superagent/store.js';
import { tempDir, jobCreated, provisionedEvents } from './superagent-helpers.mjs';

const quiet = () => {};
const stamp = (events) => events.map((e, i) => ({ seq: i + 1, at: 1000 + i, ...e }));

test('a torn final line is ignored and the next append starts on a fresh line', async () => {
  const rootDir = await tempDir('sa-store-');
  const a = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  await a.append('j1', jobCreated());
  await a.append('j1', { type: 'needs-you', reason: 'stuck', detail: {} });
  const file = path.join(rootDir, 'j1', 'events.jsonl');
  await fs.appendFile(file, '{"seq":3,"type":"job-acc');
  const logs = [];
  const b = createSuperagentStore({ rootDir, now: () => 2000, logImpl: (m) => logs.push(m) });
  assert.equal((await b.load('j1')).state, 'needs-you');
  const ev = await b.append('j1', { type: 'job-stopped' });
  assert.equal(ev.seq, 3);
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) JSON.parse(line);
  assert.equal((await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1')).state, 'stopped');
  assert.deepEqual(logs, [`superagent: dropped a torn final line in ${file}`]);
});

test('append assigns increasing seq and at, and load returns the same events', async () => {
  const rootDir = await tempDir('sa-store-');
  let t = 5000;
  const store = createSuperagentStore({ rootDir, now: () => t++, logImpl: quiet });
  const evs = [];
  for (const e of provisionedEvents()) evs.push(await store.append('j1', e));
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(evs.map((e) => e.at), [5000, 5001, 5002]);
  assert.equal(evs[2].type, 'job-provisioned');
  const job = await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1');
  assert.equal(job.lastSeq, 3);
  assert.equal(job.createdAt, 5000);
  assert.equal(job.state, 'running');
  assert.deepEqual(job, deriveJob(evs));
});

test('a corrupt middle line is refused and left on disk', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  for (const e of provisionedEvents()) await store.append('j1', e);
  await store.flush();
  const file = path.join(rootDir, 'j1', 'events.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).split('\n');
  lines[1] = 'nope';
  await fs.writeFile(file, lines.join('\n'));
  const before = await fs.readFile(file);
  const fresh = createSuperagentStore({ rootDir, logImpl: quiet });
  await assert.rejects(fresh.load('j1'), { code: 'ERR_EVENTS_CORRUPT', line: 2 });
  await assert.rejects(fresh.append('j1', { type: 'job-stopped' }), { code: 'ERR_EVENTS_CORRUPT', line: 2 });
  await fresh.flush();
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(fresh.get('j1'), null);
});

test('deriveJob tracks provisioning, attempts, outcomes and phase advance', () => {
  const events = [jobCreated()];
  assert.equal(deriveJob(stamp(events)).state, 'provisioning');
  const [, worktree, provisioned] = provisionedEvents();
  events.push(worktree);
  let job = deriveJob(stamp(events));
  assert.equal(job.state, 'provisioning');
  assert.equal(job.repos[0].worktree, worktree.worktree);
  assert.equal(job.repos[0].baseSha, 'base');
  events.push(provisioned);
  assert.equal(deriveJob(stamp(events)).state, 'running');
  const started = { type: 'attempt-started', phase: 'spec', task: null, role: 'spec-writer', model: 'claude-opus-5-5', dir: '/d' };
  events.push(
    { ...started, attemptId: 'a1', n: 1, recovery: false, previousAttemptId: null },
    { type: 'attempt-session', attemptId: 'a1', sessionId: 's1' },
    { type: 'attempt-ended', attemptId: 'a1', outcome: 'failed', reason: 'no-result' },
    { ...started, attemptId: 'a2', n: 2, recovery: true, previousAttemptId: 'a1' },
    { type: 'attempt-ended', attemptId: 'a2', outcome: 'done', summary: 'wrote the spec' },
  );
  job = deriveJob(stamp(events));
  assert.equal(job.attempts.length, 2);
  assert.equal(job.attempts[0].sessionId, 's1');
  assert.equal(job.attempts[0].reason, 'no-result');
  assert.equal(job.attempts[1].recovery, true);
  assert.equal(job.attempts[1].previousAttemptId, 'a1');
  assert.equal(job.attempts[1].summary, 'wrote the spec');
  assert.equal(job.phaseIndex, 1);
  assert.equal(job.phaseId, 'accept');
  assert.equal(job.state, 'running');
  events.push({ type: 'needs-you', reason: 'ready-to-try', detail: { text: 'try it' } });
  job = deriveJob(stamp(events));
  assert.equal(job.state, 'needs-you');
  assert.equal(job.reason, 'ready-to-try');
  assert.deepEqual(job.detail, { text: 'try it' });
  events.push({ type: 'job-accepted' });
  job = deriveJob(stamp(events));
  assert.equal(job.state, 'done');
  assert.equal(job.lastSeq, events.length);
  assert.throws(() => deriveJob(stamp([{ type: 'job-provisioned' }])));
});

test('state.json mirrors deriveJob and a stale state.json is ignored on load', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  const events = [];
  for (const e of provisionedEvents()) events.push(await store.append('j1', e));
  await store.flush();
  const stateFile = path.join(rootDir, 'j1', 'state.json');
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), deriveJob(events));
  assert.deepEqual(store.get('j1'), deriveJob(events));
  await fs.writeFile(stateFile, JSON.stringify({ state: 'done' }));
  assert.equal((await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1')).state, 'running');
});

test('concurrent appends to one job land in call order with unique seq', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  await store.append('j1', jobCreated());
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    store.append('j1', { type: 'needs-you', reason: 'question', detail: { i } })));
  assert.deepEqual(results.map((e) => e.seq), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const lines = (await fs.readFile(path.join(rootDir, 'j1', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.slice(1).map((e) => [e.seq, e.detail.i]), Array.from({ length: 10 }, (_, i) => [i + 2, i]));
  await store.flush();
});

test('job ids must be safe path segments and listJobIds returns only those directories', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  assert.deepEqual(await store.listJobIds(), []);
  await store.append('j1', jobCreated());
  await store.append('j2', jobCreated({ jobId: 'j2' }));
  await fs.writeFile(path.join(rootDir, 'stray.txt'), '');
  assert.deepEqual(await store.listJobIds(), ['j1', 'j2']);
  assert.throws(() => store.jobDir('../escape'));
  await assert.rejects(store.append('..', jobCreated()));
  await assert.rejects(store.append('j1', { type: 'not-a-type' }));
  await store.flush();
});

test('a short write rejects the append, keeps get() on the last good state and the next append repairs the tail', async () => {
  const rootDir = await tempDir('sa-store-');
  let shortNext = false;
  const openImpl = async (file, flags) => {
    const fh = await fs.open(file, flags);
    if (flags !== 'a' || !shortNext) return fh;
    shortNext = false;
    return {
      write: (buf) => fh.write(buf, 0, Math.floor(buf.length / 2)),
      datasync: () => fh.datasync(),
      close: () => fh.close(),
    };
  };
  const logs = [];
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: (m) => logs.push(m), openImpl });
  for (const e of provisionedEvents()) await store.append('j1', e);
  shortNext = true;
  await assert.rejects(store.append('j1', { type: 'needs-you', reason: 'stuck', detail: {} }), /short write/);
  const kept = store.get('j1');
  assert.notEqual(kept, null);
  assert.equal(kept.state, 'running');
  assert.equal(kept.lastSeq, 3);
  const ev = await store.append('j1', { type: 'job-stopped' });
  assert.equal(ev.seq, 4);
  await store.flush();
  const file = path.join(rootDir, 'j1', 'events.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(logs, [`superagent: dropped a torn final line in ${file}`]);
  assert.equal(store.get('j1').state, 'stopped');
  assert.equal((await createSuperagentStore({ rootDir, logImpl: quiet }).load('j1')).state, 'stopped');
});

test('an append rejected inside the chain does not disturb the next append', async () => {
  const rootDir = await tempDir('sa-store-');
  const store = createSuperagentStore({ rootDir, now: () => 1000, logImpl: quiet });
  await store.append('j1', jobCreated());
  const [rejected, next] = await Promise.allSettled([
    store.append('j1', jobCreated()),
    store.append('j1', { type: 'job-provisioned' }),
  ]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(next.status, 'fulfilled');
  assert.equal(next.value.seq, 2);
  assert.equal(store.get('j1').state, 'running');
  await store.flush();
  const lines = (await fs.readFile(path.join(rootDir, 'j1', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.seq, e.type]), [[1, 'job-created'], [2, 'job-provisioned']]);
});
