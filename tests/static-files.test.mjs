// src/permissions.js and src/stream-join.js are already shared verbatim with
// the browser rather than duplicated into public/. autopilot-schedule.js joins
// them so the panel's "next run" label and the supervisor's own due-ness check
// cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/static-files.js';

const SRC_DIR = path.dirname(fileURLToPath(new URL('../src/static-files.js', import.meta.url)));

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || null; },
    end(data) { this.body = data; },
  };
}

test('the shared src modules are served from /', async () => {
  for (const name of ['permissions.js', 'stream-join.js', 'autopilot-schedule.js']) {
    const res = fakeRes();
    await serveStatic({}, res, new URL(`http://localhost/${name}`));
    assert.equal(res.statusCode, 200, name);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    const onDisk = await readFile(path.join(SRC_DIR, name));
    assert.equal(Buffer.compare(Buffer.from(res.body), onDisk), 0, `${name} served verbatim`);
  }
});

test('a src file that is NOT on the shared list is not reachable', async () => {
  const res = fakeRes();
  await serveStatic({}, res, new URL('http://localhost/session-registry.js'));
  assert.equal(res.statusCode, 404);
});

test('autopilot-schedule.js has no node: imports, or the browser load would fail', async () => {
  const source = await readFile(path.join(SRC_DIR, 'autopilot-schedule.js'), 'utf-8');
  assert.equal(/from ['"]node:/.test(source), false);
  assert.equal(/require\(/.test(source), false);
});
