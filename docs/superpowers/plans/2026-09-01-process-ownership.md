# Process Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the cockpit a reusable atomic JSON store and real ownership of the Grok/Codex CLI processes it spawns, so Ctrl-C (or a crash) no longer leaves paid agents running unattended.

**Architecture:** Three new modules, no behavior change to any existing caller. `src/json-store.js` is `settings-file.js`'s atomic-write/serialized-read-modify-write machinery extracted and generalized over an absolute file path; `settings-file.js` keeps its public API and delegates. `src/child-tracker.js` owns a PID registry persisted to `~/.prompt-cockpit/runtime.json`, cross-platform tree-kill, and a start-time-verifying orphan reaper. `src/shutdown.js` is one idempotent async `shutdown()` that closes every live session, kills whatever outlives its grace period, and is wired to Ctrl-C / `SIGTERM` / `SIGBREAK` in `server.js`.

**Tech Stack:** Plain Node.js ESM (no framework, no bundler, no new dependencies). `node:child_process` `spawnSync` for start-time probes and `taskkill`. `node --test` for tests.

**Spec:** `docs/superpowers/specs/2026-09-01-auto-pilot-design.md` — this plan implements **Sequencing phases 1 and 2** only ("`json-store.js` extraction" and "Shutdown + `child-tracker` (Grok and Codex)"). Phases 3–5 are covered by `2026-09-01-auto-pilot-supervisor.md` and `2026-09-01-auto-pilot-ui.md`. Read the spec's "Process ownership" and "Refactor: extract `src/json-store.js`" sections alongside this plan.

## Global Constraints

- **No new npm dependencies.** The spec's Decision 5 ("No cron parser, no new dependency") is the project-wide rule; it applies here too.
- **`npm test` spawns no CLI and touches no network.** It runs `node --test tests/*.test.mjs`. Every child-process call in new code takes an injectable `spawnImpl` / `spawnSyncImpl` / `killImpl` so tests never spawn anything real.
- **Nothing on the session-start path may block on a subprocess.** The OS start-time probe costs 200-800ms on Windows (cold PowerShell) with a 10s worst case, and `retain()` is called from Grok's and Codex's session-start paths. A synchronous probe there stalls the entire HTTP + WebSocket server. It is therefore `spawn`-based and awaited by nobody on that path; the entry is recorded immediately with `osStartedAt: null` and filled in when the probe lands.
- **Durable cockpit-owned files live under `~/.prompt-cockpit/`**, alongside the existing `operator-token` (`src/operator-auth.js:17`). Do **not** create a second cockpit-owned home directory. Every path must be overridable so tests write into a temp dir instead of the real home.
- **Every child-process spawn in THIS plan uses `shell: false` and `windowsHide: true`.** Matching `src/grok-acp.js:219-225`. The one deliberate exception in the wider feature is the auto-pilot run-gate command (supervisor plan, Task 5), which is shell **by design** — it is the operator's own config-file command and needs `&&`; see the spec's Risks #2. Note the spec cites `grok-acp.js:219-226` as the model for the gate's spawn options, but that call site is `shell: false`; only its `cwd`/`windowsHide`/timeout handling carries over.
- **Claude's spawn is not touched.** `child-tracker` covers **Grok and Codex only** (spec Decision 7). The SDK does register its own `process.on('exit')` cleanup (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`) — but read the caveat before treating that as equivalent protection: its handler is `if (process.platform === "win32") try { e.stdin.end() } catch {} else e.kill("SIGTERM")`, so **on Windows, the platform this repo targets, it closes stdin and does not kill**. Excluding Claude here is therefore a scope decision (the spec's Decision 7, which supersedes revision 1's custom-spawner plan), not a claim that the SDK guarantees teardown. If a Claude transport is later observed surviving exit on Windows, that is a real gap and belongs in the backlog next to the `spawnClaudeCodeProcess` follow-up — do not silently widen this plan's scope to cover it.
- **PID verification refuses rather than guesses.** If the reaper cannot confirm a recorded PID is still the process cockpit spawned, it must **not** kill it. Logging an orphan beats killing the operator's editor.
- **Start times are OS-reported, never `Date.now()`.** `ps -o lstart` has 1-second granularity; comparing it against a JS millisecond timestamp with no tolerance means nothing is ever reaped. Tolerance is 3 seconds.
- **Existing tests must keep passing unchanged.** Specifically `tests/settings-file.test.mjs` (5 tests) and `tests/grok-acp.test.mjs`'s `killGrokProcess` test at `tests/grok-acp.test.mjs:197-212`, which asserts `proc.kill()` on POSIX — so `killGrokProcess` keeps its current body and is **not** refactored to delegate.

## File Structure

| File | Responsibility |
|---|---|
| `src/json-store.js` (create) | Atomic JSON write (tmp + rename, Windows unlink-first fallback), corrupt-file refusal, per-path serialized read-modify-write queue. Generic over an absolute file path. |
| `src/settings-file.js` (modify) | Keeps `settingsPath`/`readSettingsFile`/`updateSettingsFile` unchanged as a public API; delegates all I/O to `json-store.js`. |
| `src/child-tracker.js` (create) | PID registry + `runtime.json` persistence, OS start-time probe, existence probe, tree-kill, orphan reaper, and the blocked-pilot set an unreaped orphan produces. |
| `src/shutdown.js` (create) | One idempotent async `shutdown()`: before-close hooks → close every live session → grace period → tree-kill survivors → persist. |
| `src/server.js` (modify) | Wires `shutdown()` to the TTY Ctrl-C keypress handler (with `setRawMode(false)` first), `SIGINT`, `SIGTERM`, `SIGBREAK`. Runs the orphan reaper at boot. |
| `src/grok-session.js`, `src/grok-acp.js`, `src/codex-app-server.js`, `src/codex-session.js` (modify) | Retain/release their spawned PID with the tracker and expose it on the handle as `trackedPid`. |
| `tests/json-store.test.mjs` (create) | The extracted helper's own contract, including array payloads and write-failure handling. |
| `tests/child-tracker.test.mjs` (create) | `runtime.json` lifecycle, Codex shared-process ref-counting, orphan detection, start-time tolerance, refuse-to-kill-when-unverifiable. |
| `tests/shutdown.test.mjs` (create) | Ordering, idempotence, grace period, and that a hook throwing does not abort the rest. |

---

### Task 1: Extract `src/json-store.js` and delegate from `settings-file.js`

Pure refactor. Zero behavior change. Every existing `settings-file` test must pass unchanged.

**Files:**
- Create: `src/json-store.js`
- Modify: `src/settings-file.js` (replace lines 10–111 — the imports plus everything except `settingsPath`, which lives at `src/settings-file.js:14-16` and stays — with delegating wrappers)
- Test: `tests/json-store.test.mjs` (create)
- Test: `tests/settings-file.test.mjs` (must pass unchanged, not edited)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `readJson(filePath: string, fallback?: any) => Promise<any>` — lenient; returns `fallback` for a missing *or* corrupt file.
  - `readJsonChecked(filePath: string, fallback?: any) => Promise<{ value: any, corrupt: boolean }>` — `corrupt: true` means the file exists and failed to parse.
  - `writeJsonAtomic(filePath: string, value: any) => Promise<void>`
  - `updateJson(filePath: string, mutator: (value) => any, opts?: { fallback?: () => any }) => Promise<any>` — serialized per resolved path; `fallback` is a **factory** (not a value), called only when the file is missing. Returns whatever `mutator` returns. Throws if the file exists and is corrupt.
  - `src/settings-file.js` exports stay exactly `settingsPath(cwd)`, `readSettingsFile(cwd)`, `updateSettingsFile(cwd, mutator)`.

- [ ] **Step 1: Write the failing test**

Create `tests/json-store.test.mjs`:

```js
// The atomic-write/serialized-read-modify-write helper extracted out of
// settings-file.js (which now delegates to it). settings-file.test.mjs still
// covers the same guarantees through the settings API; these cover the
// generalized surface it grew in the extraction: an arbitrary absolute path,
// a non-object payload (runtime.json is an array), and a fallback factory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJson, readJsonChecked, writeJsonAtomic, updateJson } from '../src/json-store.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-json-store-'));
}

test('readJson returns the fallback for a missing file', async () => {
  const dir = await makeTmpDir();
  try {
    assert.deepEqual(await readJson(path.join(dir, 'nope.json')), {});
    assert.deepEqual(await readJson(path.join(dir, 'nope.json'), []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJsonChecked distinguishes missing from corrupt', async () => {
  const dir = await makeTmpDir();
  try {
    const missing = path.join(dir, 'missing.json');
    assert.deepEqual(await readJsonChecked(missing), { value: {}, corrupt: false });

    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, '{ not json', 'utf-8');
    assert.deepEqual(await readJsonChecked(bad), { value: {}, corrupt: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic creates missing parent directories and leaves no tmp sibling', async () => {
  const dir = await makeTmpDir();
  try {
    const dest = path.join(dir, 'nested', 'deeper', 'file.json');
    await writeJsonAtomic(dest, { a: 1 });
    assert.deepEqual(JSON.parse(await readFile(dest, 'utf-8')), { a: 1 });
    // Replace an existing file - this is the Windows "cannot rename over an
    // existing file" path.
    await writeJsonAtomic(dest, { a: 2 });
    assert.deepEqual(JSON.parse(await readFile(dest, 'utf-8')), { a: 2 });
    assert.deepEqual(await readdir(path.dirname(dest)), ['file.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateJson uses the fallback factory for a missing file and supports an array payload', async () => {
  const dir = await makeTmpDir();
  try {
    const dest = path.join(dir, 'runtime.json');
    await updateJson(dest, (list) => { list.push({ pid: 7 }); }, { fallback: () => [] });
    await updateJson(dest, (list) => { list.push({ pid: 8 }); }, { fallback: () => [] });
    assert.deepEqual(await readJson(dest, []), [{ pid: 7 }, { pid: 8 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateJson returns the mutator return value', async () => {
  const dir = await makeTmpDir();
  try {
    const dest = path.join(dir, 'file.json');
    const result = await updateJson(dest, (value) => { value.n = 1; return 'ok'; });
    assert.equal(result, 'ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateJson refuses to overwrite a corrupt file, which survives untouched', async () => {
  const dir = await makeTmpDir();
  try {
    const dest = path.join(dir, 'file.json');
    const corrupt = '{ "keep": "me", }';
    await writeFile(dest, corrupt, 'utf-8');
    await assert.rejects(() => updateJson(dest, (v) => { v.x = 1; }), /invalid JSON/);
    assert.equal(await readFile(dest, 'utf-8'), corrupt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two concurrent updateJson calls for the same path both land (serialized read-modify-write)', async () => {
  const dir = await makeTmpDir();
  try {
    const dest = path.join(dir, 'file.json');
    await updateJson(dest, (v) => { v.a = 0; v.b = 0; });
    // Both read the pre-write file if the queue is broken, and one clobbers
    // the other's key - that's the bug the per-path queue exists to stop.
    await Promise.all([
      updateJson(dest, (v) => { v.a = 1; }),
      updateJson(dest, (v) => { v.b = 2; }),
    ]);
    assert.deepEqual(await readJson(dest), { a: 1, b: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write failure rejects the caller and raises no unhandledRejection', async () => {
  const dir = await makeTmpDir();
  // Put a *file* where writeJsonAtomic needs to mkdir a directory, so its
  // mkdir(..., { recursive: true }) fails.
  await writeFile(path.join(dir, 'blocked'), 'not a directory', 'utf-8');

  let unhandled = null;
  const onUnhandledRejection = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(() => updateJson(path.join(dir, 'blocked', 'file.json'), (v) => { v.x = 1; }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled, null, `expected no unhandledRejection, got: ${unhandled}`);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fallback factory is called per update, so two updates cannot share one mutated object', async () => {
  const dir = await makeTmpDir();
  try {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    const fallback = () => [];
    await updateJson(a, (list) => { list.push('a'); }, { fallback });
    await updateJson(b, (list) => { list.push('b'); }, { fallback });
    assert.deepEqual(await readJson(a, []), ['a']);
    assert.deepEqual(await readJson(b, []), ['b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/json-store.test.mjs`
Expected: FAIL — `Cannot find module '.../src/json-store.js'`.

- [ ] **Step 3: Write `src/json-store.js`**

Create `src/json-store.js`. This is `settings-file.js:10-111` lifted with four deliberate changes — keep the existing comments, they explain non-obvious platform and unhandled-rejection behavior:

1. `settingsPath(cwd)` becomes a `filePath` parameter throughout.
2. The private `readSettingsFileChecked` becomes an **exported** `readJsonChecked` (child-tracker and the auto-pilot store both need the corrupt/missing distinction).
3. Its `{ settings, corrupt }` return becomes `{ value, corrupt }`.
4. `updateJson` gains a `fallback` **factory** option, so a non-object payload (`runtime.json` is an array) works without one call's mutations leaking into the next.

The corrupt-file error text is otherwise unchanged, which is what keeps `tests/settings-file.test.mjs`'s `/invalid JSON/` assertion passing:

```js
// Atomic, corruption-safe JSON file read/write plus a per-path serialized
// read-modify-write queue. Extracted from settings-file.js (which now
// delegates here) so cockpit's own durable files under ~/.prompt-cockpit -
// autopilots.json, runtime.json - get the same guarantees a project's
// .claude/settings.local.json already had, instead of each one re-inventing
// tmp-file-plus-rename and the corrupt-file refusal.
//
// Generic over an absolute file path. Nothing here knows about a cwd, a
// project, or a settings schema; settings-file.js keeps that knowledge.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

// Lenient read: a missing file AND a corrupt file both come back as
// `fallback`. Every caller other than updateJson below only ever wants this
// behavior - see readJsonChecked for why updateJson needs the distinction.
export async function readJson(filePath, fallback = {}) {
  const { value } = await readJsonChecked(filePath, fallback);
  return value;
}

// Same read, but also reports whether the file exists AND failed to parse
// (as opposed to simply not existing). A missing file is fine to treat as
// empty; a corrupt one is not - updateJson must not write the fallback back
// over content a user could otherwise have recovered by hand.
export async function readJsonChecked(filePath, fallback = {}) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return { value: fallback, corrupt: false }; // missing file - not an error
  }
  try {
    return { value: JSON.parse(raw), corrupt: false };
  } catch {
    return { value: fallback, corrupt: true };
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const payload = JSON.stringify(value, null, 2) + '\n';
  try {
    await writeFile(tmp, payload, 'utf-8');
    try {
      await rename(tmp, filePath);
    } catch (err) {
      // Windows cannot rename over an existing file. Replace dest then
      // retry - a crash in that window leaves dest gone but tmp intact,
      // which is recoverable, unlike a half-written dest.
      if (process.platform === 'win32') {
        await unlink(filePath);
        await rename(tmp, filePath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    try { await unlink(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

// One in-flight read-modify-write chain per resolved path, so two writers
// landing in the same tick queue up instead of both reading the pre-write
// file and one clobbering the other's key. Chains are removed once drained,
// so this stays a handful of entries rather than growing unbounded across a
// long-running process.
const writeQueues = new Map();

// `mutator(value)` is called with the freshly-read value and may mutate it
// in place and/or return a value; whatever it returns is this function's
// return value. The read, mutate, and write all happen while holding this
// path's queue slot.
//
// `fallback` is a FACTORY, not a value: the returned object is handed to the
// mutator and then written, so a shared value would leak one call's
// mutations into the next call for a different path.
export async function updateJson(filePath, mutator, { fallback = () => ({}) } = {}) {
  const key = path.resolve(filePath);
  const prev = writeQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const { value, corrupt } = await readJsonChecked(filePath, fallback());
    if (corrupt) {
      // Refuse to proceed rather than silently writing the fallback back
      // over a file that's corrupt-but-possibly-recoverable-by-hand - that
      // would permanently destroy whatever was in it.
      throw new Error(`${filePath} contains invalid JSON - refusing to overwrite it. Fix or remove the file by hand, then retry.`);
    }
    const result = await mutator(value);
    await writeJsonAtomic(filePath, value);
    return result;
  });
  writeQueues.set(key, run);
  // `run.finally(...)` returns a new derived promise that also rejects
  // whenever `run` rejects, and nothing awaits that derived promise - Node's
  // default unhandled-rejection handling would kill the whole process on any
  // write failure (disk full, permissions, the corrupt-file guard above).
  // `run` itself still carries the rejection forward to whoever awaits
  // updateJson's return value.
  run.finally(() => {
    if (writeQueues.get(key) === run) writeQueues.delete(key);
  }).catch(() => {});
  return run;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/json-store.test.mjs`
Expected: PASS, 9/9.

- [ ] **Step 5: Make `settings-file.js` delegate**

Replace the whole body of `src/settings-file.js` below its module comment. The comment at lines 1–9 is kept almost as-is — the one edit is dropping `(see the read-modify-write note below)` from line 7, since the note it pointed at has moved to `json-store.js`:

```js
// Shared read/write for a project's `.claude/settings.local.json` - the
// personal, gitignored-by-convention override file (per the SDK's own
// settings-precedence note: user < project < local < flag < policy).
// plugin-settings.js and session-defaults.js both store their own top-level
// key in this same file rather than each opening/parsing it independently,
// so a concurrent write from one doesn't clobber a concurrent write from the
// other and every other key already in the file (hooks, permissions,
// whatever the user has in there) always round-trips untouched.
//
// The atomic-write, corrupt-file-refusal and per-path serialized
// read-modify-write machinery this relies on now lives in json-store.js,
// shared with cockpit's own files under ~/.prompt-cockpit. This module keeps
// the cwd -> settings-path knowledge and nothing else; its public API is
// unchanged.
import path from 'node:path';
import { readJson, updateJson } from './json-store.js';

export function settingsPath(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

export async function readSettingsFile(cwd) {
  return readJson(settingsPath(cwd));
}

// Serialization is keyed on the resolved settings-file path rather than the
// resolved cwd, which is the same grouping (one settings file per cwd) - so
// a plugin toggle and a thinking-budget change for one project still queue
// up behind each other exactly as before.
export async function updateSettingsFile(cwd, mutator) {
  return updateJson(settingsPath(cwd), mutator);
}
```

- [ ] **Step 6: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS. Every pre-existing test still passes, `tests/settings-file.test.mjs` unedited (5 tests), plus the 9 new `json-store` tests. Confirm the corrupt-file test still matches on `/invalid JSON/` — the error message now interpolates the file path instead of `settingsPath(cwd)`, which is the same string.

- [ ] **Step 7: Commit**

```bash
git add src/json-store.js src/settings-file.js tests/json-store.test.mjs
git commit -m "refactor: extract src/json-store.js from settings-file.js"
```

---

### Task 2: `child-tracker.js` — PID registry and `runtime.json` lifecycle

The in-memory registry and its persistence, with no killing and no reaping yet. Split from Task 3 so a reviewer can accept the bookkeeping (including Codex's shared-process ref-counting, which is where the spec says a per-session design breaks) independently of the kill/verify logic.

**Files:**
- Create: `src/child-tracker.js`
- Test: `tests/child-tracker.test.mjs` (create)

**Interfaces:**
- Consumes: `readJson`, `updateJson`, `writeJsonAtomic` from `src/json-store.js` (Task 1).
- Produces:
  - `defaultRuntimePath(home?: string) => string` — `<home>/.prompt-cockpit/runtime.json`.
  - `createChildTracker(opts) => tracker`, where `opts` is
    `{ runtimePath?, platform?, spawnImpl?, spawnSyncImpl?, killImpl?, logImpl? }` — `spawnImpl` backs the async start-time probe, `spawnSyncImpl` only `taskkill`.
  - `tracker.retain({ pid, provider, command, pilotId? }) => Promise<entry>` — first call for a PID records the entry with `osStartedAt: null` and starts an **async** probe that fills it in; later calls increment an in-memory ref count and add `pilotId` if given. Resolves as soon as the entry exists, **not** when the probe completes.
  - `tracker.settled() => Promise<void>` — awaits every outstanding start-time probe and the persist that follows it. Tests and `shutdown()` use this; nothing on the session-start path does.
  - `tracker.release({ pid, pilotId? }) => Promise<boolean>` — `true` when the ref count reached 0 and the entry was removed.
  - `tracker.attachPilot(pid, pilotId) => Promise<void>` / `tracker.detachPilot(pid, pilotId) => Promise<void>` — used by the supervisor in the auto-pilot plan, which learns a PID only after the session handle exists.
  - `tracker.list() => entry[]` — entries this process owns.
  - `tracker.runtimeEntries() => entry[]` — owned **plus** carried-forward unreaped orphans; what gets persisted.
  - `entry` shape: `{ pid, provider, osStartedAt, command, pilotIds: string[] }` (spec's `runtime.json` shape). Ref counts are in-memory only and deliberately not persisted — after a restart every entry is an orphan candidate regardless.

- [ ] **Step 1: Write the failing test**

Create `tests/child-tracker.test.mjs`:

```js
// Process ownership for the two providers cockpit spawns itself. Claude is
// deliberately absent: the SDK registers its own process.on('exit') cleanup,
// so its transport is not cockpit's to reap (see the design spec's Decision 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChildTracker, defaultRuntimePath } from '../src/child-tracker.js';
import { readJson } from '../src/json-store.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-child-tracker-'));
}

// Every probe is injected so no test spawns anything. `startTimes` maps a pid
// to the OS-reported start time `ps`/Get-Process would print for it.
//
// The start-time probe is ASYNC (it must not block session start), so its
// fake is a minimal ChildProcess: stdout emits once, then 'exit'. Tests that
// depend on a recorded start time must `await tracker.settled()` first.
function fakeDeps({ startTimes = new Map(), alive = new Set() } = {}) {
  const killed = [];
  return {
    killed,
    platform: 'linux',
    spawnImpl: (cmd, args) => {
      if (cmd !== 'ps') throw new Error(`unexpected spawn: ${cmd}`);
      const pid = Number(args[args.length - 1]);
      const at = startTimes.get(pid);
      const listeners = {};
      const proc = {
        pid: 1,
        stdout: { on: (event, fn) => { if (event === 'data' && at != null) fn(Buffer.from(new Date(at).toUTCString())); } },
        on: (event, fn) => { listeners[event] = fn; },
        kill: () => {},
      };
      // Exit on a later turn of the microtask queue, like a real child.
      queueMicrotask(() => listeners.exit?.(0));
      return proc;
    },
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'taskkill') {
        killed.push(Number(args[1]));
        return { status: 0, stdout: '' };
      }
      throw new Error(`unexpected spawnSync: ${cmd}`);
    },
    killImpl: (pid, signal) => {
      if (signal === 0) {
        if (!alive.has(pid)) {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      }
      killed.push(pid);
      alive.delete(pid);
      return true;
    },
    logImpl: () => {},
  };
}

test('defaultRuntimePath sits beside the operator token under ~/.prompt-cockpit', () => {
  assert.equal(
    defaultRuntimePath('/home/x'),
    path.join('/home/x', '.prompt-cockpit', 'runtime.json'),
  );
});

test('retain records the OS-reported start time and persists the entry', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const started = Date.parse('2026-09-01T10:00:00Z');
    const deps = fakeDeps({ startTimes: new Map([[4242, started]]), alive: new Set([4242]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    await tracker.retain({ pid: 4242, provider: 'grok', command: '/usr/bin/grok' });
    // retain() returns as soon as the entry exists; the start time arrives
    // asynchronously so session start is never blocked on PowerShell.
    assert.equal(tracker.list()[0].osStartedAt, null, 'recorded immediately, probe still in flight');
    await tracker.settled();

    assert.deepEqual(tracker.list(), [{
      pid: 4242,
      provider: 'grok',
      osStartedAt: started,
      command: '/usr/bin/grok',
      pilotIds: [],
    }]);
    assert.deepEqual(await readJson(runtimePath, []), tracker.list());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release removes the entry only once every holder has let go (Codex shared app-server)', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const deps = fakeDeps({ startTimes: new Map([[99, 1_000]]), alive: new Set([99]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    // One app-server process, three Codex sessions subscribed to it.
    await tracker.retain({ pid: 99, provider: 'codex', command: 'codex' });
    await tracker.retain({ pid: 99, provider: 'codex', command: 'codex' });
    await tracker.retain({ pid: 99, provider: 'codex', command: 'codex' });
    assert.equal(tracker.list().length, 1, 'one PID, not three rows');

    assert.equal(await tracker.release({ pid: 99 }), false);
    assert.equal(await tracker.release({ pid: 99 }), false);
    assert.equal(tracker.list().length, 1, 'still held by the last session');

    assert.equal(await tracker.release({ pid: 99 }), true);
    assert.deepEqual(tracker.list(), []);
    assert.deepEqual(await readJson(runtimePath, []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pilotIds accumulate and drop independently of the ref count', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const deps = fakeDeps({ startTimes: new Map([[7, 1_000]]), alive: new Set([7]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    await tracker.retain({ pid: 7, provider: 'codex', command: 'codex', pilotId: 'pilot-a' });
    await tracker.retain({ pid: 7, provider: 'codex', command: 'codex' }); // a hand-driven session, no pilot
    await tracker.attachPilot(7, 'pilot-b');
    assert.deepEqual(tracker.list()[0].pilotIds, ['pilot-a', 'pilot-b']);

    await tracker.detachPilot(7, 'pilot-a');
    assert.deepEqual(tracker.list()[0].pilotIds, ['pilot-b']);

    // A hand-driven session releasing must not remove a row two other
    // holders still need.
    assert.equal(await tracker.release({ pid: 7 }), false);
    assert.equal(tracker.list().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retain is a no-op for a pid it cannot read a start time for, and says so', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const logged = [];
    const deps = fakeDeps({ startTimes: new Map(), alive: new Set([5]) });
    const tracker = createChildTracker({ runtimePath, ...deps, logImpl: (msg) => logged.push(msg) });

    const entry = await tracker.retain({ pid: 5, provider: 'grok', command: 'grok' });
    await tracker.settled();

    // Recorded anyway - shutdown still needs to kill it in THIS process,
    // where the pid is known-good. osStartedAt staying null is what makes the
    // reaper refuse to touch it after a restart.
    assert.equal(entry.osStartedAt, null);
    assert.equal(tracker.list().length, 1);
    assert.match(logged.join('\n'), /start time/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retain ignores a pid that is not a positive integer', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const tracker = createChildTracker({ runtimePath, ...fakeDeps() });
    assert.equal(await tracker.retain({ pid: undefined, provider: 'grok', command: 'grok' }), null);
    assert.equal(await tracker.retain({ pid: 0, provider: 'grok', command: 'grok' }), null);
    assert.deepEqual(tracker.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/child-tracker.test.mjs`
Expected: FAIL — `Cannot find module '.../src/child-tracker.js'`.

- [ ] **Step 3: Write `src/child-tracker.js` (registry half only)**

Create `src/child-tracker.js`:

```js
// Process ownership for the provider CLIs cockpit spawns itself: which PIDs
// they are, whether they are still the process we spawned, and how to kill
// them (including grandchildren behind a Windows .cmd wrapper).
//
// Covers GROK and CODEX only. Claude's transport is spawned by the agent
// SDK, which registers its own process.on('exit') teardown for it
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs), so it is not
// cockpit's to reap. The real orphan exposure is the other two:
// killGrokProcess runs only on explicit teardown paths - a session close
// (grok-session.js:350), the short-lived rewind helper's finally
// (grok-session.js:38), and a CLI timeout (grok-cli.js:57) - never on process
// exit. codex-app-server.js's shared process has no exit-time teardown at all.
//
// runtime.json is keyed by PROCESS, not by session. One Codex app-server
// hosts every Codex session (codex-app-server.js's ref-counted manager), so
// a per-session row would either duplicate one PID N times or - worse - drop
// the entry and kill every other Codex session when any one of them closed.
// `pilotIds` is the set of auto-pilots currently depending on that process;
// ref counts are in-memory only, since after a restart every persisted entry
// is an orphan candidate regardless of how many holders it once had.
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './json-store.js';

export function defaultRuntimePath(home = homedir()) {
  return path.join(home, '.prompt-cockpit', 'runtime.json');
}

// The OS's own start time for a pid, as epoch-ms, or null if it can't be
// read. Two properties matter and they pull in opposite directions:
//
//  - It must be the OS-REPORTED value, not Date.now() at spawn. The reaper
//    compares it against a live `ps -o lstart` / Get-Process reading, and
//    `lstart` has 1-second granularity - a JS millisecond timestamp would
//    never match, so the reaper would refuse every entry and reap nothing.
//  - It must be ASYNC. On Windows this is a cold PowerShell start: 200-800ms
//    typical, 10s worst case. retain() is called from Grok's and Codex's
//    session-start paths, so a spawnSync here would stall the whole cockpit
//    HTTP + WebSocket server on every session start.
//
// Never rejects: an unreadable start time resolves to null, which the reaper
// reads as 'unverifiable' and refuses to act on.
export function probeProcessStartTime(pid, {
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = 10_000,
} = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return Promise.resolve(null);
  // `n` is a validated positive integer by this point, so interpolating it
  // into the PowerShell command below cannot inject anything.
  const [command, args] = platform === 'win32'
    ? ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${n} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
    ]]
    : ['ps', ['-o', 'lstart=', '-p', String(n)]];

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnImpl(command, args, {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    proc.stdout?.on('data', (chunk) => { out += String(chunk); });
    proc.on('error', () => finish(null));
    proc.on('exit', () => {
      const ms = Date.parse(out.trim());
      finish(Number.isFinite(ms) ? ms : null);
    });
  });
}

// Signal 0 is an existence probe - it delivers nothing. EPERM means the
// process exists but belongs to another user, which still counts as "exists"
// (and is itself a reason not to kill it).
export function processExists(pid, { killImpl = (p, s) => process.kill(p, s) } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    killImpl(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

export function createChildTracker({
  runtimePath = defaultRuntimePath(),
  platform = process.platform,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  killImpl = (p, s) => process.kill(p, s),
  logImpl = console.error,
} = {}) {
  const probeDeps = { platform, spawnImpl, spawnSyncImpl, killImpl };
  // Outstanding async start-time probes, so settled() and shutdown() have
  // something to await. Never awaited by retain() itself.
  const probes = new Set();
  // pid -> { entry, refs }
  const owned = new Map();
  // Orphans from a previous run that the reaper refused to kill (Task 3).
  // Persisted alongside `owned` so another restart still sees them, but never
  // in list() - shutdown must not kill a process it could not verify.
  let carried = [];

  function ownedEntries() {
    return [...owned.values()].map(({ entry }) => entry);
  }

  function runtimeEntries() {
    return [...ownedEntries(), ...carried];
  }

  // Whole-file rewrite rather than updateJson's read-modify-write: this
  // process is the only writer of its own runtime.json, and the in-memory
  // maps above - not the file - are the source of truth.
  async function persist() {
    try {
      await writeJsonAtomic(runtimePath, runtimeEntries());
    } catch (err) {
      // Losing runtime.json costs us orphan reaping on the NEXT start, which
      // is not worth failing a session launch over.
      logImpl(`child-tracker: could not write ${runtimePath}: ${String(err?.message || err)}`);
    }
  }

  async function retain({ pid, provider, command, pilotId = null }) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return null;
    let slot = owned.get(n);
    if (!slot) {
      // Recorded with osStartedAt: null RIGHT NOW, filled in when the probe
      // lands. This function is on the session-start path and must not wait
      // on a subprocess - see probeProcessStartTime's comment.
      //
      // The exposure this buys is small and bounded: for the ~500ms the probe
      // is in flight the entry has no start time, so a cockpit crash inside
      // that window leaves one entry the next start's reaper will decline to
      // kill (logged, and it blocks that pilot until killed by hand). That
      // beats stalling every session start.
      slot = { entry: { pid: n, provider, osStartedAt: null, command, pilotIds: [] }, refs: 0 };
      owned.set(n, slot);
      const probe = probeProcessStartTime(n, probeDeps).then(async (osStartedAt) => {
        if (owned.get(n) !== slot) return; // released before the probe landed
        slot.entry.osStartedAt = osStartedAt;
        if (osStartedAt == null) {
          logImpl(`child-tracker: could not read the OS start time for pid ${n} (${provider}) - it is still tracked for this process's own shutdown, but an orphan reaper on the next start will refuse to touch it.`);
        }
        await persist();
      });
      probes.add(probe);
      probe.finally(() => probes.delete(probe)).catch(() => {});
    }
    slot.refs += 1;
    if (pilotId && !slot.entry.pilotIds.includes(pilotId)) slot.entry.pilotIds.push(pilotId);
    await persist();
    return slot.entry;
  }

  async function release({ pid, pilotId = null }) {
    const n = Number(pid);
    const slot = owned.get(n);
    if (!slot) return false;
    if (pilotId) slot.entry.pilotIds = slot.entry.pilotIds.filter((id) => id !== pilotId);
    slot.refs -= 1;
    const removed = slot.refs <= 0;
    if (removed) owned.delete(n);
    await persist();
    return removed;
  }

  // Drains every in-flight start-time probe (and the persist each one
  // triggers). Awaited by tests and by shutdown(); never by retain().
  async function settled() {
    while (probes.size) await Promise.all([...probes]);
  }

  async function attachPilot(pid, pilotId) {
    const slot = owned.get(Number(pid));
    if (!slot || !pilotId) return;
    if (!slot.entry.pilotIds.includes(pilotId)) slot.entry.pilotIds.push(pilotId);
    await persist();
  }

  async function detachPilot(pid, pilotId) {
    const slot = owned.get(Number(pid));
    if (!slot || !pilotId) return;
    slot.entry.pilotIds = slot.entry.pilotIds.filter((id) => id !== pilotId);
    await persist();
  }

  return {
    runtimePath,
    retain,
    release,
    attachPilot,
    detachPilot,
    list: ownedEntries,
    runtimeEntries,
    settled,
    // Task 3 adds reapOrphans / killTracked / orphanPilotIds here.
    _internals: { probeDeps, owned, setCarried: (list) => { carried = list; }, getCarried: () => carried, persist, readRuntime: () => readJson(runtimePath, []) },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/child-tracker.test.mjs`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/child-tracker.js tests/child-tracker.test.mjs
git commit -m "feat: child-tracker PID registry persisted to runtime.json"
```

---

### Task 3: `child-tracker.js` — tree-kill, start-time verification, orphan reaper

**Files:**
- Modify: `src/child-tracker.js` (add exports and tracker methods; replace the `_internals` placeholder)
- Test: `tests/child-tracker.test.mjs` (append tests)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces:
  - `killProcessTree(pid, { platform?, spawnSyncImpl?, killImpl?, signal? }) => boolean` — `signal` defaults to `'SIGKILL'`; on Windows always `taskkill /pid <n> /t` plus `/f` when the signal is `SIGKILL`.
  - `verifyEntry(entry, deps) => Promise<'gone' | 'match' | 'mismatch' | 'unverifiable'>` — async, because the start-time probe is. Only ever called from `reapOrphans()`, which runs once at boot before the server listens, so its cost is off every hot path.
  - `START_TIME_TOLERANCE_MS = 3000`
  - `tracker.reapOrphans() => Promise<{ reaped: entry[], skipped: entry[], vanished: entry[] }>`
  - `tracker.orphanPilotIds() => Set<string>` — pilots blocked because an orphan of theirs could not be reaped.
  - `tracker.killTracked({ signal? }) => Promise<entry[]>` — kills every entry **this process owns** (never a carried one) and returns those it killed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/child-tracker.test.mjs`:

```js
import {
  killProcessTree,
  verifyEntry,
  START_TIME_TOLERANCE_MS,
} from '../src/child-tracker.js';
import { writeJsonAtomic } from '../src/json-store.js';

test('killProcessTree uses taskkill /T /F on Windows and a signal elsewhere', () => {
  const calls = [];
  assert.equal(killProcessTree(1234, {
    platform: 'win32',
    spawnSyncImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; },
  }), true);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '1234', '/t', '/f']);
  assert.equal(calls[0].opts.windowsHide, true);

  // A graceful pass drops /f so the tree gets a chance to exit on its own.
  killProcessTree(1234, {
    platform: 'win32',
    signal: 'SIGTERM',
    spawnSyncImpl: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
  });
  assert.deepEqual(calls[1].args, ['/pid', '1234', '/t']);

  const signalled = [];
  assert.equal(killProcessTree(9, {
    platform: 'linux',
    killImpl: (pid, signal) => { signalled.push([pid, signal]); },
    spawnSyncImpl: () => { throw new Error('should not spawn'); },
  }), true);
  assert.deepEqual(signalled, [[9, 'SIGKILL']]);
});

test('killProcessTree refuses a non-positive-integer pid', () => {
  const spawnSyncImpl = () => { throw new Error('should not spawn'); };
  assert.equal(killProcessTree(0, { platform: 'win32', spawnSyncImpl }), false);
  assert.equal(killProcessTree(-1, { platform: 'win32', spawnSyncImpl }), false);
  assert.equal(killProcessTree(undefined, { platform: 'win32', spawnSyncImpl }), false);
});

test('verifyEntry matches within the tolerance and mismatches outside it', async () => {
  const started = Date.parse('2026-09-01T10:00:00Z');
  const alive = new Set([50]);
  const deps = (osReading) => fakeDeps({ startTimes: new Map([[50, osReading]]), alive });

  // `ps -o lstart` truncates to whole seconds, so an exact match is the
  // exception, not the rule - the tolerance is what makes this work at all.
  assert.equal(await verifyEntry({ pid: 50, osStartedAt: started + 400 }, deps(started)), 'match');
  assert.equal(
    await verifyEntry({ pid: 50, osStartedAt: started + START_TIME_TOLERANCE_MS }, deps(started)),
    'match',
  );
  assert.equal(
    await verifyEntry({ pid: 50, osStartedAt: started + START_TIME_TOLERANCE_MS + 1 }, deps(started)),
    'mismatch',
  );
});

test('verifyEntry reports gone for a dead pid and unverifiable when the start time is unreadable', async () => {
  assert.equal(
    await verifyEntry({ pid: 51, osStartedAt: 1_000 }, fakeDeps({ alive: new Set() })),
    'gone',
  );
  assert.equal(
    await verifyEntry({ pid: 52, osStartedAt: 1_000 }, fakeDeps({ startTimes: new Map(), alive: new Set([52]) })),
    'unverifiable',
  );
  // Recorded with no start time at all - either retain's probe came back
  // empty, or the cockpit died before it landed. Never confirmable, so never
  // killable.
  assert.equal(
    await verifyEntry({ pid: 53, osStartedAt: null }, fakeDeps({ startTimes: new Map([[53, 1_000]]), alive: new Set([53]) })),
    'unverifiable',
  );
});

test('reapOrphans kills a confirmed orphan and clears it from runtime.json', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    const started = Date.parse('2026-09-01T10:00:00Z');
    await writeJsonAtomic(runtimePath, [
      { pid: 300, provider: 'grok', osStartedAt: started, command: 'grok', pilotIds: ['pilot-a'] },
    ]);
    const deps = fakeDeps({ startTimes: new Map([[300, started]]), alive: new Set([300]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    const result = await tracker.reapOrphans();

    assert.deepEqual(result.reaped.map((e) => e.pid), [300]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(deps.killed, [300]);
    assert.deepEqual(await readJson(runtimePath, []), []);
    assert.deepEqual([...tracker.orphanPilotIds()], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapOrphans REFUSES to kill an unverifiable pid and blocks that pilot from firing', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    await writeJsonAtomic(runtimePath, [
      { pid: 301, provider: 'codex', osStartedAt: 1_000, command: 'codex', pilotIds: ['pilot-b', 'pilot-c'] },
    ]);
    // Alive, but its start time can't be read - could be anything now.
    const deps = fakeDeps({ startTimes: new Map(), alive: new Set([301]) });
    const logged = [];
    const tracker = createChildTracker({ runtimePath, ...deps, logImpl: (m) => logged.push(m) });

    const result = await tracker.reapOrphans();

    assert.deepEqual(deps.killed, [], 'killing the operator\'s unrelated process is worse than logging an orphan');
    assert.deepEqual(result.skipped.map((e) => e.pid), [301]);
    assert.match(logged.join('\n'), /refus/i);
    // Carried forward, so another restart still sees it.
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid), [301]);
    // And its pilots stay blocked - otherwise the pilot is overdue and
    // lock-free on the next heartbeat, putting a second unattended agent in
    // the same working tree as the one we just declined to kill.
    assert.deepEqual([...tracker.orphanPilotIds()].sort(), ['pilot-b', 'pilot-c']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapOrphans drops a reused pid without killing it and does not block its pilots', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    await writeJsonAtomic(runtimePath, [
      { pid: 302, provider: 'grok', osStartedAt: 1_000, command: 'grok', pilotIds: ['pilot-d'] },
    ]);
    // Same pid, started an hour later - this is somebody else's process now,
    // and the one we recorded is provably gone.
    const deps = fakeDeps({ startTimes: new Map([[302, 3_601_000]]), alive: new Set([302]) });
    const tracker = createChildTracker({ runtimePath, ...deps });

    const result = await tracker.reapOrphans();

    assert.deepEqual(deps.killed, []);
    assert.deepEqual(result.vanished.map((e) => e.pid), [302]);
    assert.deepEqual(await readJson(runtimePath, []), []);
    assert.deepEqual([...tracker.orphanPilotIds()], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapOrphans treats a corrupt or non-array runtime.json as empty rather than throwing', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    await writeJsonAtomic(runtimePath, { not: 'an array' });
    const tracker = createChildTracker({ runtimePath, ...fakeDeps() });
    assert.deepEqual(await tracker.reapOrphans(), { reaped: [], skipped: [], vanished: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('killTracked kills what this process owns and never a carried-forward orphan', async () => {
  const dir = await makeTmpDir();
  try {
    const runtimePath = path.join(dir, 'runtime.json');
    // One unverifiable orphan carried forward from a previous run...
    await writeJsonAtomic(runtimePath, [
      { pid: 400, provider: 'grok', osStartedAt: 1_000, command: 'grok', pilotIds: [] },
    ]);
    const deps = fakeDeps({
      startTimes: new Map([[401, 2_000]]),
      alive: new Set([400, 401]),
    });
    const tracker = createChildTracker({ runtimePath, ...deps });
    await tracker.reapOrphans();
    assert.deepEqual(deps.killed, [], 'the carried orphan was refused, not killed');

    // ...and one process we spawned ourselves.
    await tracker.retain({ pid: 401, provider: 'grok', command: 'grok' });
    await tracker.settled();

    const killed = await tracker.killTracked();
    assert.deepEqual(killed.map((e) => e.pid), [401]);
    assert.deepEqual(deps.killed, [401]);
    // The carried orphan is still recorded, so a later start can retry it.
    assert.deepEqual((await readJson(runtimePath, [])).map((e) => e.pid), [400]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/child-tracker.test.mjs`
Expected: FAIL — `killProcessTree`, `verifyEntry`, `START_TIME_TOLERANCE_MS` are not exported; `tracker.reapOrphans` / `orphanPilotIds` / `killTracked` are not functions. (`probeProcessStartTime` and `tracker.settled` already exist from Task 2.)

- [ ] **Step 3: Add the kill and reap implementation**

In `src/child-tracker.js`, add these module-level exports after `processExists`:

```js
// `ps -o lstart` prints whole seconds and Windows' Get-Process rounds
// differently again, so an exact comparison against the value recorded at
// spawn never matches. A few seconds of slack is enough to confirm identity
// without being wide enough to accept a pid recycled minutes later.
export const START_TIME_TOLERANCE_MS = 3000;

// A Windows .cmd/.bat wrapper survives killing the pid we spawned - the real
// agent keeps running - so taskkill /T walks the tree. Deliberately NOT a
// refactor of grok-acp.js's killGrokProcess: that one takes a live
// ChildProcess handle and calls proc.kill() on POSIX (the in-session
// teardown path, covered by tests/grok-acp.test.mjs:197). This one only ever
// has a bare pid read back out of runtime.json.
export function killProcessTree(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  killImpl = (p, s) => process.kill(p, s),
  signal = 'SIGKILL',
} = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (platform === 'win32') {
    const args = ['/pid', String(n), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    const res = spawnSyncImpl('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    return Boolean(res) && res.status === 0;
  }
  try {
    killImpl(n, signal);
    return true;
  } catch {
    return false;
  }
}

// Is the pid in `entry` still the process cockpit spawned?
//   'gone'         - nothing is running under that pid; nothing to do.
//   'match'        - same process, safe to kill.
//   'mismatch'     - pid was recycled; the recorded process is provably gone,
//                    so drop the entry WITHOUT killing the new occupant.
//   'unverifiable' - alive, but identity can't be confirmed. Refuse to kill.
// Async only because the start-time probe is. `processExists` stays sync -
// it is a `process.kill(pid, 0)` existence probe, no subprocess - so the
// cheap rejection still short-circuits before anything is spawned.
export async function verifyEntry(entry, deps = {}) {
  if (!entry) return 'gone';
  const n = Number(entry.pid);
  if (!Number.isInteger(n) || n <= 0) return 'gone';
  if (!processExists(n, deps)) return 'gone';
  if (entry.osStartedAt == null) return 'unverifiable';
  const started = await probeProcessStartTime(n, deps);
  if (started == null) return 'unverifiable';
  return Math.abs(started - entry.osStartedAt) <= START_TIME_TOLERANCE_MS ? 'match' : 'mismatch';
}
```

Then inside `createChildTracker`, replace the `_internals` placeholder with these three methods and return them:

```js
  // Called once at startup, before any session exists. Anything still in
  // runtime.json was spawned by a cockpit process that died without running
  // shutdown() - a hard kill, a crash, or a power loss.
  async function reapOrphans() {
    const previous = await readJson(runtimePath, []);
    const entries = Array.isArray(previous) ? previous : [];
    const reaped = [];
    const skipped = [];
    const vanished = [];
    for (const entry of entries) {
      const verdict = await verifyEntry(entry, probeDeps);
      if (verdict === 'gone' || verdict === 'mismatch') {
        vanished.push(entry);
        continue;
      }
      if (verdict === 'unverifiable') {
        logImpl(`child-tracker: refusing to reap pid ${entry.pid} (${entry.provider}, ${entry.command}) - could not confirm it is still the process cockpit spawned. Kill it by hand if it is an orphan.${entry.pilotIds?.length ? ` Auto-pilots blocked until then: ${entry.pilotIds.join(', ')}.` : ''}`);
        skipped.push(entry);
        continue;
      }
      if (killProcessTree(entry.pid, probeDeps)) {
        reaped.push(entry);
      } else {
        logImpl(`child-tracker: kill failed for orphan pid ${entry.pid} (${entry.provider})`);
        skipped.push(entry);
      }
    }
    // Whatever we would not or could not kill stays recorded, so another
    // restart sees it again and its pilots stay blocked in the meantime.
    carried = skipped;
    await persist();
    return { reaped, skipped, vanished };
  }

  // Auto-pilots that must not fire because an orphan of theirs is still
  // running. Without this the two safety behaviors combine badly: after a
  // crash the in-memory concurrency lock is empty and the pilot is overdue,
  // so it fires immediately, while the reaper correctly declines to kill the
  // previous run - two unattended agents in one working tree.
  function orphanPilotIds() {
    return new Set(carried.flatMap((entry) => entry.pilotIds || []));
  }

  // Shutdown's last resort. Only touches entries THIS process owns: a
  // carried-forward orphan is by definition one we could not verify, and
  // that verdict does not change just because we are exiting.
  async function killTracked({ signal = 'SIGKILL' } = {}) {
    const killed = [];
    for (const entry of ownedEntries()) {
      if (!processExists(entry.pid, probeDeps)) continue;
      if (killProcessTree(entry.pid, { ...probeDeps, signal })) killed.push(entry);
    }
    for (const entry of killed) owned.delete(entry.pid);
    await persist();
    return killed;
  }

  return {
    runtimePath,
    retain,
    release,
    attachPilot,
    detachPilot,
    list: ownedEntries,
    runtimeEntries,
    reapOrphans,
    orphanPilotIds,
    killTracked,
    // Awaitable flush. Every mutator above already persists, but they are all
    // called fire-and-forget from the session modules; shutdown() needs one
    // write it can actually await before process.exit(0).
    persistNow: persist,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/child-tracker.test.mjs`
Expected: PASS, 15/15.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, nothing regressed.

- [ ] **Step 6: Commit**

```bash
git add src/child-tracker.js tests/child-tracker.test.mjs
git commit -m "feat: child-tracker tree-kill and start-time-verified orphan reaper"
```

---

### Task 4: Wire the tracker into Grok and Codex spawns

**Files:**
- Modify: `src/codex-app-server.js` (add `pid()` to the manager returned by `createCodexAppServerManager`, around `src/codex-app-server.js:343`)
- Modify: `src/codex-session.js` (retain/release around the manager; expose `trackedPid` on the returned handle at `src/codex-session.js:354`)
- Modify: `src/grok-session.js` (retain after `connectImpl` at `src/grok-session.js:118`; release in `close()` around `src/grok-session.js:350`; expose `trackedPid` on the returned handle at `src/grok-session.js:465`)
- Modify: `src/child-tracker.js` (add a lazily-created process-wide default tracker)
- Test: `tests/child-tracker.test.mjs` (append one test for the default-tracker accessor)

**Interfaces:**
- Consumes: `createChildTracker` (Tasks 2–3).
- Produces:
  - `getChildTracker(opts?) => tracker` from `src/child-tracker.js` — the process-wide singleton, created on first call. `_resetChildTracker()` for tests, mirroring `_resetCodexAppServerManager` (`src/codex-app-server.js:411`).
  - `manager.pid() => number | null` on the Codex app-server manager.
  - `handle.trackedPid: number | null` on the Grok and Codex session handles. `null` for Claude (the field simply does not exist there — the supervisor in the auto-pilot plan reads it with `?.`).

- [ ] **Step 1: Write the failing test**

Append to `tests/child-tracker.test.mjs`:

```js
import { getChildTracker, _resetChildTracker } from '../src/child-tracker.js';

test('getChildTracker returns one process-wide tracker until reset', async () => {
  const dir = await makeTmpDir();
  try {
    _resetChildTracker();
    const a = getChildTracker({ runtimePath: path.join(dir, 'runtime.json'), ...fakeDeps() });
    const b = getChildTracker();
    assert.equal(a, b, 'options on a later call must not build a second tracker');
    _resetChildTracker();
    const c = getChildTracker({ runtimePath: path.join(dir, 'runtime.json'), ...fakeDeps() });
    assert.notEqual(a, c);
  } finally {
    _resetChildTracker();
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/child-tracker.test.mjs`
Expected: FAIL — `getChildTracker` is not exported.

- [ ] **Step 3: Add the default tracker accessor**

Append to `src/child-tracker.js`:

```js
// One tracker per cockpit process, created on first use. Same shape as
// codex-app-server.js's getCodexAppServerManager/_resetCodexAppServerManager
// pair: a module-level singleton with a test reset, rather than threading a
// tracker instance through every session-creation call site.
let defaultTracker = null;

export function getChildTracker(options) {
  if (!defaultTracker) defaultTracker = createChildTracker(options);
  return defaultTracker;
}

export function _resetChildTracker() {
  defaultTracker = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/child-tracker.test.mjs`
Expected: PASS, 16/16.

- [ ] **Step 5: Expose the Codex app-server's pid**

In `src/codex-app-server.js`, inside the object returned by `createCodexAppServerManager` (starts at `src/codex-app-server.js:343`), add next to `isClosed`:

```js
    // The shared app-server's own pid. child-tracker.js keys runtime.json by
    // process, and this one process backs every Codex session - see that
    // module's comment on why a per-session row would be wrong.
    pid: () => connection.proc?.pid ?? null,
```

- [ ] **Step 6: Retain/release in `codex-session.js`**

Add the import at the top of `src/codex-session.js`, next to the existing `getCodexAppServerManager` import:

```js
import { getChildTracker } from './child-tracker.js';
```

Immediately after the `manager` is resolved in `startCodexSession` (the `manager = getCodexAppServerManager(),` default parameter at `src/codex-session.js:50` means it is available at the top of the function body), add:

```js
  // The shared app-server is ref-counted by child-tracker, exactly like
  // manager.retainThread/releaseThread ref-counts a thread - one Codex row
  // closing must not drop the PID entry every other Codex row still needs.
  const tracker = getChildTracker();
  const trackedPid = manager.pid?.() ?? null;
  if (trackedPid != null) tracker.retain({ pid: trackedPid, provider: 'codex', command: 'codex app-server' }).catch(() => {});
```

In the existing `close()` (the `manager.releaseThread(threadId)` block around `src/codex-session.js:297-305`), after the unsubscribe handling, add:

```js
    if (trackedPid != null) tracker.release({ pid: trackedPid }).catch(() => {});
```

And in the returned handle object (`src/codex-session.js:354`) add:

```js
    // Read by the auto-pilot supervisor to attach a pilotId to this
    // session's underlying process; absent on Claude handles, whose
    // transport the SDK owns.
    trackedPid,
```

- [ ] **Step 7: Retain/release in `grok-session.js`**

Add the import at the top of `src/grok-session.js`:

```js
import { getChildTracker } from './child-tracker.js';
```

In `startGrokSession`, declare the tracker alongside the existing `let connection = null;` (`src/grok-session.js:90`):

```js
  const tracker = getChildTracker();
  let trackedPid = null;
```

Immediately after `connection = connectImpl({ cwd, model, effort: currentEffort });` (`src/grok-session.js:118`):

```js
    // grok-acp.js's killGrokProcess only runs on an explicit close, so a
    // Ctrl-C or crash used to leave the paid agent running. Recording the pid
    // here is what lets shutdown() and the next start's orphan reaper find it.
    trackedPid = connection.proc?.pid ?? null;
    // Not awaited, and retain() itself never blocks on the start-time probe -
    // see child-tracker.js. Session start must not wait on PowerShell.
    if (trackedPid != null) tracker.retain({ pid: trackedPid, provider: 'grok', command: connection.command }).catch(() => {});
```

In `close()`, right after the existing `killGrokProcess(connection?.proc)` try/catch block (`src/grok-session.js:349-353`) and before `onStateChange('closed')`:

```js
    if (trackedPid != null) {
      tracker.release({ pid: trackedPid }).catch(() => {});
      trackedPid = null;
    }
```

And in the returned handle object (`src/grok-session.js:465`):

```js
    // See codex-session.js's own trackedPid comment.
    get trackedPid() { return trackedPid; },
```

(A getter, not a plain field — but **not** for the reason it looks like: `connection = connectImpl(...)` at `src/grok-session.js:118` is the first statement of an immediately-invoked `async` IIFE, so it runs synchronously before `startGrokSession`'s own `return` at `src/grok-session.js:465`, and a plain field would in fact be populated. The getter is here so a later reconnect that re-assigns `connection` is reflected, and so the value cannot silently freeze at `null` if that connect path ever does become lazy.)

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/grok-session.test.mjs` and `tests/codex-session.test.mjs` both inject fakes whose `proc` has no `pid`, so `trackedPid` stays `null` and no tracker call fires — if either fails, the injected fake grew a `pid` and the test needs `_resetChildTracker()` plus a temp `runtimePath`, not a change to the source.

- [ ] **Step 9: Commit**

```bash
git add src/child-tracker.js src/codex-app-server.js src/codex-session.js src/grok-session.js tests/child-tracker.test.mjs
git commit -m "feat: track Grok and Codex CLI pids for shutdown and orphan reaping"
```

---

### Task 5: `shutdown.js` and the `server.js` signal wiring

**Files:**
- Create: `src/shutdown.js`
- Modify: `src/server.js` (imports at `src/server.js:10-24`; the `isMain` block at `src/server.js:212-235`, specifically the `process.exit(0)` at `src/server.js:225`)
- Test: `tests/shutdown.test.mjs` (create)

**Interfaces:**
- Consumes: `tracker.list()`, `tracker.killTracked({ signal })`, `tracker.reapOrphans()` (Tasks 2–4); `registry.list()` and `registry.closeSession(id)` (`src/session-registry.js:353`, `src/session-registry.js:327`).
- Produces:
  - `createShutdown({ registry, tracker, graceMs?, logImpl?, sleepImpl? }) => { run, onBeforeClose, isShuttingDown }`
  - `run(reason: string) => Promise<void>` — idempotent; a second call returns the same promise.
  - `onBeforeClose(fn: () => any) => void` — registers a hook run before any session is closed. The auto-pilot supervisor registers its heartbeat stop here.
  - `isShuttingDown() => boolean`
  - `server.js` additionally exports `shutdown` so a future test can drive it.

- [ ] **Step 1: Write the failing test**

Create `tests/shutdown.test.mjs`:

```js
// One async shutdown path for every exit route. The bug this closes: the TTY
// keypress handler was the ONLY Ctrl-C path (process.stdin.setRawMode(true)
// means the OS never delivers SIGINT) and it called process.exit(0) directly
// - so every live Grok/Codex CLI kept running, and on Windows the terminal
// was left in raw mode too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../src/shutdown.js';

function fakeRegistry(ids) {
  const closed = [];
  return {
    closed,
    list: () => ids.filter((id) => !closed.includes(id)).map((id) => ({ id })),
    closeSession: (id) => { closed.push(id); return true; },
  };
}

function fakeTracker(entries = []) {
  const calls = [];
  let live = [...entries];
  return {
    calls,
    list: () => live,
    killTracked: async ({ signal } = {}) => {
      calls.push(signal);
      const killed = live;
      live = [];
      return killed;
    },
    settled: async () => { calls.push('settled'); },
    persistNow: async () => { calls.push('persist'); },
  };
}

test('shutdown runs hooks, closes every session, then kills survivors - in that order', async () => {
  const order = [];
  const registry = fakeRegistry(['a', 'b']);
  const tracker = fakeTracker([{ pid: 1 }]);
  const shutdown = createShutdown({
    registry,
    tracker,
    graceMs: 5,
    logImpl: () => {},
    sleepImpl: async () => { order.push('grace'); },
  });
  shutdown.onBeforeClose(() => { order.push('hook'); });

  const patchedClose = registry.closeSession;
  registry.closeSession = (id) => { order.push(`close:${id}`); return patchedClose(id); };

  await shutdown.run('test');

  assert.deepEqual(order, ['hook', 'close:a', 'close:b', 'grace']);
  assert.deepEqual(tracker.calls, ['SIGKILL', 'settled', 'persist']);
});

test('shutdown skips the grace period and the kill pass when nothing is tracked', async () => {
  const tracker = fakeTracker([]);
  let slept = false;
  const shutdown = createShutdown({
    registry: fakeRegistry([]),
    tracker,
    logImpl: () => {},
    sleepImpl: async () => { slept = true; },
  });
  await shutdown.run('test');
  assert.equal(slept, false);
  // No grace period and no kill pass, but runtime.json is still flushed -
  // that is what makes "[] after a clean exit" deterministic.
  assert.deepEqual(tracker.calls, ['settled', 'persist']);
});

test('shutdown is idempotent - a second call returns the same promise and does no extra work', async () => {
  const registry = fakeRegistry(['a']);
  const tracker = fakeTracker([{ pid: 1 }]);
  const shutdown = createShutdown({ registry, tracker, logImpl: () => {}, sleepImpl: async () => {} });

  assert.equal(shutdown.isShuttingDown(), false);
  const first = shutdown.run('sigint');
  assert.equal(shutdown.isShuttingDown(), true);
  const second = shutdown.run('sigterm');
  assert.equal(first, second, 'a double Ctrl-C must not start a second teardown');
  await first;
  assert.deepEqual(registry.closed, ['a']);
  assert.deepEqual(tracker.calls, ['SIGKILL', 'settled', 'persist']);
});

test('a throwing hook or a throwing closeSession does not abort the rest of the shutdown', async () => {
  const registry = fakeRegistry(['a', 'b']);
  registry.closeSession = (id) => {
    if (id === 'a') throw new Error('close blew up');
    registry.closed.push(id);
    return true;
  };
  const tracker = fakeTracker([{ pid: 1 }]);
  const logged = [];
  const shutdown = createShutdown({
    registry,
    tracker,
    logImpl: (m) => logged.push(String(m)),
    sleepImpl: async () => {},
  });
  shutdown.onBeforeClose(() => { throw new Error('hook blew up'); });
  shutdown.onBeforeClose(async () => { throw new Error('async hook blew up'); });

  await shutdown.run('test');

  assert.deepEqual(registry.closed, ['b'], 'session b still got closed');
  assert.deepEqual(tracker.calls, ['SIGKILL', 'settled', 'persist'], 'the kill pass and the flush still ran');
  assert.match(logged.join('\n'), /hook blew up/);
  assert.match(logged.join('\n'), /async hook blew up/);
  assert.match(logged.join('\n'), /close blew up/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/shutdown.test.mjs`
Expected: FAIL — `Cannot find module '.../src/shutdown.js'`.

- [ ] **Step 3: Write `src/shutdown.js`**

```js
// One async teardown for every exit route: the TTY Ctrl-C keypress, SIGINT,
// SIGTERM, SIGBREAK. Before this, server.js's keypress handler called
// process.exit(0) directly (src/server.js:225) and that was the ONLY Ctrl-C
// path on a TTY - process.stdin.setRawMode(true) (src/server.js:221) means
// the OS never delivers SIGINT at all - so every live Grok/Codex CLI cockpit
// had spawned was left running.
//
// Deliberately dependency-injected rather than importing session-registry.js
// and child-tracker.js directly: that is what lets tests drive the ordering,
// the grace period and the idempotence without a real registry or a real
// process to kill.
const DEFAULT_GRACE_MS = 3000;

export function createShutdown({
  registry,
  tracker,
  graceMs = DEFAULT_GRACE_MS,
  logImpl = console.error,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const beforeClose = [];
  let running = null;

  function onBeforeClose(fn) {
    if (typeof fn === 'function') beforeClose.push(fn);
  }

  async function perform(reason) {
    logImpl(`shutting down (${reason})…`);

    // Hooks first - the auto-pilot heartbeat has to stop before sessions
    // start disappearing, or it sees its own runs vanish and treats them as
    // terminal outcomes mid-teardown. One bad hook must not strand the CLIs.
    for (const fn of beforeClose) {
      try {
        await fn();
      } catch (err) {
        logImpl(`shutdown hook failed: ${String(err?.message || err)}`);
      }
    }

    // Every live session, pilot-owned or not. closeSession is synchronous and
    // removes the row, so snapshot the ids first.
    for (const { id } of registry.list()) {
      try {
        registry.closeSession(id);
      } catch (err) {
        logImpl(`closing session ${id} failed: ${String(err?.message || err)}`);
      }
    }

    // Closing a session asks its CLI to exit; give it a moment to actually
    // do so before reaching for taskkill. Nothing tracked means nothing to
    // wait for - don't add three seconds to every clean exit.
    if (tracker.list().length > 0) {
      await sleepImpl(graceMs);
      try {
        const killed = await tracker.killTracked({ signal: 'SIGKILL' });
        if (killed.length) {
          logImpl(`force-killed ${killed.length} CLI process(es) that outlived the ${graceMs}ms grace period: ${killed.map((e) => `${e.provider}/${e.pid}`).join(', ')}`);
        }
      } catch (err) {
        logImpl(`force-kill pass failed: ${String(err?.message || err)}`);
      }
    }

    // UNCONDITIONAL, and the last thing we do. The spec requires shutdown to
    // clear runtime.json, and on the clean path (every session closed, every
    // PID released) neither branch above writes anything. release()'s own
    // persist is fire-and-forget from grok-session/codex-session, and
    // exitVia() calls process.exit(0) immediately afterwards - which aborts an
    // in-flight writeJsonAtomic. Without this await, "runtime.json is [] after
    // a clean exit" is a race, and the next start reaps phantom entries.
    try {
      // Drain outstanding start-time probes first: each one persists when it
      // lands, and a probe resolving AFTER our flush would rewrite
      // runtime.json behind us.
      await tracker.settled();
      await tracker.persistNow();
    } catch (err) {
      logImpl(`could not flush runtime.json on shutdown: ${String(err?.message || err)}`);
    }
  }

  // A second Ctrl-C while the first teardown is still in flight must join it,
  // not start a competing one.
  function run(reason) {
    if (!running) running = perform(reason);
    return running;
  }

  return { run, onBeforeClose, isShuttingDown: () => running !== null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/shutdown.test.mjs`
Expected: PASS, 4/4.

- [ ] **Step 5: Wire it into `server.js`**

Add to the imports at the top of `src/server.js` (after the `operator-auth.js` import at `src/server.js:24`):

```js
import { getChildTracker } from './child-tracker.js';
import { createShutdown } from './shutdown.js';
```

Add after the router registration block (`src/server.js:31-35`):

```js
// Process ownership for the Grok/Codex CLIs (child-tracker.js). Exported so
// the auto-pilot supervisor can register its heartbeat stop via
// shutdown.onBeforeClose, and so a test can drive teardown directly.
const tracker = getChildTracker();
const shutdown = createShutdown({ registry, tracker });
```

Change the export line at `src/server.js:192` to include them:

```js
export { server, PORT, HOST, seedSessionDefaults, shutdown, tracker };
```

Then replace the whole `if (isMain) { ... }` block (`src/server.js:212-235`) with:

```js
if (isMain) {
  // Anything still in runtime.json belongs to a cockpit process that died
  // without running shutdown(). Reap before listening, so a pilot cannot
  // fire into a working tree an orphan is still writing to.
  tracker.reapOrphans().catch((err) => console.error(`orphan reap failed: ${String(err?.message || err)}`));

  // Exits once, through shutdown(), whichever route got us here.
  async function exitVia(reason) {
    // Leaving the terminal in raw mode makes the shell unusable afterwards -
    // and this has to happen BEFORE the await, not after, or a slow teardown
    // leaves the user with a dead prompt for seconds.
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
      process.stdin.pause();
    }
    try {
      await shutdown.run(reason);
    } catch (err) {
      console.error(`shutdown failed: ${String(err?.message || err)}`);
    }
    process.exit(0);
  }

  // SIGTERM is not meaningfully deliverable on Windows; SIGBREAK is the
  // closer analogue (Ctrl+Break, and what a console-window close sends).
  // SIGINT is still registered because setRawMode(true) below only suppresses
  // OS SIGINT delivery while stdin IS a TTY - piped/service invocations get
  // the real signal.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => { exitVia(signal); });
  }

  server.listen(PORT, HOST, () => {
    const op = getOperatorToken();
    const url = `http://${HOST}:${PORT}/?op=${op}`;
    console.log(`prompt-cockpit listening on ${url}`);

    if (process.stdin.isTTY) {
      console.log('Press c to copy the URL to clipboard.');
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', (str, key) => {
        // With raw mode on, this is the only Ctrl-C the process ever sees.
        if (key && key.ctrl && key.name === 'c') {
          exitVia('keypress-ctrl-c');
          return;
        }
        if (str === 'c') {
          copyToClipboard(url)
            .then(() => console.log('Copied!'))
            .catch((err) => console.error(`Could not copy to clipboard: ${err.message}`));
        }
      });
    }
  });
}
```

Note that the signal handlers and `reapOrphans()` live **inside** `if (isMain)`: `tests/server-auth.test.mjs` imports `src/server.js` (`tests/server-auth.test.mjs:18`) and must not register process-wide signal handlers or touch the real `~/.prompt-cockpit/runtime.json`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. In particular `tests/server-auth.test.mjs` still passes and its run leaves no `runtime.json` behind (`ls ~/.prompt-cockpit` should show only `operator-token`).

- [ ] **Step 7: Verify Ctrl-C by hand**

This is the whole point of the task and cannot be unit-tested:

1. `npm start`
2. Open the printed URL, start a **Grok** session, send one message so the ACP process is really up.
3. Note the pid: `cat ~/.prompt-cockpit/runtime.json`
4. Back in the server terminal, press Ctrl-C. Expected console output: `shutting down (keypress-ctrl-c)…`, then the process exits.
5. Confirm the terminal is usable (typing echoes normally — that is `setRawMode(false)` working).
6. Confirm the CLI is gone: `Get-Process -Id <pid> -ErrorAction SilentlyContinue` prints nothing.
7. Confirm `~/.prompt-cockpit/runtime.json` is now `[]`.
8. Repeat with a Codex session, and once with **two** Codex sessions open (one shared app-server pid, killed once).

- [ ] **Step 8: Re-run the live manual suites**

The spec requires these because this task changed Grok's and Codex's spawn/teardown paths. `tests/integration.manual.mjs` is **not** affected — Claude's spawn is unchanged.

Run: `node tests/grok-live.manual.mjs`
Expected: same result as before this branch.

There is no Codex equivalent of `grok-live.manual.mjs` in the repo (see `backlog.md`'s note that "Codex has no equivalent live manual test"). Cover it with step 7's hand-verification instead and say so in the commit message rather than claiming a suite ran that does not exist.

- [ ] **Step 9: Commit**

```bash
git add src/shutdown.js src/server.js tests/shutdown.test.mjs
git commit -m "feat: single async shutdown wired to Ctrl-C, SIGINT, SIGTERM and SIGBREAK"
```

---

## Done when

- `npm test` passes, with `tests/settings-file.test.mjs` and `tests/grok-acp.test.mjs` unedited.
- Ctrl-C from a TTY leaves no Grok or Codex process running and no raw-mode terminal (Task 5, step 7).
- Starting the cockpit after `taskkill /f` on it reaps the orphaned CLI, or logs a refusal naming the pid.
- `~/.prompt-cockpit/runtime.json` is `[]` after a clean exit and non-empty while sessions are live.
