import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, initRepo, provisionedEvents } from './superagent-helpers.mjs';
import { slugify, createWorktree } from '../src/superagent/worktree.js';
import { deriveJob } from '../src/superagent/store.js';
import { RESULT_FILE, attemptDir, artifactPaths, readResult, validateResult } from '../src/superagent/results.js';

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

async function fixture({ commitSpec = true, specContent = '# Hello design\n' } = {}) {
  const root = await tempDir('sa-res-');
  const origin = path.join(root, 'origin');
  await initRepo(origin);
  const slug = slugify('Add hello', JOB_ID);
  const branch = `superagent/${slug}`;
  const worktree = path.join(root, 'wt');
  const { baseSha } = await createWorktree({ origin, worktree, branch, copyLocalClaudeSettings: false });
  const events = provisionedEvents({ jobId: JOB_ID, slug, branch, createdDate: '2026-11-03', repos: [{ id: 'primary', origin }] })
    .map((ev) => (ev.type === 'worktree-created' ? { ...ev, worktree, baseSha } : ev));
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
  const check = (value, { phase: p = phase, expect = {} } = {}) => validateResult(value, { expected: expected(expect), phase: p, job });
  return { root, origin, worktree, baseSha, job, phase, dir, specSha, goodResult, check };
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
