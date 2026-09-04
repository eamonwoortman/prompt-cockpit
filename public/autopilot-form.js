// Create/edit modal for one pilot. Mostly wiring around pickers that already
// exist: dir-browser.js for the folder, provider-catalog.js for the provider's
// effort list, and permissions.js for the mode list (shared verbatim with the
// server via static-files.js's SHARED_SRC_FILES, so the option list here and
// the server's own validation are literally the same array).
//
// Two misconfigurations the form is required to warn about, because both are
// silently ineffective rather than loudly wrong:
//   1. `default` mode with "pick the recommended answer" - the mode still
//      parks on ordinary tool-permission prompts, since the mode governs
//      those, not the input policy.
//   2. A Grok or Codex pilot with "pick the recommended answer" -
//      AskUserQuestion is Claude-only, so the field does nothing at all. The
//      field is DISABLED for those providers rather than left to look active.
import { PERMISSION_MODES, AUTO_ALLOW_MODES } from '/permissions.js';
import { WEEKDAY_LABELS, formatMinuteOfDay } from '/autopilot-format.js';

function minuteOfDayFromTimeInput(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
}

export function initAutopilotForm({
  modal, form, titleEl, errorEl, warningsEl, fields, cancelBtn, browseBtn,
  getProviderCatalog, openDirBrowser, onSaved,
}) {
  let editingId = null;

  // Weekday checkboxes, built once.
  const weekdayInputs = [];
  for (let day = 0; day < 7; day++) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.addEventListener('change', renderWarnings);
    const text = document.createElement('span');
    text.textContent = WEEKDAY_LABELS[day];
    label.append(input, text);
    fields.weekdays.append(label);
    weekdayInputs.push(input);
  }

  function fillModes() {
    fields.mode.textContent = '';
    for (const mode of PERMISSION_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = mode;
      fields.mode.append(option);
    }
  }

  // createProviderCatalog returns { add, get, has, list, label, validate }
  // (public/provider-catalog.js:89) - list() yields descriptors, not ids.
  function fillProviders() {
    const catalog = getProviderCatalog();
    const previous = fields.provider.value;
    fields.provider.textContent = '';
    for (const descriptor of catalog.list()) {
      const option = document.createElement('option');
      option.value = descriptor.id;
      option.textContent = catalog.label(descriptor.id);
      fields.provider.append(option);
    }
    if (previous && catalog.has(previous)) fields.provider.value = previous;
  }

  function fillEfforts() {
    const catalog = getProviderCatalog();
    // The server's providerDetails() puts the effort list under
    // `launch.efforts` (src/provider-registry.js:177-187), and the catalog
    // spreads that payload onto the descriptor verbatim. Empty until
    // /api/providers resolves, which is why app.js calls refreshProviders()
    // afterwards.
    const efforts = catalog.get(fields.provider.value)?.launch?.efforts || [];
    const previous = fields.effort.value;
    fields.effort.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '(provider default)';
    fields.effort.append(blank);
    for (const effort of efforts) {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = effort;
      fields.effort.append(option);
    }
    // An effort the new provider does not support must not silently survive a
    // provider switch - the server would 400 on save.
    fields.effort.value = efforts.includes(previous) ? previous : '';
  }

  function warn(text) {
    const box = document.createElement('div');
    box.className = 'autopilot-form-warning';
    box.textContent = text;
    warningsEl.append(box);
  }

  function renderWarnings() {
    warningsEl.textContent = '';
    const provider = fields.provider.value;
    const claude = provider === 'claude';

    // Misconfiguration 2: hide the control entirely for a provider that has
    // no AskUserQuestion, rather than leaving a setting that does nothing.
    fields.inputPolicyRow.hidden = !claude;
    if (!claude) fields.inputPolicy.value = 'ask';

    if (claude && fields.inputPolicy.value === 'recommended' && fields.mode.value === 'default') {
      // Misconfiguration 1.
      warn('Heads up: "pick the recommended answer" only covers questions the agent asks you. In "default" mode this pilot will still stop and wait on ordinary tool-permission prompts, because the permission mode governs those.');
    }
    if (AUTO_ALLOW_MODES.has(fields.mode.value)) {
      warn(`"${fields.mode.value}" writes to ${fields.cwd.value || 'the project folder'} without asking, unattended, on a timer. Make sure that folder is one you are happy for an agent to change while you are not watching.`);
    }
    if (fields.gateEnabled.checked) {
      warn('The run-gate command is executed as shell in the project folder before every firing.');
    }
    const from = minuteOfDayFromTimeInput(fields.windowFrom.value);
    const to = minuteOfDayFromTimeInput(fields.windowTo.value);
    if (fields.windowEnabled.checked && from != null && to != null && from > to) {
      warn('This window crosses midnight. The weekday set is the day the window OPENS, so a Friday window covers Friday night into Saturday morning.');
    }
    // BLOCKS submission rather than only warning: autopilot-store.js rejects
    // an explicitly empty weekday set (it refuses to silently widen it to
    // every day, which would be the opposite of what the operator selected),
    // so letting this through would just produce a 400.
    if (fields.windowEnabled.checked && weekdayInputs.every((i) => !i.checked)) {
      warn('Select at least one weekday - a window with no days selected cannot be saved.');
      return false;
    }
    return true;
  }

  function readForm() {
    const windowEnabled = fields.windowEnabled.checked;
    const gateEnabled = fields.gateEnabled.checked;
    return {
      name: fields.name.value.trim(),
      cwd: fields.cwd.value.trim(),
      provider: fields.provider.value,
      model: fields.model.value.trim() || null,
      effort: fields.effort.value || null,
      mode: fields.mode.value,
      prompt: fields.prompt.value,
      schedule: {
        everyMinutes: Number(fields.everyMinutes.value),
        window: windowEnabled ? {
          fromMinute: minuteOfDayFromTimeInput(fields.windowFrom.value),
          toMinute: minuteOfDayFromTimeInput(fields.windowTo.value),
          weekdays: weekdayInputs.map((input, day) => (input.checked ? day : null)).filter((d) => d !== null),
        } : null,
      },
      gate: gateEnabled ? {
        command: fields.gateCommand.value.trim(),
        timeoutMs: Number(fields.gateTimeout.value),
      } : null,
      inputPolicy: fields.inputPolicy.value,
      maxTurnStallMs: Number(fields.maxStallMinutes.value) * 60_000,
    };
  }

  function writeForm(pilot) {
    fields.name.value = pilot?.name ?? '';
    fields.cwd.value = pilot?.cwd ?? '';
    fillProviders();
    fields.provider.value = pilot?.provider ?? 'claude';
    fillEfforts();
    fields.model.value = pilot?.model ?? '';
    fields.effort.value = pilot?.effort ?? '';
    fields.mode.value = pilot?.mode ?? 'default';
    fields.prompt.value = pilot?.prompt ?? '';
    fields.everyMinutes.value = pilot?.schedule?.everyMinutes ?? 60;

    const window = pilot?.schedule?.window ?? null;
    fields.windowEnabled.checked = Boolean(window);
    fields.windowRow.hidden = !window;
    fields.windowFrom.value = window ? formatMinuteOfDay(window.fromMinute) : '09:00';
    fields.windowTo.value = window ? formatMinuteOfDay(window.toMinute) : '17:00';
    const days = window ? new Set(window.weekdays) : new Set([0, 1, 2, 3, 4, 5, 6]);
    weekdayInputs.forEach((input, day) => { input.checked = days.has(day); });

    const gate = pilot?.gate ?? null;
    fields.gateEnabled.checked = Boolean(gate);
    fields.gateRow.hidden = !gate;
    fields.gateCommand.value = gate?.command ?? '';
    fields.gateTimeout.value = gate?.timeoutMs ?? 30_000;

    fields.inputPolicy.value = pilot?.inputPolicy ?? 'ask';
    fields.maxStallMinutes.value = Math.round((pilot?.maxTurnStallMs ?? 3_600_000) / 60_000);

    errorEl.hidden = true;
    renderWarnings();
  }

  function open(pilot) {
    editingId = pilot?.id ?? null;
    titleEl.textContent = pilot ? `Edit "${pilot.name}"` : 'New pilot';
    writeForm(pilot);
    modal.showModal();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // renderWarnings returns false for the one client-side condition the
    // server would reject anyway (a window with no weekdays). Everything else
    // it produces is advisory and must not block a save.
    if (!renderWarnings()) return;
    const body = readForm();
    const url = editingId ? `/api/autopilots/${editingId}` : '/api/autopilots';
    errorEl.hidden = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
      modal.close();
      onSaved?.(data);
    } catch (err) {
      // The server is the authority on provider/effort/model/cwd validity
      // (routes/autopilot.js) - surface its message rather than duplicating
      // those rules here and drifting.
      errorEl.textContent = String(err?.message || err);
      errorEl.hidden = false;
    }
  });

  cancelBtn.addEventListener('click', () => modal.close());
  browseBtn.addEventListener('click', () => openDirBrowser((selected) => {
    fields.cwd.value = selected;
    renderWarnings();
  }));

  fields.provider.addEventListener('change', () => { fillEfforts(); renderWarnings(); });
  for (const el of [fields.mode, fields.inputPolicy, fields.cwd, fields.windowFrom, fields.windowTo]) {
    el.addEventListener('change', renderWarnings);
  }
  fields.windowEnabled.addEventListener('change', () => {
    fields.windowRow.hidden = !fields.windowEnabled.checked;
    renderWarnings();
  });
  fields.gateEnabled.addEventListener('change', () => {
    fields.gateRow.hidden = !fields.gateEnabled.checked;
    renderWarnings();
  });

  fillModes();
  fillProviders();
  fillEfforts();

  return {
    openCreate: () => open(null),
    openEdit: (pilot) => open(pilot),
    refreshProviders: () => { fillProviders(); fillEfforts(); },
  };
}
