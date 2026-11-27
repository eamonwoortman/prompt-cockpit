// Pure presentation of GET /api/superagent/settings for the Settings dialog,
// plus the list edits its buttons post back.

const firstError = (entry) => {
  const e = entry.errors?.[0];
  if (!e) return 'invalid';
  return e.path ? `${e.path}: ${e.message}` : e.message;
};

function workflowDetail(w) {
  if (w.status === 'shadowed') return `Shadowed by ${w.shadowedBy}`;
  if (w.status === 'invalid') return firstError(w);
  return w.description ?? '';
}

function promptDetail(p) {
  if (p.status === 'shadowed') return `Shadowed by ${p.shadowedBy}`;
  if (p.status === 'ignored') return `Ignored: ${p.reason}`;
  return `Used for the ${p.role} role`;
}

function rowTitle(folder, isDefault) {
  if (folder.fixed) return `${folder.resolved} (global, workflows only)`;
  const text = typeof folder.configured === 'string' ? folder.configured : JSON.stringify(folder.configured ?? folder.resolved);
  return isDefault ? `${folder.resolved} (default)` : text;
}

export function settingsSummary(settings) {
  const isDefault = Boolean(settings?.isDefault);
  const folders = settings?.folders ?? [];
  const list = [];
  const rows = folders.map((folder) => {
    // The unset default has no stored string, so it is posted by its path: an add keeps it.
    const value = isDefault && !folder.fixed && folder.configured == null ? folder.resolved : folder.configured;
    const postable = !folder.fixed && folder.index !== null && typeof value === 'string';
    const listIndex = postable ? list.push(value) - 1 : null;
    let status = 'ok';
    let statusText = '';
    if (folder.error) {
      status = 'error';
      statusText = folder.error;
    } else if (!folder.exists) {
      status = 'missing';
      statusText = 'Folder not found';
    }
    return {
      listIndex,
      title: rowTitle(folder, isDefault && !folder.fixed),
      resolved: folder.resolved ?? null,
      fixed: Boolean(folder.fixed),
      status,
      statusText,
      note: folder.note ?? null,
      canRemove: postable || (!folder.fixed && folder.index !== null),
      workflows: (folder.workflows ?? []).map((w) => ({ label: w.name ?? w.id ?? '(unnamed)', status: w.status, detail: workflowDetail(w) })),
      prompts: (folder.prompts ?? []).map((p) => ({ label: p.file, status: p.status, detail: promptDetail(p) })),
    };
  });
  for (const r of rows) {
    r.canUp = r.listIndex !== null && r.listIndex > 0;
    r.canDown = r.listIndex !== null && r.listIndex < list.length - 1;
  }
  return { isDefault, defaultPath: settings?.default ?? null, error: settings?.error ?? null, list, rows };
}

export function moveFolder(list, index, delta) {
  const next = [...list];
  const to = index + delta;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removeFolder(list, index) {
  const next = [...list];
  if (index >= 0 && index < next.length) next.splice(index, 1);
  return next;
}

export function addFolder(list, value) {
  return [...list, String(value).trim()];
}
