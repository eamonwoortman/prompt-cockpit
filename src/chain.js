// Chain: continue one session's work in a new session on another provider or
// account, in the same folder, by sending a text summary of the conversation
// as the new session's first message (chain-summary.js). The source session
// is left open and idle. Wired into the registry via setChainRunner() so the
// registry doesn't import this module back (see session-registry.js).
import * as registry from './session-registry.js';
import { buildChainSummary } from './chain-summary.js';
import { getProvider, parseProvider, resolveProviderSubscription } from './provider-registry.js';
import { seedSessionDefaults } from './routes/sessions.js';

export const RATE_LIMIT_ACTIONS = ['none', 'wait', 'ask', 'chain'];

// Validates a { provider, subscription? } target from a request body or the
// persisted per-folder setting. Throws on an unknown provider/account.
// Returns the normalized target stored on the row.
export function normalizeChainTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('chain target required');
  const provider = parseProvider(target.provider);
  const account = resolveProviderSubscription(provider, target.subscription || undefined);
  return { provider: provider.id, subscription: account ? account.id : null };
}

export async function chainSession(id, target, deps = {}) {
  const getRow = deps.get || registry.get;
  const createSession = deps.createSession || registry.createSession;
  const sendInput = deps.sendInput || registry.sendInput;
  const seed = deps.seedSessionDefaults || seedSessionDefaults;
  const row = getRow(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  if (!row.providerSessionId) throw new Error('session has no conversation yet to chain from');
  const { provider: targetId, subscription } = normalizeChainTarget(target);
  const source = getProvider(row.provider);
  const history = await (deps.fetchHistory || source.fetchHistory)(row.providerSessionId, row.cwd, { subscription: row.subscription });
  const summary = buildChainSummary(history, { from: { providerLabel: source.label, name: row.name, cwd: row.cwd } });
  const created = createSession({
    cwd: row.cwd,
    provider: targetId,
    subscription: subscription || undefined,
    // Model and effort are the target's own defaults on purpose, and the
    // permission mode starts at default (never copies bypassPermissions).
    permissionMode: 'default',
    chainedFrom: { id: row.id, name: row.name, providerLabel: source.label },
  });
  try {
    await seed(created);
    await sendInput(created.id, summary);
  } catch (err) {
    registry.closeSession(created.id);
    throw err;
  }
  return { id: created.id, token: created.token };
}

// What server.js hands the registry.
export function chainRunner(id, target) {
  return chainSession(id, target);
}
