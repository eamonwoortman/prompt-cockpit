// Durable per-provider usage-cap cooldowns (spec §Usage cap):
// ~/.prompt-cockpit/provider-cooldowns.json, `{ providers: { <provider>: Entry } }`.
//
// Exists because the live signal is too short-lived to schedule against: a
// registry row clears `rateLimitHit` on the very next allowed rate-limit event
// (src/session-registry.js:968-972) and the row itself is reaped when its
// session closes or errors (src/session-registry.js:912), so "this provider is
// capped until X" would otherwise vanish with the session that hit it, or with
// a cockpit restart. A clear keeps the entry (`clearedAt`) so recentlyHit can
// still classify a failure that lands shortly after the cap lifted.
import { homedir } from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './json-store.js';

export const DEFAULT_UNKNOWN_RESET_TTL_MS = 6 * 60 * 60 * 1000;

export function defaultCooldownsPath() {
  return path.join(process.env.COCKPIT_HOME || homedir(), '.prompt-cockpit', 'provider-cooldowns.json');
}

function hydrate(raw) {
  const providers = {};
  const source = raw?.providers;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return providers;
  for (const [name, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object') continue;
    providers[name] = {
      resetsAt: entry.resetsAt ?? null,
      rateLimitType: entry.rateLimitType ?? null,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      clearedAt: entry.clearedAt ?? null,
    };
  }
  return providers;
}

export function createProviderCooldowns({
  filePath = defaultCooldownsPath(),
  now = Date.now,
  unknownResetTtlMs = DEFAULT_UNKNOWN_RESET_TTL_MS,
} = {}) {
  let providers = {};
  let loading = null;
  let tail = Promise.resolve();

  // readJson reports a missing and a corrupt file alike as the fallback, and
  // the next write replaces it: a corrupt cooldown file only loses cooldowns,
  // where refusing to write would stop recording them altogether.
  function load() {
    loading ||= readJson(filePath, null).then((raw) => { providers = hydrate(raw); });
    return loading;
  }

  // Every mutation waits for load() and for the previous mutation's write, so
  // disk state is applied first and writes land in call order.
  function enqueue(mutate) {
    const run = tail.then(load).then(async () => {
      if (mutate() === false) return;
      await writeJsonAtomic(filePath, { providers });
    });
    tail = run.catch(() => {});
    return run;
  }

  function isActive(entry, at) {
    if (entry.clearedAt !== null) return false;
    return entry.resetsAt !== null ? entry.resetsAt > at : entry.lastSeenAt + unknownResetTtlMs > at;
  }

  return {
    filePath,
    load,

    record(provider, { resetsAt = null, rateLimitType = null } = {}) {
      return enqueue(() => {
        const t = now();
        const prev = providers[provider];
        const newEpisode = !prev || prev.clearedAt !== null;
        providers[provider] = {
          resetsAt: resetsAt ?? null,
          rateLimitType: rateLimitType ?? null,
          firstSeenAt: newEpisode ? t : prev.firstSeenAt,
          lastSeenAt: t,
          clearedAt: null,
        };
      });
    },

    clear(provider) {
      return enqueue(() => {
        const entry = providers[provider];
        if (!entry || entry.clearedAt !== null) return false;
        entry.clearedAt = now();
      });
    },

    get(provider) {
      const entry = providers[provider];
      return entry ? { ...entry } : null;
    },

    activeProviders(at = now()) {
      const active = new Set();
      for (const [name, entry] of Object.entries(providers)) {
        if (isActive(entry, at)) active.add(name);
      }
      return active;
    },

    recentlyHit(provider, withinMs, at = now()) {
      const entry = providers[provider];
      return Boolean(entry) && entry.lastSeenAt >= at - withinMs;
    },

    flush() {
      return tail;
    },
  };
}
