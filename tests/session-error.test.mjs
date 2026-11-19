import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSessionError } from '../src/session-error.js';

const GROK_402 = 'Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted';

test('an exhausted usage balance reads as a plain explanation, quoting the provider', () => {
  const { text, kind } = describeSessionError(new Error(GROK_402));
  assert.equal(kind, 'balance');
  assert.match(text, /usage balance is exhausted/i);
  assert.match(text, /new session/i);
  assert.match(text, /Grok Build usage balance exhausted/, 'the provider\'s own wording stays visible');
});

test('a bare 402 or "payment required" is treated as a balance problem', () => {
  assert.equal(describeSessionError(new Error('HTTP 402')).kind, 'balance');
  assert.equal(describeSessionError('Payment Required').kind, 'balance');
});

test('an ordinary failure shows its message, not the stack trace', () => {
  const err = new Error('CLI crashed');
  const { text, kind, detail } = describeSessionError(err);
  assert.equal(kind, 'generic');
  assert.equal(text, 'CLI crashed');
  assert.ok(!/\n\s+at /.test(text), 'no stack frames in the user-facing text');
  assert.match(detail, /CLI crashed/);
  assert.match(detail, /\n\s+at /, 'the stack is still returned separately for logging');
});

test('non-Error and empty inputs still produce readable text', () => {
  assert.equal(describeSessionError('plain string').text, 'plain string');
  assert.equal(describeSessionError(undefined).text, 'Unknown error');
  assert.equal(describeSessionError({}).kind, 'generic');
});
