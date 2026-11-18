import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MILESTONE_2_PIPELINE, defaultConfig } from '../src/superagent/config.js';
import { artifactPaths } from '../src/superagent/results.js';
import {
  CONFIG_PIPELINE_ID,
  LEGACY_ARTIFACTS,
  WORKFLOW_FORMAT,
  loadWorkflows,
  resolvePromptPath,
  resolveWorkflowModels,
  substituteArtifacts,
  validateWorkflow,
  workflowsDir,
} from '../src/superagent/workflows.js';
import { tempDir } from './superagent-helpers.mjs';

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const projectWorkflows = (dir) => path.join(dir, '.superpowers', 'superagent', 'workflows');

// author -> review -> per-task -> test -> human; every role has a built-in template.
function baseDoc() {
  return {
    format: 1,
    id: 'custom',
    name: 'Custom',
    description: 'a test workflow',
    artifacts: {
      spec: 'docs/custom/{date}-{slug}.md',
      tasks: 'docs/custom/{slug}/tasks.json',
      testReport: 'docs/custom/{slug}/report.md',
    },
    phases: [
      { phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['idea'], outputs: ['spec', 'tasks'] },
      { phase: 'spec-review', kind: 'review', role: 'spec-reviewer', author: 'spec-writer', target: 'spec', maxRounds: 2 },
      { phase: 'implement', kind: 'per-task', role: 'implementer', taskReview: 'task-reviewer', inputs: ['tasks'] },
      { phase: 'test', kind: 'author', role: 'tester', inputs: ['spec', 'tasks'], outputs: ['testReport'], test: true },
      { phase: 'accept', kind: 'human', inputs: ['testReport'] },
    ],
  };
}

const ALL_PROMPTS = Object.fromEntries(['brainstormer', 'spec-writer', 'spec-reviewer', 'planner', 'plan-reviewer', 'implementer', 'task-reviewer', 'tester']
  .map((role) => [role, `/prompts/${role}.md`]));

function check(doc, { models = defaultConfig().models, promptFor = ALL_PROMPTS, platform = 'linux' } = {}) {
  return validateWorkflow(doc, { models, promptFor, platform }).errors;
}

test('the shipped feature file produces today\'s default pipeline', async () => {
  const empty = await tempDir('sa-wf-empty-');
  const { workflows, default: def, defaultNote } = await loadWorkflows({ builtinDir: workflowsDir(), globalDir: empty, projectDir: null, fileConfig: {} });
  const feature = workflows.find((w) => w.id === 'feature');
  assert.deepEqual(feature.errors, []);
  assert.equal(feature.valid, true);
  assert.equal(feature.source, 'built-in');
  assert.equal(feature.name, 'Feature');
  assert.equal(feature.file, path.join(workflowsDir(), 'feature.json'));
  assert.equal(feature.doc.format, WORKFLOW_FORMAT);
  assert.deepEqual(feature.doc.phases, defaultConfig().pipeline);
  assert.deepEqual(feature.doc.artifacts, LEGACY_ARTIFACTS);
  assert.equal(def, 'feature');
  assert.equal(defaultNote, null);
  assert.ok(!workflows.some((w) => w.id === CONFIG_PIPELINE_ID));
});

test('the default pipeline and milestone-2 mark their test phase', () => {
  assert.equal(defaultConfig().pipeline.find((p) => p.phase === 'test').test, true);
  assert.equal(defaultConfig().pipeline.filter((p) => p.test).length, 1);
  assert.deepEqual(MILESTONE_2_PIPELINE.filter((p) => p.test).map((p) => p.phase), ['test']);
});

test('LEGACY_ARTIFACTS substituted is today\'s fixed artifact table', () => {
  const job = { slug: 'add-hello-12345678', createdDate: '2026-11-03' };
  assert.deepEqual(substituteArtifacts(LEGACY_ARTIFACTS, { slug: job.slug, date: job.createdDate }), artifactPaths(job));
});

test('substituteArtifacts replaces every {slug} and {date}', () => {
  assert.deepEqual(substituteArtifacts({ a: 'x/{slug}/{date}-{slug}.md' }, { slug: 's', date: 'd' }), { a: 'x/s/d-s.md' });
});

test('the base test workflow is valid', () => {
  assert.deepEqual(check(baseDoc()), []);
});

test('validation refuses', async (t) => {
  const cases = [
    ['an unknown format', (d) => { d.format = 2; }, /format/],
    ['a bad id', (d) => { d.id = '-bad id'; }, /id "-bad id" must be/],
    ['the reserved id', (d) => { d.id = 'config-pipeline'; }, /reserved/],
    ['a duplicate phase id', (d) => { d.phases[3].phase = 'spec'; }, /duplicate phase id "spec"/],
    ['an input not produced earlier', (d) => { d.phases[0].inputs = ['testReport']; }, /input "testReport" is not produced by an earlier phase/],
    ['an output not in artifacts', (d) => { d.phases[0].outputs.push('extra'); }, /output "extra" has no path in artifacts/],
    ['a review target with two earlier author producers', (d) => {
      d.phases.splice(1, 0, { phase: 'spec2', kind: 'author', role: 'planner', inputs: ['spec'], outputs: ['spec'] });
    }, /target "spec" needs exactly one earlier author phase that outputs it/],
    ['a review author that is not the producer\'s role', (d) => { d.phases[1].author = 'planner'; }, /author "planner" must be "spec-writer", the role of the phase that produces "spec"/],
    ['a brainstorm that is not first', (d) => {
      d.artifacts.brief = 'docs/custom/brief.md';
      d.phases.splice(1, 0, { phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] });
    }, /brainstorm phase must be the first phase/],
    ['a brainstorm with outputs other than brief', (d) => {
      d.artifacts.brief = 'docs/custom/brief.md';
      d.artifacts.notes = 'docs/custom/notes.md';
      d.phases.unshift({ phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], outputs: ['brief', 'notes'] });
    }, /brainstorm phase must output exactly \["brief"\]/],
    ['test: true on a non-author phase', (d) => { d.phases[1].test = true; }, /test: true is only allowed on author phases/],
    ['two test phases', (d) => { d.phases[0].test = true; }, /at most one phase can have test: true/],
    ['a test phase not directly after the per-task phase', (d) => {
      d.phases.splice(3, 0, { phase: 'between', kind: 'author', role: 'planner', inputs: ['spec'], outputs: ['extra'] });
      d.artifacts.extra = 'docs/custom/extra.md';
    }, /test: true phase must come directly after the per-task phase/],
    ['two per-task phases', (d) => {
      d.phases.splice(3, 0, { phase: 'implement2', kind: 'per-task', role: 'implementer', inputs: ['tasks'] });
    }, /at most one per-task phase/],
    ['a last phase that is not human', (d) => { d.phases.pop(); }, /exactly one human phase, and it must be last/],
    ['a role with no model', (d) => { d.phases[0].role = 'ghostwriter'; }, /"ghostwriter" has no entry in models/],
    ['a role with no prompt', (d) => { d.phases[2].taskReview = 'nitpicker'; d.roles = { nitpicker: { model: 'claude-sonnet-5-5', maxTurns: 10 } }; }, /role "nitpicker" has no prompt/],
    ['the artifact key review (a reserved attempt-key kind)', (d) => { d.artifacts.review = 'docs/custom/review.md'; }, /artifact key "review" is reserved/],
    ['the artifact key idea', (d) => { d.artifacts.idea = 'docs/custom/idea.md'; }, /artifact key "idea" is reserved/],
    ['an artifact key with a colon', (d) => { d.artifacts['a:b'] = 'docs/custom/ab.md'; }, /artifact key "a:b" must be/],
    ['an absolute artifact path', (d) => { d.artifacts.spec = '/etc/spec.md'; }, /must be relative to the repo/],
    ['a drive-letter artifact path', (d) => { d.artifacts.spec = 'C:\\spec.md'; }, /must be relative to the repo/],
    ['an artifact path containing ..', (d) => { d.artifacts.spec = 'docs/../../spec.md'; }, /must not contain "\.\."/],
    ['an artifact path inside .git/', (d) => { d.artifacts.spec = '.git/spec.md'; }, /reserved \.git\//],
    ['an artifact path inside .superpowers/superagent/', (d) => { d.artifacts.spec = '.superpowers/superagent/spec.md'; }, /reserved \.superpowers\/superagent\//],
    ['an artifact path inside the job\'s reviews/', (d) => { d.artifacts.spec = 'docs/superpowers/jobs/{slug}/reviews/spec.md'; }, /reserved docs\/superpowers\/jobs\/\{slug\}\/reviews\//],
    ['an artifact path inside the job\'s tasks/', (d) => { d.artifacts.spec = 'docs/superpowers/jobs/{slug}/tasks/spec.md'; }, /reserved docs\/superpowers\/jobs\/\{slug\}\/tasks\//],
    ['an unknown placeholder', (d) => { d.artifacts.spec = 'docs/{user}/spec.md'; }, /only \{slug\} and \{date\}/],
    ['tasks mapped to a non-.json path', (d) => { d.artifacts.tasks = 'docs/custom/tasks.md'; }, /"tasks" must be a \.json path/],
  ];
  for (const [name, mutate, message] of cases) {
    await t.test(name, () => {
      const doc = baseDoc();
      mutate(doc);
      const errors = check(doc);
      assert.ok(errors.some((e) => message.test(e.message)), `${name}: ${JSON.stringify(errors)}`);
    });
  }
  await t.test('two artifact paths equal after substitution and win32 normalisation', () => {
    const doc = baseDoc();
    doc.artifacts.spec = 'Docs\\A.md';
    doc.artifacts.testReport = 'docs/a.md';
    assert.ok(check(doc, { platform: 'win32' }).some((e) => /artifacts\.testReport: path collides with artifacts\.spec/.test(`${e.path}: ${e.message}`)));
    assert.ok(!check(doc, { platform: 'linux' }).some((e) => /collides/.test(e.message)));
  });
  await t.test('a reserved namespace in a different case on win32', () => {
    const doc = baseDoc();
    doc.artifacts.spec = '.GIT\\spec.md';
    assert.ok(check(doc, { platform: 'win32' }).some((e) => /reserved \.git\//.test(e.message)));
  });
  await t.test('error paths name the workflow fields, not config.json ones', () => {
    const doc = baseDoc();
    doc.phases[0].inputs = ['nope'];
    assert.ok(check(doc).some((e) => e.path === 'phases[0].inputs'));
  });
});

test('validation accepts a test phase without a per-task phase', () => {
  const doc = {
    format: 1,
    id: 'two-step',
    name: 'Two step',
    artifacts: { spec: 'docs/spec.md', testReport: 'docs/report.md' },
    phases: [
      { phase: 'write', kind: 'author', role: 'spec-writer', inputs: ['idea'], outputs: ['spec'] },
      { phase: 'check', kind: 'author', role: 'tester', inputs: ['spec'], outputs: ['testReport'], test: true },
      { phase: 'accept', kind: 'human', inputs: ['testReport'] },
    ],
  };
  assert.deepEqual(check(doc), []);
});

test('resolvePromptPath: project override > workflow prompt > built-in', async () => {
  const root = await tempDir('sa-wf-prompts-');
  const projectDir = path.join(root, 'repo');
  const builtinDir = path.join(root, 'builtin');
  const workflowFile = path.join(root, 'wf', 'x.json');
  await writeJson(path.join(builtinDir, 'fixer.md'), 'built-in');
  await writeJson(path.join(root, 'wf', 'prompts', 'fixer.md'), 'workflow');
  const opts = { projectDir, workflowFile, promptField: 'prompts/fixer.md', builtinDir };
  assert.deepEqual(await resolvePromptPath('fixer', opts), { source: 'workflow', path: path.join(root, 'wf', 'prompts', 'fixer.md') });
  assert.deepEqual(await resolvePromptPath('fixer', { ...opts, promptField: undefined }), { source: 'built-in', path: path.join(builtinDir, 'fixer.md') });
  const override = path.join(projectDir, '.superpowers', 'superagent', 'prompts', 'fixer.md');
  await writeJson(override, 'project');
  assert.deepEqual(await resolvePromptPath('fixer', opts), { source: 'project', path: override });
  assert.equal(await resolvePromptPath('nobody', { ...opts, promptField: undefined }), null);
  assert.equal(await resolvePromptPath('../fixer', opts), null);
  assert.equal(await resolvePromptPath('contract', { builtinDir }), null);
});

test('resolvePromptPath does not fall back to the built-in for a missing workflow prompt', async () => {
  const root = await tempDir('sa-wf-prompts-');
  await writeJson(path.join(root, 'builtin', 'fixer.md'), 'built-in');
  assert.equal(await resolvePromptPath('fixer', { workflowFile: path.join(root, 'x.json'), promptField: 'gone.md', builtinDir: path.join(root, 'builtin') }), null);
});

test('resolvePromptPath rejects on a read error other than ENOENT', async () => {
  const fsImpl = { ...fs, readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  await assert.rejects(resolvePromptPath('tester', { fsImpl }), /denied/);
});

test('loader contract', async (t) => {
  const setup = async () => {
    const root = await tempDir('sa-wf-load-');
    const dirs = { builtinDir: path.join(root, 'builtin'), globalDir: path.join(root, 'global'), projectDir: path.join(root, 'repo') };
    await fs.mkdir(dirs.builtinDir, { recursive: true });
    await fs.copyFile(path.join(workflowsDir(), 'feature.json'), path.join(dirs.builtinDir, 'feature.json'));
    return { root, dirs };
  };
  const byId = (workflows, id) => workflows.filter((w) => w.id === id);

  await t.test('same-id files in one source are both invalid, and shadow the built-in', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(dirs.globalDir, 'a.json'), { ...baseDoc(), id: 'feature' });
    await writeJson(path.join(dirs.globalDir, 'b.json'), { ...baseDoc(), id: 'feature' });
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: {} });
    const features = byId(workflows, 'feature');
    assert.deepEqual(features.map((w) => [w.source, path.basename(w.file), w.valid]), [['global', 'a.json', false], ['global', 'b.json', false]]);
    for (const w of features) assert.ok(w.errors.some((e) => /duplicate id/.test(e.message)));
  });

  await t.test('an unparseable file is listed invalid under its file name', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(dirs.globalDir, 'broken.json'), '{ not json');
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: {} });
    const broken = workflows.find((w) => w.file === path.join(dirs.globalDir, 'broken.json'));
    assert.deepEqual([broken.id, broken.name, broken.valid, broken.doc], [null, 'broken.json', false, null]);
    assert.ok(broken.errors.some((e) => /not valid JSON/.test(e.message)));
    assert.equal(byId(workflows, 'feature')[0].valid, true);
  });

  await t.test('a file with the reserved id shadows nothing', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(dirs.globalDir, 'x.json'), { ...baseDoc(), id: CONFIG_PIPELINE_ID });
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: { defaults: { pipeline: defaultConfig().pipeline } } });
    const listed = workflows.find((w) => w.file === path.join(dirs.globalDir, 'x.json'));
    assert.deepEqual([listed.id, listed.name, listed.valid], [null, 'x.json', false]);
    assert.equal(byId(workflows, CONFIG_PIPELINE_ID)[0].source, 'config');
  });

  await t.test('an invalid project feature shadows the built-in', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(projectWorkflows(dirs.projectDir), 'feature.json'), { ...baseDoc(), id: 'feature', format: 9 });
    const { workflows, default: def } = await loadWorkflows({ ...dirs, fileConfig: {} });
    const features = byId(workflows, 'feature');
    assert.deepEqual(features.map((w) => [w.source, w.valid]), [['project', false]]);
    assert.equal(def, 'feature');
  });

  await t.test('a valid project x overrides a valid global x', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(dirs.globalDir, 'x.json'), { ...baseDoc(), id: 'x', name: 'Global x' });
    await writeJson(path.join(projectWorkflows(dirs.projectDir), 'mine.json'), { ...baseDoc(), id: 'x', name: 'Project x' });
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: {} });
    assert.deepEqual(byId(workflows, 'x').map((w) => [w.source, w.name, w.valid]), [['project', 'Project x', true]]);
  });

  await t.test('files are read in name order; non-.json files and subdirectories are ignored', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(dirs.globalDir, 'c.json'), { ...baseDoc(), id: 'c' });
    await writeJson(path.join(dirs.globalDir, 'a.json'), { ...baseDoc(), id: 'a' });
    await writeJson(path.join(dirs.globalDir, 'b.json'), { ...baseDoc(), id: 'b' });
    await writeJson(path.join(dirs.globalDir, 'notes.txt'), 'hi');
    await writeJson(path.join(dirs.globalDir, 'sub.json', 'inner.json'), { ...baseDoc(), id: 'inner' });
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: {} });
    assert.deepEqual(workflows.filter((w) => w.source === 'global').map((w) => w.id), ['a', 'b', 'c']);
  });

  await t.test('missing directories are no error', async () => {
    const root = await tempDir('sa-wf-load-');
    const { workflows } = await loadWorkflows({ builtinDir: path.join(root, 'a'), globalDir: path.join(root, 'b'), projectDir: path.join(root, 'c'), fileConfig: {} });
    assert.deepEqual(workflows, []);
  });

  await t.test('a prompt read that rejects makes only that entry invalid', async () => {
    const { dirs } = await setup();
    const promptFile = path.join(dirs.globalDir, 'bad.md');
    await writeJson(path.join(dirs.globalDir, 'x.json'), { ...baseDoc(), id: 'x', roles: { tester: { prompt: 'bad.md' } } });
    const fsImpl = { ...fs, readFile: async (file, ...rest) => {
      if (file === promptFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFile(file, ...rest);
    } };
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: {}, fsImpl });
    const x = byId(workflows, 'x')[0];
    assert.equal(x.valid, false);
    assert.ok(x.errors.some((e) => /denied/.test(e.message)));
    assert.equal(byId(workflows, 'feature')[0].valid, true);
  });

  await t.test('a missing workflow prompt makes the entry invalid', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(dirs.globalDir, 'x.json'), { ...baseDoc(), id: 'x', roles: { tester: { prompt: 'gone.md' } } });
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: {} });
    const x = byId(workflows, 'x')[0];
    assert.equal(x.valid, false);
    assert.ok(x.errors.some((e) => /role "tester" has no prompt/.test(e.message) && /gone\.md/.test(e.message)));
  });

  await t.test('a workflow prompt next to the file and a workflow model make a new role valid', async () => {
    const { dirs } = await setup();
    await writeJson(path.join(dirs.globalDir, 'fixer.md'), 'fix it');
    const doc = baseDoc();
    doc.id = 'x';
    doc.phases[2].role = 'fixer';
    doc.roles = { fixer: { prompt: 'fixer.md', model: 'claude-sonnet-5-5', maxTurns: 80, alternate: 'claude-opus-5-5' } };
    await writeJson(path.join(dirs.globalDir, 'x.json'), doc);
    const { workflows } = await loadWorkflows({ ...dirs, fileConfig: {} });
    assert.deepEqual(byId(workflows, 'x')[0].errors, []);
  });
});

test('default selection', async (t) => {
  const root = await tempDir('sa-wf-default-');
  const builtinDir = path.join(root, 'builtin');
  const globalDir = path.join(root, 'global');
  const projectDir = path.join(root, 'repo');
  await fs.mkdir(builtinDir, { recursive: true });
  await fs.copyFile(path.join(workflowsDir(), 'feature.json'), path.join(builtinDir, 'feature.json'));
  await writeJson(path.join(globalDir, 'mine.json'), { ...baseDoc(), id: 'mine' });
  const pipeline = defaultConfig().pipeline;
  const load = (fileConfig, projectPath = projectDir) => loadWorkflows({ builtinDir, globalDir, projectDir, projectPath, fileConfig });

  await t.test('feature when nothing is configured', async () => {
    assert.deepEqual(await load({}).then((r) => [r.default, r.defaultNote]), ['feature', null]);
  });
  await t.test('defaults.workflow', async () => {
    assert.equal((await load({ defaults: { workflow: 'mine' } })).default, 'mine');
  });
  await t.test('defaults.pipeline selects config-pipeline', async () => {
    assert.equal((await load({ defaults: { pipeline } })).default, CONFIG_PIPELINE_ID);
  });
  await t.test('defaults.workflow beats defaults.pipeline', async () => {
    assert.equal((await load({ defaults: { workflow: 'mine', pipeline } })).default, 'mine');
  });
  await t.test('a project pipeline beats defaults.workflow', async () => {
    assert.equal((await load({ defaults: { workflow: 'mine' }, projects: { [projectDir]: { pipeline } } })).default, CONFIG_PIPELINE_ID);
  });
  await t.test('a project workflow beats defaults.pipeline', async () => {
    assert.equal((await load({ defaults: { pipeline }, projects: { [projectDir]: { workflow: 'mine' } } })).default, 'mine');
  });
  await t.test('a project workflow beats a project pipeline', async () => {
    assert.equal((await load({ projects: { [projectDir]: { workflow: 'mine', pipeline } } })).default, 'mine');
  });
  await t.test('another project\'s settings do not apply', async () => {
    assert.equal((await load({ projects: { [path.join(root, 'other')]: { workflow: 'mine' } } })).default, 'feature');
  });
  await t.test('a project key differing only in case matches on win32', { skip: process.platform !== 'win32' }, async () => {
    assert.equal((await load({ projects: { [projectDir.toUpperCase()]: { workflow: 'mine' } } })).default, 'mine');
  });
  await t.test('an unknown configured workflow falls back to feature with a note', async () => {
    const { default: def, defaultNote } = await load({ defaults: { workflow: 'nope' } });
    assert.equal(def, 'feature');
    assert.match(defaultNote, /nope/);
  });
  await t.test('an invalid configured workflow falls back to feature with a note', async () => {
    await writeJson(path.join(globalDir, 'zbroken.json'), { ...baseDoc(), id: 'broken', format: 7 });
    const { default: def, defaultNote } = await load({ defaults: { workflow: 'broken' } });
    assert.equal(def, 'feature');
    assert.match(defaultNote, /broken/);
  });
});

test('config-pipeline is listed when the raw file sets pipeline', async (t) => {
  const root = await tempDir('sa-wf-cfgpipe-');
  const builtinDir = path.join(root, 'builtin');
  const projectDir = path.join(root, 'repo');
  await fs.mkdir(builtinDir, { recursive: true });
  await fs.copyFile(path.join(workflowsDir(), 'feature.json'), path.join(builtinDir, 'feature.json'));
  const withoutReview = (id) => defaultConfig().pipeline.filter((p) => p.phase !== id);
  const load = (fileConfig) => loadWorkflows({ builtinDir, globalDir: path.join(root, 'none'), projectDir, fileConfig });

  await t.test('not listed without a raw pipeline', async () => {
    const { workflows } = await load({ defaults: { limits: { stallMinutes: 5 } } });
    assert.ok(!workflows.some((w) => w.id === CONFIG_PIPELINE_ID));
  });
  await t.test('from defaults, next to feature', async () => {
    const { workflows } = await load({ defaults: { pipeline: withoutReview('spec-review') } });
    assert.deepEqual(workflows.map((w) => w.id), ['feature', CONFIG_PIPELINE_ID]);
    const entry = workflows[1];
    assert.deepEqual([entry.name, entry.source, entry.valid], ['custom (config.json)', 'config', true]);
    assert.deepEqual(entry.doc.phases, withoutReview('spec-review'));
    assert.deepEqual(entry.doc.artifacts, LEGACY_ARTIFACTS);
  });
  await t.test('the matching project entry wins over defaults', async () => {
    const { workflows } = await load({ defaults: { pipeline: withoutReview('spec-review') }, projects: { [projectDir]: { pipeline: withoutReview('plan-review') } } });
    assert.deepEqual(workflows.find((w) => w.id === CONFIG_PIPELINE_ID).doc.phases, withoutReview('plan-review'));
  });
  await t.test('from the matching project entry alone', async () => {
    const { workflows } = await load({ projects: { [projectDir]: { pipeline: withoutReview('plan-review') } } });
    assert.deepEqual(workflows.find((w) => w.id === CONFIG_PIPELINE_ID).doc.phases, withoutReview('plan-review'));
  });
  await t.test('validated by today\'s composition rule', async () => {
    const { workflows, default: def, defaultNote } = await load({ defaults: { pipeline: withoutReview('test') } });
    const entry = workflows.find((w) => w.id === CONFIG_PIPELINE_ID);
    assert.equal(entry.valid, false);
    assert.ok(entry.errors.some((e) => /v1 pipelines must contain/.test(e.message)));
    assert.equal(def, 'feature');
    assert.match(defaultNote, /config-pipeline/);
  });
});

test('models merge in four layers', () => {
  const projectPath = path.resolve('some-repo');
  const workflow = { roles: { implementer: { prompt: 'x.md', maxTurns: 50, effort: 'high', model: 'wf-model' } } };
  const fileConfig = {
    defaults: { models: { implementer: { model: 'defaults-model', effort: 'medium' } } },
    projects: { [projectPath]: { models: { implementer: { effort: 'low' } } } },
  };
  assert.deepEqual(resolveWorkflowModels(workflow, fileConfig, projectPath).implementer, {
    provider: 'claude', model: 'defaults-model', maxTurns: 50, effort: 'low', alternate: 'claude-opus-5-5',
  });
  assert.deepEqual(resolveWorkflowModels(workflow, {}, null).implementer, {
    provider: 'claude', model: 'wf-model', maxTurns: 50, effort: 'high', alternate: 'claude-opus-5-5',
  });
  assert.deepEqual(resolveWorkflowModels({ roles: { fixer: { model: 'claude-sonnet-5-5', maxTurns: 80 } } }, {}, null).fixer, {
    provider: 'claude', model: 'claude-sonnet-5-5', maxTurns: 80,
  });
  assert.deepEqual(resolveWorkflowModels({}, fileConfig, projectPath), {
    ...defaultConfig().models,
    implementer: { ...defaultConfig().models.implementer, model: 'defaults-model', effort: 'low' },
  });
});
