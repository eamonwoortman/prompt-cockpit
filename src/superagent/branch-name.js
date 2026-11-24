const WORDS = 6;
const FORBIDDEN_CHARS = /[\u0000- \u007f~^:?*[\\]/;

export function ticketFromIdea(idea) {
  const text = typeof idea === 'string' ? idea : '';
  const match = /_workitems\/edit\/(\d+)/.exec(text) ?? /\bADO\s*#?(\d+)/i.exec(text) ?? /#(\d{4,})/.exec(text);
  return match ? match[1] : '';
}

export function describe(job) {
  const text = job.tasks?.[0]?.title ?? job.title ?? '';
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, WORDS).join('-');
}

export function isValidBranchName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (FORBIDDEN_CHARS.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  return name.split('/').every((segment) => segment !== '' && !segment.startsWith('.') && !segment.endsWith('.lock'));
}

export function suggestBranch(job, { isValid = isValidBranchName } = {}) {
  const current = job.finalBranch ?? job.branch;
  if (typeof job.branchTemplate !== 'string' || job.branchTemplate === '') return current;
  const values = { ticket: ticketFromIdea(job.idea), description: describe(job), slug: job.slug ?? '' };
  const filled = job.branchTemplate
    .replace(/\{(ticket|description|slug)\}/g, (_, key) => values[key])
    .replace(/\/-+/g, '/')
    .replace(/-{2,}/g, '-')
    .split('/')
    .map((segment) => segment.replace(/^-+|-+$/g, ''))
    .join('/');
  return isValid(filled) ? filled : current;
}
