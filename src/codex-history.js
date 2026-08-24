import { getCodexAppServerManager } from './codex-app-server.js';
import { codexThreadToMessages } from './codex-messages.js';

function millis(value) {
  if (typeof value !== 'number') return Date.parse(value || '') || 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

export async function listCodexSessions(manager = getCodexAppServerManager()) {
  const result = await manager.request('thread/list', {
    limit: 30,
    sortKey: 'updated_at',
  });
  return (result?.data || []).map((thread) => ({
    sessionId: thread.id,
    cwd: thread.cwd || null,
    projectDirName: thread.cwd || '',
    label: thread.name || thread.preview || null,
    title: thread.name || null,
    mtimeMs: millis(thread.updatedAt || thread.createdAt),
    provider: 'codex',
    // The app-server's documented Thread schema (thread/list and
    // thread/read alike) has no model field - thread.model reads as
    // undefined today. Left in rather than removed in case a future
    // app-server version adds it; null is the honest fallback either way.
    model: thread.model || null,
  }));
}

export async function fetchCodexSessionHistory(threadId, cwd, manager = getCodexAppServerManager()) {
  const result = await manager.request('thread/read', { threadId, includeTurns: true });
  if (!result?.thread) throw new Error(`Codex thread not found: ${threadId}`);
  return codexThreadToMessages(result.thread);
}
