// Pure presentation helpers for the Superagent tab (no fetching, no state).

export function linkChipLabel(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return { host: '', label: '' };
  }
  const host = url.hostname.replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : '';
  let label = last;
  try {
    label = decodeURIComponent(last);
  } catch {
    label = last;
  }
  return { host, label };
}

// href must already be isSafeHref-approved http(s); markdown.js guarantees it.
export function linkChip(href, label) {
  const parts = linkChipLabel(href);
  const a = document.createElement('a');
  a.classList.add('sa-link-chip');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = href;
  const auto = parts.label ? `${parts.host} · ${parts.label}` : parts.host;
  a.textContent = (label && label !== href ? label : auto) || href;
  return a;
}

export function formatUsd(n) {
  if (n === null || n === undefined) return '—';
  if (n > 0 && n < 0.01) return '< $0.01';
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}

export function stageColorIndex(i) {
  return i % 8;
}

// Money is { usd: number|null, complete: boolean } (R2-5): usd null means no
// part of it was priced, complete false means part of it is unknown. Null when
// there is nothing to show (an empty aggregate, a gated attempt).
export function formatMoney(money) {
  if (!money) return null;
  if (money.usd === null) return money.complete ? null : 'not available';
  return money.complete ? formatUsd(money.usd) : `at least ${formatUsd(money.usd)}`;
}

const STATUS_LABEL = {
  running: 'running', 'needs-you': 'needs you', done: 'done', stopped: 'stopped', failed: 'failed', provisioning: 'provisioning',
};

export function statusLabel(job) {
  if (job.reason === 'folder-changed' && job.status === 'needs-you') return 'paused';
  return STATUS_LABEL[job.status] ?? job.status;
}

// Keyed by workflow id (compared case-insensitively, like sameWorkflowId), so
// a project override of a built-in keeps its emoji; any other workflow gets 🧩.
const WORKFLOW_ICON = { feature: '\u{1F4A1}', troubleshooting: '\u{1F575}\u{FE0F}' };

export function feedbackRoundLabel(n) {
  return n > 0 ? `feedback ${n}` : '';
}

const READY_LABEL = { testReport: 'Test report' };

// A ready-to-try link's label: a workflow key, or a feedback round's key
// (feedback:<N>:triage, feedback:<N>:test:<key>, feedback:<N>:out:<key>).
export function readyInputLabel(key) {
  const m = /^feedback:(\d+):(?:(triage)|(?:test|out):([^:]+))$/.exec(String(key));
  if (!m) return READY_LABEL[key] ?? key;
  if (m[2]) return `Feedback ${m[1]} triage`;
  return `${READY_LABEL[m[3]] ?? m[3]} (feedback ${m[1]})`;
}

export function workflowLabel(workflow) {
  const icon = WORKFLOW_ICON[String(workflow?.id ?? '').toLowerCase()] ?? '\u{1F9E9}';
  return `${icon} ${workflow?.name ?? workflow?.id ?? 'Workflow'}`;
}
