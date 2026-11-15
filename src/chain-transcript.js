// Chain transcript: the full conversation of a session rendered to readable
// markdown and written to a temp file, so a chained session can read it on
// demand instead of receiving a lossy recap (chain-summary.js, kept as the
// fallback when the file cannot be written). Pure render + a small file
// writer; every provider's history fetcher already normalizes to SDK-shaped
// messages, so this is provider-agnostic.
//
// Kept: user text, assistant text, one line per tool call, tool results
// capped per result. Dropped: thinking, approvals, system events.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRealUserTurn } from './session-history.js';

export const TOOL_RESULT_CAP_CHARS = 2_000;
export const WHOLE_READ_CHARS = 40_000; // up to this the new session can read the whole file
const TOOL_LINE_CHARS = 300;
const TAIL_ENTRY_CHARS = 4_000;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function clip(text, max) {
  const flat = String(text);
  return flat.length > max ? `${flat.slice(0, max - 3)}... [+${flat.length - max + 3} chars]` : flat;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

function userText(message) {
  const content = message.message.content;
  return typeof content === 'string' ? content.trim() : '';
}

// Returns { text, turns }: the markdown file body and the number of user turns.
export function renderChainTranscript(messages, { from = {}, toolResultCap = TOOL_RESULT_CAP_CHARS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const source = [from.providerLabel, from.name ? `session "${from.name}"` : 'session'].filter(Boolean).join(' ');
  const out = [`# Transcript of an earlier ${source}${from.cwd ? ` in ${from.cwd}` : ''}`];
  let turns = 0;
  for (const message of list) {
    const content = message.message && message.message.content;
    if (message.type === 'assistant') {
      if (!Array.isArray(content)) {
        if (typeof content === 'string' && content.trim()) out.push(`**Assistant:** ${content.trim()}`);
        continue;
      }
      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) out.push(`**Assistant:** ${block.text.trim()}`);
        else if (block.type === 'tool_use') {
          let arg = '';
          try { arg = JSON.stringify(block.input); } catch { arg = ''; }
          out.push(`- tool \`${block.name}\` ${clip(arg || '', TOOL_LINE_CHARS)}`);
        }
      }
    } else if (isRealUserTurn(message)) {
      turns += 1;
      out.push(`## Turn ${turns}\n\n**User:** ${userText(message)}`);
    } else if (message.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') out.push(`  - result: ${clip(resultText(block.content), toolResultCap)}`);
      }
    }
  }
  if (turns === 0 && out.length === 1) out.push('[The earlier session had no conversation to carry over.]');
  return { text: out.join('\n\n'), turns };
}

// The last real user message and the last assistant text, each clipped.
function tailOf(messages) {
  let lastUser = null;
  let lastAssistant = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message.type === 'assistant') {
      const content = message.message && message.message.content;
      const texts = Array.isArray(content)
        ? content.filter((b) => b.type === 'text' && b.text && b.text.trim()).map((b) => b.text.trim())
        : typeof content === 'string' && content.trim() ? [content.trim()] : [];
      if (texts.length) lastAssistant = texts.join('\n');
    } else if (isRealUserTurn(message)) lastUser = userText(message);
  }
  return { lastUser, lastAssistant };
}

// The new session's first message: where the transcript is, how to read it
// (whole, or tail + search past WHOLE_READ_CHARS), and the last exchange so
// it can start moving before it has read anything.
export function buildChainHandoff(messages, { from = {}, filePath, chars, turns }) {
  const source = [from.providerLabel, from.name ? `session "${from.name}"` : 'session'].filter(Boolean).join(' ');
  const header = `This session is chained from an earlier ${source}${from.cwd ? ` in ${from.cwd}` : ''}, which could not continue (for example a rate limit). Continue the work from where it stopped.`;
  const how = chars <= WHOLE_READ_CHARS
    ? `The full conversation (${turns} user turns, tool results capped) is in ${filePath} as markdown. It is short enough to read whole: read it first.`
    : `The full conversation (${turns} user turns, ${chars} characters, tool results capped) is in ${filePath} as markdown. It is long: read the end of the file first, then search it for older detail as needed, or hand it to a cheap subagent to answer specific questions.`;
  const { lastUser, lastAssistant } = tailOf(messages);
  const parts = [header, how, 'Thinking and approvals were not saved, and files may have changed since, so re-check before relying on it.'];
  if (lastUser) parts.push(`Last user message:\n${clip(lastUser, TAIL_ENTRY_CHARS)}`);
  if (lastAssistant) parts.push(`Last assistant reply:\n${clip(lastAssistant, TAIL_ENTRY_CHARS)}`);
  return parts.join('\n\n');
}

export function chainTranscriptDir() {
  return path.join(os.tmpdir(), 'prompt-cockpit', 'chain');
}

// Writes the transcript (dir 0700, file 0600: transcripts can hold secrets)
// and prunes files older than a week. Returns the real path, since macOS
// temp folders sit behind symlinks and permission rules match on real paths.
export async function writeChainTranscript(text, { id, dir = chainTranscriptDir(), now = Date.now() } = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const realDir = await fs.realpath(dir);
  const file = path.join(realDir, `${String(id).replace(/[^\w-]/g, '_')}-${now}.md`);
  await fs.writeFile(file, text, { mode: 0o600 });
  try {
    for (const name of await fs.readdir(realDir)) {
      const full = path.join(realDir, name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.isFile() && now - stat.mtimeMs > PRUNE_AFTER_MS) await fs.rm(full, { force: true });
    }
  } catch { /* pruning is best effort */ }
  return { file, dir: realDir };
}
