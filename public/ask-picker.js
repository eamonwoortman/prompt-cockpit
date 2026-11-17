// `/ask <Name>: <text>` target-name autocomplete. Cockpit owns `/ask`
// client-side (app.js's onSend); this picker fills the name (and the
// required colon) so a typo does not fall through as a fake CLI command.
// The dropdown opens *above* the compose box (same `bottom:` positioning
// as command-picker.js).

export function parseAskDraft(text, caret) {
  if (typeof text !== 'string') return null;
  const pos = Number.isFinite(caret) ? caret : text.length;
  const prefix = text.slice(0, pos);
  const match = /^\/ask(?:\s+(.*))?$/i.exec(prefix);
  if (!match) return null;
  const rest = match[1] ?? '';
  if (rest.includes(':')) return null;
  return { needle: rest };
}

export function formatAskPrefix(name) {
  return `/ask ${name}: `;
}

// A lone sibling session fills `/ask Name: ` for the user, but only while they
// are typing forward. On a deletion the same text (`/ask`, `/ask `) would be
// refilled at once, so the prefix could never be backspaced away.
export function shouldAutoFill({ targetCount, needle, inputType }) {
  const deleting = typeof inputType === 'string' && inputType.startsWith('delete');
  return targetCount === 1 && !String(needle || '').trim() && !deleting;
}

export function filterAskTargets(sessions, { selfId, cwd, needle } = {}) {
  const n = (needle || '').trim().toLowerCase();
  const wantCwd = cwd || '';
  return (sessions || [])
    .filter((s) => {
      if (!s || !s.name) return false;
      if (selfId && s.id === selfId) return false;
      if (wantCwd && s.cwd !== wantCwd) return false;
      if (n && !s.name.toLowerCase().includes(n)) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function initAskPicker({ textarea, dropdown, listSessions, getSelfId, getCwd }) {
  let activeIndex = -1;
  let items = [];
  let gen = 0;

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('blur', () => setTimeout(close, 150));

  async function onInput(event) {
    const draft = parseAskDraft(textarea.value, textarea.selectionStart);
    if (!draft) return close();

    const my = ++gen;
    let sessions = [];
    try {
      sessions = await listSessions();
    } catch {
      return close();
    }
    if (my !== gen) return;

    const all = filterAskTargets(sessions, {
      selfId: getSelfId(),
      cwd: getCwd(),
      needle: '',
    });
    if (all.length === 0) return close();

    // Exactly one other named same-cwd session: fill `/ask Name: ` and
    // never open the list. Only when the user has not started a name yet,
    // so typing `/ask X` against a single session named Grok is left alone.
    if (shouldAutoFill({ targetCount: all.length, needle: draft.needle, inputType: event && event.inputType })) {
      insert(all[0].name);
      return;
    }
    // Backspacing down to `/ask` with a lone sibling falls through to the
    // list below: the text is left alone and Tab/Enter fills the name back.

    items = filterAskTargets(sessions, {
      selfId: getSelfId(),
      cwd: getCwd(),
      needle: draft.needle,
    });
    activeIndex = items.length > 0 ? 0 : -1;
    render();
  }

  function insert(name) {
    textarea.value = formatAskPrefix(name);
    const caret = textarea.value.length;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function render() {
    if (items.length === 0) return close();
    dropdown.innerHTML = '';
    items.forEach((session, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      li.className = i === activeIndex ? 'active' : '';
      const name = document.createElement('span');
      name.className = 'cmd-name';
      name.textContent = session.name;
      const desc = document.createElement('span');
      desc.className = 'cmd-desc';
      desc.textContent = session.provider || '';
      li.append(name, desc);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        select(i);
      });
      dropdown.append(li);
    });
    dropdown.classList.add('show');
  }

  function select(i) {
    const session = items[i];
    if (!session) return;
    insert(session.name);
  }

  function onKeydown(event) {
    if (!dropdown.classList.contains('show')) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      select(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  function close() {
    dropdown.classList.remove('show');
    dropdown.innerHTML = '';
    items = [];
    activeIndex = -1;
  }
}
