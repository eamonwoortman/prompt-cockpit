// Provider descriptors are the boundary between Cockpit's shared session
// lifecycle and a provider's native transport/storage.  Adding a provider
// means adding one descriptor here, rather than teaching every route that
// Claude is the fallback for every non-Grok value.
import { startSession } from './session.js';
import { startGrokSession } from './grok-session.js';
import { listResumableSessions } from './session-launcher.js';
import { listGrokSessions } from './grok-launcher.js';
import { fetchSessionHistory } from './session-history.js';
import { fetchGrokSessionHistory } from './grok-history.js';
import { isGrokAvailable } from './grok-cli.js';
import { startCodexSession } from './codex-session.js';
import { listCodexSessions, fetchCodexSessionHistory } from './codex-history.js';
import { isCodexAvailable } from './codex-app-server.js';
import { forkConversation, rewindFiles as rewindFilesSdk, resolveTurnUuid } from './rewind.js';
import { resolveGrokPromptIndex } from './grok-rewind.js';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    isAvailable: async () => true,
    startSession: startSession,
    listResumableSessions,
    fetchHistory: fetchSessionHistory,
    efforts: CLAUDE_EFFORTS,
    // Moved out of session-registry.js's rewind() (formerly an
    // if (provider === 'grok') {...} else {...this...} branch) so a third
    // conversation-fork-capable provider doesn't fall through to Claude's
    // implementation by default the way Codex almost did.
    rewind: async (row, turnIndex, { dryRun } = {}) => {
      const userMessageId = await resolveTurnUuid(row.providerSessionId, row.cwd, turnIndex);
      let filesResult = null;
      if (row.hasFileCheckpointing) {
        filesResult = await rewindFilesSdk(row.handle.query, userMessageId, { dryRun });
      }
      let fork = null;
      if (!dryRun) {
        fork = await forkConversation(row.providerSessionId, userMessageId);
      }
      return { filesResult, forkedSessionId: fork ? fork.sessionId : null };
    },
    capabilities: Object.freeze({
      fileRewind: true,
      thinkingBudget: true,
      effort: true,
      autoContinue: true,
      mcpToggle: true,
      pluginToggleViaHandle: false,
      pluginToggleViaFile: true,
      conversationFork: true,
      projectPersistentApprovals: true,
    }),
  }),
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok',
    isAvailable: isGrokAvailable,
    startSession: startGrokSession,
    listResumableSessions: listGrokSessions,
    fetchHistory: fetchGrokSessionHistory,
    efforts: GROK_EFFORTS,
    rewind: async (row, turnIndex, { dryRun } = {}) => {
      const points = await row.handle.listRewindPoints();
      const promptIndex = resolveGrokPromptIndex(points, turnIndex);
      if (dryRun) {
        return { filesResult: { conversationOnly: true, promptIndex }, forkedSessionId: null };
      }
      // Conversation-only. Fork first so the original Grok session stays
      // intact, then truncate the copy. Matches Claude's non-destructive
      // rewind: the caller opens forkedSessionId as a new cockpit row.
      const forked = await row.handle.forkAt(promptIndex);
      return {
        filesResult: { conversationOnly: true, promptIndex },
        forkedSessionId: forked.newSessionId,
      };
    },
    capabilities: Object.freeze({
      fileRewind: false,
      thinkingBudget: false,
      effort: true,
      autoContinue: false,
      mcpToggle: true,
      pluginToggleViaHandle: true,
      pluginToggleViaFile: false,
      conversationFork: true,
      // Grok's ACP permission responses have no scope concept beyond the
      // single decision for this request (grok-session.js's resolveApproval
      // ignores decision.alwaysAllow entirely) - "always in this project"
      // can't be honored any more than Codex's session-only grant below.
      projectPersistentApprovals: false,
    }),
  }),
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    isAvailable: isCodexAvailable,
    startSession: startCodexSession,
    listResumableSessions: listCodexSessions,
    fetchHistory: fetchCodexSessionHistory,
    efforts: CODEX_EFFORTS,
    // CODEX_EFFORTS above is the advertised superset (what the launcher
    // shows before a session/model is chosen) - not every model supports
    // every value in it (some don't support 'none'/'minimal', others don't
    // support 'ultra'). Once a live session exists, routes/session-actions.js's
    // effort route calls this instead of trusting the static list, so a
    // choice the current model can't actually honor is rejected immediately
    // rather than accepted here and only failing when the next turn starts.
    // Best-effort: falls back to the static list if the live model catalog
    // can't be fetched (app-server hiccup, unknown model) rather than
    // blocking every effort change on it.
    resolveEfforts: async (row) => {
      try {
        const models = await row.handle.query.supportedModels();
        const entry = row.model
          ? models.find((m) => m.value === row.model || m.resolvedModel === row.model)
          : models[0];
        if (entry?.supportedEfforts?.length) return entry.supportedEfforts;
      } catch {
        // fall through to the static list below
      }
      return CODEX_EFFORTS;
    },
    capabilities: Object.freeze({
      fileRewind: false,
      thinkingBudget: false,
      effort: true,
      autoContinue: false,
      mcpToggle: false,
      pluginToggleViaHandle: false,
      // Codex has no plugin concept at all (query.reloadPlugins() is a
      // stub returning an empty list) - distinct from pluginToggleViaHandle
      // being false, which used to mean "assume Claude's file-based
      // fallback" and would otherwise route a Codex plugin toggle into
      // .claude/settings.local.json, a store that isn't Codex's.
      pluginToggleViaFile: false,
      conversationFork: false,
      // Per the app-server's documented approval-decision shapes (accept/
      // acceptForSession/decline/cancel), there is no project-level grant -
      // only turn-scoped (default) or session-scoped. codex-session.js's
      // resolveApproval already only ever produces 'acceptForSession';
      // this capability is what stops the UI from offering "always in this
      // project" as if it would be honored.
      projectPersistentApprovals: false,
    }),
  }),
});

export class InvalidProviderError extends Error {
  constructor(provider) {
    super(`unknown provider: ${String(provider)}`);
    this.name = 'InvalidProviderError';
    this.code = 'ERR_INVALID_PROVIDER';
  }
}

// Missing provider remains Claude for old clients. Any supplied, unknown
// value is rejected; callers should turn InvalidProviderError into HTTP 400.
export function parseProvider(provider) {
  if (provider === undefined || provider === null) return PROVIDERS.claude;
  if (typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider)) return PROVIDERS[provider];
  throw new InvalidProviderError(provider);
}

export function getProvider(id) {
  return parseProvider(id);
}

export function listProviders() {
  return Object.values(PROVIDERS);
}

export function providerDetails(provider) {
  const descriptor = typeof provider === 'string' ? getProvider(provider) : provider;
  return {
    id: descriptor.id,
    label: descriptor.label,
    capabilities: { ...descriptor.capabilities },
    launch: {
      efforts: [...descriptor.efforts],
    },
  };
}

export async function listAvailableProviders() {
  const checks = await Promise.all(listProviders().map(async (descriptor) => {
    try {
      return [descriptor, await descriptor.isAvailable()];
    } catch {
      return [descriptor, false];
    }
  }));
  return checks.filter(([, available]) => available).map(([descriptor]) => descriptor);
}
