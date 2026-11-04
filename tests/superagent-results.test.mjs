import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, initRepo, provisionedEvents } from './superagent-helpers.mjs';
import { slugify, createWorktree } from '../src/superagent/worktree.js';
import { deriveJob } from '../src/superagent/store.js';
import { MILESTONE_2_PIPELINE } from '../src/superagent/config.js';
import {
  RESULT_FILE, artifactPaths, attemptDir, outcomeForResult, readResult, requiredOutputs, reviewPaths, reviseOutputs, validateResult,
} from '../src/superagent/results.js';

const JOB_ID = '12345678-aaaa-bbbb-cccc-000000000000';
const REVIEW_PHASE = { phase: 'spec-review', kind: 'review', role: 'spec-reviewer', author: 'spec-writer', target: 'spec', maxRounds: 3 };

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function commitFile(cwd, rel, content, message) {
  const abs = path.join(cwd, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function writeResult(dir, value) {
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${RESULT_FILE}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, path.join(dir, RESULT_FILE));
}

async function fixture({ commitSpec = true, specContent = '# Hello design\n', pipeline, extraRepos = [] } = {}) {
  const root = await tempDir('sa-res-');
  const origin = path.join(root, 'origin');
  await initRepo(origin);
  const slug = slugify('Add hello', JOB_ID);
  const branch = `superagent/${slug}`;
  const worktree = path.join(root, 'wt');
  const { baseSha } = await createWorktree({ origin, worktree, branch, copyLocalClaudeSettings: false });
  const repos = [{ id: 'primary', origin }, ...extraRepos.map((id) => ({ id, origin: path.join(root, id) }))];
  const events = provisionedEvents({ jobId: JOB_ID, slug, branch, createdDate: '2026-11-03', repos, ...(pipeline ? { pipeline } : {}) })
    .map((ev) => (ev.type === 'worktree-created' && ev.repo === 'primary' ? { ...ev, worktree, baseSha } : ev));
  const job = deriveJob(events);
  const phase = job.pipeline.find((p) => p.phase === 'spec');
  const dir = attemptDir(worktree, { jobId: JOB_ID, phase: 'spec', task: null, attemptId: 'a2' });
  const specSha = commitSpec ? await commitFile(worktree, artifactPaths(job).spec, specContent, 'spec') : null;
  const goodResult = (over = {}) => ({
    jobId: JOB_ID,
    phaseId: 'spec',
    taskId: null,
    attemptId: 'a2',
    status: 'done',
    artifacts: [artifactPaths(job).spec],
    summary: 'Wrote the hello design.',
    question: null,
    evidence: { commits: specSha ? [specSha] : [], checks: [{ cmd: 'npm test', exit: 0 }] },
    ...over,
  });
  const expected = (over = {}) => ({ jobId: JOB_ID, phaseId: 'spec', taskId: null, attemptId: 'a2', ...over });
  const check = (value, { phase: p = phase, expect = {}, attempt } = {}) => validateResult(value, { expected: expected(expect), phase: p, job, attempt });
  const commit = (rel, content = '# x\n', message = rel) => commitFile(worktree, rel, content, message);
  return { root, origin, worktree, baseSha, job, phase, dir, specSha, goodResult, check, commit };
}

test('a result carrying an earlier attempt\'s id is invalid-result', async () => {
  const { job, phase, dir, goodResult } = await fixture();
  await writeResult(dir, goodResult({ attemptId: 'a1' }));
  const read = await readResult(dir);
  const v = await validateResult(read.value, { expected: { jobId: job.jobId, phaseId: 'spec', taskId: null, attemptId: 'a2' }, phase, job });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /identity mismatch: attemptId/);
});

test('identity is checked field by field, and a missing field never matches', async () => {
  const { goodResult, check } = await fixture();
  for (const key of ['jobId', 'phaseId', 'taskId', 'attemptId']) {
    const value = goodResult();
    delete value[key];
    const v = await check(value);
    assert.equal(v.ok, false, key);
    assert.equal(v.errors[0], `identity mismatch: ${key}`);
  }
  const v = await check(goodResult({ taskId: 'T1' }));
  assert.equal(v.errors[0], 'identity mismatch: taskId');
});

test('attemptDir and artifactPaths follow the spec layout', async () => {
  const w = path.join('/tmp', 'wt');
  assert.equal(attemptDir(w, { jobId: 'j1', phase: 'spec', task: null, attemptId: 'a1' }), path.join(w, '.superpowers', 'superagent', 'j1', 'attempts', 'spec', 'a1'));
  assert.equal(attemptDir(w, { jobId: 'j1', phase: 'implement', task: 'T1', attemptId: 'a3' }), path.join(w, '.superpowers', 'superagent', 'j1', 'attempts', 'implement', 'T1', 'a3'));
  for (const bad of [{ task: '../x' }, { attemptId: '..' }, { phase: 'a/b' }, { jobId: '' }]) {
    assert.throws(() => attemptDir(w, { jobId: 'j1', phase: 'spec', task: null, attemptId: 'a1', ...bad }), /unsafe/);
  }
  const job = deriveJob(provisionedEvents({ jobId: JOB_ID, slug: 'add-hello-12345678', createdDate: '2026-11-03' }));
  assert.deepEqual(artifactPaths(job), {
    brief: 'docs/superpowers/jobs/add-hello-12345678/brief.md',
    spec: 'docs/superpowers/specs/2026-11-03-add-hello-12345678-design.md',
    plan: 'docs/superpowers/plans/2026-11-03-add-hello-12345678.md',
    tasks: 'docs/superpowers/jobs/add-hello-12345678/tasks.json',
    testReport: 'docs/superpowers/jobs/add-hello-12345678/test-report.md',
  });
});

test('readResult ignores a tmp-only publish and reports an unparseable file', async () => {
  const dir = await tempDir('sa-res-read-');
  assert.deepEqual(await readResult(path.join(dir, 'never-made')), { state: 'missing' });
  await fs.writeFile(path.join(dir, `${RESULT_FILE}.tmp`), '{"status":"done"}');
  assert.deepEqual(await readResult(dir), { state: 'missing' });
  await fs.writeFile(path.join(dir, RESULT_FILE), '{"status":');
  const bad = await readResult(dir);
  assert.equal(bad.state, 'unparseable');
  assert.equal(typeof bad.error, 'string');
  await fs.writeFile(path.join(dir, RESULT_FILE), '\uFEFF{"status":"done"}');
  assert.deepEqual(await readResult(dir), { state: 'present', value: { status: 'done' } });
});

test('schema errors are reported', async () => {
  const { goodResult, check, specSha } = await fixture();
  const cases = [
    goodResult({ status: 'maybe' }),
    goodResult({ question: 'Which?', status: 'done' }),
    goodResult({ artifacts: ['/abs/x'] }),
    goodResult({ artifacts: ['../x'] }),
    goodResult({ artifacts: ['docs/../../x'] }),
    goodResult({ artifacts: ['..\\x'] }),
    goodResult({ artifacts: ['C:\\x'] }),
    goodResult({ artifacts: 'docs/x' }),
    goodResult({ summary: '' }),
    goodResult({ summary: '   ' }),
    goodResult({ evidence: { checks: [{ cmd: 'npm test' }] } }),
    goodResult({ evidence: { checks: [{ cmd: 'npm test', exit: 0.5 }] } }),
    goodResult({ evidence: { commits: [specSha, '--output=pwned'] } }),
    goodResult({ evidence: { commits: [specSha, `${specSha.slice(0, 8)}^{tree}`] } }),
    goodResult({ evidence: 'lots' }),
    'not an object',
  ];
  for (const value of cases) {
    const v = await check(value);
    assert.equal(v.ok, false, JSON.stringify(value));
    assert.ok(v.errors.length > 0 && v.errors.every((e) => typeof e === 'string'));
  }
});

test('a long summary is truncated, not rejected', async () => {
  const { goodResult, check } = await fixture();
  const words = Array.from({ length: 70 }, (_, i) => `w${i}`);
  const v = await check(goodResult({ summary: words.join(' ') }));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.result.summary, words.slice(0, 60).join(' '));
});

test('done without its required output, or with an empty one, is invalid', async () => {
  const fresh = await fixture({ commitSpec: false });
  const missing = await fresh.check(fresh.goodResult());
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /missing output: docs\/superpowers\/specs\//);

  const empty = await fixture({ specContent: '' });
  const v = await empty.check(empty.goodResult());
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /empty output/);

  const good = await fixture();
  const ok = await good.check(good.goodResult());
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('an author phase\'s output must be committed by a listed commit', async () => {
  const a = await fixture({ commitSpec: false });
  const spec = path.join(a.worktree, ...artifactPaths(a.job).spec.split('/'));
  await fs.mkdir(path.dirname(spec), { recursive: true });
  await fs.writeFile(spec, '# never committed\n');
  const otherSha = await commitFile(a.worktree, 'other.txt', 'x\n', 'unrelated');
  const va = await a.check(a.goodResult({ evidence: { commits: [otherSha] } }));
  assert.equal(va.ok, false);
  assert.match(va.errors.join('\n'), /output not committed by a listed commit: docs\/superpowers\/specs\//);

  const b = await fixture();
  const vb = await b.check(b.goodResult({ evidence: { commits: [] } }));
  assert.equal(vb.ok, false);
  assert.match(vb.errors.join('\n'), /output not committed by a listed commit/);

  const c = await fixture();
  await fs.appendFile(path.join(c.worktree, ...artifactPaths(c.job).spec.split('/')), 'edited later\n');
  const vc = await c.check(c.goodResult());
  assert.equal(vc.ok, false);
  assert.match(vc.errors.join('\n'), /output changed after its commit: docs\/superpowers\/specs\//);

  const d = await fixture();
  assert.equal((await d.check(d.goodResult())).ok, true);
});

test('commit evidence must be new work on the job branch', async () => {
  const f = await fixture();
  const ok = await f.check(f.goodResult({ evidence: { commits: [f.specSha.slice(0, 10)] } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.result.commits, [{ repo: 'primary', sha: f.specSha }]);
  const asObject = await f.check(f.goodResult({ evidence: { commits: [{ repo: 'primary', sha: f.specSha }] } }));
  assert.equal(asObject.ok, true, JSON.stringify(asObject.errors));

  const absent = await f.check(f.goodResult({ evidence: { commits: [f.specSha, 'deadbeef'.repeat(5)] } }));
  assert.equal(absent.ok, false);
  assert.match(absent.errors.join('\n'), /commit not found/);

  assert.equal(f.job.repos[0].baseSha, f.baseSha);
  const base = await f.check(f.goodResult({ evidence: { commits: [f.specSha, f.job.repos[0].baseSha] } }));
  assert.equal(base.ok, false);
  assert.match(base.errors.join('\n'), /commit predates the job/);

  git(f.origin, 'checkout', '-q', '-b', 'elsewhere');
  const elsewhere = await commitFile(f.origin, 'elsewhere.txt', 'x\n', 'other branch');
  const off = await f.check(f.goodResult({ evidence: { commits: [f.specSha, elsewhere] } }));
  assert.equal(off.ok, false);
  assert.match(off.errors.join('\n'), /commit not on the job branch/);

  const nope = await f.check(f.goodResult({ evidence: { commits: [f.specSha, { repo: 'nope', sha: f.specSha }] } }));
  assert.equal(nope.ok, false);
  assert.match(nope.errors.join('\n'), /unknown repo/);
});

test('review phases require verdict and well-formed findings', async () => {
  const f = await fixture();
  const review = (over) => f.goodResult({ phaseId: 'spec-review', artifacts: [], ...over });
  const asReview = { phase: REVIEW_PHASE, expect: { phaseId: 'spec-review' } };
  const finding = (disposition) => ({ id: 'F1', severity: 'major', text: 'Missing error case.', disposition });

  assert.equal((await f.check(review({ findings: [] }), asReview)).ok, false);
  assert.equal((await f.check(review({ verdict: 'changes', findings: [finding('declined:')] }), asReview)).ok, false);
  assert.equal((await f.check(review({ verdict: 'changes', findings: [{ ...finding('open'), severity: 'nit' }] }), asReview)).ok, false);
  assert.equal((await f.check(review({ verdict: 'changes', findings: [{ ...finding('open'), text: '' }] }), asReview)).ok, false);
  for (const disposition of ['fixed', 'open', 'declined: out of scope']) {
    const v = await f.check(review({ verdict: 'changes', findings: [finding(disposition)] }), asReview);
    assert.equal(v.ok, true, `${disposition}: ${JSON.stringify(v.errors)}`);
  }

  const ignored = await f.check(f.goodResult({ verdict: 'maybe', findings: [finding('declined:')] }));
  assert.equal(ignored.ok, true, JSON.stringify(ignored.errors));
});

const SLUG = 'add-hello-12345678';
const JOBS = `docs/superpowers/jobs/${SLUG}`;
const m2Job = () => deriveJob(provisionedEvents({ jobId: JOB_ID, slug: SLUG, createdDate: '2026-11-03', pipeline: MILESTONE_2_PIPELINE }));
const phaseOf = (job, id) => job.pipeline.find((p) => p.phase === id);
const finding = (id, severity, disposition) => ({ id, severity, text: `Finding ${id}.`, disposition });

test('requiredOutputs maps each purpose to its path', () => {
  const job = m2Job();
  const a = artifactPaths(job);
  const cases = [
    [{ phase: phaseOf(job, 'plan'), purpose: 'author' }, [a.plan, a.tasks]],
    [{ phase: phaseOf(job, 'test'), purpose: 'test' }, [a.testReport]],
    [{ phase: phaseOf(job, 'spec-review'), purpose: 'review', round: 2 }, [`${JOBS}/reviews/spec-review-r2.md`]],
    [{ phase: phaseOf(job, 'spec-review'), purpose: 'fix', round: 2 }, [`${JOBS}/reviews/spec-review-r2-response.md`]],
    [{ phase: phaseOf(job, 'plan-review'), purpose: 'verify' }, [`${JOBS}/reviews/plan-review-verify.md`]],
    [{ phase: phaseOf(job, 'implement'), purpose: 'verify', task: 'T1' }, [`${JOBS}/tasks/T1-verify.md`]],
    [{ phase: phaseOf(job, 'implement'), purpose: 'implement', round: 1, task: 'T1' }, [`${JOBS}/tasks/T1-report.md`]],
    [{ phase: phaseOf(job, 'implement'), purpose: 'fix', round: 1, task: 'T1' }, [`${JOBS}/tasks/T1-report.md`]],
    [{ phase: phaseOf(job, 'implement'), purpose: 'task-review', round: 3, task: 'T1' }, [`${JOBS}/tasks/T1-review-r3.md`]],
  ];
  for (const [args, want] of cases) assert.deepEqual(requiredOutputs(job, args), want, `${args.purpose} ${args.phase.phase}`);
  assert.throws(() => requiredOutputs(job, { phase: phaseOf(job, 'spec'), purpose: 'nope' }), /purpose/);
  assert.throws(() => requiredOutputs(job, { phase: phaseOf(job, 'spec-review'), purpose: 'review' }), /round/);
});

test('reviewPaths builds round and task scoped paths under the slug', () => {
  const job = m2Job();
  assert.deepEqual(reviewPaths(job, { phase: 'spec-review', round: 2, taskId: 'T1' }), {
    review: `${JOBS}/reviews/spec-review-r2.md`,
    response: `${JOBS}/reviews/spec-review-r2-response.md`,
    verify: `${JOBS}/reviews/spec-review-verify.md`,
    report: `${JOBS}/tasks/T1-report.md`,
    taskReview: `${JOBS}/tasks/T1-review-r2.md`,
    taskVerify: `${JOBS}/tasks/T1-verify.md`,
  });
  const phaseOnly = reviewPaths(job, { phase: 'plan-review' });
  assert.equal(phaseOnly.verify, `${JOBS}/reviews/plan-review-verify.md`);
  assert.equal(phaseOnly.review, null);
  assert.equal(phaseOnly.report, null);
  assert.throws(() => reviewPaths(job, { phase: 'implement', taskId: '../x' }), /unsafe/);
  assert.throws(() => reviewPaths(job, { phase: 'a/b', round: 1 }), /unsafe/);
});

test('reviseOutputs maps spec to [spec] and plan to [plan, tasks]', () => {
  const job = m2Job();
  const a = artifactPaths(job);
  assert.deepEqual(reviseOutputs(job, phaseOf(job, 'spec-review')), [a.spec]);
  assert.deepEqual(reviseOutputs(job, phaseOf(job, 'plan-review')), [a.plan, a.tasks]);
});

async function reviewFixture(opts) {
  const f = await fixture({ pipeline: MILESTONE_2_PIPELINE, ...opts });
  const review = phaseOf(f.job, 'spec-review');
  const paths = reviewPaths(f.job, { phase: 'spec-review', round: 1 });
  const result = (rel, sha, over = {}) => f.goodResult({ phaseId: 'spec-review', artifacts: [rel], evidence: { commits: sha ? [sha] : [] }, ...over });
  const as = (attempt) => ({ phase: review, expect: { phaseId: 'spec-review' }, attempt: { round: 1, final: false, task: null, ...attempt } });
  return { ...f, review, paths, result, as };
}

test('review: approve with an open blocker is invalid', async () => {
  const f = await reviewFixture();
  const sha = await f.commit(f.paths.review);
  const v = await f.check(f.result(f.paths.review, sha, { verdict: 'approve', findings: [finding('F1', 'blocker', 'open')] }), f.as({ purpose: 'review' }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /approve.*blocker/);
});

test('review: changes with no findings is invalid', async () => {
  const f = await reviewFixture();
  const sha = await f.commit(f.paths.review);
  const v = await f.check(f.result(f.paths.review, sha, { verdict: 'changes', findings: [] }), f.as({ purpose: 'review' }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /changes.*finding/);
  const missing = await f.check(f.result(f.paths.review, sha, { verdict: 'changes' }), f.as({ purpose: 'task-review' }));
  assert.equal(missing.ok, false);
});

test('review: a committed review file with approve and only minor findings is ok', async () => {
  const f = await reviewFixture();
  const sha = await f.commit(f.paths.review);
  const v = await f.check(f.result(f.paths.review, sha, { verdict: 'approve', findings: [finding('F1', 'minor', 'open')] }), f.as({ purpose: 'review' }));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const fixed = await f.check(f.result(f.paths.review, sha, { verdict: 'approve', findings: [finding('F1', 'blocker', 'fixed')] }), f.as({ purpose: 'review' }));
  assert.equal(fixed.ok, true, JSON.stringify(fixed.errors));
});

test('a review file not committed by a listed commit is invalid-result', async () => {
  const f = await reviewFixture();
  const abs = path.join(f.worktree, ...f.paths.review.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, '# review\n');
  const v = await f.check(f.result(f.paths.review, f.specSha, { verdict: 'approve', findings: [] }), f.as({ purpose: 'review' }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /output not committed by a listed commit: docs\/superpowers\/jobs\/[^/]+\/reviews\/spec-review-r1\.md/);
});

test('fix: a fixed disposition for an id the review did not list is invalid', async () => {
  const f = await reviewFixture();
  const sha = await f.commit(f.paths.response);
  const v = await f.check(f.result(f.paths.response, sha, { findings: [finding('F1', 'major', 'fixed'), finding('F9', 'major', 'fixed')] }),
    f.as({ purpose: 'fix', reviewFindings: ['F1', 'F2'] }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /F9/);
  const none = await f.check(f.result(f.paths.response, sha), f.as({ purpose: 'fix', reviewFindings: ['F1'] }));
  assert.equal(none.ok, false);
  assert.match(none.errors.join('\n'), /findings must be an array/);
});

test('fix: findings covering the review\'s ids with fixed/declined/open are ok', async () => {
  const f = await reviewFixture();
  const sha = await f.commit(f.paths.response);
  const findings = [finding('F1', 'blocker', 'fixed'), finding('F2', 'major', 'declined: out of scope'), finding('F3', 'minor', 'open')];
  const reviewFindings = [finding('F1', 'blocker', 'open'), finding('F2', 'major', 'open'), finding('F3', 'minor', 'open')];
  const v = await f.check(f.result(f.paths.response, sha, { verdict: 'whatever', findings }), f.as({ purpose: 'fix', reviewFindings }));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('fix (non-final): an open blocker is invalid; the same result with final true is ok', async () => {
  const f = await reviewFixture();
  const sha = await f.commit(f.paths.response);
  const value = f.result(f.paths.response, sha, { findings: [finding('F1', 'blocker', 'open')] });
  const nonFinal = await f.check(value, f.as({ purpose: 'fix', reviewFindings: ['F1'] }));
  assert.equal(nonFinal.ok, false);
  assert.match(nonFinal.errors.join('\n'), /blocker.*open/);
  const downgraded = await f.check(f.result(f.paths.response, sha, { findings: [finding('F1', 'minor', 'open')] }),
    f.as({ purpose: 'fix', reviewFindings: [finding('F1', 'blocker', 'open')] }));
  assert.equal(downgraded.ok, false, 'the review\'s severity counts, not a downgraded one');
  const final = await f.check(value, f.as({ purpose: 'fix', final: true, reviewFindings: ['F1'] }));
  assert.equal(final.ok, true, JSON.stringify(final.errors));
});

test('fix: a missing, empty or dirty revise-set file is invalid; declining everything with a clean tree and no touching commit is ok', async () => {
  const fixAttempt = { purpose: 'fix', reviewFindings: ['F1'] };
  const declined = { findings: [finding('F1', 'major', 'declined: not needed')] };

  const missing = await reviewFixture({ commitSpec: false });
  const ms = await missing.commit(missing.paths.response);
  const vm = await missing.check(missing.result(missing.paths.response, ms, declined), missing.as(fixAttempt));
  assert.equal(vm.ok, false);
  assert.match(vm.errors.join('\n'), /missing revised output: docs\/superpowers\/specs\//);

  const empty = await reviewFixture({ specContent: '' });
  const es = await empty.commit(empty.paths.response);
  const ve = await empty.check(empty.result(empty.paths.response, es, declined), empty.as(fixAttempt));
  assert.equal(ve.ok, false);
  assert.match(ve.errors.join('\n'), /empty revised output: docs\/superpowers\/specs\//);

  const dirty = await reviewFixture();
  const ds = await dirty.commit(dirty.paths.response);
  await fs.appendFile(path.join(dirty.worktree, ...artifactPaths(dirty.job).spec.split('/')), 'uncommitted\n');
  const vd = await dirty.check(dirty.result(dirty.paths.response, ds, declined), dirty.as(fixAttempt));
  assert.equal(vd.ok, false);
  assert.match(vd.errors.join('\n'), /revised output has uncommitted changes: docs\/superpowers\/specs\//);

  const clean = await reviewFixture();
  const cs = await clean.commit(clean.paths.response);
  const vc = await clean.check(clean.result(clean.paths.response, cs, declined), clean.as(fixAttempt));
  assert.equal(vc.ok, true, JSON.stringify(vc.errors));
});

test('verify: missing, extra or duplicate ids are invalid; exact coverage with evidence is ok', async () => {
  const f = await reviewFixture();
  const verify = reviewPaths(f.job, { phase: 'spec-review' }).verify;
  const sha = await f.commit(verify);
  const entry = (id) => ({ id, verified: false, evidence: `Checked ${id} against the code.` });
  const as = f.as({ purpose: 'verify', round: null, contested: ['F1', 'F2'] });
  for (const ids of [['F1'], ['F1', 'F2', 'F3'], ['F1', 'F1', 'F2']]) {
    const v = await f.check(f.result(verify, sha, { verified: ids.map(entry) }), as);
    assert.equal(v.ok, false, ids.join(','));
  }
  const notArray = await f.check(f.result(verify, sha, { verified: 'all' }), as);
  assert.equal(notArray.ok, false);
  const ok = await f.check(f.result(verify, sha, { verified: [entry('F2'), { ...entry('F1'), verified: true }] }), as);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('verify: verified must be boolean and evidence non-empty', async () => {
  const f = await reviewFixture();
  const verify = reviewPaths(f.job, { phase: 'spec-review' }).verify;
  const sha = await f.commit(verify);
  const as = f.as({ purpose: 'verify', round: null, contested: ['F1'] });
  const bads = [
    { id: 'F1', verified: 'yes', evidence: 'x' },
    { id: 'F1', verified: true, evidence: '  ' },
    { id: 'F1', verified: true },
    { id: 7, verified: true, evidence: 'x' },
  ];
  for (const bad of bads) {
    const v = await f.check(f.result(verify, sha, { verified: [bad] }), as);
    assert.equal(v.ok, false, JSON.stringify(bad));
  }
});

async function testFixture(opts) {
  const f = await fixture({ pipeline: MILESTONE_2_PIPELINE, ...opts });
  const failed = (over = {}) => f.goodResult({ phaseId: 'test', status: 'failed', artifacts: [], evidence: { commits: [] }, summary: 'Two tests fail.', ...over });
  const as = { phase: phaseOf(f.job, 'test'), expect: { phaseId: 'test' }, attempt: { purpose: 'test', round: null, final: false, task: null } };
  return { ...f, failed, as };
}

test('test: failed without findings is invalid; failed with findings is ok and outcomeForResult is failed with a signature', async () => {
  const f = await testFixture();
  assert.equal((await f.check(f.failed(), f.as)).ok, false);
  assert.equal((await f.check(f.failed({ findings: [] }), f.as)).ok, false);
  assert.equal((await f.check(f.failed({ findings: [{ id: 'F1', severity: 'nit', text: 'x' }] }), f.as)).ok, false);
  const findings = [{ id: 'F1', severity: 'major', text: 'hello() returns undefined.' }];
  const v = await f.check(f.failed({ findings }), f.as);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const outcome = outcomeForResult(v.result);
  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.reason, 'failed');
  assert.equal(typeof outcome.signature, 'string');
  assert.deepEqual(outcome.findings, findings);
});

test('test: a finding with an unknown repo is invalid; a finding naming additional repo "lib" is ok', async () => {
  const f = await testFixture({ extraRepos: ['lib'] });
  const repoFinding = (repo) => [{ id: 'F1', severity: 'major', text: 'lib export missing.', repo }];
  const bad = await f.check(f.failed({ findings: repoFinding('nope') }), f.as);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /repo/);
  const ok = await f.check(f.failed({ findings: repoFinding('lib') }), f.as);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('outcomeForResult: a failed result\'s signature is stable across hex addresses and counts', () => {
  const a = outcomeForResult({ status: 'failed', summary: 'Crash at 0x7ffd1234 after 12 retries in deadbeef01\nfirst detail' });
  const b = outcomeForResult({ status: 'failed', summary: 'Crash at 0xabc after 3 retries in 0123abcd99\nother detail' });
  assert.equal(a.signature, b.signature);
  const blocked = outcomeForResult({ status: 'blocked', summary: 'Crash at 0x1 after 1 retries in abcdef1' });
  assert.equal(blocked.reason, 'blocked');
  assert.notEqual(blocked.signature, a.signature);
  const done = outcomeForResult({ status: 'done', verdict: 'approve', findings: [], verified: [] });
  assert.deepEqual(done, { outcome: 'done', verdict: 'approve', findings: [], verified: [] });
});

test('without attempt, Plan 2 validation is unchanged', async () => {
  const good = await fixture();
  const plain = await good.check(good.goodResult());
  const withAttempt = await good.check(good.goodResult(), { attempt: { purpose: 'author' } });
  assert.equal(plain.ok, true, JSON.stringify(plain.errors));
  assert.deepEqual(withAttempt, plain);

  const bad = await fixture({ commitSpec: false });
  const plainBad = await bad.check(bad.goodResult());
  const withAttemptBad = await bad.check(bad.goodResult(), { attempt: { purpose: 'author' } });
  assert.equal(plainBad.ok, false);
  assert.deepEqual(withAttemptBad, plainBad);
});

test('a truncated summary keeps its first line, so long failures that differ after line 1 share a signature', async () => {
  const f = await testFixture();
  const findings = [{ id: 'F1', severity: 'major', text: 'hello() returns undefined.' }];
  const tail = (tag) => Array.from({ length: 70 }, (_, i) => `${tag}${String.fromCharCode(97 + (i % 26))}`).join(' ');
  const first = 'npm test failed in hello.test.js';
  const a = await f.check(f.failed({ findings, summary: `${first}\n${tail('alpha')}` }), f.as);
  const b = await f.check(f.failed({ findings, summary: `${first}\n${tail('omega')}` }), f.as);
  assert.equal(a.ok && b.ok, true, JSON.stringify([a.errors, b.errors]));
  assert.equal(a.result.summary.split('\n')[0], first);
  assert.equal(a.result.summary.trim().split(/\s+/).length, 60);
  assert.equal(outcomeForResult(a.result).signature, outcomeForResult(b.result).signature);
});

test('duplicate finding ids are invalid in review and fix results', async () => {
  const f = await reviewFixture();
  const reviewSha = await f.commit(f.paths.review);
  const dupReview = await f.check(f.result(f.paths.review, reviewSha, { verdict: 'changes', findings: [finding('F1', 'major', 'open'), finding('F1', 'minor', 'open')] }),
    f.as({ purpose: 'review' }));
  assert.equal(dupReview.ok, false);
  assert.match(dupReview.errors.join('\n'), /duplicate id "F1"/);

  const responseSha = await f.commit(f.paths.response);
  const dupFix = await f.check(f.result(f.paths.response, responseSha, { findings: [finding('F1', 'blocker', 'fixed'), finding('F1', 'blocker', 'declined: no')] }),
    f.as({ purpose: 'fix', final: true, reviewFindings: ['F1'] }));
  assert.equal(dupFix.ok, false);
  assert.match(dupFix.errors.join('\n'), /duplicate id "F1"/);
});
