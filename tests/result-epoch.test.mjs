import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResultEpochTracker } from '../src/result-epoch.js';

test('consumeFifo matches push order until forceIdle', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.push('b');
  const first = t.consumeFifo();
  assert.equal(first.stale, false);
  assert.equal(first.queueId, 'a');
  assert.equal(first.epoch, 0);
  const second = t.consumeFifo();
  assert.equal(second.queueId, 'b');
  assert.equal(second.stale, false);
});

test('forceIdle then a new push: FIFO late result is stale, the new turn is not', () => {
  const t = createResultEpochTracker();
  const a = t.push('a');
  t.forceIdle();
  assert.equal(t.epoch, 1);
  const b = t.push('b');
  const late = t.consumeFifo();
  assert.equal(late.queueId, 'a');
  assert.equal(late.stale, true);
  assert.equal(late.epoch, a.epoch);
  const live = t.consumeFifo();
  assert.equal(live.queueId, 'b');
  assert.equal(live.stale, false);
  assert.equal(live.epoch, b.epoch);
});

test('consume by identity does not let a never-arriving abandoned turn steal the next live result', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.forceIdle();
  const b = t.push('b');
  const live = t.consume(b);
  assert.equal(live.queueId, 'b');
  assert.equal(live.stale, false);
  const late = t.consume('a');
  assert.equal(late.queueId, 'a');
  assert.equal(late.stale, true);
});

test('stamp uses abandoned-in-flight meta so leftover assistant text keeps the old epoch', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.forceIdle();
  t.push('b');
  const msg = { type: 'assistant' };
  t.stamp(msg);
  assert.equal(msg._cockpitEpoch, 0);
  assert.equal(msg._cockpitQueueId, 'a');
});

test('remove drops a queued id so a later fifo consume cannot hit it', () => {
  const t = createResultEpochTracker();
  t.push('in-flight');
  t.push('queued');
  assert.equal(t.remove('queued'), true);
  assert.equal(t.consumeFifo().queueId, 'in-flight');
  assert.equal(t.consumeFifo().meta, null);
});
