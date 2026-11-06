import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MILESTONE_1_PIPELINE, defaultConfig } from '../src/superagent/config.js';
import { fakeStartSession } from './test-helpers.mjs';

export const T0 = 1_000_000;
export const MIN = 60_000;

export async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function initRepo(dir, { ignoreLocalSettings = true } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  await fs.mkdir(dir, { recursive: true });
  git('init', '-q');
  // A machine-wide core.fsmonitor=true starts a daemon per repo that outlives
  // the test; worktrees share this setting.
  git('config', 'core.fsmonitor', 'false');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  if (ignoreLocalSettings) await fs.writeFile(path.join(dir, '.gitignore'), '.claude/settings.local.json\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return git('rev-parse', 'HEAD');
}

export function jobCreated(over = {}) {
  const { models, limits } = defaultConfig();
  return {
    type: 'job-created',
    jobId: 'j1',
    slug: 'add-hello',
    title: 'Add hello',
    idea: 'Add a hello file.',
    mode: 'automatic',
    branch: 'superagent/add-hello',
    createdDate: '2026-11-04',
    repos: [{ id: 'primary', origin: '/repo' }],
    pipeline: MILESTONE_1_PIPELINE,
    models,
    limits,
    workerPermissionMode: 'auto',
    copyLocalClaudeSettings: true,
    ...over,
  };
}

export function provisionedEvents(over = {}) {
  const created = jobCreated(over);
  return [
    created,
    ...created.repos.map((repo) => ({
      type: 'worktree-created',
      repo: repo.id,
      worktree: path.join(os.tmpdir(), 'sa-worktrees', created.jobId, repo.id),
      branch: created.branch,
      baseSha: 'base',
      settingsCopy: null,
    })),
    { type: 'job-provisioned' },
  ];
}

// The real registry module with only createSession overridden: each call gets
// a fresh fakeStartSession (one instance keeps only its last callbacks).
export function sessionFactory(registryModule) {
  const impls = new Map();
  const calls = [];
  let failNext = null;
  const registry = {
    ...registryModule,
    createSession(opts) {
      calls.push(opts);
      const impl = fakeStartSession();
      let start = impl;
      if (failNext) {
        const err = failNext;
        failNext = null;
        start = () => { throw err; };
      }
      const row = registryModule.createSession({ ...opts, startSessionImpl: start });
      impls.set(row.id, impl);
      return row;
    },
  };
  return { registry, impls, calls, failNextCreate(err) { failNext = err; } };
}

export async function liveJob(store, { repos = [{ id: 'primary', origin: '/repo' }], ...over } = {}) {
  const events = provisionedEvents({ repos, ...over });
  const jobId = events[0].jobId;
  const root = await tempDir('sa-live-');
  for (const ev of events) {
    if (ev.type === 'worktree-created') {
      const worktree = path.join(root, ev.repo);
      await fs.mkdir(worktree, { recursive: true });
      await store.append(jobId, { ...ev, worktree, baseSha: 'base' });
    } else {
      await store.append(jobId, ev);
    }
  }
  return store.get(jobId);
}

export function launchAction(over = {}) {
  return {
    type: 'launch',
    phase: 'spec',
    task: null,
    role: 'spec-writer',
    model: 'claude-opus-5-5',
    effort: null,
    maxTurns: 60,
    n: 1,
    recovery: false,
    previousAttemptId: null,
    ...over,
  };
}

export function ids(prefix = 'a') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const taskCreated = (id, over = {}) => ({
  id,
  title: `Task ${id}`,
  repos: ['primary'],
  dependsOn: [],
  acceptance: 'it works',
  verify: '',
  origin: 'plan',
  fromAttemptId: null,
  ...over,
});

export const ev = {
  tasksLoaded: (tasks) => ({ type: 'tasks-loaded', tasks }),
  testRouted: (attemptId, task) => ({ type: 'test-routed', attemptId, task }),
  phaseCompleted: (phase, visit, unresolved = []) => ({ type: 'phase-completed', phase, visit, unresolved, verification: null }),
};

const CARD_HEADING = '# Superagent job card';
// A handler returning HOLD leaves the turn running with no result.json.
export const HOLD = Symbol('hold');

export function parseCard(text) {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!text.startsWith(CARD_HEADING) || !match) throw new Error('scriptedWorker: not a job card');
  return JSON.parse(match[1]);
}

// A fake worker behind sessionFactory's registry: the first sendInput of a
// session is the job card; handlers[`${phaseId}:${purpose}`] (or
// handlers[purpose]) returns the result body without identity fields, which
// is published as result.json via result.json.tmp + rename before the turn
// ends (a read-only card, `resultVia: 'final-message'`, gets it as the result
// message's text instead). Handler context:
// - commit(files, message, repoId = 'primary') writes { relPath: text } into
//   that repo's worktree, commits them on the job branch, returns the sha;
// - publish(fields, { content, files }) writes every card output (content by
//   output key overrides the default text) plus `files`, commits them, and
//   returns a done body whose evidence lists that commit (and the task's
//   verify command as a passing check).
// Nudges (any later sendInput) are left unanswered.
export function scriptedWorker({ factory, handlers }) {
  const log = [];
  const errors = [];
  const original = factory.registry.sendInput;

  function commit(card, files, message, repoId = 'primary') {
    const repo = card.repos.find((r) => r.id === repoId);
    if (!repo) throw new Error(`scriptedWorker: no repo ${repoId} on the card`);
    const git = (...args) => execFileSync('git', args, { cwd: repo.worktree, encoding: 'utf8', timeout: 60_000 }).trim();
    const rels = Object.keys(files);
    for (const rel of rels) {
      const file = path.join(repo.worktree, ...rel.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, files[rel]);
    }
    git('add', '--', ...rels);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  }

  function publish(card, fields = {}, { content = {}, files = {} } = {}) {
    const writes = {};
    for (const [key, rel] of Object.entries(card.outputs ?? {})) {
      writes[rel] = content[key] ?? `# ${card.phaseId} ${card.purpose} ${card.attemptId}\n`;
    }
    Object.assign(writes, files);
    const sha = commit(card, writes, `${card.phaseId} ${card.purpose}${card.taskId ? ` ${card.taskId}` : ''}`);
    const verify = card.task?.verify?.trim();
    return {
      status: 'done',
      artifacts: Object.values(card.outputs ?? {}),
      summary: `${card.purpose} for ${card.phaseId}${card.taskId ? ` ${card.taskId}` : ''}`,
      question: null,
      evidence: { commits: [{ repo: 'primary', sha }], ...(verify ? { checks: [{ cmd: verify, exit: 0 }] } : {}) },
      ...fields,
    };
  }

  async function writeResult(card, body) {
    const result = { ...body, jobId: card.jobId, phaseId: card.phaseId, taskId: card.taskId, attemptId: card.attemptId };
    const tmp = path.join(card.attemptDir, 'result.json.tmp');
    await fs.mkdir(card.attemptDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(result, null, 2));
    await fs.rename(tmp, path.join(card.attemptDir, 'result.json'));
  }

  factory.registry.sendInput = async (id, text) => {
    await original(id, text);
    if (!String(text).startsWith(CARD_HEADING)) return;
    const card = parseCard(text);
    const entry = { card, body: null };
    log.push(entry);
    try {
      const handler = handlers[`${card.phaseId}:${card.purpose}`] ?? handlers[card.purpose];
      if (!handler) throw new Error(`scriptedWorker: no handler for ${card.phaseId}:${card.purpose}`);
      const body = await handler({
        card,
        commit: (files, message, repoId) => commit(card, files, message, repoId),
        publish: (fields, opts) => publish(card, fields, opts),
      });
      if (body === HOLD) return;
      entry.body = body;
      if (card.resultVia !== 'final-message') await writeResult(card, body);
    } catch (err) {
      errors.push(err);
      throw err;
    }
    const impl = factory.impls.get(id);
    impl.emitMessage({ type: 'result', subtype: 'success', ...(card.resultVia === 'final-message' ? { result: JSON.stringify(entry.body) } : {}) });
    impl.emitState('idle');
  };

  return { log, errors, cards: () => log.map((e) => e.card) };
}
