// The Superagent tab's middle pane: the selected job's header, description,
// workflow timeline, spend, attempts grouped by stage, artifacts, tasks and
// branches. superagent-view.js polls and calls render(detail) every time; the
// pane keeps which attempt results are expanded (by attempt id, like the right
// pane's answer drafts) and puts back the scroll position of whichever
// ancestor scrolls (the middle pane, or #superagentView in the narrow layout),
// so a poll wipes neither.
//
// Built with createElement/textContent only: titles, summaries, reasons and
// questions are worker or operator text. Markdown goes through renderMarkdown,
// which builds DOM nodes and passes every href through isSafeHref first.
//
// The imports are relative on purpose: the browser resolves them to the same
// /markdown.js and /superagent-format.js URLs as a root-absolute specifier,
// while Node (tests/superagent-job-pane.test.mjs) would resolve a root-absolute
// one against the drive root.
import { renderMarkdown } from './markdown.js';
import { formatDuration, formatMoney, formatTokens, linkChip, stageColorIndex, statusLabel } from './superagent-format.js';

const FINISHED = new Set(['done', 'stopped', 'failed']);
const STEP_MARK = { done: '✓', running: '●', waiting: '!' };
const IN_PLACE_FINISHED = "This folder is still on the job's branch.";
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNKNOWN_NOTE = {
  missing: 'No transcript was found for this attempt.',
  ambiguous: 'More than one transcript matched this attempt.',
  pruned: 'Its transcript has been removed from the Claude history.',
  unavailable: 'Its spend has not been read yet.',
};
export const ARTIFACT_STATE = {
  workspace: 'In the workspace',
  snapshot: 'From snapshot: deleted from the workspace',
  gone: 'Deleted from the workspace; no snapshot was taken',
  pending: 'Not written yet',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The modal and the Ready-to-try blocks tell a deleted artifact (its writer
// succeeded, so the file was there once) from one not written yet.
export function artifactErrorText(err) {
  if (err?.code === 'ERR_ARTIFACT_GONE') return ARTIFACT_STATE.gone;
  if (err?.code === 'ERR_ARTIFACT_MISSING') return 'Not written yet: the file does not exist so far.';
  return err?.code ? `${err.message} (${err.code})` : String(err?.message || err);
}

const markdown = (text) => renderMarkdown(text, { autolink: true, renderLink: linkChip });
const scopeLabel = (phase, task) => (task != null ? `${phase} / ${task}` : phase);
const shortModel = (model) => String(model ?? 'unknown').replace(/^claude-/, '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad = (n) => String(n).padStart(2, '0');

function createdText(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// .md renders as Markdown, .json pretty-printed (as text when it does not
// parse, e.g. a truncated file), anything else as preformatted text.
export function renderArtifactBody({ path = '', text = '' }) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith('.md')) {
    const body = el('div', 'sa-markdown markdown-body');
    body.append(markdown(text));
    return body;
  }
  let shown = text;
  let isJson = false;
  if (lower.endsWith('.json')) {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
      isJson = true;
    } catch {
      shown = text;
    }
  }
  const pre = el('pre', 'sa-pre');
  if (isJson) pre.append(el('code', 'sa-json', shown));
  else pre.textContent = shown;
  return pre;
}

function clockText(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The router log: one small card per decision, newest last as persisted.
// `attempts` names the scope each decision routed.
export function renderRouterLog(router, attempts = []) {
  const list = el('ul', 'sa-list sa-router-log');
  for (const d of router?.decisions ?? []) {
    const item = el('li', 'sa-router-card');
    const head = item.appendChild(el('div', 'sa-router-head'));
    head.append(el('span', `sa-badge router-${d.ok ? 'ok' : 'error'}`, d.ok ? d.action : 'error'));
    const a = attempts.find((x) => x.attemptId === d.forAttemptId);
    const scope = a
      ? `${scopeLabel(a.phase, a.task)} · attempt ${a.n}${a.outcome ? ` ${a.outcome}` : ''}`
      : `attempt ${String(d.forAttemptId).slice(0, 8)}`;
    head.append(el('span', 'sa-router-scope', scope));
    const facts = head.appendChild(el('span', 'sa-router-facts'));
    if (d.model) facts.append(el('span', null, shortModel(d.model)));
    facts.append(moneySpan('sa-router-cost', d.cost ?? { usd: null, complete: false }, 'This decision has no recorded cost.'));
    if (d.at != null) facts.append(el('span', null, clockText(d.at)));
    const note = d.ok ? d.note : `error: ${d.error ?? 'unknown'}`;
    if (note) item.appendChild(el('div', 'sa-router-note sa-markdown markdown-body')).append(markdown(note));
    list.append(item);
  }
  if (!list.children.length) list.append(el('li', 'sa-placeholder', 'No decisions yet.'));
  return list;
}

function card(title, className) {
  const box = el('section', `sa-card ${className}`);
  const head = box.appendChild(el('header', 'sa-card-head'));
  head.append(el('h3', 'sa-card-title', title));
  return { box, head };
}

function moneySpan(className, money, why) {
  const text = formatMoney(money);
  const span = el('span', className, text ?? '—');
  if (money && !money.complete) {
    span.classList.add(money.usd === null ? 'unknown' : 'partial');
    span.title = money.usd === null ? why : `A lower bound: part of this is unknown. ${why}`;
  }
  return span;
}

function unknownWhy(a) {
  const unpriced = a.usage?.unpricedModels ?? [];
  if (unpriced.length) return `No price is known for ${unpriced.join(', ')}.`;
  return UNKNOWN_NOTE[a.usageNote] ?? (a.usageNote ? `Spend not available (${a.usageNote}).` : 'Spend not available.');
}

function outcomeOf(a) {
  if (a.pausedBeforeLaunch) return { label: 'paused before launch', kind: 'paused' };
  if (a.outcome == null) return { label: 'running', kind: 'running' };
  return { label: a.outcome, kind: a.outcome };
}

function durationOf(a) {
  if (a.durationMs != null) return formatDuration(a.durationMs);
  if (a.live && a.startedAt != null) return formatDuration(Math.max(0, Date.now() - a.startedAt));
  return null;
}

// The one-line result and its full text: the question, the failure reason
// (with the worker's summary below it when expanded), or the summary, with a
// review's verdict and findings count beside it.
function resultOf(a) {
  if (a.pausedBeforeLaunch) return null;
  if (a.outcome === 'question' && a.question) return { verdict: null, line: a.question, full: a.question };
  const verdict = a.verdict
    ? `${a.verdict}${a.findingsCount != null ? ` · ${plural(a.findingsCount, 'finding')}` : ''}`
    : null;
  if (a.outcome === 'failed' && a.reason) {
    return { verdict, line: a.reason, full: [a.reason, a.summary].filter(Boolean).join('\n\n') };
  }
  if (!a.summary && !verdict) return null;
  return { verdict, line: a.summary, full: a.summary };
}

function costOf(a) {
  if (a.pausedBeforeLaunch) return null;
  const money = a.cost ?? { usd: null, complete: false };
  if (a.live) {
    const span = el('span', 'sa-attempt-cost', money.usd === null ? 'not available yet' : `${formatMoney({ ...money, complete: true })} so far`);
    span.title = money.usd === null ? unknownWhy(a) : 'This worker is still running; its spend so far.';
    if (money.usd === null) span.classList.add('unknown');
    return span;
  }
  if (formatMoney(money) === null) return null;
  return moneySpan('sa-attempt-cost', money, unknownWhy(a));
}

export function createJobPane({ root, onOpenArtifact = () => {}, onInspect = () => {}, stopButton = () => null }) {
  const expanded = new Set();
  let shownJobId = null;

  function stageClassFor(detail) {
    const index = new Map(detail.phases.map((p, i) => [p.phase, i]));
    return (phase) => (index.has(phase) ? `sa-stage-${stageColorIndex(index.get(phase))}` : '');
  }

  function header(detail) {
    const head = el('div', 'sa-jp-head');
    head.append(el('h2', 'sa-jp-title', detail.title), el('span', `sa-badge status-${detail.status}`, statusLabel(detail)));
    if (!FINISHED.has(detail.status)) {
      const stop = stopButton();
      if (stop) head.append(stop);
    }
    const meta = [];
    if (detail.workflow) meta.push(detail.workflow.name);
    if (detail.createdAt != null) meta.push(`created ${createdText(detail.createdAt)}`);
    const inPlace = detail.repos.filter((r) => r.inPlace).map((r) => r.id);
    if (inPlace.length) meta.push(`in place: ${inPlace.join(', ')}`);
    const spent = formatMoney(detail.spend?.total);
    if (spent) meta.push(spent === 'not available' ? 'spend not available' : `${spent} spent`);
    return [head, el('div', 'sa-jp-meta', meta.join(' · '))];
  }

  function description(detail) {
    const { box } = card('Description', 'sa-description');
    box.appendChild(el('div', 'sa-markdown markdown-body')).append(markdown(detail.idea));
    return box;
  }

  function timeline(detail) {
    const { box } = card(detail.workflow?.name ?? 'Workflow', 'sa-timeline-card');
    const list = box.appendChild(el('ol', 'sa-timeline'));
    detail.phases.forEach((p, i) => {
      if (i) {
        const arrow = el('li', 'sa-step-arrow', '→');
        arrow.setAttribute('aria-hidden', 'true');
        list.append(arrow);
      }
      const step = el('li', `sa-step sa-stage-${stageColorIndex(i)} step-${p.status}`);
      step.title = `${p.phase} · ${p.kind} · ${p.status}`;
      step.append(el('span', 'sa-step-name', p.phase));
      if (STEP_MARK[p.status]) step.append(el('span', 'sa-step-mark', STEP_MARK[p.status]));
      list.append(step);
    });
    return box;
  }

  function spendCard(spend, stageClass) {
    if (!spend || (!spend.byPhase.length && !spend.byModel.length)) return null;
    const { box, head } = card('Spend', 'sa-spend');
    const total = moneySpan('sa-spend-total', spend.total, 'Some attempts have no readable transcript or use an unpriced model.');
    total.textContent = `${total.textContent} total`;
    head.append(total);
    const max = Math.max(0, ...spend.byPhase.map((r) => r.usd ?? 0));
    const rows = box.appendChild(el('ul', 'sa-spend-rows'));
    for (const r of spend.byPhase) {
      const row = el('li', `sa-spend-row ${stageClass(r.phase)}`);
      row.append(el('span', 'sa-spend-label', scopeLabel(r.phase, r.task)));
      const fill = row.appendChild(el('span', 'sa-spend-bar')).appendChild(el('span', 'sa-spend-fill'));
      fill.style.width = `${max > 0 ? Math.max(1, Math.round(((r.usd ?? 0) / max) * 100)) : 0}%`;
      row.append(moneySpan('sa-spend-amount', r, `Part of ${plural(r.attempts, 'attempt')} here has no known spend.`));
      rows.append(row);
    }
    const line = (label, items) => {
      const div = box.appendChild(el('div', 'sa-spend-line'));
      div.append(el('span', 'sa-spend-line-label', label), ...items);
    };
    if (spend.byTask.length) {
      line('By task', spend.byTask.map((t) => {
        const item = el('span', 'sa-spend-item', `${t.task} `);
        item.append(moneySpan('sa-spend-money', t, 'Part of this task has no known spend.'));
        return item;
      }));
    }
    if (spend.byModel.length) {
      line('By model', spend.byModel.map((m) => {
        const router = m.source === 'router';
        const item = el('span', 'sa-spend-item', router ? `router (${shortModel(m.model)}) ` : `${shortModel(m.model)} `);
        item.title = m.model;
        item.append(moneySpan('sa-spend-money', m, router ? 'A router decision has no recorded cost.' : 'This model has no known price.'));
        if (!router && m.tokens) item.append(` · ${formatTokens(m.tokens)} tok`);
        return item;
      }));
    }
    return box;
  }

  function fillResult(node, a, result) {
    const open = expanded.has(a.attemptId);
    node.replaceChildren();
    node.classList.toggle('expanded', open);
    node.setAttribute('aria-expanded', String(open));
    node.title = open ? 'Click to collapse' : 'Click to show the full text';
    if (result.verdict) node.append(el('span', 'sa-attempt-verdict', result.verdict));
    if (open) node.appendChild(el('div', 'sa-markdown markdown-body')).append(markdown(result.full ?? result.line ?? ''));
    else if (result.line) node.append(el('span', 'sa-attempt-text', result.line));
  }

  function resultEl(a, result) {
    const node = el('div', 'sa-attempt-result');
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    const toggle = () => {
      if (expanded.has(a.attemptId)) expanded.delete(a.attemptId);
      else expanded.add(a.attemptId);
      fillResult(node, a, result);
    };
    node.addEventListener('click', (event) => {
      if (event.target?.closest?.('a')) return;
      toggle();
    });
    node.addEventListener('keydown', (event) => {
      if (event.target !== node || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      toggle();
    });
    fillResult(node, a, result);
    return node;
  }

  // A live attempt opens its watch-only tab; a finished one needs a transcript.
  function inspectButton(a) {
    const watchable = a.live && Boolean(a.sessionId);
    const button = el('button', 'btn btn-ghost sa-attempt-inspect', 'Inspect');
    button.type = 'button';
    if (watchable) button.title = 'Watch this worker in a new tab (watch only)';
    else if (a.transcript?.available) button.title = "Open this attempt's transcript";
    else {
      button.disabled = true;
      button.title = UNKNOWN_NOTE[a.usageNote] ?? 'No transcript is available for this attempt.';
    }
    button.addEventListener('click', () => onInspect(a));
    return button;
  }

  function attemptCard(a) {
    const item = el('li', 'sa-attempt-card');
    item.dataset.attemptId = a.attemptId;
    if (a.live) item.classList.add('live');
    if (a.retried) item.classList.add('retried');
    const line = item.appendChild(el('div', 'sa-attempt-line'));
    const outcome = outcomeOf(a);
    line.append(el('span', `sa-badge outcome-${outcome.kind}`, outcome.label));
    // A gated attempt never launched and takes no attempt number.
    if (!a.pausedBeforeLaunch) line.append(el('span', 'sa-attempt-n', `#${a.n}/${a.cap ?? '?'}`));
    line.append(el('span', 'sa-attempt-role', a.role ?? 'worker'));
    const facts = [shortModel(a.model)];
    if (a.round != null) facts.push(`round ${a.round}`);
    if (a.task != null) facts.push(`task ${a.task}`);
    if (a.pausedBeforeLaunch) facts.push('folder changed', 'not counted');
    else {
      const duration = durationOf(a);
      if (duration) facts.push(duration);
      if (a.usage?.tokens?.total != null) facts.push(`${formatTokens(a.usage.tokens.total)} tok`);
      if (a.commits) facts.push(plural(a.commits, 'commit'));
    }
    const factsEl = line.appendChild(el('span', 'sa-attempt-facts', facts.join(' · ')));
    factsEl.title = a.model ?? '';
    // A Retry restarts the count, so the attempts it left behind say so.
    if (a.retried) line.append(el('span', 'sa-attempt-flag', 'retried, not counted'));
    const cost = costOf(a);
    if (cost) line.append(cost);
    line.append(inspectButton(a));
    const result = resultOf(a);
    if (result) item.append(resultEl(a, result));
    return item;
  }

  function attemptsCard(detail, stageClass) {
    const { box } = card('Attempts', 'sa-attempts');
    if (!detail.attempts.length) {
      box.append(el('div', 'sa-placeholder', 'No attempts yet.'));
      return box;
    }
    const order = new Map(detail.phases.map((p, i) => [p.phase, i]));
    const groups = new Map();
    for (const a of detail.attempts) {
      const key = JSON.stringify([a.phase, a.task ?? null]);
      if (!groups.has(key)) groups.set(key, { phase: a.phase, task: a.task ?? null, attempts: [] });
      groups.get(key).attempts.push(a);
    }
    const rank = (g) => order.get(g.phase) ?? Number.MAX_SAFE_INTEGER;
    for (const g of [...groups.values()].sort((x, y) => rank(x) - rank(y))) {
      const group = box.appendChild(el('div', 'sa-stage-group'));
      const head = group.appendChild(el('div', `sa-stage-head ${stageClass(g.phase)}`));
      head.append(el('span', 'sa-stage-name', scopeLabel(g.phase, g.task)));
      const counted = g.attempts.filter((a) => !a.pausedBeforeLaunch).length;
      const facts = head.appendChild(el('span', 'sa-stage-facts', ` · ${plural(counted, 'attempt')}`));
      const spent = detail.spend?.byPhase.find((r) => r.phase === g.phase && (r.task ?? null) === g.task);
      if (formatMoney(spent)) {
        facts.append(' · ');
        facts.append(moneySpan('sa-stage-money', spent, 'Part of this stage has no known spend.'));
      }
      const list = group.appendChild(el('ol', 'sa-attempt-list'));
      for (const a of g.attempts) list.append(attemptCard(a));
    }
    return box;
  }

  function artifactsCard(detail, stageClass) {
    const { box } = card('Artifacts', 'sa-artifacts-card');
    const chips = box.appendChild(el('div', 'sa-artifacts'));
    for (const a of detail.artifacts) {
      const chip = el('button', 'sa-artifact-chip', a.label);
      chip.type = 'button';
      const stage = stageClass(a.phase);
      if (stage) chip.classList.add(stage);
      if (a.state) chip.classList.add(`state-${a.state}`);
      const writer = a.phase ? `Written by ${scopeLabel(a.phase, a.task)}` : null;
      chip.title = [writer, ARTIFACT_STATE[a.state]].filter(Boolean).join(' · ') || a.key;
      chip.addEventListener('click', () => onOpenArtifact(a.key));
      chips.append(chip);
    }
    return box;
  }

  function tasksCard(detail) {
    const { box } = card('Tasks', 'sa-tasks');
    const list = box.appendChild(el('ul', 'sa-list'));
    for (const t of detail.tasks) list.append(el('li', t.done ? 'done' : null, `${t.done ? '☑' : '☐'} ${t.id} ${t.title}`));
    if (!detail.tasks.length) list.append(el('li', 'sa-placeholder', 'No tasks.'));
    return box;
  }

  function branchesCard(detail) {
    const { box } = card('Branches', 'sa-branches');
    const list = box.appendChild(el('ul', 'sa-list'));
    for (const r of detail.repos) {
      const item = list.appendChild(el('li', null, `${r.id}: ${detail.branch ?? '—'}`));
      if (r.inPlace) item.append(' ', el('span', 'sa-marker', 'in place'));
      item.append(' ', el('span', 'sa-muted', r.origin));
      if (r.inPlace && FINISHED.has(detail.status)) item.append(el('div', 'sa-note', IN_PLACE_FINISHED));
    }
    return box;
  }

  function build(detail) {
    const stageClass = stageClassFor(detail);
    return [
      ...header(detail),
      detail.idea ? description(detail) : null,
      detail.phases.length ? timeline(detail) : null,
      spendCard(detail.spend, stageClass),
      attemptsCard(detail, stageClass),
      detail.artifacts.length ? artifactsCard(detail, stageClass) : null,
      detail.tasks ? tasksCard(detail) : null,
      detail.repos.length ? branchesCard(detail) : null,
    ].filter(Boolean);
  }

  function render(detail) {
    // Only the same job keeps its place; another job starts at the top.
    const saved = [];
    if (detail.jobId === shownJobId) for (let n = root; n; n = n.parentElement) saved.push([n, n.scrollTop]);
    root.replaceChildren(...build(detail));
    for (const [node, top] of saved) if (node.scrollTop !== top) node.scrollTop = top;
    shownJobId = detail.jobId;
  }

  return { render };
}
