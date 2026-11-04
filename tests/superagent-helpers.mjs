import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MILESTONE_1_PIPELINE, defaultConfig } from '../src/superagent/config.js';

export async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
