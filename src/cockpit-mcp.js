// The cockpit's own MCP server (streamable HTTP, JSON responses only) exposing
// cockpit-tools.js to providers that can't take an in-process SDK server -
// Codex connects to it through its per-thread `mcp_servers` config. One
// JSON-RPC message in, one response (or null for a notification) out; the
// HTTP framing and per-session auth live in routes/mcp.js.
import { z } from 'zod';
import { cockpitToolDefs, COCKPIT_TOOLS_SERVER } from './cockpit-tools.js';

const FALLBACK_PROTOCOL_VERSION = '2025-03-26';

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

export async function handleMcpMessage(peers, message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id ?? null, -32600, 'invalid request');
  }
  const { id, method, params } = message;
  if (id === undefined) return null; // notification (e.g. notifications/initialized) - nothing to answer

  const defs = cockpitToolDefs(peers);
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: COCKPIT_TOOLS_SERVER, version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: defs.map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: z.toJSONSchema(z.object(def.shape)),
          ...(def.annotations ? { annotations: def.annotations } : {}),
        })),
      });
    case 'tools/call': {
      const def = defs.find((d) => d.name === params?.name);
      if (!def) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
      const parsed = z.object(def.shape).safeParse(params?.arguments ?? {});
      if (!parsed.success) return rpcError(id, -32602, `invalid arguments: ${parsed.error.message}`);
      return rpcResult(id, await def.handler(parsed.data));
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
