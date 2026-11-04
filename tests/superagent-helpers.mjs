import { execFileSync } from 'node:child_process';
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
