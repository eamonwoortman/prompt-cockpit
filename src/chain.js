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
  const seed = deps.seedSessionDefaults || seedSessionDefaults;
  if (!row) throw new Error('unknown session');
  if (!row.providerSessionId) throw new Error('session has no conversation yet to chain from');
  const { provider: targetId, subscription } = normalizeChainTarget(target);
  const source = getProvider(row.provider);
  const history = await (deps.fetchHistory || source.fetchHistory)(row.providerSessionId, row.cwd, { subscription: row.subscription });
  const summary = buildChainSummary(history, { from: { providerLabel: source.label, name: row.name, cwd: row.cwd } });
  // Model and effort are the target's own defaults on purpose. The permission
  // mode is the folder's chain setting: 'inherit' copies the source's.
  const choice = row.chainOptions?.permissionMode || 'default';
  const mode = choice === 'inherit' ? (row.mode || 'default') : choice;
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
    await sendInput(created.id, summary);
  } catch (err) {
    registry.closeSession(created.id);
    throw err;
  }
  return { id: created.id, token: created.token, mode };
}

// What server.js hands the registry.
export function chainRunner(row, target) {
  return chainSession(row, target);
}
