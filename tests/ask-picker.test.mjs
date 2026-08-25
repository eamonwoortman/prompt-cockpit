import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskDraft, formatAskPrefix, filterAskTargets } from '../public/ask-picker.js';

test('parseAskDraft: /ask and /ask[space] are in the name-picking zone with an empty needle', () => {
  assert.deepEqual(parseAskDraft('/ask', 4), { needle: '' });
  assert.deepEqual(parseAskDraft('/ask ', 5), { needle: '' });
  assert.deepEqual(parseAskDraft('/ASK', 4), { needle: '' });
});

test('parseAskDraft: a partial name before the colon is the needle', () => {
  assert.deepEqual(parseAskDraft('/ask Gro', 8), { needle: 'Gro' });
  assert.deepEqual(parseAskDraft('/ask Gro', 6), { needle: 'G' });
});

test('parseAskDraft: a colon means the name is done (required for /ask Name: text to send)', () => {
  assert.equal(parseAskDraft('/ask Grok:', 10), null);
  assert.equal(parseAskDraft('/ask Grok: hello', 16), null);
  assert.equal(parseAskDraft('/ask Grok: ', 11), null);
});

test('parseAskDraft: not a leading /ask is ignored', () => {
  assert.equal(parseAskDraft('please /ask Grok', 16), null);
  assert.equal(parseAskDraft('/model', 6), null);
  assert.equal(parseAskDraft('', 0), null);
});

test('formatAskPrefix always includes the colon and a trailing space', () => {
  assert.equal(formatAskPrefix('Grok'), '/ask Grok: ');
  assert.equal(formatAskPrefix('Claude'), '/ask Claude: ');
});

const SESSIONS = [
  { id: 'self', name: 'Me', cwd: '/tmp/a', provider: 'claude' },
  { id: 'g', name: 'Grok', cwd: '/tmp/a', provider: 'grok' },
  { id: 'c', name: 'Claude', cwd: '/tmp/a', provider: 'claude' },
  { id: 'othercwd', name: 'Elsewhere', cwd: '/tmp/b', provider: 'claude' },
  { id: 'noname', name: null, cwd: '/tmp/a', provider: 'claude' },
];

test('filterAskTargets drops the calling session, unnamed rows, and other cwds', () => {
  const names = filterAskTargets(SESSIONS, { selfId: 'self', cwd: '/tmp/a', needle: '' }).map((s) => s.name);
  assert.deepEqual(names, ['Claude', 'Grok']);
});

test('filterAskTargets matches a name needle case-insensitively', () => {
  const names = filterAskTargets(SESSIONS, { selfId: 'self', cwd: '/tmp/a', needle: 'gro' }).map((s) => s.name);
  assert.deepEqual(names, ['Grok']);
});

test('filterAskTargets with a single sibling is still returned (picker auto-completes from this)', () => {
  const only = [
    { id: 'self', name: 'Me', cwd: '/tmp/a' },
    { id: 'g', name: 'Grok', cwd: '/tmp/a' },
  ];
  const names = filterAskTargets(only, { selfId: 'self', cwd: '/tmp/a', needle: '' }).map((s) => s.name);
  assert.deepEqual(names, ['Grok']);
});
