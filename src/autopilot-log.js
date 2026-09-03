// Append-only auto-pilot run history: ~/.prompt-cockpit/autopilot-log.jsonl.
// One JSON object per line, deliberately NOT a json-store.js document - this
// grows without bound between rotations and is only ever appended to, so
// rewriting the whole file on every run would be wrong twice over.
//
// It backs two things: the panel's Logs tab, and the global daily spend cap.
// That second job is why rotation is not just "truncate at 2 MB" - rotating
// resets the day's computed total, so the routine carries the day's running
// cost into the fresh file as a `carry-forward` entry. At 2 MB rotation is
// unlikely within one day, but "unlikely" is not "never", and the failure
// mode is a spend cap that silently resets mid-day.
import { appendFile, readFile, rename, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const ROTATE_BYTES = 2 * 1024 * 1024;

// `carry-forward` is not one of the spec's outcome events - it is the
// synthetic first line rotate() writes so dailyCostUsd survives a rotation.
// It is excluded from tail()'s default view for the same reason.
// Two events beyond the spec's seven, both deliberate additions rather than
// overloading an existing one:
//   `answered`      - a question the interceptor auto-answered. That run was
//                     never blocked, so logging it as `blocked` would put an
//                     amber BLOCKED chip on a run that never stopped.
//   `carry-forward` - the synthetic first line rotate() writes so
//                     dailyCostUsd survives a rotation. Belongs to no pilot.
export const LOG_EVENTS = Object.freeze([
  'fired', 'skipped', 'blocked', 'answered', 'finished', 'timed-out', 'errored', 'closed-externally', 'carry-forward',
]);

export function defaultAutopilotLogPath(home = homedir()) {
  return path.join(home, '.prompt-cockpit', 'autopilot-log.jsonl');
}

function startOfLocalDay(atMs) {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn final line is what a hard kill mid-append leaves behind.
      // Skipping it beats making the whole log unreadable.
    }
  }
  return out;
}

export function createAutopilotLog({
  filePath = defaultAutopilotLogPath(),
  now = () => Date.now(),
  rotateBytes = ROTATE_BYTES,
} = {}) {
  // Serialize appends: two entries landing in the same tick must not
  // interleave partial lines.
  let chain = Promise.resolve();

  async function readAll() {
    try {
      return parseLines(await readFile(filePath, 'utf-8'));
    } catch {
      return []; // missing file - not an error
    }
  }

  function sumSince(entries, sinceMs) {
    let costUsd = 0;
    let unpricedRuns = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.ts !== 'number' || entry.ts < sinceMs) continue;
      // Every cost-bearing event counts, not just `finished` - a timed-out
      // run spent real money before it was killed.
      if (typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd)) costUsd += entry.costUsd;
      if (entry.costUnpriced) unpricedRuns += 1;
    }
    return { costUsd, unpricedRuns };
  }

  async function writeLine(entry) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  async function rotateNow() {
    let entries;
    try {
      entries = parseLines(await readFile(filePath, 'utf-8'));
    } catch {
      return false; // nothing to rotate
    }
    const at = now();
    const carried = sumSince(entries, startOfLocalDay(at));
    // Windows cannot rename over an existing file, and the SECOND rotation
    // always targets an existing .1 - so a bare rename here would reject the
    // append that triggered it, from inside the heartbeat. Same workaround as
    // json-store.js's writeJsonAtomic; duplicated deliberately, because this
    // file is JSONL and has no json-store helper to reuse.
    const previous = `${filePath}.1`;
    try {
      await rename(filePath, previous);
    } catch (err) {
      if (process.platform !== 'win32') throw err;
      await unlink(previous).catch(() => {});
      await rename(filePath, previous);
    }
    // One generation only. The live file starts with the day's running total
    // so the spend cap does not reset just because the log got long.
    await writeFile(filePath, `${JSON.stringify({
      ts: at,
      event: 'carry-forward',
      pilotId: null,
      pilotName: null,
      costUsd: carried.costUsd,
      costUnpriced: carried.unpricedRuns > 0,
      reason: `carried forward from ${path.basename(filePath)}.1`,
    })}\n`, 'utf-8');
    return true;
  }

  function enqueue(fn) {
    const run = chain.then(fn, fn);
    // Keep the chain alive after a rejection without swallowing it from the
    // caller - same reasoning as json-store.js's own `run.finally(...).catch`.
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    filePath,

    append(entry) {
      const event = entry?.event;
      if (!LOG_EVENTS.includes(event)) {
        return Promise.reject(new Error(`unknown auto-pilot log event: ${String(event)}`));
      }
      return enqueue(async () => {
        const record = { ts: entry.ts ?? now(), ...entry };
        // A rotation check BEFORE the write, so the carry-forward line is
        // never itself the thing that pushes the file over the threshold.
        try {
          const { size } = await stat(filePath);
          if (size >= rotateBytes) await rotateNow();
        } catch {
          // missing file - nothing to rotate
        }
        await writeLine(record);
        return record;
      });
    },

    // Newest last, matching how the Logs tab renders. `carry-forward` is
    // included only when a pilotId filter is absent, since it belongs to no
    // pilot.
    async tail({ pilotId = null, limit = 200 } = {}) {
      const entries = await readAll();
      const filtered = pilotId ? entries.filter((e) => e && e.pilotId === pilotId) : entries;
      return limit > 0 ? filtered.slice(-limit) : filtered;
    },

    async dailyCostUsd(atMs = now()) {
      return sumSince(await readAll(), startOfLocalDay(atMs));
    },

    rotate() {
      return enqueue(rotateNow);
    },
  };
}
