// Single-owner lock for the superagent supervisor. Every Cockpit on this
// machine shares ~/.prompt-cockpit/superagent/, so only the one holding
// owner.lock runs the supervisor; the others point at it.
//
// Acquisition is create-if-absent (`open(file, 'wx')`), so two Cockpits
// booting together cannot both win. A lock whose owner is provably dead
// ('gone' or 'mismatch' from child-tracker's verifyEntry) is taken over by
// renaming it to a claim file only we name, then checking that the claim
// still carries the token judged dead before deleting it and creating ours
// with 'wx' again. A contender that moved a fresh lock instead puts it back
// with `link`, which fails rather than overwrite (unlike `rename` on Windows).
// On Windows two concurrent renames of one file can BOTH succeed, the second
// moving it on from the first one's claim, so a claim found empty after a
// successful rename is the same lost race as a rename that gets ENOENT. An
// owner that cannot be verified, or a lock that cannot be parsed, counts as
// occupied.
//
// Residual: three or more Cockpits booting within the same instant over a
// stale lock can still interleave badly (one moves a fresh lock aside while
// another finds the path empty and creates its own). Out of scope.
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { probeProcessStartTime, verifyEntry } from '../child-tracker.js';

export function createOwnerLock({
  file,
  port,
  pid = process.pid,
  idImpl = randomUUID,
  probeStartTime = probeProcessStartTime,
  verify = verifyEntry,
  fsImpl = fsPromises,
  logImpl = console.error,
}) {
  const token = idImpl();
  const claim = `${file}.${token}.claim`;
  let identity = null;

  async function create() {
    identity ??= { pid, osStartedAt: (await probeStartTime(pid)) ?? null, port, token };
    let handle;
    try {
      handle = await fsImpl.open(file, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
    try {
      await handle.writeFile(JSON.stringify(identity));
      await handle.datasync();
    } finally {
      await handle.close();
    }
    return true;
  }

  async function read(target) {
    let text;
    try {
      text = await fsImpl.readFile(target, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true };
      throw err;
    }
    try {
      const entry = JSON.parse(text);
      if (entry && typeof entry.token === 'string' && Number.isInteger(entry.pid) && entry.pid > 0) return { entry };
    } catch { /* falls through to corrupt */ }
    return { corrupt: true };
  }

  function occupied({ entry, corrupt }) {
    if (corrupt) return { owned: false, owner: null, corrupt: true };
    if (!entry) return { owned: false, owner: null };
    if (entry.token === token) return { owned: true };
    return { owned: false, owner: { pid: entry.pid, port: entry.port } };
  }

  async function attempt(mayRetry) {
    if (await create()) return { owned: true };
    const seen = await read(file);
    if (seen.missing) return mayRetry ? attempt(false) : occupied(seen);
    if (seen.corrupt || seen.entry.token === token) return occupied(seen);
    const status = await verify({ pid: seen.entry.pid, osStartedAt: seen.entry.osStartedAt });
    if (status !== 'gone' && status !== 'mismatch') return occupied(seen);
    return takeOver(seen.entry.token, mayRetry);
  }

  async function takeOver(staleToken, mayRetry) {
    const lostRace = () => (mayRetry ? attempt(false) : occupied({}));
    try {
      await fsImpl.rename(file, claim);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return lostRace();
    }
    const claimed = await read(claim);
    if (claimed.missing) return lostRace();
    if (claimed.entry?.token === staleToken) {
      await unlinkIfPresent(claim);
      if (await create()) return { owned: true };
      return occupied(await read(file));
    }
    try {
      await fsImpl.link(claim, file);
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'ENOENT') throw err;
    }
    await unlinkIfPresent(claim);
    return occupied(await read(file));
  }

  async function unlinkIfPresent(target) {
    try {
      await fsImpl.unlink(target);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async function release() {
    try {
      const { entry } = await read(file);
      if (entry?.token === token) await fsImpl.unlink(file);
    } catch (err) {
      if (err.code !== 'ENOENT') logImpl(`superagent: could not release ${file}: ${err.message}`);
    }
  }

  return { acquire: () => attempt(true), release };
}
