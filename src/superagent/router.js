// Superagent router, pure half: request builder (whole-request limit and
// deterministic truncation) and output validation. The SDK call is added
// separately; nothing here does I/O. Spec: docs/superpowers/specs/
// 2026-11-03-superagent-design.md, "The router".
import { ROUTER_ACTIONS, ROUTED_REASONS } from './sequencer.js';

export { ROUTER_ACTIONS, ROUTED_REASONS };

export const ROUTER_OVERHEAD_TOKENS = 600;
export const ROUTER_TIMEOUT_MS = 30_000;
export const NOTE_MAX_WORDS = 30;

const TITLE_MAX_CHARS = 200;
const PHASE_SUMMARY_WORDS = 60;
const SHORT_NOTE_WORDS = 8;
const SHORT_SUMMARY_WORDS = 20;
const DECISIONS_KEPT = 5;

export const ROUTER_SYSTEM_PROMPT = [
  'You are the recovery router for an automated multi-phase software job.',
  'Your only job is to choose how to recover a failed or blocked attempt. Never judge the quality of the work itself.',
  '',
  'Actions:',
  '- retry: run the same role again with the same model.',
  '- retry-alternate: run the same role again with its alternate model.',
  '- retry-handoff: run the same role again after reading the failed attempt\'s handoff notes.',
  '- escalate: stop and ask the human; use it when another attempt is unlikely to help.',
  '',
  'The user message is a JSON card. Choose only an action listed in the card\'s "allowed" array.',
  '',
  'Reply with exactly one JSON object and nothing else, no prose and no code fences:',
  '{"action":"<allowed action>","note":"<= 30 words"}',
].join('\n');

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

export function allowedActions({ model, alternate, handoffExists }) {
  const hasAlternate = typeof alternate === 'string' && alternate !== '' && alternate !== model;
  return ROUTER_ACTIONS.filter((a) => {
    if (a === 'retry-alternate') return hasAlternate;
    if (a === 'retry-handoff') return Boolean(handoffExists);
    return true;
  });
}

const words = (text) => String(text ?? '').split(/\s+/).filter(Boolean);
const cutWords = (text, n) => words(text).slice(0, n).join(' ');

function completedPhaseLines(job) {
  const lines = [];
  (job.pipeline ?? []).slice(0, job.phaseIndex ?? 0).forEach((p) => {
    if (p.kind === 'human') return;
    const done = (job.attempts ?? []).filter((a) => a.phase === p.phase && a.outcome === 'done');
    const summary = cutWords(done.at(-1)?.summary ?? '', PHASE_SUMMARY_WORDS);
    lines.push(`${p.phase}: done - ${summary}`);
  });
  return lines;
}

export function buildRouterRequest(job, trigger, { maxInputTokens }) {
  const system = ROUTER_SYSTEM_PROMPT;
  const phases = completedPhaseLines(job);
  const decisions = (job.routerDecisions ?? []).slice(-DECISIONS_KEPT)
    .map((d) => ({ action: d.action, note: cutWords(d.note, NOTE_MAX_WORDS) }));
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
        if (words(d.note).length > SHORT_NOTE_WORDS) {
          d.note = `${cutWords(d.note, SHORT_NOTE_WORDS)}…`;
          record('notes');
        }
      }
    } else if (!summaryDone) {
      summaryDone = true;
      if (typeof current.summary === 'string' && words(current.summary).length > SHORT_SUMMARY_WORDS) {
        current = { ...current, summary: `${cutWords(current.summary, SHORT_SUMMARY_WORDS)} (full result: ${current.resultPath})` };
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

export function validateRouterOutput(text, { allowed, maxOutputTokens, outputTokens }) {
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return { ok: false, error: 'usage-missing' };
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
  if (words(parsed.note).length > NOTE_MAX_WORDS) return { ok: false, error: 'note-too-long' };
  return { ok: true, action: parsed.action, note: parsed.note };
}
