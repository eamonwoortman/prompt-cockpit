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
