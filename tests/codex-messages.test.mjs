import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexItemToMessages,
  codexNotificationToMessages,
  codexThreadToMessages,
} from '../src/codex-messages.js';

test('streamed Codex text and reasoning deltas use the shared transcript shape', () => {
  const text = codexNotificationToMessages(
    'item/agentMessage/delta',
    { delta: 'hello' },
    'thread-1',
    { model: 'codex-model' },
  );
  assert.equal(text[0].type, 'assistant');
  assert.equal(text[0].message.model, 'codex-model');
  assert.deepEqual(text[0].message.content, [{ type: 'text', text: 'hello' }]);

  const reasoning = codexNotificationToMessages(
    'item/reasoning/summaryTextDelta',
    { delta: 'thinking' },
    'thread-1',
  );
  assert.deepEqual(reasoning[0].message.content, [{ type: 'thinking', thinking: 'thinking' }]);

  // Their completed items contain the accumulated text again. Live sessions
  // must not append that after already rendering the deltas.
  assert.deepEqual(codexNotificationToMessages('item/completed', {
    item: { type: 'agentMessage', text: 'hello' },
  }, 'thread-1'), []);
  assert.deepEqual(codexNotificationToMessages('item/completed', {
    item: { type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
  }, 'thread-1'), []);
});

test('completed command and file-change items become tool use/result pairs', () => {
  const command = codexItemToMessages({
    id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/repo',
    aggregatedOutput: 'ok', exitCode: 0, status: 'completed',
  }, 'thread-1');
  assert.equal(command[0].message.content[0].name, 'Bash');
  assert.equal(command[1].message.content[0].tool_use_id, 'cmd-1');
  assert.equal(command[1].message.content[0].is_error, false);

  const file = codexItemToMessages({
    id: 'file-1', type: 'fileChange', changes: [{ path: 'a.js' }], status: 'declined',
  }, 'thread-1');
  assert.equal(file[0].message.content[0].name, 'Edit');
  assert.equal(file[1].message.content[0].is_error, true);
  assert.equal(file[1].message.content[0].content, 'File change declined');
});

test('turn completion and stored threads preserve status and history', () => {
  const failed = codexNotificationToMessages('turn/completed', {
    turn: { id: 'turn-1', status: 'failed', error: { message: 'boom' } },
  }, 'thread-1');
  assert.equal(failed[0].subtype, 'error');
  assert.equal(failed[0].error, 'boom');

  const messages = codexThreadToMessages({
    id: 'thread-1', model: 'codex-model', turns: [{
      status: 'completed',
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', text: 'answer' },
      ],
    }],
  });
  assert.deepEqual(messages.map(({ type }) => type), ['user', 'assistant']);
  assert.equal(messages[1].message.model, 'codex-model');
});

test('previously-dropped item types (MCP calls, plans, web search, review mode, ...) render as generic tool calls', () => {
  const mcp = codexItemToMessages({
    id: 'mcp-1', type: 'mcpToolCall', server: 'github', tool: 'search_issues',
    arguments: { q: 'bug' }, status: 'completed', result: 'three issues found',
  }, 'thread-1');
  assert.equal(mcp[0].message.content[0].name, 'mcp__github__search_issues');
  assert.equal(mcp[0].message.content[0].input.q, 'bug');
  assert.equal(mcp[1].message.content[0].tool_use_id, 'mcp-1');
  assert.equal(mcp[1].message.content[0].is_error, false);

  const mcpFailed = codexItemToMessages({
    id: 'mcp-2', type: 'mcpToolCall', server: 'github', tool: 'search_issues',
    arguments: {}, status: 'failed', error: 'timeout',
  }, 'thread-1');
  assert.equal(mcpFailed[1].message.content[0].is_error, true);

  const dynamic = codexItemToMessages({
    id: 'dyn-1', type: 'dynamicToolCall', tool: 'custom_tool', arguments: { x: 1 },
    status: 'completed', success: true, contentItems: [{ text: 'done' }],
  }, 'thread-1');
  assert.equal(dynamic[0].message.content[0].name, 'custom_tool');
  assert.equal(dynamic[1].message.content[0].is_error, false);

  const search = codexItemToMessages({ id: 'ws-1', type: 'webSearch', query: 'weather' }, 'thread-1');
  assert.equal(search.length, 1, 'no result field in the schema - no tool_result pair');
  assert.equal(search[0].message.content[0].name, 'WebSearch');

  const image = codexItemToMessages({ id: 'img-1', type: 'imageView', path: '/tmp/x.png' }, 'thread-1');
  assert.equal(image[0].message.content[0].name, 'ViewImage');

  const plan = codexItemToMessages({ id: 'plan-1', type: 'plan', text: '1. do x\n2. do y' }, 'thread-1');
  assert.equal(plan[0].message.content[0].name, 'Plan');
  assert.equal(plan[0].message.content[0].input.text, '1. do x\n2. do y');

  const entered = codexItemToMessages({ id: 'rv-1', type: 'enteredReviewMode', review: { instructions: 'be strict' } }, 'thread-1');
  assert.equal(entered[0].message.content[0].name, 'EnterReviewMode');

  const compaction = codexItemToMessages({ id: 'cc-1', type: 'contextCompaction' }, 'thread-1');
  assert.equal(compaction[0].message.content[0].name, 'ContextCompaction');

  // An unrecognized future item type still drops silently rather than throwing.
  assert.deepEqual(codexItemToMessages({ id: 'x', type: 'somethingBrandNew' }, 'thread-1'), []);
});

test('thread/tokenUsage/updated stamps a usage-only assistant message the stats pipeline can price', () => {
  const withUsage = codexNotificationToMessages('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    usage: { input_tokens: 100, output_tokens: 40, cached_input_tokens: 10 },
  }, 'thread-1', { model: 'gpt-5-codex' });
  assert.equal(withUsage.length, 1);
  assert.deepEqual(withUsage[0].message.content, []);
  assert.deepEqual(withUsage[0].message.usage, {
    input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 0,
  });

  // Also accepts the camelCase spelling in case that's what the server sends.
  const camel = codexNotificationToMessages('thread/tokenUsage/updated', {
    tokenUsage: { inputTokens: 5, outputTokens: 2 },
  }, 'thread-1');
  assert.equal(camel[0].message.usage.input_tokens, 5);

  assert.deepEqual(codexNotificationToMessages('thread/tokenUsage/updated', {}, 'thread-1'), []);
});
