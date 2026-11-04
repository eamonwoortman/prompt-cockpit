// Superagent configuration: built-in defaults, global/per-project merge and
// pipeline contract validation.
//
// Spec: docs/superpowers/specs/2026-11-03-superagent-design.md, sections
// "Configuration" and "Phase contracts and validation"; Decision 13 (Claude is
// the only provider in v1); Decision 17 (superagent never writes a project's
// settings files - this module only touches its own config.json).
import os from 'node:os';
import path from 'node:path';
import { readJsonChecked, writeJsonAtomic } from '../json-store.js';
import { costForUsage } from '../usage.js';
import { CLAUDE_EFFORTS } from '../provider-registry.js';

export const PHASE_KINDS = ['author', 'review', 'per-task', 'human'];
export const WORKER_PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk'];
const MODES = ['automatic', 'manual'];

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
  freezePhase({ phase: 'plan-review', kind: 'review', role: 'plan-reviewer', author: 'planner', target: 'plan', maxRounds: 3 }),
  freezePhase({ phase: 'implement', kind: 'per-task', role: 'implementer', taskReview: 'task-reviewer', inputs: ['tasks'] }),
  freezePhase({ phase: 'test', kind: 'author', role: 'tester', inputs: ['spec', 'tasks'], outputs: ['testReport'] }),
  freezePhase({ phase: 'accept', kind: 'human', inputs: ['testReport'] }),
]);

export const FIXTURES = Object.freeze({ 'milestone-1': MILESTONE_1_PIPELINE, 'milestone-2': MILESTONE_2_PIPELINE });

export function defaultSuperagentRoot() {
  return path.join(process.env.COCKPIT_HOME || os.homedir(), '.prompt-cockpit', 'superagent');
}

const model = (name, maxTurns, extra = {}) => ({ provider: 'claude', model: name, maxTurns, ...extra });

export function defaultConfig() {
  return {
    mode: 'automatic',
    pipeline: [
      { phase: 'brainstorm', kind: 'author', role: 'brainstormer', inputs: ['idea'], outputs: ['brief'] },
      { phase: 'spec', kind: 'author', role: 'spec-writer', inputs: ['brief'], outputs: ['spec'] },
      { phase: 'spec-review', kind: 'review', role: 'spec-reviewer', author: 'spec-writer', target: 'spec', maxRounds: 3 },
      { phase: 'plan', kind: 'author', role: 'planner', inputs: ['spec'], outputs: ['plan', 'tasks'] },
      { phase: 'plan-review', kind: 'review', role: 'plan-reviewer', author: 'planner', target: 'plan', maxRounds: 3 },
      { phase: 'implement', kind: 'per-task', role: 'implementer', taskReview: 'task-reviewer', inputs: ['tasks'] },
      { phase: 'test', kind: 'author', role: 'tester', inputs: ['spec', 'tasks'], outputs: ['testReport'] },
      { phase: 'accept', kind: 'human', inputs: ['testReport'] },
    ],
    models: {
      router: model('claude-haiku-5-5', 1),
      'stand-in': model('claude-opus-5-5', 8),
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
      driftHandoffPct: 70,
      longCapNotifyHours: 12,
    },
    maxConcurrentSessions: 3,
    budget: { perJobUsd: null, perJobTokens: null },
    workerPermissionMode: 'auto',
    copyLocalClaudeSettings: true,
    additionalRepos: [],
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const keyPath = (base, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}['${key}']`);

const V1_NON_REVIEW = defaultConfig().pipeline.filter((p) => p.kind !== 'review');
const PHASE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/i;
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
  }
  if (!isPlainObject(d.models.router)) {
    errors.push({ path: 'models.router', message: 'a router model is required' });
  } else if (!Array.isArray(d.routerModelAllowlist) || !d.routerModelAllowlist.includes(d.models.router.model)) {
    errors.push({ path: 'models.router.model', message: 'router model must be in routerModelAllowlist' });
  }
}

function checkScalars(d, errors) {
  if (!MODES.includes(d.mode)) errors.push({ path: 'mode', message: `mode must be one of ${MODES.join(', ')}` });
  if (!WORKER_PERMISSION_MODES.includes(d.workerPermissionMode)) {
    errors.push({ path: 'workerPermissionMode', message: `workerPermissionMode must be one of ${WORKER_PERMISSION_MODES.join(', ')}` });
  }
  if (!isPositiveInt(d.maxConcurrentSessions)) errors.push({ path: 'maxConcurrentSessions', message: 'must be a positive integer' });
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

export function validateMilestoneFixture(d, name = 'milestone-1') {
  if (!Object.hasOwn(FIXTURES, name)) throw new Error(`unknown milestone fixture "${name}"`);
  return validate({ ...d, pipeline: FIXTURES[name] }, { composition: false });
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

export function resolveProjectConfig(fileConfig, projectPath) {
  const base = merge(defaultConfig(), fileConfig?.defaults ?? {});
  if (!projectPath || !isPlainObject(fileConfig?.projects)) return base;
  const wanted = normalizePath(projectPath);
  const key = Object.keys(fileConfig.projects).find((k) => normalizePath(k) === wanted);
  return key === undefined ? base : merge(base, fileConfig.projects[key]);
}

function configError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function createSuperagentConfig({ filePath = path.join(defaultSuperagentRoot(), 'config.json') } = {}) {
  let fileConfig = {};

  return {
    async load() {
      const { value, corrupt } = await readJsonChecked(filePath, {});
      if (corrupt || !isPlainObject(value)) {
        throw configError('ERR_CONFIG_CORRUPT', `${filePath} is not a valid superagent config - fix or remove it by hand`);
      }
      fileConfig = value;
    },

    resolve(projectPath) {
      return resolveProjectConfig(fileConfig, projectPath);
    },

    async save(next) {
      const candidate = isPlainObject(next) ? next : {};
      const errors = validateDefaults(resolveProjectConfig(candidate, null)).errors.slice();
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
