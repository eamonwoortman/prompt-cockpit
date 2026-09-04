// The auto-pilot pane: a fixed overlay under the top bar with Pilots and Logs
// tabs, modelled on session-list-pane.js (measured `top`, header-button
// toggle, interval poll while open) rather than on the Settings modal - it is
// a monitoring surface you leave open, not a dialog you dismiss.
//
// The bell is deliberately NOT here: run history lives in the Logs tab and the
// bell holds actionable entries only (spec Decision 6), so they are two
// independent surfaces with two independent polls.
//
// Everything is built with createElement/textContent, never innerHTML: a pilot
// name, a gate command's captured stdout and a log reason are all strings this
// app did not author, and there is no CSP (backlog.md).
// Root-absolute specifiers are correct here and nowhere else in this feature:
// this module is only ever loaded by the browser, never imported by a test.
// autopilot-format.js is the one that has to stay import-free, which is why it
// takes the schedule functions as a parameter and this file supplies them.
import { initResizablePanel } from '/resizable-panel.js';
import { nextRunAt, backoffMs } from '/autopilot-schedule.js';
import {
  describeSchedule, describeNextRun, describeOutcome, describeSpend,
  formatRelativeTime, formatDuration,
} from '/autopilot-format.js';

const SCHEDULE = { nextRunAt, backoffMs };
const POLL_MS = 10_000;

export function initAutopilotPanel({
  panel, body, tabsEl, headerEl, toggleBtn, closeBtn, newBtn, spendEl,
  resizeHandle, initialWidth, onWidthChange, onEdit, onCreate,
  now = () => Date.now(),
}) {
  let open = false;
  let tab = 'pilots';
  let pollTimer = null;
  let lastSnapshot = null;
  // Logs' own last-known cache, same reasoning as lastSnapshot above (the
  // best-effort-poll constraint): a failed or still-in-flight poll must
  // leave whatever entries are already on screen alone rather than wiping
  // them or flickering "Loading…" every 10s.
  let lastLogEntries = null;

  initResizablePanel({
    panel,
    handle: resizeHandle,
    minWidthPx: 360,
    initialWidth,
    onWidthChange,
    isNarrowLayout: () => window.matchMedia('(max-width: 900px)').matches,
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function placeholder(text) {
    body.textContent = '';
    body.append(el('div', 'detail-pane-placeholder', text));
  }

  // Badge is kept fresh even while the pane is closed, so the header reflects
  // pilots enabled from another tab.
  function applyBadge(pilots, running) {
    const enabled = pilots.filter((p) => p.enabled).length;
    toggleBtn.textContent = running.length
      ? `🛫 Auto-pilot ${running.length}/${enabled}`
      : `🛫 Auto-pilot ${enabled}`;
    toggleBtn.title = running.length
      ? `${running.length} pilot run${running.length === 1 ? '' : 's'} in flight, ${enabled} enabled`
      : `${enabled} pilot${enabled === 1 ? '' : 's'} enabled`;
  }

  async function fetchSnapshot() {
    try {
      const res = await fetch('/api/autopilots');
      if (!res.ok) return lastSnapshot;
      lastSnapshot = await res.json();
      return lastSnapshot;
    } catch {
      // Best-effort: a failed poll leaves the last-known value showing rather
      // than replacing it with an alarming placeholder.
      return lastSnapshot;
    }
  }

  async function post(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  }

  function renderPilotRow(pilot, runningById, at) {
    const row = el('div', 'autopilot-row');
    if (!pilot.enabled) row.classList.add('disabled');
    const live = runningById.get(pilot.id);
    if (live) row.classList.add('running');

    const top = el('div', 'autopilot-row-top');
    top.append(el('span', 'autopilot-name', pilot.name));
    const state = el('span', 'autopilot-state');
    if (live) {
      state.textContent = live.blocked ? 'needs input' : 'running';
      state.classList.add(live.blocked ? 'blocked' : 'live');
      state.title = live.blocked
        ? 'Blocked on a permission prompt. It holds this pilot\'s lock until a human answers - and is exempt from the stall backstop, since waiting for you is not a runaway.'
        : `Started ${formatRelativeTime(live.startedAt, at)}`;
    } else {
      state.textContent = describeNextRun(pilot, at, SCHEDULE);
    }
    top.append(state);
    row.append(top);

    const meta = el('div', 'autopilot-meta');
    meta.append(el('span', null, describeSchedule(pilot)));
    meta.append(el('span', null, `${pilot.provider}${pilot.model ? ` / ${pilot.model}` : ''}${pilot.effort ? ` / ${pilot.effort}` : ''}`));
    const mode = el('span', 'autopilot-mode', pilot.mode);
    // Unattended writes to a real repository are the headline risk (spec
    // Risks #1) - the mode belongs on the row, not buried in the form.
    if (pilot.mode === 'acceptEdits' || pilot.mode === 'bypassPermissions' || pilot.mode === 'dontAsk' || pilot.mode === 'auto') {
      mode.classList.add('unattended');
      mode.title = 'This pilot writes to the working tree without asking.';
    }
    meta.append(mode);
    row.append(meta);

    const cwd = el('div', 'autopilot-cwd', pilot.cwd);
    cwd.title = pilot.cwd;
    row.append(cwd);
    row.append(el('div', 'autopilot-outcome', describeOutcome(pilot, at)));

    const actions = el('div', 'autopilot-actions');

    const runBtn = el('button', 'btn', 'Run now');
    runBtn.type = 'button';
    runBtn.title = 'Fire immediately, bypassing the schedule and the active window. Still honours the lock, the provider check, the run gate, rate limits and the spend cap.';
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      try {
        await post(`/api/autopilots/${pilot.id}/run-now`);
        await refresh();
      } catch (err) {
        showRowError(row, err);
      } finally {
        runBtn.disabled = false;
      }
    });

    const toggle = el('button', 'btn', pilot.enabled ? 'Disable' : 'Enable');
    toggle.type = 'button';
    toggle.title = pilot.enabled
      ? 'Stop scheduling this pilot. A run already in flight is left alone.'
      : 'Resume scheduling, and clear any failure back-off.';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await post(`/api/autopilots/${pilot.id}/toggle`, { enabled: !pilot.enabled });
        await refresh();
      } catch (err) {
        showRowError(row, err);
      } finally {
        toggle.disabled = false;
      }
    });

    const edit = el('button', 'btn', 'Edit');
    edit.type = 'button';
    edit.title = 'Changes apply from the next firing; a run in flight keeps the model and mode it was created with.';
    edit.addEventListener('click', () => onEdit?.(pilot));

    const del = el('button', 'btn btn-danger', 'Delete');
    del.type = 'button';
    del.title = 'Force-closes any live run first, then removes the pilot.';
    del.addEventListener('click', async () => {
      const warning = live
        ? `Delete "${pilot.name}"? Its running session will be force-closed first.`
        : `Delete "${pilot.name}"?`;
      if (!confirm(warning)) return;
      del.disabled = true;
      try {
        const res = await fetch(`/api/autopilots/${pilot.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
        await refresh();
      } catch (err) {
        showRowError(row, err);
        del.disabled = false;
      }
    });

    actions.append(runBtn, toggle, edit, del);
    row.append(actions);
    return row;
  }

  function showRowError(row, err) {
    let box = row.querySelector('.autopilot-row-error');
    if (!box) {
      box = el('div', 'autopilot-row-error mcp-error');
      row.append(box);
    }
    box.textContent = String(err?.message || err);
    box.hidden = false;
  }

  function renderPilots(snapshot) {
    const at = now();
    body.textContent = '';
    if (!snapshot.pilots.length) {
      const empty = el('div', 'detail-pane-placeholder');
      empty.append(el('p', null, 'No pilots yet.'));
      empty.append(el('p', null, 'A pilot fires a NEW session on a schedule: fresh conversation, one stored prompt, force-closed when the work is done. Pilots only run while this cockpit is running.'));
      body.append(empty);
      return;
    }
    const runningById = new Map(snapshot.running.map((r) => [r.pilotId, r]));
    for (const pilot of snapshot.pilots) body.append(renderPilotRow(pilot, runningById, at));
  }

  async function renderLogs() {
    // Only the very first load shows "Loading…" - once lastLogEntries holds
    // something, a poll that fails or is just slow must leave it on screen
    // rather than flickering the body blank every 10s.
    if (lastLogEntries === null) placeholder('Loading…');
    try {
      const res = await fetch('/api/autopilot-logs?limit=200');
      if (!res.ok) throw new Error(`${res.status}`);
      lastLogEntries = (await res.json()).entries || [];
    } catch {
      if (lastLogEntries) return; // keep what's already rendered
      placeholder('Could not load the run log.');
      return;
    }
    const entries = lastLogEntries;
    if (tab !== 'logs' || !open) return;
    body.textContent = '';
    if (!entries.length) {
      placeholder('No runs yet.');
      return;
    }
    const at = now();
    // Newest first here, unlike the transcript: this is a log you scan from
    // the top, not a conversation you read forwards.
    for (const entry of [...entries].reverse()) {
      const row = el('div', `autopilot-log-row autopilot-log-${entry.event}`);
      const head = el('div', 'autopilot-log-head');
      head.append(el('span', 'autopilot-log-event', entry.event));
      head.append(el('span', 'autopilot-log-pilot', entry.pilotName || '—'));
      head.append(el('span', 'autopilot-log-when', formatRelativeTime(entry.ts, at)));
      row.append(head);

      const bits = [];
      if (entry.reason) bits.push(entry.reason);
      if (entry.durationMs != null) bits.push(`took ${formatDuration(entry.durationMs)}`);
      if (typeof entry.costUsd === 'number') bits.push(`$${entry.costUsd.toFixed(4)}`);
      if (entry.costUnpriced) bits.push('cost incomplete (unpriced model)');
      if (bits.length) row.append(el('div', 'autopilot-log-detail', bits.join(' · ')));

      if (Array.isArray(entry.answered)) {
        for (const a of entry.answered) {
          row.append(el('div', 'autopilot-log-answer', `auto-answered "${a.question}" → ${a.chosenLabel}`));
        }
      }
      body.append(row);
    }
  }

  async function refresh() {
    const snapshot = await fetchSnapshot();
    if (!snapshot) {
      if (open && tab === 'pilots') placeholder('Could not reach the server.');
      return;
    }
    applyBadge(snapshot.pilots, snapshot.running);
    spendEl.textContent = describeSpend(snapshot.spend, snapshot.settings.dailyCostCapUsd);
    if (!open) return;
    if (tab === 'pilots') renderPilots(snapshot);
    else await renderLogs();
  }

  function selectTab(next) {
    tab = next;
    for (const btn of tabsEl.querySelectorAll('[data-autopilot-tab]')) {
      const on = btn.dataset.autopilotTab === next;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    refresh();
  }

  function openPane() {
    open = true;
    toggleBtn.classList.add('on');
    // Measured live, not a fixed CSS constant - the header's height isn't
    // fixed (the rate-limit banner can wrap it onto two lines).
    panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
    panel.classList.add('enabled');
    placeholder('Loading…');
    refresh();
    // Poll only while open: unlike the badge, the list body is expensive to
    // rebuild and nobody is reading it when the pane is shut.
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
  }

  function closePane() {
    if (!open) return;
    open = false;
    toggleBtn.classList.remove('on');
    panel.classList.remove('enabled');
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Exported as openPane, not as a toggle: the notification bell needs
  // "bring me to the pilot list", and .click()ing the header button would
  // CLOSE the pane whenever it was already open - which is exactly when an
  // auto-disabled notification is most likely to be read.
  toggleBtn.addEventListener('click', () => (open ? closePane() : openPane()));
  closeBtn.addEventListener('click', closePane);
  newBtn.addEventListener('click', () => onCreate?.());
  tabsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-autopilot-tab]');
    if (btn) selectTab(btn.dataset.autopilotTab);
  });
  window.addEventListener('resize', () => {
    if (open) panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
  });

  refresh();
  // Badge stays fresh even with the pane closed, so pilots enabled in another
  // tab (or auto-disabled by the supervisor) show up here - same reasoning as
  // session-list-pane.js's own 10 s count poll.
  setInterval(() => { if (!open) refresh(); }, POLL_MS);

  return { refresh, openPane, closePane, selectTab, isOpen: () => open };
}
