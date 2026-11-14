// Builds the "chain summary": a plain-text recap of one session's
// conversation, sent as the first message of a new session on another
// provider/account that continues the work. Pure (messages in, string out)
// so it is unit-testable and provider-agnostic - every provider's history
// fetcher already normalizes to SDK-shaped messages
// ({ type: 'user'|'assistant', message: { content } }).
//
// Deliberately lossy: thinking, tool results, tool state and pending
// approvals do not survive a chain. Text is kept whole where the budget
// allows; tool calls shrink to one line each (name + the most telling arg).
import { isRealUserTurn } from './session-history.js';

export const DEFAULT_BUDGET_CHARS = 32_000;
const MAX_ENTRY_CHARS = 4_000; // one runaway message must not eat the whole budget
const MAX_TOOL_LINE_CHARS = 200;

function clip(text, max) {
  const flat = String(text);
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

// The one argument that best says what a tool call did, across providers'
// differing tool vocabularies. Falls back to the first short string value.
function toolArgSummary(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    if (typeof input[key] === 'string' && input[key]) return input[key].replace(/\s+/g, ' ').trim();
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function assistantEntry(message) {
  const content = message.message && message.message.content;
  if (!Array.isArray(content)) {
    return typeof content === 'string' && content.trim() ? `Assistant: ${clip(content.trim(), MAX_ENTRY_CHARS)}` : null;
  }
  const texts = [];
  const tools = [];
  for (const block of content) {
    if (block.type === 'text' && block.text && block.text.trim()) texts.push(block.text.trim());
    else if (block.type === 'tool_use') {
      const arg = toolArgSummary(block.input);
      tools.push(`  - ${clip(arg ? `${block.name}: ${arg}` : block.name, MAX_TOOL_LINE_CHARS)}`);
    }
  }
  if (!texts.length && !tools.length) return null;
  const lines = [];
  if (texts.length) lines.push(`Assistant: ${clip(texts.join('\n'), MAX_ENTRY_CHARS)}`);
  else lines.push('Assistant (tool calls only):');
  lines.push(...tools);
  return lines.join('\n');
}

// Turns the transcript into ordered entries, merging back-to-back assistant
// messages (a Grok reply arrives as many chunks) into one.
function toEntries(messages) {
  const entries = [];
  let pendingAssistant = [];
  const flush = () => {
    if (!pendingAssistant.length) return;
    const texts = [];
    const tools = [];
    for (const message of pendingAssistant) {
      const entry = assistantEntry(message);
      if (!entry) continue;
      const [first, ...rest] = entry.split('\n');
      if (first.startsWith('Assistant: ')) texts.push(first.slice('Assistant: '.length));
      tools.push(...rest.filter((line) => line.startsWith('  - ')));
    }
    pendingAssistant = [];
    if (!texts.length && !tools.length) return;
    const body = texts.length ? `Assistant: ${clip(texts.join('\n'), MAX_ENTRY_CHARS)}` : 'Assistant (tool calls only):';
    entries.push([body, ...tools].join('\n'));
  };
  for (const message of messages) {
    if (message.type === 'assistant') {
      pendingAssistant.push(message);
    } else if (isRealUserTurn(message)) {
      flush();
      entries.push(`User: ${clip(message.message.content.trim(), MAX_ENTRY_CHARS)}`);
    }
    // anything else (tool_result user messages, system, result) is dropped
  }
  flush();
  return entries;
}

// `from` describes the source session for the header: { providerLabel, name, cwd }.
export function buildChainSummary(messages, { from = {}, budgetChars = DEFAULT_BUDGET_CHARS } = {}) {
  const entries = toEntries(Array.isArray(messages) ? messages : []);
  // Newest-first fill: the recent turns matter most, so the oldest are what
  // get dropped. The newest entry always goes in even if it alone is huge.
  const kept = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const cost = entries[i].length + 2;
    if (kept.length > 0 && used + cost > budgetChars) break;
    kept.unshift(entries[i]);
    used += cost;
  }
  const omitted = entries.length - kept.length;
  const source = [from.providerLabel, from.name ? `session "${from.name}"` : 'session'].filter(Boolean).join(' ');
  const header = [
    `This session is chained from an earlier ${source}${from.cwd ? ` in ${from.cwd}` : ''}, which could not continue (for example a rate limit).`,
    'Below is a text recap of that conversation. Tool results, thinking and approvals were not carried over, so re-check files before relying on them.',
    'Continue the work from where it stopped.',
  ].join(' ');
  const parts = [header];
  if (omitted > 0) parts.push(`[${omitted} earlier message${omitted === 1 ? '' : 's'} omitted to fit]`);
  if (kept.length) parts.push(kept.join('\n\n'));
  else parts.push('[The earlier session had no conversation to carry over.]');
  return parts.join('\n\n');
}
