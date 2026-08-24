// Regression coverage for the 2026-08-24 review fix: /api/account-limits
// has no session token (Origin/Host-only gate, see account-limits.js's own
// module comment) and spawns a real `claude -p` subprocess per call - a
// short single-flight+TTL cache should collapse rapid/concurrent callers
// into one spawn instead of one process per request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchAccountLimits, _resetCacheForTests } from '../src/account-limits.js';

// A fake `claude` binary: each invocation appends to a counter file and
// prints the same valid `/usage` JSON payload real fetchAccountLimits
// expects to parse.
async function makeFakeClaudeBin(dir, { result = 'Current session: 10% used' } = {}) {
  const counterFile = path.join(dir, 'calls');
  await writeFile(counterFile, '0');
  const script = path.join(dir, 'claude');
  await writeFile(script, `#!/bin/sh
n=$(cat "${counterFile}")
echo $((n + 1)) > "${counterFile}"
echo '{"is_error": false, "result": "${result}"}'
`);
  await chmod(script, 0o755);
  return { script, counterFile };
}

async function readCallCount(counterFile) {
  return Number((await readFile(counterFile, 'utf8')).trim());
}

test('fetchAccountLimits dedupes concurrent calls into a single subprocess spawn', async () => {
  _resetCacheForTests();
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-limits-'));
  try {
    const { script, counterFile } = await makeFakeClaudeBin(dir);
    const [a, b, c] = await Promise.all([
      fetchAccountLimits(script),
      fetchAccountLimits(script),
      fetchAccountLimits(script),
    ]);
    assert.equal(a.text, 'Current session: 10% used');
    assert.equal(b.text, a.text);
    assert.equal(c.text, a.text);
    assert.equal(await readCallCount(counterFile), 1, 'three concurrent callers must collapse into one spawn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchAccountLimits serves a cached result on a second call shortly after, without spawning again', async () => {
  _resetCacheForTests();
  const dir = await mkdtemp(path.join(tmpdir(), 'cockpit-limits-'));
  try {
    const { script, counterFile } = await makeFakeClaudeBin(dir, { result: 'Current session: 5% used' });
    const first = await fetchAccountLimits(script);
    const second = await fetchAccountLimits(script);
    assert.equal(first.text, 'Current session: 5% used');
    assert.equal(second.text, first.text);
    assert.equal(await readCallCount(counterFile), 1, 'the second call within the TTL must be served from cache, not a fresh spawn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
