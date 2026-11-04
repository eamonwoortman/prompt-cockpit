import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MILESTONE_1_PIPELINE,
  defaultConfig,
  validateDefaults,
  validateMilestoneFixture,
  createSuperagentConfig,
} from '../src/superagent/config.js';
import { tempDir } from './superagent-helpers.mjs';

const without = (pipeline, phase) => pipeline.filter((p) => p.phase !== phase);
const hasError = (result, p) => result.errors.some((e) => e.path === p);

test('the default config validates end-to-end with no errors or warnings', () => {
  assert.deepEqual(validateDefaults(defaultConfig()), { errors: [], warnings: [] });
});

test('the default model matrix matches the spec table', () => {
  const rows = [
    [['router'], 'claude-haiku-5-5', 1],
    [['stand-in'], 'claude-opus-5-5', 8],
    [['brainstormer', 'spec-writer', 'planner'], 'claude-opus-5-5', 60],
    [['spec-reviewer', 'plan-reviewer', 'verifier'], 'claude-opus-5-5', 40],
    [['implementer', 'tester', 'task-reviewer'], 'claude-sonnet-5-5', 80],
    [['triage'], 'claude-sonnet-5-5', 20],
  ];
  const { models } = defaultConfig();
  for (const [roles, model, maxTurns] of rows) {
    for (const role of roles) {
      assert.equal(models[role].model, model, role);
      assert.equal(models[role].maxTurns, maxTurns, role);
      assert.equal(models[role].provider, 'claude', role);
    }
  }
  assert.equal(models.implementer.alternate, 'claude-opus-5-5');
});

test('contract validation rejects broken compositions', () => {
  const cases = [
    ['per-task without tasks', (d) => { d.pipeline[5].inputs = []; }, 'pipeline[5].inputs'],
    ['review without target', (d) => { delete d.pipeline[2].target; }, 'pipeline[2].target'],
    ['review targeting a later output', (d) => { d.pipeline[2].target = 'testReport'; }, 'pipeline[2].target'],
    ['review without author', (d) => { delete d.pipeline[2].author; }, 'pipeline[2].author'],
    ['spec input not yet produced', (d) => { d.pipeline[1].inputs = ['plan']; }, 'pipeline[1].inputs'],
    ['role missing from models', (d) => { delete d.models['spec-writer']; }, 'pipeline[1].role'],
    ['second human phase', (d) => { d.pipeline.push({ phase: 'accept2', kind: 'human', inputs: ['testReport'] }); }, 'pipeline'],
    ['accept before test', (d) => { const [accept] = d.pipeline.splice(7, 1); d.pipeline.splice(6, 0, accept); }, 'pipeline'],
    ['non-claude provider', (d) => { d.models.implementer.provider = 'grok'; }, 'models.implementer.provider'],
    ['unknown kind', (d) => { d.pipeline[1].kind = 'deploy'; }, 'pipeline[1].kind'],
    ['extra phase', (d) => { d.pipeline.splice(1, 0, { phase: 'deploy', kind: 'author', role: 'planner', inputs: ['idea'], outputs: [] }); }, 'pipeline'],
    ['spec phase removed', (d) => { d.pipeline = without(d.pipeline, 'spec'); }, 'pipeline'],
    ['milestone-1 pipeline', (d) => { d.pipeline = [...MILESTONE_1_PIPELINE]; }, 'pipeline'],
    ['permission mode default', (d) => { d.workerPermissionMode = 'default'; }, 'workerPermissionMode'],
    ['permission mode plan', (d) => { d.workerPermissionMode = 'plan'; }, 'workerPermissionMode'],
    ['router model off the allowlist', (d) => { d.models.router.model = 'claude-opus-5-5'; }, 'models.router.model'],
  ];
  for (const [name, mutate, expectedPath] of cases) {
    const d = defaultConfig();
    mutate(d);
    assert.ok(hasError(validateDefaults(d), expectedPath), `${name}: expected an error at ${expectedPath}`);
  }
});

test('validated compositions pass', () => {
  const variants = {
    'minus spec-review': (d) => { d.pipeline = without(d.pipeline, 'spec-review'); },
    'plus security-review': (d) => {
      const at = d.pipeline.findIndex((p) => p.phase === 'plan-review') + 1;
      d.pipeline.splice(at, 0, { phase: 'security-review', kind: 'review', role: 'plan-reviewer', author: 'planner', target: 'plan', maxRounds: 2 });
    },
    'without taskReview': (d) => { delete d.pipeline.find((p) => p.phase === 'implement').taskReview; },
    'spec role changed': (d) => { d.pipeline.find((p) => p.phase === 'spec').role = 'planner'; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const d = defaultConfig();
    mutate(d);
    assert.deepEqual(validateDefaults(d).errors, [], name);
  }
});

test('the milestone-1 fixture validates only through its own entry point', () => {
  assert.deepEqual(validateMilestoneFixture(defaultConfig()).errors, []);
  assert.ok(hasError(validateDefaults({ ...defaultConfig(), pipeline: [...MILESTONE_1_PIPELINE] }), 'pipeline'));
  const d = defaultConfig();
  d.models['spec-writer'].provider = 'grok';
  assert.ok(hasError(validateMilestoneFixture(d), "models['spec-writer'].provider"));
  assert.ok(Object.isFrozen(MILESTONE_1_PIPELINE));
});

test('an unpriced model is a warning, not an error', () => {
  const d = defaultConfig();
  d.models.triage.model = 'claude-unknown-9';
  const { errors, warnings } = validateDefaults(d);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].path, 'models.triage.model');
});

test('project overrides merge objects and replace arrays', async () => {
  const dir = await tempDir('sa-config-');
  const repo = path.join(dir, 'repo');
  const filePath = path.join(dir, 'config.json');
  const pipeline = without(defaultConfig().pipeline, 'spec-review');
  await fs.writeFile(filePath, JSON.stringify({
    defaults: { limits: { stallMinutes: 30 } },
    projects: {
      [repo]: { pipeline, models: { 'spec-writer': { maxTurns: 10 } }, limits: { attemptsPerPhase: 2 } },
    },
  }));
  const cfg = createSuperagentConfig({ filePath });
  await cfg.load();
  const resolved = cfg.resolve(repo);
  assert.equal(resolved.pipeline.length, 7);
  assert.deepEqual(resolved.pipeline, pipeline);
  assert.deepEqual(resolved.models['spec-writer'], { provider: 'claude', model: 'claude-opus-5-5', maxTurns: 10 });
  assert.equal(resolved.limits.attemptsPerPhase, 2);
  assert.equal(resolved.limits.stallMinutes, 30);
  assert.equal(resolved.limits.attemptsPerTask, 2);
  assert.deepEqual(cfg.resolve(null).pipeline, defaultConfig().pipeline);
  if (process.platform === 'win32') {
    assert.deepEqual(cfg.resolve(repo.toUpperCase()).pipeline, pipeline);
  }
});

test('load tolerates a missing file and refuses a corrupt one', async () => {
  const dir = await tempDir('sa-config-');
  const missing = createSuperagentConfig({ filePath: path.join(dir, 'nope.json') });
  await missing.load();
  assert.deepEqual(missing.resolve(null), defaultConfig());

  const filePath = path.join(dir, 'config.json');
  await fs.writeFile(filePath, '{not json');
  const cfg = createSuperagentConfig({ filePath });
  await assert.rejects(cfg.load(), (err) => err.code === 'ERR_CONFIG_CORRUPT');
  assert.equal(await fs.readFile(filePath, 'utf-8'), '{not json');
});

test('save refuses an invalid config and leaves the file unchanged', async () => {
  const dir = await tempDir('sa-config-');
  const repo = path.join(dir, 'repo');
  const filePath = path.join(dir, 'config.json');
  await fs.writeFile(filePath, JSON.stringify({ defaults: { limits: { stallMinutes: 30 } } }));
  const before = await fs.readFile(filePath, 'utf-8');
  const cfg = createSuperagentConfig({ filePath });
  await cfg.load();
  await assert.rejects(
    cfg.save({ projects: { [repo]: { pipeline: [] } } }),
    (err) => err.code === 'ERR_INVALID_CONFIG' && err.errors.length > 0,
  );
  assert.equal(await fs.readFile(filePath, 'utf-8'), before);

  await cfg.save({ defaults: { limits: { stallMinutes: 45 } }, projects: { [repo]: { limits: { attemptsPerTask: 4 } } } });
  const fresh = createSuperagentConfig({ filePath });
  await fresh.load();
  assert.equal(fresh.resolve(null).limits.stallMinutes, 45);
  assert.equal(fresh.resolve(repo).limits.attemptsPerTask, 4);
});
