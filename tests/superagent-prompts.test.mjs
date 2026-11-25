import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, provisionedEvents } from './superagent-helpers.mjs';
import { deriveJob } from '../src/superagent/store.js';
import { artifactPaths, ledgerArtifactRoot, reviewPaths, requiredOutputs } from '../src/superagent/results.js';
import { roundDir, roundOutputPaths, roundTestReportPaths, roundTriagePath } from '../src/superagent/feedback.js';
import { MILESTONE_2_PIPELINE, defaultConfig } from '../src/superagent/config.js';
import { brainstormLog } from '../src/superagent/sequencer.js';
import { ANSWER_TAGS, BRAINSTORM_BATCH } from '../src/superagent/results.js';
import { READ_ONLY_ROLES, READ_ONLY_TOOLS, RECOVERY_NOTE, UNATTENDED_DENY_MESSAGE, templatesDir, hasTemplate, buildWorkerPrompt, denyMessageFor, nudgeText } from '../src/superagent/prompts.js';

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
  assert.deepEqual(Object.keys(c).sort(), ['artifactsCommitted', 'attemptDir', 'commitTests', 'testPaths', 'attemptId', 'idea', 'inputs', 'jobId', 'mode', 'outputs', 'handoff', 'phaseId', 'previousAttemptDir', 'previousFindings', 'recoveryNote', 'repos', 'round', 'taskId', 'title'].sort());
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
  assert.equal('previousFailure' in rc, false, 'an unfinished previous attempt has no failure to report');
});

test('a recovery card carries the previous attempt\'s failure reason and readable detail', async () => {
  const { phase } = await fixture();
  const detail = 'tasks[0].id must be 1-12 letters, digits or hyphens, starting with a letter or digit: "fix-carry-init"';
  const startedA1 = { type: 'attempt-started', attemptId: 'a1', phase: phase.phase, task: null, role: phase.role, model: 'm', n: 1, dir: '/d/a1' };
  const endedA1 = { type: 'attempt-ended', attemptId: 'a1', outcome: 'failed', reason: 'invalid-result', signature: 'invalid-result|x', detail };
  const retry = await fixture({ recovery: true, previousAttemptId: 'a1' }, [startedA1, endedA1]);
  const rc = parseCard((await buildWorkerPrompt({ role: 'spec-writer', job: retry.job, phase: retry.phase, attempt: retry.attempt, projectDir: retry.emptyDir })).card);
  assert.deepEqual(rc.previousFailure, { reason: 'invalid-result', detail });
});

test('the invalid-result nudge carries the validator\'s error; the turn-cap nudge lets a nearly finished worker finish', async () => {
  const { attempt: a } = await fixture();
  const n = nudgeText('invalid-result', { dir: a.dir, ledger: true, error: 'tasks[0].id must be 1-12 letters' });
  assert.ok(n.includes(a.dir) && n.includes('was rejected: tasks[0].id must be 1-12 letters') && n.includes('result.json.tmp'));
  assert.match(nudgeText('invalid-result', { dir: a.dir, readOnly: true, error: 'bad status' }), /^Your result was rejected: bad status\n.*final message/);
  assert.match(nudgeText('turn-cap', a), /If only writing your outputs remains.*status: done/);
  assert.ok(n.includes('write any output you change'));
  assert.ok(!/commit/.test(n));
  const legacy = nudgeText('invalid-result', { dir: a.dir, error: 'tasks[0].id must be 1-12 letters' });
  assert.ok(legacy.includes('commit any output you change') && !legacy.includes('write any output'));
});

test('a commit-path rejection tells the worker to rewrite the commit; a test-path one points at testPaths', () => {
  const rewrite = ['`git commit --amend`', '`git reset --soft`', 'by explicit path', 'does not take', 'If you did not make that commit', 'publish `blocked`'];
  const test = nudgeText('invalid-result', { dir: '/d', ledger: true, error: 'commit includes test files: Tests/FooTests.cs (commit abc1234 in primary, already on the branch)' });
  for (const s of [...rewrite, '`testPaths`', 'rather than renaming']) assert.ok(test.includes(s), s);
  const superagent = nudgeText('invalid-result', { dir: '/d', ledger: true, error: 'commit includes superagent files: .superpowers/x.md' });
  for (const s of rewrite) assert.ok(superagent.includes(s), s);
  assert.ok(!superagent.includes('testPaths'));
  const other = nudgeText('invalid-result', { dir: '/d', ledger: true, error: 'summary must be a non-empty string' });
  assert.ok(!other.includes('--amend') && !other.includes('testPaths'));
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
  assert.deepEqual([...READ_ONLY_ROLES], ['stand-in', 'triage']);
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
    inputs: {}, outputs: { spec: artifactPaths(job).spec }, artifactsCommitted: true, commitTests: true, testPaths: [], attemptDir: attempt.dir, round: null, previousFindings: null, recoveryNote: null, previousAttemptDir: null, handoff: null,
  });
});

test('the card carries handoff', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const withHandoff = { ...attempt, handoff: '/w/a1/handoff.md' };
  assert.equal(parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt: withHandoff, projectDir: emptyDir })).card).handoff, '/w/a1/handoff.md');
  assert.equal(parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir })).card).handoff, null);
});

test('the card carries the retry note only when the user gave one, and the contract explains it', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const withNote = { ...attempt, retryNote: 'Write the diagnosis from code only.' };
  assert.equal(parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt: withNote, projectDir: emptyDir })).card).retryNote, 'Write the diagnosis from code only.');
  for (const none of [attempt, { ...attempt, retryNote: null }]) {
    assert.equal('retryNote' in parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt: none, projectDir: emptyDir })).card), false);
  }
  const contract = await fs.readFile(path.join(templatesDir(), 'contract.md'), 'utf8');
  assert.match(contract, /`retryNote`/);
});

test('contract.md mentions handoff', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const { system } = await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir });
  assert.ok(system.includes('`handoff`'));
  assert.ok(system.includes('read that file first'));
});

test('contract.md keeps the list-every-commit rule for legacy jobs only', async () => {
  const contract = await fs.readFile(path.join(templatesDir(), 'contract.md'), 'utf8');
  const legacy = contract.slice(contract.indexOf('If your card has `artifactsCommitted: true`'));
  assert.ok(legacy.includes('Every output must appear in at least one commit you list'));
  assert.ok(legacy.includes('an earlier attempt of this phase'));
  assert.ok(legacy.includes('review, response, verify and report files are outputs'));
  const planner = await fs.readFile(path.join(templatesDir(), 'planner.md'), 'utf8');
  assert.ok(!planner.includes('list every commit that touched them'));
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
  for (const f of ['spec-reviewer.md', 'plan-reviewer.md']) await has(f, 'read-only', '`approve` only if there is no open blocker', 'blocker', 'major', 'minor', 'Write the review file listed in `outputs`');
  await has('implementer.md', 'evidence.checks', 'exit code', 'check `git status` and `git log` before repeating work');
  await has('task-reviewer.md', 'taskCommits', 'git show', 'read-only');
  await has('tester.md', 'effectiveTasks', 'How to try it', 'status: failed', '`repo`', 'never edit code');
  for (const f of ['tester.md', 'verifier-tester.md']) await has(f, '"How to try it" section for a person (see the contract)');
  await has('verifier-tester.md', 'unit tests do not replace it', 'full test suite only when a task or the idea asks for it', 'publish `blocked` only after trying');
  await has('contract.md', 'Never start a second copy of a command that may still be running', 'stop everything you started that still runs', '`Repro Steps`', '`Agent repro`', 'paths under `.superpowers/`');
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
  for (const n of ['Unless your card has `artifactsCommitted: true`, outputs are never committed', 'never stage anything under `.superpowers/`', 'If your card has `artifactsCommitted: true`', 'unless your card says `commitTests: true`']) assert.ok(contract.includes(n), `contract: ${n}`);
  for (const f of ['fixer.md', 'implementer.md']) await has(f, "`tasks/<task>-tests/<repoId>/<repo-relative path>` under your card's `artifactRoot` (`<repoId>` is that repo's `id` on the card", 'step 5 commits only the fix', 'under `## Tests that need updating` (its path and why)');
  await has('implementer.md', 'record the `verify` run in the task report');
  assert.ok(!(await read('implementer.md')).includes('record both runs'), 'implementer has no red run to record');
  await has('fixer.md', 'record both runs in the task report');
  await has('task-reviewer.md', 'red-then-green only where the report records a failing run first');
  for (const f of ['task-reviewer.md', 'fix-reviewer.md']) await has(f, 'An updated test listed under `## Tests that need updating` in the task report, saved and not committed, is not a blocker.');
  for (const f of ['tester.md', 'verifier-tester.md']) await has(f, 'copy every entry under `## Tests that need updating` in the task reports', 'into the test report under the same heading');
  for (const f of ['task-reviewer.md', 'fix-reviewer.md', 'tester.md', 'verifier-tester.md']) {
    await has(f, 'from `tasks/<task>-tests/<repoId>/` into that repo');
    const closing = (await read(f)).split(/\r?\n/).find((l) => l.startsWith('Do not edit files outside your listed outputs'));
    assert.ok(closing.includes('except putting the saved tests back and removing them again'), `${f}: closing line carries the put-back exception`);
  }
  assert.ok(!(await read('fix-reviewer.md')).includes('says.)'), 'fix-reviewer: no stray ".)"');
  for (const f of ['task-reviewer.md', 'fix-reviewer.md', 'tester.md', 'verifier-tester.md']) await has(f, 'put the saved tests back first', 'The one exception: putting the saved tests back and removing them again.');
  await has('fix-reviewer.md', 'as it is, plus the saved tests');
  await has('contract.md', "first copies the saved tests from `tasks/<task>-tests/<repoId>/` under your card's `artifactRoot`", 'back to the same repo-relative paths in that repo');
  for (const f of ['fix-reviewer.md', 'task-reviewer.md']) await has(f, 'a fix commit that adds or changes a test is a blocker');
  const purposeLine = (p) => contract.split(/\r?\n/).find((l) => l.startsWith(`- \`${p}\`:`));
  for (const p of ['review', 'test']) assert.ok(purposeLine(p).includes('`severity` (`blocker`, `major` or `minor`)'), `contract ${p} line lists severities`);
  assert.ok(purposeLine('fix').includes('`reviewFindings`'), 'contract fix line names reviewFindings');
});

test('no prompt other than the contract legacy paragraph tells a worker to commit artifacts or names repo job paths', async () => {
  const dir = templatesDir();
  for (const f of (await fs.readdir(dir)).filter((n) => n.endsWith('.md'))) {
    const t = await fs.readFile(path.join(dir, f), 'utf8');
    const text = f === 'contract.md' ? t.slice(0, t.indexOf('If your card has `artifactsCommitted: true`')) : t;
    assert.ok(!text.includes('commit your review file'), `${f}: commit your review file`);
    assert.ok(!text.includes('list its commit'), `${f}: list its commit`);
    assert.ok(!text.includes('docs/superpowers/jobs'), `${f}: docs/superpowers/jobs`);
  }
  assert.ok(!(await fs.readFile(new URL('../src/superagent/prompts.js', import.meta.url), 'utf8')).includes('docs/superpowers/jobs'));
});

test('a ledger job card carries commitTests and testPaths, not artifactsCommitted; a legacy job card carries artifactsCommitted: true', async () => {
  const build = async (over) => {
    const emptyDir = await tempDir('sa-prompts-');
    const job = deriveJob(provisionedEvents({ jobId: 'j1', slug: 'add-hello-12345678', createdDate: '2026-11-03', idea: IDEA, ...over }));
    const phase = job.pipeline[0];
    const attempt = { attemptId: 'a1', phase: phase.phase, task: null, n: 1, recovery: false, previousAttemptId: null, dir: path.join(emptyDir, 'a1') };
    return parseCard((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir: emptyDir })).card);
  };
  const ledger = await build({ artifactRoot: 'ledger', commitTests: false, testPaths: ['**/tests/**'] });
  assert.equal(ledger.commitTests, false);
  assert.deepEqual(ledger.testPaths, ['**/tests/**']);
  assert.ok(!('artifactsCommitted' in ledger));
  assert.equal(ledger.artifactRoot, '.superpowers/superagent/j1/artifacts');
  const legacy = await build({});
  assert.equal(legacy.artifactsCommitted, true);
  assert.ok(!('artifactRoot' in legacy));
  assert.equal(legacy.commitTests, true);
  assert.deepEqual(legacy.testPaths, []);
});

test('the turn-cap nudge says writing your outputs', () => {
  assert.ok(nudgeText('turn-cap', { dir: '/d' }).includes('writing your outputs'));
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

test('a review card names the response of the fix that ran just before it as previousResponse', async () => {
  const { job, card } = await m2();
  const paths = (phase, round) => reviewPaths(job, { phase, round });
  assert.equal((await card('spec-reviewer', 'spec-review', { purpose: 'review', round: 1 })).previousResponse, null);
  assert.equal((await card('spec-reviewer', 'spec-review', { purpose: 'review', round: 2 })).previousResponse, paths('spec-review', 1).response);
  const extra = await card('spec-reviewer', 'spec-review', { purpose: 'review', round: 4 });
  assert.equal(extra.previousResponse, paths('spec-review', 4).response);
  assert.equal(extra.previousFindings, paths('spec-review', 3).review);
  assert.equal((await card('plan-reviewer', 'plan-review', { purpose: 'review', round: 4 })).previousResponse, paths('plan-review', 4).response);
  const taskReview = await card('task-reviewer', 'implement', { purpose: 'task-review', round: 2, task: 'T1', taskDef: TASK_DEF });
  assert.ok(!('previousResponse' in taskReview));
  assert.ok(!('previousResponse' in (await card('spec-writer', 'spec-review', { purpose: 'fix', round: 1 }))));
  const read = (f) => fs.readFile(path.join(templatesDir(), f), 'utf8');
  for (const f of ['spec-reviewer.md', 'plan-reviewer.md']) {
    const t = await read(f);
    assert.ok(t.includes('`previousResponse`'), `${f}: names previousResponse`);
    assert.ok(!t.includes('sits beside it'), `${f}: no sibling-file rule`);
  }
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
  await has('stand-in.md', ...ANSWER_TAGS, 'escalated', 'final message', 'When unsure whether', 'put why you escalated in `summary`');
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

test('the deny message follows the phase kind', () => {
  assert.match(denyMessageFor('brainstorm'), /questions/);
  assert.notEqual(denyMessageFor('brainstorm'), UNATTENDED_DENY_MESSAGE);
  for (const kind of ['author', 'review', 'per-task', 'brainstormer', null, undefined]) assert.equal(denyMessageFor(kind), UNATTENDED_DENY_MESSAGE, String(kind));
});

test('prompt lookup order: project override, then the recorded workflow prompt, then the built-in', async () => {
  const projectDir = await tempDir('sa-prompts-order-');
  const workflowDir = await tempDir('sa-prompts-wf-');
  const recorded = path.join(workflowDir, 'spec-writer.md');
  await fs.writeFile(recorded, 'WORKFLOW-MARKER\n');
  const jobWith = (prompts) => deriveJob(provisionedEvents({
    jobId: 'j1', slug: 'add-hello-12345678', createdDate: '2026-11-03', idea: IDEA,
    workflow: { id: 'quick', name: 'Quick', source: 'global', file: path.join(workflowDir, 'quick.json') },
    artifacts: { spec: 'docs/specs/add-hello.md' },
    prompts,
  }));
  const { phase, attempt } = await fixture();
  const systemFor = async (job) => (await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir })).system;

  const builtin = await fs.readFile(path.join(templatesDir(), 'spec-writer.md'), 'utf8');
  assert.ok((await systemFor(jobWith({ 'spec-writer': null }))).startsWith(builtin.trimEnd()));
  assert.ok((await systemFor(jobWith({}))).startsWith(builtin.trimEnd()));
  assert.ok((await systemFor(jobWith({ 'spec-writer': recorded }))).startsWith('WORKFLOW-MARKER'));
  assert.equal(await hasTemplate('spec-writer', { projectDir, recordedPrompt: recorded }), true);

  const overrides = path.join(projectDir, '.superpowers', 'superagent', 'prompts');
  await fs.mkdir(overrides, { recursive: true });
  await fs.writeFile(path.join(overrides, 'spec-writer.md'), 'OVERRIDE-MARKER\n');
  assert.ok((await systemFor(jobWith({ 'spec-writer': recorded }))).startsWith('OVERRIDE-MARKER'));
});

test('a recorded workflow prompt that disappeared is ERR_PROMPT_MISSING unless a project override exists', async () => {
  const projectDir = await tempDir('sa-prompts-missing-');
  const recorded = path.join(await tempDir('sa-prompts-wf-'), 'gone.md');
  const job = deriveJob(provisionedEvents({
    jobId: 'j1', slug: 'add-hello-12345678', createdDate: '2026-11-03', idea: IDEA,
    workflow: { id: 'quick', name: 'Quick', source: 'global', file: path.join(path.dirname(recorded), 'quick.json') },
    artifacts: { spec: 'docs/specs/add-hello.md' },
    prompts: { 'spec-writer': recorded },
  }));
  const { phase, attempt } = await fixture();
  await assert.rejects(buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir }), (err) => {
    assert.equal(err.code, 'ERR_PROMPT_MISSING');
    assert.equal(err.path, recorded);
    return true;
  });
  assert.equal(await hasTemplate('spec-writer', { projectDir, recordedPrompt: recorded }), false);

  const overrides = path.join(projectDir, '.superpowers', 'superagent', 'prompts');
  await fs.mkdir(overrides, { recursive: true });
  await fs.writeFile(path.join(overrides, 'spec-writer.md'), 'OVERRIDE-MARKER\n');
  assert.ok((await buildWorkerPrompt({ role: 'spec-writer', job, phase, attempt, projectDir })).system.startsWith('OVERRIDE-MARKER'));
});

test('an in-place repo is marked inPlace on the card and the contract forbids tree-wide git commands there', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const inPlaceJob = { ...job, repos: job.repos.map((r) => ({ ...r, inPlace: true })) };
  const { system, card } = await buildWorkerPrompt({ role: 'implementer', job: inPlaceJob, phase, attempt, projectDir: emptyDir });
  assert.deepEqual(parseCard(card).repos, [{ id: 'primary', worktree: job.repos[0].worktree, branch: job.branch, inPlace: true }]);
  for (const needle of ['`inPlace`', "the user's own checkout", '`git clean`', '`reset --hard`', '`stash`', 'never switch branches', 'never create worktrees', 'file by file']) {
    assert.ok(system.includes(needle), `contract: missing ${needle}`);
  }
});

test('an in-place repo with pending changes carries them on the card and the contract protects them', async () => {
  const { job, phase, attempt, emptyDir } = await fixture();
  const pendingChanges = { paths: ['README.md', 'notes.txt'], total: 2 };
  const repos = job.repos.map((r) => ({ ...r, inPlace: true, pendingChanges }));
  const { system, card } = await buildWorkerPrompt({ role: 'implementer', job: { ...job, repos }, phase, attempt, projectDir: emptyDir });
  assert.deepEqual(parseCard(card).repos, [{ id: 'primary', worktree: job.repos[0].worktree, branch: job.branch, inPlace: true, pendingChanges }]);
  const worktreeJob = { ...job, repos: job.repos.map((r) => ({ ...r, pendingChanges })) };
  assert.equal('pendingChanges' in parseCard((await buildWorkerPrompt({ role: 'implementer', job: worktreeJob, phase, attempt, projectDir: emptyDir })).card).repos[0], false);
  for (const needle of ['`pendingChanges`', 'by explicit path', '`git add -A`', '`git commit -a`', 'never stage, commit, edit, revert or delete them']) {
    assert.ok(system.includes(needle), `contract: missing ${needle}`);
  }
});

test('no role prompt implies a tree-wide cleanup of the worktree', async () => {
  const files = (await fs.readdir(templatesDir())).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const text = await fs.readFile(path.join(templatesDir(), f), 'utf8');
    assert.ok(!/must hold only your outputs/.test(text), `${f}: implies tree-wide cleanup`);
  }
});

// Give feedback (Task 5): the triage card, round cards and feedback precedence.
const FEATURE = JSON.parse(await fs.readFile(new URL('../workflows/feature.json', import.meta.url), 'utf8'));
const READY = { type: 'needs-you', reason: 'ready-to-try', detail: { phase: 'accept' } };
const given = (round, over = {}) => ({ type: 'feedback-given', round, text: `feedback ${round}`, triageModel: { model: 'claude-sonnet-5-5', effort: null, maxTurns: 20 }, baseline: {}, pendingChanges: {}, ...over });
const decision = (route, over = {}) => ({ route, summary: `route ${route}`, requirementChanges: [`change for ${route}`], ...over });
const triaged = (id, round, route, over = {}) => [
  started(id, 'accept', 'triage', { role: 'triage', feedbackRound: round }),
  ended(id, { triage: decision(route, over) }),
];
const routed = (id, round, route) => ({ type: 'feedback-routed', round, attemptId: id, route });

// A Feature ledger job; a feedback-given with no forNeedsYouSeq answers the
// latest ready-to-try (a needs-you or a separate route).
async function featureRounds(events, over = {}) {
  const emptyDir = await tempDir('sa-prompts-fb-');
  let ready = null;
  const all = [
    ...provisionedEvents({ jobId: 'j1', slug: 'add-hello-12345678', createdDate: '2026-11-03', idea: IDEA, pipeline: FEATURE.phases, workflow: { id: 'feature' }, artifacts: FEATURE.artifacts, artifactRoot: 'ledger', ...over }),
    ...events,
  ].map((e, i) => {
    const out = { seq: i + 1, at: 1, ...e };
    if (e.type === 'needs-you' || (e.type === 'feedback-routed' && e.route === 'separate')) ready = out.seq;
    if (e.type === 'feedback-given' && e.forNeedsYouSeq === undefined) out.forNeedsYouSeq = ready;
    return out;
  });
  const job = deriveJob(all);
  const phaseOf = (id) => job.pipeline.find((p) => p.phase === id);
  const card = async (role, phaseId, attempt) => parseCard((await buildWorkerPrompt({ role, job, phase: phaseOf(phaseId), attempt: { attemptId: 'cur', phase: phaseId, task: null, n: 1, recovery: false, previousAttemptId: null, dir: '/d/cur', ...attempt }, projectDir: emptyDir })).card);
  return { job, card };
}

const SUBPLAN_1 = [READY, given(1), ...triaged('tri1', 1, 'subplan'), routed('tri1', 1, 'subplan')];

test('triage card', async () => {
  const { job, card } = await featureRounds([READY, given(1)]);
  const paths = artifactPaths(job);
  const c = await card('triage', 'accept', { purpose: 'triage', feedbackRound: 1 });
  assert.equal(c.resultVia, 'final-message');
  assert.equal(c.purpose, 'triage');
  assert.equal(c.feedbackText, 'feedback 1');
  assert.deepEqual(c.outputs, { triage: roundTriagePath(job, 1) });
  assert.equal(roundTriagePath(job, 1), `${ledgerArtifactRoot('j1')}/feedback/round-1/triage.md`);
  assert.deepEqual(c.inputs, { spec: paths.spec, plan: paths.plan, tasks: paths.tasks, testReport: paths.testReport });
  assert.deepEqual(c.latestTestReport, { testReport: paths.testReport });
  assert.deepEqual(c.earlierRounds, []);
  assert.deepEqual(c.feedback, [{ round: 1, text: 'feedback 1', route: null, triage: null, requirementChanges: null, pendingChanges: {} }]);

  // Round 2, after a subplan round whose second tester passed.
  const later = await featureRounds([
    ...SUBPLAN_1,
    started('t1a', 'test', 'test', { feedbackRound: 1, reportOrdinal: 1 }), ended('t1a', { outcome: 'failed', reason: 'failed' }),
    started('t1b', 'test', 'test', { feedbackRound: 1, reportOrdinal: 2 }), ended('t1b'),
    READY, given(2),
  ]);
  const c2 = await later.card('triage', 'accept', { purpose: 'triage', feedbackRound: 2 });
  assert.equal(c2.feedbackText, 'feedback 2');
  assert.deepEqual(c2.outputs, { triage: roundTriagePath(later.job, 2) });
  assert.deepEqual(c2.latestTestReport, roundTestReportPaths(later.job, 1, 2));
  assert.deepEqual(c2.earlierRounds, [{
    round: 1, text: 'feedback 1', route: 'subplan', summary: 'route subplan', requirementChanges: ['change for subplan'],
    triage: roundTriagePath(later.job, 1), folder: roundDir(later.job, 1),
  }]);
  assert.deepEqual(c2.feedback.map((f) => [f.round, f.triage, f.requirementChanges]), [[1, roundTriagePath(later.job, 1), ['change for subplan']], [2, null, null]]);
});

test('round planner card', async () => {
  const { job, card } = await featureRounds(SUBPLAN_1);
  const paths = artifactPaths(job);
  const c = await card('planner', 'plan', { purpose: 'feedback-plan', feedbackRound: 1 });
  assert.equal(c.purpose, 'feedback-plan');
  assert.deepEqual(c.outputs, roundOutputPaths(job, 1, ['plan', 'tasks']));
  assert.equal(c.outputs.plan, `${ledgerArtifactRoot('j1')}/feedback/round-1/outputs/plan.md`);
  assert.deepEqual(c.inputs, { spec: paths.spec, triage: roundTriagePath(job, 1) });
  assert.equal(c.feedback.length, 1);
  assert.equal(c.feedback[0].text, 'feedback 1');
  assert.equal(c.feedback[0].triage, roundTriagePath(job, 1));
  assert.deepEqual(c.feedback[0].requirementChanges, ['change for subplan']);
  assert.ok(!('feedbackText' in c) && !('earlierRounds' in c) && !('latestTestReport' in c), 'triage-only fields');
});

test('round review fix card', async () => {
  const { job, card } = await featureRounds([
    ...SUBPLAN_1,
    started('p1', 'plan', 'feedback-plan', { feedbackRound: 1 }), ended('p1'),
    started('rv1', 'plan-review', 'review', { round: 1, feedbackRound: 1 }), ended('rv1', { verdict: 'changes', findings: [] }),
  ]);
  const round = roundOutputPaths(job, 1, ['plan', 'tasks']);
  const c = await card('planner', 'plan-review', { purpose: 'fix', round: 1, feedbackRound: 1, reviewFindings: REVIEW_FINDINGS });
  assert.equal(c.target, round.plan);
  assert.deepEqual(c.reviseOutputs, round);
  assert.equal(c.previousFindings, reviewPaths(job, { phase: 'plan-review', round: 1, feedbackRound: 1 }).review);
  assert.deepEqual(c.outputs, { response: reviewPaths(job, { phase: 'plan-review', round: 1, feedbackRound: 1 }).response });
});

test('round review card in full', async () => {
  const T1 = { ...TASK_DEF, origin: 'plan' };
  const { job, card } = await featureRounds([
    // The original run's plan review, whose files a round must never name.
    started('rv0', 'plan-review', 'review', { round: 1 }), ended('rv0', { verdict: 'changes', findings: [{ id: 'B1', severity: 'blocker', text: 'old' }] }),
    started('fx0', 'plan-review', 'fix', { round: 1 }), ended('fx0', { findings: [] }),
    started('rv0b', 'plan-review', 'review', { round: 2 }), ended('rv0b', { verdict: 'approve', findings: [] }),
    { type: 'tasks-loaded', tasks: [T1] },
    ...SUBPLAN_1,
    started('p1', 'plan', 'feedback-plan', { feedbackRound: 1 }), ended('p1'),
    started('rv1', 'plan-review', 'review', { round: 1, feedbackRound: 1 }), ended('rv1', { verdict: 'changes', findings: [{ id: 'B1', severity: 'blocker', text: 'no rollback' }] }),
    started('fx1', 'plan-review', 'fix', { round: 1, final: true, feedbackRound: 1 }), ended('fx1', { findings: [{ id: 'B1', severity: 'blocker', text: 'no rollback', disposition: 'declined: fine' }] }),
  ]);
  const paths = artifactPaths(job);
  const rp = (round) => reviewPaths(job, { phase: 'plan-review', round, feedbackRound: 1 });
  const roundPlan = roundOutputPaths(job, 1, ['plan', 'tasks']);
  const c = await card('plan-reviewer', 'plan-review', { purpose: 'review', round: 2, feedbackRound: 1 });
  assert.deepEqual(c, {
    jobId: 'j1', phaseId: 'plan-review', taskId: null, attemptId: 'cur', title: job.title, mode: job.mode, idea: IDEA,
    repos: [{ id: 'primary', worktree: job.repos[0].worktree, branch: job.branch }],
    inputs: { spec: paths.spec, tasks: roundPlan.tasks, triage: roundTriagePath(job, 1) },
    outputs: { review: rp(2).review },
    artifactRoot: ledgerArtifactRoot('j1'), commitTests: true, testPaths: [], attemptDir: '/d/cur',
    round: 2, previousFindings: rp(1).review, recoveryNote: null, previousAttemptDir: null, handoff: null,
    purpose: 'review', final: false, target: roundPlan.plan, reviseOutputs: null, task: null, taskCommits: null,
    previousResponse: rp(1).response, reviewFindings: null, contested: null,
    feedback: [{ round: 1, text: 'feedback 1', route: 'subplan', triage: roundTriagePath(job, 1), requirementChanges: ['change for subplan'], pendingChanges: {}, outputs: roundPlan }],
    effectiveTasks: [{ id: 'T1', title: T1.title, repos: T1.repos, acceptance: T1.acceptance, verify: T1.verify, origin: 'plan' }],
  });
  const original = [paths.tasks, `${ledgerArtifactRoot('j1')}/reviews/plan-review-r1.md`, `${ledgerArtifactRoot('j1')}/reviews/plan-review-r1-response.md`];
  for (const p of original) assert.ok(!JSON.stringify(c).includes(p), `review card names ${p}`);

  const v = await card('verifier', 'plan-review', { purpose: 'verify', feedbackRound: 1, contested: ['B1'] });
  assert.equal(v.target, roundPlan.plan);
  assert.deepEqual(v.inputs, { spec: paths.spec, tasks: roundPlan.tasks, triage: roundTriagePath(job, 1) });
  assert.deepEqual(v.outputs, { verify: rp(null).verify });
  assert.deepEqual(v.contested, [{ id: 'B1', text: 'no rollback', disposition: 'declined: fine' }]);
  for (const p of original) assert.ok(!JSON.stringify(v).includes(p), `verify card names ${p}`);
});

test('round 2 triage recovery card has only round 2 answers', async () => {
  const question = (id, round, q) => [
    started(id, 'accept', 'triage', { role: 'triage', feedbackRound: round }), ended(id, { outcome: 'question', question: q }),
    { type: 'needs-you', reason: 'question', detail: { attemptId: id, question: q, phase: 'accept', task: null } },
    { type: 'question-answered', forAttemptId: id, answer: `${q} answer` },
  ];
  const { card } = await featureRounds([
    READY, given(1), ...question('tri1a', 1, 'Q1?'), ...triaged('tri1b', 1, 'separate', { idea: 'A new job.' }), routed('tri1b', 1, 'separate'),
    given(2), ...question('tri2a', 2, 'Q2?'),
    started('tri2b', 'accept', 'triage', { role: 'triage', feedbackRound: 2 }), ended('tri2b', { outcome: 'failed', reason: 'stalled' }),
  ]);
  const one = await card('triage', 'accept', { purpose: 'triage', feedbackRound: 1 });
  assert.deepEqual(one.userAnswers, [{ question: 'Q1?', answer: 'Q1? answer' }]);
  const two = await card('triage', 'accept', { purpose: 'triage', feedbackRound: 2, recovery: true, previousAttemptId: 'tri2b' });
  assert.deepEqual(two.userAnswers, [{ question: 'Q2?', answer: 'Q2? answer' }]);
  assert.deepEqual(two.earlierRounds.map((r) => [r.round, r.route, r.idea]), [[1, 'separate', 'A new job.']]);
});

test('round cards list the re-recorded pending changes', async () => {
  const pendingChanges = { primary: { paths: ['notes.md', 'draft/x.txt'], total: 2 } };
  for (const repos of [[{ id: 'primary', origin: '/repo', inPlace: true }], [{ id: 'primary', origin: '/repo' }]]) {
    const { card } = await featureRounds([READY, { ...given(1), pendingChanges }, ...triaged('tri1', 1, 'fix', { task: { title: 'x', repos: ['primary'], acceptance: 'y', verify: '' } }), routed('tri1', 1, 'fix')], { repos });
    for (const [role, phase, attempt] of [['implementer', 'implement', { purpose: 'implement', task: 'T9', taskDef: { ...TASK_DEF, id: 'T9' } }], ['tester', 'test', { purpose: 'test', reportOrdinal: 1 }], ['triage', 'accept', { purpose: 'triage' }]]) {
      const c = await card(role, phase, { ...attempt, feedbackRound: 1 });
      assert.deepEqual(c.feedback[0].pendingChanges.primary.paths, ['notes.md', 'draft/x.txt'], `${role}, inPlace ${repos[0].inPlace === true}`);
      assert.equal(c.feedback[0].pendingChanges.primary.total, 2);
    }
  }
  const round0 = await (await featureRounds([])).card('planner', 'plan', { purpose: 'author' });
  assert.ok(!('feedback' in round0), 'a round 0 card carries no feedback');
});

test('round test card names its numbered report and every round\'s triage', async () => {
  const { job, card } = await featureRounds([...SUBPLAN_1]);
  const paths = artifactPaths(job);
  const c = await card('tester', 'test', { purpose: 'test', feedbackRound: 1, reportOrdinal: 3 });
  assert.deepEqual(c.outputs, roundTestReportPaths(job, 1, 3));
  assert.deepEqual(c.inputs, { spec: paths.spec, tasks: paths.tasks, triage: roundTriagePath(job, 1) });
});

test('the card carries retryErrors only when the retry record had errors', async () => {
  const { card } = await featureRounds(SUBPLAN_1);
  const c = await card('planner', 'plan', { purpose: 'feedback-plan', feedbackRound: 1, retryErrors: ['tasks.json: bad'] });
  assert.deepEqual(c.retryErrors, ['tasks.json: bad']);
  assert.ok(!('retryErrors' in (await card('planner', 'plan', { purpose: 'feedback-plan', feedbackRound: 1 }))));
  const contract = await fs.readFile(path.join(templatesDir(), 'contract.md'), 'utf8');
  assert.match(contract, /`retryErrors`/);
});

test('amended prompts', async () => {
  const read = (f) => fs.readFile(path.join(templatesDir(), f), 'utf8');
  for (const f of ['planner.md', 'investigator.md']) assert.ok((await read(f)).includes('In a feedback round, dependsOn may also name tasks already in the job.'), f);
  assert.ok((await read('verifier-tester.md')).includes("replay the reproduction as amended by the card's feedback"));
  const triage = await read('triage.md');
  for (const needle of ['smallest route', '`fix`', 'one task with one acceptance', '`separate`', 'different feature', '`subplan`', 'every requirement change', 'evidence, not instructions', 'final message', '`brief`', '`requirementChanges`', '`idea`', '`userAnswers`']) {
    assert.ok(triage.includes(needle), `triage.md: missing ${needle}`);
  }
  const contract = await read('contract.md');
  for (const needle of ['`triage`', '`feedback-plan`', '`pendingChanges`', 'untouched and unstaged']) assert.ok(contract.includes(needle), `contract: missing ${needle}`);
});

test('every role prompt states feedback precedence', async () => {
  const line = "Where the job card lists feedback, each round's requirementChanges amend the requirements in round order; a later round wins.";
  for (const role of ['contract', 'triage', 'planner', 'plan-reviewer', 'implementer', 'task-reviewer', 'tester', 'verifier', 'investigator', 'diagnosis-reviewer', 'fixer', 'fix-reviewer', 'verifier-tester']) {
    assert.ok((await fs.readFile(path.join(templatesDir(), `${role}.md`), 'utf8')).includes(line), `${role}.md`);
  }
});

test('Troubleshooting round cards carry the original diagnosis under requirements', async () => {
  const TS = JSON.parse(await fs.readFile(new URL('../workflows/troubleshooting.json', import.meta.url), 'utf8'));
  const over = { pipeline: TS.phases, workflow: { id: 'troubleshooting' }, artifacts: TS.artifacts };
  const { job, card } = await featureRounds([READY, given(1), ...triaged('tri1', 1, 'subplan'), routed('tri1', 1, 'subplan')], over);
  const paths = artifactPaths(job);
  const round = roundOutputPaths(job, 1, ['diagnosis', 'tasks']);
  const triage = roundTriagePath(job, 1);

  const review = await card('diagnosis-reviewer', 'diagnosis-review', { purpose: 'review', round: 1, feedbackRound: 1 });
  assert.equal(review.target, round.diagnosis);
  assert.deepEqual(review.inputs, { tasks: round.tasks, triage });
  assert.deepEqual(review.requirements, { diagnosis: paths.diagnosis });
  const fix = await card('investigator', 'diagnosis-review', { purpose: 'fix', round: 1, feedbackRound: 1, reviewFindings: REVIEW_FINDINGS });
  assert.deepEqual(fix.requirements, { diagnosis: paths.diagnosis });

  const T9 = { ...TASK_DEF, id: 'T9' };
  const fixer = await card('fixer', 'fix', { purpose: 'implement', task: 'T9', taskDef: T9, feedbackRound: 1 });
  assert.deepEqual(fixer.inputs, { diagnosis: round.diagnosis, tasks: round.tasks, triage });
  assert.deepEqual(fixer.requirements, { diagnosis: paths.diagnosis });
  const fixReviewer = await card('fix-reviewer', 'fix', { purpose: 'task-review', round: 1, task: 'T9', taskDef: T9, feedbackRound: 1 });
  assert.deepEqual(fixReviewer.requirements, { diagnosis: paths.diagnosis });

  // Cards whose inputs already name the original need no requirements.
  const investigator = await card('investigator', 'investigate', { purpose: 'feedback-plan', feedbackRound: 1 });
  assert.deepEqual(investigator.inputs, { diagnosis: paths.diagnosis, triage });
  assert.ok(!('requirements' in investigator));
  const tester = await card('verifier-tester', 'verify', { purpose: 'test', feedbackRound: 1, reportOrdinal: 1 });
  assert.equal(tester.inputs.diagnosis, paths.diagnosis);
  assert.ok(!('requirements' in tester));
  assert.deepEqual(tester.feedback[0].outputs, round);
  assert.equal(tester.feedback[0].outputs.diagnosis, `${roundDir(job, 1)}/outputs/diagnosis.md`);
  const round0 = await (await featureRounds([], over)).card('diagnosis-reviewer', 'diagnosis-review', { purpose: 'review', round: 1 });
  assert.ok(!('requirements' in round0), 'a round 0 card is unchanged');
  assert.ok((await fs.readFile(path.join(templatesDir(), 'contract.md'), 'utf8')).includes('`requirements` on your card'));
});

test('feedback entries carry their route; only a subplan round names its outputs', async () => {
  const fixTask = { task: { title: 'x', repos: ['primary'], acceptance: 'y', verify: '' } };
  const { job, card } = await featureRounds([
    READY, given(1), ...triaged('tri1', 1, 'separate', { requirementChanges: [], idea: 'A new job.' }), routed('tri1', 1, 'separate'),
    given(2), ...triaged('tri2', 2, 'fix', fixTask), routed('tri2', 2, 'fix'),
    READY, given(3), ...triaged('tri3', 3, 'subplan'), routed('tri3', 3, 'subplan'),
  ]);
  const c = await card('tester', 'test', { purpose: 'test', feedbackRound: 3, reportOrdinal: 1 });
  assert.deepEqual(c.feedback.map((f) => [f.round, f.route, f.outputs ?? null]), [
    [1, 'separate', null],
    [2, 'fix', null],
    [3, 'subplan', roundOutputPaths(job, 3, ['plan', 'tasks'])],
  ]);
  const contract = await fs.readFile(path.join(templatesDir(), 'contract.md'), 'utf8');
  assert.ok(contract.includes('A `separate` round changes nothing in this job'), 'contract: separate rounds');
  assert.ok(contract.includes('`outputs`'), 'contract: feedback outputs');
});
