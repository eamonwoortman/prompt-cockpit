import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MILESTONE_1_PIPELINE,
  MILESTONE_2_PIPELINE,
  FIXTURES,
  defaultConfig,
  validateDefaults,
  validateMilestoneFixture,
  createSuperagentConfig,
  templateFor,
  resolveProjectConfig,
  ENGINE_ROLES,
  resolveEngineModel,
  defaultUserFolder,
  resolveUserFolder,
} from '../src/superagent/config.js';
import { tempDir } from './superagent-helpers.mjs';

const without = (pipeline, phase) => pipeline.filter((p) => p.phase !== phase);
const hasError = (result, p) => result.errors.some((e) => e.path === p);

test('the default user folder is ~/.prompt-cockpit, used when userFolder is unset', () => {
  const home = path.join(path.sep, 'home', 'x');
  assert.equal(defaultUserFolder(home), path.join(home, '.prompt-cockpit'));
  assert.equal(resolveUserFolder(undefined, { home }).resolved, path.join(home, '.prompt-cockpit'));
  assert.equal(resolveUserFolder(null, { home }).resolved, path.join(home, '.prompt-cockpit'));
});

test('the default config validates end-to-end with no errors or warnings', () => {
  assert.deepEqual(validateDefaults(defaultConfig()), { errors: [], warnings: [] });
});

test('the default model matrix matches the spec table', () => {
  const rows = [
    [['router'], 'claude-haiku-5-5', 1],
    [['stand-in'], 'claude-sonnet-5-5', 8],
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
  assert.ok(Object.isFrozen(MILESTONE_1_PIPELINE[0]));
  assert.ok(Object.isFrozen(MILESTONE_1_PIPELINE[0].inputs));
  assert.ok(Object.isFrozen(MILESTONE_1_PIPELINE[0].outputs));
});

test('the composition rule reports a changed outputs contract at pipeline[i].outputs', () => {
  const d = defaultConfig();
  d.pipeline[3].outputs = ['plan'];
  const result = validateDefaults(d);
  assert.ok(hasError(result, 'pipeline[3].outputs'));
  assert.ok(!hasError(result, 'pipeline[3].inputs'));
});

test('malformed pipeline entries are reported, not thrown', async () => {
  const malformed = [
    ['null entry', (d) => { d.pipeline = [null]; }, 'pipeline[0]'],
    ['inputs not an array', (d) => { d.pipeline[1].inputs = 5; }, 'pipeline[1].inputs'],
    ['outputs not an array', (d) => { d.pipeline[1].outputs = 5; }, 'pipeline[1].outputs'],
    ['per-task inputs not an array', (d) => { d.pipeline[5].inputs = 5; }, 'pipeline[5].inputs'],
  ];
  const dir = await tempDir('sa-config-');
  const cfg = createSuperagentConfig({ filePath: path.join(dir, 'config.json') });
  await cfg.load();
  for (const [name, mutate, expectedPath] of malformed) {
    const d = defaultConfig();
    mutate(d);
    let result;
    assert.doesNotThrow(() => { result = validateDefaults(d); }, name);
    assert.ok(hasError(result, expectedPath), `${name}: expected an error at ${expectedPath}`);
    assert.doesNotThrow(() => validateMilestoneFixture(d), name);
    await assert.rejects(cfg.save({ defaults: { pipeline: d.pipeline } }), (err) => err.code === 'ERR_INVALID_CONFIG', name);
  }
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

test('milestone-2 fixture validates against defaults', () => {
  assert.deepEqual(validateMilestoneFixture(defaultConfig(), 'milestone-2').errors, []);
  assert.equal(FIXTURES['milestone-2'], MILESTONE_2_PIPELINE);
  assert.equal(FIXTURES['milestone-1'], MILESTONE_1_PIPELINE);
});

test('milestone-2 fixture is deep-frozen and has no brainstorm phase', () => {
  assert.ok(Object.isFrozen(MILESTONE_2_PIPELINE));
  for (const p of MILESTONE_2_PIPELINE) {
    assert.ok(Object.isFrozen(p), p.phase);
    assert.ok(Object.isFrozen(p.inputs), p.phase);
    if (p.outputs) assert.ok(Object.isFrozen(p.outputs), p.phase);
  }
  assert.ok(!MILESTONE_2_PIPELINE.some((p) => p.phase === 'brainstorm'));
});

test('milestone-2 phase order and contracts', () => {
  assert.deepEqual(MILESTONE_2_PIPELINE.map((p) => p.phase), ['spec', 'spec-review', 'plan', 'plan-review', 'implement', 'test', 'accept']);
  assert.deepEqual(MILESTONE_2_PIPELINE[2].outputs, ['plan', 'tasks']);
  assert.equal(MILESTONE_2_PIPELINE[4].taskReview, 'task-reviewer');
  assert.deepEqual(MILESTONE_2_PIPELINE[3].inputs, ['spec', 'tasks']);
  assert.deepEqual(defaultConfig().pipeline.find((p) => p.phase === 'plan-review').inputs, ['spec', 'tasks']);
  assert.deepEqual(validateDefaults(defaultConfig()).errors, []);
});

test('an unknown fixture name throws', () => {
  assert.throws(() => validateMilestoneFixture(defaultConfig(), 'nope'), Error);
  assert.throws(() => validateMilestoneFixture(defaultConfig(), 'toString'), Error);
});

test('a models map missing task-reviewer fails milestone-2 validation', () => {
  const d = defaultConfig();
  delete d.models['task-reviewer'];
  assert.ok(hasError(validateMilestoneFixture(d, 'milestone-2'), 'pipeline[4].taskReview'));
});

test('a phase id with a slash, a space or 25+ characters is rejected', () => {
  for (const id of ['a/b', 'a b', 'x'.repeat(25)]) {
    const d = defaultConfig();
    d.pipeline[1].phase = id;
    assert.ok(hasError(validateDefaults(d), 'pipeline[1].phase'), id);
  }
  const ok = defaultConfig();
  ok.pipeline[1].phase = 'x'.repeat(24);
  assert.ok(!hasError(validateDefaults(ok), 'pipeline[1].phase'));
});

test('deleting models.verifier fails validation for any pipeline with a review or per-task phase, and not for MILESTONE_1', () => {
  const d = defaultConfig();
  delete d.models.verifier;
  assert.ok(hasError(validateDefaults(d), 'models.verifier'));
  assert.ok(hasError(validateMilestoneFixture(d, 'milestone-2'), 'models.verifier'));
  assert.ok(!hasError(validateMilestoneFixture(d), 'models.verifier'));
});

test('taskReviewRounds defaults to 2 and rejects 0', () => {
  assert.equal(defaultConfig().limits.taskReviewRounds, 2);
  const d = defaultConfig();
  d.limits.taskReviewRounds = 0;
  assert.ok(hasError(validateDefaults(d), 'limits.taskReviewRounds'));
});

test('router maxTurns must be 1', () => {
  const d = defaultConfig();
  d.models.router.maxTurns = 2;
  assert.ok(hasError(validateDefaults(d), 'models.router.maxTurns'));
});

test('routerMaxInputTokens and routerMaxOutputTokens must be positive integers', () => {
  for (const field of ['routerMaxInputTokens', 'routerMaxOutputTokens']) {
    for (const bad of [0, -1, 1.5, '6000']) {
      const d = defaultConfig();
      d[field] = bad;
      assert.ok(hasError(validateDefaults(d), field), `${field}=${JSON.stringify(bad)}`);
    }
  }
});

test('routerMaxOutputTokens is at most 4000', () => {
  const d = defaultConfig();
  d.routerMaxOutputTokens = 4000;
  assert.equal(hasError(validateDefaults(d), 'routerMaxOutputTokens'), false);
  d.routerMaxOutputTokens = 4001;
  assert.ok(hasError(validateDefaults(d), 'routerMaxOutputTokens'));
});

test('routerModelAllowlist must be a non-empty array of strings', () => {
  for (const bad of [[], [1]]) {
    const d = defaultConfig();
    d.routerModelAllowlist = bad;
    assert.ok(hasError(validateDefaults(d), 'routerModelAllowlist'), JSON.stringify(bad));
  }
});

test('alternate must be a non-empty string different from model', () => {
  for (const bad of ['', 'claude-sonnet-5-5']) {
    const d = defaultConfig();
    d.models.implementer.alternate = bad;
    assert.ok(hasError(validateDefaults(d), 'models.implementer.alternate'), JSON.stringify(bad));
  }
  assert.deepEqual(validateDefaults(defaultConfig()).errors, []);
});

test('default brainstorm phase has kind brainstorm', () => {
  assert.deepEqual(defaultConfig().pipeline[0], { phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] });
  assert.deepEqual(validateDefaults(defaultConfig()).errors, []);
});

test('questionsPerScope defaults to 3 and must be a positive integer', () => {
  assert.equal(defaultConfig().limits.questionsPerScope, 3);
  const d = defaultConfig();
  d.limits.questionsPerScope = 0;
  assert.ok(hasError(validateDefaults(d), 'limits.questionsPerScope'));
});

test('a brainstorm phase needs a stand-in model', () => {
  const d = defaultConfig();
  delete d.models['stand-in'];
  assert.ok(validateDefaults(d).errors.some((e) => e.path === "models['stand-in']" && e.message === 'a stand-in model is required when the pipeline has a brainstorm phase'));
});

test('a brainstorm phase must be first and unique', () => {
  const message = 'a brainstorm phase must be the first phase, and there can be only one';
  const moved = defaultConfig();
  const [brainstorm] = moved.pipeline.splice(0, 1);
  moved.pipeline.splice(1, 0, brainstorm);
  const doubled = defaultConfig();
  doubled.pipeline.splice(1, 0, { ...doubled.pipeline[0], phase: 'brainstorm2', outputs: [] });
  for (const d of [moved, doubled]) {
    assert.ok(validateDefaults(d).errors.some((e) => e.path === 'pipeline' && e.message === message));
  }
});

test('commitTests and testPaths default, validate and resolve per project', async () => {
  const d = defaultConfig();
  assert.equal(d.commitTests, false);
  assert.ok(Array.isArray(d.testPaths) && d.testPaths.length === 10);
  assert.deepEqual(validateDefaults(d), { errors: [], warnings: [] });
  for (const bad of ['yes', 1, null]) {
    assert.ok(hasError(validateDefaults({ ...defaultConfig(), commitTests: bad }), 'commitTests'), String(bad));
  }
  assert.equal(validateDefaults({ ...defaultConfig(), commitTests: 'x' }).errors.find((e) => e.path === 'commitTests').message, 'commitTests must be a boolean');
  for (const bad of [[], 'a', [''], [1], null]) {
    const r = validateDefaults({ ...defaultConfig(), testPaths: bad });
    assert.equal(r.errors.find((e) => e.path === 'testPaths')?.message, 'testPaths must be a non-empty array of glob strings', JSON.stringify(bad));
  }
  const dir = await tempDir('sa-config-');
  const repo = path.join(dir, 'repo');
  const filePath = path.join(dir, 'config.json');
  await fs.writeFile(filePath, JSON.stringify({
    defaults: { testPaths: ['a/**'] },
    projects: { [repo]: { commitTests: true } },
  }));
  const cfg = createSuperagentConfig({ filePath });
  await cfg.load();
  assert.equal(cfg.resolve(null).commitTests, false);
  assert.equal(cfg.resolve(repo).commitTests, true);
  assert.deepEqual(cfg.resolve(repo).testPaths, ['a/**']);
  await assert.rejects(cfg.save({ defaults: { commitTests: 'yes' } }), (err) => err.code === 'ERR_INVALID_CONFIG');
});

test('branchTemplates default, validate, merge per key and resolve a workflow id case-insensitively', async () => {
  const d = defaultConfig();
  assert.deepEqual(d.branchTemplates, { troubleshooting: 'bugfix/{ticket}-{description}', feature: 'feature/{description}' });
  assert.deepEqual(validateDefaults(d), { errors: [], warnings: [] });
  for (const bad of [{ feature: '' }, { feature: 1 }, { feature: null }]) {
    const r = validateDefaults({ ...defaultConfig(), branchTemplates: bad });
    assert.equal(r.errors.find((e) => e.path === 'branchTemplates.feature')?.message, 'branchTemplates.feature must be a non-empty string', JSON.stringify(bad));
  }
  for (const bad of ['a', [], null, 3]) {
    const r = validateDefaults({ ...defaultConfig(), branchTemplates: bad });
    assert.equal(r.errors.find((e) => e.path === 'branchTemplates')?.message, 'branchTemplates must be an object', JSON.stringify(bad));
  }
  const dir = await tempDir('sa-config-');
  const repo = path.join(dir, 'repo');
  const filePath = path.join(dir, 'config.json');
  await fs.writeFile(filePath, JSON.stringify({
    defaults: { branchTemplates: { custom: 'c/{slug}' } },
    projects: { [repo]: { branchTemplates: { troubleshooting: 'fix/{ticket}' } } },
  }));
  const cfg = createSuperagentConfig({ filePath });
  await cfg.load();
  assert.deepEqual(cfg.resolve(null).branchTemplates, { troubleshooting: 'bugfix/{ticket}-{description}', feature: 'feature/{description}', custom: 'c/{slug}' });
  assert.deepEqual(cfg.resolve(repo).branchTemplates, { troubleshooting: 'fix/{ticket}', feature: 'feature/{description}', custom: 'c/{slug}' });
  await assert.rejects(cfg.save({ defaults: { branchTemplates: { feature: '' } } }), (err) => err.code === 'ERR_INVALID_CONFIG');
  const t = cfg.resolve(repo).branchTemplates;
  assert.equal(templateFor(t, 'Troubleshooting'), 'fix/{ticket}');
  assert.equal(templateFor(t, 'feature'), 'feature/{description}');
  assert.equal(templateFor(t, 'other'), null);
  assert.equal(templateFor(t, null), null);
});

test('a branchTemplates key overrides the layer below whatever its case', () => {
  const repo = path.resolve('some', 'repo');
  const fileConfig = {
    defaults: { branchTemplates: { Troubleshooting: 'fix/{ticket}', FEATURE: 'feat/{description}' } },
    projects: { [repo]: { branchTemplates: { TROUBLESHOOTING: 'hotfix/{ticket}' } } },
  };
  const defaults = resolveProjectConfig(fileConfig, null).branchTemplates;
  assert.deepEqual(defaults, { troubleshooting: 'fix/{ticket}', feature: 'feat/{description}' });
  assert.equal(templateFor(defaults, 'troubleshooting'), 'fix/{ticket}');
  const project = resolveProjectConfig(fileConfig, repo).branchTemplates;
  assert.deepEqual(project, { troubleshooting: 'hotfix/{ticket}', feature: 'feat/{description}' });
  assert.equal(templateFor(project, 'Troubleshooting'), 'hotfix/{ticket}');
});

test('triage is an engine role whose model comes from config only', () => {
  assert.ok(ENGINE_ROLES.includes('triage'));
  const origin = path.resolve('proj-a');
  const other = path.resolve('proj-b');
  assert.deepEqual(resolveEngineModel({}, origin, 'triage'), { provider: 'claude', model: 'claude-sonnet-5-5', maxTurns: 20 });
  const fileConfig = {
    defaults: { models: { triage: { maxTurns: 30 } } },
    projects: { [origin]: { models: { triage: { model: 'claude-opus-5-5' } } } },
  };
  assert.deepEqual(resolveEngineModel(fileConfig, origin, 'triage'), { provider: 'claude', model: 'claude-opus-5-5', maxTurns: 30 });
  assert.deepEqual(resolveEngineModel(fileConfig, other, 'triage'), { provider: 'claude', model: 'claude-sonnet-5-5', maxTurns: 30 });
  assert.deepEqual(resolveEngineModel(fileConfig, null, 'triage'), { provider: 'claude', model: 'claude-sonnet-5-5', maxTurns: 30 });
});
