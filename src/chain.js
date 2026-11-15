// Chain: continue one session's work in a new session on another provider or
// account, in the same folder, by sending a text summary of the conversation
// as the new session's first message (chain-summary.js). The source session
// is left open and idle. Wired into the registry via setChainRunner() so the
// registry doesn't import this module back (see session-registry.js).
import * as registry from './session-registry.js';
import { buildChainSummary } from './chain-summary.js';
import { getProvider, parseProvider, resolveProviderSubscription } from './provider-registry.js';
import { seedSessionDefaults } from './routes/sessions.js';
import { targetKey, ownTarget, RATE_LIMIT_ACTIONS } from './chain-policy.js';

export { RATE_LIMIT_ACTIONS };

// Validates a { provider, subscription? } target from a request body or the
// persisted per-folder setting. Throws on an unknown provider/account.
// Returns the normalized target stored on the row.
export function normalizeChainTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('chain target required');
  const provider = parseProvider(target.provider);
  const account = resolveProviderSubscription(provider, target.subscription || undefined);
  return { provider: provider.id, subscription: account ? account.id : null };
}

export function normalizeChainList(list) {
  if (!Array.isArray(list)) throw new Error('chainList must be an array');
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const target = normalizeChainTarget(entry);
    if (seen.has(targetKey(target))) continue; // an account appears once: it is only ever used once
    seen.add(targetKey(target));
    out.push(target);
  }
  return out;
}

// `row` is the live registry row (an object, not an id, so a session that has
// just died on its limit can still be chained from).
export async function chainSession(row, target, deps = {}) {
  const createSession = deps.createSession || registry.createSession;
  const sendInput = deps.sendInput || registry.sendInput;
  const setPermissionMode = deps.setPermissionMode || registry.setPermissionMode;
  const seed = deps.seedSessionDefaults || seedSessionDefaults;
  if (!row) throw new Error('unknown session');
  if (!row.providerSessionId) throw new Error('session has no conversation yet to chain from');
  const { provider: targetId, subscription } = normalizeChainTarget(target);
  const source = getProvider(row.provider);
  const history = await (deps.fetchHistory || source.fetchHistory)(row.providerSessionId, row.cwd, { subscription: row.subscription });
  const summary = buildChainSummary(history, { from: { providerLabel: source.label, name: row.name, cwd: row.cwd } });
  // Model and effort are the target's own defaults on purpose. The permission
  // mode is the folder's chain setting: 'inherit' copies the source's. A
  // source in auto mode always hands auto on, whatever the setting says.
  const choice = row.chainOptions?.permissionMode || 'default';
  const mode = row.mode === 'auto' ? 'auto' : choice === 'inherit' ? (row.mode || 'default') : choice;
  const created = createSession({
    cwd: row.cwd,
    provider: targetId,
    subscription: subscription || undefined,
    permissionMode: mode,
    // Every account used so far, so no hop can ever return to one.
    chainedFrom: {
      id: row.id,
      name: row.name,
      providerLabel: source.label,
      visited: [...(row.chainedFrom?.visited || []), targetKey(ownTarget(row))],
    },
  });
  try {
    await seed(created);
    // Apply the mode through the live provider control path too: launch-time
    // options alone do not confirm that the initialized session accepted it.
    // Wait for the provider's init first: Claude reports its own mode there
    // and would overwrite one set while it was still starting up.
    await (deps.awaitInit || awaitInit)(created.id);
    await setPermissionMode(created.id, mode);
    await sendInput(created.id, summary);
    // sendInput only queues the turn: a bad login or failed startup shows up
    // afterwards, so wait for the session to be running (or to die).
    await (deps.confirmStart || confirmStart)(created.id);
  } catch (err) {
    registry.closeSession(created.id);
    throw err;
  }
  return { id: created.id, token: created.token, mode };
}

// Resolves once the row has left 'starting' (the provider's init arrived).
// An unknown row or a slow init just resolves; a dead row rejects.
export async function awaitInit(id, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = registry.get(id);
    if (!live || live.state !== 'starting') {
      if (live && (live.state === 'error' || live.state === 'closed')) throw new Error('the new session failed to start');
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Resolves once the new row is running its first turn; rejects if the row
// errors out or vanishes first. A start that is merely slow (no verdict by
// the timeout) counts as started, rather than killing a healthy session.
export async function confirmStart(id, { timeoutMs = 20_000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = registry.get(id);
    if (!live || live.state === 'error' || live.state === 'closed') throw new Error('the new session failed to start');
    if (live.state === 'running') return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// What server.js hands the registry.
export function chainRunner(row, target) {
  return chainSession(row, target);
}
