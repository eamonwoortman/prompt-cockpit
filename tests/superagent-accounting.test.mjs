import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, deferred, ev, missingTranscripts, provisionedEvents, T0 } from './superagent-helpers.mjs';
import { createSuperagentStore, deriveJob } from '../src/superagent/store.js';
import { createAccounting, USAGE_FILE } from '../src/superagent/accounting.js';
import { snapshotArtifact } from '../src/superagent/artifacts.js';
import { MILESTONE_1_PIPELINE, MILESTONE_2_PIPELINE } from '../src/superagent/config.js';
import { primaryRepo } from '../src/superagent/results.js';
import { artifactPath } from '../src/superagent/view-model.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Scripted transcripts index: find/usage/verify answer from `script`, and
// every call is counted.
function fakeTranscripts(file) {
  const script = { find: { status: 'found', claudeSessionId: 'claude-1', file, cwd: '/work/tree' }, fingerprint: 'fp1', cost: 1.5, verify: true };
  const calls = { find: [], usage: 0, verify: 0 };
  return {
    script,
    calls,
    async find(job, attempt) {
      calls.find.push(attempt.attemptId);
      return typeof script.find === 'function' ? script.find(job, attempt) : script.find;
    },
    async usage() {
      calls.usage += 1;
      return {
        knownCostUsd: script.cost,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        byModel: { 'claude-opus-5-5': { costUsd: script.cost, tokens: 18 } },
        unpricedModels: [],
        complete: true,
        conflicts: 0,
        fingerprint: script.fingerprint,
      };
    },
    async verify() {
      calls.verify += 1;
      return script.verify;
    },
  };
}

const attempt = (over = {}) => ({ attemptId: 'a1', phase: 'spec', task: null, sessionId: 's1', startedAt: T0, outcome: 'done', reason: null, ...over });
const job = (over = {}) => ({ jobId: 'j1', state: 'running', repos: [], attempts: [attempt()], ...over });

async function setup(over = {}) {
  const root = await tempDir('sa-acct-');
  const store = createSuperagentStore({ rootDir: path.join(root, 'jobs'), logImpl: () => {} });
  const file = path.join(root, 'projects', 'claude-1.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{}\n');
  const transcripts = over.transcripts ?? fakeTranscripts(file);
  const live = new Set();
  const logs = [];
  const build = (more = {}) => createAccounting({ store, transcripts, isLive: (id) => live.has(id), logImpl: (line) => logs.push(line), ...over, ...more });
  const acc = build();
  const usageFile = (jobId = 'j1') => path.join(store.jobDir(jobId), USAGE_FILE);
  const doc = (jobId = 'j1') => JSON.parse(readFileSync(usageFile(jobId), 'utf8'));
  const run = async (jobs, a = acc) => {
    a.enqueue(jobs);
    await a.idle();
  };
  return { root, store, file, transcripts, live, logs, acc, build, usageFile, doc, run };
}

test('an ended attempt is written provisional with its fingerprint', async () => {
  const h = await setup();
  await h.run([job()]);
  const entry = h.doc().attempts.a1;
  assert.equal(h.doc().format, 1);
  assert.deepEqual(entry, {
    state: 'provisional',
    claudeSessionId: 'claude-1',
    file: h.file,
    cwd: '/work/tree',
    fingerprint: 'fp1',
    knownCostUsd: 1.5,
    tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
    byModel: { 'claude-opus-5-5': { costUsd: 1.5, tokens: 18 } },
    unpricedModels: [],
    complete: true,
    conflicts: 0,
    scannedAt: entry.scannedAt,
  });
  assert.equal(typeof entry.scannedAt, 'number');
});

test('a provisional entry is refreshed when the fingerprint changes', async () => {
  const h = await setup();
  await h.run([job()]);
  Object.assign(h.transcripts.script, { fingerprint: 'fp2', cost: 2.25 });
  await h.run([job()]);
  const entry = h.doc().attempts.a1;
  assert.equal(entry.state, 'provisional');
  assert.equal(entry.fingerprint, 'fp2');
  assert.equal(entry.knownCostUsd, 2.25);
});

test('an entry becomes final only when the session is not live and the fingerprint is unchanged across two runs', async () => {
  const h = await setup();
  h.live.add('s1');
  await h.run([job()]);
  await h.run([job()]);
  assert.equal(h.doc().attempts.a1.state, 'provisional', 'still live');
  h.live.delete('s1');
  h.transcripts.script.fingerprint = 'fp2';
  await h.run([job()]);
  assert.equal(h.doc().attempts.a1.state, 'provisional', 'fingerprint changed');
  await h.run([job()]);
  assert.equal(h.doc().attempts.a1.state, 'final');
  assert.equal(h.doc().attempts.a1.fingerprint, 'fp2');
});

test('a final entry is never rescanned', async () => {
  const h = await setup();
  await h.run([job()]);
  await h.run([job()]);
  assert.equal(h.doc().attempts.a1.state, 'final');
  const { usage, find } = { usage: h.transcripts.calls.usage, find: h.transcripts.calls.find.length };
  await h.run([job()]);
  const fresh = h.build();
  await h.run([job()], fresh);
  await h.run([job()], fresh);
  assert.equal(h.transcripts.calls.usage, usage);
  assert.equal(h.transcripts.calls.find.length, find);
});

for (const status of ['missing', 'ambiguous']) {
  test(`${status} is retried and recorded final-unknown after finalMissingAfter runs on a finished job`, async () => {
    const h = await setup();
    h.transcripts.script.find = status === 'missing' ? { status } : { status, files: ['x', 'y'] };
    for (let i = 0; i < 4; i++) await h.run([job()]);
    assert.equal(existsSync(h.usageFile()), false, 'an unfinished job records nothing');
    const finished = await setup();
    finished.transcripts.script.find = h.transcripts.script.find;
    await finished.run([job({ state: 'stopped' })]);
    await finished.run([job({ state: 'stopped' })]);
    assert.equal(existsSync(finished.usageFile()), false);
    await finished.run([job({ state: 'stopped' })]);
    assert.deepEqual(finished.doc().attempts.a1, { state: 'final', unknown: status, scannedAt: finished.doc().attempts.a1.scannedAt });
    await finished.run([job({ state: 'stopped' })]);
    assert.equal(finished.transcripts.calls.find.length, 3);
    const view = await finished.acc.usageForJob(job({ state: 'stopped' }));
    assert.deepEqual(view.get('a1'), { usage: { state: 'unknown', note: status }, transcript: { available: false, claudeSessionId: null, cwd: null } });
  });
}

test('a provisional entry whose transcript is gone is finalised with its last spend', async () => {
  const h = await setup();
  await h.run([job()]);
  h.transcripts.script.verify = false;
  h.transcripts.script.find = { status: 'missing' };
  for (let i = 0; i < 3; i++) await h.run([job({ state: 'done' })]);
  const entry = h.doc().attempts.a1;
  assert.equal(entry.state, 'final');
  assert.equal(entry.knownCostUsd, 1.5);
  assert.equal(entry.claudeSessionId, 'claude-1');
});

test('a running attempt is never persisted; usageForJob returns state live from a scan', async () => {
  const h = await setup();
  const running = job({ attempts: [attempt({ outcome: null })] });
  await h.run([running]);
  assert.equal(existsSync(h.usageFile()), false);
  assert.deepEqual(h.transcripts.calls.find, []);
  const view = (await h.acc.usageForJob(running)).get('a1');
  assert.equal(view.usage.state, 'live');
  assert.equal(view.usage.knownCostUsd, 1.5);
  assert.equal(view.usage.claudeSessionId, 'claude-1');
  assert.deepEqual(view.usage.tokens, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 });
  assert.deepEqual(view.transcript, { available: true, claudeSessionId: 'claude-1', cwd: '/work/tree' });
  assert.equal(existsSync(h.usageFile()), false, 'usageForJob never writes');
});

test('a gated attempt is not accounted', async () => {
  const h = await setup();
  const gated = job({ attempts: [attempt({ outcome: 'failed', reason: 'folder-changed', sessionId: null })] });
  await h.run([gated]);
  assert.deepEqual(h.transcripts.calls.find, []);
  assert.equal((await h.acc.usageForJob(gated)).has('a1'), false);
});

test('a throwing item is logged and does not stop the next item', async () => {
  const h = await setup();
  const found = h.transcripts.script.find;
  h.transcripts.script.find = (j, a) => {
    if (a.attemptId === 'a1') throw new Error('disk on fire');
    return found;
  };
  await h.run([job({ attempts: [attempt(), attempt({ attemptId: 'a2', sessionId: 's2' })] })]);
  assert.equal(h.doc().attempts.a1, undefined);
  assert.equal(h.doc().attempts.a2.state, 'provisional');
  assert.ok(h.logs.some((l) => l.includes('a1') && l.includes('disk on fire')), h.logs.join('\n'));
});

test('an enqueue with nothing to run does not stall later ones', async () => {
  const h = await setup();
  h.acc.enqueue([job({ attempts: [attempt({ outcome: null })] })]);
  await h.acc.idle();
  await h.run([job()]);
  assert.deepEqual(h.transcripts.calls.find, ['a1']);
});

test('enqueue twice for the same attempt runs it once', async () => {
  const h = await setup();
  h.acc.enqueue([job()]);
  h.acc.enqueue([job()]);
  await h.acc.idle();
  assert.deepEqual(h.transcripts.calls.find, ['a1']);
  assert.equal(h.transcripts.calls.usage, 1);
});

test('usageForJob prefers the usage.json entry over a scan', async () => {
  const h = await setup();
  await h.run([job()]);
  const fresh = h.build();
  const before = { usage: h.transcripts.calls.usage, find: h.transcripts.calls.find.length };
  h.transcripts.script.cost = 99;
  const view = (await fresh.usageForJob(job())).get('a1');
  assert.equal(view.usage.state, 'provisional');
  assert.equal(view.usage.knownCostUsd, 1.5);
  assert.deepEqual(view.transcript, { available: true, claudeSessionId: 'claude-1', cwd: '/work/tree' });
  assert.equal(h.transcripts.calls.usage, before.usage);
  assert.equal(h.transcripts.calls.find.length, before.find);
});

test('transcript availability comes from verify, cached by the file size and mtime', async () => {
  const h = await setup();
  await h.run([job()]);
  h.transcripts.script.verify = false;
  const fresh = h.build();
  const verifies = h.transcripts.calls.verify;
  const first = (await fresh.usageForJob(job())).get('a1');
  assert.equal(first.usage.knownCostUsd, 1.5, 'spend stays');
  assert.deepEqual(first.transcript, { available: false, claudeSessionId: 'claude-1', cwd: '/work/tree' });
  await fresh.usageForJob(job());
  assert.equal(h.transcripts.calls.verify, verifies + 1);
  await fs.appendFile(h.file, '{"more":true}\n');
  h.transcripts.script.verify = true;
  assert.equal((await fresh.usageForJob(job())).get('a1').transcript.available, true);
  assert.equal(h.transcripts.calls.verify, verifies + 2);
  await fs.rm(h.file);
  assert.equal((await fresh.usageForJob(job())).get('a1').transcript.available, false);
});

test('transcriptFor prefers a stored entry that still verifies, else find', async () => {
  const h = await setup();
  await h.run([job()]);
  const finds = h.transcripts.calls.find.length;
  assert.deepEqual(await h.acc.transcriptFor(job(), attempt()), { status: 'found', claudeSessionId: 'claude-1', file: h.file, cwd: '/work/tree' });
  assert.equal(h.transcripts.calls.find.length, finds);
  h.transcripts.script.verify = false;
  h.transcripts.script.find = { status: 'ambiguous', files: ['x', 'y'] };
  assert.deepEqual(await h.build().transcriptFor(job(), attempt()), { status: 'ambiguous', files: ['x', 'y'] });
  assert.equal(h.transcripts.calls.find.length, finds + 1);
});

test('writes keep unknown top-level keys of usage.json', async () => {
  const h = await setup();
  await fs.mkdir(path.dirname(h.usageFile()), { recursive: true });
  const snapshots = { spec: { attemptId: 'a0', state: 'done', at: 1 } };
  await fs.writeFile(h.usageFile(), JSON.stringify({ format: 1, attempts: {}, snapshots }));
  await h.run([job()]);
  assert.deepEqual(h.doc().snapshots, snapshots);
  assert.equal(h.doc().attempts.a1.state, 'provisional');
});

test('stop returns by its deadline even with a hung item', async () => {
  const h = await setup();
  h.transcripts.script.find = () => new Promise(() => {});
  h.acc.enqueue([job()]);
  await settle();
  const t0 = Date.now();
  await h.acc.stop({ deadline: Date.now() + 50 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 40 && elapsed < 1000, `took ${elapsed} ms`);
});

test('a stalled item that resumes after its time budget cannot write usage.json', async () => {
  const h = await setup({ itemBudgetMs: 20 });
  const gate = deferred();
  const usage = h.transcripts.usage;
  let resumed = false;
  h.transcripts.usage = async (found) => {
    await gate.promise;
    resumed = true;
    return usage(found);
  };
  await h.run([job()]);
  assert.ok(h.logs.some((l) => l.includes('a1') && l.includes('20 ms')), h.logs.join('\n'));
  gate.resolve();
  await sleep(30);
  await settle();
  assert.equal(resumed, true, 'the stalled item kept running');
  assert.equal(existsSync(h.usageFile()), false);
});

test('an item that resumes after stop cannot write', async () => {
  const h = await setup();
  const gate = deferred();
  const found = h.transcripts.script.find;
  h.transcripts.script.find = () => gate.promise.then(() => found);
  h.acc.enqueue([job()]);
  await settle();
  await h.acc.stop({ deadline: Date.now() });
  gate.resolve();
  await sleep(30);
  await settle();
  assert.equal(existsSync(h.usageFile()), false);
});

test('enqueue after stop is ignored', async () => {
  const h = await setup();
  await h.acc.stop({ deadline: Date.now() });
  await h.run([job()]);
  assert.deepEqual(h.transcripts.calls.find, []);
  assert.equal(existsSync(h.usageFile()), false);
});

test('stop uses the caller\'s absolute deadline', async () => {
  const clock = { t: 5_000_000 };
  const h = await setup({ now: () => clock.t });
  h.transcripts.script.find = () => new Promise(() => {});
  h.acc.enqueue([job()]);
  await settle();
  let t0 = Date.now();
  await h.acc.stop({ deadline: clock.t - 1 });
  assert.ok(Date.now() - t0 < 30, 'a deadline already passed by the injected clock returns at once');

  const again = h.build();
  again.enqueue([job()]);
  await settle();
  t0 = Date.now();
  await again.stop({ deadline: clock.t + 60 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 50 && elapsed < 1000, `waited ${elapsed} ms for a deadline 60 ms past the injected clock`);
});

// Snapshot items (R2-2): a derived milestone-2 job over a temp worktree, its
// artifacts in the ledger unless a test asks for a legacy job.
const started = (attemptId, phase, over = {}) => ({ type: 'attempt-started', attemptId, phase, role: 'r', model: 'm', n: 1, purpose: 'author', ...over });
const ended = (attemptId, outcome = 'done', reason = null) => ({ type: 'attempt-ended', attemptId, outcome, reason });

async function snapshotSetup(over = {}) {
  const h = await setup({ transcripts: missingTranscripts(), ...over });
  const worktree = path.join(h.root, 'worktree');
  await fs.mkdir(worktree);
  const derive = (events, created = {}) => {
    const all = [...provisionedEvents({ pipeline: MILESTONE_2_PIPELINE, artifactRoot: 'ledger', ...created }), ...events];
    const j = deriveJob(all.map((e, i) => ({ seq: i + 1, at: T0 + i, ...e })));
    primaryRepo(j).worktree = worktree;
    return j;
  };
  const write = async (key, text, j) => {
    const file = path.join(worktree, artifactPath(j, key));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const snapshot = (key, jobId = 'j1') => {
    try {
      return readFileSync(path.join(h.store.jobDir(jobId), 'artifacts', encodeURIComponent(key)), 'utf8');
    } catch {
      return undefined;
    }
  };
  const progress = (jobId = 'j1') => (existsSync(h.usageFile(jobId)) ? h.doc(jobId).snapshots ?? {} : {});
  return { ...h, worktree, derive, write, snapshot, progress };
}

test('a snapshot item copies the keys its attempt is the latest writer of', async () => {
  const h = await snapshotSetup();
  const j = h.derive([
    started('s1', 'spec'), ended('s1'), ev.phaseCompleted('spec', 1),
    started('r1', 'spec-review', { purpose: 'review', round: 1 }), ended('r1'),
    started('f1', 'spec-review', { purpose: 'fix', round: 1 }), ended('f1'),
  ]);
  assert.equal(artifactPath(j, 'spec'), '.superpowers/superagent/j1/artifacts/spec.md');
  await h.write('spec', 'revised spec', j);
  await h.write('review:spec-review:1', 'findings', j);
  await h.write('response:spec-review:1', 'response', j);
  const attempts = { s1: { state: 'final', unknown: 'missing', scannedAt: 1 } };
  await fs.mkdir(path.dirname(h.usageFile()), { recursive: true });
  await fs.writeFile(h.usageFile(), JSON.stringify({ format: 1, attempts, other: 'kept' }));
  await h.run([j]);
  assert.equal(h.snapshot('spec'), 'revised spec');
  assert.equal(h.snapshot('review:spec-review:1'), 'findings');
  assert.equal(h.snapshot('response:spec-review:1'), 'response');
  const p = h.progress();
  assert.deepEqual(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, [v.attemptId, v.state]])), {
    spec: ['f1', 'done'],
    'review:spec-review:1': ['r1', 'done'],
    'response:spec-review:1': ['f1', 'done'],
  });
  assert.equal(typeof p.spec.at, 'number');
  assert.equal(h.doc().format, 1);
  assert.deepEqual(h.doc().attempts, attempts, 'snapshot progress leaves the usage entries alone');
  assert.equal(h.doc().other, 'kept');
});

test('a finished legacy job with readable artifacts and no transcript gets its snapshots', async () => {
  const h = await snapshotSetup();
  const j = h.derive([started('s1', 'spec'), ended('s1'), { type: 'job-stopped' }], { pipeline: MILESTONE_1_PIPELINE, artifactRoot: null });
  assert.equal(j.workflow, null);
  assert.equal(artifactPath(j, 'spec'), `docs/superpowers/specs/${j.createdDate}-${j.slug}-design.md`);
  assert.equal(j.attempts[0].sessionId, null);
  await h.write('spec', 'the spec', j);
  await h.run([j]);
  assert.equal(h.snapshot('spec'), 'the spec');
  assert.equal(h.progress().spec.state, 'done');
});

test('a live attempt is snapshotted once its session ends, and a gated one never', async () => {
  const h = await snapshotSetup();
  const j = h.derive([
    started('s1', 'spec'), { type: 'attempt-session', attemptId: 's1', sessionId: 'sess-1' }, ended('s1'), ev.phaseCompleted('spec', 1),
    started('r1', 'spec-review', { purpose: 'review', round: 1 }), ended('r1', 'failed', 'folder-changed'),
  ]);
  await h.write('spec', 'the spec', j);
  await h.write('review:spec-review:1', 'stale', j);
  h.live.add('sess-1');
  await h.run([j]);
  assert.equal(h.snapshot('spec'), undefined, 'still live');
  h.live.delete('sess-1');
  await h.run([j]);
  assert.equal(h.snapshot('spec'), 'the spec');
  assert.equal(h.snapshot('review:spec-review:1'), undefined);
  assert.equal(h.progress()['review:spec-review:1'], undefined);
});

test('a failed copy is retried and later succeeds', async () => {
  let calls = 0;
  const snapshotImpl = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('disk full');
    return snapshotArtifact(...args);
  };
  const h = await snapshotSetup({ snapshotImpl });
  const j = h.derive([started('s1', 'spec'), ended('s1')]);
  await h.write('spec', 'the spec', j);
  await h.run([j]);
  assert.equal(h.progress().spec.state, 'failed');
  assert.equal(h.progress().spec.attemptId, 's1');
  assert.ok(h.logs.some((l) => l.includes('spec') && l.includes('disk full')), h.logs.join('\n'));
  await h.run([j]);
  assert.equal(h.progress().spec.state, 'done');
  assert.equal(h.snapshot('spec'), 'the spec');
  await h.run([j]);
  await h.run([j], h.build());
  assert.equal(calls, 2, 'done is final for that writer');
});

test('two writers of the same key: the later one wins even when the earlier one\'s copy is retried last', async () => {
  const copied = [];
  let failFirst = true;
  const snapshotImpl = async (j, key, opts) => {
    copied.push(j.attempts.at(-1).attemptId);
    if (failFirst) {
      failFirst = false;
      throw new Error('locked');
    }
    return snapshotArtifact(j, key, opts);
  };
  const h = await snapshotSetup({ snapshotImpl });
  const first = h.derive([started('a1', 'spec'), ended('a1')]);
  await h.write('spec', 'v1', first);
  await h.run([first]);
  assert.deepEqual(h.progress().spec, { ...h.progress().spec, attemptId: 'a1', state: 'failed' });

  const second = h.derive([started('a1', 'spec'), ended('a1'), started('a2', 'spec'), ended('a2')]);
  await h.write('spec', 'v2', second);
  await h.run([second]);
  assert.equal(h.progress().spec.attemptId, 'a2');
  assert.equal(h.snapshot('spec'), 'v2');

  await h.run([first]);
  assert.deepEqual(copied, ['a1', 'a2'], 'the stale retry of a1 copies nothing');
  assert.equal(h.progress().spec.attemptId, 'a2');
  assert.equal(h.progress().spec.state, 'done');
});

test('a snapshot write after stop or past its time budget is refused', async () => {
  for (const how of ['stop', 'budget']) {
    const gate = deferred();
    const snapshotImpl = async (j, key, opts) => {
      await gate.promise;
      return snapshotArtifact(j, key, opts);
    };
    const h = await snapshotSetup({ snapshotImpl, itemBudgetMs: how === 'budget' ? 20 : 10_000 });
    const j = h.derive([started('s1', 'spec'), ended('s1')]);
    await h.write('spec', 'the spec', j);
    h.acc.enqueue([j]);
    await settle();
    if (how === 'stop') await h.acc.stop({ deadline: Date.now() });
    else await h.acc.idle();
    gate.resolve();
    await sleep(30);
    await settle();
    assert.equal(h.snapshot('spec'), undefined, how);
    assert.deepEqual(h.progress(), {}, how);
  }
});
