// Milestone-2 and default-pipeline (brainstorm) integration: createSuperagent
// driven by tick() with scripted fake workers (tests/superagent-helpers.mjs
// scriptedWorker) that commit real files in the job's worktrees. One origin
// repo (plus one additional repo) is shared by the whole file; each test gets
// its own store, registry state and job branch.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { HOLD, MIN, T0, deferred, ev, initRepo, scriptedWorker, sessionFactory, tempDir } from './superagent-helpers.mjs';
import { createSuperagentStore } from '../src/superagent/store.js';
import { MILESTONE_2_PIPELINE, createSuperagentConfig, defaultConfig } from '../src/superagent/config.js';
import { brainstormLog } from '../src/superagent/sequencer.js';
import { ANSWER_TAGS, artifactPaths } from '../src/superagent/results.js';
import { createSuperagent, pipelineRoles } from '../src/superagent/index.js';
import { workflowsDir } from '../src/superagent/workflows.js';
import { ROUTER_SYSTEM_PROMPT } from '../src/superagent/router.js';

const quiet = () => {};
// The slowest test takes about 10s; a hung git call fails the test instead of the suite.
const TEST_TIMEOUT_MS = 120_000;
const shared = {};

before(async () => {
  shared.root = await tempDir('sa-pipe-');
  shared.repo = path.join(shared.root, 'repo');
  shared.lib = path.join(shared.root, 'lib');
  await initRepo(shared.repo);
  await initRepo(shared.lib);
});

after(() => fs.rm(shared.root, { recursive: true, force: true }).catch(() => {}));

const task = (id, over = {}) => ({ id, title: `Task ${id}`, repos: ['primary'], dependsOn: [], acceptance: `${id} works`, verify: '', ...over });
// The dependent task is listed first, so only dependsOn keeps T2 waiting.
const TWO_TASKS = [task('T2', { dependsOn: ['T1'] }), task('T1', { verify: 'npm test' })];

const approve = ({ publish }) => publish({ verdict: 'approve', findings: [] });

// Every purpose's minimal valid answer; tests override by purpose or by
// `${phaseId}:${purpose}`.
function handlersWith(over = {}) {
  return {
    'spec:author': ({ publish }) => publish(),
    'plan:author': ({ publish }) => publish({}, { content: { tasks: JSON.stringify(TWO_TASKS, null, 2) } }),
    review: approve,
    'task-review': approve,
    implement: ({ publish }) => publish(),
    test: ({ publish }) => publish(),
    ...over,
  };
}

async function harness({ handlers = handlersWith(), limits = null, defaults = {}, projects = null, router: firstRouter, budgetCheck } = {}) {
  registry._reset();
  const root = await fs.mkdtemp(path.join(shared.root, 'h-'));
  const configFile = path.join(root, 'config.json');
  const fileDefaults = { ...defaults, ...(limits ? { limits } : {}) };
  await fs.writeFile(configFile, JSON.stringify({ ...(Object.keys(fileDefaults).length > 0 ? { defaults: fileDefaults } : {}), ...(projects ? { projects } : {}) }));
  const jobsRoot = path.join(root, 'jobs');
  const worktreesRoot = path.join(shared.root, 'worktrees');
  const clock = { t: T0 };

  async function build(router = firstRouter) {
    const store = createSuperagentStore({ rootDir: jobsRoot, now: () => clock.t, logImpl: quiet });
    const config = createSuperagentConfig({ filePath: configFile });
    await config.load();
    const factory = sessionFactory(registry);
    const worker = scriptedWorker({ factory, handlers });
    const sa = createSuperagent({
      registry: factory.registry,
      store,
      config,
      worktreesRoot,
      now: () => clock.t,
      setIntervalImpl: () => 'timer',
      clearIntervalImpl: () => {},
      stopTickDeadlineMs: 20,
      logImpl: quiet,
      platform: 'linux',
      workflowDirs: { builtin: workflowsDir(), global: path.join(root, 'workflows') },
      ...(router === undefined ? {} : { router }),
      ...(budgetCheck === undefined ? {} : { budgetCheck }),
    });
    const events = (jobId) => readFileSync(path.join(jobsRoot, jobId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const h = {
      clock, store, factory, worker, sa, events,
      started: (jobId, phase) => events(jobId).filter((e) => e.type === 'attempt-started' && e.dir && (phase === undefined || e.phase === phase)),
      ended: (jobId) => events(jobId).filter((e) => e.type === 'attempt-ended'),
      // One tick per step, the clock moved past any back-off (max 5 minutes)
      // but well inside the 20-minute stall deadline.
      async drive(jobId, until = (job) => job.state !== 'running', maxTicks = 60) {
        for (let i = 0; i < maxTicks; i++) {
          if (until(store.get(jobId), events(jobId))) return store.get(jobId);
          clock.t += 6 * MIN;
          await sa.tick();
        }
        if (until(store.get(jobId), events(jobId))) return store.get(jobId);
        const tail = events(jobId).slice(-6).map((e) => JSON.stringify(e)).join('\n');
        throw new Error(`job ${jobId} did not reach the expected state in ${maxTicks} ticks; worker errors: ${worker.errors.map(String).join('; ')}\n${tail}`);
      },
      async restart({ router } = {}) {
        registry._reset();
        return build(router);
      },
    };
    return h;
  }
  return build();
}

const createJob = (h, over = {}) => h.sa.createJob({ title: 'Add hello', idea: 'Add a hello endpoint.', primaryRepo: shared.repo, fixture: 'milestone-2', ...over });
const steps = (started) => started.map((e) => [e.phase, e.task, e.purpose, e.role]);
const loopSteps = (started) => started.map((e) => [e.purpose, e.round, e.final]);
const lastEvent = (type) => (job, events) => events.at(-1).type === type;
const launchedIn = (phase, task) => (job, events) => events.some((e) => e.type === 'attempt-started' && e.dir && e.phase === phase && (task === undefined || e.task === task));
const endOf = (h, jobId, attemptId) => h.ended(jobId).find((e) => e.attemptId === attemptId);

const FF_ORDER = ['spec', 'spec-review', 'plan', 'plan-review', 'implement'];
const FF_ROLES = { spec: 'spec-writer', plan: 'planner' };

// Puts a fresh job at `phaseId` without running workers for the phases
// before it (the happy path runs them for real): the earlier artifacts are
// committed in one go and the earlier phases are recorded as synthetic done
// attempts (dir null, so h.started() leaves them out) and completions.
async function fastForward(h, job, phaseId, { tasks = TWO_TASKS } = {}) {
  const wt = job.repos.find((r) => r.id === 'primary').worktree;
  const paths = artifactPaths(job);
  const upTo = FF_ORDER.indexOf(phaseId);
  const files = { [paths.spec]: '# spec\n' };
  if (upTo > FF_ORDER.indexOf('plan')) Object.assign(files, { [paths.plan]: '# plan\n', [paths.tasks]: JSON.stringify(tasks, null, 2) });
  const git = (...args) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', timeout: 60_000 });
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt, ...rel.split('/'))), { recursive: true });
    await fs.writeFile(path.join(wt, ...rel.split('/')), text);
  }
  git('add', '--', ...Object.keys(files));
  git('commit', '-q', '-m', 'fast-forward');
  for (const phase of FF_ORDER.slice(0, upTo)) {
    if (FF_ROLES[phase]) {
      const attemptId = randomUUID();
      await h.store.append(job.jobId, { type: 'attempt-started', attemptId, phase, task: null, role: FF_ROLES[phase], model: 'claude-opus-5-5', n: 1, recovery: false, previousAttemptId: null, dir: null, purpose: 'author', round: null, final: false });
      await h.store.append(job.jobId, { type: 'attempt-ended', attemptId, outcome: 'done', summary: 'fast-forwarded', commits: [] });
    } else {
      await h.store.append(job.jobId, ev.phaseCompleted(phase, 1));
    }
  }
  assert.equal(h.store.get(job.jobId).phaseId, phaseId);
}

const BLOCKER = { id: 'B1', severity: 'blocker', text: 'the spec omits error handling' };
const MAJOR = { id: 'M1', severity: 'major', text: 'name the config file' };
const EVIDENCE = 'src/app.js:12 throws on a missing file';
const changes = (finding) => ({ publish }) => publish({ verdict: 'changes', findings: [finding] });
const decline = (finding) => ({ publish }) => publish({ findings: [{ ...finding, disposition: 'declined: out of scope' }] });
const failedTest = (summary, findings) => ({ status: 'failed', artifacts: [], summary, question: null, findings });

test('milestone-2 happy path: spec to accept with two dependent tasks', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness();
    const job = await createJob(h);
    const parked = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);
    assert.deepEqual([parked.state, parked.reason], ['needs-you', 'ready-to-try']);

    const started = h.started(job.jobId);
    assert.deepEqual(steps(started), [
      ['spec', null, 'author', 'spec-writer'],
      ['spec-review', null, 'review', 'spec-reviewer'],
      ['plan', null, 'author', 'planner'],
      ['plan-review', null, 'review', 'plan-reviewer'],
      ['implement', 'T1', 'implement', 'implementer'],
      ['implement', 'T1', 'task-review', 'task-reviewer'],
      ['implement', 'T2', 'implement', 'implementer'],
      ['implement', 'T2', 'task-review', 'task-reviewer'],
      ['test', null, 'test', 'tester'],
    ]);
    assert.deepEqual(started.filter((e) => e.purpose === 'review' || e.purpose === 'task-review').map((e) => e.round), [1, 1, 1, 1]);
    assert.ok(h.ended(job.jobId).every((e) => e.outcome === 'done'), 'every attempt is done');

    // T2 (dependsOn T1) only starts after T1's task review ended.
    const evs = h.events(job.jobId);
    const t1Review = started.find((e) => e.task === 'T1' && e.purpose === 'task-review').attemptId;
    const t1ReviewEnd = evs.findIndex((e) => e.type === 'attempt-ended' && e.attemptId === t1Review);
    const t2Start = evs.findIndex((e) => e.type === 'attempt-started' && e.task === 'T2');
    assert.ok(t1ReviewEnd > 0 && t2Start > t1ReviewEnd);

    assert.deepEqual(evs.filter((e) => e.type === 'tasks-loaded').map((e) => e.tasks.map((t) => [t.id, t.dependsOn])), [[['T2', ['T1']], ['T1', []]]]);
    assert.deepEqual(parked.completions.map((c) => [c.phase, c.visit, c.unresolved]), [['spec-review', 1, []], ['plan-review', 1, []], ['implement', 1, []]]);

    const cards = h.worker.cards();
    const t1Impl = h.worker.log.find((e) => e.card.taskId === 'T1' && e.card.purpose === 'implement');
    assert.deepEqual(t1Impl.body.evidence.checks, [{ cmd: 'npm test', exit: 0 }]);
    const t1ReviewCard = cards.find((c) => c.taskId === 'T1' && c.purpose === 'task-review');
    assert.deepEqual(t1ReviewCard.taskCommits, t1Impl.body.evidence.commits);
    assert.deepEqual(cards.find((c) => c.taskId === 'T2').effectiveTasks.map((t) => t.id), ['T2', 'T1']);
    assert.match(cards.find((c) => c.purpose === 'test').outputs.testReport, /test-report\.md$/);

    const accepted = await h.sa.accept(job.jobId);
    assert.equal(accepted.state, 'done');
    assert.equal(registry.list().length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a reviewer that always answers changes stops at the cap: 3 reviewers, 3 fixes, the last final, then the next phase', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness({ handlers: handlersWith({ review: changes(MAJOR), fix: decline(MAJOR), 'plan:author': () => HOLD }) });
    const job = await createJob(h);
    await fastForward(h, job, 'spec-review');
    const got = await h.drive(job.jobId, launchedIn('plan'));
    assert.deepEqual(h.worker.errors, []);

    assert.deepEqual(loopSteps(h.started(job.jobId, 'spec-review')), [
      ['review', 1, false], ['fix', 1, false], ['review', 2, false], ['fix', 2, false], ['review', 3, false], ['fix', 3, true],
    ]);
    assert.ok(h.started(job.jobId, 'spec-review').every((e) => e.role === (e.purpose === 'review' ? 'spec-reviewer' : 'spec-writer')));
    assert.equal(h.started(job.jobId).filter((e) => e.purpose === 'verify').length, 0, 'no blocker, no verifier');
    assert.deepEqual(got.completions.find((c) => c.phase === 'spec-review'), {
      phase: 'spec-review', visit: 1, unresolved: [{ ...MAJOR, status: 'declined' }], verification: [],
    });
    assert.deepEqual(steps(h.started(job.jobId).slice(-1)), [['plan', null, 'author', 'planner']]);

    const cards = h.worker.cards().filter((c) => c.phaseId === 'spec-review');
    const reviews = `docs/superpowers/jobs/${job.slug}/reviews`;
    assert.deepEqual(cards.map((c) => c.previousFindings), [null, `${reviews}/spec-review-r1.md`, `${reviews}/spec-review-r1.md`, `${reviews}/spec-review-r2.md`, `${reviews}/spec-review-r2.md`, `${reviews}/spec-review-r3.md`]);
    assert.ok(cards.every((c) => c.target === artifactPaths(job).spec));
    assert.deepEqual(cards.map((c) => c.final), [false, false, false, false, false, true]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

async function contestedRun(verified) {
  const h = await harness({
    handlers: handlersWith({
      review: changes(BLOCKER),
      fix: decline(BLOCKER),
      verify: ({ card, publish }) => publish({ verified: card.contested.map(({ id }) => ({ id, verified, evidence: EVIDENCE })) }),
      'plan:author': () => HOLD,
    }),
  });
  const job = await createJob(h);
  await fastForward(h, job, 'spec-review');
  const got = await h.drive(job.jobId, (j, events) => j.state !== 'running' || launchedIn('plan')(j, events));
  assert.deepEqual(h.worker.errors, []);
  assert.deepEqual(loopSteps(h.started(job.jobId, 'spec-review')), [
    ['review', 1, false], ['fix', 1, false], ['review', 2, false], ['fix', 2, false], ['review', 3, false], ['fix', 3, true], ['verify', null, false],
  ]);
  const verify = h.started(job.jobId, 'spec-review').at(-1);
  assert.equal(verify.role, 'verifier');
  const card = h.worker.cards().find((c) => c.purpose === 'verify');
  assert.deepEqual(card.contested, [{ id: 'B1', text: BLOCKER.text, disposition: 'declined: out of scope' }]);
  assert.deepEqual(card.outputs, { verify: `docs/superpowers/jobs/${job.slug}/reviews/spec-review-verify.md` });
  return { h, job, got, verify };
}

test('a contested blocker at the cap reaches the verifier; verified:false proceeds as disputed-not-verified', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const { h, job, got } = await contestedRun(false);
    assert.equal(got.state, 'running');
    assert.deepEqual(got.completions.find((c) => c.phase === 'spec-review'), {
      phase: 'spec-review',
      visit: 1,
      unresolved: [{ ...BLOCKER, status: 'disputed-not-verified' }],
      verification: [{ id: 'B1', verified: false, evidence: EVIDENCE }],
    });
    assert.deepEqual(steps(h.started(job.jobId).slice(-1)), [['plan', null, 'author', 'planner']]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a contested blocker the verifier confirms parks the job needs-you with the evidence', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const { h, job, got, verify } = await contestedRun(true);
    assert.deepEqual([got.state, got.reason], ['needs-you', 'question']);
    assert.deepEqual(got.detail, {
      kind: 'blocker',
      text: `The verifier confirmed blocker B1: ${BLOCKER.text}`,
      evidence: `B1: ${EVIDENCE}`,
      attemptId: verify.attemptId,
      phase: 'spec-review',
      task: null,
    });
    assert.equal(got.phaseId, 'spec-review');
    assert.equal(got.completions.some((c) => c.phase === 'spec-review'), false);
    assert.equal(h.started(job.jobId, 'plan').length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an approve with an open blocker is invalid-result and is retried, bounded by attemptsPerPhase', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    // repeatedErrorStop above the cap, so the attempt cap is what stops it.
    const h = await harness({
      limits: { repeatedErrorStop: 3 },
      handlers: handlersWith({ review: ({ publish }) => publish({ verdict: 'approve', findings: [BLOCKER] }) }),
    });
    const job = await createJob(h);
    await fastForward(h, job, 'spec-review');
    const got = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);

    const started = h.started(job.jobId);
    assert.deepEqual(loopSteps(started), [['review', 1, false], ['review', 1, false], ['review', 1, false]]);
    assert.deepEqual(started.map((e) => [e.recovery, e.previousAttemptId]), [[false, null], [true, started[0].attemptId], [true, started[1].attemptId]]);
    for (const e of started) {
      const end = endOf(h, job.jobId, e.attemptId);
      assert.deepEqual([end.outcome, end.reason], ['failed', 'invalid-result']);
      assert.match(end.signature, /approve is not allowed with an open blocker/);
    }
    assert.deepEqual([got.state, got.reason], ['needs-you', 'stuck']);
    assert.deepEqual([got.detail.phase, got.detail.task, got.detail.why, got.detail.lastReason], ['spec-review', null, 'attempt-cap', 'invalid-result']);
    assert.equal(got.completions.some((c) => c.phase === 'spec-review'), false);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a task review loop: changes, fix, approve completes the task with both commits on the round-2 card; at taskReviewRounds the verifier path is the same', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const byTask = (handlers) => (ctx) => handlers[ctx.card.taskId](ctx);
    const h = await harness({
      handlers: handlersWith({
        'task-review': byTask({
          T1: (ctx) => (ctx.card.round === 1 ? changes(MAJOR)(ctx) : approve(ctx)),
          T2: changes(BLOCKER),
        }),
        fix: byTask({
          T1: ({ publish }) => publish({ findings: [{ ...MAJOR, disposition: 'fixed' }] }),
          T2: decline(BLOCKER),
        }),
        verify: ({ publish }) => publish({ verified: [{ id: 'B1', verified: false, evidence: EVIDENCE }] }),
        test: () => HOLD,
      }),
    });
    const job = await createJob(h);
    await fastForward(h, job, 'implement', { tasks: [task('T1'), task('T2', { dependsOn: ['T1'] })] });
    const got = await h.drive(job.jobId, launchedIn('test'));
    assert.deepEqual(h.worker.errors, []);

    const t1 = h.started(job.jobId).filter((e) => e.task === 'T1');
    const t2 = h.started(job.jobId).filter((e) => e.task === 'T2');
    assert.deepEqual(loopSteps(t1), [['implement', null, false], ['task-review', 1, false], ['fix', 1, false], ['task-review', 2, false]]);
    assert.deepEqual(t1.map((e) => e.role), ['implementer', 'task-reviewer', 'implementer', 'task-reviewer']);
    assert.deepEqual(loopSteps(t2), [['implement', null, false], ['task-review', 1, false], ['fix', 1, false], ['task-review', 2, false], ['fix', 2, true], ['verify', null, false]]);
    assert.equal(t2.at(-1).role, 'verifier');
    assert.ok(t2[0].seq > t1.at(-1).seq, 'T2 starts after T1 completed');

    const body = (taskId, purpose) => h.worker.log.find((e) => e.card.taskId === taskId && e.card.purpose === purpose).body;
    const cards = h.worker.cards();
    const round2 = cards.find((c) => c.taskId === 'T1' && c.purpose === 'task-review' && c.round === 2);
    assert.deepEqual(round2.taskCommits, [...body('T1', 'implement').evidence.commits, ...body('T1', 'fix').evidence.commits]);
    assert.equal(round2.taskCommits.length, 2);
    assert.equal(round2.previousFindings, `docs/superpowers/jobs/${job.slug}/tasks/T1-review-r1.md`);
    const t1Fix = cards.find((c) => c.taskId === 'T1' && c.purpose === 'fix');
    assert.deepEqual([t1Fix.target, t1Fix.task.id, t1Fix.previousFindings], [null, 'T1', `docs/superpowers/jobs/${job.slug}/tasks/T1-review-r1.md`]);
    const t2Verify = cards.find((c) => c.taskId === 'T2' && c.purpose === 'verify');
    assert.deepEqual(t2Verify.outputs, { taskVerify: `docs/superpowers/jobs/${job.slug}/tasks/T2-verify.md` });
    assert.deepEqual(t2Verify.contested, [{ id: 'B1', text: BLOCKER.text, disposition: 'declined: out of scope' }]);

    assert.deepEqual(got.completions.find((c) => c.phase === 'implement'), {
      phase: 'implement',
      visit: 1,
      unresolved: [{ ...BLOCKER, status: 'disputed-not-verified', task: 'T2' }],
      verification: [{ id: 'B1', verified: false, evidence: EVIDENCE, task: 'T2' }],
    });
    assert.equal(got.phaseId, 'test');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('two test-failure cycles: a planner task F1 does not collide with the generated fix ids, each implement completion advances to test, a stale visit-1 phase-completed is ignored', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    let runs = 0;
    const h = await harness({
      handlers: handlersWith({
        test: ({ publish }) => {
          runs += 1;
          if (runs === 1) {
            return failedTest('2 tests fail', [
              { id: 'F1', severity: 'major', text: 'GET /hello returns 500' },
              { id: 'F2', severity: 'minor', text: 'the body lacks a newline' },
            ]);
          }
          if (runs === 2) return failedTest('1 test fails', [{ id: 'F1', severity: 'major', text: 'GET /hello still returns 500' }]);
          return publish();
        },
      }),
    });
    const job = await createJob(h);
    await fastForward(h, job, 'implement', { tasks: [task('F1')] });

    let got = await h.drive(job.jobId, lastEvent('test-routed'));
    assert.deepEqual([got.phaseId, got.visits.implement], ['implement', 2]);
    await h.store.append(job.jobId, ev.phaseCompleted('implement', 1));
    got = h.store.get(job.jobId);
    assert.deepEqual([got.phaseId, got.visits.implement], ['implement', 2], 'the stale visit-1 completion is ignored');
    assert.deepEqual(got.completions.filter((c) => c.phase === 'implement').map((c) => c.visit), [1]);

    got = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);
    assert.deepEqual([got.state, got.reason], ['needs-you', 'ready-to-try']);

    const tests = h.started(job.jobId, 'test');
    assert.deepEqual(tests.map((e) => [e.n, e.recovery, e.previousAttemptId]), [[1, false, null], [2, false, null], [3, false, null]]);
    const fixIds = tests.slice(0, 2).map((e) => `F-${e.attemptId.slice(0, 8)}`);
    assert.deepEqual(got.tasks.map((t) => [t.id, t.origin, t.fromAttemptId]), [
      ['F1', 'plan', null],
      [fixIds[0], 'test', tests[0].attemptId],
      [fixIds[1], 'test', tests[1].attemptId],
    ]);
    assert.equal(got.tasks[1].acceptance, 'GET /hello returns 500\nthe body lacks a newline');
    assert.deepEqual(steps(h.started(job.jobId)), [
      ['implement', 'F1', 'implement', 'implementer'],
      ['implement', 'F1', 'task-review', 'task-reviewer'],
      ['test', null, 'test', 'tester'],
      ['implement', fixIds[0], 'implement', 'implementer'],
      ['implement', fixIds[0], 'task-review', 'task-reviewer'],
      ['test', null, 'test', 'tester'],
      ['implement', fixIds[1], 'implement', 'implementer'],
      ['implement', fixIds[1], 'task-review', 'task-reviewer'],
      ['test', null, 'test', 'tester'],
    ]);
    const evs = h.events(job.jobId);
    assert.equal(evs.filter((e) => e.type === 'test-routed').length, 2);
    const implementDone = evs.filter((e) => e.type === 'phase-completed' && e.phase === 'implement');
    assert.deepEqual(implementDone.map((e) => e.visit), [1, 1, 2, 3], 'the hand-appended stale event is the second');
    assert.deepEqual(got.completions.filter((c) => c.phase === 'implement').map((c) => c.visit), [1, 2, 3]);
    for (const done of [implementDone[0], implementDone[2], implementDone[3]]) {
      const next = evs.find((e) => e.seq > done.seq && e.type === 'attempt-started');
      assert.equal(next.phase, 'test', `implement visit ${done.visit} advances to test`);
    }
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an additional-repo-only task completes with an additional-repo commit plus the primary report commit; a test failure naming that repo routes a fix task whose repos include it', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    let implementRuns = 0;
    let tests = 0;
    const h = await harness({
      handlers: handlersWith({
        implement: ({ commit, publish }) => {
          if (++implementRuns > 1) return HOLD;
          const libSha = commit({ 'src/lib.js': 'export const hello = () => "hello";\n' }, 'lib: hello', 'lib');
          const body = publish();
          body.evidence.commits.unshift({ repo: 'lib', sha: libSha });
          return body;
        },
        test: () => {
          tests += 1;
          return failedTest('lib test fails', [{ id: 'X1', severity: 'major', text: 'hello() throws', repo: 'lib' }]);
        },
      }),
    });
    const job = await createJob(h, { additionalRepos: [shared.lib] });
    assert.deepEqual(job.repos.map((r) => r.id), ['primary', 'lib']);
    await fastForward(h, job, 'implement', { tasks: [task('L1', { repos: ['lib'] })] });
    const got = await h.drive(job.jobId, (j, events) => (j.tasks ?? []).length === 2 && launchedIn('implement', j.tasks[1].id)(j, events));
    assert.deepEqual(h.worker.errors, []);

    const l1 = h.started(job.jobId).find((e) => e.task === 'L1' && e.purpose === 'implement');
    const l1End = endOf(h, job.jobId, l1.attemptId);
    assert.equal(l1End.outcome, 'done');
    assert.deepEqual(l1End.commits.map((c) => c.repo), ['lib', 'primary']);
    const libHead = execFileSync('git', ['log', '-1', '--format=%H %s', job.branch], { cwd: shared.lib, encoding: 'utf8', timeout: 60_000 }).trim();
    assert.equal(libHead, `${l1End.commits[0].sha} lib: hello`);
    const review = h.worker.cards().find((c) => c.taskId === 'L1' && c.purpose === 'task-review');
    assert.deepEqual(review.taskCommits, l1End.commits);
    assert.deepEqual(review.repos.map((r) => r.id), ['primary', 'lib']);
    assert.equal(got.completions.filter((c) => c.phase === 'implement').length, 1);

    assert.equal(tests, 1);
    const fix = got.tasks[1];
    assert.deepEqual([fix.origin, fix.repos], ['test', ['lib']]);
    const fixCard = h.worker.cards().at(-1);
    assert.deepEqual([fixCard.taskId, fixCard.purpose, fixCard.task.repos], [fix.id, 'implement', ['lib']]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('test failure routing: one F-xxxxxxxx task per failed tester attempt, a restart right after test-routed launches the fix task, and a second failure at the attempt cap parks the job stuck', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness({
      limits: { attemptsPerPhase: 2 },
      handlers: handlersWith({
        test: () => failedTest('2 tests fail', [
          { id: 'E1', severity: 'major', text: 'GET /hello returns 500' },
          { id: 'E2', severity: 'minor', text: 'no newline at end of body' },
        ]),
      }),
    });
    const job = await createJob(h);
    await fastForward(h, job, 'implement', { tasks: [task('T1')] });
    await h.drive(job.jobId, lastEvent('test-routed'));
    const [testAttempt] = h.started(job.jobId, 'test');
    const routed = h.events(job.jobId).at(-1);
    assert.equal(routed.attemptId, testAttempt.attemptId);
    assert.match(routed.task.id, /^F-[0-9a-f]{8}$/);
    assert.deepEqual(routed.task, {
      id: `F-${testAttempt.attemptId.slice(0, 8)}`,
      title: `Fix test failures from attempt ${testAttempt.attemptId.slice(0, 8)}`,
      repos: ['primary'],
      dependsOn: [],
      acceptance: 'GET /hello returns 500\nno newline at end of body',
      verify: '',
      origin: 'test',
      fromAttemptId: testAttempt.attemptId,
    });
    await h.sa.stop();

    const fresh = await h.restart();
    await fresh.sa.start();
    await fresh.sa.tick();
    const relaunched = fresh.started(job.jobId).at(-1);
    assert.deepEqual([relaunched.phase, relaunched.task, relaunched.purpose], ['implement', routed.task.id, 'implement']);
    const routedCount = () => fresh.events(job.jobId).filter((e) => e.type === 'test-routed').length;
    assert.equal(routedCount(), 1);

    const got = await fresh.drive(job.jobId);
    assert.deepEqual(fresh.worker.errors, []);
    assert.deepEqual([got.state, got.reason], ['needs-you', 'stuck']);
    assert.deepEqual([got.detail.phase, got.detail.why], ['test', 'attempt-cap']);
    assert.equal(routedCount(), 1, 'the capped failure is not routed');
    assert.deepEqual(steps(fresh.started(job.jobId)), [
      ['implement', 'T1', 'implement', 'implementer'],
      ['implement', 'T1', 'task-review', 'task-reviewer'],
      ['test', null, 'test', 'tester'],
      ['implement', routed.task.id, 'implement', 'implementer'],
      ['implement', routed.task.id, 'task-review', 'task-reviewer'],
      ['test', null, 'test', 'tester'],
    ]);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('a plan-review fix that corrupts tasks.json is invalid-result and retried', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    let fixes = 0;
    let tasksRel = null;
    const revised = [task('T1', { title: 'Task T1 (revised)' })];
    const h = await harness({
      handlers: handlersWith({
        'plan-review:review': (ctx) => (ctx.card.round === 1 ? changes(MAJOR)(ctx) : approve(ctx)),
        'plan-review:fix': ({ publish }) => publish(
          { findings: [{ ...MAJOR, disposition: 'fixed' }] },
          { files: { [tasksRel]: ++fixes === 1 ? '[{"id": "T1",' : JSON.stringify(revised, null, 2) } },
        ),
        implement: () => HOLD,
      }),
    });
    const job = await createJob(h);
    tasksRel = artifactPaths(job).tasks;
    await fastForward(h, job, 'plan-review', { tasks: [task('T1')] });
    const got = await h.drive(job.jobId, launchedIn('implement'));
    assert.deepEqual(h.worker.errors, []);

    const started = h.started(job.jobId, 'plan-review');
    assert.deepEqual(loopSteps(started), [['review', 1, false], ['fix', 1, false], ['fix', 1, false], ['review', 2, false]]);
    assert.deepEqual(started.map((e) => e.role), ['plan-reviewer', 'planner', 'planner', 'plan-reviewer']);
    assert.deepEqual([started[2].recovery, started[2].previousAttemptId], [true, started[1].attemptId]);
    const corrupt = endOf(h, job.jobId, started[1].attemptId);
    assert.deepEqual([corrupt.outcome, corrupt.reason], ['failed', 'invalid-result']);
    assert.match(corrupt.signature, /tasks\.json.*not valid json/);
    assert.equal(endOf(h, job.jobId, started[2].attemptId).outcome, 'done');
    assert.deepEqual(got.completions.find((c) => c.phase === 'plan-review'), { phase: 'plan-review', visit: 1, unresolved: [], verification: [] });
    assert.deepEqual(got.tasks.map((t) => [t.id, t.title]), [['T1', 'Task T1 (revised)']]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an invalid tasks.json (cycle) fails the planner attempt as invalid-result and the planner is retried', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    let plans = 0;
    const cyclic = [task('T1', { dependsOn: ['T2'] }), task('T2', { dependsOn: ['T1'] })];
    const h = await harness({
      handlers: handlersWith({
        'plan:author': ({ publish }) => publish({}, { content: { tasks: JSON.stringify(++plans === 1 ? cyclic : TWO_TASKS) } }),
        'plan-review:review': () => HOLD,
      }),
    });
    const job = await createJob(h);
    await fastForward(h, job, 'plan');
    const got = await h.drive(job.jobId, launchedIn('plan-review'));
    assert.deepEqual(h.worker.errors, []);

    const planners = h.started(job.jobId, 'plan');
    assert.equal(planners.length, 2);
    assert.deepEqual(planners.map((e) => [e.n, e.recovery, e.previousAttemptId]), [[1, false, null], [2, true, planners[0].attemptId]]);
    const first = endOf(h, job.jobId, planners[0].attemptId);
    assert.deepEqual([first.outcome, first.reason], ['failed', 'invalid-result']);
    assert.match(first.signature, /dependency cycle/);
    assert.equal(endOf(h, job.jobId, planners[1].attemptId).outcome, 'done');
    assert.deepEqual([got.phaseId, got.tasks], ['plan-review', null]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('stopJob mid-review-loop closes the live attempt and launches nothing more', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness({ handlers: handlersWith({ review: changes(MAJOR), fix: () => HOLD }) });
    const job = await createJob(h);
    await fastForward(h, job, 'spec-review');
    await h.drive(job.jobId, (j) => j.attempts.some((a) => a.purpose === 'fix' && a.sessionId));
    const fix = h.store.get(job.jobId).attempts.at(-1);
    assert.deepEqual([fix.purpose, fix.round, fix.outcome], ['fix', 1, null]);
    assert.equal(registry.list().length, 1);

    const stopped = await h.sa.stopJob(job.jobId);
    assert.equal(stopped.state, 'stopped');
    assert.equal(endOf(h, job.jobId, fix.attemptId).outcome, 'stopped');
    assert.equal(h.events(job.jobId).at(-1).type, 'job-stopped');
    assert.equal(registry.list().length, 0);
    assert.equal(h.factory.impls.get(fix.sessionId).closed, true);

    const count = h.events(job.jobId).length;
    for (let i = 0; i < 3; i++) {
      h.clock.t += 6 * MIN;
      await h.sa.tick();
    }
    assert.equal(h.events(job.jobId).length, count, 'nothing appended after the stop');
    assert.deepEqual(loopSteps(h.started(job.jobId)), [['review', 1, false], ['fix', 1, false]]);
    assert.equal(registry.list().length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

// --- Plan 4: the supervisor's routing step (a fake router, scripted workers) ---

const INVALID = { status: 'maybe', artifacts: [], summary: 'not sure what happened', question: null };
const decision = (action, note = `router says ${action}`) => ({ ok: true, action, note, usage: { inputTokens: 900, outputTokens: 12, totalInputTokens: 900 }, latencyMs: 5, apiKeySource: 'none' });
// The first call of a handler answers `first`, every later one `rest`.
const firstThen = (first, rest = HOLD) => {
  let n = 0;
  return (ctx) => {
    const pick = ++n === 1 ? first : rest;
    if (pick === HOLD) return HOLD;
    return typeof pick === 'function' ? pick(ctx) : pick;
  };
};
const routerEvents = (h, jobId) => h.events(jobId).filter((e) => e.type === 'router-decided');
const tickOnce = async (h) => {
  h.clock.t += 6 * MIN;
  await h.sa.tick();
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const cardOf = (req) => JSON.parse(req.card);

// Records every request; `answer` is a decide result or (req, n) => result.
function fakeRouter(answer = decision('retry')) {
  const requests = [];
  return {
    requests,
    decide(req) {
      requests.push(req);
      return Promise.resolve(typeof answer === 'function' ? answer(req, requests.length) : answer);
    },
  };
}

// Every call stays pending until resolved by hand; like the real router it
// settles { ok: false, error: 'aborted' } once its signal aborts.
function heldRouter() {
  const requests = [];
  const calls = [];
  return {
    requests,
    calls,
    decide(req) {
      requests.push(req);
      const d = deferred();
      req.signal.addEventListener('abort', () => d.resolve({ ok: false, error: 'aborted', usage: null, latencyMs: 1, apiKeySource: null }), { once: true });
      calls.push({ req, resolve: d.resolve });
      return d.promise;
    },
  };
}

const specStarts = (n) => (j, events) => events.filter((e) => e.type === 'attempt-started' && e.phase === 'spec').length === n;

test('router: a failed attempt is routed, then retried as decided', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = fakeRouter(decision('retry'));
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID, ({ publish }) => publish()) }) });
    const job = await createJob(h);
    const got = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);
    assert.deepEqual([got.state, got.reason], ['needs-you', 'ready-to-try']);

    const specs = h.started(job.jobId, 'spec');
    assert.equal(specs.length, 2);
    assert.deepEqual([endOf(h, job.jobId, specs[0].attemptId).reason, specs[1].recovery, specs[1].previousAttemptId], ['invalid-result', true, specs[0].attemptId]);
    const decided = routerEvents(h, job.jobId);
    assert.equal(decided.length, 1);
    assert.deepEqual(
      [decided[0].forAttemptId, decided[0].ok, decided[0].action, decided[0].note, decided[0].error, decided[0].model, decided[0].latencyMs],
      [specs[0].attemptId, true, 'retry', 'router says retry', null, 'claude-haiku-5-5', 5],
    );
    assert.ok(decided[0].request.estimatedTokens > 0);
    assert.deepEqual(decided[0].request.truncated, []);
    assert.deepEqual(decided[0].usage, decision('retry').usage);
    assert.ok(decided[0].seq < specs[1].seq);

    assert.equal(router.requests.length, 1);
    const [req] = router.requests;
    assert.deepEqual(req.allowed, ['retry', 'escalate']);
    assert.deepEqual([req.model, req.maxOutputTokens, req.allowlist, req.system], ['claude-haiku-5-5', 300, ['claude-haiku-5-5'], ROUTER_SYSTEM_PROMPT]);
    assert.ok(req.signal instanceof AbortSignal);
    assert.deepEqual(cardOf(req).allowed, ['retry', 'escalate']);
    assert.equal(cardOf(req).trigger.attemptId, specs[0].attemptId);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: retry-alternate launches the implementer on its alternate model', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = fakeRouter(decision('retry-alternate'));
    const h = await harness({ router, handlers: handlersWith({ implement: firstThen(INVALID) }) });
    const job = await createJob(h);
    await fastForward(h, job, 'implement', { tasks: [task('T1')] });
    await h.drive(job.jobId, (j, events) => events.filter((e) => e.type === 'attempt-started' && e.purpose === 'implement').length === 2);
    assert.deepEqual(h.worker.errors, []);

    const impls = h.started(job.jobId, 'implement');
    assert.deepEqual(impls.map((e) => [e.task, e.model]), [['T1', 'claude-sonnet-5-5'], ['T1', 'claude-opus-5-5']]);
    assert.deepEqual(router.requests.map((r) => r.allowed), [['retry', 'retry-alternate', 'escalate']]);
    assert.deepEqual([cardOf(router.requests[0]).trigger.task, cardOf(router.requests[0]).trigger.role], ['T1', 'implementer']);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: the trigger carries the failed attempt\'s own model', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const failedAgain = { status: 'failed', artifacts: [], summary: 'the build still breaks', question: null };
    const router = fakeRouter((req, n) => decision(n === 1 ? 'retry-alternate' : 'escalate'));
    const h = await harness({ router, limits: { attemptsPerTask: 3 }, handlers: handlersWith({ implement: firstThen(INVALID, failedAgain) }) });
    const job = await createJob(h);
    await fastForward(h, job, 'implement', { tasks: [task('T1')] });
    const got = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);
    assert.deepEqual([got.state, got.reason, got.detail.why], ['needs-you', 'stuck', 'router-escalated']);
    assert.deepEqual(h.started(job.jobId, 'implement').map((e) => e.model), ['claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.deepEqual(router.requests.map((r) => cardOf(r).trigger.model), ['claude-sonnet-5-5', 'claude-opus-5-5']);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: retry-handoff is offered only when handoff.md exists and passes it on', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const writeHandoff = async ({ card }) => {
      await fs.mkdir(card.attemptDir, { recursive: true });
      await fs.writeFile(path.join(card.attemptDir, 'handoff.md'), '# where I stopped\n');
      return INVALID;
    };
    const router = fakeRouter(decision('retry-handoff'));
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(writeHandoff) }) });
    const job = await createJob(h);
    await h.drive(job.jobId, specStarts(2));
    assert.deepEqual(h.worker.errors, []);
    const specs = h.started(job.jobId, 'spec');
    assert.deepEqual(router.requests.map((r) => r.allowed), [['retry', 'retry-handoff', 'escalate']]);
    const handoff = path.join(specs[0].dir, 'handoff.md');
    assert.deepEqual([specs[0].handoff, specs[1].handoff], [null, handoff]);
    assert.equal(h.worker.cards().at(-1).handoff, handoff);
    await h.sa.stop();

    const bare = fakeRouter(decision('escalate'));
    const h2 = await harness({ router: bare, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job2 = await createJob(h2);
    await h2.drive(job2.jobId);
    assert.deepEqual(bare.requests.map((r) => r.allowed), [['retry', 'escalate']]);
    await h2.sa.stop();
  } finally { registry._reset(); }
});

test('router: escalate stops the job as stuck with the note', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = fakeRouter(decision('escalate', 'the idea needs a human decision'));
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    const got = await h.drive(job.jobId);
    assert.deepEqual([got.state, got.reason], ['needs-you', 'stuck']);
    assert.deepEqual([got.detail.phase, got.detail.why, got.detail.note, got.detail.lastReason], ['spec', 'router-escalated', 'the idea needs a human decision', 'invalid-result']);
    assert.equal(h.started(job.jobId, 'spec').length, 1);
    assert.equal(router.requests.length, 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: a router failure escalates the job as stuck with the error, also when decide rejects', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const failures = [
      { decide: () => Promise.resolve({ ok: false, error: 'Not logged in · Please run /login', usage: null, latencyMs: 40, apiKeySource: 'none' }) },
      { decide: () => Promise.reject(new Error('Not logged in · Please run /login (thrown)')) },
    ];
    for (const router of failures) {
      const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
      const job = await createJob(h);
      const got = await h.drive(job.jobId);
      assert.deepEqual([got.state, got.reason, got.detail.why], ['needs-you', 'stuck', 'router-failed']);
      assert.match(got.detail.error, /Not logged in/);
      const [decided] = routerEvents(h, job.jobId);
      assert.deepEqual([decided.ok, decided.action, decided.note], [false, 'escalate', null]);
      assert.match(decided.error, /Not logged in/);
      assert.equal(h.started(job.jobId, 'spec').length, 1);
      await h.sa.stop();
    }
  } finally { registry._reset(); }
});

test('router: an "aborted" error the supervisor did not cause is recorded like any failure', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = fakeRouter({ ok: false, error: 'aborted', usage: null, latencyMs: 3, apiKeySource: null });
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    const got = await h.drive(job.jobId);
    assert.deepEqual([got.state, got.reason, got.detail.why, got.detail.error], ['needs-you', 'stuck', 'router-failed', 'aborted']);
    const decided = routerEvents(h, job.jobId);
    assert.equal(decided.length, 1);
    assert.deepEqual([decided[0].ok, decided[0].action, decided[0].error], [false, 'escalate', 'aborted']);
    assert.equal(router.requests.length, 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: an over-limit request makes no call and is stuck', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = fakeRouter();
    const h = await harness({ router, defaults: { routerMaxInputTokens: 700 }, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    assert.equal(job.router.maxInputTokens, 700);
    const got = await h.drive(job.jobId);
    assert.equal(router.requests.length, 0);
    const decided = routerEvents(h, job.jobId);
    assert.equal(decided.length, 1);
    assert.deepEqual([decided[0].ok, decided[0].action, decided[0].note, decided[0].usage, decided[0].latencyMs, decided[0].model], [false, 'escalate', null, null, 0, 'claude-haiku-5-5']);
    assert.match(decided[0].error, /^over-limit: estimated \d+ tokens > 700$/);
    assert.ok(decided[0].request.estimatedTokens > 700);
    assert.deepEqual([got.state, got.reason, got.detail.why], ['needs-you', 'stuck', 'router-failed']);
    assert.match(got.detail.error, /^over-limit/);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: the card built by the supervisor carries status and question', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const blocked = { status: 'blocked', artifacts: [], summary: 'the idea contradicts the README', question: null };
    const router = fakeRouter(decision('escalate'));
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(blocked) }) });
    const job = await createJob(h);
    await h.drive(job.jobId);
    const [spec] = h.started(job.jobId, 'spec');
    const { trigger } = cardOf(router.requests[0]);
    assert.deepEqual(
      [trigger.attemptId, trigger.phase, trigger.task, trigger.role, trigger.reason, trigger.status, trigger.question, trigger.summary],
      [spec.attemptId, 'spec', null, 'spec-writer', 'blocked', 'blocked', null, blocked.summary],
    );
    assert.deepEqual([trigger.attemptsUsed, trigger.attemptsLeft, trigger.resultPath], [1, 2, path.join(spec.dir, 'result.json')]);
    assert.deepEqual(trigger.allowed, ['retry', 'escalate']);
    await h.sa.stop();

    // No result at all: the session goes away before result.json exists.
    const router2 = fakeRouter(decision('escalate'));
    const h2 = await harness({ router: router2, handlers: handlersWith({ 'spec:author': () => HOLD }) });
    const job2 = await createJob(h2);
    const live = await h2.drive(job2.jobId, (j) => j.attempts.some((a) => a.sessionId));
    registry.closeSession(live.attempts[0].sessionId);
    await h2.sa.drain();
    await h2.drive(job2.jobId);
    const t2 = cardOf(router2.requests[0]).trigger;
    assert.deepEqual([t2.reason, t2.status, t2.question, t2.summary], ['no-result', null, null, null]);
    await h2.sa.stop();
  } finally { registry._reset(); }
});

test('router: the tick does not wait on the router', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = heldRouter();
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    await h.drive(job.jobId, () => router.requests.length === 1);
    const count = h.events(job.jobId).length;
    await tickOnce(h);
    await tickOnce(h);
    assert.equal(h.events(job.jobId).length, count, 'nothing launched or appended while the router call is pending');
    assert.equal(router.requests.length, 1, 'decide is not called again');

    router.calls[0].resolve(decision('retry'));
    await h.sa.drain();
    assert.equal(routerEvents(h, job.jobId).length, 1);
    await tickOnce(h);
    assert.equal(h.started(job.jobId, 'spec').length, 2);
    assert.equal(router.requests.length, 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: stop aborts an in-flight router call and records nothing', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = heldRouter();
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    await h.drive(job.jobId, () => router.requests.length === 1);
    const count = h.events(job.jobId).length;
    await h.sa.stop();
    assert.equal(router.requests[0].signal.aborted, true);
    await settle();
    assert.equal(h.events(job.jobId).length, count);
    assert.equal(routerEvents(h, job.jobId).length, 0);
  } finally { registry._reset(); }
});

test('router: stopJob during a router call leaves no router-decided', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = heldRouter();
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    await h.drive(job.jobId, () => router.requests.length === 1);
    const stopping = h.sa.stopJob(job.jobId);
    assert.equal(router.requests[0].signal.aborted, true, 'aborted synchronously');
    const stopped = await stopping;
    assert.equal(stopped.state, 'stopped');
    await h.sa.drain();
    await tickOnce(h);
    assert.equal(routerEvents(h, job.jobId).length, 0);
    assert.equal(h.events(job.jobId).at(-1).type, 'job-stopped');
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('router: stopping one job leaves another job\'s router call intact', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = heldRouter();
    let specRuns = 0;
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': () => (++specRuns <= 2 ? INVALID : HOLD) }) });
    const a = await createJob(h, { title: 'Add hello' });
    const b = await createJob(h, { title: 'Add goodbye' });
    for (let i = 0; i < 20 && router.requests.length < 2; i++) await tickOnce(h);
    assert.equal(router.requests.length, 2);
    const attemptOf = (job) => h.started(job.jobId, 'spec')[0].attemptId;
    const callOf = (job) => router.calls.find((c) => cardOf(c.req).trigger.attemptId === attemptOf(job));

    await h.sa.stopJob(a.jobId);
    assert.deepEqual([callOf(a).req.signal.aborted, callOf(b).req.signal.aborted], [true, false]);
    callOf(b).resolve(decision('retry'));
    await h.sa.drain();
    assert.deepEqual([routerEvents(h, a.jobId).length, routerEvents(h, b.jobId).length], [0, 1]);
    await tickOnce(h);
    assert.equal(h.started(b.jobId, 'spec').length, 2);
    assert.equal(h.started(a.jobId, 'spec').length, 1);
    assert.equal(h.store.get(a.jobId).state, 'stopped');
    await h.sa.stop();
  } finally { registry._reset(); }
});

// Ticks without awaiting until the route's budget check is pending, stops,
// then lets the check pass.
async function stopDuringRouteBudgetCheck({ defaults } = {}) {
  const gate = deferred();
  let routeChecks = 0;
  const budgetCheck = ({ action }) => {
    if (action.type !== 'route') return { allow: true };
    routeChecks += 1;
    return gate.promise;
  };
  const router = fakeRouter();
  const h = await harness({ router, budgetCheck, defaults, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
  const job = await createJob(h);
  await h.drive(job.jobId, (j) => j.attempts[0]?.outcome === 'failed');
  h.clock.t += 6 * MIN;
  const ticking = h.sa.tick();
  for (let i = 0; i < 100 && routeChecks === 0; i++) await settle();
  assert.equal(routeChecks, 1);
  const count = h.events(job.jobId).length;
  await h.sa.stop();
  gate.resolve({ allow: true });
  await ticking;
  await h.sa.drain();
  assert.equal(router.requests.length, 0);
  assert.equal(h.events(job.jobId).length, count);
  assert.equal(routerEvents(h, job.jobId).length, 0);
}

test('router: stop during a pending budget check starts no call and appends nothing, also when over-limit', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    await stopDuringRouteBudgetCheck();
    await stopDuringRouteBudgetCheck({ defaults: { routerMaxInputTokens: 700 } });
  } finally { registry._reset(); }
});

test('router: a rejected decision append is retried without a second call', { timeout: TEST_TIMEOUT_MS }, async () => {
  const unhandled = [];
  const spy = (err) => unhandled.push(err);
  process.on('unhandledRejection', spy);
  try {
    for (const mode of ['before-write', 'after-write']) {
      const router = fakeRouter(decision('retry'));
      const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
      const original = h.store.append;
      let failing = true;
      h.store.append = (jobId, event) => {
        if (event.type !== 'router-decided' || !failing) return original(jobId, event);
        failing = false;
        if (mode === 'before-write') return Promise.reject(new Error('disk full'));
        return original(jobId, event).then(() => { throw new Error('fsync reported failure'); });
      };
      const job = await createJob(h);
      await h.drive(job.jobId, specStarts(2));
      assert.equal(failing, false, `${mode}: the append was attempted`);
      assert.equal(router.requests.length, 1, `${mode}: decide is called once`);
      assert.equal(routerEvents(h, job.jobId).length, 1, `${mode}: one router-decided`);
      const specs = h.started(job.jobId, 'spec');
      assert.equal(specs[1].previousAttemptId, specs[0].attemptId);
      await h.sa.stop();
    }
    await settle();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', spy);
    registry._reset();
  }
});

test('router: restart after a decision launches without calling the router', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = heldRouter();
    const h = await harness({ router, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    await h.drive(job.jobId, () => router.requests.length === 1);
    router.calls[0].resolve(decision('retry'));
    await h.sa.drain();
    await h.sa.stop();
    assert.equal(h.events(job.jobId).at(-1).type, 'router-decided');

    const freshRouter = fakeRouter();
    const fresh = await h.restart({ router: freshRouter });
    await fresh.sa.start();
    await fresh.sa.tick();
    assert.equal(fresh.started(job.jobId, 'spec').length, 2);
    assert.equal(freshRouter.requests.length, 0);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('router: the budget check runs before a router call', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const router = fakeRouter();
    const checked = [];
    const budgetCheck = ({ action }) => {
      checked.push(action.type);
      return action.type === 'route' ? { allow: false, reason: 'job budget spent' } : { allow: true };
    };
    const h = await harness({ router, budgetCheck, handlers: handlersWith({ 'spec:author': firstThen(INVALID) }) });
    const job = await createJob(h);
    const got = await h.drive(job.jobId);
    assert.deepEqual([got.state, got.reason, got.detail], ['needs-you', 'question', { kind: 'budget', text: 'job budget spent' }]);
    assert.deepEqual(checked, ['launch', 'route']);
    assert.equal(router.requests.length, 0);
    assert.equal(routerEvents(h, job.jobId).length, 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('pipelineRoles adds the stand-in for a brainstorm phase', () => {
  const roles = pipelineRoles(defaultConfig().pipeline);
  assert.ok(roles.includes('brainstormer') && roles.includes('stand-in'));
  assert.ok(!pipelineRoles(MILESTONE_2_PIPELINE).includes('stand-in'));
});

// --- Plan 5: the automatic brainstorm and answered questions (default pipeline) ---

const createDefaultJob = (h, over = {}) => createJob(h, { fixture: null, ...over });
const headed = (title) => `# ${title}\n\n## Assumptions made for you\n\n- Q1: port 8080\n\n## Your answers\n\n- Q2: Postgres\n`;
const Q1 = { id: 'Q1', text: 'Which port should it listen on?' };
const Q2 = { id: 'Q2', text: 'Which database should it use?' };
const DB_QUESTION = 'Which database should the hello endpoint use?';
const asks = (questions) => ({ status: 'done', artifacts: [], summary: `asks ${questions.length} questions`, question: null, questions });
const writeBrief = ({ publish }) => publish({ questions: [] }, { content: { brief: headed('Brief') } });
const writeSpec = ({ publish }) => publish({}, { content: { spec: headed('Spec') } });
const standInAnswers = (card, skip = null) => card.openQuestions
  .filter((q) => q.id !== skip)
  .map((q) => ({ id: q.id, tag: 'from-idea', answer: `answer to ${q.id}`, reason: 'the idea says so' }));
const standIn = ({ card }) => ({ status: 'done', artifacts: [], summary: 'answered every question', question: null, answers: standInAnswers(card) });
const escalate = (id) => ({ card }) => ({
  status: 'blocked', artifacts: [], summary: 'only the user knows which database', question: DB_QUESTION, escalated: id, answers: standInAnswers(card, id),
});
// Asks Q1 and Q2 on the first turn, writes the brief on every later one.
const brainstormWith = (answer = standIn) => ({ 'brainstorm:ask': firstThen(() => asks([Q1, Q2]), writeBrief), 'brainstorm:answer': answer });
// One turn: the brief straight away.
const NO_BRAINSTORM = { 'brainstorm:ask': writeBrief, 'spec:author': writeSpec };
const blockedWith = (question) => ({ status: 'blocked', artifacts: [], summary: 'needs a decision', question });
const needsYouCount = (h, jobId) => h.events(jobId).filter((e) => e.type === 'needs-you').length;
const rejectsWith = (promise, code) => assert.rejects(promise, (err) => {
  assert.equal(err.code, code);
  return true;
});

test('automatic brainstorm reaches spec with the brief', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness({ handlers: handlersWith({ ...brainstormWith(), 'spec:author': () => HOLD }) });
    const job = await createDefaultJob(h);
    assert.equal(job.pipeline[0].kind, 'brainstorm');
    const got = await h.drive(job.jobId, launchedIn('spec'));
    assert.deepEqual(h.worker.errors, []);
    assert.equal(got.phaseId, 'spec');

    assert.deepEqual(steps(h.started(job.jobId)), [
      ['brainstorm', null, 'ask', 'brainstormer'],
      ['brainstorm', null, 'answer', 'stand-in'],
      ['brainstorm', null, 'ask', 'brainstormer'],
      ['spec', null, 'author', 'spec-writer'],
    ]);
    const cards = h.worker.cards();
    const standInCard = cards.find((c) => c.purpose === 'answer');
    assert.deepEqual([standInCard.resultVia, standInCard.openQuestions], ['final-message', [Q1, Q2]]);
    const brief = artifactPaths(job).brief;
    assert.equal(cards.find((c) => c.phaseId === 'spec').inputs.brief, brief);
    const wt = job.repos.find((r) => r.id === 'primary').worktree;
    assert.equal(readFileSync(path.join(wt, ...brief.split('/')), 'utf8'), headed('Brief'));

    const log = brainstormLog(got);
    assert.deepEqual(log.map((e) => [e.id, e.tag, e.answer]), [['Q1', 'from-idea', 'answer to Q1'], ['Q2', 'from-idea', 'answer to Q2']]);
    assert.ok(log.every((e) => ANSWER_TAGS.includes(e.tag)));
    assert.equal(needsYouCount(h, job.jobId), 0);
    await h.sa.stop();
  } finally { registry._reset(); }
});

// Runs the brainstorm until the stand-in escalates Q2.
async function escalatedJob() {
  const h = await harness({ handlers: handlersWith({ ...brainstormWith(escalate('Q2')), 'spec:author': () => HOLD }) });
  const job = await createDefaultJob(h);
  const parked = await h.drive(job.jobId);
  assert.deepEqual(h.worker.errors, []);
  return { h, job, parked };
}

test('stand-in escalation, answer, resume', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const { h, job, parked } = await escalatedJob();
    assert.deepEqual([parked.state, parked.reason, parked.detail.kind], ['needs-you', 'question', 'stand-in']);
    const standInAttempt = h.started(job.jobId).at(-1);
    assert.deepEqual([standInAttempt.purpose, parked.detail.attemptId, parked.detail.question], ['answer', standInAttempt.attemptId, DB_QUESTION]);
    assert.deepEqual(parked.detail.brainstormQuestion, Q2);
    assert.equal(registry.list().length, 0, 'no live session while the job waits');
    assert.ok([...h.factory.impls.values()].every((impl) => impl.closed));

    const resumed = await h.sa.answerQuestion(job.jobId, 'Postgres');
    assert.equal(resumed.state, 'running');
    assert.deepEqual(resumed.answers.map((a) => [a.forAttemptId, a.answer]), [[standInAttempt.attemptId, 'Postgres']]);
    const answeredEvent = h.events(job.jobId).at(-1);
    assert.deepEqual([answeredEvent.type, answeredEvent.forAttemptId, answeredEvent.answer], ['question-answered', standInAttempt.attemptId, 'Postgres']);

    const got = await h.drive(job.jobId, launchedIn('spec'));
    assert.deepEqual(h.worker.errors, []);
    assert.equal(got.phaseId, 'spec');
    const askCards = h.worker.cards().filter((c) => c.purpose === 'ask');
    assert.equal(askCards.length, 2);
    assert.deepEqual(askCards[1].exchanges.map((e) => [e.id, e.tag, e.answer]), [['Q1', 'from-idea', 'answer to Q1'], ['Q2', 'from-you', 'Postgres']]);
    const lastAsk = h.started(job.jobId, 'brainstorm').at(-1);
    assert.equal(endOf(h, job.jobId, lastAsk.attemptId).outcome, 'done', 'the brief is accepted');
    assert.equal(needsYouCount(h, job.jobId), 1);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('restart after an answer launches the asking scope', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const { h, job } = await escalatedJob();
    await h.sa.answerQuestion(job.jobId, 'Postgres');
    await h.sa.stop();
    const before = h.started(job.jobId).length;

    const fresh = await h.restart();
    await fresh.sa.start();
    await fresh.sa.tick();
    const launched = fresh.started(job.jobId);
    assert.equal(launched.length, before + 1);
    assert.deepEqual(steps(launched.slice(-1)), [['brainstorm', null, 'ask', 'brainstormer']]);
    const [card] = fresh.worker.cards();
    const q2 = card.exchanges.find((e) => e.id === 'Q2');
    assert.deepEqual([q2.tag, q2.answer], ['from-you', 'Postgres']);
    assert.equal(needsYouCount(fresh, job.jobId), 1, 'no needs-you after the restart');
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

test('answerQuestion refuses wrong states, budget questions, repeats and bad text', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness({ handlers: handlersWith({ ...brainstormWith(escalate('Q2')), 'spec:author': () => HOLD }) });
    const job = await createDefaultJob(h);
    const lines = () => h.events(job.jobId).length;
    let count = lines();
    await rejectsWith(h.sa.answerQuestion(job.jobId, 'Postgres'), 'ERR_INVALID_STATE');
    assert.equal(lines(), count, 'a running job');

    const parked = await h.drive(job.jobId);
    assert.deepEqual([parked.state, parked.reason, parked.detail.kind], ['needs-you', 'question', 'stand-in']);
    count = lines();
    for (const text of ['', '   ', 'x'.repeat(4001), null, 42]) {
      await rejectsWith(h.sa.answerQuestion(job.jobId, text), 'ERR_INVALID_ANSWER');
      assert.equal(lines(), count, `text ${String(text).slice(0, 20)}`);
    }
    const answered = await h.sa.answerQuestion(job.jobId, `  ${'x'.repeat(4000)}  `);
    assert.deepEqual(answered.answers.map((a) => a.answer), ['x'.repeat(4000)]);
    count = lines();
    await rejectsWith(h.sa.answerQuestion(job.jobId, 'MySQL'), 'ERR_INVALID_STATE');
    assert.equal(lines(), count, 'a second answer');
    await rejectsWith(h.sa.answerQuestion('no-such-job', 'Postgres'), 'ERR_UNKNOWN_JOB');
    await h.sa.stop();

    const b = await harness({ handlers: handlersWith(NO_BRAINSTORM), budgetCheck: () => ({ allow: false, reason: 'job budget spent' }) });
    const budgetJob = await createDefaultJob(b);
    const refused = await b.drive(budgetJob.jobId);
    assert.deepEqual([refused.state, refused.reason, refused.detail], ['needs-you', 'question', { kind: 'budget', text: 'job budget spent' }]);
    const budgetLines = b.events(budgetJob.jobId).length;
    await rejectsWith(b.sa.answerQuestion(budgetJob.jobId, 'raise it'), 'ERR_INVALID_STATE');
    assert.equal(b.events(budgetJob.jobId).length, budgetLines, 'a budget question');
    await b.sa.stop();
  } finally { registry._reset(); }
});

test('an answered spec question resumes spec', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness({
      handlers: handlersWith({ ...NO_BRAINSTORM, 'spec:author': firstThen(blockedWith('Which port?'), writeSpec), 'spec-review:review': () => HOLD }),
    });
    const job = await createDefaultJob(h);
    const parked = await h.drive(job.jobId);
    const [asking] = h.started(job.jobId, 'spec');
    assert.deepEqual([parked.state, parked.reason, parked.detail], ['needs-you', 'question', { attemptId: asking.attemptId, question: 'Which port?' }]);

    await h.sa.answerQuestion(job.jobId, '8080');
    const got = await h.drive(job.jobId, launchedIn('spec-review'));
    assert.deepEqual(h.worker.errors, []);
    assert.equal(got.phaseId, 'spec-review');
    const specCards = h.worker.cards().filter((c) => c.phaseId === 'spec');
    assert.equal(specCards.length, 2);
    assert.equal('userAnswers' in specCards[0], false);
    assert.deepEqual(specCards[1].userAnswers, [{ question: 'Which port?', answer: '8080' }]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('the fourth question in a scope is stuck', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    let asked = 0;
    const h = await harness({ handlers: handlersWith({ ...NO_BRAINSTORM, 'spec:author': () => blockedWith(`Question ${++asked}?`) }) });
    const job = await createDefaultJob(h);
    for (let i = 1; i <= 3; i++) {
      const parked = await h.drive(job.jobId);
      assert.deepEqual([parked.state, parked.reason, parked.detail.question], ['needs-you', 'question', `Question ${i}?`]);
      await h.sa.answerQuestion(job.jobId, `answer ${i}`);
    }
    const got = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);
    assert.deepEqual([got.state, got.reason, got.detail.phase, got.detail.why], ['needs-you', 'stuck', 'spec', 'question-cap']);
    assert.equal(h.started(job.jobId, 'spec').length, 4);
    assert.deepEqual(h.worker.cards().at(-1).userAnswers.map((a) => a.answer), ['answer 1', 'answer 2', 'answer 3']);
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('a dismissed blocker closes after the extra round', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const pipeline = defaultConfig().pipeline.map((p) => (p.phase === 'spec-review' ? { ...p, maxRounds: 1 } : p));
    const h = await harness({
      projects: { [shared.repo]: { pipeline } },
      handlers: handlersWith({
        ...NO_BRAINSTORM,
        'spec-review:review': (ctx) => (ctx.card.round === 1 ? changes(BLOCKER)(ctx) : approve(ctx)),
        'spec-review:fix': ({ card, publish }) => (card.round === 1
          ? decline(BLOCKER)({ publish })
          : publish({ findings: [{ ...BLOCKER, disposition: `declined: the user said "${card.userAnswers[0].answer}"` }] })),
        verify: ({ card, publish }) => publish({ verified: card.contested.map(({ id }) => ({ id, verified: true, evidence: EVIDENCE })) }),
        'plan:author': () => HOLD,
      }),
    });
    const job = await createDefaultJob(h);
    assert.equal(job.pipeline.find((p) => p.phase === 'spec-review').maxRounds, 1);
    const parked = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);
    const verifyAttempt = h.started(job.jobId, 'spec-review').at(-1);
    assert.deepEqual([parked.state, parked.reason, parked.detail.kind, parked.detail.attemptId], ['needs-you', 'question', 'blocker', verifyAttempt.attemptId]);

    await h.sa.answerQuestion(job.jobId, 'leave it');
    const got = await h.drive(job.jobId, launchedIn('plan'));
    assert.deepEqual(h.worker.errors, []);
    assert.deepEqual(loopSteps(h.started(job.jobId, 'spec-review')), [
      ['review', 1, false], ['fix', 1, true], ['verify', null, false], ['fix', 2, true], ['review', 2, false],
    ]);
    const fix2 = h.worker.cards().find((c) => c.purpose === 'fix' && c.round === 2);
    assert.deepEqual(fix2.reviewFindings, [BLOCKER]);
    assert.equal(fix2.previousFindings, null);
    assert.equal(parked.detail.text, `The verifier confirmed blocker B1: ${BLOCKER.text}`);
    assert.deepEqual(fix2.userAnswers, [{ question: parked.detail.text, answer: 'leave it' }]);
    const fix2Body = h.worker.log.find((e) => e.card === fix2).body;
    assert.equal(fix2Body.findings[0].disposition, 'declined: the user said "leave it"');
    assert.deepEqual(got.completions.find((c) => c.phase === 'spec-review'), { phase: 'spec-review', visit: 1, unresolved: [], verification: [] });
    assert.deepEqual(steps(h.started(job.jobId).slice(-1)), [['plan', null, 'author', 'planner']]);
    await h.sa.stop();
  } finally { registry._reset(); }
});

// The default pipeline as Plan 6 recorded it: no phase carries `test`.
const PRE_PLAN_7_PIPELINE = [
  { phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] },
  { phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['brief'], outputs: ['spec'] },
  { phase: 'spec-review', kind: 'review', role: 'spec-reviewer', author: 'spec-writer', target: 'spec', maxRounds: 3 },
  { phase: 'plan', kind: 'author', role: 'planner', inputs: ['spec'], outputs: ['plan', 'tasks'] },
  { phase: 'plan-review', kind: 'review', role: 'plan-reviewer', author: 'planner', target: 'plan', inputs: ['spec', 'tasks'], maxRounds: 3 },
  { phase: 'implement', kind: 'per-task', role: 'implementer', taskReview: 'task-reviewer', inputs: ['tasks'] },
  { phase: 'test', kind: 'author', role: 'tester', inputs: ['spec', 'tasks'], outputs: ['testReport'] },
  { phase: 'accept', kind: 'human', inputs: ['testReport'] },
];

test('a pre-Plan-7 job resumes and routes a test failure', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    let tests = 0;
    const h = await harness({
      handlers: handlersWith({
        test: ({ publish }) => (++tests === 1 ? failedTest('1 test fails', [{ id: 'E1', severity: 'major', text: 'GET /hello returns 500' }]) : publish()),
      }),
    });
    const job = await createDefaultJob(h);
    await h.sa.stop();
    const [created, ...provisioned] = h.events(job.jobId);
    assert.deepEqual(provisioned.map((e) => e.type), ['worktree-created', 'job-provisioned']);
    const { slug, createdDate } = created;
    const today = {
      brief: `docs/superpowers/jobs/${slug}/brief.md`,
      spec: `docs/superpowers/specs/${createdDate}-${slug}-design.md`,
      plan: `docs/superpowers/plans/${createdDate}-${slug}.md`,
      tasks: `docs/superpowers/jobs/${slug}/tasks.json`,
      testReport: `docs/superpowers/jobs/${slug}/test-report.md`,
    };

    const wt = job.repos.find((r) => r.id === 'primary').worktree;
    const files = { [today.brief]: headed('Brief'), [today.spec]: headed('Spec'), [today.plan]: '# plan\n', [today.tasks]: JSON.stringify([task('T1')], null, 2) };
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(wt, ...rel.split('/'))), { recursive: true });
      await fs.writeFile(path.join(wt, ...rel.split('/')), text);
    }
    const git = (...args) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', timeout: 60_000 });
    git('add', '--', ...Object.keys(files));
    git('commit', '-q', '-m', 'the job so far');

    // Written field by field, as Plan 6 wrote it: no workflow, artifacts,
    // prompts or test flag, and repos without the in-place fields.
    const oldCreated = {
      seq: created.seq, at: created.at, type: 'job-created', jobId: created.jobId, slug, title: created.title, idea: created.idea, mode: created.mode,
      branch: created.branch, createdDate, repos: created.repos.map(({ id, origin }) => ({ id, origin })), pipeline: PRE_PLAN_7_PIPELINE,
      models: created.models, limits: created.limits, router: created.router, workerPermissionMode: created.workerPermissionMode, copyLocalClaudeSettings: created.copyLocalClaudeSettings,
    };
    const doneAttempt = (phase, role, purpose, started = {}, ended = {}) => {
      const attemptId = randomUUID();
      return [
        { type: 'attempt-started', attemptId, phase, task: null, role, model: 'claude-opus-5-5', n: 1, recovery: false, previousAttemptId: null, dir: null, purpose, round: null, final: false, ...started },
        { type: 'attempt-ended', attemptId, outcome: 'done', summary: 'written by hand', commits: [], ...ended },
      ];
    };
    const later = [
      ...doneAttempt('brainstorm', 'brainstormer', 'ask', {}, { questions: [] }),
      ...doneAttempt('spec', 'spec-writer', 'author'),
      ev.phaseCompleted('spec-review', 1),
      ...doneAttempt('plan', 'planner', 'author'),
      ev.phaseCompleted('plan-review', 1),
      ev.tasksLoaded([{ ...task('T1'), origin: 'plan', fromAttemptId: null }]),
      ...doneAttempt('implement', 'implementer', 'implement', { task: 'T1' }),
      ...doneAttempt('implement', 'task-reviewer', 'task-review', { task: 'T1', round: 1 }, { verdict: 'approve', findings: [] }),
      ev.phaseCompleted('implement', 1),
    ];
    const log = [oldCreated, ...provisioned, ...later.map((e, i) => ({ seq: provisioned.at(-1).seq + 1 + i, at: h.clock.t, ...e }))];
    await fs.writeFile(path.join(h.store.jobDir(job.jobId), 'events.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const fresh = await h.restart();
    const resumed = await fresh.store.load(job.jobId);
    assert.deepEqual([resumed.state, resumed.phaseId, resumed.workflow], ['running', 'test', null]);
    assert.deepEqual(resumed.artifacts, today);
    await fresh.sa.start();

    const routed = await fresh.drive(job.jobId, lastEvent('test-routed'));
    assert.deepEqual([routed.phaseIndex, routed.phaseId, routed.visits.implement], [5, 'implement', 2]);
    const got = await fresh.drive(job.jobId);
    assert.deepEqual(fresh.worker.errors, []);
    assert.deepEqual([got.state, got.reason], ['needs-you', 'ready-to-try']);

    const [failed] = fresh.started(job.jobId, 'test');
    const fixId = `F-${failed.attemptId.slice(0, 8)}`;
    assert.deepEqual(steps(fresh.started(job.jobId)), [
      ['test', null, 'test', 'tester'],
      ['implement', fixId, 'implement', 'implementer'],
      ['implement', fixId, 'task-review', 'task-reviewer'],
      ['test', null, 'test', 'tester'],
    ]);
    assert.deepEqual(got.tasks.map((t) => [t.id, t.origin]), [['T1', 'plan'], [fixId, 'test']]);
    assert.equal(got.visits.implement, 2);
    const testerCards = fresh.worker.cards().filter((c) => c.phaseId === 'test');
    assert.equal(testerCards.length, 2);
    for (const c of testerCards) assert.deepEqual([c.inputs, c.outputs], [{ spec: today.spec, tasks: today.tasks }, { testReport: today.testReport }]);
    assert.match(readFileSync(path.join(wt, ...today.testReport.split('/')), 'utf8'), /^# test test /);
    await fresh.sa.stop();
  } finally { registry._reset(); }
});

const createTroubleshooting = (h, over = {}) => createJob(h, { fixture: null, workflow: 'troubleshooting', title: 'Fix hello', idea: 'GET /hello returns 500.', ...over });
const DIAGNOSIS = '# Diagnosis\n\n## Reproduction\n\ncurl /hello\n\n## Evidence\n\nsrc/app.js:12\n\n## Root cause\n\nnull config\n\n## Hypothesis tested\n\nguard the read: 500 gone\n';
const writeDiagnosis = ({ publish }) => publish({}, { content: { diagnosis: DIAGNOSIS, tasks: JSON.stringify([task('T1', { verify: 'npm test' })], null, 2) } });
const troubleshootingHandlers = (over = {}) => ({
  'investigate:author': writeDiagnosis,
  'diagnosis-review:review': approve,
  'fix:implement': ({ publish }) => publish(),
  'fix:task-review': approve,
  'verify:test': ({ publish }) => publish(),
  ...over,
});

test('troubleshooting runs investigate to accept with one routed failure', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    let verifies = 0;
    const h = await harness({
      handlers: troubleshootingHandlers({
        'verify:test': ({ publish }) => (++verifies === 1 ? failedTest('the reproduction still fails', [{ id: 'V1', severity: 'major', text: 'GET /hello still returns 500' }]) : publish()),
      }),
    });
    const job = await createTroubleshooting(h);
    const got = await h.drive(job.jobId);
    assert.deepEqual(h.worker.errors, []);
    assert.deepEqual([got.state, got.reason], ['needs-you', 'ready-to-try']);

    const [failed] = h.started(job.jobId, 'verify');
    const fixId = `F-${failed.attemptId.slice(0, 8)}`;
    assert.deepEqual(steps(h.started(job.jobId)), [
      ['investigate', null, 'author', 'investigator'],
      ['diagnosis-review', null, 'review', 'diagnosis-reviewer'],
      ['fix', 'T1', 'implement', 'fixer'],
      ['fix', 'T1', 'task-review', 'fix-reviewer'],
      ['verify', null, 'test', 'verifier-tester'],
      ['fix', fixId, 'implement', 'fixer'],
      ['fix', fixId, 'task-review', 'fix-reviewer'],
      ['verify', null, 'test', 'verifier-tester'],
    ]);
    assert.deepEqual(got.tasks.map((t) => [t.id, t.origin]), [['T1', 'plan'], [fixId, 'test']]);
    assert.equal(got.visits.fix, 2);
    for (const c of h.worker.cards().filter((card) => card.phaseId === 'fix' && card.purpose === 'implement')) {
      assert.ok('diagnosis' in c.inputs, 'the fixer card lists diagnosis among its inputs');
      assert.equal(c.inputs.diagnosis, got.artifacts.diagnosis);
    }
    await h.sa.stop();
  } finally { registry._reset(); }
});

test('an investigator that cannot reproduce asks the user', { timeout: TEST_TIMEOUT_MS }, async () => {
  try {
    const h = await harness({
      handlers: troubleshootingHandlers({ 'investigate:author': firstThen(blockedWith('Which build shows the 500?'), writeDiagnosis), 'diagnosis-review:review': () => HOLD }),
    });
    const job = await createTroubleshooting(h);
    const parked = await h.drive(job.jobId);
    const [asking] = h.started(job.jobId, 'investigate');
    assert.deepEqual([parked.state, parked.reason, parked.detail], ['needs-you', 'question', { attemptId: asking.attemptId, question: 'Which build shows the 500?' }]);

    await h.sa.answerQuestion(job.jobId, 'the release build');
    const got = await h.drive(job.jobId, launchedIn('diagnosis-review'));
    assert.deepEqual(h.worker.errors, []);
    assert.equal(got.phaseId, 'diagnosis-review');
    const cards = h.worker.cards().filter((c) => c.phaseId === 'investigate');
    assert.equal(cards.length, 2);
    assert.deepEqual(cards[1].userAnswers, [{ question: 'Which build shows the 500?', answer: 'the release build' }]);
    await h.sa.stop();
  } finally { registry._reset(); }
});
