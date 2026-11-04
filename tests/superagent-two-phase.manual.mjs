// Superagent core, Plan 2: one real job through the two-phase milestone-1 fixture (author -> human).
//
// NOT run by npm test and NOT run by implementers of Plan 2. Run by hand only with the user's approval:
//   node tests/superagent-two-phase.manual.mjs
// Limits: 1 job, 1 phase, <= 3 attempts x maxTurns 20, one nudge each, 10-minute deadline.
// Estimated cost: about $0.50 (Sonnet 5.5) - treat as a FLOOR; Plan 1's probes cost 10-30x their header estimates.
// Observes what unit tests cannot:
//   (a) whether the SDK calls canUseTool for an ordinary tool (Bash) in permissionMode `auto` with
//       sdkOptions.interceptEveryPermission (src/session.js claims it skips canUseTool in auto; spike S1 saw it
//       only for AskUserQuestion) - printed as APPROVAL INTERCEPT lines; none for Bash means it was skipped;
//   (b) whether maxTurns counts per prompt or per session in streaming input, and the real error_max_turns
//       subtype - read the attempt-ended / attempt-nudged lines;
//   (c) whether a PreCompact firing reaches events.jsonl (precompact lines; may legitimately be absent).
// Uses a temp COCKPIT_HOME, operator file and toy repo; nothing under the real home is touched. Temp dirs are
// left behind on purpose (the SDK child can hold the cwd on Windows, S2).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEADLINE_MS = 10 * 60_000;
const POLL_MS = 5_000;

const home = mkdtempSync(path.join(tmpdir(), 'superagent-two-phase-home-'));
process.env.COCKPIT_HOME = home;
process.env.COCKPIT_OPERATOR_FILE = path.join(home, 'operator-token');
process.env.COCKPIT_RUNTIME_FILE = path.join(home, 'runtime.json');

const realRegistry = await import('../src/session-registry.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { createSuperagentStore } = await import('../src/superagent/store.js');
const { createSuperagentConfig } = await import('../src/superagent/config.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same registry, but every approval interceptor is wrapped so each request and decision is printed.
const registry = {
  ...realRegistry,
  addApprovalInterceptor(fn) {
    return realRegistry.addApprovalInterceptor((arg) => {
      const decision = fn(arg);
      console.log(`APPROVAL INTERCEPT tool=${arg?.request?.toolName} decision=${JSON.stringify(decision)}`);
      return decision;
    });
  },
};

const repo = path.join(home, 'toy');
const configFile = path.join(home, 'superagent', 'config.json');
const jobsRoot = path.join(home, 'superagent', 'jobs');
let sa = null;

async function main() {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'probe@example.com');
  git(repo, 'config', 'user.name', 'Probe');
  writeFileSync(path.join(repo, 'README.md'), '# toy\n');
  writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    projects: { [repo]: { models: { 'spec-writer': { provider: 'claude', model: 'claude-sonnet-5-5', maxTurns: 20 } } } },
  }));
  const config = createSuperagentConfig({ filePath: configFile });
  await config.load();
  const store = createSuperagentStore({ rootDir: jobsRoot });
  sa = createSuperagent({ registry, store, config, worktreesRoot: path.join(home, 'superagent', 'worktrees') });

  console.log('home:', home, '\nrepo:', repo);
  await sa.start();
  const created = await sa.createJob({
    title: 'Add a hello file',
    idea: 'Add hello.txt containing hi, with a one-paragraph design. Before writing the design, first run the shell command `echo probe` once and note what happened.',
    primaryRepo: repo,
    fixture: 'milestone-1',
  });
  console.log('created job', created.jobId, 'state', created.state);

  const deadline = Date.now() + DEADLINE_MS;
  let job = created;
  while (Date.now() < deadline) {
    await sa.tick();
    job = sa.getJob(created.jobId);
    if (job?.state === 'needs-you' || job?.state === 'failed') break;
    await sleep(POLL_MS);
  }
  console.log(`\nfinal state: ${job?.state} reason: ${job?.reason ?? ''}${Date.now() >= deadline ? ' (DEADLINE HIT)' : ''}`);

  const eventsFile = path.join(jobsRoot, created.jobId, 'events.jsonl');
  console.log('\n=== events.jsonl (attempt-* and precompact) ===');
  if (existsSync(eventsFile)) {
    for (const line of readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)) {
      if (/"type":"(attempt-[a-z]+|precompact)"/.test(line)) console.log(line);
    }
  }
  const worktree = job?.repos?.[0]?.worktree;
  if (worktree && existsSync(worktree)) {
    console.log('\n=== worktree git log --oneline ===\n' + git(worktree, 'log', '--oneline'));
  }
}

try {
  await main();
} finally {
  if (sa) await sa.stop().catch((err) => console.log('stop error:', err?.message ?? err));
  for (const row of realRegistry.list()) {
    try { realRegistry.closeSession(row.id); } catch (err) { console.log('close error:', err?.message ?? err); }
  }
  console.log('\ntemp dirs left in place under', home);
}
