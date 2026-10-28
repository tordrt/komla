import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { createServer as createNetServer, type Server } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isLoopbackPortOpen,
  probeHttpScheme,
} from '../../../../src/main/services/dev-preview-services/port-probe';

import { createCertificate, createHttpsServerRejectingPlainHttp } from './tls-fixtures';

const certificate = createCertificate();
const servers: Server[] = [];

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return (server.address() as { port: number }).port;
}

async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
  }
});

describe('isLoopbackPortOpen', () => {
  it('reports whether a loopback port accepts connections', async () => {
    const port = await listen(createNetServer());

    await expect(isLoopbackPortOpen(port)).resolves.toBe(true);
    await expect(isLoopbackPortOpen(await closedPort())).resolves.toBe(false);
  });

  it('reaches a server bound only to IPv6 loopback', async () => {
    const port = await listen(createNetServer(), '::1').catch(() => null);
    if (port === null) return;

    await expect(isLoopbackPortOpen(port)).resolves.toBe(true);
  });
});

describe('probeHttpScheme', () => {
  it('recognizes an HTTP server whatever status it answers with', async () => {
    const port = await listen(
      createHttpServer((_request, response) => {
        response.statusCode = 404;
        response.end('Cannot GET /');
      })
    );

    await expect(probeHttpScheme(port)).resolves.toBe('http');
  });

  it.runIf(certificate !== null)(
    'recognizes an HTTPS server with a self-signed certificate',
    async () => {
      const port = await listen(
        createHttpsServer(certificate!, (_request, response) => response.end('ok'))
      );

      await expect(probeHttpScheme(port)).resolves.toBe('https');
    }
  );

  it.runIf(certificate !== null)(
    'recognizes an HTTPS server that answers plain HTTP with a 400',
    async () => {
      const port = await listen(createHttpsServerRejectingPlainHttp(certificate!));

      await expect(probeHttpScheme(port)).resolves.toBe('https');
    }
  );

  it('recognizes an HTTP server that answers every request with a 400', async () => {
    const port = await listen(
      createHttpServer((_request, response) => {
        response.statusCode = 400;
        response.end();
      })
    );

    await expect(probeHttpScheme(port)).resolves.toBe('http');
  });

  it('counts a server that accepts the request but has not answered yet as HTTP', async () => {
    const port = await listen(createNetServer(() => {}));

    await expect(probeHttpScheme(port)).resolves.toBe('http');
  });

  it('rejects servers that answer with another protocol', async () => {
    const port = await listen(
      createNetServer((socket) => {
        socket.on('error', () => {});
        socket.end('-ERR unknown command\r\n');
      })
    );

    await expect(probeHttpScheme(port)).resolves.toBeNull();
  });

  it('returns null for a closed port', async () => {
    await expect(probeHttpScheme(await closedPort())).resolves.toBeNull();
  });
});
