import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKomlaClient, httpTransport, type KomlaRoute } from '../src/index.js';

interface Received {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

let server: Server;
let base: string;
let received: Received[];
let answer: { status: number; body: string };

beforeEach(async () => {
  received = [];
  answer = { status: 200, body: JSON.stringify({ ok: true, result: { tags: [] } }) };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function client(route: Partial<KomlaRoute> = {}) {
  return createKomlaClient({
    transport: httpTransport({ route: { url: base, ...route } }),
    capabilities: ['workspace.tag'],
  });
}

describe('httpTransport', () => {
  it('posts the operation to /api/v1/commands as JSON', async () => {
    await expect(client({ terminalId: 'terminal-1' }).tag.list()).resolves.toEqual({ tags: [] });

    expect(received).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/api/v1/commands',
        body: { type: 'tag.list' },
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-komla-terminal-id': 'terminal-1',
        }),
      }),
    ]);
  });

  // Komla refuses requests that look like a web page's (docs/CLI.md, Architecture).
  it('sends no header that makes Komla take it for a web page', async () => {
    await client().tag.list();

    expect(received[0]?.headers.origin).toBeUndefined();
    expect(received[0]?.headers['sec-fetch-site'] ?? 'none').toBe('none');
  });

  it("names the calling workspace by the caller's folder when it has no terminal", async () => {
    await client({ cwd: '/projects/web app', workspaceId: 'workspace-1' }).tag.list();

    expect(received[0]?.url).toBe('/api/v1/commands?cwd=%2Fprojects%2Fweb%20app');
    expect(received[0]?.headers['x-komla-workspace-id']).toBe('workspace-1');
  });

  it("leaves the folder out under a terminal's scoped URL", async () => {
    const scoped = createKomlaClient({
      transport: httpTransport({ route: { url: `${base}/terminals/terminal-1/`, cwd: '/x' } }),
    });
    await scoped.tag.list();

    expect(received[0]?.url).toBe('/terminals/terminal-1/api/v1/commands');
  });

  it('acts on a named workspace in place of the calling one', async () => {
    await client({ terminalId: 'terminal-1', workspaceId: 'workspace-1' }).workspace.tag(
      { tag: 'CI failed', ifTag: 'CI running' },
      { workspace: 'workspace-2' }
    );

    const { headers } = received[0]!;
    expect(headers['x-komla-target-workspace-id']).toBe('workspace-2');
    expect(headers['x-komla-workspace-id']).toBe('workspace-2');
    expect(headers['x-komla-terminal-id']).toBeUndefined();
  });

  it("throws Komla's error with its code, status and details", async () => {
    answer = {
      status: 403,
      body: JSON.stringify({
        ok: false,
        error: {
          code: 'CAPABILITY_DISABLED',
          message: '`komla tag` is turned off in Komla.',
          details: { capability: 'workspace.tag' },
        },
      }),
    };

    await expect(client().workspace.tag({ tag: 'x' })).rejects.toMatchObject({
      name: 'KomlaError',
      code: 'CAPABILITY_DISABLED',
      message: '`komla tag` is turned off in Komla.',
      status: 403,
      details: { capability: 'workspace.tag' },
    });
  });

  it('throws UNEXPECTED_RESPONSE for an answer without a result', async () => {
    answer = { status: 404, body: 'Not found' };

    await expect(client().tag.list()).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      status: 404,
    });
  });

  it('throws KOMLA_UNREACHABLE when nothing answers', async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createServer();

    await expect(client().tag.list()).rejects.toMatchObject({ code: 'KOMLA_UNREACHABLE' });
  });

  it('throws UNEXPECTED_RESPONSE for a success without a result', async () => {
    answer = { status: 200, body: JSON.stringify({ ok: true }) };

    await expect(client().tag.list()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('throws UNEXPECTED_RESPONSE when the answer to a change breaks off, as it may have run', async () => {
    const broken = createKomlaClient({
      transport: httpTransport({
        route: { url: base },
        fetch: async () =>
          ({ status: 200, text: () => Promise.reject(new TypeError('terminated')) }) as Response,
      }),
      capabilities: ['workspace.tag'],
    });

    await expect(broken.workspace.tag({ tag: 'x' })).rejects.toMatchObject({
      name: 'KomlaError',
      code: 'UNEXPECTED_RESPONSE',
      status: 200,
    });
    // A read changed nothing, so it says Komla stopped answering, and Komla is found again.
    await expect(broken.tag.list()).rejects.toMatchObject({ code: 'KOMLA_UNREACHABLE' });
  });

  // As the CLI waits 10 seconds for an answer only to calls that change nothing.
  it('stops waiting for a read Komla never answers, but not for a change', async () => {
    const pending: Array<'aborted'> = [];
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          pending.push('aborted');
          reject(init.signal?.reason);
        });
      });
    const komla = createKomlaClient({
      transport: httpTransport({ route: { url: base }, fetch: hanging, readTimeoutMs: 20 }),
      capabilities: ['workspace.tag'],
    });

    await expect(komla.workspace.list()).rejects.toMatchObject({
      code: 'KOMLA_UNREACHABLE',
      message: expect.stringContaining('within 20 ms'),
    });
    const caller = new AbortController();
    const change = komla.workspace.tag({ tag: 'x' }, { signal: caller.signal });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(pending).toEqual(['aborted']);
    caller.abort(new Error('done waiting'));
    await expect(change).rejects.toThrow('done waiting');
    expect(pending).toEqual(['aborted', 'aborted']);
  });

  it('finds the route before each request when given a function', async () => {
    let calls = 0;
    const komla = createKomlaClient({
      transport: httpTransport({
        route: () => ({ url: base, terminalId: `terminal-${++calls}` }),
      }),
    });

    await komla.tag.list();
    await komla.tag.list();

    expect(received.map(({ headers }) => headers['x-komla-terminal-id'])).toEqual([
      'terminal-1',
      'terminal-2',
    ]);
  });
});
