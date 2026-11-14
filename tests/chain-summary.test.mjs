import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChainSummary } from '../src/chain-summary.js';

const user = (text) => ({ type: 'user', message: { content: text } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'big output' }] } });
const assistant = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', name, input });

test('keeps user and assistant text, one line per tool call, drops results and thinking', () => {
  const out = buildChainSummary([
    user('fix the bug'),
    assistant({ type: 'thinking', thinking: 'secret' }, text('On it.'), tool('Bash', { command: 'npm test' }), tool('Edit', { file_path: 'src/a.js', old_string: 'x' })),
    toolResult(),
    assistant(text('Done.')),
  ], { from: { providerLabel: 'Claude', name: 'main', cwd: '/p' } });
  assert.match(out, /chained from an earlier Claude session "main" in \/p/);
  assert.match(out, /User: fix the bug/);
  assert.match(out, /Assistant: On it\.\nDone\./);
  assert.match(out, /- Bash: npm test/);
  assert.match(out, /- Edit: src\/a\.js/);
  assert.doesNotMatch(out, /secret|big output|old_string/);
});

test('merges consecutive assistant chunks into one entry', () => {
  const out = buildChainSummary([user('hi'), assistant(text('a')), assistant(text('b'))]);
  assert.equal(out.match(/Assistant:/g).length, 1);
  assert.match(out, /Assistant: a\nb/);
});

test('drops the oldest entries first when over budget and says how many', () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) messages.push(user(`question ${i} ${'x'.repeat(100)}`));
  const out = buildChainSummary(messages, { budgetChars: 400 });
  assert.match(out, /earlier messages? omitted/);
  assert.match(out, /question 9/);
  assert.doesNotMatch(out, /question 0 /);
});

test('always keeps the newest entry even if it alone exceeds the budget', () => {
  const out = buildChainSummary([user('old'), user('y'.repeat(3000))], { budgetChars: 50 });
  assert.match(out, /yyyy/);
  assert.match(out, /1 earlier message omitted/);
});

test('empty or missing history still yields a usable message', () => {
  assert.match(buildChainSummary([]), /no conversation to carry over/);
  assert.match(buildChainSummary(null), /no conversation to carry over/);
});

test('tool-only assistant turn is labeled and truncated args stay one line', () => {
  const out = buildChainSummary([user('go'), assistant(tool('Bash', { command: `echo ${'z'.repeat(500)}\nsecond line` }))]);
  assert.match(out, /Assistant \(tool calls only\):/);
  const toolLine = out.split('\n').find((l) => l.startsWith('  - Bash'));
  assert.ok(toolLine.length <= 205);
  assert.doesNotMatch(toolLine, /second line/);
});

test('a multi-line assistant reply survives whole, including lines that look like tool lines', () => {
  const reply = 'Plan:\n1. do X\n  - indented bullet\n2. do Y';
  const out = buildChainSummary([user('go'), assistant(text(reply), tool('Bash', { command: 'ls' }))]);
  assert.ok(out.includes(`Assistant: ${reply}`));
  assert.match(out, /\n  - Bash: ls/);
});
