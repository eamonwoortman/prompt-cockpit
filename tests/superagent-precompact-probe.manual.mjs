// Spike S2: does a PreCompact hook fire on a manual /compact between turns, and what is in its input?
// Scope: manual trigger between turns only; says nothing about automatic mid-turn compaction.
//
// NOT run by npm test. Run by hand: `node tests/superagent-precompact-probe.manual.mjs`
// Limits: 1 query x 3 turns x maxTurns 4 x 120 s deadline per turn. Measured cost: $0.311 (turn 1 $0.205 of it, about 42k tokens of preset/tools context;
// the header estimate of a few cents was about 10x low).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = 'claude-sonnet-5-5';
const DEADLINE_MS = 120_000;
const TURNS = [
  'Read package.json and summarise it in one line.',
  '/compact Keep a note that the project is called probe.',
  'What is the project called, and what file did you read earlier?',
];

function createQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(text) {
      items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      if (wake) { wake(); wake = null; }
    },
    end() { closed = true; if (wake) { wake(); wake = null; } },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-precompact-probe-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'echo ok' } }));
  console.log('cwd:', dir);
  const input = createQueue();
  const q = query({
    prompt: input,
    options: {
      cwd: dir, model: MODEL, permissionMode: 'acceptEdits', maxTurns: 4,
      hooks: { PreCompact: [{ hooks: [async (hin) => { console.log('HOOK PreCompact input:', JSON.stringify(hin)); return { continue: true }; }] }] },
    },
  });
  let turn = 0;
  let turnResolve = null;
  let lastResult = null;
  const pump = (async () => {
    try {
      for await (const m of q) {
        if (turn >= 2) console.log(`[turn ${turn}] msg type=${m.type} subtype=${m.subtype ?? ''}`, m.type === 'system' && m.subtype !== 'init' ? JSON.stringify(m) : '');
        if (m.type === 'assistant') {
          for (const b of m.message.content) if (b.type === 'text' && turn === 3) console.log(`[turn 3] assistant text:`, JSON.stringify(b.text));
        } else if (m.type === 'result') {
          lastResult = m;
          console.log(`[turn ${turn}] result subtype=${m.subtype} is_error=${m.is_error} total_cost_usd=${m.total_cost_usd} result=${JSON.stringify(String(m.result ?? '').slice(0, 300))}`);
          if (turnResolve) { turnResolve(); turnResolve = null; }
        }
      }
    } catch (err) {
      console.log('pump error:', err?.message ?? err);
      if (turnResolve) { turnResolve(); turnResolve = null; }
    }
  })();
  try {
    for (const text of TURNS) {
      turn += 1;
      console.log(`\n=== turn ${turn}: ${JSON.stringify(text)} ===`);
      let timer;
      let timedOut = false;
      const done = new Promise((r) => { turnResolve = r; });
      const deadline = new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(); }, DEADLINE_MS); });
      input.push(text);
      await Promise.race([done, deadline]);
      clearTimeout(timer);
      if (timedOut) { console.log('DEADLINE hit'); break; }
    }
  } catch (e) {
    console.log('probe error:', e?.message ?? e);
  } finally {
    input.end();
    try { await q.interrupt(); } catch (e) { console.log('interrupt error:', e?.message ?? e); }
    try { q.close(); } catch (e) { console.log('close error:', e?.message ?? e); }
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.log('cleanup error:', e?.message ?? e); }
  }
  console.log('\nfinal total_cost_usd:', lastResult?.total_cost_usd);
}

main().catch((err) => { console.error('FAILED:', err); process.exitCode = 1; });
