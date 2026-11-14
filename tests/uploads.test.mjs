import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sanitizeUploadName, saveUpload, readRawBody, UploadTooLargeError } from '../src/uploads.js';

test('sanitizeUploadName strips paths, odd chars, leading dots', () => {
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeUploadName('C:\\Users\\me\\shot 1.png'), 'shot_1.png');
  assert.equal(sanitizeUploadName('a<b>:"c".png'), 'a_b_c_.png');
  assert.equal(sanitizeUploadName('Screen Shot 10.00.png'), 'Screen_Shot_10.00.png'); // no spaces: the @path reference must stay one token
  assert.equal(sanitizeUploadName('.hidden'), 'hidden');
  assert.equal(sanitizeUploadName(''), 'upload');
  assert.equal(sanitizeUploadName(null), 'upload');
  assert.ok(sanitizeUploadName('x'.repeat(500)).length <= 100);
});

test('saveUpload writes under cwd, adds a self-ignoring .gitignore, returns a relative posix path', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'upl-'));
  const rel = await saveUpload(cwd, 'shot.png', Buffer.from([1, 2, 3]), 42);
  assert.equal(rel, '.claude/cockpit-uploads/42-shot.png');
  assert.deepEqual([...(await fs.readFile(path.join(cwd, rel)))], [1, 2, 3]);
  assert.equal(await fs.readFile(path.join(cwd, '.claude/cockpit-uploads/.gitignore'), 'utf8'), '*\n');
});

test('saveUpload cannot escape the upload dir via the name', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'upl-'));
  const rel = await saveUpload(cwd, '../../../evil.txt', Buffer.from('x'), 1);
  assert.equal(rel, '.claude/cockpit-uploads/1-evil.txt');
});

test('readRawBody enforces the limit', async () => {
  assert.equal((await readRawBody(Readable.from([Buffer.from('abc')]), 10)).toString(), 'abc');
  await assert.rejects(readRawBody(Readable.from([Buffer.alloc(11)]), 10), UploadTooLargeError);
});

test('readRawBody drains an oversized body instead of destroying it, so a 413 can still be sent', async () => {
  const body = Readable.from([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)]);
  let destroyedEarly = false;
  body.on('data', () => { if (body.destroyed) destroyedEarly = true; });
  await assert.rejects(readRawBody(body, 10), UploadTooLargeError);
  assert.equal(destroyedEarly, false);
  assert.equal(body.readableEnded, true, 'the whole body was read, not cut off');
});
