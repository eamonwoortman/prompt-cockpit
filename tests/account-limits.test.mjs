// Regression coverage for the 2026-08-24 review fix: /api/account-limits
// has no session token (Origin/Host-only gate, see account-limits.js's own
// module comment) and spawns a real `claude -p` subprocess per call - a
// short single-flight+TTL cache should collapse rapid/concurrent callers
// into one spawn instead of one process per request.
//
// Uses the injectable execFileImpl (see account-limits.js's own comment on
// it) instead of a real spawned subprocess - a fake `claude` binary written
// as a shell script can't be spawned by execFile without `shell: true` on
// Windows (Node refuses bare .bat/.cmd files post-CVE-2024-27980, and a
// plain-text file has no PE header to run directly), so a real cross-platform
// spawn isn't worth chasing when what's under test is the cache/dedupe logic,
// not child_process itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAccountLimits, _resetCacheForTests } from '../src/account-limits.js';

// A fake execFileImpl: same shape as promisify(execFile) - takes
// (file, args, options) and resolves { stdout }. Counts calls and returns
// the same valid `/usage` JSON payload real fetchAccountLimits expects to
// parse, mirroring what the real `claude -p` subprocess prints.
function makeFakeExecFile({ result = 'Current session: 10% used' } = {}) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return { stdout: JSON.stringify({ is_error: false, result }) };
  };
  return { impl, callCount: () => calls };
}

test('fetchAccountLimits dedupes concurrent calls into a single subprocess spawn', async () => {
  _resetCacheForTests();
  const { impl, callCount } = makeFakeExecFile();
  const [a, b, c] = await Promise.all([
    fetchAccountLimits('claude', impl),
    fetchAccountLimits('claude', impl),
    fetchAccountLimits('claude', impl),
  ]);
  assert.equal(a.text, 'Current session: 10% used');
  assert.equal(b.text, a.text);
  assert.equal(c.text, a.text);
  assert.equal(callCount(), 1, 'three concurrent callers must collapse into one spawn');
});

test('fetchAccountLimits serves a cached result on a second call shortly after, without spawning again', async () => {
  _resetCacheForTests();
  const { impl, callCount } = makeFakeExecFile({ result: 'Current session: 5% used' });
  const first = await fetchAccountLimits('claude', impl);
  const second = await fetchAccountLimits('claude', impl);
  assert.equal(first.text, 'Current session: 5% used');
  assert.equal(second.text, first.text);
  assert.equal(callCount(), 1, 'the second call within the TTL must be served from cache, not a fresh spawn');
});
