import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { fakeStartSession } from './test-helpers.mjs';
import { tempDir, sessionFactory, liveJob, launchAction, ids, deferred, T0, MIN } from './superagent-helpers.mjs';
import { createSuperagentStore } from '../src/superagent/store.js';
import { RESULT_FILE, artifactPaths, readResult } from '../src/superagent/results.js';
import { UNATTENDED_DENY_MESSAGE, nudgeText } from '../src/superagent/prompts.js';
import { createRunner, PROGRESS_TYPES } from '../src/superagent/runner.js';

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

async function setup() {
  const root = await tempDir('sa-runner-');
  const store = createSuperagentStore({ rootDir: path.join(root, 'jobs'), now: () => T0, logImpl: quiet });
  const repos = [
    { id: 'primary', origin: path.join(root, 'origin') },
    { id: 'extra', origin: path.join(root, 'extra-origin') },
  ];
  const newJob = (jobId = 'j1') => liveJob(store, { jobId, repos });
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

test('brainstormer AskUserQuestion falls through, its other asks are denied', async () => {
  registry._reset();
  try {
    const { root, store, job } = await setup();
    const projectDir = path.join(root, 'project');
    const overrides = path.join(projectDir, '.superpowers', 'superagent', 'prompts');
    await fs.mkdir(overrides, { recursive: true });
    await fs.writeFile(path.join(overrides, 'brainstormer.md'), '# Brainstormer\n');
    const { registry: reg, impls } = sessionFactory(registry);
    const runner = createRunner({ registry: reg, store, results, now: () => T0, idImpl: ids(), logImpl: quiet, projectDirFor: () => projectDir });
    registry.addApprovalInterceptor(runner.onApprovalRequest);
    const { attemptId } = await runner.launch(job, launchAction({ role: 'brainstormer' }));
    assert.ok(attemptId);
    const sessionId = lastAttempt(store, job.jobId).sessionId;
    const worker = impls.get(sessionId);
    worker.emitApprovalRequest({ questions: [{ question: 'Which?' }] }, 'AskUserQuestion');
    assert.equal(registry.get(sessionId).pendingApprovals.length, 1);
    const bash = await worker.emitApprovalRequest({ command: 'curl x' }, 'Bash');
    assert.deepEqual(bash, { behavior: 'deny', message: UNATTENDED_DENY_MESSAGE });
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
