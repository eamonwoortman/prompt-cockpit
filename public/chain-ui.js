// Chain UI: the "When a rate limit hits" + "Chain target" settings, the
// manual "Chain to..." action, and the ask-me offer button. A chain
// continues this session's work in a new session on another provider or
// account (chain.js on the server); this module only collects the choice and
// calls the routes. DOM refs and callbacks are injected, like
// approval-panel.js, so app.js stays the only place that knows about the rest.
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
    if (Array.isArray(subs) && subs.length > 1) {
      for (const sub of subs) options.push({ value: encodeTarget({ provider: provider.id, subscription: sub.id }), label: `${provider.label} (${sub.label})` });
    } else {
      options.push({ value: encodeTarget({ provider: provider.id, subscription: subs?.[0]?.id && subs[0].id !== 'default' ? subs[0].id : null }), label: provider.label });
    }
  }
  return options;
}

export function initChainUi({
  actionSelect, // settings: rate-limit choice
  targetSelect, // settings: chain target
  settingsRows, // wrapper hidden for providers that never report rate limits
  chainBtn, // activity bar "Chain to..."
  chainMenu,
  chainMenuSelect,
  chainGoBtn,
  offerBtn, // appears on the "ask me" choice when a limit is hit
  errorEl,
  getCatalog,
  post, // async (action, body) => Response
  onChained, // ({ id, token }) => void - the tab jumps to the new session
}) {
  let session = null;
  let busy = false;
  let optionsKey = '';

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function fill(select, options, keep) {
    const previous = keep ? select.value : '';
    select.innerHTML = '';
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.append(el);
    }
    if (previous && options.some((o) => o.value === previous)) select.value = previous;
  }

  function labelFor(value) {
    return [...targetSelect.options].find((o) => o.value === value)?.textContent || 'another session';
  }

  // Called when the provider catalog (re)loads, and on every summary.
  // Rebuilt only when the option list actually changed: summaries stream in
  // constantly, and tearing down a select the user has open loses their pick.
  function refreshTargets() {
    const options = buildTargetOptions(getCatalog());
    const key = options.map((o) => `${o.value}|${o.label}`).join('\n');
    if (key === optionsKey) return;
    optionsKey = key;
    fill(targetSelect, options, true);
    fill(chainMenuSelect, options, true);
  }

  async function savePolicy() {
    showError('');
    const rateLimitAction = actionSelect.value;
    const chainTarget = decodeTarget(targetSelect.value);
    if ((rateLimitAction === 'ask' || rateLimitAction === 'chain') && !chainTarget) {
      showError('Pick a chain target first.');
      return;
    }
    const res = await post('chain-policy', { rateLimitAction, chainTarget });
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
    const target = decodeTarget(targetValue);
    if (!target) return;
    busy = true;
    chainGoBtn.disabled = true;
    offerBtn.disabled = true;
    showError('');
    try {
      const res = await post('chain', { target });
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

  actionSelect.addEventListener('change', savePolicy);
  targetSelect.addEventListener('change', savePolicy);
  chainBtn.addEventListener('click', () => {
    chainMenu.hidden = !chainMenu.hidden;
  });
  chainGoBtn.addEventListener('click', () => chainNow(chainMenuSelect.value));
  offerBtn.addEventListener('click', () => chainNow(encodeTarget(session?.chainTarget)));

  // Idempotent: runs on every session summary, so a choice changed in another
  // tab (or an offer raised server-side) shows up here without a refresh.
  function render(next, { supportsRateLimits }) {
    session = next;
    refreshTargets();
    settingsRows.hidden = !supportsRateLimits;
    const target = encodeTarget(next.chainTarget);
    // Never overwrite a control the user is in the middle of using.
    if (document.activeElement !== actionSelect) actionSelect.value = next.autoContinue ? 'wait' : (next.rateLimitAction || 'none');
    if (document.activeElement !== targetSelect && target && [...targetSelect.options].some((o) => o.value === target)) targetSelect.value = target;
    chainBtn.hidden = !next.providerSessionId;
    if (!next.providerSessionId) chainMenu.hidden = true;
    // Default the manual menu to the saved target, else the first option that
    // is not this very session's provider/account - only while it is closed,
    // so an open menu keeps the user's pick.
    if (chainMenu.hidden) {
      if (target && [...chainMenuSelect.options].some((o) => o.value === target)) chainMenuSelect.value = target;
      else {
        const other = [...chainMenuSelect.options].find((o) => decodeTarget(o.value).provider !== next.provider);
        if (other) chainMenuSelect.value = other.value;
      }
    }
    offerBtn.hidden = !(next.chainOffer && next.chainTarget);
    if (!offerBtn.hidden) offerBtn.textContent = `Chain to ${labelFor(target)} now`;
    if (next.chainError) showError(`Chain failed: ${next.chainError}`);
    else if (errorEl.dataset.fromSummary === '1') showError('');
    errorEl.dataset.fromSummary = next.chainError ? '1' : '';
  }

  return { render, refreshTargets };
}
