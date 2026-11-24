import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestPath } from '../src/superagent/test-paths.js';
import { defaultConfig } from '../src/superagent/config.js';

const DEFAULT = defaultConfig().testPaths;

test('default globs match test files and folders', () => {
  for (const rel of [
    'FallGuys_MP/SharedUnityPackages/x/Tests/Editor/FooTests.cs',
    'src/app.test.js',
    'pkg/__tests__/a.js',
    'a_test.go',
    'tests/a.mjs',
    'x/Bar/BarTest.cs',
  ]) assert.equal(isTestPath(rel, DEFAULT), true, rel);
});

test('a .meta next to a test matches', () => {
  assert.equal(isTestPath('FallGuys_MP/SharedUnityPackages/x/Tests/Editor/FooTests.cs.meta', DEFAULT), true);
  assert.equal(isTestPath('x/Bar/BarTest.cs.meta', DEFAULT), true);
});

test('non-test paths do not match', () => {
  for (const rel of ['src/latest.js', 'docs/testing.md', 'Contest.cs', 'src/app.js', 'x/Contest.cs.meta']) {
    assert.equal(isTestPath(rel, DEFAULT), false, rel);
  }
});

test('backslash paths are normalised', () => {
  assert.equal(isTestPath('pkg\\Tests\\Editor\\FooTests.cs', DEFAULT), true);
  assert.equal(isTestPath('src\\app.js', DEFAULT), false);
});

test('custom globs and an empty list', () => {
  assert.equal(isTestPath('spec_helpers/a.rb', ['spec_helpers/**']), true);
  assert.equal(isTestPath('src/a.test.js', []), false);
});
