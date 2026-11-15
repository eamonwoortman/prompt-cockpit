import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderChainTranscript, buildChainHandoff, writeChainTranscript, WHOLE_READ_CHARS } from '../src/chain-transcript.js';

const user = (text) => ({ type: 'user', message: { content: text } });
const result = (content) => ({ type: 'user', message: { content: [{ type: 'tool_result', content }] } });
const assistant = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', name, input });
const thinking = (t) => ({ type: 'thinking', thinking: t });

test('renders numbered turns, assistant text, tool calls and capped tool results; drops thinking', () => {
  const { text: out, turns } = renderChainTranscript([
    user('first'), assistant(thinking('secret thoughts'), text('on it'), tool('Bash', { command: 'ls' })), result('x'.repeat(50)), user('second'),
  ], { toolResultCap: 20, from: { providerLabel: 'Claude', name: 'main', cwd: '/p' } });
  assert.equal(turns, 2);
  assert.match(out, /^# Transcript of an earlier Claude session "main" in \/p/);
  assert.match(out, /## Turn 1\n\n\*\*User:\*\* first/);
  assert.match(out, /## Turn 2\n\n\*\*User:\*\* second/);
  assert.match(out, /\*\*Assistant:\*\* on it/);
  assert.match(out, /tool `Bash` \{"command":"ls"\}/);
  assert.match(out, /result: x{17}\.\.\. \[\+\d+ chars\]/);
  assert.doesNotMatch(out, /secret thoughts/);
});

test('tool results given as content blocks are flattened', () => {
  const { text: out } = renderChainTranscript([user('go'), assistant(tool('Read', {})), result([{ type: 'text', text: 'file body' }])]);
  assert.match(out, /result: file body/);
});

test('an empty conversation says so', () => {
  assert.match(renderChainTranscript([]).text, /no conversation to carry over/);
  assert.match(renderChainTranscript(null).text, /no conversation to carry over/);
});

test('handoff: short transcripts say read whole, long ones say read the end and search; both carry the last exchange', () => {
  const messages = [user('old'), assistant(text('older reply')), user('the last ask'), assistant(text('the last reply'))];
  const short = buildChainHandoff(messages, { from: { providerLabel: 'Claude', cwd: '/p' }, filePath: '/tmp/x.md', chars: 1000, turns: 2 });
  assert.match(short, /\/tmp\/x\.md/);
  assert.match(short, /read whole/);
  assert.match(short, /Last user message:\nthe last ask/);
  assert.match(short, /Last assistant reply:\nthe last reply/);
  const long = buildChainHandoff(messages, { filePath: '/tmp/x.md', chars: WHOLE_READ_CHARS + 1, turns: 2 });
  assert.match(long, /read the end of the file first/);
  assert.match(long, /subagent/);
});

test('writeChainTranscript writes a private file and prunes week-old ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chain-tr-'));
  const old = path.join(dir, 'old.md');
  await fs.writeFile(old, 'stale');
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fs.utimes(old, longAgo, longAgo);
  const { file, dir: realDir } = await writeChainTranscript('# hi', { id: 'a/b c', dir });
  assert.equal(await fs.readFile(file, 'utf8'), '# hi');
  assert.equal(path.dirname(file), realDir);
  assert.match(path.basename(file), /^a_b_c-\d+\.md$/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(() => fs.stat(old));
  await fs.rm(dir, { recursive: true, force: true });
});
