import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendToolOutput,
  completeToolCallRecord,
  createToolCallRecord,
  MAX_LIVE_OUTPUT_CHARS,
} from '../public/tool-call-store.js';

function pendingRecord(container, id = 'cmd-1') {
  return createToolCallRecord(container, { id, name: 'Bash', kind: 'shell', input: {}, payload: '', rowEl: null });
}

test('live output accumulates on a pending tool call record', () => {
  const container = {};
  pendingRecord(container);
  assert.equal(appendToolOutput(container, 'cmd-1', 'one\n').liveOutput, 'one\n');
  assert.equal(appendToolOutput(container, 'cmd-1', 'two\n').liveOutput, 'one\ntwo\n');
});

test('live output for an unknown or already finished call is ignored', () => {
  const container = {};
  assert.equal(appendToolOutput(container, 'missing', 'x'), null);
  pendingRecord(container);
  completeToolCallRecord(container, 'cmd-1', { resultText: 'final', isError: false, resultAtMs: 1 });
  assert.equal(appendToolOutput(container, 'cmd-1', 'late'), null);
});

test('live output keeps only the newest tail once it passes the cap', () => {
  const container = {};
  pendingRecord(container);
  appendToolOutput(container, 'cmd-1', 'a'.repeat(MAX_LIVE_OUTPUT_CHARS));
  const record = appendToolOutput(container, 'cmd-1', 'TAIL');
  assert.equal(record.liveOutput.length, MAX_LIVE_OUTPUT_CHARS);
  assert.ok(record.liveOutput.endsWith('TAIL'));
});
