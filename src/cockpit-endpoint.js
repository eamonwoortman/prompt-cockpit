// Where this process's HTTP server is reachable, set once server.js is
// listening. Providers that talk back to the cockpit over HTTP (the Codex MCP
// config, see session-registry.js) read it; unset (unit tests, no server)
// means "don't offer an endpoint".
let baseUrl = null;

export function setCockpitBaseUrl(url) {
  baseUrl = url;
}

export function getCockpitBaseUrl() {
  return baseUrl;
}
