import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, provisionedEvents } from './superagent-helpers.mjs';
import { deriveJob } from '../src/superagent/store.js';
import { artifactPaths, reviewPaths, requiredOutputs } from '../src/superagent/results.js';
import { MILESTONE_2_PIPELINE, defaultConfig } from '../src/superagent/config.js';
import { brainstormLog } from '../src/superagent/sequencer.js';
import { ANSWER_TAGS, BRAINSTORM_BATCH } from '../src/superagent/results.js';
import { READ_ONLY_ROLES, READ_ONLY_TOOLS, RECOVERY_NOTE, templatesDir, hasTemplate, buildWorkerPrompt, nudgeText } from '../src/superagent/prompts.js';

const IDEA = 'Line one of the idea.\n\n  Indented line two with "quotes" and \ backslash.\nLast line';

async function fixture(attemptOver = {}, extraAttempts = []) {
  const emptyDir = await tempDir('sa-prompts-');
  const events = [
    ...provisionedEvents({ jobId: 'j1', slug: 'add-hello-12345678', createdDate: '2026-11-03', idea: IDEA }),
    ...extraAttempts,
  ];
  const job = deriveJob(events);
  const phase = job.pipeline[0];
  const attempt = {
    attemptId: 'a2',
    phase: phase.phase,
    task: null,
    role: phase.role,
    n: 2,
    recovery: false,
    previousAttemptId: null,
    dir: path.join(emptyDir, 'attempts', 'a2'),
    ...attemptOver,
  };
  return { job, phase, attempt, emptyDir };
}

function parseCard(card) {
  assert.ok(card.startsWith('# Superagent job card'));
  const m = card.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, 'card has a json block');
  return JSON.parse(m[1]);
}

test('prompt surface: every role template plus the contract states the worker contract', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const roles = (await fs.readdir(templatesDir())).filter((f) => f.endsWith('.md') && f !== 'contract.md').map((f) => f.slice(0, -3));
  assert.ok(roles.includes('spec-writer'));
  for (const role of roles) {
    const { system } = await buildWorkerPrompt({ role, job, phase, attempt, projectDir: emptyDir });
    for (const needle of ['result.json.tmp', 'rename', '"attemptId"', '"status"', 'blocked', 'Do not start the next phase', 'If the job card has a recovery note', 'AskUserQuestion', 'list the commit sha(s) in `evidence.commits`']) {
      assert.ok(system.includes(needle), `${role}: missing ${needle}`);
    }
  }
});

test('the job card carries every field and the recovery note only on retries', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const { card } = await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir });
  const c = parseCard(card);
  assert.deepEqual(Object.keys(c).sort(), ['attemptDir', 'attemptId', 'idea', 'inputs', 'jobId', 'mode', 'outputs', 'handoff', 'phaseId', 'previousAttemptDir', 'previousFindings', 'recoveryNote', 'repos', 'round', 'taskId', 'title'].sort());
  assert.equal(c.jobId, job.jobId);
  assert.equal(c.phaseId, attempt.phase);
  assert.equal(c.taskId, null);
  assert.equal(c.attemptId, 'a2');
  assert.equal(c.title, job.title);
  assert.equal(c.mode, job.mode);
  assert.equal(c.idea, IDEA);
  assert.equal(c.repos[0].id, 'primary');
  assert.equal(c.repos[0].branch, job.branch);
  assert.equal(c.repos[0].worktree, job.repos[0].worktree);
  assert.equal(c.outputs.spec, artifactPaths(job).spec);
  assert.ok(!('idea' in c.inputs));
  assert.deepEqual(c.inputs, {});
  assert.deepEqual(c.outputs, { spec: artifactPaths(job).spec });
  assert.equal(c.attemptDir, attempt.dir);
  assert.equal(c.round, null);
  assert.equal(c.previousFindings, null);
  assert.equal(c.recoveryNote, null);
  assert.equal(c.previousAttemptDir, null);

  const a1Dir = path.join(emptyDir, 'attempts', 'a1');
  const started = { type: 'attempt-started', attemptId: 'a1', phase: phase.phase, task: null, role: phase.role, model: 'm', n: 1, dir: a1Dir };
  const retry = await fixture({ recovery: true, previousAttemptId: 'a1' }, [started]);
  const rc = parseCard((await buildWorkerPrompt({ role: 'spec-writer', job: retry.job, phase: retry.phase, attempt: retry.attempt, projectDir: retry.emptyDir })).card);
  assert.equal(rc.recoveryNote, RECOVERY_NOTE);
  assert.equal(rc.previousAttemptDir, a1Dir);
});

test('the job card inputs and outputs follow the current phase', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const paths = artifactPaths(job);
  const first = parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir })).card);
  assert.deepEqual(first.outputs, { spec: paths.spec });
  assert.deepEqual(first.inputs, {});

  const later = { ...phase, phase: 'plan', inputs: ['spec'], outputs: ['plan'] };
  const card = parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase: later, attempt: { ...attempt, phase: 'plan' }, projectDir: emptyDir })).card);
  assert.deepEqual(card.inputs, { spec: paths.spec });
  assert.deepEqual(card.outputs, { plan: paths.plan });
});

test('a missing role template fails and a project override wins', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  await assert.rejects(buildWorkerPrompt({ role: 'no-such-role', job, phase, attempt, projectDir: emptyDir }), { code: 'ERR_NO_TEMPLATE' });
  assert.equal(await hasTemplate('no-such-role', { projectDir: emptyDir }), false);
  assert.equal(await hasTemplate('spec-writer', { projectDir: emptyDir }), true);

  const overrides = path.join(emptyDir, '.superpowers', 'superagent', 'prompts');
  await fs.mkdir(overrides, { recursive: true });
  await fs.writeFile(path.join(overrides, 'spec-writer.md'), 'OVERRIDE-MARKER\n');
  const { system } = await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir });
  assert.ok(system.includes('OVERRIDE-MARKER'));
  assert.ok(system.includes('result.json.tmp'));
});

test('nudge texts name the attempt directory and ask for handoff.md on a turn cap', async () => {
  const { attempt: a } = await fixture();
  const r = nudgeText('result', a);
  assert.ok(r.includes(a.dir) && r.includes('result.json'));
  const t = nudgeText('turn-cap', a);
  assert.ok(t.includes('handoff.md') && t.includes(a.dir) && t.includes('result.json'));
});

test('a read-only role publishes via its final message: card field and nudge text', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const overrides = path.join(emptyDir, '.superpowers', 'superagent', 'prompts');
  await fs.mkdir(overrides, { recursive: true });
  await fs.writeFile(path.join(overrides, 'stand-in.md'), '# Stand-in\n');
  assert.deepEqual([...READ_ONLY_ROLES], ['stand-in']);
  assert.deepEqual(READ_ONLY_TOOLS, ['Read', 'Grep', 'Glob']);
  const standIn = parseCard((await buildWorkerPrompt({ role: 'stand-in', job, phase, attempt, projectDir: emptyDir })).card);
  assert.equal(standIn.resultVia, 'final-message');
  const writer = parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir })).card);
  assert.equal('resultVia' in writer, false);
  const text = 'No result was received. Reply with only the result JSON object as your final message.';
  assert.equal(nudgeText('result', { dir: attempt.dir, readOnly: true }), text);
  assert.equal(nudgeText('turn-cap', { dir: attempt.dir, readOnly: true }), text);
});

const TASK_DEF ={ id: 'T1', title: 'Add hello', repos: ['primary'], dependsOn: [], acceptance: 'hello exists', verify: 'npm test', origin: 'plan' };
const FIX_DEF = { id: 'F-0123abcd', title: 'Fix greeting', repos: ['primary'], dependsOn: [], acceptance: 'greeting is polite', verify: '', origin: 'test-failure' };

function started(attemptId, phase, purpose, over = {}) {
  return { type: 'attempt-started', attemptId, phase, task: null, role: 'x', model: 'm', n: 1, dir: `/d/${attemptId}`, purpose, round: null, final: false, ...over };
}
const ended = (attemptId, over = {}) => ({ type: 'attempt-ended', attemptId, outcome: 'done', ...over });

async function m2(extra = []) {
  const emptyDir = await tempDir('sa-prompts2-');
  const job = deriveJob([...provisionedEvents({ jobId: 'j1', slug: 'add-hello-12345678', createdDate: '2026-11-03', idea: IDEA, pipeline: MILESTONE_2_PIPELINE }), ...extra]);
  const phaseOf = (id) => job.pipeline.find((p) => p.phase === id);
  const card = async (role, phaseId, attempt) => parseCard((await buildWorkerPrompt({ role, job, phase: phaseOf(phaseId), attempt: { attemptId: 'cur', phase: phaseId, task: null, n: 1, recovery: false, previousAttemptId: null, dir: '/d/cur', ...attempt }, projectDir: emptyDir })).card);
  return { job, card, phaseOf };
}

test('every role in milestone-2 has a template', async () => {
  const projectDir = await tempDir('sa-prompts-');
  const roles = new Set(['task-reviewer', 'verifier']);
  for (const p of MILESTONE_2_PIPELINE) { if (p.role) roles.add(p.role); if (p.taskReview) roles.add(p.taskReview); }
  for (const role of roles) assert.equal(await hasTemplate(role, { projectDir }), true, role);
});

test('with no purpose the card equals the Plan 2 card', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const c = parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir })).card);
  assert.deepEqual(c, {
    jobId: job.jobId, phaseId: phase.phase, taskId: null, attemptId: 'a2', title: job.title, mode: job.mode, idea: IDEA,
    repos: [{ id: 'primary', worktree: job.repos[0].worktree, branch: job.branch }],
    inputs: {}, outputs: { spec: artifactPaths(job).spec }, attemptDir: attempt.dir, round: null, previousFindings: null, recoveryNote: null, previousAttemptDir: null, handoff: null,
  });
});

test('the card carries handoff', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const withHandoff = { ...attempt, handoff: '/w/a1/handoff.md' };
  assert.equal(parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt: withHandoff, projectDir: emptyDir })).card).handoff, '/w/a1/handoff.md');
  assert.equal(parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir })).card).handoff, null);
});

test('contract.md mentions handoff', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const { system } = await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir });
  assert.ok(system.includes('`handoff`'));
  assert.ok(system.includes('read that file first'));
});

test('contract.md and planner.md require listing every commit that touched an output, including earlier attempts', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const { system } = await buildWorkerPrompt({ role: 'planner', job, phase, attempt, projectDir: emptyDir });
  assert.ok(system.includes('Every output must appear in at least one commit you list'));
  assert.ok(system.includes('an earlier attempt of this phase'));
  assert.ok(system.includes('list every commit that touched them'));
});

test('the card carries purpose, round, final and the required outputs list when purpose is set', async () => {
  const { job, card, phaseOf } = await m2();
  const c = await card('spec-reviewer', 'spec-review', { purpose: 'review', round: 1, final: false });
  assert.equal(c.purpose, 'review');
  assert.equal(c.round, 1);
  assert.equal(c.final, false);
  const want = requiredOutputs(job, { phase: phaseOf('spec-review'), purpose: 'review', round: 1 });
  assert.deepEqual(Object.values(c.outputs), want);
  const a = await card('spec-writer', 'spec', { purpose: 'author' });
  assert.deepEqual(a.outputs, { spec: artifactPaths(job).spec });
  const f = await card('spec-writer', 'spec-review', { purpose: 'fix', round: 2, final: true });
  assert.equal(f.final, true);
});

test('a review card has target and previousFindings null in round 1, the previous review path in round 2', async () => {
  const { job, card } = await m2();
  const r1 = await card('spec-reviewer', 'spec-review', { purpose: 'review', round: 1 });
  assert.equal(r1.target, artifactPaths(job).spec);
  assert.equal(r1.previousFindings, null);
  const r2 = await card('spec-reviewer', 'spec-review', { purpose: 'review', round: 2 });
  assert.equal(r2.previousFindings, reviewPaths(job, { phase: 'spec-review', round: 1 }).review);
});

test('a fix card has previousFindings pointing at the round review file', async () => {
  const { job, card } = await m2([started('r1', 'spec-review', 'review', { round: 1 }), ended('r1', { verdict: 'changes', findings: [] })]);
  const c = await card('spec-writer', 'spec-review', { purpose: 'fix', round: 1 });
  assert.equal(c.previousFindings, reviewPaths(job, { phase: 'spec-review', round: 1 }).review);
  assert.equal(c.target, artifactPaths(job).spec);
  assert.deepEqual(Object.values(c.outputs), [reviewPaths(job, { phase: 'spec-review', round: 1 }).response]);
});

test('a task-review card lists cumulative taskCommits: round 2 after a fix includes the original implementation commit and the corrective commit', async () => {
  const events = [
    { type: 'tasks-loaded', tasks: [TASK_DEF] },
    started('i1', 'implement', 'implement', { task: 'T1' }), ended('i1', { commits: [{ repo: 'primary', sha: 'aaaa111' }] }),
    started('r1', 'implement', 'task-review', { task: 'T1', round: 1 }), ended('r1', { verdict: 'changes', findings: [{ id: 'F1', severity: 'major', text: 'bad' }] }),
    started('x1', 'implement', 'fix', { task: 'T1', round: 1 }), ended('x1', { commits: [{ repo: 'primary', sha: 'bbbb222' }, { repo: 'primary', sha: 'aaaa111' }] }),
    started('o1', 'implement', 'implement', { task: 'T2' }), ended('o1', { commits: [{ repo: 'primary', sha: 'cccc333' }] }),
  ];
  const { card } = await m2(events);
  const c = await card('task-reviewer', 'implement', { purpose: 'task-review', round: 2, task: 'T1', taskDef: TASK_DEF });
  assert.deepEqual(c.taskCommits, [{ repo: 'primary', sha: 'aaaa111' }, { repo: 'primary', sha: 'bbbb222' }]);
  assert.deepEqual(c.task, TASK_DEF);
  assert.equal(c.taskId, 'T1');
  assert.equal(c.target, null);
  assert.ok(c.previousFindings.endsWith('T1-review-r1.md'));
  const impl = await card('implementer', 'implement', { purpose: 'implement', task: 'T1', taskDef: TASK_DEF });
  assert.equal(impl.taskCommits, null);
});

test('a verify card lists contested findings', async () => {
  const events = [
    started('r3', 'plan-review', 'review', { round: 3 }),
    ended('r3', { verdict: 'changes', findings: [{ id: 'B1', severity: 'blocker', text: 'no rollback' }, { id: 'B2', severity: 'blocker', text: 'no tests' }, { id: 'M1', severity: 'minor', text: 'nit' }] }),
    started('x3', 'plan-review', 'fix', { round: 3, final: true }),
    ended('x3', { findings: [{ id: 'B1', severity: 'blocker', text: 'no rollback', disposition: 'declined: out of scope' }, { id: 'B2', severity: 'blocker', text: 'no tests', disposition: 'open' }] }),
  ];
  const { card } = await m2(events);
  const c = await card('verifier', 'plan-review', { purpose: 'verify', contested: ['B1', 'B2'] });
  assert.deepEqual(c.contested, [
    { id: 'B1', text: 'no rollback', disposition: 'declined: out of scope' },
    { id: 'B2', text: 'no tests', disposition: 'open' },
  ]);
  assert.equal(c.round, null);
  const other = await card('spec-reviewer', 'plan-review', { purpose: 'review', round: 1 });
  assert.equal(other.contested, null);
});

test('a tester card carries effectiveTasks including a generated fix task acceptance criteria', async () => {
  const { card } = await m2([{ type: 'tasks-loaded', tasks: [{ ...TASK_DEF, fromAttemptId: null }, { ...FIX_DEF, fromAttemptId: 'tt1' }] }]);
  const c = await card('tester', 'test', { purpose: 'test' });
  assert.deepEqual(c.effectiveTasks.map((t) => t.id), ['T1', 'F-0123abcd']);
  assert.equal(c.effectiveTasks[1].acceptance, 'greeting is polite');
  assert.deepEqual(Object.keys(c.effectiveTasks[0]).sort(), ['acceptance', 'id', 'origin', 'repos', 'title', 'verify']);
  const early = await (await m2()).card('spec-writer', 'spec', { purpose: 'author' });
  assert.ok(!('effectiveTasks' in early));
});

test('prompt surface: pinned strings in the pipeline templates and the contract', async () => {
  const read = (f) => fs.readFile(path.join(templatesDir(), f), 'utf8');
  const has = async (f, ...needles) => { const t = await read(f); for (const n of needles) assert.ok(t.includes(n), `${f}: missing ${n}`); };
  const fixRule = ['when `purpose` is `fix`, read `previousFindings`, change the artifact for each finding or decline it with a one-sentence reason, and write the response file', 'when `final` is true, append every finding you did not fix under a heading `## Unresolved review findings`'];
  await has('spec-writer.md', ...fixRule, '## Unresolved review findings');
  await has('planner.md', ...fixRule, '## Unresolved review findings', '`id`', '`title`', '`repos`', '`dependsOn`', '`acceptance`', '`verify`', 'ids are at most 12 characters, letters, digits and hyphens', 'one task = one worker session');
  for (const f of ['spec-reviewer.md', 'plan-reviewer.md']) await has(f, 'read-only', '`approve` only if there is no open blocker', 'blocker', 'major', 'minor', 'commit your review file and list its commit');
  await has('implementer.md', 'evidence.checks', 'exit code', 'check `git status` and `git log` before repeating work');
  await has('task-reviewer.md', 'taskCommits', 'git show', 'read-only');
  await has('tester.md', 'effectiveTasks', 'How to try it', 'status: failed', '`repo`', 'never edit code');
  await has('verifier.md', 'contested', 'verified', 'read-only');
  for (const f of ['planner', 'spec-reviewer', 'plan-reviewer', 'implementer', 'task-reviewer', 'tester', 'verifier', 'spec-writer']) await has(`${f}.md`, 'Do not edit files outside your listed outputs and the code your task owns');
  for (const f of ['spec-reviewer.md', 'plan-reviewer.md', 'task-reviewer.md']) await has(f, '"disposition": "open"');
  for (const f of ['spec-writer.md', 'planner.md', 'implementer.md']) await has(f, 'copy id, severity and text from `reviewFindings` on your card', 'list only findings from `reviewFindings`', 'A blocker may be `open` only when `final` is true');
  for (const f of ['spec-writer.md', 'planner.md']) await has(f, '`reviseOutputs`');
  await has('tester.md', '`severity` (`blocker`, `major` or `minor`)');
  await has('verifier.md', '`target`', '`taskCommits`');
  await has('plan-reviewer.md', '`inputs.spec`', '`inputs.tasks`');
  await has('implementer.md', '{ "cmd": "...", "exit": 0 }', '`cmd` equals the task `verify` string');
  await has('verifier.md', '`evidence` must be a non-empty string');
  const contract = await read('contract.md');
  assert.ok(contract.includes('`done`, `blocked` or `failed`'));
  assert.ok(contract.includes('a plain sha for the primary repo, or `{ "repo": "<id>", "sha": "<sha>" }` for an additional repo'));
  assert.ok(contract.includes('Purposes'));
  for (const p of ['author', 'review', 'fix', 'verify', 'implement', 'task-review', 'test']) assert.ok(contract.includes(`\`${p}\``), `contract: ${p}`);
  assert.ok(contract.includes('review, response, verify and report files are outputs'));
  const purposeLine = (p) => contract.split(/\r?\n/).find((l) => l.startsWith(`- \`${p}\`:`));
  for (const p of ['review', 'test']) assert.ok(purposeLine(p).includes('`severity` (`blocker`, `major` or `minor`)'), `contract ${p} line lists severities`);
  assert.ok(purposeLine('fix').includes('`reviewFindings`'), 'contract fix line names reviewFindings');
});

const REVIEW_FINDINGS = [{ id: 'B1', severity: 'blocker', text: 'no rollback' }, { id: 'M1', severity: 'minor', text: 'nit' }];

test('a fix card lists reviewFindings with the review ids, severities and texts; other cards carry null', async () => {
  const { card } = await m2();
  const c = await card('spec-writer', 'spec-review', { purpose: 'fix', round: 1, reviewFindings: REVIEW_FINDINGS.map((f) => ({ ...f, disposition: 'open' })) });
  assert.deepEqual(c.reviewFindings, REVIEW_FINDINGS);
  const t = await card('implementer', 'implement', { purpose: 'fix', round: 1, task: 'T1', taskDef: TASK_DEF, reviewFindings: REVIEW_FINDINGS });
  assert.deepEqual(t.reviewFindings, REVIEW_FINDINGS);
  const r = await card('spec-reviewer', 'spec-review', { purpose: 'review', round: 1 });
  assert.equal(r.reviewFindings, null);
});

test('the plan-review card carries the spec and tasks.json as inputs; a fix card names the revise set as reviseOutputs', async () => {
  const { job, card } = await m2();
  const paths = artifactPaths(job);
  const review = await card('plan-reviewer', 'plan-review', { purpose: 'review', round: 1 });
  assert.deepEqual(review.inputs, { spec: paths.spec, tasks: paths.tasks });
  assert.equal(review.reviseOutputs, null);
  const planFix = await card('planner', 'plan-review', { purpose: 'fix', round: 1, reviewFindings: REVIEW_FINDINGS });
  assert.deepEqual(planFix.reviseOutputs, { plan: paths.plan, tasks: paths.tasks });
  const specFix = await card('spec-writer', 'spec-review', { purpose: 'fix', round: 1, reviewFindings: REVIEW_FINDINGS });
  assert.deepEqual(specFix.reviseOutputs, { spec: paths.spec });
  const taskFix = await card('implementer', 'implement', { purpose: 'fix', round: 1, task: 'T1', taskDef: TASK_DEF, reviewFindings: REVIEW_FINDINGS });
  assert.equal(taskFix.reviseOutputs, null);
});

test('a phase verify card names the review target; a task verify card lists cumulative taskCommits', async () => {
  const events = [
    { type: 'tasks-loaded', tasks: [TASK_DEF] },
    started('i1', 'implement', 'implement', { task: 'T1' }), ended('i1', { commits: [{ repo: 'primary', sha: 'aaaa111' }] }),
    started('r1', 'implement', 'task-review', { task: 'T1', round: 1 }), ended('r1', { verdict: 'changes', findings: [{ id: 'B1', severity: 'blocker', text: 'bad' }] }),
    started('x1', 'implement', 'fix', { task: 'T1', round: 1 }), ended('x1', { commits: [{ repo: 'primary', sha: 'bbbb222' }] }),
  ];
  const { job, card } = await m2(events);
  const phaseVerify = await card('verifier', 'plan-review', { purpose: 'verify', contested: ['B1'] });
  assert.equal(phaseVerify.target, artifactPaths(job).plan);
  assert.equal(phaseVerify.taskCommits, null);
  const taskVerify = await card('verifier', 'implement', { purpose: 'verify', task: 'T1', taskDef: TASK_DEF, contested: ['B1'] });
  assert.deepEqual(taskVerify.taskCommits, [{ repo: 'primary', sha: 'aaaa111' }, { repo: 'primary', sha: 'bbbb222' }]);
  assert.equal(taskVerify.target, null);
});

test('an extra-round fix has no review at its round, so previousFindings is null', async () => {
  const { card } = await m2([started('r1', 'spec-review', 'review', { round: 1 }), ended('r1', { verdict: 'changes', findings: [] })]);
  const extra = await card('spec-writer', 'spec-review', { purpose: 'fix', round: 4, final: true, reviewFindings: REVIEW_FINDINGS });
  assert.equal(extra.previousFindings, null);
  assert.deepEqual(extra.reviewFindings, REVIEW_FINDINGS);
});

async function brainstormJob(extra = []) {
  const emptyDir = await tempDir('sa-prompts-bs-');
  const job = deriveJob([...provisionedEvents({ jobId: 'j1', slug: 'add-hello-12345678', createdDate: '2026-11-03', idea: IDEA, pipeline: defaultConfig().pipeline }), ...extra]);
  const phaseOf = (id) => job.pipeline.find((p) => p.phase === id);
  const card = async (role, phaseId, attempt) => parseCard((await buildWorkerPrompt({ role, job, phase: phaseOf(phaseId), attempt: { attemptId: 'cur', phase: phaseId, task: null, n: 1, recovery: false, previousAttemptId: null, dir: '/d/cur', ...attempt }, projectDir: emptyDir })).card);
  return { job, card, emptyDir, phaseOf };
}

const QS = [{ id: 'Q1', text: 'Which db?' }, { id: 'Q2', text: 'Which port?' }];
const BRAINSTORM_EVENTS = [
  started('b1', 'brainstorm', 'ask', { role: 'brainstormer' }), ended('b1', { questions: QS }),
  started('s1', 'brainstorm', 'answer', { role: 'stand-in' }), ended('s1', { answers: [{ id: 'Q1', tag: 'from-idea', answer: 'sqlite', reason: 'idea says so' }, { id: 'Q2', tag: 'assumed', answer: '3000', reason: 'default' }] }),
];

test('ask card carries exchanges, maxQuestions and the brief output', async () => {
  const { job, card } = await brainstormJob(BRAINSTORM_EVENTS);
  const c = await card('brainstormer', 'brainstorm', { purpose: 'ask', final: true });
  assert.deepEqual(c.outputs, { brief: artifactPaths(job).brief });
  assert.equal(c.maxQuestions, BRAINSTORM_BATCH);
  assert.equal(c.maxQuestions, 5);
  assert.deepEqual(c.exchanges, brainstormLog(job));
  assert.equal(c.exchanges.length, 2);
  assert.equal(c.final, true);
  assert.equal('userAnswers' in c, false);
  const spec = await card('spec-writer', 'spec', { purpose: 'author' });
  assert.equal('exchanges' in spec, false);
  assert.equal('maxQuestions' in spec, false);
});

test('exchanges holds only entries settled before this attempt', async () => {
  const { job, card } = await brainstormJob(BRAINSTORM_EVENTS);
  const c = await card('brainstormer', 'brainstorm', { purpose: 'ask', attemptId: 's1' });
  assert.deepEqual(c.exchanges, []);
  assert.equal(brainstormLog(job).length, 2);
});

test('answer card carries open questions and resultVia', async () => {
  const { card } = await brainstormJob(BRAINSTORM_EVENTS.slice(0, 2));
  const open = [{ id: 'Q1', text: 'Which db?' }, { id: 'Q2', text: 'Which port?' }];
  const c = await card('stand-in', 'brainstorm', { purpose: 'answer', openQuestions: open });
  assert.deepEqual(c.openQuestions, open);
  assert.equal(c.resultVia, 'final-message');
  assert.deepEqual(c.outputs, {});
  assert.deepEqual(c.exchanges, []);
  assert.equal('maxQuestions' in c, false);
});

test('userAnswers reach every later card in the scope', async () => {
  const specQ = [
    started('w1', 'spec', 'author'), ended('w1', { outcome: 'question', question: 'Q?' }),
    { type: 'needs-you', reason: 'question', detail: { attemptId: 'w1' } },
    { type: 'question-answered', forAttemptId: 'w1', answer: 'A' },
  ];
  const { card } = await brainstormJob(specQ);
  const spec = await card('spec-writer', 'spec', { purpose: 'author' });
  assert.deepEqual(spec.userAnswers, [{ question: 'Q?', answer: 'A' }]);
  const plan = await card('planner', 'plan', { purpose: 'author' });
  assert.equal('userAnswers' in plan, false);

  const verifierQ = [
    started('r3', 'plan-review', 'review', { round: 3 }), ended('r3', { verdict: 'changes', findings: [{ id: 'B1', severity: 'blocker', text: 'x' }] }),
    started('v1', 'plan-review', 'verify'), ended('v1', { outcome: 'question', question: 'V?' }),
    { type: 'needs-you', reason: 'question', detail: { attemptId: 'v1' } },
    { type: 'question-answered', forAttemptId: 'v1', answer: 'VA' },
  ];
  const v = await brainstormJob(verifierQ);
  const want = [{ question: 'V?', answer: 'VA' }];
  assert.deepEqual((await v.card('planner', 'plan-review', { purpose: 'fix', round: 4, final: true, reviewFindings: REVIEW_FINDINGS })).userAnswers, want);
  assert.deepEqual((await v.card('plan-reviewer', 'plan-review', { purpose: 'review', round: 4 })).userAnswers, want);
  assert.deepEqual((await v.card('verifier', 'plan-review', { purpose: 'verify', round: 4, contested: ['B1'] })).userAnswers, want);
});

test('a confirmed blocker answer carries the needs-you question, not the done verify attempt', async () => {
  const text = 'The verifier confirmed blocker B1: x';
  const { card } = await brainstormJob([
    started('r3', 'plan-review', 'review', { round: 3 }), ended('r3', { verdict: 'changes', findings: [{ id: 'B1', severity: 'blocker', text: 'x' }] }),
    started('v1', 'plan-review', 'verify'), ended('v1', { verified: [{ id: 'B1', verified: true, evidence: 'e' }] }),
    { type: 'needs-you', reason: 'question', detail: { kind: 'blocker', text, evidence: 'B1: e', attemptId: 'v1', phase: 'plan-review', task: null } },
    { type: 'question-answered', forAttemptId: 'v1', answer: 'leave it' },
  ]);
  const fix = await card('planner', 'plan-review', { purpose: 'fix', round: 4, final: true, reviewFindings: REVIEW_FINDINGS });
  assert.deepEqual(fix.userAnswers, [{ question: text, answer: 'leave it' }]);
});

test('templates exist and state the rules', async () => {
  const read = (f) => fs.readFile(path.join(templatesDir(), f), 'utf8');
  const has = async (f, ...needles) => { const t = await read(f); for (const n of needles) assert.ok(t.includes(n), `${f}: missing ${n}`); };
  await has('brainstormer.md', 'brief', 'questions', '## Assumptions made for you', '## Your answers', 'question id', 'Do not write a design document');
  await has('stand-in.md', ...ANSWER_TAGS, 'escalated', 'final message', 'When unsure whether');
  await has('spec-writer.md', '## Assumptions made for you', '## Your answers');
  for (const f of ['spec-reviewer', 'plan-reviewer', 'task-reviewer', 'verifier', 'planner', 'implementer', 'tester']) await has(`${f}.md`, '`userAnswers`');
  for (const f of ['brainstormer.md', 'stand-in.md']) assert.ok((await read(f)).split('\n').length < 25);
});

test('the composed stand-in prompt never tells it to write result.json', async () => {
  const { job, phaseOf, emptyDir } = await brainstormJob();
  const { system } = await buildWorkerPrompt({ role: 'stand-in', job, phase: phaseOf('brainstorm'), attempt: { attemptId: 'cur', phase: 'brainstorm', purpose: 'answer', openQuestions: [], dir: '/d/cur' }, projectDir: emptyDir });
  assert.ok(system.includes('resultVia') && system.includes('final message'));
  const publishing = system.split('\n').filter((l) => l.includes('result.json.tmp'));
  assert.equal(publishing.length, 1);
  assert.ok(publishing[0].includes('Unless your card says `resultVia'));
  assert.ok(!/result\.json/.test(await fs.readFile(path.join(templatesDir(), 'stand-in.md'), 'utf8')));
});

test('the contract documents ask and answer', async () => {
  const { job, phaseOf, emptyDir } = await brainstormJob();
  for (const role of ['brainstormer', 'stand-in']) {
    const { system } = await buildWorkerPrompt({ role, job, phase: phaseOf('brainstorm'), attempt: { attemptId: 'cur', phase: 'brainstorm', purpose: role === 'stand-in' ? 'answer' : 'ask', dir: '/d/cur' }, projectDir: emptyDir });
    for (const n of ['`questions`', '`maxQuestions`', 'Q<n>', '`answers`', '"id", "tag", "answer", "reason"', '`escalated`', '`question`', '`questions: []`']) assert.ok(system.includes(n), `${role}: missing ${n}`);
    const blocked = system.split('\n').find((l) => l.includes('A `blocked` result needs none'));
    assert.ok(blocked.includes('`answer`') && blocked.includes('`ask`'));
  }
});

test('later workers treat the spec sections as the user decisions and reviewable defaults', async () => {
  const { job, phaseOf, emptyDir } = await brainstormJob();
  const { system, card } = await buildWorkerPrompt({ role: 'planner', job, phase: phaseOf('plan'), attempt: { attemptId: 'cur', phase: 'plan', purpose: 'author', dir: '/d/cur' }, projectDir: emptyDir });
  assert.equal(parseCard(card).userAnswers, undefined);
  assert.ok(system.includes('`## Your answers` are the user\'s decisions and `## Assumptions made for you` are reviewable defaults'));
});

test('contract carves out ask and answer from the blocked-question rule, and templates pin the final-turn and reason rules', async () => {
  const read = (f) => fs.readFile(path.join(templatesDir(), f), 'utf8');
  const contract = await read('contract.md');
  const never = contract.slice(contract.indexOf('## Never ask the user'), contract.indexOf('## Scope'));
  assert.ok(never.includes('the brainstormer asks only through `questions`'));
  assert.ok(never.includes('the stand-in escalates only as described under `answer`'));
  const blocked = contract.split('\n').find((l) => l.startsWith('A `blocked` result needs none'));
  assert.ok(blocked.includes('Exception: a blocked `answer` still needs `escalated` and `answers`. `ask` never blocks.'));
  const brainstormer = await read('brainstormer.md');
  assert.ok(brainstormer.includes('`unasked:`') && brainstormer.includes('instead of a question id'));
  assert.ok((await read('stand-in.md')).includes('why the assumption is safe'));
  assert.ok((await read('spec-writer.md')).includes('`userAnswers`'));
});

test('userAnswers stay on the answered task: T1 cards carry them, T2 cards do not', async () => {
  const events = [
    { type: 'tasks-loaded', tasks: [TASK_DEF, { ...TASK_DEF, id: 'T2' }] },
    started('i1', 'implement', 'implement', { task: 'T1' }), ended('i1', { outcome: 'question', question: 'T1Q?' }),
    { type: 'needs-you', reason: 'question', detail: { attemptId: 'i1' } },
    { type: 'question-answered', forAttemptId: 'i1', answer: 'T1A' },
  ];
  const { card } = await m2(events);
  const t1 = await card('implementer', 'implement', { purpose: 'implement', task: 'T1', taskDef: TASK_DEF });
  assert.deepEqual(t1.userAnswers, [{ question: 'T1Q?', answer: 'T1A' }]);
  const t2 = await card('implementer', 'implement', { purpose: 'implement', task: 'T2', taskDef: { ...TASK_DEF, id: 'T2' } });
  assert.equal('userAnswers' in t2, false);
});
