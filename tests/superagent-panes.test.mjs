import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANE_DEFAULTS, readPaneWidths } from '../public/superagent-panes.js';

const storage = (value) => ({ getItem: () => value });

test('readPaneWidths falls back to the defaults for nothing stored, bad JSON or a throwing storage', () => {
  assert.deepEqual(readPaneWidths(storage(null)), PANE_DEFAULTS);
  assert.deepEqual(readPaneWidths(storage('{nope')), PANE_DEFAULTS);
  assert.deepEqual(readPaneWidths({ getItem: () => { throw new Error('denied'); } }), PANE_DEFAULTS);
  assert.deepEqual(readPaneWidths(undefined), PANE_DEFAULTS);
});

test('readPaneWidths: the middle defaults to null (an even split with the right pane)', () => {
  assert.deepEqual(PANE_DEFAULTS, { left: 300, middle: null });
});

test('readPaneWidths keeps stored widths, replaces ones under the minimum or not numbers, and caps the left pane', () => {
  assert.deepEqual(readPaneWidths(storage('{"left":250,"middle":900}')), { left: 250, middle: 900 });
  assert.deepEqual(readPaneWidths(storage('{"left":50,"middle":"wide"}')), PANE_DEFAULTS);
  assert.deepEqual(readPaneWidths(storage('{"left":5000,"middle":2000}')), { left: 600, middle: 2000 });
});
