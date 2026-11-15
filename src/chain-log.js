// Append-only record of what chaining did, one JSON object per line in the
// project's .claude/cockpit-chain-log.jsonl, so the morning after an
// unattended run there is a plain account of every hop, skip and stop. It is
// best-effort: a log write that fails never blocks a chain.
import fs from 'node:fs/promises';
import path from 'node:path';

export const CHAIN_LOG_FILE = path.join('.claude', 'cockpit-chain-log.jsonl');
const MAX_DETAIL_CHARS = 500;

export async function appendChainLog(cwd, entry) {
  try {
    const file = path.join(cwd, CHAIN_LOG_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const clean = { at: new Date().toISOString(), ...entry };
    if (typeof clean.detail === 'string') clean.detail = clean.detail.slice(0, MAX_DETAIL_CHARS);
    await fs.appendFile(file, `${JSON.stringify(clean)}\n`);
  } catch {
    // logging must never break chaining
  }
}

// Newest first, malformed lines skipped.
export async function readChainLog(cwd, limit = 50) {
  let raw;
  try {
    raw = await fs.readFile(path.join(cwd, CHAIN_LOG_FILE), 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip a torn line
    }
  }
  return entries.slice(-limit).reverse();
}
