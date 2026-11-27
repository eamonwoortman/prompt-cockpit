import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSummary, moveFolder, removeFolder, addFolder, editFolders } from '../public/superagent-settings.js';

const row = (over) => ({ index: 0, configured: '/a', resolved: '/a', error: null, exists: true, fixed: false, workflows: [], prompts: [], note: null, ...over });
const globalRow = (over) => row({ index: null, configured: null, resolved: '/home/x/.prompt-cockpit/superagent/workflows', fixed: true, ...over });
const settings = (folders, over = {}) => ({ isDefault: false, default: '/home/x/.prompt-cockpit', error: null, folders, ...over });

test('settingsSummary keeps stored strings and drops non-strings from the list', () => {
  const s = settingsSummary(settings([row({}), row({ index: 1, configured: 7, resolved: null, error: 'bad', exists: false }), row({ index: 2, configured: '/b', resolved: '/b' }), globalRow()]));
  assert.deepEqual(s.list, ['/a', '/b']);
  assert.deepEqual(s.rows.map((r) => r.listIndex), [0, null, 1, null]);
});

test('the global row is fixed', () => {
  const g = settingsSummary(settings([row({}), globalRow()])).rows.at(-1);
  assert.deepEqual([g.fixed, g.canUp, g.canDown, g.canRemove], [true, false, false, false]);
  assert.ok(g.title.endsWith('(global, workflows only)'));
});

test('first row cannot move up, last user row cannot move down', () => {
  const rows = settingsSummary(settings([row({}), row({ index: 1, configured: '/b', resolved: '/b' }), globalRow()])).rows;
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.canUp, r.canDown, r.canRemove]), [[false, true, true], [true, false, true]]);
});

test('listIndex skips non-string entries', () => {
  const s = settingsSummary(settings([row({}), row({ index: 1, configured: 7, resolved: null, error: 'bad', exists: false }), row({ index: 2, configured: '/b', resolved: '/b' }), globalRow()]));
  const b = s.rows.find((r) => r.title === '/b');
  assert.equal(b.listIndex, 1);
  assert.deepEqual(removeFolder(s.list, b.listIndex), ['/a']);
  assert.deepEqual(moveFolder(s.list, b.listIndex, -1), ['/b', '/a']);
  const junk = s.rows[1];
  assert.deepEqual([junk.canUp, junk.canDown, junk.canRemove, junk.status, junk.statusText], [false, false, true, 'error', 'bad']);
});

test('the whole-setting error row cannot be moved or removed', () => {
  const s = settingsSummary(settings([row({ index: null, configured: 'x', resolved: null, error: 'userFolders must be a list of paths', exists: false }), globalRow()], { error: 'userFolders must be a list of paths' }));
  assert.deepEqual(s.list, []);
  assert.deepEqual([s.rows[0].listIndex, s.rows[0].canUp, s.rows[0].canDown, s.rows[0].canRemove], [null, false, false, false]);
  assert.equal(s.error, 'userFolders must be a list of paths');
});

test('a missing folder and the default folder are labelled', () => {
  const s = settingsSummary(settings([row({ exists: false }), globalRow()], { isDefault: true }));
  assert.equal(s.rows[0].status, 'missing');
  assert.ok(s.rows[0].title.endsWith('(default)'));
  assert.equal(s.isDefault, true);
  assert.equal(s.defaultPath, '/home/x/.prompt-cockpit');
});

test('the default folder is posted by its path, so adding a folder keeps it', () => {
  const s = settingsSummary(settings([row({ configured: null, resolved: '/home/x/.prompt-cockpit' }), globalRow()], { isDefault: true }));
  assert.deepEqual(s.list, ['/home/x/.prompt-cockpit']);
  assert.equal(s.rows[0].listIndex, 0);
  assert.deepEqual(addFolder(s.list, '/b'), ['/home/x/.prompt-cockpit', '/b']);
  assert.deepEqual(removeFolder(s.list, 0), []);
});

test('item details by status', () => {
  const r = settingsSummary(settings([row({
    workflows: [
      { id: 'x', name: 'X', valid: true, errors: [], description: 'does x', status: 'used', shadowedBy: null },
      { id: 'y', name: 'Y', valid: true, errors: [], description: '', status: 'shadowed', shadowedBy: '/b' },
      { id: null, name: 'broken.json', valid: false, errors: [{ path: null, message: 'not valid JSON' }], description: '', status: 'invalid', shadowedBy: null },
    ],
    prompts: [
      { file: 'tester.md', role: 'tester', status: 'used', shadowedBy: null, reason: null },
      { file: 'planner.md', role: 'planner', status: 'shadowed', shadowedBy: '/b', reason: null },
      { file: 'contract.md', role: 'contract', status: 'ignored', shadowedBy: null, reason: 'the contract is built in' },
    ],
  }), globalRow()])).rows[0];
  assert.deepEqual(r.workflows.map((w) => [w.label, w.status, w.detail]), [['X', 'used', 'does x'], ['Y', 'shadowed', 'Shadowed by /b'], ['broken.json', 'invalid', 'not valid JSON']]);
  assert.deepEqual(r.prompts.map((p) => [p.label, p.status, p.detail]), [['tester.md', 'used', 'Used for the tester role'], ['planner.md', 'shadowed', 'Shadowed by /b'], ['contract.md', 'ignored', 'Ignored: the contract is built in']]);
});

test('moveFolder/removeFolder/addFolder', () => {
  assert.deepEqual(moveFolder(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveFolder(['a', 'b'], 0, 1), ['b', 'a']);
  assert.deepEqual(moveFolder(['a'], 0, -1), ['a']);
  assert.deepEqual(moveFolder(['a', 'b'], 1, 1), ['a', 'b']);
  assert.deepEqual(removeFolder(['a', 'b'], 0), ['b']);
  assert.deepEqual(removeFolder(['a'], 5), ['a']);
  assert.deepEqual(addFolder(['a'], '  b '), ['a', 'b']);
  const list = ['a'];
  moveFolder(list, 0, 1);
  removeFolder(list, 0);
  addFolder(list, 'c');
  assert.deepEqual(list, ['a']);
});

test('no list edit is possible before the settings have loaded', () => {
  assert.equal(editFolders(null, { add: '/c' }), null);
  assert.equal(editFolders(null, { move: 0, delta: 1 }), null);
  const s = settingsSummary(settings([row({}), row({ index: 1, configured: '/b', resolved: '/b' }), globalRow()]));
  assert.deepEqual(editFolders(s, { add: ' /c ' }), ['/a', '/b', '/c']);
  assert.deepEqual(editFolders(s, { move: 1, delta: -1 }), ['/b', '/a']);
  assert.deepEqual(editFolders(s, { remove: 0 }), ['/b']);
  assert.deepEqual(editFolders(s, { remove: null }), ['/a', '/b']);
});
