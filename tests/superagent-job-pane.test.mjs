import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub } from './helpers/dom-stub.mjs';

installDomStub();
const { artifactErrorText, artifactFileName, artifactMimeType, createJobPane, renderArtifactBody, renderRouterLog, stageState } = await import('../public/superagent-job-pane.js');

const money = (usd, complete = true) => ({ usd, complete });

function attempt(overrides = {}) {
  return {
    attemptId: 'a1',
    phase: 'investigate',
    task: null,
    role: 'investigator',
    model: 'claude-opus-5-5',
    n: 1,
    cap: 3,
    round: null,
    purpose: 'author',
    outcome: 'done',
    pausedBeforeLaunch: false,
    retried: false,
    live: false,
    sessionId: 's1',
    startedAt: 1_000,
    endedAt: 1_000 + 14 * 60_000,
    durationMs: 14 * 60_000,
    summary: 'Found the null reference in RoundLoader.',
    reason: null,
    verdict: null,
    findingsCount: null,
    question: null,
    commits: 0,
    usage: { state: 'final', knownCostUsd: 4.44, tokens: { total: 7_300_000 }, byModel: {}, unpricedModels: [], complete: true },
    usageNote: null,
    cost: money(4.44),
    transcript: { available: true },
    ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    jobId: 'job-1',
    title: 'Investigate this ADO issue',
    status: 'needs-you',
    reason: 'ready-to-try',
    createdAt: Date.UTC(2026, 10, 18, 12, 5),
    workflow: { id: 'troubleshooting', name: 'Troubleshooting' },
    idea: 'Investigate https://dev.azure.com/org/proj/_workitems/edit/171558 for:\n\n- https://mediatonicgames.sentry.io/issues/4908023691/\n- https://mediatonicgames.sentry.io/issues/4908733049/',
    branch: 'superagent/investigate',
    repos: [{ id: 'FallGuys', origin: '/repo', worktree: '/repo', inPlace: true }],
    readyInputs: [],
    phases: [
      { phase: 'investigate', kind: 'author', status: 'done' },
      { phase: 'diagnosis-review', kind: 'review', status: 'done' },
      { phase: 'fix', kind: 'per-task', status: 'done' },
      { phase: 'verify', kind: 'author', status: 'done' },
      { phase: 'accept', kind: 'human', status: 'waiting' },
    ],
    tasks: null,
    attempts: [attempt()],
    artifacts: [],
    spend: {
      total: money(4.44),
      workers: money(4.44),
      router: money(null),
      byPhase: [{ phase: 'investigate', task: null, attempts: 1, usd: 4.44, complete: true }],
      byTask: [],
      byModel: [{ model: 'claude-opus-5-5', source: 'worker', tokens: 7_300_000, usd: 4.44, complete: true }],
      complete: true,
    },
    router: null,
    needsYou: null,
    ...overrides,
  };
}

function mount(options = {}) {
  const view = document.createElement('main');
  const middle = document.createElement('section');
  const root = document.createElement('div');
  view.append(middle);
  middle.append(root);
  const opened = [];
  const pane = createJobPane({
    root,
    onOpenArtifact: (key) => opened.push(key),
    stopButton: () => {
      const b = document.createElement('button');
      b.className = 'btn btn-danger';
      b.textContent = 'Stop job';
      return b;
    },
    ...options,
  });
  return { view, middle, root, pane, opened };
}

const cardFor = (root, attemptId) => root.querySelectorAll('.sa-attempt-card').find((c) => c.dataset.attemptId === attemptId);

test('renders the idea as markdown with link chips', () => {
  const { root, pane } = mount();
  pane.render(detail());
  const description = root.querySelector('.sa-description');
  const chips = description.querySelectorAll('.sa-link-chip');
  assert.equal(chips.length, 3);
  assert.deepEqual(chips.slice(1).map((c) => c.textContent), [
    'mediatonicgames.sentry.io · 4908023691',
    'mediatonicgames.sentry.io · 4908733049',
  ]);
  assert.equal(chips[1].title, 'https://mediatonicgames.sentry.io/issues/4908023691/');
  assert.equal(description.querySelectorAll('li').length, 2);
});

test('the header carries title, status badge, Stop and a meta line with workflow, folder and spend', () => {
  const { root, pane } = mount();
  pane.render(detail());
  const head = root.querySelector('.sa-jp-head');
  assert.equal(head.querySelector('.sa-jp-title').textContent, 'Investigate this ADO issue');
  const badge = head.querySelector('.sa-badge');
  assert.equal(badge.textContent, 'needs you');
  assert.ok(badge.classList.contains('status-needs-you'));
  assert.equal(head.querySelector('.btn-danger').textContent, 'Stop job');
  const meta = root.querySelector('.sa-jp-meta').textContent;
  assert.match(meta, /^🕵️ Troubleshooting · created \d+ \w{3} \d\d:\d\d · in place: FallGuys · \$4\.44 spent$/);

  pane.render(detail({ status: 'done', reason: null }));
  assert.equal(root.querySelector('.sa-jp-head').querySelector('.btn-danger'), null);
});

test('renders one timeline step per phase with arrows between and the workflow name as the panel title', () => {
  const { root, pane } = mount();
  pane.render(detail());
  const timeline = root.querySelector('.sa-timeline-card');
  assert.equal(timeline.querySelector('.sa-card-title').textContent, 'Workflow: 🕵️ Troubleshooting');
  const steps = timeline.querySelectorAll('.sa-step');
  assert.equal(steps.length, 5);
  assert.equal(timeline.querySelectorAll('.sa-step-arrow').length, 4);
  steps.forEach((step, i) => assert.ok(step.classList.contains(`sa-stage-${i % 8}`), step.className));
  assert.ok(steps[0].classList.contains('step-done'));
  assert.ok(steps[4].classList.contains('step-waiting'));
  assert.match(steps[0].textContent, /investigate/);
  assert.match(steps[0].textContent, /✓/);
  assert.match(steps[4].textContent, /!/);
});

test('the timeline colours wrap around after eight stages', () => {
  const { root, pane } = mount();
  const phases = Array.from({ length: 10 }, (_, i) => ({ phase: `p${i}`, kind: 'author', status: 'todo' }));
  pane.render(detail({ phases, attempts: [], spend: { ...detail().spend, byPhase: [], byModel: [] } }));
  const steps = root.querySelectorAll('.sa-step');
  assert.ok(steps[8].classList.contains('sa-stage-0'));
  assert.ok(steps[9].classList.contains('sa-stage-1'));
  assert.ok(steps[9].classList.contains('step-todo'));
});

test('groups attempts per phase, and per (phase, task) for per-task phases, with count and spend in the header', () => {
  const { root, pane } = mount();
  pane.render(detail({
    attempts: [
      attempt({ attemptId: 'i1' }),
      attempt({ attemptId: 'f1', phase: 'fix', task: 'T1', role: 'fixer', n: 1, cost: money(0.2) }),
      attempt({ attemptId: 'i2', n: 2, outcome: 'failed', reason: 'invalid-result', summary: null, cost: money(1) }),
      attempt({ attemptId: 'f2', phase: 'fix', task: 'T2', role: 'fixer', cost: money(0.3) }),
      attempt({ attemptId: 'f3', phase: 'fix', task: 'T2', role: 'fix-reviewer', n: 1, cost: money(0.09) }),
    ],
    spend: {
      ...detail().spend,
      byPhase: [
        { phase: 'investigate', task: null, attempts: 2, usd: 5.44, complete: true },
        { phase: 'fix', task: 'T1', attempts: 1, usd: 0.2, complete: true },
        { phase: 'fix', task: 'T2', attempts: 2, usd: 0.39, complete: true },
      ],
    },
  }));
  const groups = root.querySelectorAll('.sa-stage-group');
  assert.equal(groups.length, 3);
  const heads = groups.map((g) => g.querySelector('.sa-stage-head').textContent);
  assert.match(heads[0], /^investigate done · 2 attempts · \$5\.44/);
  assert.match(heads[1], /^fix \/ T1 done · 1 attempt · \$0\.20/);
  assert.match(heads[2], /^fix \/ T2 done · 2 attempts · \$0\.39/);
  assert.ok(groups[0].querySelector('.sa-stage-head').classList.contains('sa-stage-0'));
  assert.ok(groups[1].querySelector('.sa-stage-head').classList.contains('sa-stage-2'));
  assert.deepEqual(groups[0].querySelectorAll('.sa-attempt-card').map((c) => c.dataset.attemptId), ['i1', 'i2']);
  assert.deepEqual(groups[2].querySelectorAll('.sa-attempt-card').map((c) => c.dataset.attemptId), ['f2', 'f3']);
});

test('an attempt card shows outcome, role, model, n/cap, duration, tokens, cost and its result line', () => {
  const { root, pane } = mount();
  pane.render(detail({ attempts: [attempt({ commits: 2, round: 1 })] }));
  const card = cardFor(root, 'a1');
  const badge = card.querySelector('.sa-badge');
  assert.equal(badge.textContent, 'done');
  assert.ok(badge.classList.contains('outcome-done'));
  const text = card.textContent;
  for (const part of ['#1/3', 'investigator', 'opus-5-5', 'round 1', '14m', '7.3M tok', '$4.44', '2 commits']) {
    assert.ok(text.includes(part), `missing ${part} in ${text}`);
  }
  assert.equal(card.querySelector('.sa-attempt-result').textContent, 'Found the null reference in RoundLoader.');
  assert.equal(card.querySelector('.sa-attempt-flag'), null);

  pane.render(detail({ attempts: [attempt({ outcome: 'failed', retried: true, reason: 'invalid-result: tasks.json is missing' })] }));
  const retried = cardFor(root, 'a1');
  assert.equal(retried.querySelector('.sa-attempt-flag').textContent, 'retried, not counted');
  assert.ok(retried.querySelector('.sa-badge').classList.contains('outcome-failed'));
  assert.equal(retried.querySelector('.sa-attempt-result').textContent, 'invalid-result: tasks.json is missing');
});

test('the result line is the question, or the review verdict with its findings count', () => {
  const { root, pane } = mount();
  pane.render(detail({
    attempts: [
      attempt({ attemptId: 'q', outcome: 'question', question: 'Which Sentry issue first?', summary: null }),
      attempt({ attemptId: 'r', phase: 'diagnosis-review', purpose: 'review', verdict: 'changes-requested', findingsCount: 2, summary: 'Two gaps.' }),
    ],
  }));
  const q = cardFor(root, 'q');
  assert.ok(q.querySelector('.sa-badge').classList.contains('outcome-question'));
  assert.equal(q.querySelector('.sa-attempt-result').textContent, 'Which Sentry issue first?');
  const r = cardFor(root, 'r');
  assert.equal(r.querySelector('.sa-attempt-verdict').textContent, 'changes-requested · 2 findings');
  assert.match(r.querySelector('.sa-attempt-result').textContent, /Two gaps\./);
});

test("unknown usage renders 'not available' with the note as tooltip, and the spend header reads 'at least' when spend is incomplete", () => {
  const { root, pane } = mount();
  pane.render(detail({
    attempts: [
      attempt({ attemptId: 'known' }),
      attempt({ attemptId: 'unknown', n: 2, usage: null, usageNote: 'missing', cost: money(null, false) }),
    ],
    spend: {
      ...detail().spend,
      total: money(4.44, false),
      workers: money(4.44, false),
      byPhase: [{ phase: 'investigate', task: null, attempts: 2, usd: 4.44, complete: false }],
      complete: false,
    },
  }));
  const cost = cardFor(root, 'unknown').querySelector('.sa-attempt-cost');
  assert.equal(cost.textContent, 'not available');
  assert.match(cost.title, /No transcript was found/);
  assert.ok(!cardFor(root, 'unknown').textContent.includes('$0.00'));
  assert.match(root.querySelector('.sa-spend-total').textContent, /^at least \$4\.44 total$/);
  assert.match(root.querySelector('.sa-stage-head').textContent, /at least \$4\.44/);
  assert.match(root.querySelector('.sa-jp-meta').textContent, /at least \$4\.44 spent/);
});

test('an unpriced model names itself in the cost tooltip', () => {
  const { root, pane } = mount();
  pane.render(detail({
    attempts: [attempt({
      usage: { state: 'final', knownCostUsd: 0, tokens: { total: 900 }, byModel: { 'mystery-1': { costUsd: null, tokens: 900 } }, unpricedModels: ['mystery-1'], complete: false },
      cost: money(null, false),
    })],
  }));
  const cost = cardFor(root, 'a1').querySelector('.sa-attempt-cost');
  assert.equal(cost.textContent, 'not available');
  assert.match(cost.title, /mystery-1/);
});

test('a gated attempt is paused before launch, with no cost and no "not available"', () => {
  const { root, pane } = mount();
  pane.render(detail({
    attempts: [attempt({ outcome: 'failed', reason: 'folder-changed', pausedBeforeLaunch: true, usage: null, usageNote: null, cost: money(null, true), durationMs: 0 })],
  }));
  const card = cardFor(root, 'a1');
  assert.equal(card.querySelector('.sa-badge').textContent, 'paused before launch');
  assert.ok(card.querySelector('.sa-badge').classList.contains('outcome-paused'));
  assert.equal(card.querySelector('.sa-attempt-cost'), null);
  assert.ok(!card.textContent.includes('not available'));
  assert.ok(!card.textContent.includes('#1/3'));
  assert.match(card.textContent, /not counted/);
  assert.equal(card.querySelector('.sa-attempt-result'), null);
});

test("a live attempt's cost is labelled 'so far'", () => {
  const { root, pane } = mount();
  pane.render(detail({
    status: 'running',
    attempts: [attempt({ outcome: null, live: true, endedAt: null, durationMs: null, startedAt: Date.now() - 120_000, summary: null, cost: money(1.25) })],
  }));
  const card = cardFor(root, 'a1');
  assert.equal(card.querySelector('.sa-badge').textContent, 'running');
  assert.ok(card.querySelector('.sa-badge').classList.contains('outcome-running'));
  assert.equal(card.querySelector('.sa-attempt-cost').textContent, '$1.25 so far');
  assert.match(card.textContent, /2m/);
});

test('an empty job shows no spend panel and no spend in the meta line', () => {
  const { root, pane } = mount();
  pane.render(detail({
    attempts: [],
    spend: { total: money(null), workers: money(null), router: money(null), byPhase: [], byTask: [], byModel: [], complete: true },
  }));
  assert.equal(root.querySelector('.sa-spend'), null);
  assert.ok(!root.querySelector('.sa-jp-meta').textContent.includes('spent'));
  assert.ok(!root.textContent.includes('not available'));
  assert.match(root.querySelector('.sa-attempts').textContent, /No attempts yet/);
});

test('the spend panel lists stages, tasks, models and the router', () => {
  const { root, pane } = mount();
  pane.render(detail({
    spend: {
      total: money(5.45),
      workers: money(5.44),
      router: money(0.01),
      byPhase: [
        { phase: 'investigate', task: null, attempts: 1, usd: 5, complete: true },
        { phase: 'fix', task: 'T1', attempts: 1, usd: 0.44, complete: true },
      ],
      byTask: [{ task: 'T1', usd: 0.44, complete: true }],
      byModel: [
        { model: 'claude-opus-5-5', source: 'worker', tokens: 7_300_000, usd: 5.44, complete: true },
        { model: 'claude-haiku-5-5', source: 'router', tokens: 4000, usd: 0.01, complete: true },
      ],
      complete: true,
    },
  }));
  const spend = root.querySelector('.sa-spend');
  const rows = spend.querySelectorAll('.sa-spend-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /investigate.*\$5\.00/);
  assert.ok(rows[0].classList.contains('sa-stage-0'));
  assert.match(rows[1].textContent, /fix \/ T1.*\$0\.44/);
  assert.ok(rows[1].classList.contains('sa-stage-2'));
  const text = spend.textContent;
  assert.match(text, /T1 \$0\.44/);
  assert.match(text, /opus-5-5 \$5\.44 · 7\.3M tok/);
  assert.match(text, /router \(haiku-5-5\) \$0\.01/);
});

test('artifact chips carry their stage colour, writer and state, and open on click', () => {
  const { root, pane, opened } = mount();
  pane.render(detail({
    artifacts: [
      { key: 'diagnosis', label: 'diagnosis', phase: 'investigate', task: null, state: 'workspace' },
      { key: 'report:T1', label: 'report:T1', phase: 'fix', task: 'T1', state: 'snapshot' },
      { key: 'testReport', label: 'testReport', phase: 'verify', task: null, state: 'gone' },
      { key: 'plan', label: 'plan', phase: null, task: null, state: null },
    ],
  }));
  const chips = root.querySelectorAll('.sa-artifact-chip');
  assert.deepEqual(chips.map((c) => c.textContent), ['diagnosis', 'report:T1', 'testReport', 'plan']);
  assert.ok(chips[0].classList.contains('sa-stage-0'));
  assert.match(chips[0].title, /investigate/);
  assert.ok(chips[1].classList.contains('sa-stage-2'));
  assert.match(chips[1].title, /fix \/ T1/);
  assert.match(chips[1].title, /From snapshot: deleted from the workspace/);
  assert.ok(chips[2].classList.contains('state-gone'));
  assert.match(chips[2].title, /Deleted from the workspace; no snapshot was taken/);
  assert.ok(!chips[3].className.includes('sa-stage-'));
  chips[1].click();
  assert.deepEqual(opened, ['report:T1']);
});

test('renderJobPane keeps expanded attempts across re-render', () => {
  const { root, pane } = mount();
  const d = detail();
  pane.render(d);
  const result = cardFor(root, 'a1').querySelector('.sa-attempt-result');
  assert.ok(!result.classList.contains('expanded'));
  result.click();
  assert.ok(cardFor(root, 'a1').querySelector('.sa-attempt-result').classList.contains('expanded'));
  pane.render(d);
  const again = cardFor(root, 'a1').querySelector('.sa-attempt-result');
  assert.ok(again.classList.contains('expanded'));
  assert.equal(again.getAttribute('aria-expanded'), 'true');
  again.click();
  pane.render(d);
  assert.ok(!cardFor(root, 'a1').querySelector('.sa-attempt-result').classList.contains('expanded'));
});

test('an expanded result renders its full text as markdown with link chips', () => {
  const { root, pane } = mount();
  pane.render(detail({ attempts: [attempt({ summary: 'Root cause:\n\n- **RoundLoader** null\n- see https://github.com/a/b/pull/12' })] }));
  cardFor(root, 'a1').querySelector('.sa-attempt-result').click();
  const result = cardFor(root, 'a1').querySelector('.sa-attempt-result');
  assert.equal(result.querySelectorAll('strong').length, 1);
  assert.equal(result.querySelectorAll('.sa-link-chip').length, 1);
});

test('a refresh with a changed detail keeps expansion and the scroll position of the element that scrolls', () => {
  for (const scroller of ['middle', 'view']) {
    const mounted = mount();
    const { root, pane } = mounted;
    pane.render(detail({ attempts: [attempt({ attemptId: 'a1', outcome: null, live: true, endedAt: null, durationMs: null, summary: 'Working on it' })] }));
    cardFor(root, 'a1').querySelector('.sa-attempt-result').click();
    mounted[scroller].scrollTop = 240;

    pane.render(detail({
      attempts: [
        attempt({ attemptId: 'a1', outcome: 'failed', reason: 'invalid-result: no result.json' }),
        attempt({ attemptId: 'a2', n: 2, summary: 'Second try' }),
      ],
    }));
    assert.equal(mounted[scroller].scrollTop, 240, scroller);
    const first = cardFor(root, 'a1');
    assert.ok(first.querySelector('.sa-badge').classList.contains('outcome-failed'));
    assert.ok(first.querySelector('.sa-attempt-result').classList.contains('expanded'));
    assert.match(first.querySelector('.sa-attempt-result').textContent, /no result\.json/);
    assert.ok(!cardFor(root, 'a2').querySelector('.sa-attempt-result').classList.contains('expanded'));
  }
});

test('selecting another job starts at the top', () => {
  const { root, middle, pane } = mount();
  pane.render(detail());
  middle.scrollTop = 300;
  pane.render(detail({ jobId: 'job-2' }));
  assert.equal(middle.scrollTop, 0);
  assert.ok(root.querySelector('.sa-jp-title'));
});

test('worker text is never parsed as HTML', () => {
  const { root, pane } = mount();
  pane.render(detail({ title: '<img src=x onerror=alert(1)>', attempts: [attempt({ summary: '<script>alert(1)</script>' })] }));
  const html = root.querySelectorAll('div').map((d) => d.toHTML()).join('');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.equal(root.querySelector('.sa-jp-title').textContent, '<img src=x onerror=alert(1)>');
});

test('branches and tasks are still listed', () => {
  const { root, pane } = mount();
  pane.render(detail({ tasks: [{ id: 'T1', title: 'Guard the loader', done: true }, { id: 'T2', title: 'Add a test', done: false }] }));
  assert.match(root.querySelector('.sa-branches').textContent, /FallGuys: superagent\/investigate/);
  assert.match(root.querySelector('.sa-branches').textContent, /in place/);
  const tasks = root.querySelector('.sa-tasks').querySelectorAll('li');
  assert.equal(tasks.length, 2);
  assert.match(tasks[0].textContent, /☑ T1 Guard the loader/);
});

test('renderArtifactBody renders a test report table as a <table>', () => {
  const body = renderArtifactBody({ path: 'docs/test-report.md', text: ['| Test | Result |', '| --- | --- |', '| login | pass |', '', 'See https://example.com/a/1'].join('\n') });
  assert.ok(body.classList.contains('markdown-body'));
  assert.equal(body.querySelectorAll('table').length, 1);
  assert.equal(body.querySelectorAll('td').length, 2);
  assert.equal(body.querySelectorAll('.sa-link-chip').length, 1);
});

test('renderArtifactBody renders JSON pretty-printed', () => {
  const body = renderArtifactBody({ path: 'out/result.json', text: '{"a":1,"b":[2]}' });
  assert.equal(body.tag, 'pre');
  assert.equal(body.querySelector('code').textContent, JSON.stringify({ a: 1, b: [2] }, null, 2));
});

test('renderArtifactBody shows invalid JSON and other files as text', () => {
  assert.equal(renderArtifactBody({ path: 'out/result.json', text: '{"a":' }).textContent, '{"a":');
  const plain = renderArtifactBody({ path: 'notes.txt', text: '# not markdown' });
  assert.equal(plain.tag, 'pre');
  assert.equal(plain.textContent, '# not markdown');
});

test('a deleted artifact says so, while one not written yet does not', () => {
  const gone = artifactErrorText(Object.assign(new Error('x'), { code: 'ERR_ARTIFACT_GONE' }));
  const missing = artifactErrorText(Object.assign(new Error('x'), { code: 'ERR_ARTIFACT_MISSING' }));
  assert.equal(gone, 'Deleted from the workspace; no snapshot was taken');
  assert.ok(!missing.includes('Deleted'));
  assert.match(missing, /^Not written yet/);
});

test('Inspect is disabled without a transcript unless the attempt is live, and calls onInspect otherwise', () => {
  const inspected = [];
  const { root, pane } = mount({ onInspect: (a) => inspected.push(a.attemptId) });
  pane.render(detail({
    attempts: [
      attempt({ attemptId: 'ok' }),
      attempt({ attemptId: 'none', transcript: { available: false }, usageNote: 'pruned' }),
      attempt({ attemptId: 'live', outcome: null, live: true, sessionId: 's9', transcript: { available: false } }),
    ],
  }));
  const inspect = (id) => cardFor(root, id).querySelector('.sa-attempt-inspect');
  assert.equal(inspect('ok').disabled, false);
  assert.equal(inspect('none').disabled, true);
  assert.match(inspect('none').title, /removed from the Claude history/);
  assert.equal(inspect('live').disabled, false);
  assert.match(inspect('live').title, /watch only/);
  inspect('ok').click();
  inspect('live').click();
  assert.deepEqual(inspected, ['ok', 'live']);
});

test('the router log is one card per decision: action badge, scope, model, cost, time and note; no cost shows not available', () => {
  const at = new Date(2026, 10, 19, 14, 5).getTime();
  const router = {
    decisions: [
      { forAttemptId: 'a1', action: 'retry', ok: true, note: 'transient, see https://example.com/x/1', model: 'claude-haiku-5-5', cost: money(0.0123), at },
      { forAttemptId: 'a2', action: 'escalate', ok: true, note: null, model: 'claude-haiku-5-5', cost: money(null, false), at },
      { forAttemptId: 'zzzzzzzzzz', action: null, ok: false, error: 'timeout <b>x</b>', model: null, cost: money(null, false), at: null },
    ],
  };
  const attempts = [attempt({ attemptId: 'a1', phase: 'fix', task: 'T1', n: 2, outcome: 'failed' }), attempt({ attemptId: 'a2', outcome: 'failed' })];
  const list = renderRouterLog(router, attempts);
  const cards = list.querySelectorAll('.sa-router-card');
  assert.equal(cards.length, 3);
  assert.equal(cards[0].querySelector('.sa-badge').textContent, 'retry');
  const first = cards[0].textContent;
  for (const part of ['fix / T1 · attempt 2 failed', 'haiku-5-5', '$0.01', '14:05', 'transient']) assert.ok(first.includes(part), `${part} in ${first}`);
  assert.equal(cards[0].querySelectorAll('.sa-link-chip').length, 1);
  assert.ok(cards[1].textContent.includes('not available'));
  assert.ok(!cards[1].textContent.includes('$0'));
  assert.equal(cards[2].querySelector('.sa-badge').textContent, 'error');
  assert.ok(cards[2].textContent.includes('attempt zzzzzzzz'));
  assert.ok(cards[2].textContent.includes('error: timeout <b>x</b>'));
  assert.equal(renderRouterLog({ decisions: [] }).querySelectorAll('.sa-placeholder').length, 1);
});

const stageRetro = (group) => group.querySelector('.sa-stage-head').querySelector('.sa-retro-btn');
const attemptRetro = (root, id) => cardFor(root, id).querySelector('.sa-retro-btn');

test('stage headers and attempt rows carry Retrospective, calling onRetrospective with their selector', () => {
  const asked = [];
  const { root, pane } = mount({ onRetrospective: (selector) => asked.push(selector) });
  pane.render(detail({
    attempts: [
      attempt({ attemptId: 'i1' }),
      attempt({ attemptId: 'f1', phase: 'fix', task: 'T1', role: 'fixer' }),
      attempt({ attemptId: 'g1', n: null, outcome: 'stopped', pausedBeforeLaunch: true }),
    ],
  }));
  const groups = root.querySelectorAll('.sa-stage-group');
  assert.equal(stageRetro(groups[0]).textContent, 'Retrospective');
  stageRetro(groups[0]).click();
  stageRetro(groups[1]).click();
  attemptRetro(root, 'f1').click();
  assert.deepEqual(asked, [{ phase: 'investigate' }, { phase: 'fix', task: 'T1' }, { attemptId: 'f1' }]);
  assert.equal(attemptRetro(root, 'g1'), null, 'a gated attempt never ran, so it has no Retrospective');
});

test('Retrospective shows Starting… while in flight, the error inline, and the Open recovery link', () => {
  const asked = [];
  const { root, pane } = mount({ onRetrospective: (selector) => asked.push(selector) });
  pane.render(detail());
  const key = JSON.stringify({ attemptId: 'a1' });
  pane.setRetroState(key, { status: 'starting' }, 'job-1');
  assert.equal(attemptRetro(root, 'a1').textContent, 'Starting…');
  assert.equal(attemptRetro(root, 'a1').disabled, true);

  pane.setRetroState(key, { status: 'error', error: 'no transcript was found (ERR_TRANSCRIPT_MISSING)' }, 'job-1');
  assert.equal(attemptRetro(root, 'a1').disabled, false);
  assert.equal(cardFor(root, 'a1').querySelector('.sa-retro-error').textContent, 'no transcript was found (ERR_TRANSCRIPT_MISSING)');

  pane.setRetroState(key, { status: 'pending', name: 'Retro: x · investigate' }, 'job-1');
  const open = cardFor(root, 'a1').querySelector('.sa-retro-open');
  assert.equal(open.textContent, 'Retrospective started: Open');
  assert.equal(cardFor(root, 'a1').querySelector('.sa-retro-error'), null);
  open.click();
  assert.deepEqual(asked, [{ attemptId: 'a1' }]);

  // Another job's state never shows here.
  pane.setRetroState(key, { status: 'starting' }, 'job-2');
  assert.ok(cardFor(root, 'a1').querySelector('.sa-retro-open'));
  pane.setRetroState(key, null, 'job-1');
  assert.equal(attemptRetro(root, 'a1').textContent, 'Retro');
});

test('a pending or blocked Retrospective stays recoverable across a re-render without a second POST', async () => {
  const { createHandoff } = await import('../public/superagent-handoff.js');
  const posts = [];
  const opened = [];
  const handoff = createHandoff({
    win: { location: { origin: 'http://127.0.0.1:4317' }, addEventListener() {}, removeEventListener() {} },
    openWindow: (url) => { opened.push(url); return null; },
    postJson: async (selector) => { posts.push(selector); return { id: 's1', token: 't1', name: 'Retro: x · investigate' }; },
  });
  let pane;
  const runs = [];
  const onRetrospective = (selector) => {
    const key = JSON.stringify(selector);
    pane.setRetroState(key, { status: 'starting' }, 'job-1');
    runs.push(handoff.start(selector).then(({ status, session }) => pane.setRetroState(key, status === 'opened' ? null : { status: 'pending', name: session.name }, 'job-1')));
  };
  const mounted = mount({ onRetrospective });
  pane = mounted.pane;
  const { root } = mounted;
  pane.render(detail());
  stageRetro(root.querySelectorAll('.sa-stage-group')[0]).click();
  await Promise.all(runs);
  assert.equal(posts.length, 1);

  // A poll brings a changed detail: the recovery link is still there.
  pane.render(detail({ attempts: [attempt(), attempt({ attemptId: 'a2', n: 2, outcome: null, live: true })] }));
  const head = root.querySelectorAll('.sa-stage-group')[0].querySelector('.sa-stage-head');
  const open = head.querySelector('.sa-retro-open');
  assert.equal(open.textContent, 'Retrospective started: Open');
  open.click();
  await Promise.all(runs);
  assert.equal(posts.length, 1, 'Open repeats the handoff, never the POST');
  assert.equal(opened.length, 2, 'each click opens a fresh handoff page');
  assert.ok(root.querySelectorAll('.sa-stage-group')[0].querySelector('.sa-stage-head').querySelector('.sa-retro-open'));
});

test('stage groups start folded, a click opens one, and it stays open across a poll', () => {
  const { root, pane } = mount();
  pane.render(detail({ attempts: [attempt({ attemptId: 'i1' }), attempt({ attemptId: 'f1', phase: 'fix', task: 'T1' })] }));
  const lists = () => root.querySelectorAll('.sa-attempt-list');
  const toggles = () => root.querySelectorAll('.sa-stage-toggle');
  assert.deepEqual(lists().map((l) => l.hidden), [true, true]);
  assert.deepEqual(toggles().map((t) => t.getAttribute('aria-expanded')), ['false', 'false']);
  toggles()[1].click();
  assert.deepEqual(lists().map((l) => l.hidden), [true, false]);
  assert.equal(toggles()[1].getAttribute('aria-expanded'), 'true');
  pane.render(detail({ attempts: [attempt({ attemptId: 'i1' }), attempt({ attemptId: 'f1', phase: 'fix', task: 'T1' })] }));
  assert.deepEqual(lists().map((l) => l.hidden), [true, false]);
  toggles()[1].click();
  assert.deepEqual(lists().map((l) => l.hidden), [true, true]);
  pane.render(detail({ jobId: 'job-2', attempts: [attempt({ attemptId: 'f1', phase: 'fix', task: 'T1' })] }));
  assert.equal(lists()[0].hidden, true, "another job's stage starts folded");
});

test('stageState: running while live, the phase chip for a whole phase, else the latest outcome', () => {
  const g = (attempts, task = null) => ({ phase: 'p', task, attempts });
  assert.deepEqual(stageState(g([attempt(), attempt({ outcome: null, live: true })]), { status: 'done' }), { label: 'running', className: 'outcome-running' });
  assert.deepEqual(stageState(g([attempt({ outcome: 'failed' })]), { status: 'done' }), { label: 'done', className: 'outcome-done' });
  assert.deepEqual(stageState(g([attempt({ outcome: 'question' })]), { status: 'waiting' }), { label: 'needs you', className: 'status-needs-you' });
  assert.deepEqual(stageState(g([attempt(), attempt({ outcome: 'failed' })]), { status: 'todo' }), { label: 'failed', className: 'outcome-failed' });
  assert.deepEqual(stageState(g([attempt({ outcome: 'failed' })], 'T1'), { status: 'done' }), { label: 'failed', className: 'outcome-failed' });
  assert.deepEqual(stageState(g([attempt({ pausedBeforeLaunch: true })]), { status: 'todo' }), { label: 'paused before launch', className: 'outcome-paused' });
});

test('Spend is the last card of the job pane', () => {
  const { root, pane } = mount();
  pane.render(detail({ artifacts: [{ key: 'diagnosis', label: 'diagnosis', phase: 'investigate', task: null, state: 'workspace' }] }));
  const cards = root.children.filter((c) => c.classList?.contains('sa-card'));
  assert.ok(cards.at(-1).classList.contains('sa-spend'));
  assert.ok(cards.at(-2).classList.contains('sa-branches'));
});

test("artifactFileName and artifactMimeType name the artifact viewer's download", () => {
  assert.equal(artifactFileName('docs/superpowers/jobs/x/diagnosis.md'), 'diagnosis.md');
  assert.equal(artifactFileName('a\\b\\tasks.json'), 'tasks.json');
  assert.equal(artifactFileName(''), 'artifact.txt');
  assert.equal(artifactMimeType('x/DIAGNOSIS.MD'), 'text/markdown;charset=utf-8');
  assert.equal(artifactMimeType('x/tasks.json'), 'application/json;charset=utf-8');
  assert.equal(artifactMimeType('x/report.txt'), 'text/plain;charset=utf-8');
});
