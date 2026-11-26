// Superagent workflow files: loading, validation, prompt lookup and the
// model merge.
//
// Spec: docs/superpowers/specs/2026-11-17-superagent-p7-workflows-design.md,
// "Workflow files" and "Default models per role".
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_ROLES,
  PHASE_ID,
  defaultConfig,
  defaultSuperagentRoot,
  findProjectEntry,
  keyPath,
  resolveProjectConfig,
  validateDefaults,
  validatePipeline,
} from './config.js';
import { RESERVED_ARTIFACT_KEYS } from './results.js';

export const WORKFLOW_FORMAT = 1;
export const CONFIG_PIPELINE_ID = 'config-pipeline';
const CONFIG_PIPELINE_NAME = 'custom (config.json)';
const DEFAULT_WORKFLOW = 'feature';
export const ROLE_NAME = /^[a-z0-9][a-z0-9-]*$/i;
const CONTRACT_ROLE = 'contract';
const ARTIFACT_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const MODEL_FIELDS = ['provider', 'model', 'maxTurns', 'effort', 'alternate'];
const SAMPLE_JOB = { slug: 'sample-job-00000000', date: '2000-01-01' };
const RESERVED_PATHS = ['.git/', '.superpowers/', 'reviews/', 'tasks/', 'feedback/'];

export const LEGACY_ARTIFACTS = Object.freeze({
  brief: 'docs/superpowers/jobs/{slug}/brief.md',
  spec: 'docs/superpowers/specs/{date}-{slug}-design.md',
  plan: 'docs/superpowers/plans/{date}-{slug}.md',
  tasks: 'docs/superpowers/jobs/{slug}/tasks.json',
  testReport: 'docs/superpowers/jobs/{slug}/test-report.md',
});

export const LEDGER_LEGACY_ARTIFACTS = Object.freeze({ brief: 'brief.md', spec: 'spec.md', plan: 'plan.md', tasks: 'tasks.json', testReport: 'test-report.md' });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
// The id pattern ignores case, so precedence, duplicates and lookups do too.
export const sameWorkflowId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function workflowsDir() {
  return fileURLToPath(new URL('../../workflows/', import.meta.url));
}

export function templatesDir() {
  return fileURLToPath(new URL('../../prompts/superagent/', import.meta.url));
}

export function substituteArtifacts(artifacts, { slug, date }) {
  return Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, value.replaceAll('{slug}', slug).replaceAll('{date}', date)]));
}

async function exists(file, fsImpl) {
  try {
    await fsImpl.readFile(file, 'utf8');
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

// A declared workflow prompt that is missing resolves to null, never to the built-in.
export async function resolvePromptPath(role, { projectDir = null, workflowFile = null, promptField = null, userPromptsDir = null, builtinDir = templatesDir(), fsImpl = fs } = {}) {
  if (typeof role !== 'string' || !ROLE_NAME.test(role) || role === CONTRACT_ROLE) return null;
  const file = `${role}.md`;
  if (projectDir) {
    const override = path.join(projectDir, '.superpowers', 'superagent', 'prompts', file);
    if (await exists(override, fsImpl)) return { source: 'project', path: override };
  }
  if (workflowFile && isNonEmptyString(promptField)) {
    const declared = path.resolve(path.dirname(workflowFile), promptField);
    return (await exists(declared, fsImpl)) ? { source: 'workflow', path: declared } : null;
  }
  if (userPromptsDir) {
    const user = path.join(userPromptsDir, file);
    if (await exists(user, fsImpl)) return { source: 'user', path: user };
  }
  const builtin = path.join(builtinDir, file);
  return (await exists(builtin, fsImpl)) ? { source: 'built-in', path: builtin } : null;
}

function workflowBase(workflow) {
  const base = defaultConfig();
  const roles = isPlainObject(workflow?.roles) ? workflow.roles : {};
  for (const [role, entry] of Object.entries(roles)) {
    if (!isPlainObject(entry) || ENGINE_ROLES.includes(role)) continue;
    const fields = Object.fromEntries(MODEL_FIELDS.filter((f) => entry[f] !== undefined).map((f) => [f, entry[f]]));
    base.models[role] = { ...(isPlainObject(base.models[role]) ? base.models[role] : { provider: 'claude' }), ...fields };
  }
  return base;
}

function workflowConfig(workflow, fileConfig, projectPath) {
  return resolveProjectConfig(fileConfig, projectPath, workflowBase(workflow));
}

export function resolveWorkflowModels(workflow, fileConfig, projectPath) {
  return workflowConfig(workflow, fileConfig, projectPath).models;
}

const normaliseArtifactPath = (p, platform) => {
  const n = path.posix.normalize(p.replaceAll('\\', '/'));
  return platform === 'win32' ? n.toLowerCase() : n;
};

function checkArtifacts(artifacts, errors, platform) {
  const reserved = RESERVED_PATHS.map((raw) => ({ raw, prefix: normaliseArtifactPath(raw.replaceAll('{slug}', SAMPLE_JOB.slug), platform) }));
  const seen = new Map();
  for (const [key, value] of Object.entries(artifacts)) {
    const at = keyPath('artifacts', key);
    if (!ARTIFACT_KEY.test(key)) {
      errors.push({ path: at, message: `artifact key "${key}" must be a letter followed by up to 31 letters or digits` });
    } else if (RESERVED_ARTIFACT_KEYS.includes(key)) {
      errors.push({ path: at, message: `artifact key "${key}" is reserved` });
    }
    if (!isNonEmptyString(value)) {
      errors.push({ path: at, message: 'artifact path must be a non-empty string' });
      continue;
    }
    if (/\{[^}]*\}/.test(value.replaceAll('{slug}', '').replaceAll('{date}', ''))) {
      errors.push({ path: at, message: 'only {slug} and {date} placeholders are allowed' });
    }
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
      errors.push({ path: at, message: `"${value}" must be relative to the repo` });
      continue;
    }
    if (value.split(/[\\/]/).includes('..')) {
      errors.push({ path: at, message: `"${value}" must not contain ".."` });
      continue;
    }
    const normalised = normaliseArtifactPath(substituteArtifacts({ key: value }, SAMPLE_JOB).key, platform);
    if (normalised === '.' || normalised.endsWith('/')) {
      errors.push({ path: at, message: `"${value}" must name a file` });
      continue;
    }
    const hit = reserved.find(({ prefix }) => normalised === prefix.slice(0, -1) || normalised.startsWith(prefix));
    if (hit) errors.push({ path: at, message: `"${value}" is inside the reserved ${hit.raw}` });
    if (key === 'tasks' && !/\.json$/i.test(normalised)) errors.push({ path: at, message: '"tasks" must be a .json path' });
    if (seen.has(normalised)) errors.push({ path: at, message: `path collides with ${keyPath('artifacts', seen.get(normalised))}` });
    else seen.set(normalised, key);
  }
}

const rolesUsed = (phases) => [...new Set(phases.filter(isPlainObject).flatMap((p) => [p.kind !== 'human' ? p.role : null, p.kind === 'per-task' ? p.taskReview : null]).filter(isNonEmptyString))];

function checkPhases(phases, artifactKeys, errors, roles, promptFor) {
  const at = (i, field) => `phases[${i}].${field}`;
  const producers = new Map();
  let perTask = -1;
  let testPhase = -1;
  phases.forEach((phase, i) => {
    if (!isPlainObject(phase)) return;
    const outputs = Array.isArray(phase.outputs) ? phase.outputs : [];
    for (const output of outputs) {
      if (!artifactKeys.has(output)) errors.push({ path: at(i, 'outputs'), message: `output "${output}" has no path in artifacts` });
    }
    if (phase.kind === 'review' && isNonEmptyString(phase.target)) {
      if (!artifactKeys.has(phase.target)) errors.push({ path: at(i, 'target'), message: `target "${phase.target}" has no path in artifacts` });
      const authors = producers.get(phase.target) ?? [];
      if (authors.length !== 1) {
        errors.push({ path: at(i, 'target'), message: `target "${phase.target}" needs exactly one earlier author phase that outputs it` });
      } else if (phase.author !== authors[0].role) {
        errors.push({ path: at(i, 'author'), message: `author "${phase.author}" must be "${authors[0].role}", the role of the phase that produces "${phase.target}"` });
      }
    }
    if (phase.kind === 'brainstorm' && !(outputs.length === 1 && outputs[0] === 'brief')) {
      errors.push({ path: at(i, 'outputs'), message: 'a brainstorm phase must output exactly ["brief"]' });
    }
    if (phase.test !== undefined && typeof phase.test !== 'boolean') {
      errors.push({ path: at(i, 'test'), message: 'test must be true or false' });
    } else if (phase.test === true) {
      if (phase.kind !== 'author') errors.push({ path: at(i, 'test'), message: 'test: true is only allowed on author phases' });
      if (testPhase !== -1) errors.push({ path: at(i, 'test'), message: 'at most one phase can have test: true' });
      else testPhase = i;
    }
    if (phase.kind === 'per-task') {
      if (perTask !== -1) errors.push({ path: at(i, 'kind'), message: 'a workflow can have at most one per-task phase' });
      else perTask = i;
    }
    if (phase.kind === 'author') {
      for (const output of outputs) producers.set(output, [...(producers.get(output) ?? []), phase]);
    }
  });
  if (perTask !== -1 && testPhase !== -1 && testPhase !== perTask + 1) {
    errors.push({ path: `phases[${testPhase}].test`, message: 'the test: true phase must come directly after the per-task phase' });
  }
  for (const role of rolesUsed(phases)) {
    if (promptFor[role] != null) continue;
    const declared = isPlainObject(roles[role]) && isNonEmptyString(roles[role].prompt) ? roles[role].prompt : null;
    errors.push({
      path: `${keyPath('roles', role)}.prompt`,
      message: declared
        ? `role "${role}" has no prompt: "${declared}" was not found next to the workflow file`
        : `role "${role}" has no prompt: no project override, no prompt in your workflows folder and no built-in template of that name`,
    });
  }
}

function checkRoles(roles, errors) {
  for (const [role, entry] of Object.entries(roles)) {
    const at = keyPath('roles', role);
    if (!ROLE_NAME.test(role)) errors.push({ path: at, message: `role name "${role}" must be letters, digits or hyphens, starting with a letter or digit` });
    if (ENGINE_ROLES.includes(role)) errors.push({ path: at, message: `"${role}" is an engine role; set its model in config.json` });
    if (!isPlainObject(entry)) errors.push({ path: at, message: 'role entry must be an object' });
    else if (entry.prompt !== undefined && !isNonEmptyString(entry.prompt)) errors.push({ path: `${at}.prompt`, message: 'prompt must be a non-empty string' });
  }
}

// `config` is the resolved config the pipeline checks run against; `models` replaces its models.
export function validateWorkflow(doc, { models, promptFor = {}, config = defaultConfig(), platform = process.platform } = {}) {
  const errors = [];
  if (!isPlainObject(doc)) return { errors: [{ path: '', message: 'a workflow must be a JSON object' }] };
  if (doc.format !== WORKFLOW_FORMAT) errors.push({ path: 'format', message: `unknown format ${JSON.stringify(doc.format)}; expected ${WORKFLOW_FORMAT}` });
  if (!isNonEmptyString(doc.id) || !PHASE_ID.test(doc.id)) {
    errors.push({ path: 'id', message: `id ${JSON.stringify(doc.id ?? null)} must be 1-24 letters, digits or hyphens, starting with a letter or digit` });
  } else if (sameWorkflowId(doc.id, CONFIG_PIPELINE_ID)) {
    errors.push({ path: 'id', message: `id "${CONFIG_PIPELINE_ID}" is reserved` });
  }
  let artifacts = {};
  if (!isPlainObject(doc.artifacts)) errors.push({ path: 'artifacts', message: 'artifacts must be an object' });
  else artifacts = doc.artifacts;
  let roles = {};
  if (doc.roles !== undefined && !isPlainObject(doc.roles)) errors.push({ path: 'roles', message: 'roles must be an object' });
  else roles = doc.roles ?? {};
  checkArtifacts(artifacts, errors, platform);
  checkRoles(roles, errors);
  for (const e of validatePipeline({ ...config, pipeline: doc.phases, models }).errors) {
    errors.push({ ...e, path: e.path.replace(/^pipeline/, 'phases') });
  }
  if (Array.isArray(doc.phases)) checkPhases(doc.phases, new Set(Object.keys(artifacts)), errors, roles, promptFor);
  return { errors };
}

async function readSource(source, dir, fsImpl) {
  if (!dir) return [];
  let dirents;
  try {
    dirents = await fsImpl.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    return [{ source, file: dir, name: dir, doc: null, readError: `the workflows folder could not be read: ${err.message}` }];
  }
  const names = dirents.filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => d.name).sort();
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      out.push({ source, file, name, doc: JSON.parse(await fsImpl.readFile(file, 'utf8')), readError: null });
    } catch (err) {
      out.push({ source, file, name, doc: null, readError: err instanceof SyntaxError ? `not valid JSON: ${err.message}` : `could not be read: ${err.message}` });
    }
  }
  return out;
}

async function evaluate(raw, { projectDir, userPromptsDir, fileConfig, projectPath, fsImpl, platform }) {
  const { doc } = raw;
  if (raw.readError) return [{ path: '', message: raw.readError }];
  if (!isPlainObject(doc)) return validateWorkflow(doc, {}).errors;
  const config = workflowConfig(doc, fileConfig, projectPath);
  const roles = isPlainObject(doc.roles) ? doc.roles : {};
  const readErrors = [];
  const promptFor = {};
  for (const role of new Set([...rolesUsed(Array.isArray(doc.phases) ? doc.phases : []), ...Object.keys(roles)])) {
    const promptField = isPlainObject(roles[role]) ? roles[role].prompt : null;
    try {
      promptFor[role] = (await resolvePromptPath(role, { projectDir, workflowFile: raw.file, promptField, userPromptsDir, fsImpl }))?.path ?? null;
    } catch (err) {
      promptFor[role] = null;
      readErrors.push({ path: `${keyPath('roles', role)}.prompt`, message: `the prompt for "${role}" could not be read: ${err.message}` });
    }
  }
  return [...readErrors, ...validateWorkflow(doc, { models: config.models, promptFor, config, platform }).errors];
}

const usableId = (doc) => (isPlainObject(doc) && isNonEmptyString(doc.id) && PHASE_ID.test(doc.id) && !sameWorkflowId(doc.id, CONFIG_PIPELINE_ID) ? doc.id : null);

function entryFor(raw, errors) {
  const id = usableId(raw.doc);
  return {
    id,
    name: id !== null && isNonEmptyString(raw.doc.name) ? raw.doc.name : (id ?? raw.name),
    description: id !== null && typeof raw.doc.description === 'string' ? raw.doc.description : '',
    source: raw.source,
    file: raw.file,
    valid: errors.length === 0,
    errors,
    doc: raw.doc,
  };
}

function configPipelineEntry(fileConfig, projectPath) {
  const project = findProjectEntry(fileConfig, projectPath);
  if (fileConfig?.defaults?.pipeline === undefined && project?.pipeline === undefined) return null;
  const resolved = resolveProjectConfig(fileConfig, projectPath);
  const { errors } = validateDefaults(resolved);
  return {
    id: CONFIG_PIPELINE_ID,
    name: CONFIG_PIPELINE_NAME,
    description: 'The pipeline set in config.json (deprecated: use a workflow file).',
    source: 'config',
    file: null,
    valid: errors.length === 0,
    errors,
    doc: { format: WORKFLOW_FORMAT, id: CONFIG_PIPELINE_ID, name: CONFIG_PIPELINE_NAME, artifacts: { ...LEGACY_ARTIFACTS }, phases: resolved.pipeline },
  };
}

function configuredDefault(fileConfig, projectPath) {
  const project = findProjectEntry(fileConfig, projectPath);
  const defaults = fileConfig?.defaults;
  if (project?.workflow !== undefined) return project.workflow;
  if (project?.pipeline !== undefined) return CONFIG_PIPELINE_ID;
  if (defaults?.workflow !== undefined) return defaults.workflow;
  if (defaults?.pipeline !== undefined) return CONFIG_PIPELINE_ID;
  return null;
}

export async function loadWorkflows({
  builtinDir = workflowsDir(),
  globalDir = path.join(defaultSuperagentRoot(), 'workflows'),
  userDir = null,
  userError = null,
  projectDir = null,
  fileConfig = {},
  projectPath = projectDir,
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  const sources = [
    ['built-in', builtinDir],
    ['global', globalDir],
    ['user', userDir && path.join(userDir, 'workflows')],
    ['project', projectDir && path.join(projectDir, '.superpowers', 'superagent', 'workflows')],
  ];
  const userPromptsDir = userDir && !userError ? path.join(userDir, 'prompts') : null;
  const ctx = { projectDir, userPromptsDir, fileConfig, projectPath, fsImpl, platform };
  const all = [];
  for (const [source, dir] of sources) {
    const raws = source === 'user' && userError
      ? [{ source, file: null, name: typeof userError.configured === 'string' ? userError.configured : JSON.stringify(userError.configured), doc: null, readError: `the workflows folder setting is invalid: ${userError.error}` }]
      : await readSource(source, dir, fsImpl);
    for (const raw of raws) all.push(entryFor(raw, await evaluate(raw, ctx)));
  }

  const winner = new Map();
  const count = new Map();
  const key = (e) => e.id.toLowerCase();
  for (const e of all) {
    if (e.id === null) continue;
    winner.set(key(e), e.source);
    count.set(`${e.source}\n${key(e)}`, (count.get(`${e.source}\n${key(e)}`) ?? 0) + 1);
  }
  const configEntry = configPipelineEntry(fileConfig, projectPath);
  const workflows = [];
  for (const e of all) {
    if (e.id !== null && winner.get(key(e)) !== e.source) continue;
    if (e.id !== null && count.get(`${e.source}\n${key(e)}`) > 1) {
      e.errors = [{ path: 'id', message: `duplicate id "${e.id}" in the ${e.source} workflows` }, ...e.errors];
      e.valid = false;
    }
    workflows.push(e);
    if (sameWorkflowId(e.id, DEFAULT_WORKFLOW) && configEntry && !workflows.includes(configEntry)) workflows.push(configEntry);
  }
  if (configEntry && !workflows.includes(configEntry)) workflows.unshift(configEntry);

  // `default` is the listed entry's own spelling, so it matches an option value.
  const fallback = workflows.find((w) => sameWorkflowId(w.id, DEFAULT_WORKFLOW))?.id ?? DEFAULT_WORKFLOW;
  const wanted = configuredDefault(fileConfig, projectPath);
  if (wanted === null) return { workflows, default: fallback, defaultNote: null };
  const match = workflows.find((w) => sameWorkflowId(w.id, wanted));
  if (match?.valid) return { workflows, default: match.id, defaultNote: null };
  const why = match ? 'invalid' : 'unknown';
  return { workflows, default: fallback, defaultNote: `the configured workflow ${JSON.stringify(wanted)} is ${why}; using "${fallback}"` };
}
