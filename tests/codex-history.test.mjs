import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCodexSessionHistory, listCodexSessions } from '../src/codex-history.js';

test('Codex thread listing maps app-server metadata to resumable sessions', async () => {
  const calls = [];
  const manager = {
    async request(method, params) {
      calls.push([method, params]);
      // Real Thread summaries from thread/list don't carry a model field
      // (developers.openai.com/codex/app-server's Thread schema has none) -
      // fabricating one here would hide listCodexSessions() actually
      // dropping it, which the resumable-list UI needs to tolerate.
      return { data: [{
        id: 'thread-1', cwd: '/repo', name: 'Refactor', preview: 'fallback',
        updatedAt: 1_700_000_000,
      }] };
    },
  };
  const sessions = await listCodexSessions(manager);
  assert.equal(calls[0][0], 'thread/list');
  assert.deepEqual(sessions[0], {
    sessionId: 'thread-1', cwd: '/repo', projectDirName: '/repo',
    label: 'Refactor', title: 'Refactor', mtimeMs: 1_700_000_000_000,
    provider: 'codex', model: null,
  });
});

test('Codex history reads full turns without starting or resuming a thread', async () => {
  let call;
  const manager = {
    async request(method, params) {
      call = [method, params];
      // Same as above - the real Thread response from thread/read has no
      // model field either.
      return { thread: {
        id: 'thread-1', turns: [{
          status: 'completed',
          items: [{ type: 'agentMessage', text: 'saved answer' }],
        }],
      } };
    },
  };
  const messages = await fetchCodexSessionHistory('thread-1', '/ignored', manager);
  assert.deepEqual(call, ['thread/read', { threadId: 'thread-1', includeTurns: true }]);
  assert.equal(messages[0].message.content[0].text, 'saved answer');
  assert.equal(messages[0].message.model, undefined);
});
