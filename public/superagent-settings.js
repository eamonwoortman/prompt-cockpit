// Pure presentation of GET /api/superagent/settings for the Settings dialog.

const firstError = (entry) => {
  const e = entry.errors?.[0];
  if (!e) return 'invalid';
  return e.path ? `${e.path}: ${e.message}` : e.message;
};

export function settingsSummary(settings) {
  const folder = settings?.userFolder ?? {};
  const isDefault = folder.configured == null;
  const error = folder.error ? (folder.error.error ?? folder.error.message ?? String(folder.error)) : null;
  let status = 'ok';
  let statusText = 'Folder exists';
  if (error) {
    status = 'error';
    statusText = error;
  } else if (!folder.exists) {
    status = 'missing';
    statusText = 'Folder does not exist yet; saving creates it.';
  }
  return {
    field: folder.configured ?? '',
    resolved: folder.resolved ?? null,
    defaultPath: folder.default ?? null,
    isDefault,
    status,
    statusText,
    workflows: (settings?.workflows ?? []).map((w) => ({
      label: w.name ?? w.id ?? '(unnamed)',
      id: w.id ?? null,
      valid: Boolean(w.valid),
      detail: w.valid ? (w.description ?? '') : firstError(w),
    })),
    prompts: (settings?.prompts ?? []).map((p) => ({
      label: p.file,
      used: Boolean(p.used),
      detail: p.used ? `Used for the ${p.role} role` : (p.role === 'contract' ? 'Ignored: the contract is built in' : 'Ignored: not a role name'),
    })),
    note: settings?.note ?? null,
  };
}
