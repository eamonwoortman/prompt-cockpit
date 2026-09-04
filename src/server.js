// HTTP + ws, bound to 127.0.0.1. Origin validation and a per-session token
// are both required from the first commit (see plan Decisions: a websocket
// does not enforce same-origin, so 127.0.0.1 binding alone is not auth).
//
// Route handlers live in src/routes/* (registered on the router below);
// this file keeps only what genuinely has to sit at the top level: the raw
// http server, the Origin/Host spoof check every request goes through
// first, static file fallback, and the websocket upgrade/message wiring
// (tightly coupled to the http server itself, not worth its own module).
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

import * as registry from './session-registry.js';
import { createRouter } from './router.js';
import { registerSessionRoutes, seedSessionDefaults } from './routes/sessions.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerSessionActionRoutes } from './routes/session-actions.js';
import { serveStatic } from './static-files.js';
import { checkOperatorToken, getOperatorToken } from './operator-auth.js';
import { getChildTracker } from './child-tracker.js';
import { createShutdown } from './shutdown.js';
import { registerAutopilotRoutes } from './routes/autopilot.js';
import { createAutopilotStore } from './autopilot-store.js';
import { createAutopilotLog } from './autopilot-log.js';
import { createAutopilot } from './autopilot.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4317;
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// Process ownership for the Grok/Codex CLIs (child-tracker.js). Exported so
// the auto-pilot supervisor can register its heartbeat stop via
// shutdown.onBeforeClose, and so a test can drive teardown directly.
const tracker = getChildTracker();
const shutdown = createShutdown({ registry, tracker });

const autopilotStore = createAutopilotStore();
const autopilotLog = createAutopilotLog();
const autopilot = createAutopilot({ registry, store: autopilotStore, log: autopilotLog, tracker });
const isPilotOwned = (sessionId) => autopilot.status().some((run) => run.sessionId === sessionId);

const router = createRouter();
// ORDER MATTERS: registerSessionRoutes must come before
// registerSessionActionRoutes, whose any('/api/sessions/:id/:action')
// catch-all would otherwise swallow GET /api/sessions/:id/attach-token.
registerSessionRoutes(router, { isPilotOwned });
registerHistoryRoutes(router);
registerSystemRoutes(router);
registerAutopilotRoutes(router, { store: autopilotStore, log: autopilotLog, supervisor: autopilot, registry });
registerSessionActionRoutes(router);

// The heartbeat has to stop before sessions start disappearing, or it sees
// its own runs vanish mid-teardown and records them as terminal outcomes.
shutdown.onBeforeClose(() => autopilot.stop());
// Fix round 1 (I2): the removal listener stays registered through shutdown
// (ruling I6), so each session shutdown.js closes fires a floating
// track(finishRun(...)) write - outcome + spend log - that nothing awaited.
// drain() here, after every session is closed but before the grace/kill pass
// and the final runtime.json flush, is what stops those writes racing
// process.exit().
shutdown.onAfterClose(() => autopilot.drain());

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('request error:', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  });
});

// Only the websocket upgrade checked Origin before this - every plain HTTP
// /api/* route was reachable by any page's cross-origin fetch (a browser
// does not block the request server-side; that's this server's job) with
// nothing but the target session's UUID to guess. Host is checked too and
// required (every HTTP request carries one): Origin alone doesn't survive
// DNS rebinding, where the attacker's own domain is what resolves to
// 127.0.0.1, so the request's Origin is the *page's* origin, not ours -
// but Host would then also read as the attacker's domain, not
// 127.0.0.1:PORT/localhost:PORT, and that's what actually catches it.
// Origin itself is allowed to be absent (curl, direct API use from this
// machine); Host is not.
function isSpoofedRequest(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return true;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return true;
  return false;
}

async function handleRequest(req, res) {
  if (isSpoofedRequest(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  // Operator token is the process credential (see operator-auth.js).
  // Session tokens still gate /api/sessions/:id/*; this is the layer those
  // token-free routes (browse, spawn, history, handshake) were missing.
  // Static files stay Origin/Host only so the shell can load and then
  // send the header (or `?op=` from the console URL).
  if (url.pathname.startsWith('/api/') && !checkOperatorToken(req, url)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'invalid or missing operator token' }));
  }
  const handled = await router.handle(req, res, url);
  if (handled) return;
  return serveStatic(req, res, url);
}

// --- websocket -------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Host, not just Origin - see isSpoofedRequest's comment on why Origin
  // alone doesn't survive DNS rebinding. A missing Origin is rejected here
  // (unlike the plain-HTTP check), since a real browser's ws handshake
  // always sends one.
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!checkOperatorToken(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!id || !registry.checkToken(id, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // Reconnect: a client that already rendered up to some seq sends
  // it back here so attachClient() can send just the delta instead of
  // re-rendering the whole visible transcript. Absent/invalid - including
  // the very first connect, which has nothing to resume from - is a full
  // replay, same as always.
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam && Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : 0;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, id, since);
  });
});

wss.on('connection', (ws, req, id, since) => {
  registry.attachClient(id, ws, since);

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (payload.type === 'input' && typeof payload.text === 'string' && payload.text.length > 0) {
      registry.sendInput(id, payload.text).catch((err) => {
        console.error(`sendInput failed for ${id}:`, err);
      });
    }
    // Queue pane mutations - same ws channel as 'input' rather
    // than a REST round trip: these are live edits to messages already sent
    // down this same socket, so there's no meaningful "queue-remove before
    // the socket that queued it is even open" case to support.
    if (payload.type === 'queue-remove' && typeof payload.queueId === 'string') {
      registry.removeQueued(id, payload.queueId).catch((err) => {
        console.error(`removeQueued failed for ${id}:`, err);
      });
    }
    if (payload.type === 'queue-reorder' && Array.isArray(payload.queueIds)) {
      registry.reorderQueue(id, payload.queueIds).catch((err) => {
        console.error(`reorderQueue failed for ${id}:`, err);
      });
    }
    if (payload.type === 'queue-send-now' && typeof payload.queueId === 'string') {
      registry.sendNow(id, payload.queueId).catch((err) => {
        console.error(`sendNow failed for ${id}:`, err);
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
  });

  ws.on('close', () => {
    registry.detachClient(id, ws);
  });
});

export { server, PORT, HOST, seedSessionDefaults, shutdown, tracker, autopilot };

// Only auto-listen when run directly (`node src/server.js`), not when
// imported by tests - lets tests bind an ephemeral port and drive the same
// Origin/token checks without a second process.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
function copyToClipboard(text) {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'pbcopy' :
    platform === 'win32' ? 'clip' :
    'xclip -selection clipboard';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.stdin.end(text);
  });
}

// Upper bound on the whole teardown. Without one, Ctrl-C has no worst case a
// user can rely on: today it is bounded but unpleasant (tracker.settled()'s
// probe timeout plus the grace period), and it becomes unbounded the moment
// the auto-pilot supervisor registers a shutdown.onBeforeClose hook that can
// hang. Comfortably above grace (3s) + killTracked's verify budget (1.5s).
const FORCE_EXIT_MS = 8000;

if (isMain) {
  let exiting = false;

  // Exits once, through shutdown(), whichever route got us here.
  async function exitVia(reason) {
    // A second Ctrl-C is an escape hatch, not a no-op. shutdown.run() is
    // idempotent, so joining the first teardown changes nothing when that
    // teardown is the thing that is wedged. Raw mode is already off by then,
    // so the terminal survives this path too.
    if (exiting) {
      console.error('second interrupt - exiting now. Any CLI still running has to be killed by hand.');
      process.exit(1);
    }
    exiting = true;

    // Leaving the terminal in raw mode makes the shell unusable afterwards -
    // and this has to happen BEFORE the await, not after, or a slow teardown
    // leaves the user with a dead prompt for seconds. pause() is inside the
    // try with setRawMode: a throw from it used to escape exitVia entirely,
    // which on the signal paths below became an unhandled rejection - and in
    // Node 20 that terminates the process without running the teardown, on
    // the one path that must never fail.
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch { /* not a TTY any more */ }
    }

    // .unref() so the watchdog alone never holds the process open: if the
    // event loop empties first we exit anyway, which is the same outcome.
    const watchdog = setTimeout(() => {
      console.error(`teardown did not finish within ${FORCE_EXIT_MS}ms - exiting anyway. Check for surviving CLI processes.`);
      process.exit(1);
    }, FORCE_EXIT_MS);
    watchdog.unref();

    let failed = false;
    try {
      await shutdown.run(reason);
    } catch (err) {
      failed = true;
      console.error(`shutdown failed: ${String(err?.message || err)}`);
    }
    clearTimeout(watchdog);
    // Non-zero on a failed teardown, so a wrapper script can tell the
    // difference instead of reading every clean exit into a broken one.
    process.exit(failed ? 1 : 0);
  }

  // Every fire-and-forget exit route goes through this rather than calling
  // exitVia() bare. A rejection escaping exitVia would otherwise be an
  // unhandled rejection, and Node 20 terminates the process on those WITHOUT
  // finishing the teardown - the exact failure this whole path exists to
  // prevent. Exit anyway, non-zero, so a wrapper script can tell a broken
  // teardown from a clean one.
  function exitNow(reason) {
    exitVia(reason).catch((err) => {
      console.error(`shutdown failed hard: ${String(err?.message || err)}`);
      process.exit(1);
    });
  }

  // SIGTERM is not meaningfully deliverable on Windows; SIGBREAK is the
  // closer analogue (Ctrl+Break, and what a console-window close sends).
  // SIGINT is still registered because setRawMode(true) below only suppresses
  // OS SIGINT delivery while stdin IS a TTY - piped/service invocations get
  // the real signal.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => { exitNow(signal); });
  }

  server.listen(PORT, HOST, () => {
    // Anything still in runtime.json belongs to a cockpit process that died
    // without running shutdown(). Reaping AFTER listen() succeeds is what
    // makes a second `npm start` on the same port harmless: it dies on
    // EADDRINUSE before it can touch another instance's PIDs, rather than
    // relying on the crash beating the kill by a second. (Entries owned by a
    // cockpit that is still alive are skipped regardless - see child-tracker.)
    // Fix round 1 (cheap item 2): chained rather than fired in parallel with
    // autopilot.start() below. orphanPilotIds() (blockingReason's
    // precondition 4) returns an empty set until reapOrphans() resolves, and
    // each entry costs a real 200-800ms probe on Windows - so after an
    // unclean exit with several unverifiable pids, a pilot could fire while
    // its own orphan was still billing, reliably only because the first
    // heartbeat happened to be 15s away. Error logging unchanged either way.
    tracker.reapOrphans()
      .catch((err) => console.error(`orphan reap failed: ${String(err?.message || err)}`))
      .finally(() => {
        // Pilots live and die with this process, by design (spec Non-goals).
        // Not started when imported by tests - a 15-second interval would
        // keep the test runner's event loop alive.
        autopilot.start();
      });

    const op = getOperatorToken();
    const url = `http://${HOST}:${PORT}/?op=${op}`;
    console.log(`prompt-cockpit listening on ${url}`);

    if (process.stdin.isTTY) {
      console.log('Press c to copy the URL to clipboard.');
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', (str, key) => {
        // With raw mode on, this is the only Ctrl-C the process ever sees.
        if (key && key.ctrl && key.name === 'c') {
          exitNow('keypress-ctrl-c');
          return;
        }
        if (str === 'c') {
          copyToClipboard(url)
            .then(() => console.log('Copied!'))
            .catch((err) => console.error(`Could not copy to clipboard: ${err.message}`));
        }
      });
    }
  });
}
