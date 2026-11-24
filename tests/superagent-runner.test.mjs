import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { fakeStartSession } from './test-helpers.mjs';
import { execFileSync } from 'node:child_process';
import { tempDir, initRepo, jobCreated, sessionFactory, scriptedWorker, liveJob, launchAction, ids, deferred, taskCreated, T0, MIN } from './superagent-helpers.mjs';
import { createSuperagentStore } from '../src/superagent/store.js';
import { MILESTONE_2_PIPELINE, defaultConfig } from '../src/superagent/config.js';
import { createWorktree } from '../src/superagent/worktree.js';
import { RESULT_FILE, artifactPaths, attemptDir, readResult, reviewPaths } from '../src/superagent/results.js';
import { UNATTENDED_DENY_MESSAGE, denyMessageFor, nudgeText } from '../src/superagent/prompts.js';
import { createRunner, extractResultJson, PROGRESS_TYPES } from '../src/superagent/runner.js';
import { writeJsonAtomic } from '../src/json-store.js';

const quiet = () => {};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Task 5 owns real validation; here only identity and status matter.
async function stubValidate(value, { expected }) {
  const errors = [];
  for (const key of ['jobId', 'phaseId', 'taskId', 'attemptId']) {
    if (value?.[key] !== (expected[key] ?? null)) errors.push(`identity mismatch: ${key}`);
  }
  if (!['done', 'blocked', 'failed'].includes(value?.status)) errors.push('status must be one of done|blocked|failed');
  return errors.length ? { ok: false, errors } : { ok: true, result: { ...value, question: value.question ?? null, commits: [] } };
}

const results = { readResult, validateResult: stubValidate };

async function setup({ pipeline } = {}) {
  const root = await tempDir('sa-runner-');
  const store = createSuperagentStore({ rootDir: path.join(root, 'jobs'), now: () => T0, logImpl: quiet });
  const repos = [
    { id: 'primary', origin: path.join(root, 'origin') },
    { id: 'extra', origin: path.join(root, 'extra-origin') },
  ];
  const newJob = (jobId = 'j1') => liveJob(store, { jobId, repos, ...(pipeline ? { pipeline } : {}) });
  const job = await newJob();
  const events = async (jobId = job.jobId) => {
    const text = await fs.readFile(path.join(store.jobDir(jobId), 'events.jsonl'), 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  const ended = async (jobId = job.jobId) => (await events(jobId)).filter((e) => e.type === 'attempt-ended');
  return { root, store, job, newJob, events, ended };
}

function failingStore(store, failures) {
  return {
    ...store,
    append(jobId, event) {
      if ((failures[event.type] ?? 0) > 0) {
        failures[event.type]--;
        return Promise.reject(new Error(`injected ${event.type} failure`));
      }
      return store.append(jobId, event);
    },
  };
}

function rejectionSpy() {
  const seen = [];
  const on = (reason) => seen.push(reason);
  process.on('unhandledRejection', on);
  return {
    seen,
    async stop() {
      await tick();
      await tick();
      process.off('unhandledRejection', on);
    },
  };
}

const lastAttempt = (store, jobId) => store.get(jobId).attempts.at(-1);

function endTurn(impl, subtype = 'success') {
  impl.emitMessage({ type: 'result', subtype });
  impl.emitState('idle');
}

async function writeValidResult(job, attempt, over = {}) {
  const spec = path.join(job.repos[0].worktree, ...artifactPaths(job).spec.split('/'));
  await fs.mkdir(path.dirname(spec), { recursive: true });
  await fs.writeFile(spec, '# Hello design\n');
  await fs.mkdir(attempt.dir, { recursive: true });
  await fs.writeFile(path.join(attempt.dir, RESULT_FILE), JSON.stringify({
    jobId: job.jobId,
    phaseId: 'spec',
    taskId: null,
    attemptId: attempt.attemptId,
    status: 'done',
    artifacts: [artifactPaths(job).spec],
    summary: 'Wrote the hello design.',
    question: null,
    ...over,
  }));
}

const assistantMessage = () => ({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 1, output_tokens: 1 } },
});

// Plan 5: the brainstorm roles. Their templates arrive in Task 7, so tests
// write them into the project override dir (Decision 15).
const Q1 = { id: 'Q1', text: 'Which database?' };
const Q2 = { id: 'Q2', text: 'Which port?' };
const answerOf = (id, tag = 'from-idea') => ({ id, tag, answer: `${id} answer`, reason: `${id} reason` });
const standInAction = (over = {}) => launchAction({ phase: 'brainstorm', role: 'stand-in', maxTurns: 8, purpose: 'answer', openQuestions: [Q1, Q2], askedIds: null, ...over });
const brainstormerAction = (over = {}) => launchAction({ phase: 'brainstorm', role: 'brainstormer', purpose: 'ask', openQuestions: null, askedIds: [], ...over });
const answerBody = (over = {}) => ({ status: 'done', artifacts: [], summary: 'Answered both.', question: null, answers: [answerOf('Q1'), answerOf('Q2', 'assumed')], ...over });

async function writeBrainstormTemplates(projectDir) {
  const overrides = path.join(projectDir, '.superpowers', 'superagent', 'prompts');
  await fs.mkdir(overrides, { recursive: true });
  await fs.writeFile(path.join(overrides, 'brainstormer.md'), '# Brainstormer\n');
  await fs.writeFile(path.join(overrides, 'stand-in.md'), '# Stand-in\n');
}

// A default-pipeline job (it has the brainstorm phase) with stubbed validation.
async function standInSetup(over = {}) {
  const s = await setup({ pipeline: defaultConfig().pipeline });
  await writeBrainstormTemplates(s.job.repos[0].origin);
  const factory = sessionFactory(registry);
  const runner = createRunner({ registry: factory.registry, store: s.store, results, now: () => T0, idImpl: ids(), logImpl: quiet, ...over });
  registry.addSessionRemovedListener(runner.onSessionRemoved);
  return { ...s, factory, runner };
}

function reply(impl, text, { idle = true } = {}) {
  impl.emitMessage({ type: 'result', subtype: 'success', result: text });
  impl.emitState(idle ? 'idle' : 'running');
}

const readJsonFile = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = (file) => fs.access(file).then(() => true, () => false);

test('progress types are the worker messages only', () => {
  assert.deepEqual([...PROGRESS_TYPES].sort(), ['assistant', 'result', 'user']);
});

test('the interceptor passes on rows it does not own', async () => {
  registry._reset();
  try {
    const { store, job } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addApprovalInterceptor(runner.onApprovalRequest);
    const { attemptId } = await runner.launch(job, launchAction());
    const worker = impls.get(store.get(job.jobId).attempts.at(-1).sessionId);
    const denied = await worker.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion');
    assert.deepEqual(denied, { behavior: 'deny', message: UNATTENDED_DENY_MESSAGE });
    const bash = await worker.emitApprovalRequest({ command: 'curl x' }, 'Bash');
    assert.equal(bash.behavior, 'deny');
    const handImpl = fakeStartSession();
    const handRow = registry.createSession({ cwd: '/elsewhere', startSessionImpl: handImpl });
    handImpl.emitApprovalRequest({ questions: [{ question: 'Human?' }] }, 'AskUserQuestion');
    assert.equal(handRow.pendingApprovals.length, 1, 'hand-driven question reaches the human');
    assert.ok(attemptId);
  } finally { registry._reset(); }
});

test('launch writes attempt-started before the session and passes explicit options', async () => {
  registry._reset();
  try {
    const { store, job } = await setup();
    const factory = sessionFactory(registry);
    const order = [];
    const recordingStore = { ...store, append: (jobId, event) => { order.push(`append:${event.type}`); return store.append(jobId, event); } };
    const reg = {
      ...factory.registry,
      createSession: (opts) => { order.push('createSession'); return factory.registry.createSession(opts); },
      sendInput: (id, text) => { order.push('sendInput'); return factory.registry.sendInput(id, text); },
    };
    const runner = createRunner({ registry: reg, store: recordingStore, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    const { attemptId } = await runner.launch(job, launchAction());
    assert.equal(attemptId, 'a1');
    assert.deepEqual(order, ['append:attempt-started', 'createSession', 'append:attempt-session', 'sendInput']);
    const opts = factory.calls[0];
    assert.equal(opts.cwd, job.repos[0].worktree);
    assert.equal(opts.provider, 'claude');
    assert.equal(opts.model, 'claude-opus-5-5');
    assert.equal(opts.permissionMode, 'auto');
    assert.equal(opts.name, null);
    assert.deepEqual(opts.sdkOptions.additionalDirectories, [job.repos[1].worktree]);
    assert.equal(opts.sdkOptions.maxTurns, 60);
    assert.equal(opts.sdkOptions.interceptEveryPermission, true);
    assert.match(opts.sdkOptions.appendSystemPrompt, /result\.json\.tmp/);
    const impl = [...factory.impls.values()][0];
    assert.ok(impl.allInputs[0].includes(attemptId));
    assert.equal(runner.liveCount(), 1);
    assert.equal(runner.isLive(job.jobId), true);
  } finally { registry._reset(); }
});

test('launch records handoff on attempt-started', async () => {
  registry._reset();
  try {
    const { store, job, events } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    await runner.launch(job, launchAction({ handoff: '/w/a1/handoff.md' }));
    const started = (await events()).filter((e) => e.type === 'attempt-started');
    assert.equal(started.at(-1).handoff, '/w/a1/handoff.md');
  } finally { registry._reset(); }
  registry._reset();
  try {
    const { store, job, events } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    await runner.launch(job, launchAction());
    const started = (await events()).filter((e) => e.type === 'attempt-started');
    assert.equal(started.at(-1).handoff, null);
    assert.equal('retryNote' in started.at(-1), false);
  } finally { registry._reset(); }
});

test('launch records a Retry note on attempt-started and the attempt', async () => {
  registry._reset();
  try {
    const { store, job, events } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    await runner.launch(job, launchAction({ retryNote: 'from code only' }));
    const started = (await events()).filter((e) => e.type === 'attempt-started');
    assert.equal(started.at(-1).retryNote, 'from code only');
    assert.equal(store.get(job.jobId).attempts.at(-1).retryNote, 'from code only');
  } finally { registry._reset(); }
});

test('a failed attempt-started append creates no session', async () => {
  registry._reset();
  try {
    const { store, job, events } = await setup();
    const { registry: reg } = sessionFactory(registry);
    const before = (await events()).length;
    const runner = createRunner({ registry: reg, store: failingStore(store, { 'attempt-started': 1 }), results, now: () => T0, idImpl: ids(), logImpl: quiet });
    assert.deepEqual(await runner.launch(job, launchAction()), { error: 'store-failed' });
    assert.equal(registry.list().length, 0);
    assert.equal(runner.isLive(job.jobId), false);
    assert.equal(runner.liveCount(), 0);
    assert.equal((await events()).length, before);
  } finally { registry._reset(); }
});

test('every later launch failure releases the reservation and leaves no session', async () => {
  registry._reset();
  const spy = rejectionSpy();
  try {
    const { store, newJob, events } = await setup();
    const assertClean = async (runner, jobId) => {
      await runner.drain();
      assert.equal(registry.list().length, 0, `${jobId}: no session left`);
      assert.equal(runner.isLive(jobId), false, `${jobId}: reservation released`);
      const last = (await events(jobId)).at(-1);
      assert.equal(last.type, 'attempt-ended');
      assert.equal(last.outcome, 'failed');
      assert.equal(last.reason, 'launch-failed');
    };

    const jobA = await newJob('ja');
    const runnerA = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    assert.deepEqual(await runnerA.launch(jobA, launchAction({ role: 'no-such-role' })), { error: 'launch-failed' });
    await assertClean(runnerA, 'ja');

    const jobB = await newJob('jb');
    const factoryB = sessionFactory(registry);
    factoryB.failNextCreate(new Error('spawn failed'));
    const runnerB = createRunner({ registry: factoryB.registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    assert.deepEqual(await runnerB.launch(jobB, launchAction()), { error: 'launch-failed' });
    assert.equal(factoryB.calls.length, 1);
    await assertClean(runnerB, 'jb');

    const jobC = await newJob('jc');
    const runnerC = createRunner({ registry: sessionFactory(registry).registry, store: failingStore(store, { 'attempt-session': 1 }), results, now: () => T0, idImpl: ids(), logImpl: quiet });
    assert.deepEqual(await runnerC.launch(jobC, launchAction()), { error: 'launch-failed' });
    await assertClean(runnerC, 'jc');

    const jobD = await newJob('jd');
    const runnerD = createRunner({ registry: sessionFactory(registry).registry, store: failingStore(store, { 'attempt-session': 1, 'attempt-ended': 1 }), results, now: () => T0, idImpl: ids(), logImpl: quiet });
    assert.deepEqual(await runnerD.launch(jobD, launchAction()), { error: 'launch-failed' });
    await runnerD.drain();
    assert.equal((await events('jd')).filter((e) => e.type === 'attempt-ended').length, 0, 'no attempt-ended yet');
    assert.equal(runnerD.isLive('jd'), true, 'the end is pending');
    assert.equal(registry.list().length, 0, 'the session is closed even though the end is pending');
    await runnerD.review(store.get('jd'));
    await assertClean(runnerD, 'jd');
    assert.equal((await events('jd')).filter((e) => e.type === 'attempt-ended').length, 1);
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('a removal during the attempt-session append sends nothing and ends once', async () => {
  registry._reset();
  const spy = rejectionSpy();
  try {
    const { store, job, ended } = await setup();
    const factory = sessionFactory(registry);
    const closingStore = {
      ...store,
      append(jobId, event) {
        if (event.type === 'attempt-session') registry.closeSession(event.sessionId);
        return store.append(jobId, event);
      },
    };
    const runner = createRunner({ registry: factory.registry, store: closingStore, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    assert.deepEqual(await runner.launch(job, launchAction()), { attemptId: 'a1' });
    await runner.drain();
    const impl = [...factory.impls.values()][0];
    assert.equal(impl.allInputs, undefined, 'no job card was sent');
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'no-result');
    assert.equal(runner.isLive(job.jobId), false);
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('a removal during a failing attempt-session append still ends once', async () => {
  registry._reset();
  const spy = rejectionSpy();
  try {
    const { store, job, ended } = await setup();
    const factory = sessionFactory(registry);
    const closingStore = {
      ...store,
      append(jobId, event) {
        if (event.type !== 'attempt-session') return store.append(jobId, event);
        registry.closeSession(event.sessionId);
        return Promise.reject(new Error('injected attempt-session failure'));
      },
    };
    const runner = createRunner({ registry: factory.registry, store: closingStore, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    assert.deepEqual(await runner.launch(job, launchAction()), { error: 'launch-failed' });
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1, 'the launch failure did not claim a second end');
    assert.equal(ends[0].reason, 'no-result');
    assert.equal(runner.isLive(job.jobId), false);
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('a stop or shutdown during the attempt-session append sends no job card', async () => {
  registry._reset();
  try {
    const { store, job, newJob, ended } = await setup();
    const factory = sessionFactory(registry);
    let during = null;
    let duringType = 'attempt-session';
    const hookedStore = {
      ...store,
      append(jobId, event) {
        const written = store.append(jobId, event);
        if (event.type === duringType && during) during(jobId);
        return written;
      },
    };
    const runner = createRunner({ registry: factory.registry, store: hookedStore, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);

    let stopped;
    during = (jobId) => { stopped = runner.stopAttempt(jobId); };
    const job0 = await newJob('j0');
    duringType = 'attempt-started';
    assert.deepEqual(await runner.launch(job0, launchAction()), { error: 'job-not-running' });
    await stopped;
    await runner.drain();
    assert.equal(factory.calls.length, 0, 'a stop before the session exists creates none');
    assert.deepEqual((await ended('j0')).map((e) => e.outcome), ['stopped']);
    assert.equal(runner.isLive('j0'), false);

    duringType = 'attempt-session';
    assert.deepEqual(await runner.launch(job, launchAction()), { attemptId: 'a2' });
    await stopped;
    await runner.drain();
    assert.equal([...factory.impls.values()][0].allInputs, undefined, 'stop: no job card');
    assert.deepEqual((await ended()).map((e) => e.outcome), ['stopped']);
    assert.equal(registry.list().length, 0);

    const job2 = await newJob('j2');
    during = () => runner.setStopping(true);
    assert.deepEqual(await runner.launch(job2, launchAction()), { attemptId: 'a3' });
    assert.equal([...factory.impls.values()][1].allInputs, undefined, 'shutdown: no job card');
    assert.equal((await ended('j2')).length, 0, 'left in flight for reconcile');
  } finally { registry._reset(); }
});

test('launch refuses while stopping and stops cleanly when stop begins mid-launch', async () => {
  registry._reset();
  try {
    const { store, job, events, ended } = await setup();
    const gate = deferred();
    const slowStore = {
      ...store,
      async append(jobId, event) {
        const stamped = await store.append(jobId, event);
        if (event.type === 'attempt-started') await gate.promise;
        return stamped;
      },
    };
    const runner = createRunner({ registry: sessionFactory(registry).registry, store: slowStore, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    const before = (await events()).length;
    runner.setStopping(true);
    assert.deepEqual(await runner.launch(job, launchAction()), { error: 'stopping' });
    assert.equal((await events()).length, before, 'no event');

    runner.setStopping(false);
    const launching = runner.launch(job, launchAction());
    runner.setStopping(true);
    gate.resolve();
    assert.deepEqual(await launching, { error: 'stopping' });
    assert.equal(registry.list().length, 0);
    assert.equal(runner.isLive(job.jobId), false);
    assert.equal((await events()).filter((e) => e.type === 'attempt-started').length, 1);
    assert.equal((await ended()).length, 0, 'left in flight for reconcile');
  } finally { registry._reset(); }
});

test('concurrent launches for one job create one session', async () => {
  registry._reset();
  try {
    const { store, job, events } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    const outcomes = await Promise.all([runner.launch(job, launchAction()), runner.launch(job, launchAction())]);
    assert.equal(outcomes.filter((o) => o.attemptId).length, 1);
    assert.deepEqual(outcomes.filter((o) => o.error), [{ error: 'busy' }]);
    assert.equal(registry.list().length, 1);
    assert.equal((await events()).filter((e) => e.type === 'attempt-started').length, 1);
  } finally { registry._reset(); }
});

test('every ask is denied, including the brainstormer\'s AskUserQuestion', async () => {
  registry._reset();
  try {
    const { store, job, newJob, runner, factory } = await standInSetup();
    registry.addApprovalInterceptor(runner.onApprovalRequest);
    await runner.launch(job, brainstormerAction());
    const sessionId = lastAttempt(store, job.jobId).sessionId;
    const worker = factory.impls.get(sessionId);
    const asked = await worker.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion');
    assert.deepEqual(asked, { behavior: 'deny', message: denyMessageFor('brainstorm') });
    assert.match(asked.message, /questions/);
    assert.equal(registry.get(sessionId).pendingApprovals.length, 0, 'nothing reaches the human');
    const bash = await worker.emitApprovalRequest({ command: 'curl x' }, 'Bash');
    assert.deepEqual(bash, { behavior: 'deny', message: denyMessageFor('brainstorm') });

    const job2 = await newJob('j2');
    await runner.launch(job2, standInAction());
    const standIn = factory.impls.get(lastAttempt(store, 'j2').sessionId);
    assert.deepEqual(await standIn.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion'), { behavior: 'deny', message: UNATTENDED_DENY_MESSAGE });
  } finally { registry._reset(); }
});

test('the brainstorm deny message follows the phase kind, whatever the role is called', async () => {
  registry._reset();
  try {
    const pipeline = defaultConfig().pipeline.map((p) => (p.kind === 'brainstorm' ? { ...p, role: 'interviewer' } : p));
    const { store, job } = await setup({ pipeline });
    const overrides = path.join(job.repos[0].origin, '.superpowers', 'superagent', 'prompts');
    await fs.mkdir(overrides, { recursive: true });
    await fs.writeFile(path.join(overrides, 'interviewer.md'), '# Interviewer\n');
    const factory = sessionFactory(registry);
    const runner = createRunner({ registry: factory.registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addApprovalInterceptor(runner.onApprovalRequest);
    await runner.launch(job, brainstormerAction({ role: 'interviewer' }));
    const worker = factory.impls.get(lastAttempt(store, job.jobId).sessionId);
    assert.deepEqual(await worker.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion'), { behavior: 'deny', message: denyMessageFor('brainstorm') });
  } finally { registry._reset(); }
});

test('a valid result at turn end ends the attempt done and closes the session', async () => {
  registry._reset();
  try {
    const { store, job, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    await writeValidResult(job, attempt);
    endTurn(impls.get(attempt.sessionId));
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');
    assert.equal(ends[0].summary, 'Wrote the hello design.');
    assert.equal(registry.get(attempt.sessionId), undefined);
    assert.equal(runner.isLive(job.jobId), false);
  } finally { registry._reset(); }
});

test('an ask on a row whose close threw is still denied', async () => {
  registry._reset();
  try {
    const { store, job, ended } = await setup();
    const factory = sessionFactory(registry);
    let stuckId = null;
    const reg = {
      ...factory.registry,
      closeSession(id) {
        if (id === stuckId) throw new Error('injected close failure');
        return registry.closeSession(id);
      },
    };
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    stuckId = attempt.sessionId;
    await writeValidResult(job, attempt);
    endTurn(factory.impls.get(stuckId));
    await runner.review(job);
    await runner.drain();
    assert.deepEqual((await ended()).map((e) => e.outcome), ['done']);
    assert.equal(runner.isLive(job.jobId), false);
    const row = registry.get(stuckId);
    assert.ok(row, 'the row whose close threw is still in the registry');
    assert.deepEqual(runner.onApprovalRequest({ row }), { behavior: 'deny', message: UNATTENDED_DENY_MESSAGE });
    assert.equal(runner.ownsSession(row.id), true);
    runner.onSessionRemoved({ id: row.id, reason: 'closed' });
    assert.equal(runner.ownsSession(row.id), false);
    assert.equal(runner.onApprovalRequest({ row }), null);
  } finally { registry._reset(); }
});

test('no result: one nudge, then no-result', async () => {
  registry._reset();
  try {
    const { store, job, events, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    const impl = impls.get(attempt.sessionId);
    endTurn(impl);
    await runner.review(job);
    const nudges = (await events()).filter((e) => e.type === 'attempt-nudged');
    assert.deepEqual(nudges.map((e) => e.kind), ['result']);
    assert.equal(impl.lastInput, nudgeText('result', attempt));
    const count = (await events()).length;
    await runner.review(job);
    assert.equal((await events()).length, count, 'nothing new before the next result');
    endTurn(impl);
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'failed');
    assert.equal(ends[0].reason, 'no-result');
  } finally { registry._reset(); }
});

test('a removal during the nudge is replayed once the nudge releases its claim', async () => {
  registry._reset();
  const spy = rejectionSpy();
  try {
    const { store, job, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    let sessionId = null;
    const closingStore = {
      ...store,
      append(jobId, event) {
        if (event.type === 'attempt-nudged') registry.closeSession(sessionId);
        return store.append(jobId, event);
      },
    };
    const runner = createRunner({ registry: reg, store: closingStore, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    sessionId = lastAttempt(store, job.jobId).sessionId;
    const impl = impls.get(sessionId);
    endTurn(impl);
    await runner.review(job);
    await runner.drain();
    assert.equal(impl.allInputs.length, 1, 'only the job card; the nudge never reached a closed row');
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'no-result');
    assert.equal(runner.isLive(job.jobId), false);
  } finally {
    await spy.stop();
    registry._reset();
  }
  assert.deepEqual(spy.seen, []);
});

test('hitting maxTurns asks for handoff.md and ends as turn-cap', async () => {
  registry._reset();
  try {
    const { store, job, events, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    const impl = impls.get(attempt.sessionId);
    endTurn(impl, 'error_max_turns');
    await runner.review(job);
    assert.deepEqual((await events()).filter((e) => e.type === 'attempt-nudged').map((e) => e.kind), ['turn-cap']);
    assert.match(impl.lastInput, /handoff\.md/);
    endTurn(impl);
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'turn-cap');
  } finally { registry._reset(); }
});

test('a rejected result is nudged once with the validator\'s error, and a corrected result is accepted', async () => {
  registry._reset();
  try {
    const { store, job, events, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    const impl = impls.get(attempt.sessionId);
    await writeValidResult(job, attempt, { status: 'finished' });
    endTurn(impl);
    await runner.review(job);
    assert.deepEqual((await events()).filter((e) => e.type === 'attempt-nudged').map((e) => e.kind), ['invalid-result']);
    assert.equal(impl.lastInput, nudgeText('invalid-result', { dir: attempt.dir, error: 'status must be one of done|blocked|failed' }));
    assert.match(impl.lastInput, /was rejected: status must be one of done\|blocked\|failed/);
    assert.deepEqual(await ended(), [], 'the attempt stays live after the nudge');
    await writeValidResult(job, attempt);
    endTurn(impl);
    await runner.review(job);
    await runner.drain();
    assert.deepEqual((await ended()).map((e) => e.outcome), ['done']);
  } finally { registry._reset(); }
});

test('a result still rejected after the nudge ends invalid-result with its readable detail', async () => {
  registry._reset();
  try {
    const { store, job, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    const impl = impls.get(attempt.sessionId);
    await writeValidResult(job, attempt, { status: 'finished' });
    endTurn(impl);
    await runner.review(job);
    endTurn(impl);
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.deepEqual([ends[0].outcome, ends[0].reason, ends[0].detail], ['failed', 'invalid-result', 'status must be one of done|blocked|failed']);
    assert.equal(lastAttempt(store, job.jobId).detail, 'status must be one of done|blocked|failed');
  } finally { registry._reset(); }
});

test('a rejected stand-in reply is nudged with the error, then fails invalid-result', async () => {
  registry._reset();
  try {
    const { store, job, ended, events, factory, runner } = await standInSetup();
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    const impl = factory.impls.get(attempt.sessionId);
    reply(impl, JSON.stringify(answerBody({ status: 'finished' })));
    await runner.review(job);
    assert.deepEqual((await events()).filter((e) => e.type === 'attempt-nudged').map((e) => e.kind), ['invalid-result']);
    assert.equal(impl.lastInput, nudgeText('invalid-result', { dir: attempt.dir, readOnly: true, error: 'status must be one of done|blocked|failed' }));
    reply(impl, JSON.stringify(answerBody({ status: 'finished' })));
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.deepEqual([ends.length, ends[0].reason], [1, 'invalid-result']);
  } finally { registry._reset(); }
});

test('a silent attempt is closed as stalled after stallMinutes', async () => {
  registry._reset();
  try {
    const { store, job, events, ended } = await setup();
    let t = T0;
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => t, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const sessionId = lastAttempt(store, job.jobId).sessionId;
    const count = (await events()).length;
    t = T0 + 19 * MIN;
    await runner.review(job);
    assert.equal((await events()).length, count);
    t = T0 + 20 * MIN;
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1, 'the removal listener did not add a second end');
    assert.equal(ends[0].reason, 'stalled');
    assert.equal(registry.get(sessionId), undefined);
  } finally { registry._reset(); }
});

test('telemetry does not postpone the stall deadline, worker messages do', async () => {
  registry._reset();
  try {
    const { store, job, newJob, ended } = await setup();
    let t = T0;
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => t, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);

    await runner.launch(job, launchAction());
    const impl = impls.get(lastAttempt(store, job.jobId).sessionId);
    for (const m of [5, 10, 15, 20]) {
      t = T0 + m * MIN;
      impl.emitMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
      impl.emitMessage({ type: 'system', subtype: 'status', status: null });
      await runner.review(job);
      assert.equal((await ended()).length, m < 20 ? 0 : 1, `at ${m} minutes`);
    }
    assert.equal((await ended())[0].reason, 'stalled');

    t = T0;
    const job2 = await newJob('j2');
    await runner.launch(job2, launchAction());
    const impl2 = impls.get(lastAttempt(store, 'j2').sessionId);
    t = T0 + 19 * MIN;
    impl2.emitMessage(assistantMessage());
    await runner.review(job2);
    for (const m of [20, 38]) {
      t = T0 + m * MIN;
      await runner.review(job2);
      assert.equal((await ended('j2')).length, 0, `no stall at ${m} minutes`);
    }
    t = T0 + 39 * MIN;
    await runner.review(job2);
    await runner.drain();
    const ends = await ended('j2');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'stalled');
  } finally { registry._reset(); }
});

test('completion, removal and stop claim one finish per attempt', async () => {
  registry._reset();
  try {
    const { store, job, newJob, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    let validating = deferred();
    let proceed = deferred();
    const slowValidate = async (value, opts) => {
      validating.resolve();
      await proceed.promise;
      return stubValidate(value, opts);
    };
    const runner = createRunner({ registry: reg, store, results: { readResult, validateResult: slowValidate }, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);

    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    await writeValidResult(job, attempt);
    endTurn(impls.get(attempt.sessionId));
    const reviewing = runner.review(job);
    await validating.promise;
    registry.closeSession(attempt.sessionId);
    proceed.resolve();
    await reviewing;
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');

    validating = deferred();
    proceed = deferred();
    const job2 = await newJob('j2');
    await runner.launch(job2, launchAction());
    const attempt2 = lastAttempt(store, 'j2');
    await writeValidResult(job2, attempt2);
    endTurn(impls.get(attempt2.sessionId));
    const reviewing2 = runner.review(job2);
    await validating.promise;
    let endsWhenStopped = null;
    const stopping = runner.stopAttempt('j2').then(async () => { endsWhenStopped = (await ended('j2')).length; });
    await tick();
    assert.equal(endsWhenStopped, null, 'stopAttempt waits for the finish in progress');
    proceed.resolve();
    await reviewing2;
    await stopping;
    await runner.drain();
    assert.equal(endsWhenStopped, 1);
    const ends2 = await ended('j2');
    assert.equal(ends2.length, 1);
    assert.equal(ends2[0].outcome, 'done');
    assert.equal(runner.isLive('j2'), false);
  } finally { registry._reset(); }
});

test('stopAttempt ends a live attempt as stopped and closes its session', async () => {
  registry._reset();
  try {
    const { store, job, ended } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const sessionId = lastAttempt(store, job.jobId).sessionId;
    await runner.stopAttempt(job.jobId);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'stopped');
    assert.equal(registry.get(sessionId), undefined);
    assert.equal(runner.isLive(job.jobId), false);
  } finally { registry._reset(); }
});

test('PreCompact firings are logged with the attempt id', async () => {
  registry._reset();
  try {
    const { store, job, events } = await setup();
    const factory = sessionFactory(registry);
    const runner = createRunner({ registry: factory.registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    const { attemptId } = await runner.launch(job, launchAction());
    const hook = factory.calls[0].sdkOptions.hooks.PreCompact[0].hooks[0];
    assert.deepEqual(await hook({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }), { continue: true });
    const logged = (await events()).filter((e) => e.type === 'precompact');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].attemptId, attemptId);
    assert.equal(logged[0].trigger, 'auto');
  } finally { registry._reset(); }
});

test('an external close is classified, but a shutdown close leaves the attempt in flight', async () => {
  registry._reset();
  try {
    const { store, job, newJob, ended } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    registry.closeSession(lastAttempt(store, job.jobId).sessionId);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'failed');
    assert.equal(ends[0].reason, 'no-result');

    const job2 = await newJob('j2');
    await runner.launch(job2, launchAction());
    runner.setStopping(true);
    registry.closeSession(lastAttempt(store, 'j2').sessionId);
    await runner.drain();
    assert.equal((await ended('j2')).length, 0);
    assert.equal(runner.isLive('j2'), false);
  } finally { registry._reset(); }
});

test('reconcile ends in-flight attempts with their result or as interrupted', async () => {
  registry._reset();
  try {
    const { store, job, newJob, ended } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    await writeValidResult(job, attempt);
    const job2 = await newJob('j2');
    await runner.launch(job2, launchAction());

    const restarted = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids('b'), logImpl: quiet });
    await restarted.reconcile(store.get(job.jobId));
    await restarted.reconcile(store.get('j2'));
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');
    assert.equal(ends[0].summary, 'Wrote the hello design.');
    assert.deepEqual((await ended('j2')).map((e) => e.outcome), ['interrupted']);
  } finally { registry._reset(); }
});

// Plan 3 Task 7: real validateResult against a git worktree on the job branch.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const F = (id, severity, disposition) => ({ id, severity, text: `Finding ${id}.`, ...(disposition ? { disposition } : {}) });

async function gitSetup({ tasks = null, pipeline = MILESTONE_2_PIPELINE } = {}) {
  const root = await tempDir('sa-runner-git-');
  const store = createSuperagentStore({ rootDir: path.join(root, 'jobs'), now: () => T0, logImpl: quiet });
  const origin = path.join(root, 'origin');
  await initRepo(origin);
  const created = jobCreated({ pipeline, repos: [{ id: 'primary', origin }] });
  const { jobId, branch } = created;
  const worktree = path.join(root, 'wt');
  const { baseSha } = await createWorktree({ origin, worktree, branch, copyLocalClaudeSettings: false });
  await store.append(jobId, created);
  await store.append(jobId, { type: 'worktree-created', repo: 'primary', worktree, branch, baseSha, settingsCopy: null });
  await store.append(jobId, { type: 'job-provisioned' });
  if (tasks) await store.append(jobId, { type: 'tasks-loaded', tasks });
  const job = store.get(jobId);
  const commit = async (files, message = 'work') => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(worktree, ...rel.split('/'));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
      git(worktree, 'add', '--', rel);
    }
    git(worktree, 'commit', '-q', '-m', message);
    return git(worktree, 'rev-parse', 'HEAD');
  };
  const result = (attempt, over = {}) => ({
    jobId, phaseId: attempt.phase, taskId: attempt.task ?? null, attemptId: attempt.attemptId,
    status: 'done', artifacts: [], summary: 'Did the work.', question: null, ...over,
  });
  const publish = async (attempt, value) => {
    await fs.mkdir(attempt.dir, { recursive: true });
    await fs.writeFile(path.join(attempt.dir, RESULT_FILE), JSON.stringify(value));
  };
  // A derived attempt that never ended, as a restarted cockpit finds it.
  const startedOnly = async (attemptId, { phase, task = null, role, ...over }) => {
    const dir = attemptDir(worktree, { jobId, phase, task, attemptId });
    await store.append(jobId, { type: 'attempt-started', attemptId, phase, task, role, model: 'claude-opus-5-5', n: 1, recovery: false, previousAttemptId: null, dir, ...over });
    return store.get(jobId).attempts.find((a) => a.attemptId === attemptId);
  };
  const doneReview = async (attemptId, round, findings) => {
    await startedOnly(attemptId, { phase: 'spec-review', role: 'spec-reviewer', purpose: 'review', round });
    await store.append(jobId, { type: 'attempt-ended', attemptId, outcome: 'done', verdict: 'changes', findings });
  };
  const events = async () => (await fs.readFile(path.join(store.jobDir(jobId), 'events.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const endOf = async (attemptId) => (await events()).find((e) => e.type === 'attempt-ended' && e.attemptId === attemptId);
  return { store, job, jobId, origin, worktree, commit, result, publish, startedOnly, doneReview, events, endOf };
}

let liveRuns = 0;

// Launches one live attempt with the real validator and finishes its turn.
async function runLive(g, action, makeResult) {
  const { registry: reg, impls } = sessionFactory(registry);
  const runner = createRunner({ registry: reg, store: g.store, now: () => T0, idImpl: ids(`live${++liveRuns}-`), logImpl: quiet });
  const launched = await runner.launch(g.store.get(g.jobId), action);
  assert.ok(launched.attemptId, JSON.stringify(launched));
  const attempt = lastAttempt(g.store, g.jobId);
  await g.publish(attempt, await makeResult(attempt));
  const impl = impls.get(attempt.sessionId);
  endTurn(impl);
  await runner.review(g.store.get(g.jobId));
  await runner.drain();
  // A rejected result is nudged once; this worker ignores the nudge.
  if (lastAttempt(g.store, g.jobId).nudges.some((n) => n.kind === 'invalid-result')) {
    endTurn(impl);
    await runner.review(g.store.get(g.jobId));
    await runner.drain();
  }
  return lastAttempt(g.store, g.jobId);
}

const reconcileWith = (g) => createRunner({ registry: sessionFactory(registry).registry, store: g.store, now: () => T0, idImpl: ids('r'), logImpl: quiet })
  .reconcile(g.store.get(g.jobId));

test('attempt-started records purpose and round; no purpose defaults to author', async () => {
  registry._reset();
  try {
    const g = await gitSetup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store: g.store, now: () => T0, idImpl: ids(), logImpl: quiet });
    await runner.launch(g.job, launchAction({ phase: 'spec-review', role: 'spec-writer', purpose: 'fix', round: 2, final: true, reviewFindings: [F('F1', 'major')] }));
    const started = (await g.events()).find((e) => e.type === 'attempt-started');
    assert.equal(started.purpose, 'fix');
    assert.equal(started.round, 2);
    assert.equal(started.final, true);
    const fixAttempt = lastAttempt(g.store, g.jobId);
    assert.deepEqual([fixAttempt.purpose, fixAttempt.round, fixAttempt.final], ['fix', 2, true]);
    await runner.stopAttempt(g.jobId);

    await runner.launch(g.store.get(g.jobId), launchAction());
    const plain = lastAttempt(g.store, g.jobId);
    assert.deepEqual([plain.purpose, plain.round, plain.final], ['author', null, false]);
    const plainStarted = (await g.events()).filter((e) => e.type === 'attempt-started').at(-1);
    assert.equal(plainStarted.purpose, 'author');
    await runner.stopAttempt(g.jobId);
    await runner.drain();
  } finally { registry._reset(); }
});

test('a valid review result ends the attempt with verdict and findings stored on the derived attempt', async () => {
  registry._reset();
  try {
    const g = await gitSetup();
    const rel = reviewPaths(g.job, { phase: 'spec-review', round: 1 }).review;
    const sha = await g.commit({ [rel]: '# review r1\n' });
    const findings = [F('F1', 'blocker'), F('F2', 'minor')];
    const attempt = await runLive(g, launchAction({ phase: 'spec-review', role: 'spec-reviewer', purpose: 'review', round: 1 }),
      (a) => g.result(a, { artifacts: [rel], verdict: 'changes', findings, evidence: { commits: [sha] } }));
    assert.equal(attempt.outcome, 'done', JSON.stringify(await g.endOf(attempt.attemptId)));
    assert.equal(attempt.verdict, 'changes');
    assert.deepEqual(attempt.findings, findings);
    assert.deepEqual(attempt.commits, [{ repo: 'primary', sha }]);
    assert.equal(attempt.verified, null);
    const end = await g.endOf(attempt.attemptId);
    assert.equal(end.verdict, 'changes');
    assert.equal(end.verified, null);
  } finally { registry._reset(); }
});

test('a valid implement result stores commits; a missing verify check ends the attempt invalid-result', async () => {
  registry._reset();
  try {
    const T1 = taskCreated('T1', { verify: 'npm test' });
    const g = await gitSetup({ tasks: [T1] });
    const report = reviewPaths(g.job, { taskId: 'T1' }).report;
    const reportSha = await g.commit({ [report]: '# T1 report\n' }, 'report');
    const codeSha = await g.commit({ 'src/hello.js': 'export const hello = 1;\n' }, 'code');
    const action = launchAction({ phase: 'implement', task: 'T1', role: 'implementer', purpose: 'implement', taskDef: T1 });
    const evidence = (checks) => ({ commits: [reportSha, codeSha], checks });

    const ok = await runLive(g, action, (a) => g.result(a, { artifacts: [report], evidence: evidence([{ cmd: 'npm test', exit: 0 }]) }));
    assert.equal(ok.outcome, 'done', JSON.stringify(await g.endOf(ok.attemptId)));
    assert.deepEqual(ok.commits, [{ repo: 'primary', sha: reportSha }, { repo: 'primary', sha: codeSha }]);
    assert.equal(ok.verdict, null);
    assert.equal(ok.findings, null);

    const missing = await runLive(g, action, (a) => g.result(a, { artifacts: [report], evidence: evidence([{ cmd: 'npm run lint', exit: 0 }]) }));
    assert.equal(missing.outcome, 'failed');
    assert.equal(missing.reason, 'invalid-result');
    assert.match(missing.signature, /verify command/);
    assert.deepEqual(missing.commits, []);
  } finally { registry._reset(); }
});

test('a worker-reported failed result gets a signature, and two identical failures produce equal signatures', async () => {
  registry._reset();
  try {
    const g = await gitSetup();
    const failing = (summary) => (a) => g.result(a, { status: 'failed', summary });
    const first = await runLive(g, launchAction(), failing('Build broke after 3 retries at 0x7ffd12\nfirst detail'));
    const second = await runLive(g, launchAction(), failing('Build broke after 12 retries at 0xabc\nother detail'));
    for (const a of [first, second]) {
      assert.equal(a.outcome, 'failed');
      assert.equal(a.reason, 'failed');
      assert.equal(typeof a.signature, 'string');
    }
    assert.equal(first.signature, second.signature);
    assert.equal((await g.endOf(first.attemptId)).signature, first.signature);
  } finally { registry._reset(); }
});

test('reconcile validates a finished fix attempt with the same rules as a live finish', async () => {
  registry._reset();
  try {
    const g = await gitSetup();
    await g.doneReview('rv1', 1, [F('F1', 'blocker'), F('F2', 'minor')]);
    const response = reviewPaths(g.job, { phase: 'spec-review', round: 1 }).response;
    const sha = await g.commit({ [artifactPaths(g.job).spec]: '# Hello design\n', [response]: '# response r1\n' });
    const fixResult = (a, findings) => g.result(a, { artifacts: [response], findings, evidence: { commits: [sha] } });
    const answered = [F('F1', 'blocker', 'fixed'), F('F2', 'minor', 'declined: out of scope')];

    const valid = await g.startedOnly('fx1', { phase: 'spec-review', role: 'spec-writer', purpose: 'fix', round: 1 });
    await g.publish(valid, fixResult(valid, answered));
    await reconcileWith(g);
    const validEnd = await g.endOf('fx1');
    assert.equal(validEnd.outcome, 'done', JSON.stringify(validEnd));
    assert.deepEqual(validEnd.findings, answered);

    const extra = await g.startedOnly('fx2', { phase: 'spec-review', role: 'spec-writer', purpose: 'fix', round: 1 });
    await g.publish(extra, fixResult(extra, [...answered, F('F9', 'major', 'fixed')]));
    await reconcileWith(g);
    const extraEnd = await g.endOf('fx2');
    assert.equal(extraEnd.outcome, 'failed');
    assert.equal(extraEnd.reason, 'invalid-result');
    assert.match(extraEnd.signature, /not a finding of the review/);
  } finally { registry._reset(); }
});

test('a non-final fix with an open blocker ends invalid-result live and in reconcile (final is persisted and rebuilt); the same result on the final fix is accepted', async () => {
  registry._reset();
  try {
    const g = await gitSetup();
    await g.doneReview('rv1', 1, [F('F1', 'blocker')]);
    const response = reviewPaths(g.job, { phase: 'spec-review', round: 1 }).response;
    const sha = await g.commit({ [artifactPaths(g.job).spec]: '# Hello design\n', [response]: '# response r1\n' });
    const openBlocker = (a) => g.result(a, { artifacts: [response], findings: [F('F1', 'blocker', 'open')], evidence: { commits: [sha] } });
    const fixAction = (final) => launchAction({ phase: 'spec-review', role: 'spec-writer', purpose: 'fix', round: 1, final, reviewFindings: [F('F1', 'blocker')] });

    const liveNonFinal = await runLive(g, fixAction(false), openBlocker);
    assert.equal(liveNonFinal.outcome, 'failed');
    assert.equal(liveNonFinal.reason, 'invalid-result');
    assert.match(liveNonFinal.signature, /may only stay open in the final fix/);
    const liveFinal = await runLive(g, fixAction(true), openBlocker);
    assert.equal(liveFinal.outcome, 'done', JSON.stringify(await g.endOf(liveFinal.attemptId)));

    const nonFinal = await g.startedOnly('fx1', { phase: 'spec-review', role: 'spec-writer', purpose: 'fix', round: 1, final: false });
    await g.publish(nonFinal, openBlocker(nonFinal));
    const final = await g.startedOnly('fx2', { phase: 'spec-review', role: 'spec-writer', purpose: 'fix', round: 1, final: true });
    await g.publish(final, openBlocker(final));
    await reconcileWith(g);
    const nonFinalEnd = await g.endOf('fx1');
    assert.equal(nonFinalEnd.outcome, 'failed');
    assert.equal(nonFinalEnd.reason, 'invalid-result');
    assert.match(nonFinalEnd.signature, /may only stay open in the final fix/);
    assert.equal((await g.endOf('fx2')).outcome, 'done', JSON.stringify(await g.endOf('fx2')));
  } finally { registry._reset(); }
});

// Plan 5 Task 6: the read-only stand-in, its final-message result, tokens.
test('stand-in sessions are read-only', async () => {
  registry._reset();
  try {
    const { job, newJob, factory, runner } = await standInSetup();
    await runner.launch(job, standInAction());
    assert.deepEqual(factory.calls[0].sdkOptions.tools, ['Read', 'Grep', 'Glob']);
    assert.deepEqual(factory.calls[0].sdkOptions.disallowedTools, ['mcp__*']);
    await runner.launch(await newJob('j2'), brainstormerAction());
    assert.equal('tools' in factory.calls[1].sdkOptions, false);
    assert.equal('disallowedTools' in factory.calls[1].sdkOptions, false);
  } finally { registry._reset(); }
});

test('read-only result: fenced, braced, prose-wrapped and unparseable final messages', () => {
  const body = { status: 'done', answers: [{ id: 'Q1' }] };
  const json = JSON.stringify(body);
  assert.deepEqual(extractResultJson(`Here you go.\n\`\`\`json\n${json}\n\`\`\`\nBye {not this}`), body);
  assert.deepEqual(extractResultJson(`Here it is: ${json} done`), body);
  assert.deepEqual(extractResultJson(json), body);
  assert.equal(extractResultJson('no json here'), null);
  assert.equal(extractResultJson('{ broken'), null);
  assert.equal(extractResultJson('[{"status":"done"}]'), null);
  assert.equal(extractResultJson(null), null);
});

test('a stand-in final message becomes result.json', async () => {
  registry._reset();
  try {
    const g = await gitSetup({ pipeline: defaultConfig().pipeline });
    await writeBrainstormTemplates(g.origin);
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store: g.store, now: () => T0, idImpl: ids('si'), logImpl: quiet });
    await runner.launch(g.store.get(g.jobId), standInAction());
    const attempt = lastAttempt(g.store, g.jobId);
    const body = answerBody();
    reply(impls.get(attempt.sessionId), `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``);
    await runner.review(g.store.get(g.jobId));
    await runner.drain();
    const written = await readJsonFile(path.join(attempt.dir, RESULT_FILE));
    assert.deepEqual(written, { ...body, jobId: g.jobId, phaseId: 'brainstorm', taskId: null, attemptId: attempt.attemptId });
    const end = await g.endOf(attempt.attemptId);
    assert.equal(end.outcome, 'done', JSON.stringify(end));
    assert.deepEqual(end.answers, body.answers);
  } finally { registry._reset(); }
});

test('the result is materialised on the first scan, so removal still judges it', async () => {
  registry._reset();
  try {
    const { store, job, ended, factory, runner } = await standInSetup();
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    reply(factory.impls.get(attempt.sessionId), JSON.stringify(answerBody()), { idle: false });
    assert.notEqual(registry.get(attempt.sessionId).state, 'idle');
    await runner.review(job);
    assert.equal(await exists(path.join(attempt.dir, RESULT_FILE)), true);
    assert.equal((await ended()).length, 0, 'the turn has not ended yet');
    registry.closeSession(attempt.sessionId);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');
    assert.deepEqual(ends[0].answers, answerBody().answers);
  } finally { registry._reset(); }
});

test('removal before any scan loses the reply (documented boundary)', async () => {
  registry._reset();
  try {
    const { store, job, ended, factory, runner } = await standInSetup();
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    reply(factory.impls.get(attempt.sessionId), JSON.stringify(answerBody()), { idle: false });
    registry.closeSession(attempt.sessionId);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'failed');
    assert.equal(ends[0].reason, 'no-result');
    assert.equal(await exists(path.join(attempt.dir, RESULT_FILE)), false);
  } finally { registry._reset(); }
});

test('reconcile after a restart uses the materialised result', async () => {
  registry._reset();
  try {
    const { store, job, ended, factory, runner } = await standInSetup();
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    reply(factory.impls.get(attempt.sessionId), JSON.stringify(answerBody()), { idle: false });
    await runner.review(job);
    const restarted = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids('b'), logImpl: quiet });
    await restarted.reconcile(store.get(job.jobId));
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');
    assert.deepEqual(ends[0].answers, answerBody().answers);
    assert.equal(ends[0].tokens, null);
  } finally { registry._reset(); }
});

test('a failing result write is retried and never strands the attempt', async () => {
  registry._reset();
  try {
    let failures = 1;
    const logged = [];
    const writeJsonImpl = async (file, value) => {
      if (failures-- > 0) throw new Error('disk full');
      return writeJsonAtomic(file, value);
    };
    const { store, job, newJob, ended, events, factory, runner } = await standInSetup({ writeJsonImpl, logImpl: (m) => logged.push(m) });
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    const impl = factory.impls.get(attempt.sessionId);
    reply(impl, JSON.stringify(answerBody()), { idle: false });
    await runner.review(job);
    assert.equal(await exists(path.join(attempt.dir, RESULT_FILE)), false);
    assert.ok(logged.some((m) => /disk full/.test(m)), logged.join('\n'));
    assert.equal((await ended()).length, 0, 'nothing claimed the attempt');
    assert.equal(runner.isLive(job.jobId), true);
    impl.emitState('idle');
    await runner.review(job);
    await runner.drain();
    assert.equal(await exists(path.join(attempt.dir, RESULT_FILE)), true);
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');
    assert.equal(registry.get(attempt.sessionId), undefined);
    assert.equal(runner.isLive(job.jobId), false);

    failures = Infinity;
    const job2 = await newJob('j2');
    await runner.launch(job2, standInAction());
    const attempt2 = lastAttempt(store, 'j2');
    const impl2 = factory.impls.get(attempt2.sessionId);
    reply(impl2, JSON.stringify(answerBody()));
    await runner.review(job2);
    assert.deepEqual((await events('j2')).filter((e) => e.type === 'attempt-nudged').map((e) => e.kind), ['result']);
    reply(impl2, JSON.stringify(answerBody()));
    await runner.review(job2);
    await runner.drain();
    const ends2 = await ended('j2');
    assert.equal(ends2.length, 1);
    assert.equal(ends2[0].outcome, 'failed');
    assert.equal(ends2[0].reason, 'no-result');
  } finally { registry._reset(); }
});

test('an unparseable stand-in reply is nudged, then fails', async () => {
  registry._reset();
  try {
    const { store, job, ended, events, factory, runner } = await standInSetup();
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    const impl = factory.impls.get(attempt.sessionId);
    reply(impl, 'sorry');
    await runner.review(job);
    assert.equal((await events()).filter((e) => e.type === 'attempt-nudged').length, 1);
    assert.match(impl.lastInput, /final message/);
    assert.equal(impl.lastInput, nudgeText('result', { dir: attempt.dir, readOnly: true }));
    reply(impl, 'sorry');
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'failed');
    assert.equal(ends[0].reason, 'no-result');
  } finally { registry._reset(); }
});

test('attempt-ended records tokens from the row', async () => {
  registry._reset();
  try {
    const { store, job, newJob, ended } = await setup();
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    await runner.launch(job, launchAction());
    const attempt = lastAttempt(store, job.jobId);
    Object.assign(registry.get(attempt.sessionId).usageAcc.totals, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 });
    await writeValidResult(job, attempt);
    endTurn(impls.get(attempt.sessionId));
    await runner.review(job);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends[0].outcome, 'done');
    assert.equal(ends[0].tokens, 135);
    assert.deepEqual([ends[0].questions, ends[0].answers, ends[0].escalated], [null, null, null]);

    const job2 = await newJob('j2');
    await runner.launch(job2, launchAction());
    await writeValidResult(job2, lastAttempt(store, 'j2'));
    const restarted = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids('b'), logImpl: quiet });
    await restarted.reconcile(store.get('j2'));
    const ends2 = await ended('j2');
    assert.equal(ends2[0].outcome, 'done');
    assert.equal(ends2[0].tokens, null);
  } finally { registry._reset(); }
});

test('brainstorm payload fields reach attempt-ended', async () => {
  registry._reset();
  try {
    const { store, job, newJob, ended, factory, runner } = await standInSetup();
    await runner.launch(job, brainstormerAction());
    const ask = lastAttempt(store, job.jobId);
    const questions = [Q1, Q2];
    await fs.mkdir(ask.dir, { recursive: true });
    await fs.writeFile(path.join(ask.dir, RESULT_FILE), JSON.stringify({
      jobId: job.jobId, phaseId: 'brainstorm', taskId: null, attemptId: ask.attemptId,
      status: 'done', artifacts: [], summary: 'Two questions.', question: null, questions,
    }));
    endTurn(factory.impls.get(ask.sessionId));
    await runner.review(job);
    await runner.drain();
    const asked = (await ended())[0];
    assert.equal(asked.outcome, 'done');
    assert.deepEqual(asked.questions, questions);
    assert.equal(asked.answers, null);

    const job2 = await newJob('j2');
    await runner.launch(job2, standInAction());
    const standIn = lastAttempt(store, 'j2');
    const blocked = answerBody({ status: 'blocked', question: 'Postgres or SQLite?', escalated: 'Q1', answers: [answerOf('Q2', 'assumed')] });
    reply(factory.impls.get(standIn.sessionId), JSON.stringify(blocked));
    await runner.review(job2);
    await runner.drain();
    const escalation = (await ended('j2'))[0];
    assert.equal(escalation.outcome, 'question');
    assert.equal(escalation.question, 'Postgres or SQLite?');
    assert.equal(escalation.escalated, 'Q1');
    assert.deepEqual(escalation.answers, blocked.answers);
  } finally { registry._reset(); }
});

test('scriptedWorker publishes a read-only card\'s result as its final message', async () => {
  registry._reset();
  try {
    const { store, job, ended, factory, runner } = await standInSetup();
    const worker = scriptedWorker({ factory, handlers: { 'brainstorm:answer': () => answerBody() } });
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    assert.equal(worker.cards()[0].resultVia, 'final-message');
    assert.equal(await exists(path.join(attempt.dir, RESULT_FILE)), false, 'the worker wrote no file');
    await runner.review(job);
    await runner.drain();
    assert.deepEqual(worker.errors, []);
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');
    assert.deepEqual(ends[0].answers, answerBody().answers);
  } finally { registry._reset(); }
});

test('a removal after a failed result write still materialises the reply', async () => {
  registry._reset();
  try {
    let failures = 1;
    const writeJsonImpl = async (file, value) => {
      if (failures-- > 0) throw new Error('disk full');
      return writeJsonAtomic(file, value);
    };
    const { store, job, ended, factory, runner } = await standInSetup({ writeJsonImpl });
    await runner.launch(job, standInAction());
    const attempt = lastAttempt(store, job.jobId);
    reply(factory.impls.get(attempt.sessionId), JSON.stringify(answerBody()), { idle: false });
    await runner.review(job);
    assert.equal(await exists(path.join(attempt.dir, RESULT_FILE)), false);
    registry.closeSession(attempt.sessionId);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'done');
    assert.deepEqual(ends[0].answers, answerBody().answers);
  } finally { registry._reset(); }
});

test('a removed attempt records the tokens last seen on its row', async () => {
  registry._reset();
  try {
    const { store, job, ended } = await setup();
    const runner = createRunner({ registry: sessionFactory(registry).registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    registry.addSessionRemovedListener(runner.onSessionRemoved);
    await runner.launch(job, launchAction());
    const sessionId = lastAttempt(store, job.jobId).sessionId;
    Object.assign(registry.get(sessionId).usageAcc.totals, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 });
    await runner.review(job);
    registry.closeSession(sessionId);
    await runner.drain();
    const ends = await ended();
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'no-result');
    assert.equal(ends[0].tokens, 135);
  } finally { registry._reset(); }
});

test('a recorded prompt that disappeared makes the job stuck', async () => {
  registry._reset();
  try {
    const root = await tempDir('sa-runner-prompt-');
    const store = createSuperagentStore({ rootDir: path.join(root, 'jobs'), now: () => T0, logImpl: quiet });
    const recorded = path.join(root, 'workflow', 'spec-writer.md');
    await fs.mkdir(path.dirname(recorded), { recursive: true });
    await fs.writeFile(recorded, '# Spec writer\n');
    const job = await liveJob(store, {
      repos: [{ id: 'primary', origin: path.join(root, 'origin') }],
      workflow: { id: 'quick', name: 'Quick', source: 'global', file: path.join(root, 'workflow', 'quick.json') },
      artifacts: { spec: 'docs/specs/add-hello.md' },
      prompts: { 'spec-writer': recorded },
    });
    await fs.rm(recorded);
    const factory = sessionFactory(registry);
    const runner = createRunner({ registry: factory.registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet });
    assert.deepEqual(await runner.launch(job, launchAction()), { error: 'launch-failed' });
    await runner.drain();
    assert.equal(factory.calls.length, 0);
    assert.equal(runner.isLive(job.jobId), false);
    const got = store.get(job.jobId);
    assert.deepEqual([got.attempts.at(-1).outcome, got.attempts.at(-1).reason], ['failed', 'prompt-missing']);
    assert.deepEqual([got.state, got.reason, got.detail.why, got.detail.path], ['needs-you', 'stuck', 'prompt-missing', recorded]);
  } finally { registry._reset(); }
});

test('beforeSession is the last check before createSession for an in-place job', async () => {
  registry._reset();
  try {
    const root = await tempDir('sa-runner-gate-');
    const store = createSuperagentStore({ rootDir: path.join(root, 'jobs'), now: () => T0, logImpl: quiet });
    const inPlace = await liveJob(store, { jobId: 'jp', repos: [{ id: 'primary', origin: path.join(root, 'origin'), inPlace: true }] });
    const worktreeJob = await liveJob(store, { jobId: 'jw', repos: [{ id: 'primary', origin: path.join(root, 'other') }] });
    const checked = [];
    let verdict = { ok: false, text: 'this folder is on main; switch it back to superagent/add-hello to continue', folder: '/repo' };
    const factory = sessionFactory(registry);
    const runner = createRunner({
      registry: factory.registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet,
      beforeSession: async (job) => { checked.push(job.jobId); return verdict; },
    });

    assert.deepEqual(await runner.launch(inPlace, launchAction()), { error: 'folder-changed' });
    await runner.drain();
    assert.equal(factory.calls.length, 0);
    assert.equal(runner.isLive('jp'), false);
    const paused = store.get('jp');
    assert.deepEqual([paused.attempts[0].outcome, paused.attempts[0].reason, paused.attempts[0].sessionId], ['failed', 'folder-changed', null]);
    assert.deepEqual([paused.state, paused.reason, paused.detail], ['needs-you', 'folder-changed', { why: 'folder-changed', text: verdict.text, folder: '/repo' }]);

    assert.ok((await runner.launch(worktreeJob, launchAction())).attemptId);
    assert.deepEqual(checked, ['jp']);
    assert.equal(factory.calls.length, 1);

    await store.append('jp', { type: 'folder-restored' });
    verdict = { ok: true };
    assert.ok((await runner.launch(store.get('jp'), launchAction())).attemptId);
    assert.deepEqual(checked, ['jp', 'jp']);
    assert.equal(factory.calls.length, 2);
  } finally { registry._reset(); }
});

test('a stop during beforeSession ends the attempt as stopped, with no pause', async () => {
  registry._reset();
  try {
    const root = await tempDir('sa-runner-gate-stop-');
    const store = createSuperagentStore({ rootDir: path.join(root, 'jobs'), now: () => T0, logImpl: quiet });
    const job = await liveJob(store, { repos: [{ id: 'primary', origin: path.join(root, 'origin'), inPlace: true }] });
    const reached = deferred();
    const release = deferred();
    const factory = sessionFactory(registry);
    const runner = createRunner({
      registry: factory.registry, store, results, now: () => T0, idImpl: ids(), logImpl: quiet,
      beforeSession: async () => { reached.resolve(); await release.promise; return { ok: false, text: 'moved' }; },
    });
    const launching = runner.launch(job, launchAction());
    await reached.promise;
    await store.append(job.jobId, { type: 'job-stopped' });
    release.resolve();
    assert.deepEqual(await launching, { error: 'job-not-running' });
    await runner.drain();
    assert.equal(factory.calls.length, 0);
    const got = store.get(job.jobId);
    assert.equal(got.attempts[0].outcome, 'stopped');
    assert.equal(got.state, 'stopped');
  } finally { registry._reset(); }
});
