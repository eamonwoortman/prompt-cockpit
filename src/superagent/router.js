// Superagent router: request builder (whole-request limit and deterministic
// truncation), output validation, and the isolated single-turn SDK call
// (createRouter). Spec: docs/superpowers/specs/2026-11-03-superagent-design.md,
// "The router"; isolation options and auth route: spike S4b.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ROUTER_ACTIONS, ROUTED_REASONS, hasAlternate } from './sequencer.js';
import { defaultSuperagentRoot } from './config.js';

export { ROUTER_ACTIONS, ROUTED_REASONS };

export const ROUTER_OVERHEAD_TOKENS = 600;
export const ROUTER_TIMEOUT_MS = 30_000;
export const NOTE_MAX_WORDS = 30;
export const NOTE_MAX_CHARS = 300;
// Haiku 5.5 thinks whatever the options say (probe 2026-11-05: 117-194
// thinking tokens per call), and thinking counts as output. maxOutputTokens
// limits the answer; the CLI's hard generation cap leaves this much on top.
export const ROUTER_THINKING_ALLOWANCE = 1000;

const TITLE_MAX_CHARS = 200;
const PHASE_SUMMARY_WORDS = 60;
const PHASE_SUMMARY_CHARS = 400;
const DECISION_NOTE_CHARS = 200;
const SHORT_NOTE_WORDS = 8;
const SHORT_NOTE_CHARS = 60;
const SHORT_SUMMARY_WORDS = 20;
const SHORT_SUMMARY_CHARS = 150;
const DECISIONS_KEPT = 5;

export const ROUTER_SYSTEM_PROMPT = [
  'You are the recovery router for an automated multi-phase software job.',
  'Your only job is to choose how to recover a failed or blocked attempt. Never judge the quality of the work itself.',
  '',
  'Actions:',
  '- retry: run the role again on its default model.',
  '- retry-alternate: run it on its alternate model.',
  '- retry-handoff: run the same role again after reading the failed attempt\'s handoff notes.',
  '- escalate: stop and ask the human; use it when another attempt is unlikely to help.',
  '',
  'The user message is a JSON card. Choose only an action listed in the card\'s "allowed" array.',
  'In the card, the trigger\'s model is the model of the attempt that just failed.',
  '',
  'Reply with exactly one JSON object and nothing else, no prose and no code fences:',
  '{"action":"<allowed action>","note":"<= 30 words"}',
].join('\n');

// ASCII code points cost 1 token per 3; every non-ASCII code point (a surrogate pair counts once) costs 2.
// The old UTF-8 bytes / 3 counted a CJK character as 1, under the probe's measured ~1.18.
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + 2 * other;
}

export function allowedActions({ model, alternate, handoffExists }) {
  return ROUTER_ACTIONS.filter((a) => {
    if (a === 'retry-alternate') return hasAlternate(model, alternate);
    if (a === 'retry-handoff') return Boolean(handoffExists);
    return true;
  });
}

const words = (text) => String(text ?? '').split(/\s+/).filter(Boolean);
// Characters are code points, so a cut never splits a surrogate pair.
const chars = (text) => [...String(text ?? '')];
const overChars = (text, max) => chars(text).length > max;
const clipChars = (text, max) => `${chars(text).slice(0, max - 1).join('')}…`;
// Word cut, then a character cap for space-free text; the result is at most
// maxChars characters and ends in '…' when the character cap cut it.
const cutWords = (text, n, maxChars) => {
  const out = words(text).slice(0, n).join(' ');
  return overChars(out, maxChars) ? clipChars(out, maxChars) : out;
};
const isWordOrCharOver = (text, n, maxChars) => words(text).length > n || overChars(text, maxChars);
// The shortened forms always end in '…'.
const shorten = (text, n, maxChars) => {
  const out = words(text).slice(0, n).join(' ');
  return overChars(out, maxChars - 1) ? clipChars(out, maxChars) : `${out}…`;
};

function completedPhaseLines(job) {
  const lines = [];
  (job.pipeline ?? []).slice(0, job.phaseIndex ?? 0).forEach((p) => {
    if (p.kind === 'human') return;
    const done = (job.attempts ?? []).filter((a) => a.phase === p.phase && a.outcome === 'done');
    const summary = cutWords(done.at(-1)?.summary ?? '', PHASE_SUMMARY_WORDS, PHASE_SUMMARY_CHARS);
    lines.push(`${p.phase}: done - ${summary}`);
  });
  return lines;
}

export function buildRouterRequest(job, trigger, { maxInputTokens }) {
  const system = ROUTER_SYSTEM_PROMPT;
  const phases = completedPhaseLines(job);
  const decisions = (job.routerDecisions ?? []).slice(-DECISIONS_KEPT)
    .map((d) => ({ action: d.action, note: cutWords(d.note, NOTE_MAX_WORDS, DECISION_NOTE_CHARS) }));
  let current = trigger;
  const truncated = [];

  const render = () => JSON.stringify({
    job: { title: String(job.title ?? '').slice(0, TITLE_MAX_CHARS), mode: job.mode, phase: job.phaseId ?? job.pipeline?.[job.phaseIndex]?.phase ?? null },
    phases,
    decisions,
    trigger: current,
    allowed: trigger.allowed,
  }, null, 1);
  const size = (card) => ROUTER_OVERHEAD_TOKENS + estimateTokens(system) + estimateTokens(card);
  const record = (name) => { if (!truncated.includes(name)) truncated.push(name); };

  let card = render();
  let notesDone = false;
  let summaryDone = false;
  while (size(card) > maxInputTokens) {
    if (phases.length > 0) {
      phases.shift();
      record('phases');
    } else if (!notesDone) {
      notesDone = true;
      for (const d of decisions) {
        if (isWordOrCharOver(d.note, SHORT_NOTE_WORDS, SHORT_NOTE_CHARS)) {
          d.note = shorten(d.note, SHORT_NOTE_WORDS, SHORT_NOTE_CHARS);
          record('notes');
        }
      }
    } else if (!summaryDone) {
      summaryDone = true;
      if (typeof current.summary === 'string' && isWordOrCharOver(current.summary, SHORT_SUMMARY_WORDS, SHORT_SUMMARY_CHARS)) {
        const summary = cutWords(current.summary, SHORT_SUMMARY_WORDS, SHORT_SUMMARY_CHARS);
        current = { ...current, summary: `${summary} (full result: ${current.resultPath})` };
        record('summary');
      }
    } else {
      return { ok: false, error: 'over-limit', estimatedTokens: size(card), truncated };
    }
    card = render();
  }
  return { ok: true, system, card, estimatedTokens: size(card), truncated };
}

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;
const BAD_MAX_OUTPUT = 'bad-limit: maxOutputTokens';

// `outputTokens` is the answer's size: output less thinking (see decide).
export function validateRouterOutput(text, { allowed, maxOutputTokens, outputTokens }) {
  if (!isPositiveInt(maxOutputTokens)) return { ok: false, error: BAD_MAX_OUTPUT };
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0) return { ok: false, error: 'usage-missing' };
  if (outputTokens > maxOutputTokens) return { ok: false, error: 'over-length' };
  let body = String(text ?? '').trim();
  const fenced = FENCE.exec(body);
  if (fenced) body = fenced[1].trim();
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { ok: false, error: 'unparseable' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'bad-shape' };
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('action') || !keys.includes('note')
    || typeof parsed.action !== 'string' || typeof parsed.note !== 'string') return { ok: false, error: 'bad-shape' };
  if (!allowed.includes(parsed.action)) return { ok: false, error: 'action-not-allowed' };
  if (words(parsed.note).length > NOTE_MAX_WORDS || overChars(parsed.note, NOTE_MAX_CHARS)) return { ok: false, error: 'note-too-long' };
  return { ok: true, action: parsed.action, note: parsed.note };
}

// `settingSources: []` drops the user's apiKeyHelper, so the router hands that
// one key back inline (S4b). Read only; never throws.
export async function readUserApiKeyHelper({
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  readFileImpl = fs.readFile,
} = {}) {
  try {
    const settings = JSON.parse(await readFileImpl(path.join(configDir, 'settings.json'), 'utf8'));
    return typeof settings?.apiKeyHelper === 'string' ? settings.apiKeyHelper : null;
  } catch {
    return null;
  }
}

const ISOLATION_LISTS = ['tools', 'mcp_servers', 'plugins'];

// An init without one of the lists cannot show isolation, so it is a breach.
function isolationLeaks(init) {
  const missing = ISOLATION_LISTS.find((field) => !Array.isArray(init[field]));
  if (missing) return [`${missing} missing`];
  return [
    ...init.tools.map((t) => `tool ${t}`),
    ...init.mcp_servers.map((s) => `mcp server ${s?.name}`),
    ...init.plugins.filter((p) => p?.path !== 'builtin').map((p) => `plugin ${p?.source ?? p?.name}`),
  ];
}

// Spend is modelUsage[model] (what is billed; probe 2026-11-05: it folds in a
// hidden ~2,951-in / 21-out request). The router's own request is result.usage
// (sdk.d.ts: main agent loop only), which the pre-send estimate is compared with.
// A missing modelUsage[model] (no spend for the served model) returns null.
function usageFrom(result, model) {
  const u = result.modelUsage?.[model];
  if (!u) return null;
  const r = result.usage;
  const num = (n) => (typeof n === 'number' ? n : 0);
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
    totalInputTokens: (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
    costUsd: u.costUSD ?? null,
    requestInputTokens: typeof r?.input_tokens === 'number'
      ? r.input_tokens + num(r.cache_read_input_tokens) + num(r.cache_creation_input_tokens)
      : null,
    requestOutputTokens: r?.output_tokens ?? null,
    thinkingTokens: r ? (r.output_tokens_details?.thinking_tokens ?? 0) : null,
  };
}

// The answer's size: the router request's output less its thinking. NaN when
// it cannot be shown, which validateRouterOutput reports as usage-missing.
function answerTokens(result) {
  const output = result.usage?.output_tokens;
  const thinking = result.usage?.output_tokens_details?.thinking_tokens ?? 0;
  if (typeof output !== 'number' || typeof thinking !== 'number') return NaN;
  const answer = output - thinking;
  return Number.isFinite(answer) && answer >= 0 ? answer : NaN;
}

function resultError(result) {
  const detail = [...(result.errors ?? []), result.result].filter((s) => typeof s === 'string' && s !== '').join('; ');
  if (result.subtype === 'success') return detail || 'error result';
  return detail ? `${result.subtype}: ${detail}` : result.subtype;
}

export function createRouter({
  queryImpl = query,
  cwd = path.join(defaultSuperagentRoot(), 'router'),
  apiKeyHelper = readUserApiKeyHelper,
  timeoutMs = ROUTER_TIMEOUT_MS,
  now = Date.now,
  mkdirImpl = fs.mkdir,
  baseEnv = process.env,
  thinkingAllowance = ROUTER_THINKING_ALLOWANCE,
} = {}) {
  if (!Number.isInteger(thinkingAllowance) || thinkingAllowance < 0) {
    throw new TypeError(`superagent router: thinkingAllowance must be a non-negative integer, got ${String(thinkingAllowance)}`);
  }

  async function decide({ model, allowlist, system, card, allowed, maxOutputTokens, signal }) {
    const started = now();
    let usage = null;
    let apiKeySource = null;
    const settle = (o) => (o.ok
      ? { ok: true, action: o.action, note: o.note, usage, latencyMs: now() - started, apiKeySource }
      : { ok: false, error: o.error, usage, latencyMs: now() - started, apiKeySource });
    if (!Array.isArray(allowlist) || !allowlist.includes(model)) return settle({ ok: false, error: `model-not-allowed: ${model}` });
    if (!isPositiveInt(maxOutputTokens)) return settle({ ok: false, error: BAD_MAX_OUTPUT });
    if (signal?.aborted) return settle({ ok: false, error: 'aborted' });

    const controller = new AbortController();
    let q = null;
    let timer;
    let onAbort;
    const stopped = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
      onAbort = () => { controller.abort(); resolve({ ok: false, error: 'aborted' }); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    const call = async () => {
      await mkdirImpl(cwd, { recursive: true });
      const helper = await apiKeyHelper();
      if (controller.signal.aborted) return { ok: false, error: 'aborted' };
      q = queryImpl({
        prompt: card,
        options: {
          model, maxTurns: 1, tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
          systemPrompt: system,
          settings: { autoMemoryEnabled: false, ...(helper ? { apiKeyHelper: helper } : {}) },
          persistSession: false, thinking: { type: 'disabled' }, cwd, abortController: controller,
          // A hard API max (probe 2026-11-05): over it the call fails. It
          // bounds answer plus thinking; the answer itself is checked below.
          env: { ...baseEnv, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens + thinkingAllowance) },
        },
      });
      let text = '';
      let result = null;
      let sawInit = false;
      const breach = (what) => {
        controller.abort();
        return { ok: false, error: `isolation-breach: ${what}` };
      };
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          sawInit = true;
          apiKeySource = m.apiKeySource ?? null;
          const leaks = isolationLeaks(m);
          if (leaks.length > 0) return breach(leaks.join(', '));
        } else if (m.type === 'assistant') {
          for (const b of m.message?.content ?? []) if (b.type === 'text') text += b.text;
        } else if (m.type === 'result') {
          if (!sawInit) return breach('no init');
          result = m;
          break;
        }
      }
      if (!result) return { ok: false, error: 'no-result' };
      usage = usageFrom(result, model);
      if (result.subtype !== 'success' || result.is_error) return { ok: false, error: resultError(result) };
      if (!usage) return { ok: false, error: 'usage-missing' };
      return validateRouterOutput(text, { allowed, maxOutputTokens, outputTokens: answerTokens(result) });
    };

    try {
      const failed = (err) => ({ ok: false, error: err?.message || String(err) });
      return settle(await Promise.race([call().catch(failed), stopped]));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { q?.close?.(); } catch { /* best effort */ }
    }
  }

  return { decide };
}
