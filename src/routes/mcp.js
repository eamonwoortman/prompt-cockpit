// Streamable-HTTP MCP endpoint, one per cockpit session (`/mcp/:id`), so a
// Codex session can call the cockpit's ask_session tool (see cockpit-mcp.js).
// Outside /api/, so the operator token doesn't apply; the session's own bearer
// token gates it instead, the same credential the session's other routes use.
import * as registry from '../session-registry.js';
import { handleMcpMessage } from '../cockpit-mcp.js';
import { readJsonBody, respondJson, extractToken } from '../http-utils.js';

export function registerMcpRoutes(router) {
  router.any('/mcp/:id', async (req, res, url, { id }) => {
    if (!registry.get(id) || !registry.checkToken(id, extractToken(req, url))) {
      return respondJson(res, 401, { error: 'invalid or missing session token' });
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    const response = await handleMcpMessage(registry.peersFor(id), await readJsonBody(req));
    if (response === null) {
      res.writeHead(202);
      return res.end();
    }
    return respondJson(res, 200, response);
  });
}
