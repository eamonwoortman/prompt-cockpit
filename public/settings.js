// localStorage here is for per-browser UI preferences the server never
// sees. Anything that should follow a *project* around instead belongs in
// session-defaults.js/plugin-settings.js's shared settings.local.json.
// Close session lives in this modal, not the header's always-visible row,
// since it permanently ends the live process.
const STORAGE_KEY = 'cockpit:settings';
const INTERFACE_FONTS = {
  sans: 'Arial, sans-serif',
  serif: 'Georgia, serif',
  mono: 'ui-monospace, monospace',
};
const MONOSPACE_FONTS = {
  consolas: 'Consolas, ui-monospace, monospace',
  cascadia: '"Cascadia Code", ui-monospace, monospace',
  courier: '"Courier New", ui-monospace, monospace',
};
const APPEARANCE_DEFAULTS = {
  interfaceFont: 'system',
  monoFont: 'system',
  textScale: '100',
  readingSize: '14',
  lineSpacing: '1.4',
};
// customFolders: [{ id, label, path }, ...] - the "@" picker's virtual
// folders beyond "Local folder" (file-picker.js). Used to be a single
// screenshotDir string; loadSettings() below migrates that one-time.
const DEFAULTS = {
  autoCollapsePreviousGroup: true,
  customFolders: [],
  screenshotsSeeded: false,
  turnChartEnabled: false,
  turnChartMetric: 'cost',
  turnChartExcludeCacheMisses: false,
  turnChartAxisPosition: 'left', // 'left' | 'right' - which side of the cost graph shows y-axis labels
  showMessageTimestamps: false,
  // 'show' | 'hide-successful' | 'hide-all' - how much of the tool-call
  // groups the transcript displays. Per-browser, same as the timestamps pref.
  toolCallVisibility: 'show',
  // Default ON, unlike the other two panels above - Decision 3 (tool-call
  // presentation redesign) calls for the detail pane docked by default when
  // a session is active, not closed-by-default/slide-in.
  detailPaneEnabled: true,
  // Debug option, off by default - see setPendingTurnsBadgeEnabled below and
  // its checkbox's own hint text in index.html for what this actually shows.
  pendingTurnsBadgeEnabled: false,
  // Sent when a session starts (app.js's startSession): hides the Claude CLI's
  // own ListAgents/SendMessage so the model uses the cockpit's ask_session.
  hideBuiltinPeerTools: true,
  // Drag-resized (detail-pane.js's resizeHandle) - persisted the same way
  // turnChartMetric is, via the standalone patchSettings() below rather than
  // the settings-modal machinery, since there's no checkbox/select for this,
  // just a drag handle.
  detailPaneWidth: 380,
  // Same drag-resized/patchSettings-only persistence as detailPaneWidth
  // above - session-list-pane.js's own resize handle.
  sessionListPaneWidth: 380,
  // One-time nag (app.js's checkPromptSuggestionNag) pointing out that the
  // CLI's own promptSuggestionEnabled feature costs a server-side call per
  // turn cockpit never uses - compose.js implements its own ghost-text
  // suggestion client-side instead. Set true once the user dismisses it.
  promptSuggestionNagDismissed: false,
};

function makeFolderId() {
  return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Exported so app.js can read turnChartMetric/turnChartExcludeCacheMisses
// before initTurnChart() runs: that call rebuilds metricSelect's <option>s
// (clobbering any preset value) and captures the checkbox's .checked into a
// closured variable at call time, so the persisted value must be applied
// before that call or via a synthetic change event after - not just read.
export function loadSettings() {
  let settings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    settings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    settings = { ...DEFAULTS }; // corrupt/blocked storage - fall back rather than throw
  }
  // One-time migration: an old build stored a single screenshotDir string.
  // Fold it into the new customFolders list so nobody's existing setting
  // silently vanishes, then drop the old key.
  if (typeof settings.screenshotDir === 'string' && settings.screenshotDir.trim()) {
    settings.customFolders = [...settings.customFolders, { id: makeFolderId(), label: 'Screenshots', path: settings.screenshotDir.trim() }];
    settings.screenshotsSeeded = true;
  }
  if ('screenshotDir' in settings) {
    delete settings.screenshotDir;
    saveSettings(settings);
  }
  return settings;
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // private browsing / quota - setting just won't survive reload, not fatal
  }
}

// Standalone read-modify-write for a caller that only wants to persist one
// or two keys and isn't otherwise holding the `settings` object
// initSettings() closes over - turn-chart.js's metric/exclude-cache-miss
// picks (via app.js) are the first use.
export function patchSettings(patch) {
  const settings = loadSettings();
  Object.assign(settings, patch);
  saveSettings(settings);
  return settings;
}

export function initSettings({
  modal,
  cogButton,
  closeButton,
  autoCollapseCheckbox,
  customFoldersListEl,
  addCustomFolderButton,
  onBrowseFolder,
  turnChartCheckbox,
  timestampsCheckbox,
  toolCallVisibilitySelect,
  detailPaneCheckbox,
  pendingTurnsBadgeCheckbox,
  hideBuiltinPeerToolsCheckbox,
  closeSessionButton,
  resetSessionButton,
  onAutoCollapseChange,
  onTurnChartEnabledChange,
  onTimestampsChange,
  onToolCallVisibilityChange,
  onDetailPaneEnabledChange,
  onPendingTurnsBadgeEnabledChange,
  onCloseSession,
  onResetSession,
  onOpen,
}) {
  const settings = loadSettings();

  // Reloads fresh from localStorage before writing, rather than saving this
  // closure's own snapshot directly - otherwise a key written elsewhere via
  // patchSettings() (e.g. app.js's turn-chart picks) after this closure was
  // created would get silently reverted by the next checkbox toggle here.
  function persist(patch) {
    Object.assign(settings, patchSettings(patch));
  }

  initAppearance(modal, settings.appearance, (appearance) => persist({ appearance }));

  autoCollapseCheckbox.checked = settings.autoCollapsePreviousGroup;
  turnChartCheckbox.checked = settings.turnChartEnabled;
  timestampsCheckbox.checked = settings.showMessageTimestamps;
  toolCallVisibilitySelect.value = settings.toolCallVisibility;
  detailPaneCheckbox.checked = settings.detailPaneEnabled;
  pendingTurnsBadgeCheckbox.checked = settings.pendingTurnsBadgeEnabled;
  hideBuiltinPeerToolsCheckbox.checked = settings.hideBuiltinPeerTools;
  onAutoCollapseChange(settings.autoCollapsePreviousGroup);
  onTurnChartEnabledChange(settings.turnChartEnabled);
  onTimestampsChange(settings.showMessageTimestamps);
  onToolCallVisibilityChange(settings.toolCallVisibility);
  onDetailPaneEnabledChange(settings.detailPaneEnabled);
  onPendingTurnsBadgeEnabledChange(settings.pendingTurnsBadgeEnabled);
  renderCustomFolders();

  // Seeds the OS-detected Screenshots folder exactly once, even for a user
  // who never opens Settings; screenshotsSeeded latches so deliberately
  // removing it later doesn't cause it to silently reappear.
  if (!settings.screenshotsSeeded) {
    fetch('/api/os-defaults')
      .then((r) => r.json())
      .then((data) => {
        const customFolders = data.screenshotDir
          ? [...settings.customFolders, { id: makeFolderId(), label: 'Screenshots', path: data.screenshotDir }]
          : settings.customFolders;
        persist({ screenshotsSeeded: true, customFolders });
        renderCustomFolders();
      })
      .catch(() => {}); // offline/blocked - just skip the seed, not fatal
  }

  function renderCustomFolders() {
    customFoldersListEl.innerHTML = '';
    for (const folder of settings.customFolders) {
      const li = document.createElement('li');
      li.className = 'custom-folder-row';

      const label = document.createElement('span');
      label.className = 'cmd-name';
      label.textContent = folder.label;

      const pathSpan = document.createElement('span');
      pathSpan.className = 'cmd-desc';
      pathSpan.textContent = folder.path;
      pathSpan.title = folder.path;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'custom-folder-remove';
      removeBtn.textContent = '−'; // minus sign
      removeBtn.title = `Remove ${folder.label}`;
      removeBtn.addEventListener('click', () => {
        persist({ customFolders: settings.customFolders.filter((f) => f.id !== folder.id) });
        renderCustomFolders();
      });

      li.append(label, pathSpan, removeBtn);
      customFoldersListEl.append(li);
    }
  }

  if (addCustomFolderButton) {
    addCustomFolderButton.addEventListener('click', () => {
      if (!onBrowseFolder) return;
      onBrowseFolder((chosenPath) => {
        if (!chosenPath) return;
        const defaultLabel = chosenPath.split(/[\\/]/).filter(Boolean).pop() || chosenPath;
        const label = (window.prompt('Label for this folder:', defaultLabel) || '').trim() || defaultLabel;
        persist({ customFolders: [...settings.customFolders, { id: makeFolderId(), label, path: chosenPath }] });
        renderCustomFolders();
      });
    });
  }

  cogButton.addEventListener('click', () => {
    if (!modal.open) modal.showModal();
    if (onOpen) onOpen();
  });
  closeButton.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  enableModalDrag(modal);

  // Doesn't reset to "display" tab on close/reopen - staying on the tab you
  // were last looking at is more useful than snapping back.
  const tabButtons = [...modal.querySelectorAll('[data-settings-tab]')];
  const tabPanels = [...modal.querySelectorAll('[data-settings-tab-panel]')];
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.settingsTab;
      for (const b of tabButtons) {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      for (const p of tabPanels) p.hidden = p.dataset.settingsTabPanel !== target;
    });
  }

  autoCollapseCheckbox.addEventListener('change', () => {
    persist({ autoCollapsePreviousGroup: autoCollapseCheckbox.checked });
    onAutoCollapseChange(settings.autoCollapsePreviousGroup);
  });

  turnChartCheckbox.addEventListener('change', () => setTurnChartEnabled(turnChartCheckbox.checked));
  detailPaneCheckbox.addEventListener('change', () => setDetailPaneEnabled(detailPaneCheckbox.checked));
  timestampsCheckbox.addEventListener('change', () => {
    persist({ showMessageTimestamps: timestampsCheckbox.checked });
    onTimestampsChange(timestampsCheckbox.checked);
  });
  toolCallVisibilitySelect.addEventListener('change', () => {
    persist({ toolCallVisibility: toolCallVisibilitySelect.value });
    onToolCallVisibilityChange(toolCallVisibilitySelect.value);
  });
  pendingTurnsBadgeCheckbox.addEventListener('change', () => {
    persist({ pendingTurnsBadgeEnabled: pendingTurnsBadgeCheckbox.checked });
    onPendingTurnsBadgeEnabledChange(pendingTurnsBadgeCheckbox.checked);
  });
  hideBuiltinPeerToolsCheckbox.addEventListener('change', () => {
    persist({ hideBuiltinPeerTools: hideBuiltinPeerToolsCheckbox.checked });
  });

  // Both buttons end the live process, so the first click only arms them
  // ("Click again to confirm"); it disarms itself after a few seconds.
  function confirmOnSecondClick(button, action) {
    const idleLabel = button.textContent;
    let timer = null;
    const disarm = () => {
      clearTimeout(timer);
      timer = null;
      button.textContent = idleLabel;
    };
    button.addEventListener('click', () => {
      if (timer === null) {
        button.textContent = 'Click again to confirm';
        timer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      close();
      action();
    });
    button.addEventListener('blur', disarm);
  }
  confirmOnSecondClick(closeSessionButton, () => onCloseSession());
  confirmOnSecondClick(resetSessionButton, () => onResetSession());

  function close() {
    if (modal.open) modal.close();
  }

  // Shared by the checkbox above and app.js's turnChartToggleBtn (the "same
  // line as Agents" button) - two entry points, one persisted value, so
  // flipping either keeps the other in sync instead of drifting.
  function setTurnChartEnabled(value) {
    turnChartCheckbox.checked = value;
    persist({ turnChartEnabled: value });
    onTurnChartEnabledChange(value);
  }

  // Same shape again, for the tool-call detail pane's toggle button +
  // settings-modal checkbox pair (default true, unlike the two above).
  function setDetailPaneEnabled(value) {
    detailPaneCheckbox.checked = value;
    persist({ detailPaneEnabled: value });
    onDetailPaneEnabledChange(value);
  }

  return {
    getCustomFolders: () => settings.customFolders,
    isTurnChartEnabled: () => settings.turnChartEnabled,
    setTurnChartEnabled,
    isDetailPaneEnabled: () => settings.detailPaneEnabled,
    setDetailPaneEnabled,
    isPendingTurnsBadgeEnabled: () => settings.pendingTurnsBadgeEnabled,
  };
}

function initAppearance(modal, saved, onChange) {
  const controls = [...modal.querySelectorAll('[data-appearance]')];
  if (!controls.length) return;

  function render(values) {
    for (const control of controls) {
      const key = control.dataset.appearance;
      control.value = values?.[key] ?? APPEARANCE_DEFAULTS[key];
      if (control.selectedIndex === -1) control.value = APPEARANCE_DEFAULTS[key];
    }
    return apply();
  }

  function apply() {
    const values = Object.fromEntries(controls.map((control) => [control.dataset.appearance, control.value]));
    const style = document.documentElement.style;
    style.setProperty('--interface-font', INTERFACE_FONTS[values.interfaceFont] ?? '');
    style.setProperty('--mono-font', MONOSPACE_FONTS[values.monoFont] ?? '');
    style.setProperty('--text-scale', `${values.textScale}%`);
    style.setProperty('--reading-size', `${values.readingSize}px`);
    style.setProperty('--reading-line-height', values.lineSpacing);
    return values;
  }

  render(saved);
  for (const control of controls) {
    control.addEventListener('change', () => onChange(apply()));
  }
  modal.querySelector('[data-appearance-reset]').addEventListener('click', () => {
    onChange(render(APPEARANCE_DEFAULTS));
  });
}

// Lets the modal be repositioned by dragging its header. Settings has a
// resize grip as well, so its larger sections can be given more room.
// Position isn't persisted, so it re-centers after a reload.
function enableModalDrag(modal) {
  const box = modal.querySelector('.modal-box');
  const header = modal.querySelector('header');
  if (!box || !header) return;
  header.classList.add('modal-draggable');

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  header.addEventListener('mousedown', (e) => {
    // Ignore drags starting on an interactive element inside the header
    // (there are none today, but future-proof against e.g. a close icon
    // moving up there).
    if (e.button !== 0 || e.target.closest('button, a, input, select')) return;
    const rect = box.getBoundingClientRect();
    // Switch from the modal's default flex-centered placement to an
    // explicit fixed position on first drag - position: fixed pulls the
    // box out of the parent's flex layout entirely, so left/top fully
    // control it from here on.
    box.style.position = 'fixed';
    box.style.margin = '0';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    startLeft = rect.left;
    startTop = rect.top;
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = box.getBoundingClientRect();
    // Clamp so the header can't be dragged fully off-screen and become
    // ungrabbable.
    const maxLeft = window.innerWidth - Math.min(rect.width, 80);
    const maxTop = window.innerHeight - 40;
    const left = Math.min(Math.max(startLeft + (e.clientX - startX), -rect.width + 80), maxLeft);
    const top = Math.min(Math.max(startTop + (e.clientY - startY), 0), maxTop);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  });
}
