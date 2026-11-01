import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createLogger } from '../../../lib/logger';
import { createMcpServer } from '../mcp-tools';

import type { KomlaOperationContext } from '../../komla-operation.service';
import type http from 'http';

const logger = createLogger('HttpServerService');

export function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: KomlaOperationContext = {}
): void {
  const mcpServer = createMcpServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Connect server to transport, then delegate request handling
  mcpServer
    .connect(transport)
    .then(() => {
      return transport.handleRequest(req, res);
    })
    .catch((error) => {
      logger.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
}
