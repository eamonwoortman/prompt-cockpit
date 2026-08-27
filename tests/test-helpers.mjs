// Shared test doubles for session-registry.js and delegation.js's test
// suites (tests/session-registry.test.mjs, tests/delegation.test.mjs) - split
// out so both files exercise the exact same stubbed session handle instead
// of drifting apart via copy-paste.
import { createResultEpochTracker } from '../src/result-epoch.js';

export function fakeWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(JSON.parse(data));
    },
  };
}

// Mimics session.js's startSession() signature/contract without touching
// the SDK: captures the callbacks so a test can drive them directly.
// `rejectModes` mimics the real SDK rejecting setPermissionMode for modes
// that need session-start-only flags (e.g. bypassPermissions needs
// allowDangerouslySkipPermissions) - see the bug this covers below.
// `usageExperimental`, when provided, is a function stood in for the SDK's
// `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` -
// omitted (the default) mimics an SDK build that lacks the method entirely,
// same as `getContextUsage` below it, both of which live under `.query` on
// the real handle (session.js's `{ query: handle, ... }`), not on the
// stubbed handle's own top level.
// `mcpStatus`/`reloadPluginsResult`, when provided, stand in for the real
// SDK responses of the same-named Query methods - omitted (the default)
// still returns a sane empty-ish value rather than throwing, since most
// tests here don't care about MCP/plugin state at all.
// `withMcpAuthPending`, when true, gives the stub's handle a
// getMcpAuthPending() (mirrors session.js's own real one) so
// getMcpServerStatus's authUrl-merge logic has something to merge -
// omitted (the default) mimics grok-session.js's handle, which has no such
// method at all (session-registry.js's typeof guard is what this is for).
export function fakeStartSession({ rejectModes = new Set(), usageExperimental, mcpStatus, reloadPluginsResult, withMcpAuthPending = false } = {}) {
  let callbacks;
  let mode = 'default';
  const resolvers = new Map();
  let mcpAuthPending = [];
  const epochTracker = createResultEpochTracker();
  const impl = (opts) => {
    callbacks = opts;
    impl.lastOpts = opts;
    mode = opts.permissionMode || 'default';
    return {
      ...(withMcpAuthPending ? { getMcpAuthPending: () => mcpAuthPending } : {}),
      pushInput: (text) => {
        // Mirrors session.js's real pushInput now returning `null` (not a
        // queueId) once the queue is closed - see the 2026-08-24 review fix
        // for the pendingResultTags desync this used to cause.
        if (impl.closed) return null;
        impl.lastInput = text;
        impl.allInputs = impl.allInputs || [];
        impl.allInputs.push(text);
        // Mirrors session.js's pushInput now returning a queueId so
        // registry.js's pendingResultTags/removeQueued/reorderQueue/sendNow
        // mirroring logic has something real to key off in tests.
        impl.allQueueIds = impl.allQueueIds || [];
        const queueId = `q-${impl.allQueueIds.length}`;
        impl.allQueueIds.push(queueId);
        epochTracker.push(queueId);
        return queueId;
      },
      close: () => {
        impl.closed = true;
      },
      interrupt: async () => {
        impl.interrupted = (impl.interrupted || 0) + 1;
      },
      // Mirrors session.js's real forceIdle: local bookkeeping reset plus
      // a result-generation bump so a late `result` cannot steal a tag
      // pushed after recovery (result-epoch.js).
      forceIdle: () => {
        impl.forceIdleCalls = (impl.forceIdleCalls || 0) + 1;
        epochTracker.forceIdle();
        callbacks.onStateChange('idle');
      },
      listQueue: () => impl.queue || [],
      removeQueued: (queueId) => {
        impl.lastRemoveQueued = queueId;
        epochTracker.remove(queueId);
        return impl.removeQueuedResult ?? true;
      },
      reorderQueue: (queueIds) => {
        impl.lastReorderQueue = queueIds;
        epochTracker.reorderTail(queueIds);
      },
      sendNow: async (queueId) => {
        impl.lastSendNow = queueId;
        epochTracker.reorderTail([queueId]);
        return impl.sendNowResult ?? true;
      },
      debugSnapshot: () => epochTracker.snapshot(),
      setMode: async (m) => {
        if (rejectModes.has(m)) {
          throw new Error(`Cannot set permission mode to ${m} because the session was not launched with the required flag`);
        }
        mode = m;
        impl.lastSetMode = m;
      },
      getMode: () => mode,
      resolveApproval: (requestId, decision) => {
        const resolve = resolvers.get(requestId);
        if (!resolve) return false;
        resolvers.delete(requestId);
        resolve(decision);
        return true;
      },
      listRewindPoints: async () => impl.rewindPoints || [],
      rewindTo: async (promptIndex) => {
        impl.lastRewindTo = promptIndex;
        return { success: true, target_prompt_index: promptIndex };
      },
      forkAt: async (promptIndex) => {
        impl.lastForkAt = promptIndex;
        return { newSessionId: impl.forkedSessionId || 'grok-fork-1' };
      },
      // Every stubbed Query method the registry calls through `handle.query`,
      // regardless of whether a given test cares about it - mirrors the real
      // handle's `{ query: handle, ... }` shape (session.js) so registry
      // functions that reach through `.query` don't need per-test opt-in.
      query: {
        setModel: async (model) => { impl.lastSetModel = model; },
        setEffort: async (effort) => { impl.lastSetEffort = effort; },
        supportedModels: async () => [],
        setMaxThinkingTokens: async (maxThinkingTokens, thinkingDisplay) => { impl.lastSetMaxThinkingTokens = { maxThinkingTokens, thinkingDisplay }; },
        supportedCommands: async () => [],
        supportedAgents: async () => [],
        mcpServerStatus: async () => mcpStatus || [],
        toggleMcpServer: async (name, enabled) => {
          impl.lastMcpToggle = { name, enabled };
        },
        reconnectMcpServer: async (name) => {
          impl.lastMcpReconnect = name;
        },
        reloadPlugins: async () => reloadPluginsResult || { commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 },
        setPluginEnabled: async (pluginKey, enabled) => {
          impl.lastPluginEnabled = { pluginKey, enabled };
        },
        ...(usageExperimental
          ? { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (...args) => { impl.usageExperimentalCalls = (impl.usageExperimentalCalls || 0) + 1; return usageExperimental(...args); } }
          : {}),
      },
    };
  };
  impl.emitMessage = (msg) => {
    const message = msg && typeof msg === 'object' ? { ...msg } : msg;
    if (message && message.type === 'result') {
      const consumed = epochTracker.consumeFifo();
      epochTracker.applyResultStamp(message, consumed);
    } else if (message) {
      epochTracker.stamp(message);
    }
    callbacks.onMessage(message);
  };
  impl.emitState = (state) => callbacks.onStateChange(state);
  impl.emitError = (err) => callbacks.onError(err);
  // Mirrors session.js's canUseTool routing for ExitPlanMode: registers a
  // pending resolver and fires onApprovalRequest, same as the real thing.
  impl.emitApprovalRequest = (input) => {
    const requestId = `req-${resolvers.size}`;
    const decision = new Promise((resolve) => resolvers.set(requestId, resolve));
    callbacks.onApprovalRequest({ requestId, toolName: 'ExitPlanMode', input, title: 'Exit plan mode?' });
    return decision;
  };
  // Mirrors session.js's onElicitation/elicitation_complete handling
  // (mcpAuthPending Map -> getMcpAuthPending()) without going through a
  // real onElicitation call - same "call the callback directly" shape as
  // emitApprovalRequest above.
  impl.emitMcpAuthRequest = ({ serverName, url, message }) => {
    mcpAuthPending = [...mcpAuthPending.filter((p) => p.name !== serverName), { name: serverName, url, message }];
    callbacks.onMcpAuthRequest?.({ serverName, url, message });
  };
  impl.emitMcpAuthResolved = (serverName) => {
    mcpAuthPending = mcpAuthPending.filter((p) => p.name !== serverName);
    callbacks.onMcpAuthResolved?.(serverName);
  };
  return impl;
}
