import { test } from 'node:test';
import assert from 'node:assert/strict';

// compose.js touches window/document only inside autosize() and the resize
// drag, so a few globals plus a fake textarea are enough to drive send().
globalThis.window = { innerHeight: 1000 };
globalThis.document = { addEventListener() {}, removeEventListener() {} };
const { initCompose } = await import('../public/compose.js');

function makeCompose(onSend) {
  const listeners = {};
  const textarea = {
    value: '',
    placeholder: 'Message...',
    scrollHeight: 60,
    style: {},
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const sendButton = { closest: () => null, addEventListener(type, fn) { listeners.click = fn; } };
  const recorded = [];
  const promptHistory = { record: (t) => recorded.push(t), list: () => [] };
  initCompose({ textarea, sendButton, onSend, promptHistory });
  return { textarea, click: () => listeners.click(), recorded };
}

test('send clears the box and records history when onSend accepts the message', () => {
  const c = makeCompose(() => undefined);
  c.textarea.value = 'hello';
  c.click();
  assert.equal(c.textarea.value, '');
  assert.deepEqual(c.recorded, ['hello']);
});

test('send keeps the typed text and skips history when onSend returns false (not delivered)', () => {
  const c = makeCompose(() => false);
  c.textarea.value = 'hello';
  c.click();
  assert.equal(c.textarea.value, 'hello');
  assert.deepEqual(c.recorded, []);
});
