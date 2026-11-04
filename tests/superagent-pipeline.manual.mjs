// Superagent Plan 3: one real job through the milestone-2 fixture
// (spec -> spec-review -> plan -> plan-review -> implement -> test -> accept).
//
// NOT run by npm test and NOT run by the implementers of Plan 3. The controller runs it by hand after the final review:
//   node tests/superagent-pipeline.manual.mjs
// There is NO cost cap: only the 40-minute wall-clock deadline and the attempt limits bound spend (limits.attemptsPerPhase 2,
// limits.taskReviewRounds 1; models are the defaults from defaultConfig()).
// maxRounds for spec-review and plan-review is a field on the frozen MILESTONE_2_PIPELINE phases (src/superagent/config.js) and a
// fixture job uses that pipeline as is, so config.json cannot override it: this probe runs with the real default of 3 review rounds.
// Observes what unit tests (which use scripted workers) cannot:
//   (a) do real reviewers produce a parseable verdict/findings with the dispositions the validator wants;
//   (b) do real planners produce a valid tasks.json with ids of at most 12 characters;
//   (c) does the real implementer report the verify check;
//   (d) does `auto` mode let workers commit (earlier probe: canUseTool is skipped for Bash in auto);
//   (e) how long a full pipeline takes.
// Prints per-attempt purpose/round/role/outcome/summary (and the reason of every failed attempt), phase-completed and test-routed
// events, job state transitions, the final state and reason, the worktree `git log --oneline`, and which artifact paths exist.
// Uses a temp COCKPIT_HOME, operator file and toy repo; nothing under the real home is touched. Temp dirs are left behind on
// purpose (the SDK child can hold the cwd on Windows).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEADLINE_MS = 40 * 60_000;
const POLL_MS = 5_000;

const home = mkdtempSync(path.join(tmpdir(), 'superagent-pipeline-home-'));
process.env.COCKPIT_HOME = home;
process.env.COCKPIT_OPERATOR_FILE = path.join(home, 'operator-token');
process.env.COCKPIT_RUNTIME_FILE = path.join(home, 'runtime.json');

const realRegistry = await import('../src/session-registry.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { createSuperagentStore } = await import('../src/superagent/store.js');
const { createSuperagentConfig } = await import('../src/superagent/config.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const attached = new Set();

const fakeWs = {
  OPEN: 1,
  readyState: 1,
  send(raw) {
    const frame = JSON.parse(raw);
    if (frame.type !== 'sdk:message' || frame.message?.type !== 'assistant') return;
    for (const b of frame.message.message?.content ?? []) {
      if (b.type === 'tool_use') console.log(`TOOL_USE name=${b.name}`);
    }
  },
};
const attachNewRows = () => {
  for (const row of realRegistry.list()) {
    if (!attached.has(row.id)) { attached.add(row.id); realRegistry.attachClient(row.id, fakeWs, 0); }
  }
};

const clip = (s, n = 200) => (s == null ? '' : String(s).replace(/\s+/g, ' ').slice(0, n));
const printed = new Set();
let lastState = null;

function printNew(job) {
  const stamp = `${job.state}${job.reason ? `/${job.reason}` : ''}`;
  if (stamp !== lastState) { lastState = stamp; console.log(`STATE ${new Date().toISOString()} ${stamp}`); }
  for (const a of job.attempts) {
    if (a.outcome == null || printed.has(a.attemptId)) continue;
    printed.add(a.attemptId);
    console.log(`ATTEMPT phase=${a.phase} task=${a.task ?? '-'} purpose=${a.purpose} round=${a.round ?? '-'} role=${a.role} n=${a.n} outcome=${a.outcome} verdict=${a.verdict ?? '-'} verified=${JSON.stringify(a.verified)} summary=${clip(a.summary)}`);
    if (a.outcome !== 'done') console.log(`  FAILED REASON: ${a.reason ?? '(none recorded)'}`);
  }
}

function printEvents(jobId) {
  const eventsFile = path.join(jobsRoot, jobId, 'events.jsonl');
  console.log('\n=== phase-completed / test-routed events ===');
  if (!existsSync(eventsFile)) return;
  for (const line of readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)) {
    if (/"type":"(phase-completed|test-routed)"/.test(line)) console.log(line);
  }
}

function printArtifacts(job, worktree) {
  const { slug, createdDate } = job;
  const jobs = `docs/superpowers/jobs/${slug}`;
  const rels = [
    `docs/superpowers/specs/${createdDate}-${slug}-design.md`,
    `docs/superpowers/plans/${createdDate}-${slug}.md`,
    `${jobs}/tasks.json`,
    `${jobs}/test-report.md`,
  ];
  for (const phase of ['spec-review', 'plan-review']) {
    for (let r = 1; r <= 3; r++) rels.push(`${jobs}/reviews/${phase}-r${r}.md`, `${jobs}/reviews/${phase}-r${r}-response.md`);
    rels.push(`${jobs}/reviews/${phase}-verify.md`);
  }
  for (const t of job.tasks ?? []) {
    const id = t.id ?? t.taskId;
    rels.push(`${jobs}/tasks/${id}-report.md`, `${jobs}/tasks/${id}-review-r1.md`, `${jobs}/tasks/${id}-verify.md`);
  }
  console.log('\n=== artifacts (exists?) ===');
  for (const rel of rels) console.log(`${existsSync(path.join(worktree, rel)) ? 'EXISTS ' : 'missing'} ${rel}`);
}

async function main() {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.fsmonitor', 'false');
  git(repo, 'config', 'user.email', 'probe@example.com');
  git(repo, 'config', 'user.name', 'Probe');
  writeFileSync(path.join(repo, 'README.md'), '# toy\n');
  writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    projects: { [repo]: { limits: { attemptsPerPhase: 2, taskReviewRounds: 1 } } },
  }));
  const config = createSuperagentConfig({ filePath: configFile });
  await config.load();
  const store = createSuperagentStore({ rootDir: jobsRoot });
  sa = createSuperagent({ registry, store, config, worktreesRoot: path.join(home, 'superagent', 'worktrees') });

  console.log('home:', home, '\nrepo:', repo);
  const startedAt = Date.now();
  await sa.start();
  const created = await sa.createJob({
    title: 'Add a hello file',
    idea: 'Add a hello.txt containing the text hi at the repo root, verified by a node one-liner (for example node -e "process.exit(require(\'fs\').readFileSync(\'hello.txt\',\'utf8\').trim()===\'hi\'?0:1)").',
    primaryRepo: repo,
    fixture: 'milestone-2',
  });
  console.log('created job', created.jobId, 'state', created.state);

  const deadline = startedAt + DEADLINE_MS;
  let job = created;
  let deadlineHit = true;
  while (Date.now() < deadline) {
    await sa.tick();
    attachNewRows();
    job = sa.getJob(created.jobId);
    if (job) printNew(job);
    if (job?.state === 'needs-you' || job?.state === 'failed' || job?.state === 'done' || job?.state === 'stopped') { deadlineHit = false; break; }
    await sleep(POLL_MS);
  }
  attachNewRows();
  console.log(`\nfinal state: ${job?.state} reason: ${job?.reason ?? ''}${deadlineHit ? ' (DEADLINE HIT)' : ''}`);
  if (job?.detail) console.log('detail:', clip(JSON.stringify(job.detail), 1000));
  console.log(`elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s, attempts: ${job?.attempts?.length ?? 0}`);

  console.log('\n=== all attempts ===');
  for (const a of job?.attempts ?? []) {
    console.log(`phase=${a.phase} task=${a.task ?? '-'} purpose=${a.purpose} round=${a.round ?? '-'} role=${a.role} outcome=${a.outcome ?? 'running'} summary=${clip(a.summary)}${a.outcome && a.outcome !== 'done' ? ` REASON=${a.reason ?? ''}` : ''}`);
  }
  printEvents(created.jobId);

  const worktree = job?.repos?.[0]?.worktree;
  if (worktree && existsSync(worktree)) {
    console.log('\n=== worktree git log --oneline ===\n' + git(worktree, 'log', '--oneline'));
    printArtifacts(job, worktree);
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
