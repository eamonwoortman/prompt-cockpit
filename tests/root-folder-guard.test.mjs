import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootFolderGuard } from '../src/root-folder-guard.js';

const options = { platform: 'win32', statPath: async (p) => {
  if (/^[CD]:\\(Users|Dev)$/i.test(p)) return { isDirectory: () => true };
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
} };
const check = (command, cwd = 'D:\\Dev\\project') => rootFolderGuard(command, cwd, options);

test('blocks common literal root-folder creation commands', async () => {
  for (const command of ['mkdir C:/c/bla', 'md D:\\new\\nested', 'New-Item -ItemType Directory -Path "C:\\new folder\\child"', 'mkdir newfolder']) {
    const cwd = command === 'mkdir newfolder' ? 'D:\\' : undefined;
    assert.match(await check(command, cwd), /ask the user to create it/i, command);
  }
});

test('allows existing root folders and other commands', async () => {
  for (const command of ['mkdir D:\\Dev\\project\\temp', 'mkdir C:\\Users\\person\\temp', 'git status']) {
    assert.equal(await check(command), null, command);
  }
  assert.equal(await rootFolderGuard('mkdir C:\\new', 'D:\\', { ...options, platform: 'linux' }), null);
});
