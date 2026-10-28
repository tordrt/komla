import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8')
) as Record<string, unknown>;

const SCOPE = 'https://desk.tailnet.ts.net/remote/';

type Listener = (event: Record<string, unknown>) => void;

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function loadWorker(
  fetchImpl: (request: { url: string }) => Promise<Response>,
  windows: FakeClient[] = []
) {
  const listeners = new Map<string, Listener>();
  const stored = new Map<string, Response>();
  const cache = {
    put: vi.fn(async (key: string | { url: string }, response: Response) => {
      stored.set(typeof key === 'string' ? key : key.url, response);
    }),
    match: vi.fn(async (key: string | { url: string }) =>
      stored.get(typeof key === 'string' ? key : key.url)
    ),
    addAll: vi.fn(async () => {}),
  };
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const self = {
    registration: { scope: SCOPE, showNotification },
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => windows), openWindow },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  runInNewContext(workerSource, {
    self,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: fetchImpl,
    URL,
    Set,
  });

  async function dispatchFetch(url: string, mode = 'cors'): Promise<Response | undefined> {
    let responded: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: { url, method: 'GET', mode },
      respondWith: (promise: Promise<Response>) => {
        responded = promise;
      },
    });
    return responded;
  }

  async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> | undefined;
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => (pending = promise),
    });
    await pending;
  }

  return { listeners, cache, stored, dispatchFetch, dispatch, showNotification, openWindow };
}

function okResponse(body: string): Response {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

describe('remote service worker', () => {
  it('leaves the socket, connection config and health check to the network', async () => {
    const worker = loadWorker(async () => okResponse('x'));

    for (const path of ['ws?fp=abc', 'config', 'health']) {
      expect(await worker.dispatchFetch(`${SCOPE}${path}`)).toBeUndefined();
    }
    expect(await worker.dispatchFetch('https://desk.tailnet.ts.net/other/app.js')).toBeUndefined();
    expect(await worker.dispatchFetch('https://example.com/remote/app.js')).toBeUndefined();
  });

  it('asks the desktop first and keeps one copy of the page for every route', async () => {
    const worker = loadWorker(async () => okResponse('<html>new</html>'));

    const response = await worker.dispatchFetch(`${SCOPE}pair`, 'navigate');

    expect(await response?.text()).toBe('<html>new</html>');
    expect([...worker.stored.keys()]).toEqual([SCOPE]);
  });

  it('opens the last copy of the page when the desktop is unreachable', async () => {
    let online = true;
    const worker = loadWorker(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return okResponse('<html>cached</html>');
    });
    await worker.dispatchFetch(SCOPE, 'navigate');
    online = false;

    const offline = await worker.dispatchFetch(SCOPE, 'navigate');

    expect(await offline?.text()).toBe('<html>cached</html>');
    await expect(worker.dispatchFetch(`${SCOPE}assets/missing.js`)).rejects.toThrow(
      'Failed to fetch'
    );
  });
});

describe('remote service worker notifications', () => {
  const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });

  it('shows the desktop’s title and body and keeps where to go', async () => {
    const worker = loadWorker(async () => okResponse(''));

    await worker.dispatch(
      'push',
      pushEvent({
        v: 1,
        title: 'Fix SSH prompt',
        body: 'Needs input · Allow npm test?',
        tag: 'workspace-ws-1',
        workspaceId: 'ws-1',
        terminalId: 't-1',
      })
    );

    expect(worker.showNotification).toHaveBeenCalledWith('Fix SSH prompt', {
      body: 'Needs input · Allow npm test?',
      tag: 'workspace-ws-1',
      renotify: true,
      icon: `${SCOPE}icons/icon-192.png`,
      data: { workspaceId: 'ws-1', terminalId: 't-1' },
    });
  });

  it('falls back to a plain notification for an unreadable payload and drops odd ids', async () => {
    const worker = loadWorker(async () => okResponse(''));

    await worker.dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError('bad');
        },
      },
    });
    await worker.dispatch(
      'push',
      pushEvent({ title: 'x', workspaceId: '../../etc', terminalId: 't' })
    );

    expect(worker.showNotification).toHaveBeenNthCalledWith(
      1,
      'Komla',
      expect.objectContaining({ body: '', data: {} })
    );
    expect(worker.showNotification).toHaveBeenNthCalledWith(
      2,
      'x',
      expect.objectContaining({ data: { workspaceId: undefined, terminalId: undefined } })
    );
  });

  it('opens the workspace in a new window when none is open', async () => {
    const worker = loadWorker(async () => okResponse(''));
    const close = vi.fn();

    await worker.dispatch('notificationclick', {
      notification: { close, data: { workspaceId: 'ws-1', terminalId: 't-1' } },
    });

    expect(close).toHaveBeenCalled();
    expect(worker.openWindow).toHaveBeenCalledWith(`${SCOPE}?workspace=ws-1&terminal=t-1`);
  });

  it('focuses an open window and tells it which workspace to show', async () => {
    const open: FakeClient = {
      url: `${SCOPE}`,
      focus: vi.fn(async () => {}),
      postMessage: vi.fn(),
    };
    const worker = loadWorker(async () => okResponse(''), [open]);

    await worker.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { workspaceId: 'ws-1' } },
    });

    expect(open.focus).toHaveBeenCalled();
    expect(open.postMessage).toHaveBeenCalledWith({
      type: 'komla:open-workspace',
      workspaceId: 'ws-1',
      terminalId: undefined,
    });
    expect(worker.openWindow).not.toHaveBeenCalled();
  });
});

describe('web app manifest', () => {
  it('installs as a standalone app scoped to the remote client', () => {
    expect(manifest).toMatchObject({
      id: '/remote/',
      start_url: '/remote/',
      scope: '/remote/',
      display: 'standalone',
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
      ])
    );
  });
});
