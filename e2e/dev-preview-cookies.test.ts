import { randomUUID } from 'crypto';
import { createServer, type Server } from 'http';

import { test, expect } from './electron-app';

let server: Server;
let origin: string;
const sessionValue = randomUUID();

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(302, {
        Location: '/app',
        'Set-Cookie': `komla_session=${sessionValue}; HttpOnly; SameSite=Lax; Path=/`,
      });
      response.end();
      return;
    }

    if (request.url === '/app') {
      const authenticated = request.headers.cookie?.includes(`komla_session=${sessionValue}`);
      response.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'text/html' });
      response.end(`<main>${authenticated ? 'Authenticated preview' : 'Missing session'}</main>`);
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Preview test server did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('keeps a SameSite=Lax session cookie in the first-party preview', async ({
  appWindow,
  electronApp,
}) => {
  await appWindow.evaluate((url) => {
    window.api.syncDevPreview('cookie-test-workspace', 'cookie-test-tab', `${url}/login`, {
      x: 100,
      y: 100,
      width: 600,
      height: 400,
    });
  }, origin);

  await expect
    .poll(
      async () =>
        electronApp.evaluate(async ({ webContents }, previewOrigin) => {
          const preview = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(previewOrigin));
          if (!preview || !preview.getURL().endsWith('/app')) return null;
          return preview.executeJavaScript('document.body.textContent', true);
        }, origin),
      { timeout: 10_000 }
    )
    .toContain('Authenticated preview');
});
