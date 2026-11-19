// Cross-session delegation as model-callable tools, so the user can say "ask the
// other sessions what they think" and the model calls ask_session itself
// instead of the user typing `/ask <Name>: ...`. Defined once here and exposed
// two ways: an in-process SDK MCP server for Claude, and the cockpit's own
// streamable-HTTP MCP endpoint (cockpit-mcp.js) for Codex and other providers.
// `peers` is { listPeers(), ask(name, text) } bound to the owning session.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const COCKPIT_TOOLS_SERVER = 'cockpit';

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

export function cockpitToolDefs(peers) {
  return [
    {
      name: 'list_sessions',
      description: 'List the other Prompt Cockpit sessions (the named tabs the operator has open: name, provider, project folder, state) that this session can consult with ask_session.',
      shape: {},
      annotations: { readOnlyHint: true },
      handler: async () => {
        const list = peers.listPeers();
        return text(list.length ? JSON.stringify(list, null, 2) : 'No other named sessions are available.');
      },
    },
    {
      name: 'ask_session',
      description: 'Ask another Prompt Cockpit session a question or hand it a task, and wait for its answer. The other session '
        + 'cannot see this conversation, so `prompt` must be self-contained: the relevant context, the exact question, '
        + 'and any file paths or constraints. Use list_sessions first if you are unsure of the name. Slow: the other '
        + 'session may run a full turn before it replies.',
      shape: {
        session: z.string().describe('Name of the target session, as shown by list_sessions'),
        prompt: z.string().min(1).describe('Self-contained message for the target session'),
      },
      handler: async ({ session, prompt }, { signal } = {}) => {
        try {
          const reply = await peers.ask(session, prompt, { signal });
          return reply.ok ? text(reply.text) : text(`${session} could not answer: ${reply.text}`, true);
        } catch (err) {
          return text(String(err.message || err), true);
        }
      },
    },
  ];
}

export function createCockpitToolsServer(peers) {
  return createSdkMcpServer({
    name: COCKPIT_TOOLS_SERVER,
    version: '1.0.0',
    tools: cockpitToolDefs(peers).map((def) => tool(def.name, def.description, def.shape, def.handler, {
      annotations: def.annotations,
      alwaysLoad: true,
    })),
  });
}
