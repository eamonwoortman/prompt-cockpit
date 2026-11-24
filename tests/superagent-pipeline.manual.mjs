// Superagent Plan 3: one real job through the milestone-2 fixture
// (spec -> spec-review -> plan -> plan-review -> implement -> test -> accept).
//
// NOT run by npm test and NOT run by the implementers of Plan 3. The controller runs it by hand after the final review:
//   node tests/superagent-pipeline.manual.mjs
// There is NO cost cap: only the 40-minute wall-clock deadline and the attempt limits bound spend (limits.attemptsPerPhase 2,
// limits.taskReviewRounds 1). Models: the installed SDK's bundled Claude Code (2.1.231) rejects claude-opus-5-5 with an API 400
// ("version 2.1.280 or newer is required"), so by default this probe runs every role whose default is claude-opus-5-5 (spec-writer,
// planner, spec-reviewer, plan-reviewer, verifier, brainstormer, stand-in) on claude-sonnet-5-5 via a projects[<repo>].models override
// (provider and maxTurns are kept; the router stays claude-haiku-5-5). Implementer, tester and task-reviewer are Sonnet 5.5 already, so
// every worker is Sonnet 5.5. Set PROBE_KEEP_MODELS=1 to skip the override. Worst case is 3 review rounds per review phase
// (maxRounds is frozen at 3 in the fixture), each possibly followed by a fix and a verifier attempt.
// maxRounds for spec-review and plan-review is a field on the frozen MILESTONE_2_PIPELINE phases (src/superagent/config.js) and a
// fixture job uses that pipeline as is, so config.json cannot override it: this probe runs with the real default of 3 review rounds.
// Observes what unit tests (which use scripted workers) cannot:
//   (a) do real reviewers produce a parseable verdict/findings with the dispositions the validator wants;
//   (b) do real planners produce a valid tasks.json with ids of at most 12 characters;
//   (c) does the real implementer report the verify check;
//   (d) does `auto` mode let workers commit (earlier probe: canUseTool is skipped for Bash in auto);
//   (e) how long a full pipeline takes.
// Plan 4: the real isolated router is injected (createRouter()), so failed attempts are routed; each router-decided is printed with
// its action, note, request.estimatedTokens, usage.requestInputTokens (the router's own request, result.usage), usage.totalInputTokens and
// usage.costUsd (the spend, modelUsage) and latencyMs.
// Prints per-attempt purpose/round/role/outcome/summary (and the reason of every failed attempt), phase-completed, test-routed and
// router-decided events, job state transitions, the final state and reason, the worktree `git log --oneline`, and which artifact paths exist.
// Uses a temp COCKPIT_HOME, operator file and toy repo, so cockpit state stays under the temp home; the Claude SDK still writes its
// own session transcripts under the real ~/.claude. The home is a SHORT path (PROBE_HOME if set, else <drive root>\sa-XXXXXX), because
// under the default os.tmpdir() the longest attempt path exceeds createJob's win32 limit and it refuses with ERR_PATH_TOO_LONG.
// Temp dirs are left behind on purpose (the SDK child can hold the cwd on Windows).
// Exit code 0 only if the job ends needs-you with reason ready-to-try; anything else (or the deadline) exits 1.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEADLINE_MS = 40 * 60_000;
const POLL_MS = 5_000;

const home = process.env.PROBE_HOME
  ? (mkdirSync(process.env.PROBE_HOME, { recursive: true }), path.resolve(process.env.PROBE_HOME))
  : mkdtempSync(path.join(path.parse(tmpdir()).root, 'sa-'));
process.env.COCKPIT_HOME = home;
process.env.COCKPIT_OPERATOR_FILE = path.join(home, 'operator-token');
process.env.COCKPIT_RUNTIME_FILE = path.join(home, 'runtime.json');

const realRegistry = await import('../src/session-registry.js');
const { createSuperagent } = await import('../src/superagent/index.js');
const { createSuperagentStore } = await import('../src/superagent/store.js');
const { createRouter } = await import('../src/superagent/router.js');
const { createSuperagentConfig, defaultConfig } = await import('../src/superagent/config.js');

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

const modelOverride = process.env.PROBE_KEEP_MODELS === '1' ? null : Object.fromEntries(
  Object.entries(defaultConfig().models)
    .filter(([, m]) => m.model === 'claude-opus-5-5')
    .map(([role, m]) => [role, { ...m, model: 'claude-sonnet-5-5' }]),
);

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
    console.log(`ATTEMPT phase=${a.phase} task=${a.task ?? '-'} purpose=${a.purpose} round=${a.round ?? '-'} role=${a.role} model=${a.model} n=${a.n} outcome=${a.outcome} verdict=${a.verdict ?? '-'} verified=${JSON.stringify(a.verified)} summary=${clip(a.summary)}`);
    if (a.outcome !== 'done') console.log(`  FAILED REASON: ${a.reason ?? '(none recorded)'}`);
  }
  for (const d of job.routerDecisions ?? []) {
    const key = `router:${d.forAttemptId}`;
    if (printed.has(key)) continue;
    printed.add(key);
    console.log(`ROUTER forAttempt=${d.forAttemptId} action=${d.action} ok=${d.ok} note=${clip(d.note)} estimatedTokens=${d.request?.estimatedTokens} requestInputTokens=${d.usage?.requestInputTokens} totalInputTokens=${d.usage?.totalInputTokens} costUsd=${d.usage?.costUsd} latencyMs=${d.latencyMs}${d.error ? ` error=${d.error}` : ''}`);
  }
}

function printEvents(jobId) {
  const eventsFile = path.join(jobsRoot, jobId, 'events.jsonl');
  console.log('\n=== phase-completed / test-routed events ===');
  if (!existsSync(eventsFile)) return;
  for (const line of readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)) {
    if (/"type":"(phase-completed|test-routed|router-decided)"/.test(line)) console.log(line);
  }
}

function printArtifacts(job, worktree) {
  const jobs = `.superpowers/superagent/${job.jobId}/artifacts`;
  const rels = [job.artifacts.spec, job.artifacts.plan, job.artifacts.tasks, job.artifacts.testReport];
  for (const phase of ['spec-review', 'plan-review']) {
    for (let r = 1; r <= 3; r++) rels.push(`${jobs}/reviews/${phase}-r${r}.md`, `${jobs}/reviews/${phase}-r${r}-response.md`);
    rels.push(`${jobs}/reviews/${phase}-verify.md`);
  }
  for (const t of job.tasks ?? []) {
    const id = t.id;
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
    projects: { [repo]: { limits: { attemptsPerPhase: 2, taskReviewRounds: 1 }, ...(modelOverride ? { models: modelOverride } : {}) } },
  }));
  console.log('model override:', JSON.stringify(modelOverride));
  const config = createSuperagentConfig({ filePath: configFile });
  await config.load();
  const store = createSuperagentStore({ rootDir: jobsRoot });
  sa = createSuperagent({ registry, store, config, router: createRouter(), worktreesRoot: path.join(home, 'superagent', 'worktrees') });

  console.log('home:', home, '\nrepo:', repo);
  const startedAt = Date.now();
  await sa.start();
  let created;
  try {
    created = await sa.createJob({
      title: 'Add a hello file',
      idea: 'Add a hello.txt containing the text hi at the repo root, verified by a node one-liner (for example node -e "process.exit(require(\'fs\').readFileSync(\'hello.txt\',\'utf8\').trim()===\'hi\'?0:1)").',
      primaryRepo: repo,
      fixture: 'milestone-2',
    });
  } catch (err) {
    console.log(`createJob failed: ${err?.code ?? ''} ${err?.message ?? err}`);
    if (err?.code === 'ERR_PATH_TOO_LONG') console.log('HINT: the home path is too long for the win32 path guard; set PROBE_HOME to a shorter path (for example C:\\sa).');
    process.exitCode = 1;
    return;
  }
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
  const ok = !deadlineHit && job?.state === 'needs-you' && job?.reason === 'ready-to-try';
  console.log(ok ? 'VERDICT: pipeline reached ready-to-try' : 'VERDICT: pipeline did NOT reach ready-to-try');
  if (!ok) process.exitCode = 1;
  if (job?.detail) console.log('detail:', clip(JSON.stringify(job.detail), 1000));
  console.log(`elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s, attempts: ${job?.attempts?.length ?? 0}`);

  console.log('\n=== all attempts ===');
  for (const a of job?.attempts ?? []) {
    console.log(`phase=${a.phase} task=${a.task ?? '-'} purpose=${a.purpose} round=${a.round ?? '-'} role=${a.role} model=${a.model} outcome=${a.outcome ?? 'running'} summary=${clip(a.summary)}${a.outcome && a.outcome !== 'done' ? ` REASON=${a.reason ?? ''}` : ''}`);
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
