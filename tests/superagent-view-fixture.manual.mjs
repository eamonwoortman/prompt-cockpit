// Superagent view, Plan 6 Task 11: seeds four jobs for hand-verifying the
// Superagent tab (public/superagent-view.js).
//
// NOT run by npm test. Run by hand, with Cockpit STOPPED on that home:
//   node tests/superagent-view-fixture.manual.mjs <cockpitHome> <repoDir>
// then start Cockpit with COCKPIT_HOME=<cockpitHome> (and COCKPIT_OPERATOR_FILE
// under it, never the real ~/.prompt-cockpit).
//
// <repoDir> is created and committed to if it is missing or empty; otherwise it
// must already be a git repo with a commit. Each job gets a real worktree under
// <cockpitHome>/.prompt-cockpit/superagent/worktrees, made by worktree.js's own
// createWorktree, and an event log written through the real store:
//   - needs-you / question   (HTML-looking, long, multi-line question; router decisions)
//   - needs-you / ready-to-try (brief, spec, plan, tasks, reviews and test report committed)
//   - needs-you / stuck      (attempt cap; router decisions)
//   - done                   (accepted)
// None of them is a state the supervisor resumes. That is PROVEN before the
// script exits, not assumed: it builds a real supervisor over the seeded store
// with a registry whose createSession records the call and throws, runs
// start() and a few tick()s, then stop()/dispose(), and exits non-zero if any
// session would have been created or any job's event log grew.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [homeArg, repoArg] = process.argv.slice(2);
if (!homeArg || !repoArg) {
  console.error('usage: node tests/superagent-view-fixture.manual.mjs <cockpitHome> <repoDir>');
  process.exit(2);
}
const home = path.resolve(homeArg);
const repo = path.resolve(repoArg);
if (home.toLowerCase() === os.homedir().toLowerCase()) {
  console.error('refusing to seed the real home directory - pass a temp dir as <cockpitHome>');
  process.exit(2);
}
process.env.COCKPIT_HOME = home;

const { defaultConfig, defaultSuperagentRoot, createSuperagentConfig } = await import('../src/superagent/config.js');
const { createSuperagentStore } = await import('../src/superagent/store.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { artifactPaths, reviewPaths } = await import('../src/superagent/results.js');
const { BRANCH_PREFIX, createWorktree, slugify } = await import('../src/superagent/worktree.js');
const { initRepo, jobCreated } = await import('./superagent-helpers.mjs');

const root = defaultSuperagentRoot();
const worktreesRoot = path.join(root, 'worktrees');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();

if (!existsSync(repo) || readdirSync(repo).length === 0) {
  await initRepo(repo);
  console.log(`initialised ${repo}`);
} else {
  git(repo, 'rev-parse', 'HEAD');
}

const store = createSuperagentStore({ rootDir: path.join(root, 'jobs') });
const defaults = defaultConfig();
const pipeline = defaults.pipeline;
const modelFor = (role) => defaults.models[role]?.model ?? 'claude-opus-5-5';
const routerModel = defaults.models.router.model;

function attemptEvents(a) {
  const startedEv = { type: 'attempt-started', attemptId: a.id, phase: a.phase, task: a.task ?? null, role: a.role, model: modelFor(a.role), n: a.n ?? 1, purpose: a.purpose, round: a.round ?? null };
  const events = [startedEv];
  if (a.sessionId) events.push({ type: 'attempt-session', attemptId: a.id, sessionId: a.sessionId });
  events.push({
    type: 'attempt-ended',
    attemptId: a.id,
    outcome: a.outcome ?? 'done',
    reason: a.reason ?? null,
    signature: a.signature ?? null,
    summary: a.summary ?? `${a.purpose} for ${a.phase}${a.task ? ` ${a.task}` : ''}`,
    question: a.question ?? null,
    verdict: a.verdict ?? null,
    questions: a.questions ?? null,
    tokens: 12_345,
  });
  return events;
}

const routerDecided = (forAttemptId, action, note, estimatedTokens) => ({
  type: 'router-decided', forAttemptId, action, note, ok: true, error: null, model: routerModel,
  request: { estimatedTokens, truncated: false }, usage: null, latencyMs: 1800,
});

// Provisions the worktree with createWorktree, commits `files` into it, then
// writes job-created, worktree-created, job-provisioned and `events`.
async function seedJob({ title, idea, files = () => ({}), events }) {
  const jobId = randomUUID();
  const slug = slugify(title, jobId);
  const branch = BRANCH_PREFIX + slug;
  const created = jobCreated({
    jobId, slug, title, idea, branch,
    createdDate: new Date().toISOString().slice(0, 10),
    repos: [{ id: 'primary', origin: repo }],
    pipeline,
    router: { allowlist: defaults.routerModelAllowlist, maxInputTokens: defaults.routerMaxInputTokens, maxOutputTokens: defaults.routerMaxOutputTokens },
    copyLocalClaudeSettings: false,
  });
  const made = await createWorktree({ origin: repo, worktree: path.join(worktreesRoot, slug, 'primary'), branch, copyLocalClaudeSettings: false });
  const job = { slug, createdDate: created.createdDate };
  const writes = files(job);
  if (Object.keys(writes).length) {
    for (const [rel, text] of Object.entries(writes)) {
      const file = path.join(made.worktree, ...rel.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }
    git(made.worktree, 'add', '--', ...Object.keys(writes));
    git(made.worktree, '-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-q', '-m', `fixture: ${title}`);
  }
  await store.append(jobId, created);
  await store.append(jobId, { type: 'worktree-created', repo: 'primary', worktree: made.worktree, branch: made.branch, baseSha: made.baseSha, settingsCopy: made.settingsCopy });
  await store.append(jobId, { type: 'job-provisioned' });
  for (const ev of events) await store.append(jobId, ev);
  return jobId;
}

const brainstormDone = () => attemptEvents({ id: randomUUID(), phase: 'brainstorm', role: 'brainstormer', purpose: 'ask', questions: [] });

const QUESTION = [
  '<img src=x onerror="alert(\'xss\')"> Should the session expire after 30 minutes of inactivity, or after 8 hours regardless of activity, and should "remember me" extend it?',
  '',
  'The spec has to pick one. Today the app keeps a session forever.',
  '<script>alert("still text")</script>',
].join('\n');

// A finished pipeline up to the human accept phase, with every artifact committed.
function finishedPipeline() {
  const t = (id, title) => ({ id, title, repos: ['primary'], dependsOn: [], acceptance: 'it works', verify: '', origin: 'plan', fromAttemptId: null });
  const tasks = [t('t1', 'Parse rows'), t('t2', 'Write the export')];
  const events = [
    ...brainstormDone(),
    ...attemptEvents({ id: randomUUID(), phase: 'spec', role: 'spec-writer', purpose: 'author' }),
    ...attemptEvents({ id: randomUUID(), phase: 'spec-review', role: 'spec-reviewer', purpose: 'review', round: 1, verdict: 'approve' }),
    { type: 'phase-completed', phase: 'spec-review', visit: 1, unresolved: [], verification: null },
    ...attemptEvents({ id: randomUUID(), phase: 'plan', role: 'planner', purpose: 'author' }),
    ...attemptEvents({ id: randomUUID(), phase: 'plan-review', role: 'plan-reviewer', purpose: 'review', round: 1, verdict: 'approve' }),
    { type: 'phase-completed', phase: 'plan-review', visit: 1, unresolved: [], verification: null },
    { type: 'tasks-loaded', tasks },
  ];
  for (const task of tasks) {
    events.push(...attemptEvents({ id: randomUUID(), phase: 'implement', task: task.id, role: 'implementer', purpose: 'implement' }));
    events.push(...attemptEvents({ id: randomUUID(), phase: 'implement', task: task.id, role: 'task-reviewer', purpose: 'task-review', round: 1, verdict: 'approve' }));
  }
  events.push(
    { type: 'phase-completed', phase: 'implement', visit: 1, unresolved: [], verification: null },
    ...attemptEvents({ id: randomUUID(), phase: 'test', role: 'tester', purpose: 'test' }),
    { type: 'needs-you', reason: 'ready-to-try', detail: { phase: 'accept' } },
  );
  const files = (job) => {
    const p = artifactPaths(job);
    return {
      [p.brief]: '# Brief\n\nExport the table as CSV with a header row.\n\n## Assumptions made for you\n\n- Commas inside a cell are quoted, not escaped.\n- The export uses UTF-8 with no BOM.\n\n## Your answers\n\nNone.\n',
      [p.spec]: '# Spec\n\nCSV export.\n',
      [p.plan]: '# Plan\n\n1. Parse rows\n2. Write the export\n',
      [p.tasks]: `${JSON.stringify({ tasks }, null, 2)}\n`,
      [p.testReport]: '# Test report\n\n- `npm test`: 42 passing\n- Exported a 3-row table; opened it in a spreadsheet: OK\n',
      [reviewPaths(job, { phase: 'spec-review', round: 1 }).review]: '# Spec review r1\n\nApprove.\n',
      [reviewPaths(job, { phase: 'plan-review', round: 1 }).review]: '# Plan review r1\n\nApprove.\n',
      ...Object.fromEntries(tasks.flatMap((task) => [
        [reviewPaths(job, { taskId: task.id }).report, `# ${task.id} report\n\nDone.\n`],
        [reviewPaths(job, { taskId: task.id, round: 1 }).taskReview, `# ${task.id} review r1\n\nApprove.\n`],
      ])),
    };
  };
  return { events, files };
}

const questionSpec1 = randomUUID();
const questionSpec2 = randomUUID();
const stuckIds = [randomUUID(), randomUUID(), randomUUID()];
const ready = finishedPipeline();
const done = finishedPipeline();

const seeded = [];
seeded.push(await seedJob({
  title: 'Add login page',
  idea: 'Add a login page with a session that expires.',
  events: [
    ...brainstormDone(),
    ...attemptEvents({ id: questionSpec1, phase: 'spec', role: 'spec-writer', purpose: 'author', n: 1, outcome: 'failed', reason: 'no-result', signature: 'no-result' }),
    routerDecided(questionSpec1, 'retry', 'The worker ended without a result; one more try.', 1834),
    ...attemptEvents({ id: questionSpec2, phase: 'spec', role: 'spec-writer', purpose: 'author', n: 2, outcome: 'question', question: QUESTION, sessionId: randomUUID() }),
    { type: 'needs-you', reason: 'question', detail: { attemptId: questionSpec2, question: QUESTION } },
  ],
}));
seeded.push(await seedJob({ title: 'Fix CSV export', idea: 'The CSV export drops the header row.', ...ready }));
seeded.push(await seedJob({
  title: 'Rename settings',
  idea: 'Rename the "prefs" settings key to "settings".',
  events: [
    ...brainstormDone(),
    ...stuckIds.flatMap((id, i) => attemptEvents({ id, phase: 'spec', role: 'spec-writer', purpose: 'author', n: i + 1, outcome: 'failed', reason: 'no-result', signature: 'no-result' })),
    routerDecided(stuckIds[0], 'retry', 'Transient: retry once.', 1702),
    routerDecided(stuckIds[1], 'retry-alternate', 'Same failure twice; try the alternate model.', 2210),
    { type: 'needs-you', reason: 'stuck', detail: { phase: 'spec', task: null, why: 'attempt-cap', lastReason: 'no-result', signature: 'no-result' } },
  ],
}));
seeded.push(await seedJob({ title: 'Update README badge', idea: 'Point the build badge at the new CI.', files: done.files, events: [...done.events, { type: 'job-accepted' }] }));

const before = new Map();
for (const jobId of seeded) {
  const job = await store.load(jobId);
  before.set(jobId, job.lastSeq);
  console.log(`seeded ${job.state}${job.reason ? `/${job.reason}` : ''}  ${job.title}  ${jobId}`);
}

// --- No-launch proof (controller ruling T11-1) ---
const launches = [];
const refuse = (what) => () => { throw new Error(`fixture: ${what} refused - a seeded job must launch nothing`); };
const registry = {
  createSession(opts) {
    launches.push({ cwd: opts?.cwd, name: opts?.name });
    throw new Error('fixture: createSession refused - a seeded job must launch nothing');
  },
  get: () => undefined,
  sendInput: refuse('sendInput'),
  closeSession: () => {},
  addApprovalInterceptor: () => () => {},
  addSessionRemovedListener: () => () => {},
};
// A guard that throws proves nothing, so a crash anywhere in it fails the
// check loudly instead of leaving a bare stack trace.
const grown = [];
let crashed = null;
try {
  const config = createSuperagentConfig({ filePath: path.join(root, 'config.json') });
  await config.load();
  const guardStore = createSuperagentStore({ rootDir: path.join(root, 'jobs') });
  const supervisor = createSuperagent({ registry, store: guardStore, config, worktreesRoot, logImpl: (line) => console.log(`[supervisor] ${line}`) });
  try {
    await supervisor.start();
    for (let i = 0; i < 3; i++) await supervisor.tick();
  } finally {
    await supervisor.stop();
    supervisor.dispose();
  }
  for (const jobId of seeded) {
    const job = await createSuperagentStore({ rootDir: path.join(root, 'jobs') }).load(jobId);
    if (job.lastSeq !== before.get(jobId)) grown.push(`${job.title}: seq ${before.get(jobId)} -> ${job.lastSeq}`);
  }
} catch (err) {
  crashed = err;
}
if (crashed || launches.length || grown.length) {
  console.error('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('!!! NO-LAUNCH CHECK FAILED - DO NOT START COCKPIT ON THIS HOME !!!');
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  for (const l of launches) console.error(`createSession called: ${JSON.stringify(l)}`);
  for (const g of grown) console.error(`event log grew: ${g}`);
  if (crashed) console.error(`the check itself crashed: ${crashed?.stack || crashed}`);
  console.error('Change the seed, not the guard.');
  process.exit(1);
}
console.log(`\nNO-LAUNCH CHECK PASSED: start() + 3 tick()s + stop() over ${seeded.length} seeded jobs, createSession calls: 0, event logs unchanged.`);
console.log(`Start Cockpit with COCKPIT_HOME=${home}`);
