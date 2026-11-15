// Pure helpers for chain-on-rate-limit: the per-folder policy shape, which
// account a hop goes to next, and recognizing a rate-limit message from a
// provider that has no structured rate-limit event (Grok, Codex).
import { PERMISSION_MODES } from './permissions.js';
import { DEFAULT_AWAY_MINUTES } from './presence.js';

export const RATE_LIMIT_ACTIONS = ['none', 'wait', 'ask', 'chain'];
export const CHAIN_PERMISSION_CHOICES = ['inherit', ...PERMISSION_MODES];
export const MAX_CHAIN_LIST = 12;

export const DEFAULT_CHAIN_OPTIONS = Object.freeze({
  askWhenPresent: true, // automatic chaining waits for you to leave; while you are here it only offers
  awayMinutes: DEFAULT_AWAY_MINUTES,
  permissionMode: 'default', // for chained sessions: 'inherit' (the source's mode) or a mode name
});

export function targetKey(target) {
  return `${target.provider}::${target.subscription || ''}`;
}

export function ownTarget(row) {
  return { provider: row.provider, subscription: row.subscription || null };
}

// Fixed order, forward only. A session that is on the list continues with
// the entries after its own place; one that is not on it starts from the top.
// `visited` (every account earlier in this chain of sessions) is never
// reused, so an account is used at most once however the chain was started.
export function nextTargets(list, own, visited = []) {
  const used = new Set([...visited, targetKey(own)]);
  const at = list.findIndex((t) => targetKey(t) === targetKey(own));
  return list.slice(at + 1).filter((t) => !used.has(targetKey(t)));
}

export function normalizeChainOptions(input = {}) {
  const out = { ...DEFAULT_CHAIN_OPTIONS };
  if (typeof input.askWhenPresent === 'boolean') out.askWhenPresent = input.askWhenPresent;
  if (input.awayMinutes != null) {
    const minutes = Number(input.awayMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error('awayMinutes must be between 1 and 1440');
    out.awayMinutes = Math.round(minutes);
  }
  if (input.permissionMode != null) {
    if (!CHAIN_PERMISSION_CHOICES.includes(input.permissionMode)) throw new Error(`invalid permissionMode: ${input.permissionMode}`);
    out.permissionMode = input.permissionMode;
  }
  return out;
}

// Providers without a structured rate-limit event (Grok, Codex) only surface
// the failure as error text. The wording is unverified against the real
// CLIs, so this is deliberately a list of plain phrases, and callers keep the
// raw text in the chain log so it can be tightened after a real hit.
const LIMIT_PHRASES = /usage limit|rate[ -]?limit|quota (?:exceeded|reached|exhausted)|too many requests|limit (?:reached|exceeded)|(?:credits|tokens) (?:exhausted|depleted)|\b429\b/i;

export function looksLikeRateLimit(text) {
  return typeof text === 'string' && LIMIT_PHRASES.test(text);
}

// Codex reports the cause structurally (TurnError.codexErrorInfo, from its
// generated app-server schema). The account-level ones count; a context
// window overflow or a per-session budget does not, since another account
// would not help.
const LIMIT_ERROR_CODES = new Set(['usageLimitExceeded', 'rateLimitExceeded']);

export function isRateLimitFailure({ code, text } = {}) {
  if (typeof code === 'string' && LIMIT_ERROR_CODES.has(code)) return true;
  return looksLikeRateLimit(text);
}
