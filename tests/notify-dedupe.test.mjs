import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planNotifications, claimNotifications } from '../src/notify-dedupe.js';
import { serveStatic } from '../src/static-files.js';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const entry = (key) => ({ kind: 'superagent', type: 'needs-you', key, jobId: 'j', title: 't', message: 'm' });
const KEY = 'cockpit:notifiedKeys';

function fakeStorage(initial, delayMs = 0) {
  const data = new Map(initial === undefined ? [] : [[KEY, initial]]);
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    data,
    async getItem(k) { await wait(); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, v); },
  };
}

function serialLocks() {
  let tail = Promise.resolve();
  return {
    request(name, fn) {
      assert.equal(name, 'cockpit:notify');
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    },
  };
}

test('first poll records but does not notify', () => {
  const out = planNotifications({ entries: [entry('a'), entry('b')], record: [], firstPoll: true });
  assert.deepEqual(out.notify, []);
  assert.deepEqual(out.record, ['a', 'b']);
});

test('a new entry notifies once', () => {
  const entries = [entry('k1'), entry('k2')];
  const first = planNotifications({ entries, record: ['k1'], firstPoll: false });
  assert.deepEqual(first.notify.map((e) => e.key), ['k2']);
  assert.deepEqual(first.record, ['k1', 'k2']);
  const again = planNotifications({ entries, record: first.record, firstPoll: false });
  assert.deepEqual(again.notify, []);
});

test("a second tab sees the first tab's record", () => {
  const entries = [entry('k1'), entry('k2')];
  const tabA = planNotifications({ entries, record: [], firstPoll: true });
  const tabB = planNotifications({ entries, record: tabA.record, firstPoll: false });
  assert.deepEqual(tabB.notify, []);
});

test('record is pruned to current entries', () => {
  const out = planNotifications({ entries: [entry('k1')], record: ['k0', 'k1'], firstPoll: false });
  assert.deepEqual(out.record, ['k1']);
});

test('overlapping claims from two tabs notify once', async () => {
  const storage = fakeStorage(JSON.stringify(['old']), 5);
  const locks = serialLocks();
  const entries = [entry('old'), entry('new')];
  const [a, b] = await Promise.all([
    claimNotifications({ entries, firstPoll: false, storage, locks }),
    claimNotifications({ entries, firstPoll: false, storage, locks }),
  ]);
  assert.equal(a.length + b.length, 1);
});

test('without locks the claim still runs and does not throw', async () => {
  const storage = fakeStorage(JSON.stringify([]), 5);
  const entries = [entry('new')];
  const results = await Promise.all([
    claimNotifications({ entries, firstPoll: false, storage, locks: undefined }),
    claimNotifications({ entries, firstPoll: false, storage, locks: undefined }),
  ]);
  assert.ok(results.every(Array.isArray));
});

test('unparseable record counts as empty', async () => {
  const storage = fakeStorage('{');
  const out = await claimNotifications({ entries: [entry('a')], firstPoll: false, storage, locks: serialLocks() });
  assert.deepEqual(out.map((e) => e.key), ['a']);
  assert.deepEqual(JSON.parse(storage.data.get(KEY)), ['a']);
});

test('absent record counts as empty', async () => {
  const storage = fakeStorage(undefined);
  const out = await claimNotifications({ entries: [entry('a')], firstPoll: true, storage });
  assert.deepEqual(out, []);
  assert.deepEqual(JSON.parse(storage.data.get(KEY)), ['a']);
});

test('served to the browser verbatim', async () => {
  const res = { statusCode: 0, headers: null, body: null, writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(d) { this.body = d; } };
  await serveStatic({}, res, new URL('http://localhost/notify-dedupe.js'));
  assert.equal(res.statusCode, 200);
  const onDisk = await readFile(path.join(SRC_DIR, 'notify-dedupe.js'));
  assert.equal(Buffer.compare(Buffer.from(res.body), onDisk), 0);
});

test('a throwing getItem counts as an empty record', async () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() {} };
  const out = await claimNotifications({ entries: [entry('a')], firstPoll: false, storage, locks: serialLocks() });
  assert.deepEqual(out.map((e) => e.key), ['a']);
});

test('a throwing setItem still returns the planned entries', async () => {
  const storage = { async getItem() { return JSON.stringify([]); }, setItem() { throw new Error('quota'); } };
  const out = await claimNotifications({ entries: [entry('a')], firstPoll: false, storage, locks: serialLocks() });
  assert.deepEqual(out.map((e) => e.key), ['a']);
});
