// Grok's plan quota is one weekly pool. The agent exposes it as `_x.ai/billing`
// (the same call `/usage` makes). There is no 5-hour window. The shared
// launcher and stats strip already render `seven_day` and skip a missing
// `five_hour`, so this module only fills the weekly window.
import path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnGrokAgent, killGrokProcess } from './grok-acp.js';
import { accountUsageCache } from './account-usage-cache.js';

export function grokAccountUsageKey() {
  return `grok:${path.resolve(process.env.GROK_HOME || path.join(homedir(), '.grok'))}`;
}

// proto3 omits a zero `creditUsagePercent`. A weekly period with no number
// is 0% used, which is what the Grok CLI's own usage panel shows.
export function grokBillingToPanel(result) {
  const config = result?.config;
  if (!config || typeof config !== 'object') return null;
  const period = config.currentPeriod;
  if (!period || period.type !== 'USAGE_PERIOD_TYPE_WEEKLY') return null;
  const raw = config.creditUsagePercent;
  const utilization = raw == null ? 0 : Number(raw);
  if (!Number.isFinite(utilization)) return null;
  const resetsAt = Date.parse(period.end || config.billingPeriodEnd || '');
  return {
    seven_day: {
      utilization,
      resets_at: Number.isFinite(resetsAt) ? resetsAt : null,
    },
  };
}

export async function readGrokAccountLimits({
  connectImpl = spawnGrokAgent,
  killImpl = killGrokProcess,
  cwd = tmpdir(),
  timeoutMs = 20_000,
} = {}) {
  const connection = connectImpl({ cwd });
  let timer;
  const reading = (async () => {
    await connection.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'prompt-cockpit', version: '0' },
    }, { timeoutMs });
    const result = await connection.client.request('_x.ai/billing', {}, { timeoutMs });
    return grokBillingToPanel(result);
  })();
  // If the timeout wins, rejectAll below rejects this in-flight request.
  // Nothing awaits it by then, so swallow it or it kills the server.
  reading.catch(() => {});
  try {
    return await Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Grok usage lookup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    try { connection.client.rejectAll(new Error('Grok usage lookup closed')); } catch { /* already gone */ }
    try { killImpl(connection.proc); } catch { /* already gone */ }
  }
}

export async function fetchGrokRateLimits({ queryHandle, connectImpl, killImpl, refresh = false } = {}) {
  return accountUsageCache.fetch(grokAccountUsageKey(), async () => {
    if (queryHandle) return queryHandle.grokRateLimits();
    return readGrokAccountLimits({ connectImpl, killImpl });
  }, { refresh });
}
