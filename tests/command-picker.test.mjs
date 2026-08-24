import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCommands } from '../public/command-picker.js';

const COMMANDS = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'candidate_bullets', description: 'Generate candidate bullets' },
  { name: 'model', description: 'Switch model' },
  { name: 'ask', aliases: ['question'], description: 'Ask a sub-question' },
];

test('filterCommands: empty needle returns everything, alphabetically sorted', () => {
  const names = filterCommands(COMMANDS, '').map((c) => c.name);
  assert.deepEqual(names, ['ask', 'candidate_bullets', 'clear', 'model']);
});

test('filterCommands: matches a substring anywhere in the name, not just a prefix', () => {
  // "bullet" isn't a prefix of "candidate_bullets" - this is the whole point.
  const names = filterCommands(COMMANDS, 'bullet').map((c) => c.name);
  assert.deepEqual(names, ['candidate_bullets']);
});

test('filterCommands: prefix matches still work', () => {
  const names = filterCommands(COMMANDS, 'cl').map((c) => c.name);
  assert.deepEqual(names, ['clear']);
});

test('filterCommands: matches are case-insensitive', () => {
  const names = filterCommands(COMMANDS, 'BULLET').map((c) => c.name);
  assert.deepEqual(names, ['candidate_bullets']);
});

test('filterCommands: matches an alias substring too', () => {
  const names = filterCommands(COMMANDS, 'quest').map((c) => c.name);
  assert.deepEqual(names, ['ask']);
});

test('filterCommands: multiple matches come back alphabetically, not in input order', () => {
  // "clear" is listed before "candidate_bullets" in COMMANDS but "c" matches both.
  const names = filterCommands(COMMANDS, 'c').map((c) => c.name);
  assert.deepEqual(names, ['candidate_bullets', 'clear']);
});

test('filterCommands: no match returns an empty list', () => {
  assert.deepEqual(filterCommands(COMMANDS, 'zzz'), []);
});
