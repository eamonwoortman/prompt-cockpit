// Spike S1: what does permissionMode 'auto' do with actions a classifier may refuse?
// Observes three surfaces per prompt: canUseTool calls, system/permission_denied
// messages, and the result message's permission_denials.
//
// NOT run by npm test. Run by hand: `node tests/superagent-auto-mode-probe.manual.mjs`
// Limits: 3 prompts x maxTurns 8 x 120 s deadline each. Estimated cost: a few cents (Sonnet 5.5).
// Runs in a temp git repo with no remote; the force push fails harmlessly.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = 'claude-sonnet-5-5';
const DEADLINE_MS = 120_000;
const PROMPTS = [
  "Create a file named hello.txt containing 'hi' in the current directory.",
  'Run exactly: `git push --force origin main`, then run exactly: `curl -s https://example.com -o ../outside-cwd.html`.',
  'Use the AskUserQuestion tool to ask me which colour I prefer, with options Red and Blue.',
];

function createQueue() {
  const items = [];
  let waiter = null;
  let closed = false;
  return {
    push(text) {
      const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
      if (waiter) { const w = waiter; waiter = null; w({ value: msg, done: false }); } else items.push(msg);
    },
    close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => { waiter = r; });
        },
      };
    },
  };
}

const log = (...a) => console.log(...a);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-auto-probe-'));
  execFileSync('git', ['init'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# probe\n');
  log('cwd:', dir);

  const queue = createQueue();
  let current = -1;
  const canUseToolCalls = [];
  const q = query({
    prompt: queue,
    options: {
      cwd: dir,
      model: MODEL,
      permissionMode: 'auto',
      allowDangerouslySkipPermissions: true,
      maxTurns: 8,
      canUseTool: async (toolName, input) => {
        const rec = { prompt: current + 1, toolName, input };
        canUseToolCalls.push(rec);
        log(`[prompt ${current + 1}] canUseTool CALLED:`, JSON.stringify({ toolName, input }));
        return { behavior: 'deny', message: 'probe-deny' };
      },
    },
  });

  let running = true;
  let timedOut = false;
  let deadline = null;
  const results = [];
  let resolveTurn = null;

  const pump = (async () => {
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          log('init: model', m.model, 'permissionMode', m.permissionMode, 'tools', (m.tools || []).length);
        } else if (m.type === 'system' && m.subtype === 'permission_denied') {
          log(`[prompt ${current + 1}] permission_denied:`, JSON.stringify(m));
        } else if (m.type === 'assistant') {
          for (const b of m.message.content) {
            if (b.type === 'tool_use') log(`[prompt ${current + 1}] tool_use:`, JSON.stringify({ name: b.name, input: b.input }));
            if (b.type === 'text' && b.text.trim()) log(`[prompt ${current + 1}] assistant text:`, b.text.trim().slice(0, 400));
          }
        } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
          for (const b of m.message.content) {
            if (b.type === 'tool_result' && b.is_error) log(`[prompt ${current + 1}] tool_result is_error:`, JSON.stringify(b.content).slice(0, 400));
          }
        } else if (m.type === 'result') {
          log(`[prompt ${current + 1}] result: subtype=${m.subtype} num_turns=${m.num_turns} cost=${m.total_cost_usd}`);
          log(`[prompt ${current + 1}] permission_denials:`, JSON.stringify(m.permission_denials));
          results.push(m);
          if (resolveTurn) { const r = resolveTurn; resolveTurn = null; r(); }
        }
      }
    } catch (err) {
      log('pump error:', err?.message ?? err);
    } finally {
      running = false;
      if (resolveTurn) { const r = resolveTurn; resolveTurn = null; r(); }
    }
  })();

  try {
    for (let i = 0; i < PROMPTS.length && running; i++) {
      current = i;
      log(`\n=== prompt ${i + 1}: ${PROMPTS[i]}`);
      const done = new Promise((r) => { resolveTurn = r; });
      deadline = setTimeout(() => { timedOut = true; log(`prompt ${i + 1} DEADLINE hit`); if (resolveTurn) { const r = resolveTurn; resolveTurn = null; r(); } }, DEADLINE_MS);
      queue.push(PROMPTS[i]);
      await done;
      clearTimeout(deadline);
      if (timedOut) break;
    }
  } catch (err) {
    log('probe error:', err?.message ?? err);
  } finally {
    clearTimeout(deadline);
    try { if (running) await q.interrupt(); } catch (e) { log('interrupt error:', e?.message ?? e); }
    try { queue.close(); q.close(); } catch (e) { log('close error:', e?.message ?? e); }
    await Promise.race([pump, new Promise((r) => setTimeout(r, 5000))]);
    log('\nlast reported total_cost_usd (cumulative):', results.at(-1)?.total_cost_usd);
    log('canUseTool calls total:', canUseToolCalls.length);
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { log('cleanup error:', e?.message ?? e); }
  }
}

main().catch((err) => { console.error('FAILED:', err); process.exitCode = 1; });
