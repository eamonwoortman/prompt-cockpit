// Superagent configuration: built-in defaults, global/per-project merge and
// pipeline contract validation.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, sections
// "Configuration" and "Phase contracts and validation"; Decision 13 (Claude is
// the only provider in v1); Decision 17 (superagent never writes a project's
// settings files - this module only touches its own config.json).
import os from 'node:os';
import path from 'node:path';
import { readJsonChecked, updateJson, writeJsonAtomic } from '../json-store.js';
import { costForUsage } from '../usage.js';
import { CLAUDE_EFFORTS } from '../provider-registry.js';

export const PHASE_KINDS = ['author', 'brainstorm', 'review', 'per-task', 'human'];
export const STAND_IN_ROLE = 'stand-in';
// Roles the engine runs itself; their models come from config.json only, never from a workflow file.
export const ENGINE_ROLES = Object.freeze(['verifier', STAND_IN_ROLE, 'router', 'triage']);
export const WORKER_PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk'];
const MODES = ['automatic', 'manual'];
// The router's answer limit; its generation cap adds a thinking allowance on top.
export const ROUTER_MAX_OUTPUT_TOKENS_CAP = 4000;

const freezePhase = (p) => Object.freeze({
  ...p,
  inputs: Object.freeze([...(p.inputs ?? [])]),
  ...(p.outputs ? { outputs: Object.freeze([...p.outputs]) } : {}),
});

export const MILESTONE_1_PIPELINE = Object.freeze([
  freezePhase({ phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['idea'], outputs: ['spec'] }),
  freezePhase({ phase: 'accept', kind: 'human', inputs: ['spec'] }),
]);

export const MILESTONE_2_PIPELINE = Object.freeze([
  freezePhase({ phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['idea'], outputs: ['spec'] }),
  freezePhase({ phase: 'spec-review', kind: 'review', role: 'spec-reviewer', author: 'spec-writer', target: 'spec', maxRounds: 3 }),
  freezePhase({ phase: 'plan', kind: 'author', role: 'planner', inputs: ['spec'], outputs: ['plan', 'tasks'] }),
  freezePhase({ phase: 'plan-review', kind: 'review', role: 'plan-reviewer', author: 'planner', target: 'plan', inputs: ['spec', 'tasks'], maxRounds: 3 }),
  freezePhase({ phase: 'implement', kind: 'per-task', role: 'implementer', taskReview: 'task-reviewer', inputs: ['tasks'] }),
  freezePhase({ phase: 'test', kind: 'author', role: 'tester', inputs: ['spec', 'tasks'], outputs: ['testReport'], test: true }),
  freezePhase({ phase: 'accept', kind: 'human', inputs: ['testReport'] }),
]);

export const FIXTURES = Object.freeze({ 'milestone-1': MILESTONE_1_PIPELINE, 'milestone-2': MILESTONE_2_PIPELINE });

export const USER_FOLDER_MAX_CHARS = 1000;

const defaultHome = () => process.env.COCKPIT_HOME || os.homedir();

export function defaultUserFolder(home = defaultHome()) {
  return path.join(home, '.prompt-cockpit');
}

export function resolveUserFolder(value, { home = defaultHome(), platform = process.platform } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const base = { configured: value ?? null, resolved: null, error: null, default: defaultUserFolder(home) };
  if (value === undefined || value === null) return { ...base, resolved: base.default };
  const fail = (error) => ({ ...base, configured: value, error });
  if (typeof value !== 'string' || value.trim() === '') return fail('userFolder must be a non-empty path');
  const trimmed = value.trim();
  if (trimmed.length > USER_FOLDER_MAX_CHARS) return fail(`userFolder must be at most ${USER_FOLDER_MAX_CHARS} characters`);
  let expanded = trimmed;
  if (trimmed.startsWith('~')) {
    const rest = trimmed.slice(1);
    if (rest === '' || rest[0] === '/' || (win && rest[0] === '\\')) expanded = home + rest;
    else return fail('"~user" paths are not supported; use an absolute path');
  }
  const absolute = p.isAbsolute(expanded) && (!win || /^[a-zA-Z]:[\\/]/.test(expanded) || expanded.startsWith('\\\\'));
  if (!absolute) return fail(`userFolder must be an absolute path or start with ~ (got "${trimmed}")`);
  return { ...base, configured: trimmed, resolved: p.resolve(expanded) };
}

export function validateUserFolder(value, opts) {
  return resolveUserFolder(value, opts).error;
}

export function defaultSuperagentRoot() {
  return path.join(process.env.COCKPIT_HOME || os.homedir(), '.prompt-cockpit', 'superagent');
}

const model = (name, maxTurns, extra = {}) => ({ provider: 'claude', model: name, maxTurns, ...extra });

export function defaultConfig() {
  return {
    mode: 'automatic',
    pipeline: [
      { phase: 'brainstorm', kind: 'brainstorm', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] },
      { phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['brief'], outputs: ['spec'] },
      { phase: 'spec-review', kind: 'review', role: 'spec-reviewer', author: 'spec-writer', target: 'spec', maxRounds: 3 },
      { phase: 'plan', kind: 'author', role: 'planner', inputs: ['spec'], outputs: ['plan', 'tasks'] },
      { phase: 'plan-review', kind: 'review', role: 'plan-reviewer', author: 'planner', target: 'plan', inputs: ['spec', 'tasks'], maxRounds: 3 },
      { phase: 'implement', kind: 'per-task', role: 'implementer', taskReview: 'task-reviewer', inputs: ['tasks'] },
      { phase: 'test', kind: 'author', role: 'tester', inputs: ['spec', 'tasks'], outputs: ['testReport'], test: true },
      { phase: 'accept', kind: 'human', inputs: ['testReport'] },
    ],
    models: {
      router: model('claude-haiku-5-5', 1),
      'stand-in': model('claude-sonnet-5-5', 8),
      brainstormer: model('claude-opus-5-5', 60),
      'spec-writer': model('claude-opus-5-5', 60),
      planner: model('claude-opus-5-5', 60),
      'spec-reviewer': model('claude-opus-5-5', 40),
      'plan-reviewer': model('claude-opus-5-5', 40),
      verifier: model('claude-opus-5-5', 40),
      implementer: model('claude-sonnet-5-5', 80, { alternate: 'claude-opus-5-5' }),
      tester: model('claude-sonnet-5-5', 80),
      'task-reviewer': model('claude-sonnet-5-5', 80),
      triage: model('claude-sonnet-5-5', 20),
    },
    routerModelAllowlist: ['claude-haiku-5-5'],
    routerMaxInputTokens: 6000,
    routerMaxOutputTokens: 300,
    limits: {
      attemptsPerPhase: 3,
      attemptsPerTask: 2,
      taskReviewRounds: 2,
      backoffMinutes: [1, 5],
      stallMinutes: 20,
      repeatedErrorStop: 2,
      brainstormExchanges: 20,
      brainstormTokens: null,
      questionsPerScope: 3,
      driftHandoffPct: 70,
      longCapNotifyHours: 12,
    },
    maxConcurrentSessions: 3,
    budget: { perJobUsd: null, perJobTokens: null },
    workerPermissionMode: 'auto',
    copyLocalClaudeSettings: true,
    commitTests: false,
    testPaths: [
      '**/test/**', '**/tests/**', '**/Test/**', '**/Tests/**', '**/__tests__/**',
      '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*Test.cs', '**/*Tests.cs',
    ],
    branchTemplates: { troubleshooting: 'bugfix/{ticket}-{description}', feature: 'feature/{description}' },
    additionalRepos: [],
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
export const keyPath = (base, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}['${key}']`);

const V1_NON_REVIEW = defaultConfig().pipeline.filter((p) => p.kind !== 'review');
export const PHASE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/i;
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

function checkComposition(pipeline, errors) {
  const nonReview = pipeline.map((phase, i) => ({ phase, i })).filter(({ phase }) => isPlainObject(phase) && phase.kind !== 'review');
  const shapeOk = nonReview.length === V1_NON_REVIEW.length
    && nonReview.every(({ phase }, k) => phase.phase === V1_NON_REVIEW[k].phase && phase.kind === V1_NON_REVIEW[k].kind);
  if (!shapeOk) {
    errors.push({ path: 'pipeline', message: `v1 pipelines must contain the phases ${V1_NON_REVIEW.map((p) => p.phase).join(', ')} in that order (review phases may be added or removed)` });
    return;
  }
  nonReview.forEach(({ phase, i }, k) => {
    const want = V1_NON_REVIEW[k];
    if (!sameList(phase.inputs ?? [], want.inputs ?? [])) {
      errors.push({ path: `pipeline[${i}].inputs`, message: `phase "${phase.phase}" must take inputs [${(want.inputs ?? []).join(', ')}] in v1` });
    }
    if (!sameList(phase.outputs ?? [], want.outputs ?? [])) {
      errors.push({ path: `pipeline[${i}].outputs`, message: `phase "${phase.phase}" must produce outputs [${(want.outputs ?? []).join(', ')}] in v1` });
    }
  });
}

function checkPipeline(d, errors, { composition }) {
  const pipeline = d.pipeline;
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    errors.push({ path: 'pipeline', message: 'pipeline must be a non-empty array' });
    return;
  }
  const models = isPlainObject(d.models) ? d.models : {};
  const seen = new Set();
  const produced = new Set(['idea']);
  const requireRole = (value, field, i) => {
    if (!isNonEmptyString(value)) {
      errors.push({ path: `pipeline[${i}].${field}`, message: `${field} is required` });
    } else if (!isPlainObject(models[value])) {
      errors.push({ path: `pipeline[${i}].${field}`, message: `"${value}" has no entry in models` });
    }
  };

  pipeline.forEach((phase, i) => {
    const at = (field) => `pipeline[${i}].${field}`;
    if (!isPlainObject(phase)) {
      errors.push({ path: `pipeline[${i}]`, message: 'phase must be an object' });
      return;
    }
    const list = (field) => {
      const value = phase[field];
      if (value === undefined) return [];
      if (!Array.isArray(value)) {
        errors.push({ path: at(field), message: `${field} must be an array` });
        return [];
      }
      return value;
    };
    const inputs = list('inputs');
    const outputs = list('outputs');
    if (!isNonEmptyString(phase?.phase)) {
      errors.push({ path: at('phase'), message: 'phase id is required' });
    } else if (!PHASE_ID.test(phase.phase)) {
      errors.push({ path: at('phase'), message: `phase id "${phase.phase}" must be 1-24 letters, digits or hyphens, starting with a letter or digit` });
    } else if (seen.has(phase.phase)) {
      errors.push({ path: at('phase'), message: `duplicate phase id "${phase.phase}"` });
    } else {
      seen.add(phase.phase);
    }
    if (!PHASE_KINDS.includes(phase?.kind)) {
      errors.push({ path: at('kind'), message: `unknown kind "${phase?.kind}"` });
    }
    if (phase?.kind !== 'human') requireRole(phase?.role, 'role', i);
    for (const input of inputs) {
      if (!produced.has(input)) {
        errors.push({ path: at('inputs'), message: `input "${input}" is not produced by an earlier phase` });
      }
    }
    if (phase?.kind === 'review') {
      if (!isNonEmptyString(phase.target)) errors.push({ path: at('target'), message: 'review needs a target' });
      else if (!produced.has(phase.target)) errors.push({ path: at('target'), message: `target "${phase.target}" is not produced by an earlier phase` });
      requireRole(phase.author, 'author', i);
    }
    if (phase?.kind === 'per-task') {
      if (!inputs.includes('tasks')) errors.push({ path: at('inputs'), message: 'per-task needs "tasks" among its inputs' });
      else if (!produced.has('tasks')) errors.push({ path: at('inputs'), message: '"tasks" is not produced by an earlier phase' });
      if (phase.taskReview !== undefined) requireRole(phase.taskReview, 'taskReview', i);
    }
    if (phase?.maxRounds !== undefined && !isPositiveInt(phase.maxRounds)) {
      errors.push({ path: at('maxRounds'), message: 'maxRounds must be a positive integer' });
    }
    for (const output of outputs) produced.add(output);
  });

  const humans = pipeline.map((p, i) => [p, i]).filter(([p]) => p?.kind === 'human');
  if (humans.length !== 1 || humans[0][1] !== pipeline.length - 1) {
    errors.push({ path: 'pipeline', message: 'pipeline needs exactly one human phase, and it must be last' });
  }
  if (pipeline.some((p) => p?.kind === 'review' || p?.kind === 'per-task') && !isPlainObject(models.verifier)) {
    errors.push({ path: 'models.verifier', message: 'a verifier model is required when the pipeline has a review or per-task phase' });
  }
  const brainstorms = pipeline.map((p, i) => [p, i]).filter(([p]) => p?.kind === 'brainstorm');
  if (brainstorms.length > 0) {
    if (!isPlainObject(models[STAND_IN_ROLE])) {
      errors.push({ path: keyPath('models', STAND_IN_ROLE), message: 'a stand-in model is required when the pipeline has a brainstorm phase' });
    }
    if (brainstorms.length > 1 || brainstorms[0][1] !== 0) {
      errors.push({ path: 'pipeline', message: 'a brainstorm phase must be the first phase, and there can be only one' });
    }
  }
  if (composition) checkComposition(pipeline, errors);
}

function checkModels(d, errors, warnings) {
  if (!isPlainObject(d.models)) {
    errors.push({ path: 'models', message: 'models must be an object' });
    return;
  }
  for (const [role, entry] of Object.entries(d.models)) {
    const base = keyPath('models', role);
    if (!isPlainObject(entry)) {
      errors.push({ path: base, message: 'model entry must be an object' });
      continue;
    }
    if (entry.provider !== 'claude') errors.push({ path: `${base}.provider`, message: 'provider must be "claude" in v1' });
    if (!isNonEmptyString(entry.model)) {
      errors.push({ path: `${base}.model`, message: 'model is required' });
    } else if (costForUsage(entry.model, { input_tokens: 1, output_tokens: 1 }) === null) {
      warnings.push({ path: `${base}.model`, message: `"${entry.model}" is unpriced; budget falls back to tokens` });
    }
    if (!isPositiveInt(entry.maxTurns)) errors.push({ path: `${base}.maxTurns`, message: 'maxTurns must be a positive integer' });
    if (entry.effort !== undefined && !CLAUDE_EFFORTS.includes(entry.effort)) {
      errors.push({ path: `${base}.effort`, message: `effort must be one of ${CLAUDE_EFFORTS.join(', ')}` });
    }
    if (entry.alternate !== undefined && (!isNonEmptyString(entry.alternate) || entry.alternate === entry.model)) {
      errors.push({ path: `${base}.alternate`, message: 'alternate must be a non-empty string different from model' });
    }
  }
  if (!Array.isArray(d.routerModelAllowlist) || d.routerModelAllowlist.length === 0 || !d.routerModelAllowlist.every(isNonEmptyString)) {
    errors.push({ path: 'routerModelAllowlist', message: 'routerModelAllowlist must be a non-empty array of strings' });
  }
  if (!isPlainObject(d.models.router)) {
    errors.push({ path: 'models.router', message: 'a router model is required' });
  } else if (d.models.router.maxTurns !== 1) {
    errors.push({ path: 'models.router.maxTurns', message: 'router maxTurns must be 1' });
  }
  if (isPlainObject(d.models.router) && (!Array.isArray(d.routerModelAllowlist) || !d.routerModelAllowlist.includes(d.models.router.model))) {
    errors.push({ path: 'models.router.model', message: 'router model must be in routerModelAllowlist' });
  }
}

function checkScalars(d, errors) {
  if (!MODES.includes(d.mode)) errors.push({ path: 'mode', message: `mode must be one of ${MODES.join(', ')}` });
  if (!WORKER_PERMISSION_MODES.includes(d.workerPermissionMode)) {
    errors.push({ path: 'workerPermissionMode', message: `workerPermissionMode must be one of ${WORKER_PERMISSION_MODES.join(', ')}` });
  }
  for (const key of ['routerMaxInputTokens', 'routerMaxOutputTokens']) {
    if (!isPositiveInt(d[key])) errors.push({ path: key, message: `${key} must be a positive integer` });
  }
  if (isPositiveInt(d.routerMaxOutputTokens) && d.routerMaxOutputTokens > ROUTER_MAX_OUTPUT_TOKENS_CAP) {
    errors.push({ path: 'routerMaxOutputTokens', message: `routerMaxOutputTokens must be at most ${ROUTER_MAX_OUTPUT_TOKENS_CAP}` });
  }
  if (!isPositiveInt(d.maxConcurrentSessions)) errors.push({ path: 'maxConcurrentSessions', message: 'must be a positive integer' });
  if (typeof d.commitTests !== 'boolean') errors.push({ path: 'commitTests', message: 'commitTests must be a boolean' });
  if (!Array.isArray(d.testPaths) || d.testPaths.length === 0 || !d.testPaths.every(isNonEmptyString)) {
    errors.push({ path: 'testPaths', message: 'testPaths must be a non-empty array of glob strings' });
  }
  if (!isPlainObject(d.branchTemplates)) {
    errors.push({ path: 'branchTemplates', message: 'branchTemplates must be an object' });
  } else {
    for (const [key, value] of Object.entries(d.branchTemplates)) {
      if (!isNonEmptyString(value)) errors.push({ path: keyPath('branchTemplates', key), message: `${keyPath('branchTemplates', key)} must be a non-empty string` });
    }
  }
  if (!isPlainObject(d.limits)) {
    errors.push({ path: 'limits', message: 'limits must be an object' });
    return;
  }
  for (const [key, value] of Object.entries(d.limits)) {
    const p = `limits.${key}`;
    if (key === 'backoffMinutes') {
      if (!Array.isArray(value) || value.length === 0 || !value.every((n) => typeof n === 'number' && n > 0)) {
        errors.push({ path: p, message: 'backoffMinutes must be a non-empty array of positive numbers' });
      }
    } else if (key === 'brainstormTokens' && value === null) {
      // null means unlimited
    } else if (!isPositiveInt(value)) {
      errors.push({ path: p, message: 'must be a positive integer' });
    }
  }
}

function validate(d, { composition }) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(d)) return { errors: [{ path: '', message: 'config must be an object' }], warnings };
  checkPipeline(d, errors, { composition });
  checkModels(d, errors, warnings);
  checkScalars(d, errors);
  return { errors, warnings };
}

export function validateDefaults(d) {
  return validate(d, { composition: true });
}

export function validatePipeline(d) {
  return validate(d, { composition: false });
}

export function validateMilestoneFixture(d, name = 'milestone-1') {
  if (!Object.hasOwn(FIXTURES, name)) throw new Error(`unknown milestone fixture "${name}"`);
  return validate({ ...d, pipeline: FIXTURES[name] }, { composition: false });
}

// Case-insensitive like workflows.js's sameWorkflowId, which cannot be imported here (workflows.js imports this module).
export function templateFor(templates, workflowId) {
  if (typeof workflowId !== 'string' || !isPlainObject(templates)) return null;
  const key = Object.keys(templates).find((k) => k.toLowerCase() === workflowId.toLowerCase());
  return key === undefined ? null : templates[key];
}

function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return structuredClone(override);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : structuredClone(value);
  }
  return out;
}

const normalizePath = (p) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// The raw projects[<path>] entry, matched by normalised path; undefined when none matches.
export function findProjectEntry(fileConfig, projectPath) {
  if (!projectPath || !isPlainObject(fileConfig?.projects)) return undefined;
  const wanted = normalizePath(projectPath);
  const key = Object.keys(fileConfig.projects).find((k) => normalizePath(k) === wanted);
  return key === undefined ? undefined : fileConfig.projects[key];
}

// Workflow ids compare case-insensitively, so a later layer's `Feature` must replace an earlier `feature`.
function lowerTemplateKeys(layer) {
  if (!isPlainObject(layer) || !isPlainObject(layer.branchTemplates)) return layer;
  return { ...layer, branchTemplates: Object.fromEntries(Object.entries(layer.branchTemplates).map(([k, v]) => [k.toLowerCase(), v])) };
}

// `base` is the layer under config.json; a workflow's role models are merged into it first.
export function resolveProjectConfig(fileConfig, projectPath, base = defaultConfig()) {
  const merged = merge(lowerTemplateKeys(base), lowerTemplateKeys(fileConfig?.defaults ?? {}));
  const entry = findProjectEntry(fileConfig, projectPath);
  return entry === undefined ? merged : merge(merged, lowerTemplateKeys(entry));
}

// An engine role's model: defaultConfig() < defaults.models < projects[<path>].models,
// never a workflow file's roles, so it resolves even when the job's workflow file is gone.
export function resolveEngineModel(fileConfig, projectPath, role) {
  return resolveProjectConfig(fileConfig, projectPath).models[role] ?? null;
}

function configError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function createSuperagentConfig({
  filePath = path.join(defaultSuperagentRoot(), 'config.json'),
  home = defaultHome(),
  platform = process.platform,
} = {}) {
  let fileConfig = {};
  const corruptError = () => configError('ERR_CONFIG_CORRUPT', `${filePath} is not a valid superagent config - fix or remove it by hand`);

  return {
    async load() {
      const { value, corrupt } = await readJsonChecked(filePath, {});
      if (corrupt || !isPlainObject(value)) throw corruptError();
      fileConfig = value;
    },

    resolve(projectPath) {
      return resolveProjectConfig(fileConfig, projectPath);
    },

    // The loaded file before any merge: the workflow loader looks for a raw `pipeline` and `workflow`.
    raw() {
      return structuredClone(fileConfig);
    },

    userFolder() {
      return resolveUserFolder(fileConfig.userFolder, { home, platform });
    },

    checkUserFolder(value) {
      return resolveUserFolder(value, { home, platform });
    },

    async setUserFolder(value) {
      let trimmed = null;
      if (value !== null) {
        const r = resolveUserFolder(value, { home, platform });
        if (r.error) throw configError('ERR_INVALID_REQUEST', r.error);
        trimmed = r.configured;
      }
      try {
        await updateJson(filePath, (current) => {
          if (!isPlainObject(current)) throw corruptError();
          if (trimmed === null) delete current.userFolder;
          else current.userFolder = trimmed;
        });
      } catch (err) {
        if (err?.code) throw err;
        throw corruptError();
      }
      const { userFolder: _previous, ...rest } = fileConfig;
      fileConfig = trimmed === null ? rest : { ...rest, userFolder: trimmed };
    },

    async save(next) {
      const candidate = isPlainObject(next) ? next : {};
      const errors = validateDefaults(resolveProjectConfig(candidate, null)).errors.slice();
      if (candidate.userFolder !== undefined && candidate.userFolder !== null) {
        const message = validateUserFolder(candidate.userFolder, { home, platform });
        if (message) errors.push({ path: 'userFolder', message });
      }
      for (const project of Object.keys(isPlainObject(candidate.projects) ? candidate.projects : {})) {
        for (const e of validateDefaults(resolveProjectConfig(candidate, project)).errors) {
          errors.push({ path: `projects[${JSON.stringify(project)}].${e.path}`, message: e.message });
        }
      }
      if (errors.length > 0) {
        throw configError('ERR_INVALID_CONFIG', `superagent config is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { errors });
      }
      await writeJsonAtomic(filePath, candidate);
      fileConfig = structuredClone(candidate);
    },
  };
}
