// Superagent view, Plan 6 Task 11 and Plan 7 Task 9: seeds six jobs and one
// invalid global workflow file for hand-verifying the Superagent tab
// (public/superagent-view.js).
//
// NOT run by npm test. Run by hand, with Cockpit STOPPED on that home:
//   node tests/superagent-view-fixture.manual.mjs <cockpitHome> <repoDir>
// then start Cockpit with COCKPIT_HOME=<cockpitHome> (and COCKPIT_OPERATOR_FILE
// under it, never the real ~/.prompt-cockpit).
//
// <repoDir> is created and committed to if it is missing or empty; otherwise it
// must already be a git repo with a commit. Each worktree job gets a real
// worktree under <cockpitHome>/.prompt-cockpit/superagent/worktrees, made by
// worktree.js's own createWorktree, and an event log written through the real
// store:
//   - needs-you / question   (HTML-looking, long, multi-line question; router decisions)
//   - needs-you / ready-to-try (brief, spec, plan, tasks, reviews and test report committed)
//   - needs-you / stuck      (attempt cap; router decisions)
//   - done                   (accepted)
//   - needs-you / ready-to-try, Troubleshooting workflow (diagnosis, tasks,
//     reviews and test report committed; no brief)
// plus one in-place Feature job on <repoDir>-inplace (created like <repoDir>),
// paused at needs-you / folder-changed: its superagent/<slug> branch exists but
// the folder is left on its own branch, so the real in-place gate fails on
// every heartbeat. Its first brainstorm attempt and its spec attempt were
// ended by that gate (paused before launch), with a folder-restored between.
// The invalid workflow file is <superagent root>/workflows/broken.json.
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
const { checkGate, folderChangedEvent } = await import('../src/superagent/inplace.js');
const { resolveWorkflowModels, substituteArtifacts, workflowsDir } = await import('../src/superagent/workflows.js');
const { createSuperagentStore, deriveJob } = await import('../src/superagent/store.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { artifactPaths, reviewPaths } = await import('../src/superagent/results.js');
const { BRANCH_PREFIX, createWorktree, slugify } = await import('../src/superagent/worktree.js');
const { initRepo, jobCreated } = await import('./superagent-helpers.mjs');

const root = defaultSuperagentRoot();
const worktreesRoot = path.join(root, 'worktrees');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();

async function ensureRepo(dir) {
  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    await initRepo(dir);
    console.log(`initialised ${dir}`);
  } else {
    git(dir, 'rev-parse', 'HEAD');
  }
}
await ensureRepo(repo);
const inPlaceRepo = `${repo}-inplace`;
await ensureRepo(inPlaceRepo);

const store = createSuperagentStore({ rootDir: path.join(root, 'jobs') });
const defaults = defaultConfig();
const pipeline = defaults.pipeline;
const routerModel = defaults.models.router.model;

// A built-in workflow as createJob records it (Plan 7): pipeline, workflow,
// artifacts, prompts and models.
async function builtinWorkflow(id, slug, createdDate) {
  const file = path.join(workflowsDir(), `${id}.json`);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  const roles = [...new Set(doc.phases.flatMap((p) => [p.role, p.taskReview].filter(Boolean)))];
  return {
    pipeline: doc.phases,
    workflow: { id: doc.id, name: doc.name, source: 'built-in', file },
    artifacts: substituteArtifacts(doc.artifacts, { slug, date: createdDate }),
    prompts: Object.fromEntries(roles.map((role) => [role, null])),
    models: resolveWorkflowModels(doc, {}, repo),
  };
}

function attemptEvents(a, models = defaults.models) {
  const startedEv = { type: 'attempt-started', attemptId: a.id, phase: a.phase, task: a.task ?? null, role: a.role, model: models[a.role]?.model ?? 'claude-opus-5-5', n: a.n ?? 1, purpose: a.purpose, round: a.round ?? null };
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
    tokens: a.tokens === undefined ? 12_345 : a.tokens,
  });
  return events;
}

const routerDecided = (forAttemptId, action, note, estimatedTokens) => ({
  type: 'router-decided', forAttemptId, action, note, ok: true, error: null, model: routerModel,
  request: { estimatedTokens, truncated: false }, usage: null, latencyMs: 1800,
});

// Provisions the worktree with createWorktree, commits `files` into it, then
// writes job-created, worktree-created, job-provisioned and `events`.
// `workflowId` records a built-in workflow; `events` may then be a function of
// its models.
async function seedJob({ title, idea, files = () => ({}), events, workflowId = null }) {
  const jobId = randomUUID();
  const slug = slugify(title, jobId);
  const branch = BRANCH_PREFIX + slug;
  const createdDate = new Date().toISOString().slice(0, 10);
  const recorded = workflowId ? await builtinWorkflow(workflowId, slug, createdDate) : { pipeline };
  const created = jobCreated({
    jobId, slug, title, idea, branch, createdDate,
    repos: [{ id: 'primary', origin: repo }],
    ...recorded,
    router: { allowlist: defaults.routerModelAllowlist, maxInputTokens: defaults.routerMaxInputTokens, maxOutputTokens: defaults.routerMaxOutputTokens },
    copyLocalClaudeSettings: false,
  });
  const made = await createWorktree({ origin: repo, worktree: path.join(worktreesRoot, slug, 'primary'), branch, copyLocalClaudeSettings: false });
  const job = deriveJob([created]);
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
  for (const ev of typeof events === 'function' ? events(recorded.models) : events) await store.append(jobId, ev);
  return jobId;
}

// In place, as createJob + provisionInPlace would record it, except that the
// folder is NOT switched: superagent/<slug> is only created, so the folder
// stays on its own branch and the real gate's text is what the job shows.
async function seedInPlaceJob({ title, idea }) {
  const jobId = randomUUID();
  const slug = slugify(title, jobId);
  const branch = BRANCH_PREFIX + slug;
  const createdDate = new Date().toISOString().slice(0, 10);
  const recorded = await builtinWorkflow('feature', slug, createdDate);
  const head = git(inPlaceRepo, 'rev-parse', 'HEAD');
  git(inPlaceRepo, 'branch', branch);
  const created = jobCreated({
    jobId, slug, title, idea, branch, createdDate,
    repos: [{ id: 'primary', origin: inPlaceRepo, toplevel: inPlaceRepo, inPlace: true, admittedHead: head }],
    ...recorded,
    router: { allowlist: defaults.routerModelAllowlist, maxInputTokens: defaults.routerMaxInputTokens, maxOutputTokens: defaults.routerMaxOutputTokens },
    copyLocalClaudeSettings: false,
  });
  const check = await checkGate({ folder: inPlaceRepo, branch, baseSha: head });
  if (check.ok) throw new Error(`fixture: ${inPlaceRepo} passes the in-place gate; it must stay off ${branch}`);
  const paused = folderChangedEvent({ text: check.text, folder: inPlaceRepo });
  const gated = (phase, role, purpose) => attemptEvents({ id: randomUUID(), phase, role, purpose, outcome: 'failed', reason: 'folder-changed', summary: null, tokens: null }, recorded.models);
  const events = [
    created,
    { type: 'worktree-created', repo: 'primary', worktree: inPlaceRepo, branch, baseSha: head, settingsCopy: 'in-place', inPlace: true },
    { type: 'job-provisioned' },
    ...gated('brainstorm', 'brainstormer', 'ask'),
    paused,
    { type: 'folder-restored' },
    ...attemptEvents({ id: randomUUID(), phase: 'brainstorm', role: 'brainstormer', purpose: 'ask', questions: [], sessionId: randomUUID() }, recorded.models),
    ...gated('spec', 'spec-writer', 'author'),
    paused,
  ];
  for (const ev of events) await store.append(jobId, ev);
  return jobId;
}

// One invalid global workflow file, for the New job form's Workflow select.
const globalWorkflows = path.join(root, 'workflows');
await fs.mkdir(globalWorkflows, { recursive: true });
const brokenWorkflow = {
  format: 1,
  id: 'broken',
  name: 'Broken (seeded)',
  description: 'A seeded invalid global workflow.',
  artifacts: { notes: 'docs/notes.md' },
  phases: [
    { phase: 'write', kind: 'author', role: 'spec-writer', inputs: ['idea'], outputs: ['missing'] },
    { phase: 'accept', kind: 'human', inputs: ['notes'] },
  ],
};
await fs.writeFile(path.join(globalWorkflows, 'broken.json'), `${JSON.stringify(brokenWorkflow, null, 2)}\n`);

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

// The Troubleshooting pipeline up to its accept phase, every artifact committed.
function troubleshootingPipeline() {
  const tasks = [{ id: 't1', title: 'Guard the empty header', repos: ['primary'], dependsOn: [], acceptance: 'a failing test now passes', verify: '', origin: 'plan', fromAttemptId: null }];
  const events = (models) => [
    ...attemptEvents({ id: randomUUID(), phase: 'investigate', role: 'investigator', purpose: 'author' }, models),
    ...attemptEvents({ id: randomUUID(), phase: 'diagnosis-review', role: 'diagnosis-reviewer', purpose: 'review', round: 1, verdict: 'approve' }, models),
    { type: 'phase-completed', phase: 'diagnosis-review', visit: 1, unresolved: [], verification: null },
    { type: 'tasks-loaded', tasks },
    ...attemptEvents({ id: randomUUID(), phase: 'fix', task: 't1', role: 'fixer', purpose: 'implement' }, models),
    ...attemptEvents({ id: randomUUID(), phase: 'fix', task: 't1', role: 'fix-reviewer', purpose: 'task-review', round: 1, verdict: 'approve' }, models),
    { type: 'phase-completed', phase: 'fix', visit: 1, unresolved: [], verification: null },
    ...attemptEvents({ id: randomUUID(), phase: 'verify', role: 'verifier-tester', purpose: 'test' }, models),
    { type: 'needs-you', reason: 'ready-to-try', detail: { phase: 'accept' } },
  ];
  const files = (job) => {
    const p = artifactPaths(job);
    return {
      [p.diagnosis]: '# Diagnosis\n\nThe export skips row 0 when the header cell is empty.\n',
      [p.tasks]: `${JSON.stringify({ tasks }, null, 2)}\n`,
      [p.testReport]: '# Test report (troubleshooting)\n\n- Reproduced: the header row was missing before the fix\n- `npm test`: 43 passing, including the new failing-first test\n',
      [reviewPaths(job, { phase: 'diagnosis-review', round: 1 }).review]: '# Diagnosis review r1\n\nApprove.\n',
      [reviewPaths(job, { taskId: 't1' }).report]: '# t1 report\n\nFixed.\n',
      [reviewPaths(job, { taskId: 't1', round: 1 }).taskReview]: '# t1 review r1\n\nApprove.\n',
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
seeded.push(await seedJob({ title: 'Header row missing in export', idea: 'The CSV export loses its header row when the first cell is empty.', workflowId: 'troubleshooting', ...troubleshootingPipeline() }));
seeded.push(await seedInPlaceJob({ title: 'Add dark mode', idea: 'Add a dark mode toggle to the settings page.' }));

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
