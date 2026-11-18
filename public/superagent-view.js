// The Superagent tab (/?view=superagent, chosen by entry.js before app.js and
// its session bootstrap could run). Three panes: jobs and the New job form;
// the selected job's phases, tasks, attempts and artifacts; and what the job
// needs from you plus its router log.
//
// A POLL, like the bell: GET /api/superagent and the selected job every 5s
// while the tab is visible. Panes render only while the host is `ready`;
// every other host state is a one-line notice.
//
// Everything is built with createElement/textContent, never innerHTML: job
// titles, questions, stuck details and artifacts are all text a worker or the
// operator wrote.
import { initOperatorGate } from '/operator-auth.js';
import { initDirBrowser } from '/dir-browser.js';
import { initNotificationsPanel, requestBrowserNotifications, SUPERAGENT_TAB, SUPERAGENT_SELECT_MESSAGE } from '/notifications-panel.js';

const POLL_MS = 5_000;
const ANSWER_MAX_CHARS = 4000;
const ASSUMPTIONS_HEADING = '## Assumptions made for you';
const FINISHED = new Set(['done', 'stopped', 'failed']);
const STATUS_LABEL = {
  running: 'running', 'needs-you': 'needs you', done: 'done', stopped: 'stopped', failed: 'failed', provisioning: 'provisioning',
};
const CHIP_MARK = { done: ' ✓', running: ' ●', waiting: ' !', todo: '' };
const IN_PLACE_LABEL = 'Use this folder directly (no new worktree)';
const IN_PLACE_NOTE = "The job switches this folder to its own branch and works there. Don't work in this folder while the job runs.";
const IN_PLACE_FINISHED = "This folder is still on the job's branch.";
const READY_LABEL = { testReport: 'Test report' };

const statusLabel = (job) => (job.reason === 'folder-changed' && job.status === 'needs-you' ? 'paused' : (STATUS_LABEL[job.status] ?? job.status));

function firstError(workflow) {
  const e = workflow.errors?.[0];
  if (!e) return 'invalid';
  return e.path ? `${e.path}: ${e.message}` : e.message;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const b = el('button', className ? `btn ${className}` : 'btn', text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, code: data.code });
  return data;
}

const postJson = (url, payload = {}) => getJson(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const errorText = (err) => (err?.code ? `${err.message} (${err.code})` : String(err?.message || err));

// The brief's section, from its heading to the next `## ` heading.
function briefSection(text, heading = ASSUMPTIONS_HEADING) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

function sortJobs(jobs) {
  const finished = (j) => (FINISHED.has(j.status) ? 1 : 0);
  return [...jobs].sort((a, b) => finished(a) - finished(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function initSuperagentView() {
  const root = document.getElementById('superagentView');
  const notice = root.appendChild(el('div', 'sa-notice'));
  const panes = root.appendChild(el('div', 'sa-panes'));
  const left = panes.appendChild(el('section', 'sa-pane sa-left'));
  const middle = panes.appendChild(el('section', 'sa-pane sa-middle'));
  const right = panes.appendChild(el('section', 'sa-pane sa-right'));

  let status = null;
  let jobs = [];
  let selectedId = new URL(location.href).searchParams.get('job');
  let detail = null;
  let detailError = null;
  let refreshing = null;
  let pollAgain = false;
  const artifactCache = new Map();
  // Draft answers by needs-you key, so switching jobs and back keeps them.
  const answerDrafts = new Map();

  document.title = 'Superagent - Prompt Cockpit';
  // Lets other tabs' bell, Superagent button and notification clicks find
  // this tab (openSuperagentView), which then asks it to select a job instead
  // of reloading it.
  window.name = SUPERAGENT_TAB;
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== SUPERAGENT_SELECT_MESSAGE) return;
    if (typeof event.data.jobId === 'string') select(event.data.jobId);
  });

  const gate = initOperatorGate({
    banner: document.getElementById('operatorGate'),
    input: document.getElementById('operatorTokenInput'),
    saveBtn: document.getElementById('operatorTokenSave'),
    onSaved: () => refresh(),
  });

  const superagentBtn = document.getElementById('superagentBtn');
  superagentBtn.addEventListener('click', () => select(null));
  initNotificationsPanel({
    button: document.getElementById('notificationsBtn'),
    panel: document.getElementById('notificationsPanel'),
    headerEl: document.querySelector('.app-header'),
    superagentButton: superagentBtn,
    // This tab has no auto-pilot pane; a pilot entry opens a regular Cockpit tab.
    onOpenPilots: () => window.open('/', '_blank'),
    // A superagent entry selects its job here, never reloading this tab.
    onOpenSuperagent: (jobId) => {
      window.focus();
      select(jobId);
    },
  });

  const dirBrowser = initDirBrowser({
    modal: document.getElementById('dirBrowserModal'),
    pathLabel: document.getElementById('dirPath'),
    list: document.getElementById('dirList'),
    upButton: document.getElementById('dirUpBtn'),
    selectButton: document.getElementById('dirSelectBtn'),
    cancelButton: document.getElementById('dirCancelBtn'),
    onSelect: () => {},
  });

  // --- Left: New job form (built once, so a poll never wipes a draft) ---

  left.append(el('h2', 'sa-heading', 'Jobs'));
  const newJobBtn = left.appendChild(button('+ New job', 'btn-primary', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) {
      ideaInput.focus();
      loadWorkflows();
    }
  }));
  newJobBtn.title = 'Create a new superagent job';

  const form = left.appendChild(el('form', 'sa-form'));
  form.hidden = true;
  const ideaInput = el('textarea');
  ideaInput.required = true;
  ideaInput.rows = 4;
  ideaInput.placeholder = 'What should be built?';
  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Optional - taken from the idea when empty';
  const primaryInput = el('input');
  primaryInput.type = 'text';
  primaryInput.placeholder = '/path/to/repo';
  primaryInput.required = true;
  const extraList = el('ul', 'sa-folder-list');
  const extraFolders = [];
  const formError = el('div', 'sa-error');
  formError.hidden = true;
  const createBtn = el('button', 'btn btn-primary', 'Create job');
  createBtn.type = 'submit';

  const field = (label, ...controls) => {
    const row = el('label', 'sa-field');
    row.append(el('span', 'sa-field-label', label), ...controls);
    return row;
  };
  // The checkbox's note shows only while it is checked; sync() re-reads it
  // after form.reset() unchecks it without a change event.
  function inPlaceToggle(checked, onToggle = () => {}) {
    const box = el('div', 'sa-in-place');
    const label = box.appendChild(el('label', 'sa-check'));
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    label.append(input, el('span', null, IN_PLACE_LABEL));
    const note = box.appendChild(el('div', 'sa-note', IN_PLACE_NOTE));
    const sync = () => { note.hidden = !input.checked; };
    input.addEventListener('change', () => {
      sync();
      onToggle(input.checked);
    });
    sync();
    return { box, input, sync };
  }

  const primaryRow = el('div', 'sa-folder-row');
  primaryRow.append(primaryInput, button('Browse', '', () => dirBrowser.open(primaryInput.value.trim(), (p) => {
    primaryInput.value = p;
    loadWorkflows();
  })));
  const primaryInPlace = inPlaceToggle(false);
  primaryInput.addEventListener('change', () => loadWorkflows());

  function renderExtraFolders() {
    extraList.textContent = '';
    extraFolders.forEach((folder, i) => {
      const li = el('li', 'sa-folder-item');
      const row = li.appendChild(el('div', 'sa-folder-row'));
      row.append(el('span', 'sa-path', folder.path), button('Remove', '', () => {
        extraFolders.splice(i, 1);
        renderExtraFolders();
      }));
      li.append(inPlaceToggle(folder.inPlace, (on) => { folder.inPlace = on; }).box);
      extraList.append(li);
    });
  }
  const addFolderBtn = button('+ Add folder', '', () => dirBrowser.open(primaryInput.value.trim(), (p) => {
    extraFolders.push({ path: p, inPlace: false });
    renderExtraFolders();
  }));

  // Workflow select: listed for the primary folder (project workflows live
  // in it), so it is refetched whenever that folder changes. `workflowFor` is
  // the folder the shown list belongs to; a stale response is dropped.
  const workflowSelect = el('select');
  const workflowHint = el('div', 'sa-note');
  const workflowNotes = el('div');
  let workflowFor = null;
  let workflowTicket = 0;

  function placeholderOption(text) {
    const option = el('option', null, text);
    option.value = '';
    return option;
  }

  function showWorkflowPlaceholder(text) {
    workflowSelect.textContent = '';
    workflowSelect.append(placeholderOption(text));
    workflowSelect.disabled = true;
    workflowSelect.required = false;
    workflowHint.textContent = '';
    workflowNotes.textContent = '';
  }

  function describeWorkflow(entries) {
    const chosen = entries.find((w) => w.id === workflowSelect.value);
    workflowHint.textContent = chosen?.description ?? '';
  }

  function renderWorkflows(listing, previous) {
    const entries = listing.workflows ?? [];
    const usable = (id) => entries.some((w) => w.id === id && w.valid);
    workflowSelect.textContent = '';
    workflowNotes.textContent = '';
    for (const w of entries) {
      const option = el('option', null, `${w.name} (${w.source})${w.valid ? '' : ' - invalid'}`);
      option.value = w.id ?? '';
      option.disabled = !w.valid || w.id == null;
      option.title = w.valid ? w.description : firstError(w);
      workflowSelect.append(option);
    }
    const pick = usable(previous) ? previous : (usable(listing.default) ? listing.default : '');
    if (!pick) workflowSelect.prepend(placeholderOption('Choose a workflow'));
    workflowSelect.value = pick;
    workflowSelect.disabled = false;
    workflowSelect.required = true;

    if (listing.defaultNote) workflowNotes.append(el('div', 'sa-note', `Default workflow: ${listing.defaultNote}`));
    if (!usable(listing.default)) {
      const entry = entries.find((w) => w.id === listing.default);
      workflowNotes.append(el('div', 'sa-error', entry
        ? `The default workflow "${entry.name}" is invalid: ${firstError(entry)}`
        : `The default workflow "${listing.default}" is not available`));
    }
    const invalid = entries.filter((w) => !w.valid);
    if (invalid.length) {
      const list = workflowNotes.appendChild(el('ul', 'sa-list sa-note'));
      for (const w of invalid) list.append(el('li', null, `Invalid: ${w.name} (${w.source}) - ${firstError(w)}`));
    }
    describeWorkflow(entries);
    workflowSelect.onchange = () => describeWorkflow(entries);
  }

  async function loadWorkflows() {
    const primary = primaryInput.value.trim();
    if (primary === workflowFor) return;
    workflowFor = primary;
    const ticket = ++workflowTicket;
    const previous = workflowSelect.value;
    if (!primary) {
      showWorkflowPlaceholder('Choose a primary folder first');
      return;
    }
    showWorkflowPlaceholder('Loading…');
    try {
      const listing = await getJson(`/api/superagent/workflows?primary=${encodeURIComponent(primary)}`);
      if (ticket === workflowTicket) renderWorkflows(listing, previous);
    } catch (err) {
      if (ticket !== workflowTicket) return;
      workflowFor = null;
      showWorkflowPlaceholder('No workflows listed');
      workflowNotes.append(el('div', 'sa-error', errorText(err)));
    }
  }
  showWorkflowPlaceholder('Choose a primary folder first');

  function resetForm() {
    form.reset();
    primaryInPlace.sync();
    extraFolders.length = 0;
    renderExtraFolders();
    workflowFor = null;
    workflowTicket++;
    showWorkflowPlaceholder('Choose a primary folder first');
  }

  const actions = el('div', 'sa-actions');
  actions.append(createBtn, button('Cancel', '', () => { form.hidden = true; }));
  form.append(
    field('Idea', ideaInput),
    field('Title', titleInput),
    field('Primary folder', primaryRow),
    primaryInPlace.box,
    field('Workflow', workflowSelect),
    workflowHint,
    workflowNotes,
    el('div', 'sa-field-label', 'Additional folders'),
    extraList,
    addFolderBtn,
    el('div', 'sa-mode', 'Mode: Automatic'),
    formError,
    actions,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formError.hidden = true;
    createBtn.disabled = true;
    const primaryRepo = primaryInput.value.trim();
    const payload = {
      idea: ideaInput.value,
      title: titleInput.value,
      primaryRepo,
      additionalRepos: extraFolders.map((f) => f.path),
      inPlace: [...(primaryInPlace.input.checked ? [primaryRepo] : []), ...extraFolders.filter((f) => f.inPlace).map((f) => f.path)],
    };
    // A list shown for another folder, or none at all, leaves the choice to
    // the server's default.
    if (workflowFor === primaryRepo && !workflowSelect.disabled && workflowSelect.value) payload.workflow = workflowSelect.value;
    try {
      const job = await postJson('/api/superagent/jobs', payload);
      resetForm();
      form.hidden = true;
      select(job.jobId);
    } catch (err) {
      formError.textContent = errorText(err);
      formError.hidden = false;
    } finally {
      createBtn.disabled = false;
    }
  });

  const jobList = left.appendChild(el('div', 'sa-job-list'));

  function renderJobList() {
    jobList.textContent = '';
    if (!jobs.length) {
      jobList.append(el('div', 'sa-placeholder', 'No jobs yet.'));
      return;
    }
    for (const job of sortJobs(jobs)) {
      const row = el('button', `sa-job-row status-${job.status}`);
      row.type = 'button';
      if (job.jobId === selectedId) row.classList.add('selected');
      row.append(el('span', 'sa-job-title', job.title));
      const meta = el('span', 'sa-job-meta');
      if (job.phaseId) meta.append(el('span', 'sa-job-phase', job.phaseId));
      if (job.workflow) meta.append(el('span', 'sa-job-workflow', job.workflow.name));
      meta.append(el('span', 'sa-status', statusLabel(job)));
      row.append(meta);
      row.addEventListener('click', () => select(job.jobId));
      jobList.append(row);
    }
  }

  // --- Middle: the selected job ---

  const middleError = middle.appendChild(el('div', 'sa-error'));
  middleError.hidden = true;
  const middleBody = middle.appendChild(el('div'));

  function showError(target, err) {
    target.textContent = err ? errorText(err) : '';
    target.hidden = !err;
  }

  async function act(name, target, payload = {}) {
    const jobId = selectedId;
    showError(target, null);
    try {
      await postJson(`/api/superagent/jobs/${encodeURIComponent(jobId)}/${name}`, payload);
      return true;
    } catch (err) {
      showError(target, err);
      return false;
    } finally {
      await refresh();
    }
  }

  function stopButton(target) {
    const stop = button('Stop job', 'btn-danger', async () => {
      if (!confirm('Stop this job? Its live worker is closed and the job cannot be resumed. Its worktree and branch are kept.')) return;
      stop.disabled = true;
      if (!(await act('stop', target))) stop.disabled = false;
    });
    return stop;
  }

  function section(title) {
    const box = el('div', 'sa-section');
    box.append(el('h3', 'sa-subheading', title));
    return box;
  }

  function branchLine(repo) {
    const li = el('li', null, `${repo.id}: ${detail.branch ?? '—'}`);
    if (repo.inPlace) li.append(' ', el('span', 'sa-marker', 'in place'));
    return li;
  }

  function openWorker(sessionId) {
    window.open(`/?attach=${encodeURIComponent(sessionId)}`, '_blank');
  }

  function attemptRow(a) {
    const row = el('li', 'sa-attempt');
    const scope = [a.phase, a.task].filter(Boolean).join(' / ');
    // A gated attempt never launched and takes no attempt number, so the
    // launch after it reuses its n; it must not read as a second attempt n.
    const parts = a.pausedBeforeLaunch
      ? [a.role, a.model, 'paused before launch (folder changed)', 'not counted']
      : [a.role, a.model, a.outcome ?? 'running', `${a.n}/${a.cap ?? '?'}`];
    if (a.round != null) parts.push(`round ${a.round}`);
    row.append(el('span', 'sa-attempt-scope', scope), el('span', 'sa-attempt-meta', parts.join(' · ')));
    if (a.live && a.sessionId) {
      const open = button('open', '', () => openWorker(a.sessionId));
      open.title = 'Watch this worker in a new tab (watch only)';
      row.append(open);
    }
    return row;
  }

  function renderMiddle() {
    middleBody.textContent = '';
    if (!selectedId) {
      middleBody.append(el('div', 'sa-placeholder', 'Select a job, or create one with + New job.'));
      return;
    }
    if (detailError && !detail) {
      middleBody.append(el('div', 'sa-error', errorText(detailError)));
      return;
    }
    if (!detail) {
      middleBody.append(el('div', 'sa-placeholder', 'Loading…'));
      return;
    }
    const head = el('div', 'sa-job-head');
    head.append(el('h2', 'sa-heading', detail.title), el('span', `sa-status status-${detail.status}`, statusLabel(detail)));
    if (!FINISHED.has(detail.status)) head.append(stopButton(middleError));
    middleBody.append(head);
    if (detail.workflow) middleBody.append(el('div', 'sa-note', `Workflow: ${detail.workflow.name}`));
    if (detail.idea) middleBody.append(el('div', 'sa-idea', detail.idea));

    if (detail.phases.length) {
      const chips = el('div', 'sa-chips');
      for (const p of detail.phases) {
        const chip = el('span', `sa-chip chip-${p.status}`, `${p.phase}${CHIP_MARK[p.status] ?? ''}`);
        chip.title = `${p.kind} · ${p.status}`;
        chips.append(chip);
      }
      middleBody.append(chips);
    }

    if (detail.repos.length) {
      const box = section('Branches');
      const list = el('ul', 'sa-list');
      for (const r of detail.repos) {
        const li = branchLine(r);
        li.append(` (${r.origin})`);
        if (r.inPlace && FINISHED.has(detail.status)) li.append(el('div', 'sa-note', IN_PLACE_FINISHED));
        list.append(li);
      }
      box.append(list);
      middleBody.append(box);
    }

    if (detail.tasks) {
      const box = section('Tasks');
      const list = el('ul', 'sa-list sa-tasks');
      for (const t of detail.tasks) list.append(el('li', t.done ? 'done' : null, `${t.done ? '☑' : '☐'} ${t.id} ${t.title}`));
      if (!detail.tasks.length) list.append(el('li', 'sa-placeholder', 'No tasks.'));
      box.append(list);
      middleBody.append(box);
    }

    const attempts = section('Attempts');
    const list = el('ul', 'sa-list');
    for (const a of detail.attempts) list.append(attemptRow(a));
    if (!detail.attempts.length) list.append(el('li', 'sa-placeholder', 'No attempts yet.'));
    attempts.append(list);
    middleBody.append(attempts);

    if (detail.artifacts.length) {
      const box = section('Artifacts');
      const links = el('div', 'sa-artifacts');
      for (const a of detail.artifacts) links.append(button(a.label, 'btn-ghost', () => openArtifact(detail.jobId, a.key)));
      box.append(links);
      middleBody.append(box);
    }
  }

  // --- Artifact viewer (read-only, plain text) ---

  const viewer = document.getElementById('superagentArtifactModal');
  const viewerTitle = document.getElementById('superagentArtifactTitle');
  const viewerText = document.getElementById('superagentArtifactText');
  const viewerNote = document.getElementById('superagentArtifactNote');
  document.getElementById('superagentArtifactClose').addEventListener('click', () => viewer.close());

  const artifactUrl = (jobId, key) => `/api/superagent/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(key)}`;

  async function openArtifact(jobId, key) {
    viewerTitle.textContent = key;
    viewerText.textContent = 'Loading…';
    viewerNote.hidden = true;
    if (!viewer.open) viewer.showModal();
    try {
      const artifact = await getJson(artifactUrl(jobId, key));
      viewerTitle.textContent = `${key} · ${artifact.path}`;
      viewerText.textContent = artifact.text;
      viewerNote.textContent = 'Truncated: only the first part of this file is shown.';
      viewerNote.hidden = !artifact.truncated;
    } catch (err) {
      viewerText.textContent = errorText(err);
    }
  }

  // Ready to try shows two artifacts inline; each is fetched once per
  // needs-you entry, then the pane re-renders. A failed fetch is shown, then
  // dropped by the next poll (dropFailedArtifacts) so it is tried again.
  function cachedArtifact(jobId, entryKey, key) {
    const cacheKey = `${entryKey}|${key}`;
    if (!artifactCache.has(cacheKey)) {
      artifactCache.set(cacheKey, null);
      getJson(artifactUrl(jobId, key))
        .then((a) => ({ text: a.text }), (err) => ({ error: errorText(err) }))
        .then((value) => {
          artifactCache.set(cacheKey, value);
          renderRight();
        });
    }
    return artifactCache.get(cacheKey);
  }

  function dropFailedArtifacts() {
    for (const [cacheKey, value] of artifactCache) if (value?.error) artifactCache.delete(cacheKey);
  }

  // --- Right: needs you, router, browser notifications ---

  const notifyRow = right.appendChild(el('div', 'sa-notify'));
  const rightError = right.appendChild(el('div', 'sa-error'));
  rightError.hidden = true;
  const needsYouBox = right.appendChild(el('div'));
  const routerBox = right.appendChild(el('div'));
  let needsYouShown = null;

  function renderNotifyControl() {
    notifyRow.textContent = '';
    if (typeof Notification === 'undefined') {
      notifyRow.append(el('span', 'sa-muted', 'Browser notifications are not supported here'));
    } else if (Notification.permission === 'denied') {
      notifyRow.append(el('span', 'sa-muted', 'Blocked in browser settings'));
    } else if (Notification.permission === 'default') {
      notifyRow.append(button('Enable browser notifications', '', async () => {
        await requestBrowserNotifications();
        renderNotifyControl();
      }));
    }
    notifyRow.hidden = !notifyRow.childNodes.length;
  }

  function preBlock(text, className = 'sa-pre') {
    return el('pre', className, text);
  }

  function artifactBlock(label, value, pick = (text) => text) {
    const box = el('div', 'sa-section');
    box.append(el('h4', 'sa-subheading', label));
    if (value == null) box.append(el('div', 'sa-placeholder', 'Loading…'));
    else if (value.error) box.append(el('div', 'sa-error', value.error));
    else box.append(preBlock(pick(value.text) ?? 'Not in the brief.'));
    return box;
  }

  function stuckLines(detailObj) {
    return Object.entries(detailObj ?? {})
      .filter(([key, value]) => key !== 'why' && value != null)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  function buildNeedsYou(needsYou) {
    const box = el('div', 'sa-needs-you');
    if (needsYou.type === 'question') {
      box.append(el('h3', 'sa-subheading', 'Question'), preBlock(needsYou.text, 'sa-question'));
      if (needsYou.answerable) {
        const input = el('textarea', 'sa-answer');
        input.maxLength = ANSWER_MAX_CHARS;
        input.rows = 5;
        input.placeholder = 'Your answer';
        input.value = answerDrafts.get(needsYou.key) ?? '';
        const send = button('Send', 'btn-primary', async () => {
          send.disabled = true;
          if (await act('answer', rightError, { text: input.value, needsYouSeq: needsYou.seq })) answerDrafts.delete(needsYou.key);
          else send.disabled = !input.value.trim();
        });
        send.disabled = !input.value.trim();
        input.addEventListener('input', () => {
          answerDrafts.set(needsYou.key, input.value);
          send.disabled = !input.value.trim();
        });
        const row = el('div', 'sa-actions');
        row.append(send, stopButton(rightError));
        box.append(input, row);
      } else {
        box.appendChild(el('div', 'sa-actions')).append(stopButton(rightError));
      }
    } else if (needsYou.type === 'ready-to-try') {
      box.append(el('h3', 'sa-subheading', 'Ready to try'));
      const branches = el('ul', 'sa-list');
      for (const r of detail.repos) branches.append(branchLine(r));
      box.append(branches);
      // The final human phase's own inputs; the brief, when there is one,
      // is shown as its assumptions section as before.
      for (const key of detail.readyInputs.filter((k) => k !== 'idea' && k !== 'brief')) {
        box.append(artifactBlock(READY_LABEL[key] ?? key, cachedArtifact(detail.jobId, needsYou.key, key)));
      }
      if (detail.readyInputs.includes('brief') || detail.artifacts.some((a) => a.key === 'brief')) {
        box.append(artifactBlock('Assumptions made for you', cachedArtifact(detail.jobId, needsYou.key, 'brief'), (text) => briefSection(text)));
      }
      const row = el('div', 'sa-actions');
      const accept = button('Accept', 'btn-primary', async () => {
        accept.disabled = true;
        if (!(await act('accept', rightError, { needsYouSeq: needsYou.seq }))) accept.disabled = false;
      });
      accept.title = 'Mark the job done. Nothing is merged or pushed.';
      row.append(accept, stopButton(rightError));
      box.append(row);
    } else if (needsYou.reason === 'folder-changed') {
      // Not terminal: the supervisor re-checks the folder every heartbeat.
      box.append(el('h3', 'sa-subheading', 'Paused'), preBlock(needsYou.text ?? ''));
      box.append(el('div', 'sa-note', 'The job continues on its own once the folder is back.'));
      box.appendChild(el('div', 'sa-actions')).append(stopButton(rightError));
    } else {
      box.append(el('h3', 'sa-subheading', 'Stuck'));
      box.append(el('div', 'sa-reason', needsYou.detail?.why ?? needsYou.type));
      const lines = stuckLines(needsYou.detail);
      if (lines.length) box.append(preBlock(lines.join('\n')));
      box.appendChild(el('div', 'sa-actions')).append(stopButton(rightError));
    }
    return box;
  }

  function renderRouter() {
    routerBox.textContent = '';
    const box = section('Router');
    if (status?.router === 'off') box.append(el('div', 'sa-muted', 'Router off: no apiKeyHelper'));
    const router = detail?.router;
    if (router && (status?.router !== 'off' || router.decisions.length)) {
      const limit = router.maxInputTokens ?? '?';
      box.append(el('div', null, `${router.model ?? '—'} · ${router.calls} call${router.calls === 1 ? '' : 's'}`));
      box.append(el('div', 'sa-muted', `Last request: ${router.lastRequestTokens ?? '—'} / ${limit} tokens`));
      const log = el('ul', 'sa-list sa-router-log');
      for (const d of router.decisions) {
        const a = detail.attempts.find((x) => x.attemptId === d.forAttemptId);
        const event = a ? `${[a.phase, a.task].filter(Boolean).join(' / ')} attempt ${a.n} ${a.outcome ?? ''}`.trim() : `attempt ${String(d.forAttemptId).slice(0, 8)}`;
        const note = d.ok ? (d.note ?? '') : `error: ${d.error ?? 'unknown'}`;
        log.append(el('li', null, `${event} → ${d.action} → ${note}`));
      }
      if (!router.decisions.length) log.append(el('li', 'sa-placeholder', 'No decisions yet.'));
      box.append(log);
    }
    routerBox.append(box);
  }

  function renderRight() {
    renderNotifyControl();
    const needsYou = detail?.jobId === selectedId ? detail.needsYou : null;
    const loaded = needsYou?.type === 'ready-to-try'
      ? [...artifactCache.entries()].filter(([k, v]) => k.startsWith(`${needsYou.key}|`) && v).length
      : 0;
    // Rebuilt only when the entry changes, so a poll never wipes a draft answer.
    const shown = needsYou ? `${needsYou.key}|${loaded}` : `none|${selectedId}|${detail ? 'loaded' : ''}`;
    if (shown !== needsYouShown) {
      needsYouShown = shown;
      needsYouBox.textContent = '';
      if (needsYou) needsYouBox.append(buildNeedsYou(needsYou));
      else if (selectedId && detail) needsYouBox.append(el('div', 'sa-placeholder', 'Nothing needs you on this job.'));
    }
    renderRouter();
  }

  // --- Status, selection, polling ---

  function renderStatus() {
    notice.textContent = '';
    const state = status?.state;
    if (state === 'ready') {
      notice.hidden = true;
      panes.hidden = false;
      return;
    }
    panes.hidden = true;
    notice.hidden = false;
    if (state === 'not-owner') {
      const text = `Superagent is running in the Cockpit on port ${status.ownerPort ?? 'unknown'}`;
      if (status.ownerPort == null) notice.append(text);
      else {
        const link = el('a', null, text);
        link.href = `http://127.0.0.1:${status.ownerPort}/?view=superagent`;
        notice.append(link);
      }
    } else if (state === 'error') {
      notice.append(el('span', 'sa-error-text', status.error || 'Superagent failed to start'));
    } else if (state === 'initialising' || state == null) {
      notice.append('Starting…');
    } else {
      notice.append('Superagent is not running');
    }
  }

  function render() {
    renderStatus();
    if (status?.state !== 'ready') return;
    renderJobList();
    renderMiddle();
    renderRight();
  }

  function select(jobId) {
    if (jobId === selectedId) return;
    selectedId = jobId;
    detail = null;
    detailError = null;
    showError(middleError, null);
    showError(rightError, null);
    const url = new URL(location.href);
    if (jobId) url.searchParams.set('job', jobId);
    else url.searchParams.delete('job');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    render();
    refresh();
  }

  async function poll() {
    let list;
    try {
      const res = await fetch('/api/superagent');
      if (res.status === 401) {
        gate.show();
        return;
      }
      if (!res.ok) return;
      gate.hide();
      list = await res.json();
    } catch {
      return; // best-effort: a failed poll leaves the last-known view showing
    }
    status = list.status;
    jobs = list.jobs ?? [];
    const jobId = selectedId;
    if (status?.state === 'ready' && jobId) {
      try {
        const fresh = await getJson(`/api/superagent/jobs/${encodeURIComponent(jobId)}`);
        if (jobId === selectedId) {
          detail = fresh;
          detailError = null;
        }
      } catch (err) {
        if (jobId === selectedId && err.status === 404) {
          detail = null;
          detailError = err;
        }
      }
    }
    dropFailedArtifacts();
    render();
  }

  // A refresh asked for mid-poll (a new selection, an action) polls once more
  // afterwards, so it never settles on data fetched before the change.
  function refresh() {
    if (refreshing) {
      pollAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        pollAgain = false;
        await poll();
      } while (pollAgain);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  renderStatus();
  refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}
