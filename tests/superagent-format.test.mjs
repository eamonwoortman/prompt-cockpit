import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub } from './helpers/dom-stub.mjs';

installDomStub();
const { renderMarkdown } = await import('../public/markdown.js');
const { linkChipLabel, linkChip, formatUsd, formatMoney, formatTokens, formatDuration, stageColorIndex, statusLabel } =
  await import('../public/superagent-format.js');

test('linkChipLabel takes the host and the last path segment', () => {
  assert.deepEqual(
    linkChipLabel('https://dev.azure.com/mediatonic/Fall%20Guys%20Client/_workitems/edit/171558'),
    { host: 'dev.azure.com', label: '171558' },
  );
  assert.deepEqual(
    linkChipLabel('https://mediatonicgames.sentry.io/issues/4908023691/?project=4503970822242144'),
    { host: 'mediatonicgames.sentry.io', label: '4908023691' },
  );
  assert.deepEqual(linkChipLabel('https://www.github.com/a/b/pull/12'), { host: 'github.com', label: '12' });
  assert.deepEqual(linkChipLabel('https://example.com/'), { host: 'example.com', label: '' });
});

test('linkChip builds a safe anchor with the full URL as title', () => {
  const a = linkChip('https://www.github.com/a/b/pull/12');
  assert.equal(
    a.toHTML(),
    '<a class="sa-link-chip" href="https://www.github.com/a/b/pull/12" target="_blank" rel="noopener noreferrer" title="https://www.github.com/a/b/pull/12">github.com · 12</a>',
  );
  assert.equal(linkChip('https://example.com/', 'Docs').textContent, 'Docs');
  assert.equal(linkChip('https://example.com/').textContent, 'example.com');
});

test('formatUsd', () => {
  assert.equal(formatUsd(0.004), '< $0.01');
  assert.equal(formatUsd(16.06), '$16.06');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(0), '$0.00');
});

test('formatTokens', () => {
  assert.equal(formatTokens(7_276_245), '7.3M');
  assert.equal(formatTokens(412_000), '412k');
  assert.equal(formatTokens(950), '950');
});

test('formatDuration', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(840_000), '14m');
  assert.equal(formatDuration(3_900_000), '1h 05m');
});

test('stageColorIndex wraps at 8', () => {
  assert.equal(stageColorIndex(0), 0);
  assert.equal(stageColorIndex(9), 1);
});

test('a bare URL autolinked through linkChip shows host and id, not the URL', () => {
  const out = renderMarkdown('see https://www.github.com/a/b/pull/12.', { autolink: true, renderLink: linkChip }).toHTML();
  assert.ok(out.includes('>github.com · 12</a>'));
  assert.ok(!out.includes('>https://'));
});

test('formatMoney follows the money rules: unknown, lower bound, exact zero, nothing', () => {
  assert.equal(formatMoney({ usd: null, complete: false }), 'not available');
  assert.equal(formatMoney({ usd: 4.2, complete: false }), 'at least $4.20');
  assert.equal(formatMoney({ usd: 0, complete: true }), '$0.00');
  assert.equal(formatMoney({ usd: 16.42, complete: true }), '$16.42');
  assert.equal(formatMoney({ usd: null, complete: true }), null);
  assert.equal(formatMoney(null), null);
});

test('statusLabel shows a folder-changed pause as paused', () => {
  assert.equal(statusLabel({ status: 'needs-you', reason: 'folder-changed' }), 'paused');
  assert.equal(statusLabel({ status: 'needs-you', reason: 'question' }), 'needs you');
  assert.equal(statusLabel({ status: 'running' }), 'running');
  assert.equal(statusLabel({ status: 'odd' }), 'odd');
});
