// "Is a newer CLI/SDK available?" check behind the launcher's update popup.
//
// Per tool (claude = the Agent SDK package cockpit actually runs, codex, grok):
// installed version vs latest published version. Read-only: it never installs
// anything, it only reports the command the user should run.
//
// Two layers of rate limiting, both in memory (reset on cockpit restart):
//   - results are cached for CHECK_CACHE_MS so starting several sessions in a
//     row doesn't re-spawn a CLI / hit the registry each time;
//   - an outdated result is handed out at most once per NOTIFY_INTERVAL_MS per
//     tool, so every tab and browser together see the popup at most that often.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexSpawnAsync } from './codex-app-server.js';
import { runGrokCommand, parseJsonOutput } from './grok-cli.js';

export const NOTIFY_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const CHECK_CACHE_MS = 30 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 5000;
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const CODEX_PACKAGE = '@openai/codex';
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const UPDATE_CHECK_TOOLS = ['claude', 'codex', 'grok'];

const VERSION_RE = /\d+\.\d+\.\d+/;

// Numeric major.minor.patch compare; prerelease suffixes are ignored (the
// registry's `latest` tag is always a stable release).
export function isNewerVersion(latest, current) {
  const a = String(latest || '').match(VERSION_RE);
  const b = String(current || '').match(VERSION_RE);
  if (!a || !b) return false;
  const pa = a[0].split('.').map(Number);
  const pb = b[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

async function latestFromRegistry(pkg, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${pkg}`);
  const { version } = await res.json();
  if (!version) throw new Error(`npm registry returned no version for ${pkg}`);
  return version;
}

async function installedSdkVersion({ readFileImpl = readFile } = {}) {
  const file = path.join(REPO_ROOT, 'node_modules', ...SDK_PACKAGE.split('/'), 'package.json');
  return JSON.parse(await readFileImpl(file, 'utf8')).version;
}

async function installedCodexVersion({ resolveSpawn = resolveCodexSpawnAsync, spawnImpl = spawn } = {}) {
  const { command, prefixArgs } = await resolveSpawn();
  return await new Promise((resolve, reject) => {
    const proc = spawnImpl(command, [...prefixArgs, '--version'], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      reject(new Error('codex --version timed out'));
    }, NETWORK_TIMEOUT_MS);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.stdout?.on('data', (chunk) => { out += String(chunk); });
    proc.on('close', () => {
      clearTimeout(timer);
      const match = out.match(VERSION_RE);
      if (match) resolve(match[0]);
      else reject(new Error('codex --version printed no version'));
    });
  });
}

// Each probe returns { current, latest, command } or throws. The caller turns
// "latest is not newer" and any failure into "nothing to show".
const PROBES = {
  claude: async (deps) => ({
    current: await installedSdkVersion(deps),
    latest: await latestFromRegistry(SDK_PACKAGE, deps),
    command: `npm install ${SDK_PACKAGE}@latest`,
    note: 'Run it in the prompt-cockpit folder, then restart cockpit.',
    label: 'Claude Agent SDK',
  }),
  codex: async (deps) => ({
    current: await installedCodexVersion(deps),
    latest: await latestFromRegistry(CODEX_PACKAGE, deps),
    command: 'codex update',
    note: 'Close your Codex tabs afterwards so the next one starts the new version.',
    label: 'Codex CLI',
  }),
  grok: async ({ runGrok = runGrokCommand } = {}) => {
    const info = parseJsonOutput(await runGrok(['update', '--check', '--json'], { timeoutMs: 15_000 }));
    return {
      current: info.currentVersion,
      latest: info.updateAvailable ? info.latestVersion : info.currentVersion,
      command: 'grok update',
      note: 'New Grok tabs pick it up; open tabs keep the old version.',
      label: 'Grok CLI',
    };
  },
};

export function createUpdateChecker({ now = Date.now, probes = PROBES, deps = {} } = {}) {
  const cache = new Map(); // tool -> { at, result }
  const inFlight = new Map(); // tool -> Promise
  const lastNotified = new Map(); // tool -> ms timestamp

  async function probe(tool) {
    const cached = cache.get(tool);
    if (cached && now() - cached.at < CHECK_CACHE_MS) return cached.result;
    if (inFlight.has(tool)) return inFlight.get(tool);
    const run = (async () => {
      let result = null;
      try {
        const info = await probes[tool](deps);
        if (isNewerVersion(info.latest, info.current)) result = { tool, ...info };
      } catch {
        // Offline, CLI missing, registry hiccup: say nothing. Not cached, so
        // the next session start tries again.
        return null;
      }
      cache.set(tool, { at: now(), result });
      return result;
    })().finally(() => inFlight.delete(tool));
    inFlight.set(tool, run);
    return run;
  }

  // Returns the update info to show, or null for "show nothing". Marks the
  // tool as notified when it returns info.
  async function check(tool) {
    if (!probes[tool]) return null;
    const last = lastNotified.get(tool);
    if (last !== undefined && now() - last < NOTIFY_INTERVAL_MS) return null;
    const result = await probe(tool);
    if (!result) return null;
    lastNotified.set(tool, now());
    return result;
  }

  return { check };
}

export const updateChecker = createUpdateChecker();
