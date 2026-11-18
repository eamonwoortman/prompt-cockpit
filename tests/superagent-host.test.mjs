import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSuperagentHost, HOST_STOP_DEADLINE_MS } from '../src/superagent-host.js';
import { wireSuperagent } from '../src/superagent-wiring.js';
import { createSuperagentConfig } from '../src/superagent/config.js';
import { tempDir } from './superagent-helpers.mjs';

process.env.COCKPIT_HOME = await tempDir('sa-host-home-');
process.env.CLAUDE_CONFIG_DIR = await tempDir('sa-host-claude-');

const registry = { name: 'registry' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeLock(calls, acquire = async () => ({ owned: true })) {
  return {
    acquire: () => { calls.push('acquire'); return acquire(); },
    release: async () => { calls.push('release'); },
  };
}

function fakeSupervisor(calls, over = {}) {
  return {
    start: async () => { calls.push('start'); },
    stop: () => { calls.push('stop'); return Promise.resolve(); },
    drain: async () => { calls.push('drain'); },
    dispose: () => { calls.push('dispose'); },
    ownsSession: (id) => id === 'worker-1',
    listJobs: () => [],
    ...over,
  };
}

function makeHost({ calls = [], lock, config, store = { name: 'store' }, router = null, supervisor, logged = [], ...over } = {}) {
  const seen = {};
  const sup = supervisor ?? fakeSupervisor(calls);
  const host = createSuperagentHost({
    registry,
    port: 4317,
    lockFactory: () => lock ?? fakeLock(calls),
    configFactory: () => config ?? { load: async () => { calls.push('load'); }, resolve: () => ({}) },
    storeFactory: () => { calls.push('store'); return store; },
    routerFactory: async () => { calls.push('router'); return router; },
    superagentFactory: (deps) => { calls.push('build'); seen.deps = deps; return sup; },
    logImpl: (m) => logged.push(String(m)),
    ...over,
  });
  return { host, calls, seen, supervisor: sup, logged };
}

async function assertUnavailable(promise, { state, status, ownerPort = null }) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'ERR_SUPERAGENT_UNAVAILABLE');
    assert.equal(err.state, state);
    assert.equal(err.status, status);
    assert.equal(err.ownerPort, ownerPort);
    return true;
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a constructed host is off and refuses everything', async () => {
  const { host, calls } = makeHost();
  assert.deepEqual(host.status(), { state: 'off', ownerPort: null, error: null, router: null });
  await assertUnavailable(host.admit(() => 1), { state: 'off', status: 503 });
  assert.equal(host.read(() => 1), null);
  assert.equal(host.ownsSession('worker-1'), false);
  assert.deepEqual(host.notifications(), []);
  assert.equal(host.notificationsReady(), false);
  assert.deepEqual(calls, []);
});

test('init loads config before building the supervisor', async () => {
  const root = await tempDir('sa-host-config-');
  const filePath = path.join(root, 'config.json');
  await createSuperagentConfig({ filePath }).save({ defaults: { maxConcurrentSessions: 7 } });
  const calls = [];
  const real = createSuperagentConfig({ filePath });
  const config = { ...real, load: async () => { calls.push('load'); await real.load(); } };
  const { host, seen } = makeHost({ calls, config });
  await host.init();
  assert.deepEqual(calls, ['acquire', 'load', 'store', 'router', 'build', 'start']);
  assert.equal(seen.deps.config.resolve(null).maxConcurrentSessions, 7);
  assert.equal(seen.deps.registry, registry);
  assert.deepEqual(seen.deps.store, { name: 'store' });
  assert.equal(host.status().state, 'ready');
  assert.equal(host.ownsSession('worker-1'), true);
  assert.equal(host.ownsSession('other'), false);
});

test('a corrupt config leaves the superagent in error and the rest untouched', async () => {
  const root = await tempDir('sa-host-corrupt-');
  const filePath = path.join(root, 'config.json');
  await fs.writeFile(filePath, '{ not json');
  const calls = [];
  const { host, logged } = makeHost({ calls, config: createSuperagentConfig({ filePath }) });
  await host.init();
  const status = host.status();
  assert.equal(status.state, 'error');
  assert.ok(status.error.includes(filePath), status.error);
  assert.equal(status.router, null);
  await assertUnavailable(host.admit(() => 1), { state: 'error', status: 503 });
  assert.equal(host.read(() => 1), null);
  assert.deepEqual(calls, ['acquire', 'release']);
  assert.match(logged.join('\n'), /superagent init failed/);
});

test('not owner when another Cockpit holds the lock', async () => {
  const calls = [];
  const lock = fakeLock(calls, async () => ({ owned: false, owner: { pid: 9, port: 4400 } }));
  const { host } = makeHost({ calls, lock });
  await host.init();
  assert.deepEqual(host.status(), { state: 'not-owner', ownerPort: 4400, error: null, router: null });
  await assertUnavailable(host.admit(() => 1), { state: 'not-owner', status: 409, ownerPort: 4400 });
  assert.deepEqual(calls, ['acquire']);
  assert.deepEqual(host.notifications(), []);
  assert.equal(host.notificationsReady(), false);
});

test('not owner with an unknown owner reports no port', async () => {
  for (const result of [{ owned: false, owner: null }, { owned: false, owner: null, corrupt: true }]) {
    const calls = [];
    const { host } = makeHost({ calls, lock: fakeLock(calls, async () => result) });
    await host.init();
    assert.equal(host.status().state, 'not-owner');
    assert.equal(host.status().ownerPort, null);
    await assertUnavailable(host.admit(() => 1), { state: 'not-owner', status: 409 });
  }
});

test('a lock acquire that rejects is an init error', async () => {
  const calls = [];
  const lock = fakeLock(calls, async () => { throw Object.assign(new Error('link not supported'), { code: 'EPERM' }); });
  const { host } = makeHost({ calls, lock });
  await host.init();
  assert.equal(host.status().state, 'error');
  assert.match(host.status().error, /link not supported/);
  assert.ok(!calls.includes('load'));
});

test('router on only with an apiKeyHelper', async () => {
  const off = makeHost({ router: null });
  await off.host.init();
  assert.equal(off.seen.deps.router, null);
  assert.equal(off.host.status().router, 'off');

  const router = { decide: async () => ({}) };
  const on = makeHost({ router });
  await on.host.init();
  assert.equal(on.seen.deps.router, router);
  assert.equal(on.host.status().router, 'on');
});

test('the default router factory is off without an apiKeyHelper and logs why', async () => {
  const logged = [];
  const { host, seen } = makeHost({ logged, routerFactory: undefined });
  await host.init();
  assert.equal(seen.deps.router, null);
  assert.equal(host.status().router, 'off');
  assert.ok(logged.includes('superagent router off: no apiKeyHelper in ~/.claude/settings.json'), logged.join('\n'));
});

test('actions are refused while initialising and admitted once ready', async () => {
  const calls = [];
  const acquired = deferred();
  const { host, supervisor } = makeHost({ calls, lock: fakeLock(calls, () => acquired.promise) });
  const init = host.init();
  assert.equal(host.status().state, 'initialising');
  assert.equal(host.status().router, null);
  await assertUnavailable(host.admit(() => 1), { state: 'initialising', status: 503 });
  acquired.resolve({ owned: true });
  await init;
  assert.equal(host.status().state, 'ready');
  let got = null;
  assert.equal(await host.admit((s) => { got = s; return 'done'; }), 'done');
  assert.equal(got, supervisor);
  assert.equal(host.read((s) => s === supervisor), true);
});

test('read and notifications use the supervisor once it exists', async () => {
  const job = { jobId: 'j1', title: 'Add hello', state: 'needs-you', reason: 'ready-to-try', needsYouSeq: 4 };
  const calls = [];
  const { host } = makeHost({ calls, supervisor: fakeSupervisor(calls, { listJobs: () => [job] }) });
  await host.init();
  assert.deepEqual(host.read((s) => s.listJobs()), [job]);
  assert.deepEqual(host.notifications(), [{
    kind: 'superagent', type: 'ready-to-try', key: 'superagent:j1:4', jobId: 'j1', title: 'Add hello', message: '"Add hello" is ready to try',
  }]);
});

test('notifications are ready only once start() has resolved, and through stopping', async () => {
  const calls = [];
  const acquired = deferred();
  const startGate = deferred();
  const supervisor = fakeSupervisor(calls, { start: () => { calls.push('start'); return startGate.promise; } });
  const { host } = makeHost({ calls, supervisor, lock: fakeLock(calls, () => acquired.promise) });
  const init = host.init();
  assert.equal(host.status().state, 'initialising');
  assert.equal(host.notificationsReady(), false, 'initialising');
  acquired.resolve({ owned: true });
  await tick();
  assert.equal(calls.at(-1), 'start');
  assert.equal(host.notificationsReady(), false, 'start() pending');
  startGate.resolve();
  await init;
  assert.equal(host.status().state, 'ready');
  assert.equal(host.notificationsReady(), true, 'ready');
  await host.stop();
  assert.equal(host.status().state, 'stopping');
  assert.equal(host.notificationsReady(), true, 'stopping with every job loaded');
  await host.afterClose();
  assert.equal(host.notificationsReady(), false, 'stopped');
});

test('a stop while start() is pending keeps notifications ready once it resolves', async () => {
  const calls = [];
  const startGate = deferred();
  const supervisor = fakeSupervisor(calls, { start: () => { calls.push('start'); return startGate.promise; } });
  const { host } = makeHost({ calls, supervisor });
  const init = host.init();
  await tick();
  assert.equal(calls.at(-1), 'start');
  const stopped = host.stop();
  assert.equal(host.notificationsReady(), false, 'stopping before start() resolved');
  startGate.resolve();
  await init;
  await stopped;
  assert.equal(host.status().state, 'stopping');
  assert.equal(host.notificationsReady(), true);
  await host.afterClose();
});

test('stop blocks new launches at once and waits for admitted actions', async () => {
  const calls = [];
  const { host } = makeHost({ calls });
  await host.init();
  const held = deferred();
  const action = host.admit(() => held.promise);
  calls.length = 0;
  let stopped = false;
  const stopping = host.stop().then(() => { stopped = true; });
  assert.deepEqual(calls, ['stop'], 'supervisor.stop is called synchronously');
  assert.equal(host.status().state, 'stopping');
  await assertUnavailable(host.admit(() => 1), { state: 'stopping', status: 503 });
  assert.equal(host.read(() => 'still readable'), 'still readable');
  await tick();
  assert.equal(stopped, false, 'stop waits for the admitted action');
  held.resolve('ok');
  assert.equal(await action, 'ok');
  await stopping;
  assert.equal(stopped, true);
});

test('stop waits for an admitted action that rejects without failing', async () => {
  const { host } = makeHost();
  await host.init();
  const action = host.admit(async () => { throw new Error('boom'); });
  await assert.rejects(action, /boom/);
  await host.stop();
});

test('stop is bounded', async () => {
  assert.equal(HOST_STOP_DEADLINE_MS, 2500);
  const calls = [];
  const never = new Promise(() => {});
  const supervisor = fakeSupervisor(calls, { stop: () => { calls.push('stop'); return never; } });
  const { host, logged } = makeHost({ calls, supervisor, stopDeadlineMs: 50 });
  await host.init();
  host.admit(() => never);
  const started = Date.now();
  await host.stop();
  assert.ok(Date.now() - started < 1000, `stop took ${Date.now() - started}ms`);
  assert.ok(logged.includes('superagent stop did not settle within 50ms - closing sessions anyway'), logged.join('\n'));
  await host.afterClose();
  assert.equal(calls.at(-1), 'release');
  assert.equal(host.status().state, 'stopped');
});

test('stop and afterClose share one deadline', async () => {
  const calls = [];
  const never = () => new Promise(() => {});
  const supervisor = fakeSupervisor(calls, {
    stop: () => { calls.push('stop'); return never(); },
    drain: () => { calls.push('drain'); return never(); },
  });
  const { host, logged } = makeHost({ calls, supervisor, stopDeadlineMs: 400 });
  await host.init();
  calls.length = 0;
  const started = Date.now();
  await host.stop();
  await host.afterClose();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, `stop + afterClose took ${elapsed}ms, more than one deadline`);
  assert.deepEqual(calls, ['stop', 'drain', 'dispose', 'release']);
  assert.match(logged.join('\n'), /superagent drain did not settle/);
  assert.equal(host.status().state, 'stopped');
});

test('a fast stop leaves the drain the rest of the deadline', async () => {
  const calls = [];
  const supervisor = fakeSupervisor(calls, {
    drain: () => {
      calls.push('drain');
      return new Promise((resolve) => { setTimeout(() => { calls.push('drained'); resolve(); }, 50); });
    },
  });
  const { host, logged } = makeHost({ calls, supervisor, stopDeadlineMs: 2000 });
  await host.init();
  await host.stop();
  calls.length = 0;
  await host.afterClose();
  assert.deepEqual(calls, ['drain', 'drained', 'dispose', 'release']);
  assert.deepEqual(logged, []);
});

test('afterClose without stop starts the deadline itself', async () => {
  const calls = [];
  const supervisor = fakeSupervisor(calls, { drain: () => { calls.push('drain'); return new Promise(() => {}); } });
  const { host } = makeHost({ calls, supervisor, stopDeadlineMs: 50 });
  await host.init();
  calls.length = 0;
  const started = Date.now();
  await host.afterClose();
  assert.ok(Date.now() - started < 1000, `afterClose took ${Date.now() - started}ms`);
  assert.deepEqual(calls, ['drain', 'dispose', 'release']);
});

test('a supervisor that fails to start is stopped within the deadline, disposed and silenced', async () => {
  const calls = [];
  const stopGate = deferred();
  const job = { jobId: 'j1', title: 'Add hello', state: 'needs-you', reason: 'ready-to-try', needsYouSeq: 1 };
  const supervisor = fakeSupervisor(calls, {
    start: async () => { calls.push('start'); throw new Error('start blew up'); },
    stop: () => { calls.push('stop'); return stopGate.promise; },
    listJobs: () => [job],
  });
  const { host } = makeHost({ calls, supervisor, stopDeadlineMs: 2000 });
  const init = host.init();
  await tick();
  assert.equal(host.status().state, 'error');
  assert.match(host.status().error, /start blew up/);
  assert.deepEqual(host.notifications(), [], 'no bell entries for a host in error');
  assert.equal(host.notificationsReady(), false);
  assert.equal(host.ownsSession('worker-1'), true, 'worker rows stay watch-only until the supervisor is disposed');
  stopGate.resolve();
  await init;
  assert.deepEqual(calls.slice(-4), ['start', 'stop', 'dispose', 'release']);
  assert.equal(host.ownsSession('worker-1'), false);
});

test('a failed start whose stop never settles still releases the lock', async () => {
  const calls = [];
  const supervisor = fakeSupervisor(calls, {
    start: async () => { throw new Error('start blew up'); },
    stop: () => { calls.push('stop'); return new Promise(() => {}); },
  });
  const { host, logged } = makeHost({ calls, supervisor, stopDeadlineMs: 50 });
  const started = Date.now();
  await host.init();
  assert.ok(Date.now() - started < 1000, `init took ${Date.now() - started}ms`);
  assert.deepEqual(calls.slice(-3), ['stop', 'dispose', 'release']);
  assert.match(logged.join('\n'), /superagent stop did not settle within 50ms/);
  assert.equal(host.status().state, 'error');
});

test('afterClose bounds a drain that never settles', async () => {
  const calls = [];
  const supervisor = fakeSupervisor(calls, { drain: () => { calls.push('drain'); return new Promise(() => {}); } });
  const { host } = makeHost({ calls, supervisor, stopDeadlineMs: 50 });
  await host.init();
  await host.stop();
  calls.length = 0;
  const started = Date.now();
  await host.afterClose();
  assert.ok(Date.now() - started < 1000, `afterClose took ${Date.now() - started}ms`);
  assert.deepEqual(calls, ['drain', 'dispose', 'release']);
});

test('shutdown during initialisation never starts the supervisor', async () => {
  for (const pendingAt of ['acquire', 'load', 'router']) {
    const calls = [];
    const gate = deferred();
    const lock = fakeLock(calls, pendingAt === 'acquire' ? () => gate.promise : async () => ({ owned: true }));
    const config = { load: () => { calls.push('load'); return pendingAt === 'load' ? gate.promise : Promise.resolve(); }, resolve: () => ({}) };
    const routerFactory = () => { calls.push('router'); return pendingAt === 'router' ? gate.promise : Promise.resolve(null); };
    const { host } = makeHost({ calls, lock, config, routerFactory });
    const init = host.init();
    await tick();
    assert.equal(calls.at(-1), pendingAt, pendingAt);
    await host.stop();
    assert.equal(host.status().state, 'stopping', pendingAt);
    gate.resolve(pendingAt === 'acquire' ? { owned: true } : null);
    await init;
    assert.ok(!calls.includes('build'), `${pendingAt}: no supervisor built`);
    assert.ok(!calls.includes('start'), `${pendingAt}: no supervisor started`);
    assert.equal(host.status().state, 'stopping', pendingAt);
    assert.equal(host.notificationsReady(), false, pendingAt);
    await host.afterClose();
    assert.equal(host.status().state, 'stopped', pendingAt);
    assert.equal(calls.at(-1), 'release', `${pendingAt}: lock released`);
    assert.equal(host.read(() => 1), null);
  }
});

test('afterClose waits for a pending acquire before releasing', async () => {
  const calls = [];
  const gate = deferred();
  const { host } = makeHost({ calls, lock: fakeLock(calls, () => gate.promise) });
  host.init();
  await host.stop();
  const closing = host.afterClose();
  await tick();
  assert.ok(!calls.includes('release'));
  gate.resolve({ owned: true });
  await closing;
  assert.deepEqual(calls, ['acquire', 'release']);
});

test('stop before init leaves nothing to start', async () => {
  const { host, calls } = makeHost();
  await host.stop();
  await host.init();
  await host.afterClose();
  assert.deepEqual(calls, []);
  assert.equal(host.status().state, 'stopped');
});

test('an init error after stop does not overwrite stopping', async () => {
  const calls = [];
  const gate = deferred();
  const config = { load: () => { calls.push('load'); return gate.promise; }, resolve: () => ({}) };
  const { host, logged } = makeHost({ calls, config });
  const init = host.init();
  await tick();
  await host.stop();
  gate.reject(Object.assign(new Error('config.json is not a valid superagent config'), { code: 'ERR_CONFIG_CORRUPT' }));
  await init;
  assert.equal(host.status().state, 'stopping');
  assert.equal(host.status().error, null);
  assert.match(logged.join('\n'), /not a valid superagent config/);
  await host.afterClose();
  assert.equal(host.status().state, 'stopped');
  assert.equal(calls.at(-1), 'release');
});

test('afterClose drains, disposes, then releases', async () => {
  const calls = [];
  const { host } = makeHost({ calls });
  await host.init();
  await host.stop();
  calls.length = 0;
  await host.afterClose();
  assert.deepEqual(calls, ['drain', 'dispose', 'release']);
  assert.equal(host.status().state, 'stopped');
  await assertUnavailable(host.admit(() => 1), { state: 'stopped', status: 503 });
});

test('default factories build the real lock, config, store and supervisor under root', async () => {
  const root = path.join(await tempDir('sa-host-root-'), 'nested', 'superagent');
  let interceptors = 0;
  const realRegistry = {
    addSessionRemovedListener: () => {},
    addApprovalInterceptor: () => { interceptors += 1; return () => { interceptors -= 1; }; },
  };
  const host = createSuperagentHost({ registry: realRegistry, port: 4555, root, routerFactory: async () => null, logImpl: () => {} });
  await host.init();
  assert.equal(host.status().state, 'ready', host.status().error);
  const lock = JSON.parse(await fs.readFile(path.join(root, 'owner.lock'), 'utf8'));
  assert.equal(lock.port, 4555);
  assert.equal(lock.pid, process.pid);
  assert.deepEqual(host.read((s) => s.listJobs()), []);
  assert.equal(interceptors, 1);

  const second = createSuperagentHost({ registry: realRegistry, port: 4556, root, routerFactory: async () => null, logImpl: () => {} });
  await second.init();
  assert.equal(second.status().state, 'not-owner');
  assert.equal(second.status().ownerPort, 4555);

  await host.stop();
  await host.afterClose();
  assert.equal(interceptors, 0);
  await assert.rejects(fs.access(path.join(root, 'owner.lock')), { code: 'ENOENT' });
});

function fakeShutdownHooks(calls) {
  const before = [];
  const after = [];
  return {
    before,
    after,
    onBeforeClose: (fn) => { calls.push('onBeforeClose'); before.push(fn); },
    onAfterClose: (fn) => { calls.push('onAfterClose'); after.push(fn); },
  };
}

test('wireSuperagent registers both hooks before init', async () => {
  const calls = [];
  const shutdown = fakeShutdownHooks(calls);
  const host = {
    init: async () => { calls.push('init'); },
    stop: async () => { calls.push('stop'); },
    afterClose: async () => { calls.push('afterClose'); },
  };
  await wireSuperagent({ shutdown, host });
  assert.deepEqual(calls, ['onBeforeClose', 'onAfterClose', 'init']);
  await shutdown.before[0]();
  await shutdown.after[0]();
  assert.deepEqual(calls.slice(3), ['stop', 'afterClose']);
});

test('wireSuperagent logs an init failure rather than throwing', async () => {
  const calls = [];
  const logged = [];
  const shutdown = fakeShutdownHooks(calls);
  const host = { init: async () => { throw new Error('init blew up'); }, stop: async () => {}, afterClose: async () => {} };
  await wireSuperagent({ shutdown, host, logImpl: (m) => logged.push(String(m)) });
  assert.match(logged.join('\n'), /init blew up/);
});

test('the default supervisor reads global workflows from the host root', async () => {
  const realRegistry = await import('../src/session-registry.js');
  const root = await tempDir('sa-host-root-');
  const feature = JSON.parse(await fs.readFile(new URL('../workflows/feature.json', import.meta.url), 'utf8'));
  const file = path.join(root, 'workflows', 'host-global.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...feature, id: 'host-global', name: 'Host global' }));
  const calls = [];
  const host = createSuperagentHost({
    registry: realRegistry,
    port: 4317,
    root,
    lockFactory: () => fakeLock(calls),
    routerFactory: async () => null,
    logImpl: () => {},
  });
  try {
    await host.init();
    assert.equal(host.status().state, 'ready', host.status().error);
    const { workflows } = await host.admit((sa) => sa.listWorkflows(null));
    const entry = workflows.find((w) => w.id === 'host-global');
    assert.deepEqual([entry?.source, entry?.file, entry?.valid], ['global', file, true]);
  } finally {
    await host.stop();
    await host.afterClose();
    realRegistry._reset();
  }
});
