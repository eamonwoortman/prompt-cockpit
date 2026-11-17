// The single seam between Cockpit and the superagent supervisor. Routes, the
// notification route and the watch-only checks hold this host, never the
// supervisor, so "not owner", "starting", "config corrupt" and "stopping" are
// answered in one place.
//
// off -> initialising -> ready | not-owner | error; then stopping -> stopped.
// init() checks stopRequested after every await, so a shutdown during boot
// never builds or starts a supervisor. stop() is bounded so shutdown can go on
// to close sessions; the lock is kept until afterClose().
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createOwnerLock } from './superagent/owner-lock.js';
import { createSuperagentConfig, defaultSuperagentRoot } from './superagent/config.js';
import { createSuperagentStore } from './superagent/store.js';
import { createSuperagent } from './superagent/index.js';
import { createRouter, readUserApiKeyHelper } from './superagent/router.js';
import { superagentNotifications } from './superagent/notifications.js';

export const HOST_STOP_DEADLINE_MS = 2500;

const TIMED_OUT = Symbol('timed out');
const messageOf = (err) => String(err?.message || err);

export function createSuperagentHost({
  registry,
  port,
  root = defaultSuperagentRoot(),
  lockFactory,
  configFactory,
  storeFactory,
  superagentFactory,
  routerFactory,
  stopDeadlineMs = HOST_STOP_DEADLINE_MS,
  logImpl = console.error,
}) {
  lockFactory ??= () => {
    const lock = createOwnerLock({ file: path.join(root, 'owner.lock'), port, logImpl });
    return {
      acquire: async () => {
        await mkdir(root, { recursive: true });
        return lock.acquire();
      },
      release: lock.release,
    };
  };
  configFactory ??= () => createSuperagentConfig({ filePath: path.join(root, 'config.json') });
  storeFactory ??= () => createSuperagentStore({ rootDir: path.join(root, 'jobs'), logImpl });
  superagentFactory ??= (deps) => createSuperagent({ ...deps, worktreesRoot: path.join(root, 'worktrees'), logImpl });
  routerFactory ??= async () => {
    if (await readUserApiKeyHelper()) return createRouter({ cwd: path.join(root, 'router') });
    logImpl('superagent router off: no apiKeyHelper in ~/.claude/settings.json');
    return null;
  };

  let state = 'off';
  let ownerPort = null;
  let error = null;
  let router = null;
  let lock = null;
  let supervisor = null;
  let disposed = false;
  let stopRequested = false;
  let shutdownDeadline = null;
  let initializing = null;
  let stopping = null;
  let closing = null;
  const admitted = new Set();

  function log(message) {
    try {
      logImpl(message);
    } catch { /* logging must never break shutdown */ }
  }

  async function within(promise, ms) {
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, ms, TIMED_OUT); });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // stop() and afterClose() share one budget, started by whichever runs first.
  function shutdownRemaining() {
    shutdownDeadline ??= Date.now() + stopDeadlineMs;
    return Math.max(0, shutdownDeadline - Date.now());
  }

  function stopSupervisor() {
    let stopped;
    try {
      stopped = Promise.resolve(supervisor.stop());
    } catch (err) {
      stopped = Promise.reject(err);
    }
    return stopped.catch((err) => log(`superagent stop failed: ${messageOf(err)}`));
  }

  function disposeSupervisor() {
    disposed = true;
    try {
      supervisor.dispose();
    } catch (err) {
      log(`superagent dispose failed: ${messageOf(err)}`);
    }
  }

  function unavailable() {
    const message = state === 'not-owner'
      ? `superagent is running in the Cockpit on port ${ownerPort ?? 'unknown'}`
      : `superagent is ${state}${error ? `: ${error}` : ''}`;
    return Object.assign(new Error(message), {
      code: 'ERR_SUPERAGENT_UNAVAILABLE',
      state,
      ownerPort,
      status: state === 'not-owner' ? 409 : 503,
    });
  }

  async function boot() {
    if (stopRequested) return;
    state = 'initialising';
    try {
      lock = lockFactory();
      const claim = await lock.acquire();
      if (stopRequested) return;
      if (!claim.owned) {
        state = 'not-owner';
        ownerPort = claim.owner?.port ?? null;
        return;
      }
      const config = configFactory();
      await config.load();
      if (stopRequested) return;
      const store = storeFactory();
      const chosen = await routerFactory();
      if (stopRequested) return;
      router = chosen != null ? 'on' : 'off';
      supervisor = superagentFactory({ registry, store, config, router: chosen });
      if (stopRequested) return;
      await supervisor.start();
      if (stopRequested) return;
      state = 'ready';
    } catch (err) {
      if (stopRequested) {
        log(`superagent init failed after stop: ${messageOf(err)}`);
        return;
      }
      state = 'error';
      error = messageOf(err);
      log(`superagent init failed: ${error}`);
      if (supervisor) {
        if (await within(stopSupervisor(), stopDeadlineMs) === TIMED_OUT) {
          log(`superagent stop did not settle within ${stopDeadlineMs}ms - releasing the lock anyway`);
        }
        disposeSupervisor();
      }
      await lock?.release();
    }
  }

  function init() {
    initializing ??= boot();
    return initializing;
  }

  function admit(fn) {
    if (state !== 'ready') return Promise.reject(unavailable());
    const action = (async () => fn(supervisor))();
    const forget = () => { admitted.delete(action); };
    admitted.add(action);
    action.then(forget, forget);
    return action;
  }

  function read(fn) {
    return supervisor && (state === 'ready' || state === 'stopping') ? fn(supervisor) : null;
  }

  async function settleStop() {
    const budget = shutdownRemaining();
    const supervisorStopped = supervisor && !disposed ? stopSupervisor() : null;
    const settled = Promise.allSettled([...admitted, supervisorStopped]);
    if (await within(settled, budget) === TIMED_OUT) {
      log(`superagent stop did not settle within ${stopDeadlineMs}ms - closing sessions anyway`);
    }
  }

  function stop() {
    if (!stopping) {
      stopRequested = true;
      state = 'stopping';
      stopping = settleStop();
    }
    return stopping;
  }

  async function close() {
    stopRequested = true;
    if (state !== 'stopped') state = 'stopping';
    if (initializing && await within(initializing, shutdownRemaining()) === TIMED_OUT) {
      log(`superagent init did not settle within ${stopDeadlineMs}ms - releasing the lock anyway`);
    }
    if (supervisor && !disposed) {
      const drained = Promise.resolve().then(() => supervisor.drain())
        .catch((err) => log(`superagent drain failed: ${messageOf(err)}`));
      if (await within(drained, shutdownRemaining()) === TIMED_OUT) log(`superagent drain did not settle within ${stopDeadlineMs}ms`);
      disposeSupervisor();
    }
    await lock?.release();
    state = 'stopped';
  }

  function afterClose() {
    closing ??= close();
    return closing;
  }

  return {
    status: () => ({ state, ownerPort, error, router }),
    init,
    stop,
    afterClose,
    admit,
    read,
    ownsSession: (id) => (supervisor && !disposed ? supervisor.ownsSession(id) : false),
    notifications: () => (supervisor && state !== 'error' ? superagentNotifications(supervisor.listJobs()) : []),
  };
}
