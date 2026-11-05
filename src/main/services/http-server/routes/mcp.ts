import { createLogger } from '../../../lib/logger';

import type { KomlaOperationContext } from '../../komla-operation.service';
import type http from 'http';

const logger = createLogger('HttpServerService');

/** How long after the server starts listening it loads the MCP SDK, once startup has settled. */
export const MCP_PRELOAD_DELAY_MS = 5_000;

// The MCP SDK takes about 60ms to load, so startup leaves it for later: a background load a few
// seconds in, or the first request if that comes sooner. Node keeps each loaded module.
function loadMcp() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('../mcp-tools'),
  ]);
}

/** Loads the MCP SDK in the background, so the first request answers as fast as later ones. */
export function preloadMcp(): void {
  loadMcp().catch((error) => logger.warn('Could not preload the MCP server:', error));
}

export function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: KomlaOperationContext = {}
): void {
  // The request's body waits, paused, until the transport reads it.
  loadMcp()
    .then(([{ StreamableHTTPServerTransport }, { createMcpServer }]) => {
      const mcpServer = createMcpServer(context);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      // Connect server to transport, then delegate request handling
      return mcpServer.connect(transport).then(() => transport.handleRequest(req, res));
    })
    .catch((error) => {
      logger.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
}
