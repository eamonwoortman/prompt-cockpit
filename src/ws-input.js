// One parsed client frame on a session's websocket. Moved out of server.js's
// ws.on('message') so the watch-only gate is testable without a socket.
const WATCH_ONLY_TYPES = new Set(['input', 'queue-remove', 'queue-reorder', 'queue-send-now', 'delegate']);

export function handleClientMessage({ id, payload, ws, registry, isWatchOnly, logImpl = console.error }) {
  // A superagent worker is watched, never driven: anything that would reach
  // its input queue is refused out loud rather than dropped.
  if (isWatchOnly(id) && WATCH_ONLY_TYPES.has(payload.type)) {
    ws.send(JSON.stringify({ type: 'cockpit:watch-only', error: 'superagent worker sessions are watch only' }));
    return;
  }
  if (payload.type === 'input' && typeof payload.text === 'string' && payload.text.length > 0) {
    registry.sendInput(id, payload.text).catch((err) => {
      logImpl(`sendInput failed for ${id}:`, err);
    });
  }
  // Queue pane mutations - same ws channel as 'input' rather
  // than a REST round trip: these are live edits to messages already sent
  // down this same socket, so there's no meaningful "queue-remove before
  // the socket that queued it is even open" case to support.
  if (payload.type === 'queue-remove' && typeof payload.queueId === 'string') {
    registry.removeQueued(id, payload.queueId).catch((err) => {
      logImpl(`removeQueued failed for ${id}:`, err);
    });
  }
  if (payload.type === 'queue-reorder' && Array.isArray(payload.queueIds)) {
    registry.reorderQueue(id, payload.queueIds).catch((err) => {
      logImpl(`reorderQueue failed for ${id}:`, err);
    });
  }
  if (payload.type === 'queue-send-now' && typeof payload.queueId === 'string') {
    registry.sendNow(id, payload.queueId).catch((err) => {
      logImpl(`sendNow failed for ${id}:`, err);
    });
  }
  // Cross-session delegation - `/ask <Name>: <text>`
  // parsed client-side (app.js's onSend) into this payload shape. Errors
  // (unknown name, self-delegation, cross-cwd) are synchronous throws
  // from delegateTask - sent straight back on THIS socket (the origin's
  // own), not broadcast, since only the tab that typed the bad command
  // needs to see it.
  if (payload.type === 'delegate' && typeof payload.targetName === 'string' && typeof payload.text === 'string' && payload.text.length > 0) {
    try {
      registry.delegateTask(id, payload.targetName, payload.text);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'cockpit:delegate-error', targetName: payload.targetName, error: String(err.message || err) }));
    }
  }
}
