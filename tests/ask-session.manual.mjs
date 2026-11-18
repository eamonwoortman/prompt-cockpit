// Real end-to-end check of the ask_session tool: two live Haiku sessions in the
// same project; the origin's model is told to consult the other one, must call
// mcp__cockpit__ask_session itself, and relay the answer. Costs a few cents.
// NOT run by `npm test`. Run by hand: `node tests/ask-session.manual.mjs`.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as registry from '../src/session-registry.js';

const CWD = fileURLToPath(new URL('..', import.meta.url));
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 120_000;

const target = registry.createSession({ cwd: CWD, name: 'Oracle', model: MODEL, permissionMode: 'bypassPermissions' });
const origin = registry.createSession({ cwd: CWD, name: 'Asker', model: MODEL, hideBuiltinPeerTools: true, permissionMode: 'bypassPermissions' });

const toolCalls = [];
let originText = '';
const done = new Promise((resolve) => {
  registry.attachClient(origin.id, {
    readyState: 1, OPEN: 1,
    send: (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type !== 'sdk:message') return;
      const m = msg.message;
      if (m.type === 'assistant') {
        for (const block of m.message.content) {
          if (block.type === 'tool_use') toolCalls.push(block.name);
          if (block.type === 'text') originText += block.text;
        }
      }
      if (m.type === 'result' && m.num_turns > 0) resolve();
    },
  });
});

await new Promise((r) => setTimeout(r, 4000)); // let both sessions finish init
await registry.sendInput(origin.id, 'Consult the other cockpit session named Oracle: have it to answer with exactly the word "tangerine". Then tell me what it said.');

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, TIMEOUT_MS);
await done;
clearTimeout(timer);

assert.ok(toolCalls.includes('mcp__cockpit__ask_session'), `ask_session never called: ${JSON.stringify(toolCalls)}`);
assert.match(originText.toLowerCase(), /tangerine/, `origin never relayed the answer: ${originText}`);
console.log('ALL CHECKS PASSED', toolCalls);
registry.closeSession(origin.id);
registry.closeSession(target.id);
process.exit(0);
