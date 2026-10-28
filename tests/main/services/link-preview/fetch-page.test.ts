import { execFile } from 'child_process';
import { createServer as createHttpServer, type RequestListener, type Server } from 'http';
import { createServer as createHttpsServer } from 'https';
import { promisify } from 'util';
import { gzipSync } from 'zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRemoteFetchCommand,
  fetchPageLocally,
  isPublicAddress,
  parseRemoteFetch,
  type FetchPageOptions,
} from '../../../../src/main/services/link-preview/fetch-page';
import { createCertificate } from '../dev-preview-services/tls-fixtures';

const run = promisify(execFile);
const certificate = createCertificate();
const servers: Server[] = [];
const options: FetchPageOptions = { accept: 'text/html', maxBytes: 64 * 1024, timeoutMs: 2_000 };

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `localhost:${(server.address() as { port: number }).port}`;
}

function serve(handler: RequestListener): Promise<string> {
  return listen(createHttpServer(handler));
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe('fetchPageLocally', () => {
  it('follows redirects and reports the page that answered', async () => {
    const host = await serve((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { Location: '/dashboard' }).end();
        return;
      }
      expect(request.headers.cookie).toBeUndefined();
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Powered-By': 'Express' })
        .end('<title>Dashboard</title>');
    });

    const page = await fetchPageLocally(`http://${host}/`, options);

    expect(page).toMatchObject({
      url: `http://${host}/dashboard`,
      status: 200,
      contentType: 'text/html',
      poweredBy: 'Express',
    });
    expect(page?.body.toString()).toBe('<title>Dashboard</title>');
  });

  it('decompresses gzip and stops reading once it has enough', async () => {
    const html = `<head><title>Big</title></head><body>${'x'.repeat(200_000)}</body>`;
    const host = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      response.end(gzipSync(html));
    });

    const page = await fetchPageLocally(`http://${host}/`, {
      ...options,
      maxBytes: 1_000,
    });

    expect(page?.body.toString()).toBe(html.slice(0, 1_000));
  });

  it('stops at a closing tag split between chunks, seeing only the newest bytes each time', async () => {
    const host = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      const parts = [`<head>${'x'.repeat(10_000)}`, '<title>Split</title></he', 'ad>'];
      const next = () => {
        const part = parts.shift();
        if (part) response.write(part, () => setTimeout(next, 20));
        // The body never ends, so only the closing tag can stop the read.
      };
      next();
    });
    const seen: number[] = [];

    const page = await fetchPageLocally(`http://${host}/`, {
      ...options,
      isEnough: (recent) => {
        seen.push(recent.length);
        return recent.toString().includes('</head>');
      },
    });

    expect(page?.body.toString()).toMatch(/<title>Split<\/title><\/head>$/);
    expect(seen.slice(1).every((length) => length <= 64 + 24)).toBe(true);
  });

  it('gives up on a server that never answers', async () => {
    const host = await serve(() => {});

    await expect(fetchPageLocally(`http://${host}/`, { ...options, timeoutMs: 200 })).resolves.toBe(
      null
    );
  });

  it('settles at once on a redirect to an address that is not a URL', async () => {
    const host = await serve((_request, response) => {
      response.writeHead(302, { Location: 'http://[bad' }).end();
    });
    const started = Date.now();

    await expect(fetchPageLocally(`http://${host}/`, options)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(options.timeoutMs);
  });

  it('reads nothing from this computer when the page must be on the public internet', async () => {
    let requests = 0;
    const host = await serve((_request, response) => {
      requests++;
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Admin</title>');
    });
    const port = host.split(':')[1];

    for (const url of [`http://${host}/`, `http://127.0.0.1:${port}/`, `http://[::1]:${port}/`]) {
      await expect(fetchPageLocally(url, { ...options, publicOnly: true })).resolves.toBeNull();
    }
    expect(requests).toBe(0);
  });

  it.skipIf(!certificate)('accepts a self-signed certificate on localhost', async () => {
    const host = await listen(
      createHttpsServer(certificate!, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Secure</title>');
      })
    );

    const page = await fetchPageLocally(`https://${host}/`, options);

    expect(page?.body.toString()).toBe('<title>Secure</title>');
  });
});

describe('isPublicAddress', () => {
  it('tells internet addresses from local, private and reserved ones', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(address)).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '100.100.1.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'localhost',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
  });
});

describe('parseRemoteFetch', () => {
  it('reads the last response curl followed', () => {
    const output = [
      '@@komla-headers',
      'HTTP/1.1 302 Found\r',
      'Location: /login\r',
      '\r',
      'HTTP/1.1 200 OK\r',
      'Content-Type: text/html; charset=utf-8\r',
      'Server: uvicorn\r',
      '\r',
      '',
      '@@komla-body',
      Buffer.from('<title>Log in</title>').toString('base64'),
      '',
    ].join('\n');

    expect(parseRemoteFetch(output, 'http://localhost:8000/')).toEqual({
      url: 'http://localhost:8000/login',
      status: 200,
      contentType: 'text/html',
      poweredBy: undefined,
      server: 'uvicorn',
      body: Buffer.from('<title>Log in</title>'),
    });
  });

  it('is null when curl printed nothing', () => {
    expect(parseRemoteFetch('', 'http://localhost:8000/')).toBeNull();
    expect(
      parseRemoteFetch('@@komla-headers\n\n@@komla-body\n\n', 'http://localhost:8000/')
    ).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('buildRemoteFetchCommand', () => {
  it('fetches the start of a page with curl in a POSIX shell', async () => {
    const host = await serve((request, response) => {
      response.writeHead(request.url === '/' ? 301 : 200, {
        'Content-Type': 'text/html',
        ...(request.url === '/' ? { Location: '/app/' } : {}),
      });
      response.end(`<title>It's here</title>${'x'.repeat(5_000)}`);
    });
    const url = `http://${host}/`;

    const { stdout } = await run('sh', [
      '-c',
      buildRemoteFetchCommand(url, { ...options, maxBytes: 100 }),
    ]);
    const page = parseRemoteFetch(stdout, url);

    expect(page).toMatchObject({
      url: `http://${host}/app/`,
      status: 200,
      contentType: 'text/html',
    });
    expect(page?.body.toString()).toBe(`<title>It's here</title>${'x'.repeat(76)}`);
  });

  it('quotes the URL for the shell', () => {
    const command = buildRemoteFetchCommand("http://localhost:1/'$(touch /tmp/pwned)'", options);

    expect(command).toContain(`'http://localhost:1/'"'"'$(touch /tmp/pwned)'"'"''`);
  });
});
