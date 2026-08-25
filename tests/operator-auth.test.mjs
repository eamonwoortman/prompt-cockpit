import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOperatorToken, tokensEqual, mintOperatorToken } from '../src/operator-auth.js';

test('tokensEqual is length-safe and rejects mismatches', () => {
  const token = 'a'.repeat(64);
  assert.equal(tokensEqual(token, token), true);
  assert.equal(tokensEqual(token, 'b'.repeat(64)), false);
  assert.equal(tokensEqual(token, token.slice(0, 32)), false);
  assert.equal(tokensEqual(token, ''), false);
  assert.equal(tokensEqual('', token), false);
});

test('resolveOperatorToken prefers COCKPIT_OPERATOR_TOKEN over the file', () => {
  let wrote = false;
  const token = resolveOperatorToken({
    envToken: '  env-token-value-16plus  ',
    filePath: '/tmp/unused',
    readFileSyncImpl: () => { throw new Error('should not read'); },
    writeFileSyncImpl: () => { wrote = true; },
    mkdirSyncImpl: () => {},
  });
  assert.equal(token, 'env-token-value-16plus');
  assert.equal(wrote, false);
});

test('resolveOperatorToken reuses a persisted file and does not rewrite it', () => {
  let writes = 0;
  const token = resolveOperatorToken({
    envToken: '',
    filePath: '/tmp/operator-token',
    readFileSyncImpl: () => 'persisted-token-16plus\n',
    writeFileSyncImpl: () => { writes += 1; },
    mkdirSyncImpl: () => {},
    mintImpl: () => 'fresh-minted-token-16plus',
  });
  assert.equal(token, 'persisted-token-16plus');
  assert.equal(writes, 0);
});

test('resolveOperatorToken mints and writes when the file is missing', () => {
  const writes = [];
  const minted = mintOperatorToken();
  const token = resolveOperatorToken({
    envToken: '',
    filePath: '/tmp/prompt-cockpit/operator-token',
    readFileSyncImpl: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    writeFileSyncImpl: (p, data) => { writes.push({ p, data }); },
    mkdirSyncImpl: () => {},
    mintImpl: () => minted,
  });
  assert.equal(token, minted);
  assert.equal(writes.length, 1);
  assert.match(writes[0].data, new RegExp(`^${minted}\\n$`));
});
