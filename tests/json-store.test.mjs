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
