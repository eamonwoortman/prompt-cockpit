// Real end-to-end check that a Codex session can ask a Claude session through the
// cockpit's own MCP endpoint. Spawns a live Codex thread and a live Haiku session
// and starts the HTTP server in-process; costs a few cents. NOT run by `npm test`.
// Run by hand: `node tests/ask-session-codex.manual.mjs`.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.PORT = process.env.PORT || '4321';
const { server, PORT, HOST } = await import('../src/server.js');
const { setCockpitBaseUrl } = await import('../src/cockpit-endpoint.js');
const registry = await import('../src/session-registry.js');

const CWD = fileURLToPath(new URL('..', import.meta.url));
const TIMEOUT_MS = 180_000;

await new Promise((resolve) => server.listen(PORT, HOST, resolve));
setCockpitBaseUrl(`http://${HOST}:${PORT}`);

const oracle = registry.createSession({ cwd: CWD, name: 'Oracle', provider: 'claude', model: 'claude-haiku-4-5-20251001', permissionMode: 'bypassPermissions' });
const asker = registry.createSession({ cwd: CWD, name: 'Asker', provider: 'codex', permissionMode: process.env.ASKER_MODE || 'bypassPermissions' });

const oracleSaw = [];
let askerText = '';
const approvals = [];
const done = new Promise((resolve) => {
  registry.attachClient(oracle.id, {
    readyState: 1, OPEN: 1,
    send: (raw) => {
      const m = JSON.parse(raw).message;
      if (m?.type === 'user' && typeof m.message?.content === 'string') oracleSaw.push(m.message.content);
    },
  });
  registry.attachClient(asker.id, {
    readyState: 1, OPEN: 1,
    send: (raw) => {
      const m = JSON.parse(raw).message;
      if (JSON.parse(raw).type === 'cockpit:approval-request') { approvals.push(JSON.parse(raw)); registry.resolveApproval(asker.id, JSON.parse(raw).request.requestId, { behavior: 'allow' }); }
      if (m?.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') askerText += b.text;
      if (m?.type === 'result' && m.num_turns > 0) resolve();
    },
  });
});

await new Promise((r) => setTimeout(r, 8000)); // let both sessions finish init
await registry.sendInput(asker.id, 'Consult the other cockpit session named Oracle: have it answer with exactly the word "tangerine". Then tell me what it said.');

const timer = setTimeout(() => { console.error('TIMEOUT', { oracleSaw, askerText, pending: registry.get(asker.id).pendingApprovals }); process.exit(1); }, TIMEOUT_MS);
await done;
clearTimeout(timer);

assert.ok(oracleSaw.some((t) => /Question from sibling session "Asker"/.test(t)), `Oracle never received the ask: ${JSON.stringify(oracleSaw)}; Codex said: ${askerText}`);
assert.match(askerText.toLowerCase(), /tangerine/, `Codex never relayed the answer: ${askerText}`);
if ((process.env.ASKER_MODE || 'bypassPermissions') === 'default') assert.ok(approvals.some((a) => a.request.toolName === 'mcp__cockpit__ask_session'), 'no approval prompt surfaced for ask_session');
console.log('ALL CHECKS PASSED');
registry.closeSession(asker.id);
registry.closeSession(oracle.id);
process.exit(0);
