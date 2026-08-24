// Runs `claude -p "/usage" --output-format json` as a one-off headless
// query and returns its plain-text result - the same table the CLI's own
// interactive /usage command shows. Confirmed by hand: num_turns:0,
// total_cost_usd:0 - the harness answers /usage from the account's own
// subscription backend, not a billed model turn - and it returns in a few
// seconds. Still a real subprocess spawn though, so this stays on-demand
// (dashboard's own "Refresh limits" button), never polled.
//
// Deliberately shells out rather than reading local transcripts (unlike
// global-stats.js, in the same directory): the two top lines ("Current
// session"/"Current week ... used") reflect the account's actual plan
// quota, tracked server-side by Anthropic across every device signed into
// this account - exactly what local transcript-scanning can never see (see
// global-stats.js's own module comment on that boundary). The rest of the
// CLI's own output (top skills/subagents/MCP servers) is explicitly
// local-machine-only per its own disclaimer text in the result, kept as-is
// rather than re-derived here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20_000;
// /api/account-limits (server.js) has no session token to gate it - like
// /api/browse/etc it relies on Origin/Host allowlisting only (an
// operator-level token to close that gap is still an open idea). Unlike
// those read-only routes, this one spawns a real subprocess on every GET
// with no rate limit of its own - the worst route in the app to leave open
// in that sense (2026-08-24 review). A short single-flight+TTL cache here
// means N rapid/concurrent
// requests (a buggy client retry loop, or literally anyone else on
// 127.0.0.1) collapse into at most one `claude -p` spawn per window,
// without changing the on-demand "own button, not polled" contract the
// module comment above already describes.
const CACHE_TTL_MS = 30_000;
let cached = null; // { result, atMs }
let inFlight = null; // Promise, shared by concurrent callers while one spawn is running

// Test-only: clears the module-level cache/in-flight state between test
// cases (same pattern as session-registry.js's own `_reset`) - without it,
// a cached result from one test's fake `claudeBin` would leak into the
// next test's assertions, since the cache isn't (and in production doesn't
// need to be) keyed by claudeBin.
export function _resetCacheForTests() {
  cached = null;
  inFlight = null;
}

export async function fetchAccountLimits(claudeBin = 'claude') {
  if (cached && Date.now() - cached.atMs < CACHE_TTL_MS) return cached.result;
  if (inFlight) return inFlight;
  inFlight = doFetch(claudeBin).then((result) => {
    cached = { result, atMs: Date.now() };
    return result;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doFetch(claudeBin) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      claudeBin,
      ['-p', '/usage', '--output-format', 'json'],
      // tmpdir, not process.cwd() - this is an account-level query, not
      // project-scoped, and running it from a real project dir would pull
      // in that project's CLAUDE.md/hooks for no benefit, just latency.
      { cwd: tmpdir(), timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    ));
  } catch (err) {
    // execFile throws on non-zero exit or timeout - surface stderr (or the
    // timeout) rather than a bare "Command failed" that named nothing.
    throw new Error(err.stderr?.trim() || err.message || String(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('unexpected output from claude -p "/usage" (not JSON)');
  }
  if (parsed.is_error) throw new Error(parsed.result || 'claude -p "/usage" reported an error');
  return { text: parsed.result || '', fetchedAtMs: Date.now() };
}
