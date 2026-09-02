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

// Runs `job` while holding this path's queue slot, and hands back a promise
// that settles when the job does - so `await` on the return value is a
// complete flush of everything queued up to that point, and two writers in
// the same tick land in call order rather than whichever rename won.
function withPathLock(filePath, job) {
  const key = path.resolve(filePath);
  const prev = writeQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(job);
  writeQueues.set(key, run);
  // `run.finally(...)` returns a new derived promise that also rejects
  // whenever `run` rejects, and nothing awaits that derived promise - Node's
  // default unhandled-rejection handling would kill the whole process on any
  // write failure (disk full, permissions, the corrupt-file guard below).
  // `run` itself still carries the rejection forward to whoever awaits the
  // public function's return value.
  run.finally(() => {
    if (writeQueues.get(key) === run) writeQueues.delete(key);
  }).catch(() => {});
  return run;
}

// `mutator(value)` is called with the freshly-read value and may mutate it
// in place and/or return a value; whatever it returns is this function's
// return value. The read, mutate, and write all happen while holding this
// path's queue slot.
//
// `fallback` is a FACTORY, not a value: the returned object is handed to the
// mutator and then written, so a shared value would leak one call's
// mutations into the next call for a different path.
export async function updateJson(filePath, mutator, { fallback = () => ({}) } = {}) {
  return withPathLock(filePath, async () => {
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
}

// Same per-path serialization as updateJson, but `transform(current, corrupt)`
// RETURNS the value to write instead of mutating one in place, and a corrupt
// file is reported rather than refused.
//
// Both differences exist for runtime.json (child-tracker.js): its payload is
// an array rebuilt wholesale from in-memory state, so there is nothing to
// mutate in place when the file holds something else entirely (or nothing);
// and refusing to write it would mean a cockpit whose runtime.json got
// corrupted silently stops recording the PIDs it spawns - strictly worse than
// replacing the file, since the only thing lost is orphan reaping, which a
// corrupt file has already lost.
export async function replaceJson(filePath, transform, { fallback = () => ({}) } = {}) {
  return withPathLock(filePath, async () => {
    const { value, corrupt } = await readJsonChecked(filePath, fallback());
    const next = await transform(value, corrupt);
    await writeJsonAtomic(filePath, next);
    return next;
  });
}
