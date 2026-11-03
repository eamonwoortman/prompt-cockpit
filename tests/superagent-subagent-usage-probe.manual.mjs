// Spike S3: which result field carries subagent spend, and is it cumulative across turns?
// Compares default options (A) with forwardSubagentText: true (B) in the repo cwd.
//
// NOT run by npm test. Run by hand: `node tests/superagent-subagent-usage-probe.manual.mjs`
// Limits: 2 configs x 2 turns x maxTurns 12 x 180 s deadline per turn. Measured cost: $0.805 (config A $0.489, config B $0.316);
// the brief's under-$0.50 estimate was about 1.6x low.
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = 'claude-sonnet-5-5';
const DEADLINE_MS = 180_000;
const REPO = fileURLToPath(new URL('..', import.meta.url));
const TURNS = [
  'Use the Agent tool to spawn one general-purpose subagent that counts the .js files in src/ and reports the number. Then tell me the number.',
  'Use the Agent tool to spawn one general-purpose subagent that counts the .js files in tests/ and reports the number. Then tell me the number.',
];
const CONFIGS = { A: {}, B: { forwardSubagentText: true } };

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

const sumUsage = (acc, u) => {
  if (!u) return;
  for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) acc[k] = (acc[k] ?? 0) + (u[k] ?? 0);
};

async function runConfig(name, extra) {
  console.log(`\n##### config ${name}: ${JSON.stringify(extra)} #####`);
  const input = createQueue();
  const q = query({ prompt: input, options: { cwd: REPO, model: MODEL, permissionMode: 'acceptEdits', maxTurns: 12, ...extra } });
  let turn = 0;
  let turnResolve = null;
  let turnInFlight = false;
  let top = {};
  let sub = {};
  let prevModelUsage = {};
  let lastResult = null;
  const pump = (async () => {
    try {
      for await (const m of q) {
        const usage = m.message?.usage;
        console.log(`[${name}${turn}] type=${m.type} subtype=${m.subtype ?? ''} parent_tool_use_id=${m.parent_tool_use_id ?? null}${usage ? ' message.usage=' + JSON.stringify(usage) : ''}`);
        if (m.type === 'assistant' && usage) sumUsage(m.parent_tool_use_id ? sub : top, usage);
        if (m.type === 'result') {
          lastResult = m;
          console.log(`[${name}${turn}] result.usage=${JSON.stringify(m.usage)}`);
          console.log(`[${name}${turn}] result.modelUsage=${JSON.stringify(m.modelUsage)}`);
          console.log(`[${name}${turn}] total_cost_usd=${m.total_cost_usd} result=${JSON.stringify(String(m.result ?? '').slice(0, 200))}`);
          console.log(`[${name}${turn}] sum top-level assistant usage=${JSON.stringify(top)}`);
          console.log(`[${name}${turn}] sum parent_tool_use_id usage=${JSON.stringify(sub)}`);
          const delta = {};
          for (const [model, mu] of Object.entries(m.modelUsage ?? {})) {
            delta[model] = {};
            for (const [k, v] of Object.entries(mu)) if (typeof v === 'number') delta[model][k] = v - (prevModelUsage[model]?.[k] ?? 0);
          }
          console.log(`[${name}${turn}] modelUsage delta vs previous result=${JSON.stringify(delta)}`);
          prevModelUsage = m.modelUsage ?? {};
          top = {}; sub = {};
          if (turnResolve) { turnInFlight = false; turnResolve(); turnResolve = null; }
        }
      }
    } catch (err) {
      console.log('pump error:', err?.message ?? err);
      if (turnResolve) { turnInFlight = false; turnResolve(); turnResolve = null; }
    }
  })();
  try {
    for (const text of TURNS) {
      turn += 1;
      console.log(`\n=== ${name} turn ${turn} ===`);
      let timer;
      let timedOut = false;
      const done = new Promise((r) => { turnResolve = r; });
      const deadline = new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(); }, DEADLINE_MS); });
      turnInFlight = true;
      input.push(text);
      await Promise.race([done, deadline]);
      clearTimeout(timer);
      if (timedOut) { console.log('DEADLINE hit'); break; }
      turnInFlight = false;
    }
  } catch (e) {
    console.log(`${name} error:`, e?.message ?? e);
  } finally {
    input.end();
    try { if (turnInFlight) await q.interrupt(); } catch (e) { console.log('interrupt error:', e?.message ?? e); }
    try { q.close(); } catch (e) { console.log('close error:', e?.message ?? e); }
  }
  console.log(`${name} final total_cost_usd:`, lastResult?.total_cost_usd);
}

async function main() {
  for (const [name, extra] of Object.entries(CONFIGS)) {
    try { await runConfig(name, extra); } catch (e) { console.log(`${name} error:`, e?.message ?? e); }
  }
}

main().catch((err) => { console.error('FAILED:', err); process.exitCode = 1; });
