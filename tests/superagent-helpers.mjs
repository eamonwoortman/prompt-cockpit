import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MILESTONE_1_PIPELINE, defaultConfig } from '../src/superagent/config.js';

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
