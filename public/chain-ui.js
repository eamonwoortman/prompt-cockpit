// Chain UI: the "When a rate limit hits" choice, the ordered chain list and
// its options, the chain log, the manual "Chain to..." action, the ask-me
// offer button and the away switch. A chain continues a session's work in a
// new session on another provider/account (chain.js on the server); this
// module only collects the choices and calls the routes. DOM refs and
// callbacks are injected, like approval-panel.js, so app.js stays the only
// place that knows about the rest.
const SEP = '::';

export function encodeTarget(target) {
  return target ? `${target.provider}${SEP}${target.subscription || ''}` : '';
}

export function decodeTarget(value) {
  if (!value) return null;
  const [provider, subscription] = value.split(SEP);
  return { provider, subscription: subscription || null };
}

// One option per provider, or per account for a provider that has several
// (Claude login folders). `catalog` is provider-catalog.js's catalog.
export function buildTargetOptions(catalog) {
  const options = [];
  for (const provider of catalog.list()) {
    const subs = provider.launch?.subscriptions;
    if (Array.isArray(subs) && subs.length) {
      // Same account ids the server stores (Claude's own is 'default').
      for (const sub of subs) options.push({ value: encodeTarget({ provider: provider.id, subscription: sub.id }), label: subs.length > 1 ? `${provider.label} (${sub.label})` : provider.label });
    } else {
      options.push({ value: encodeTarget({ provider: provider.id, subscription: null }), label: provider.label });
    }
  }
  return options;
}

const PERMISSION_LABELS = [
  ['default', 'Ask for each action (it will wait for you)'],
  ['inherit', 'Same as the session it continues'],
  ['acceptEdits', 'Accept edits automatically'],
  ['plan', 'Plan only'],
  ['dontAsk', "Don't ask"],
  ['auto', 'Auto'],
  ['bypassPermissions', 'Bypass all permissions (risky)'],
];

function formatLogEntry(entry, labelFor) {
  const when = entry.at ? new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const from = entry.from ? labelFor({ provider: entry.from.provider, subscription: entry.from.subscription }) : '';
  const to = entry.to ? ` -> ${labelFor(entry.to)}` : '';
  const how = entry.trigger ? ` (${entry.trigger})` : '';
  const detail = entry.detail ? `: ${entry.detail}` : '';
  return `${when}  ${entry.event}  ${from}${to}${how}${detail}`;
}

export function initChainUi({
  actionSelect, // settings: rate-limit choice
  listEl, // settings: the ordered chain list
  addSelect,
  addBtn,
  askPresentCheckbox,
  awayMinutesInput,
  permissionSelect,
  logBtn,
  logEl,
  settingsRows, // wrapper hidden for sessions that never report rate limits
  chainBtn, // activity bar "Chain to..."
  chainMenu,
  chainMenuSelect,
  chainGoBtn,
  offerBtn, // appears when a limit is hit and chaining is waiting on you
  awayBtn, // activity bar away switch
  errorEl,
  getCatalog,
  post, // async (action, body) => Response
  get, // async (action) => Response
  sendAway, // (boolean) => void
  onChained, // ({ id, token }) => void - opens the new session in a new tab
}) {
  let session = null;
  let busy = false;
  let optionsKey = '';
  let list = [];
  let options = [];

  permissionSelect.innerHTML = '';
  for (const [value, label] of PERMISSION_LABELS) {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = label;
    permissionSelect.append(el);
  }

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function fill(select, opts) {
    const previous = select.value;
    select.innerHTML = '';
    for (const option of opts) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.append(el);
    }
    if (previous && opts.some((o) => o.value === previous)) select.value = previous;
  }

  function labelFor(target) {
    const value = encodeTarget(target);
    return options.find((o) => o.value === value)?.label || (target ? target.provider : 'another session');
  }

  // Rebuilt only when the option list actually changed: summaries stream in
  // constantly, and tearing down a select the user has open loses their pick.
  function refreshTargets() {
    options = buildTargetOptions(getCatalog());
    const key = options.map((o) => `${o.value}|${o.label}`).join('\n');
    if (key === optionsKey) return;
    optionsKey = key;
    fill(addSelect, options);
    fill(chainMenuSelect, options);
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'cmd-desc';
      empty.textContent = 'Empty: add the accounts to chain through, in order.';
      listEl.append(empty);
      return;
    }
    const ownKey = session ? encodeTarget({ provider: session.provider, subscription: session.subscription || null }) : '';
    list.forEach((target, index) => {
      const li = document.createElement('li');
      li.className = 'custom-folder-row';
      const name = document.createElement('span');
      name.className = 'cmd-name';
      name.textContent = `${index + 1}. ${labelFor(target)}${encodeTarget(target) === ownKey ? '  (this session)' : ''}`;
      li.append(name);
      for (const [text, title, handler, disabled] of [
        ['↑', 'Move up', () => move(index, -1), index === 0],
        ['↓', 'Move down', () => move(index, 1), index === list.length - 1],
        ['−', 'Remove from the list', () => { list.splice(index, 1); changed(); }, false],
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'custom-folder-remove';
        btn.textContent = text;
        btn.title = title;
        btn.disabled = disabled;
        btn.addEventListener('click', handler);
        li.append(btn);
      }
      listEl.append(li);
    });
  }

  function move(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    changed();
  }

  function changed() {
    renderList();
    savePolicy();
  }

  function currentOptions() {
    return {
      askWhenPresent: askPresentCheckbox.checked,
      awayMinutes: Number(awayMinutesInput.value) || 10,
      permissionMode: permissionSelect.value,
    };
  }

  async function savePolicy() {
    showError('');
    const rateLimitAction = actionSelect.value;
    if ((rateLimitAction === 'ask' || rateLimitAction === 'chain') && list.length === 0) {
      showError('Add at least one account to the chain list first.');
      return;
    }
    const res = await post('chain-policy', { rateLimitAction, chainList: list, chainOptions: currentOptions() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showError(`Could not save: ${err.error || res.statusText}`);
      return;
    }
    const result = await res.json().catch(() => ({}));
    if (result.persisted === false) showError('Applied to this session only: could not save it for the folder.');
  }

  async function chainNow(targetValue) {
    if (busy) return;
    busy = true;
    chainGoBtn.disabled = true;
    offerBtn.disabled = true;
    showError('');
    try {
      const target = decodeTarget(targetValue);
      const res = await post('chain', target ? { target } : {});
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showError(`Chain failed: ${err.error || res.statusText}`);
        return;
      }
      const { newSession } = await res.json();
      chainMenu.hidden = true;
      if (newSession) onChained(newSession);
    } finally {
      busy = false;
      chainGoBtn.disabled = false;
      offerBtn.disabled = false;
    }
  }

  async function loadLog() {
    logEl.hidden = false;
    logEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'cmd-desc';
    li.textContent = 'Loading...';
    logEl.append(li);
    try {
      const res = await get('chain-log');
      const { entries } = await res.json();
      logEl.innerHTML = '';
      if (!entries?.length) {
        li.textContent = 'Nothing yet: no rate limit or chain has been recorded in this folder.';
        logEl.append(li);
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('li');
        row.className = 'cmd-desc';
        row.textContent = formatLogEntry(entry, labelFor);
        logEl.append(row);
      }
    } catch {
      logEl.innerHTML = '';
      li.textContent = 'Could not read the chain log.';
      logEl.append(li);
    }
  }

  actionSelect.addEventListener('change', savePolicy);
  askPresentCheckbox.addEventListener('change', savePolicy);
  awayMinutesInput.addEventListener('change', savePolicy);
  permissionSelect.addEventListener('change', savePolicy);
  addBtn.addEventListener('click', () => {
    const target = decodeTarget(addSelect.value);
    if (!target || list.some((t) => encodeTarget(t) === encodeTarget(target))) return; // an account is only ever used once
    list.push(target);
    changed();
  });
  logBtn.addEventListener('click', loadLog);
  chainBtn.addEventListener('click', () => {
    chainMenu.hidden = !chainMenu.hidden;
  });
  chainGoBtn.addEventListener('click', () => chainNow(chainMenuSelect.value));
  offerBtn.addEventListener('click', () => chainNow(''));
  awayBtn.addEventListener('click', () => sendAway(awayBtn.getAttribute('aria-pressed') !== 'true'));

  // Idempotent: runs on every session summary, so a choice changed in another
  // tab (or an offer raised server-side) shows up here without a refresh.
  function render(next, { supportsRateLimits }) {
    session = next;
    refreshTargets();
    settingsRows.hidden = !supportsRateLimits;
    const active = document.activeElement;
    if (active !== actionSelect) actionSelect.value = next.autoContinue ? 'wait' : (next.rateLimitAction || 'none');
    if (active !== listEl && !listEl.contains(active)) {
      list = Array.isArray(next.chainList) ? next.chainList.map((t) => ({ ...t })) : [];
      renderList();
    }
    const opts = next.chainOptions || {};
    if (active !== askPresentCheckbox) askPresentCheckbox.checked = opts.askWhenPresent !== false;
    if (active !== awayMinutesInput) awayMinutesInput.value = opts.awayMinutes || 10;
    if (active !== permissionSelect) permissionSelect.value = opts.permissionMode || 'default';
    chainBtn.hidden = !next.providerSessionId;
    if (!next.providerSessionId) chainMenu.hidden = true;
    // The manual menu defaults to the next account in the list while closed;
    // an open menu keeps the user's pick.
    if (chainMenu.hidden && next.chainNext) chainMenuSelect.value = encodeTarget(next.chainNext);
    offerBtn.hidden = !(next.chainOffer && next.chainNext);
    if (!offerBtn.hidden) offerBtn.textContent = `Chain to ${labelFor(next.chainNext)} now`;
    const forced = Boolean(next.presence?.forcedAway);
    awayBtn.setAttribute('aria-pressed', forced ? 'true' : 'false');
    awayBtn.classList.toggle('on', forced);
    awayBtn.textContent = forced ? '🌙 Away: on' : '🌙 Away';
    if (next.chainError) showError(next.chainError.startsWith('Chain') ? next.chainError : `Chain stopped: ${next.chainError}`);
    else if (errorEl.dataset.fromSummary === '1') showError('');
    errorEl.dataset.fromSummary = next.chainError ? '1' : '';
  }

  return { render, refreshTargets };
}
