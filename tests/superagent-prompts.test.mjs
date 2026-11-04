import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, provisionedEvents } from './superagent-helpers.mjs';
import { deriveJob } from '../src/superagent/store.js';
import { artifactPaths } from '../src/superagent/results.js';
import { RECOVERY_NOTE, templatesDir, hasTemplate, buildWorkerPrompt, nudgeText } from '../src/superagent/prompts.js';

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
  assert.deepEqual(Object.keys(c).sort(), ['attemptDir', 'attemptId', 'idea', 'inputs', 'jobId', 'mode', 'outputs', 'phaseId', 'previousAttemptDir', 'previousFindings', 'recoveryNote', 'repos', 'round', 'taskId', 'title'].sort());
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
  await assert.rejects(buildWorkerPrompt({ role: 'planner', job, phase, attempt, projectDir: emptyDir }), { code: 'ERR_NO_TEMPLATE' });
  assert.equal(await hasTemplate('planner', { projectDir: emptyDir }), false);
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
