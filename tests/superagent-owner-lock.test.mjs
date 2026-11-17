import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOwnerLock } from '../src/superagent/owner-lock.js';
import { tempDir } from './superagent-helpers.mjs';

process.env.COCKPIT_HOME = await tempDir('sa-lock-home-');

const STALE_PID = 999;
const STARTED = 1_700_000_000_000;
const quiet = () => {};
const staleUnlessPid = (status = 'gone') => async (e) => (e.pid === STALE_PID ? status : 'match');

async function lockFile() {
  const dir = await tempDir('sa-lock-');
  return path.join(dir, 'owner.lock');
}

function makeLock(file, { token, pid, port, verify = staleUnlessPid(), fsImpl, logImpl = quiet } = {}) {
  return createOwnerLock({
    file, port, pid,
    idImpl: () => token,
    probeStartTime: async () => STARTED,
    verify,
    ...(fsImpl ? { fsImpl } : {}),
    logImpl,
  });
}

const lockA = (file, over = {}) => makeLock(file, { token: 'tok-a', pid: 111, port: 4317, ...over });
const lockB = (file, over = {}) => makeLock(file, { token: 'tok-b', pid: 222, port: 4318, ...over });

const readLock = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeStale = (file, token = 'tok-s') => fs.writeFile(file, JSON.stringify({ pid: STALE_PID, osStartedAt: STARTED, port: 4000, token }));
const leftovers = async (file) => (await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.claim') || n.endsWith('.tmp'));
const ownerOf = (r) => (r.token === 'tok-a' ? { pid: 111, port: 4317 } : { pid: 222, port: 4318 });

test('the first acquire owns the lock and writes its identity', async () => {
  const file = await lockFile();
  assert.deepEqual(await lockA(file).acquire(), { owned: true });
  assert.deepEqual(await readLock(file), { pid: 111, osStartedAt: STARTED, port: 4317, token: 'tok-a' });
  assert.deepEqual(await leftovers(file), []);
});

test("a live owner's lock is refused", async () => {
  for (const status of ['match', 'unverifiable']) {
    const file = await lockFile();
    await lockA(file).acquire();
    const seen = [];
    const verify = async (e) => { seen.push(e); return status; };
    assert.deepEqual(await lockB(file, { verify }).acquire(), { owned: false, owner: { pid: 111, port: 4317 } }, status);
    assert.deepEqual(seen, [{ pid: 111, osStartedAt: STARTED }]);
    assert.equal((await readLock(file)).token, 'tok-a');
  }
});

test("a dead owner's lock is taken over", async () => {
  for (const status of ['gone', 'mismatch']) {
    const file = await lockFile();
    await writeStale(file);
    assert.deepEqual(await lockA(file, { verify: staleUnlessPid(status) }).acquire(), { owned: true }, status);
    assert.equal((await readLock(file)).token, 'tok-a');
    assert.deepEqual(await leftovers(file), []);
  }
});

test('simultaneous acquisition has exactly one winner', async () => {
  for (let i = 0; i < 20; i++) {
    const file = await lockFile();
    const results = await Promise.all([lockA(file).acquire(), lockB(file).acquire()]);
    const lock = await readLock(file);
    const winner = lock.token === 'tok-a' ? 0 : 1;
    assert.deepEqual(results[winner], { owned: true });
    assert.deepEqual(results[1 - winner], { owned: false, owner: ownerOf(lock) });
    assert.deepEqual(await leftovers(file), []);
  }
});

test('simultaneous stale takeover has exactly one winner', async () => {
  for (let i = 0; i < 20; i++) {
    const file = await lockFile();
    await writeStale(file);
    const results = await Promise.all([lockA(file).acquire(), lockB(file).acquire()]);
    const lock = await readLock(file);
    const winner = lock.token === 'tok-a' ? 0 : 1;
    assert.deepEqual(results[winner], { owned: true }, JSON.stringify(results));
    assert.deepEqual(results[1 - winner], { owned: false, owner: ownerOf(lock) }, JSON.stringify(results));
    assert.deepEqual(await leftovers(file), []);
  }
});

test('a contender that moved a fresh lock puts it back', async () => {
  const file = await lockFile();
  await writeStale(file);
  const b = lockB(file);
  let bResult;
  const ops = [];
  const fsImpl = {
    ...fs,
    async rename(from, to) {
      ops.push('rename');
      bResult = await b.acquire();
      return fs.rename(from, to);
    },
    async link(from, to) {
      if (from.endsWith('.claim')) ops.push('put back');
      return fs.link(from, to);
    },
  };
  const aResult = await lockA(file, { fsImpl }).acquire();
  assert.deepEqual(bResult, { owned: true });
  assert.deepEqual(aResult, { owned: false, owner: { pid: 222, port: 4318 } });
  assert.deepEqual(ops, ['rename', 'put back']);
  assert.equal((await readLock(file)).token, 'tok-b');
  assert.deepEqual(await leftovers(file), []);
});

test('a claim emptied after a successful rename is a lost race', async () => {
  const file = await lockFile();
  await writeStale(file);
  const b = lockB(file);
  let bResult;
  const fsImpl = {
    ...fs,
    async rename(from, to) {
      await fs.rename(from, to);
      await fs.rename(to, from);
      bResult = await b.acquire();
    },
    async link(from, to) {
      if (from.endsWith('.claim')) assert.fail('a lost race must not put anything back');
      return fs.link(from, to);
    },
  };
  const aResult = await lockA(file, { fsImpl }).acquire();
  assert.deepEqual(bResult, { owned: true });
  assert.deepEqual(aResult, { owned: false, owner: { pid: 222, port: 4318 } });
  assert.equal((await readLock(file)).token, 'tok-b');
  assert.deepEqual(await leftovers(file), []);
});

test('a fresh lock moved on from our claim before we put it back is left alone', async () => {
  const file = await lockFile();
  await writeStale(file);
  const b = lockB(file);
  let bResult;
  const fsImpl = {
    ...fs,
    async rename(from, to) {
      bResult = await b.acquire();
      return fs.rename(from, to);
    },
    async link(from, to) {
      if (from.endsWith('.claim')) await fs.rename(from, to);
      return fs.link(from, to);
    },
  };
  const aResult = await lockA(file, { fsImpl }).acquire();
  assert.deepEqual(bResult, { owned: true });
  assert.deepEqual(aResult, { owned: false, owner: { pid: 222, port: 4318 } });
  assert.equal((await readLock(file)).token, 'tok-b');
  assert.deepEqual(await leftovers(file), []);
});

test('a takeover rename refused while racing an unlink is a lost race, once', async () => {
  const file = await lockFile();
  await writeStale(file);
  const b = lockB(file);
  let bResult;
  const fsImpl = {
    ...fs,
    async rename() {
      bResult = await b.acquire();
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    },
  };
  assert.deepEqual(await lockA(file, { fsImpl }).acquire(), { owned: false, owner: { pid: 222, port: 4318 } });
  assert.deepEqual(bResult, { owned: true });

  const stuck = await lockFile();
  await writeStale(stuck);
  let renames = 0;
  const busy = {
    ...fs,
    async rename() {
      renames++;
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    },
  };
  await assert.rejects(lockA(stuck, { fsImpl: busy }).acquire(), { code: 'EBUSY' });
  assert.equal(renames, 2);
  assert.equal((await readLock(stuck)).token, 'tok-s');
});

test('a failed identity write publishes nothing and surfaces the write error', async () => {
  const file = await lockFile();
  const fsImpl = {
    ...fs,
    async open(target, flags) {
      const handle = await fs.open(target, flags);
      return {
        writeFile: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
        datasync: () => handle.datasync(),
        close: async () => { await handle.close(); throw Object.assign(new Error('bad fd'), { code: 'EBADF' }); },
      };
    },
  };
  await assert.rejects(lockA(file, { fsImpl }).acquire(), { code: 'ENOSPC' });
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(file), []);
  assert.deepEqual(await lockA(file).acquire(), { owned: true });
});

test("a faster contender's new lock makes the slower one occupied", async () => {
  const file = await lockFile();
  await writeStale(file);
  const b = lockB(file);
  let bResult;
  const fsImpl = {
    ...fs,
    async unlink(target) {
      await fs.unlink(target);
      if (target.endsWith('.claim') && !bResult) bResult = await b.acquire();
    },
  };
  const aResult = await lockA(file, { fsImpl }).acquire();
  assert.deepEqual(bResult, { owned: true });
  assert.deepEqual(aResult, { owned: false, owner: { pid: 222, port: 4318 } });
  assert.equal((await readLock(file)).token, 'tok-b');
  assert.deepEqual(await leftovers(file), []);
});

test('leftover claim and tmp files from a crash are ignored', async () => {
  const live = await lockFile();
  await lockB(live).acquire();
  await fs.writeFile(`${live}.x.claim`, JSON.stringify({ pid: STALE_PID, osStartedAt: STARTED, port: 4000, token: 'x' }));
  await fs.writeFile(`${live}.x.tmp`, 'garbage');
  assert.deepEqual(await lockA(live).acquire(), { owned: false, owner: { pid: 222, port: 4318 } });
  assert.equal((await readLock(live)).token, 'tok-b');

  const free = await lockFile();
  await fs.writeFile(`${free}.x.claim`, 'garbage');
  await fs.writeFile(`${free}.x.tmp`, 'garbage');
  assert.deepEqual(await lockA(free).acquire(), { owned: true });
  assert.equal((await readLock(free)).token, 'tok-a');
});

test('an unparseable lock is occupied', async () => {
  for (const content of ['not json{', '', 'null', '"tok"', JSON.stringify({ pid: 5, port: 1 })]) {
    const file = await lockFile();
    await fs.writeFile(file, content);
    let verified = false;
    const verify = async () => { verified = true; return 'gone'; };
    assert.deepEqual(await lockA(file, { verify }).acquire(), { owned: false, owner: null, corrupt: true }, content);
    assert.equal(verified, false);
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
});

test('release removes only our own lock', async () => {
  const file = await lockFile();
  const a = lockA(file);
  await a.acquire();
  await fs.writeFile(file, JSON.stringify({ pid: 222, osStartedAt: STARTED, port: 4318, token: 'tok-b' }));
  await a.release();
  assert.equal((await readLock(file)).token, 'tok-b');

  await fs.unlink(file);
  await a.acquire();
  await a.release();
  await assert.rejects(fs.access(file), { code: 'ENOENT' });

  const logs = [];
  await lockA(file, { logImpl: (m) => logs.push(m) }).release();
  assert.deepEqual(logs, []);
});
