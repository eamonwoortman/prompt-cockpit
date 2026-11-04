// Milestone-2 pipeline integration: createSuperagent driven by tick() with
// scripted fake workers (tests/superagent-helpers.mjs scriptedWorker) that
// commit real files in the job's worktrees. One origin repo (plus one
// additional repo) is shared by the whole file; each test gets its own
// store, registry state and job branch.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { HOLD, MIN, T0, ev, initRepo, scriptedWorker, sessionFactory, tempDir } from './superagent-helpers.mjs';
import { createSuperagentStore } from '../src/superagent/store.js';
import { createSuperagentConfig } from '../src/superagent/config.js';
import { artifactPaths } from '../src/superagent/results.js';
import { createSuperagent } from '../src/superagent/index.js';

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

async function harness({ handlers = handlersWith(), limits = null } = {}) {
  registry._reset();
  const root = await fs.mkdtemp(path.join(shared.root, 'h-'));
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(limits ? { defaults: { limits } } : {}));
  const jobsRoot = path.join(root, 'jobs');
  const worktreesRoot = path.join(shared.root, 'worktrees');
  const clock = { t: T0 };

  async function build() {
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
      async restart() {
        registry._reset();
        return build();
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
