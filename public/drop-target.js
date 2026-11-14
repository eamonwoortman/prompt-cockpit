// Drag-and-drop and paste onto the compose box, inserting an `@path`
// reference at the caret. The browser can't expose a dropped file's real
// path, so a drop first tries to resolve the basename inside cwd via the same
// file-suggestions search `@`-autocomplete uses; anything that doesn't
// resolve (and every pasted screenshot) is uploaded into the project's
// .claude/cockpit-uploads/ (see src/uploads.js) and referenced from there.
export function initDropTarget({ textarea, getSessionId, getSessionToken }) {
  textarea.addEventListener('dragover', (event) => {
    event.preventDefault(); // required for 'drop' to fire at all
    event.dataTransfer.dropEffect = 'copy';
    textarea.classList.add('drag-over');
  });
  textarea.addEventListener('dragleave', () => textarea.classList.remove('drag-over'));
  textarea.addEventListener('drop', (event) => {
    event.preventDefault();
    textarea.classList.remove('drag-over');
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length === 0) return;
    handleFiles(files, { tryResolve: true });
  });

  // Pasted files/screenshots only: plain-text pastes fall through untouched.
  textarea.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length === 0) return;
    // A clipboard carrying text too (a spreadsheet cell, rich text with an
    // image) is a text paste first - don't swallow it.
    if (event.clipboardData?.getData('text/plain')) return;
    event.preventDefault();
    handleFiles(files, { tryResolve: false }); // clipboard names ("image.png") are never real cwd paths
  });

  async function handleFiles(files, { tryResolve }) {
    const id = getSessionId();
    if (!id) return;
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop -- sequential so each
      // insertion's caret position is known before the next one starts.
      await insertOne(id, file, tryResolve);
    }
    textarea.focus();
  }

  async function insertOne(sessionId, file, tryResolve) {
    const name = file.name || 'image.png';
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    const after = textarea.value.slice(pos);
    // Bare name first - immediate feedback, no round trip yet.
    textarea.value = `${before}${name} ${after}`;
    let caret = pos + name.length + 1;
    textarea.setSelectionRange(caret, caret);

    const resolved = (tryResolve && (await resolve(sessionId, name))) || (await upload(sessionId, file, name));
    if (!resolved) return; // neither resolved nor uploaded - stays a bare name, honestly

    // Replace exactly the span this drop inserted (`name` plus its
    // trailing space), not a blind string search - the textarea may have
    // been edited between the insert above and this resolving, and a
    // naive replace could hit an unrelated later occurrence of `name`.
    const current = textarea.value;
    const spanStart = pos;
    const spanEnd = pos + name.length + 1;
    if (current.slice(spanStart, spanEnd) !== `${name} `) return; // edited since - leave it alone
    const token = `@${resolved} `;
    textarea.value = current.slice(0, spanStart) + token + current.slice(spanEnd);
    caret = spanStart + token.length;
    textarea.setSelectionRange(caret, caret);
  }

  // Reuses the exact endpoint `@`-autocomplete calls (file-picker.js) -
  // same cwd-glob fallback, same substring match. Only resolves when the
  // basename is unambiguous: multiple hits (or none) means "don't guess".
  async function resolve(sessionId, name) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/file-suggestions?q=${encodeURIComponent(name)}`, {
        headers: { authorization: `Bearer ${getSessionToken()}` },
      });
      if (!res.ok) return null;
      const items = await res.json(); // [{ path, source }, ...] - see sdk-adapter.js's fileSuggestions
      // Cross-platform basename: `path` came from Node's path.relative(),
      // which uses `\` on Windows - splitting on `/` alone (the old code)
      // only worked for files directly in cwd's root there.
      const exact = items.filter((item) => item.path.split(/[\\/]/).pop() === name);
      return exact.length === 1 ? exact[0].path : null;
    } catch {
      return null;
    }
  }

  // Saves the file's bytes under cwd and returns the cwd-relative path, or
  // null on any failure (too large, network, server error).
  async function upload(sessionId, file, name) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/upload?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${getSessionToken()}`, 'content-type': 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) return null;
      return (await res.json()).path;
    } catch {
      return null;
    }
  }
}
