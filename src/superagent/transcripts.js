import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { listAllSessionFiles } from '../session-launcher.js';
import { costForUsage } from '../usage.js';
import { primaryRepo } from './results.js';

const CARD_MARKER = '# Superagent job card';
const MAX_HEAD_LINES = 50;
const CACHE_LIMIT = 500;

export function projectDirName(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function readJobCard(text) {
  if (typeof text !== 'string') return null;
  const at = text.indexOf(CARD_MARKER);
  if (at < 0) return null;
  const fence = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(text.slice(at + CARD_MARKER.length));
  if (!fence) return null;
  try {
    const card = JSON.parse(fence[1]);
    return card && typeof card === 'object' && !Array.isArray(card) ? card : null;
  } catch {
    return null;
  }
}

const num = (v) => (Number.isFinite(v) ? v : 0);

function cacheWrite(usage) {
  const cc = usage.cache_creation;
  if (cc) return num(cc.ephemeral_5m_input_tokens) + num(cc.ephemeral_1h_input_tokens);
  return num(usage.cache_creation_input_tokens);
}

export function summarizeUsage(rows, { truncated = false } = {}) {
  const byId = new Map();
  const kept = [];
  let conflicts = 0;
  for (const row of rows) {
    if (!row.id) {
      conflicts += 1;
      kept.push(row);
      continue;
    }
    const prior = byId.get(row.id);
    if (!prior) {
      byId.set(row.id, { row, conflicted: false });
      kept.push(row);
      continue;
    }
    if (JSON.stringify(prior.row.usage) !== JSON.stringify(row.usage)) {
      if (!prior.conflicted) conflicts += 1;
      prior.conflicted = true;
      if (num(row.usage?.output_tokens) > num(prior.row.usage?.output_tokens)) {
        kept[kept.indexOf(prior.row)] = row;
        prior.row = row;
      }
    }
  }

  const out = {
    knownCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    byModel: {},
    unpricedModels: [],
    complete: true,
    conflicts,
  };
  for (const { model, usage } of kept) {
    const key = model ?? 'unknown';
    const tokens = num(usage?.input_tokens) + num(usage?.output_tokens) + num(usage?.cache_read_input_tokens) + cacheWrite(usage ?? {});
    out.inputTokens += num(usage?.input_tokens);
    out.outputTokens += num(usage?.output_tokens);
    out.cacheReadTokens += num(usage?.cache_read_input_tokens);
    out.cacheWriteTokens += cacheWrite(usage ?? {});
    const entry = (out.byModel[key] ??= { costUsd: null, tokens: 0 });
    entry.tokens += tokens;
    const priced = model ? costForUsage(model, usage) : null;
    if (priced) {
      entry.costUsd = (entry.costUsd ?? 0) + priced.cost;
      out.knownCostUsd += priced.cost;
    } else if (!out.unpricedModels.includes(key)) {
      out.unpricedModels.push(key);
    }
  }
  out.complete = !truncated && out.unpricedModels.length === 0;
  return out;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

function toMs(value) {
  if (Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

const defaultFs = { readdir, stat, createReadStream };

export function createTranscriptIndex({ projectsRoot = path.join(os.homedir(), '.claude', 'projects'), fsImpl = defaultFs } = {}) {
  const fs = { ...defaultFs, ...fsImpl };
  const cache = new Map();

  async function readHead(file) {
    let cwd = null;
    let card = null;
    let rl;
    let stream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
      rl = createInterface({ input: stream });
      let lines = 0;
      for await (const line of rl) {
        if (++lines > MAX_HEAD_LINES) break;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.type !== 'user') continue;
        if (cwd == null && typeof entry.cwd === 'string') cwd = entry.cwd;
        const text = messageText(entry.message);
        if (text.includes(CARD_MARKER)) {
          card = readJobCard(text);
          if (cwd == null && typeof entry.cwd === 'string') cwd = entry.cwd;
          break;
        }
      }
    } catch {
      return { cwd, card: null };
    } finally {
      rl?.close();
      stream?.destroy();
    }
    return { cwd, card };
  }

  async function jsonlIn(dir) {
    try {
      return (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
  }

  async function matches(file, jobId, attemptId, notBefore) {
    if (notBefore != null) {
      try {
        if ((await fs.stat(file)).mtimeMs < notBefore) return null;
      } catch {
        return null;
      }
    }
    const head = await readHead(file);
    if (head.card?.jobId !== jobId || head.card?.attemptId !== attemptId) return null;
    return { file, cwd: head.cwd };
  }

  async function find(job, attempt) {
    const { jobId } = job;
    const { attemptId } = attempt;
    const notBefore = toMs(attempt.startedAt);
    const worktree = primaryRepo(job)?.worktree;
    const seen = new Set();
    const hits = [];

    const scan = async (files) => {
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const hit = await matches(file, jobId, attemptId, notBefore);
        if (hit) hits.push(hit);
      }
    };

    if (worktree) {
      const dir = path.join(projectsRoot, projectDirName(worktree));
      await scan((await jsonlIn(dir)).map((n) => path.join(dir, n)));
    }
    if (hits.length === 0) {
      await scan((await listAllSessionFiles(projectsRoot)).map((f) => f.filePath).sort());
    }

    if (hits.length === 0) return { status: 'missing' };
    if (hits.length > 1) return { status: 'ambiguous', files: hits.map((h) => h.file) };
    const [{ file, cwd }] = hits;
    return { status: 'found', claudeSessionId: path.basename(file, '.jsonl'), file, cwd: cwd ?? worktree ?? null };
  }

  async function verify({ file }, { jobId, attemptId }) {
    try {
      await fs.stat(file);
    } catch {
      return false;
    }
    const { card } = await readHead(file);
    return card?.jobId === jobId && card?.attemptId === attemptId;
  }

  async function readRows(file) {
    const rows = [];
    let truncated = false;
    let rl;
    let stream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
      rl = createInterface({ input: stream });
      for await (const line of rl) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          truncated = true;
          continue;
        }
        if (entry?.type === 'assistant' && entry.message?.usage) {
          rows.push({ id: entry.message.id ?? null, model: entry.message.model ?? null, usage: entry.message.usage });
        }
      }
    } catch {
      truncated = true;
    } finally {
      rl?.close();
      stream?.destroy();
    }
    return { rows, truncated };
  }

  async function usage(found) {
    const subDir = path.join(path.dirname(found.file), found.claudeSessionId, 'subagents');
    const files = [found.file, ...(await jsonlIn(subDir)).map((n) => path.join(subDir, n))];
    const stats = [];
    for (const file of files) {
      try {
        const s = await fs.stat(file);
        stats.push([file, s.size, s.mtimeMs]);
      } catch {
        stats.push([file, -1, -1]);
      }
    }
    stats.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const fingerprint = JSON.stringify(stats);

    const hit = cache.get(fingerprint);
    if (hit) return { ...hit, fingerprint };

    const rows = [];
    let truncated = false;
    for (const [file, size] of stats) {
      if (size < 0) {
        truncated = true;
        continue;
      }
      const read = await readRows(file);
      rows.push(...read.rows);
      truncated ||= read.truncated;
    }
    const summary = summarizeUsage(rows, { truncated });
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(fingerprint, summary);
    return { ...summary, fingerprint };
  }

  return { find, usage, verify };
}
