import { describe, expect, it, vi } from 'vitest';

import { createLinkPreviewService } from '../../../../src/main/services/link-preview/link-preview.service';

import type { FetchedPage } from '../../../../src/main/services/link-preview/fetch-page';

type Pages = Record<string, Partial<FetchedPage> & { body?: Buffer | string }>;

function fetcher(pages: Pages) {
  return vi.fn(async (url: string) => {
    const page = pages[url];
    if (!page) return null;
    return {
      url,
      status: 200,
      contentType: 'text/html',
      ...page,
      body: Buffer.from(page.body ?? ''),
    } satisfies FetchedPage;
  });
}

const PNG = Buffer.from('png-bytes');

function setup(local: Pages, remote: Pages = {}) {
  let time = 0;
  const fetchLocally = fetcher(local);
  const remoteFetch = fetcher(remote);
  const fetchOnSshHost = vi.fn(async (_workspaceId: string, url: string) => remoteFetch(url));
  const service = createLinkPreviewService({ fetchLocally, fetchOnSshHost, now: () => time });
  return {
    service,
    fetchLocally,
    fetchOnSshHost,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const request = (url: string, extra: { pid?: number; onSshHost?: boolean } = {}) => ({
  url,
  workspaceId: 'ws-1',
  onSshHost: false,
  ...extra,
});

describe('linkPreviewService.getPreview', () => {
  it('describes a local dev server with its title, icon and tool', async () => {
    const { service } = setup({
      'http://localhost:5173/': {
        body: '<head><title>Acme Admin</title><script src="/@vite/client"></script></head>',
        server: 'nginx',
      },
      'http://localhost:5173/favicon.ico': { contentType: 'image/x-icon', body: PNG },
    });

    await expect(service.getPreview(request('http://localhost:5173/'))).resolves.toEqual({
      title: 'Acme Admin',
      iconDataUrl: `data:image/x-icon;base64,${PNG.toString('base64')}`,
      servedBy: 'Vite',
    });
  });

  it('labels a local API server that answers JSON or an error', async () => {
    const { service } = setup({
      'http://localhost:8000/': { contentType: 'application/json', server: 'uvicorn' },
      'http://localhost:4000/': { status: 404, poweredBy: 'Express', body: '<title>Error</title>' },
    });

    await expect(service.getPreview(request('http://localhost:8000/'))).resolves.toEqual({
      servedBy: 'uvicorn',
      isJson: true,
    });
    await expect(service.getPreview(request('http://localhost:4000/'))).resolves.toEqual({
      servedBy: 'Express',
    });
  });

  it("reads a local server's home page, never the printed address and its token", async () => {
    const { service, fetchLocally } = setup({
      'http://localhost:3000/': { body: '<title>Acme</title>' },
    });

    await expect(
      service.getPreview(request('http://localhost:3000/api/auth/callback/email?token=abc'))
    ).resolves.toEqual({ title: 'Acme' });
    await service.getPreview(request('http://localhost:3000/admin'));

    expect(fetchLocally.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:3000/favicon.ico',
    ]);
  });

  const githubHome = {
    'https://github.com/': {
      body: '<head><meta property="og:site_name" content="GitHub"><link rel="icon" href="/icon.png"></head>',
    },
    'https://github.com/icon.png': { contentType: 'image/png', body: PNG },
  };
  const githubSite = {
    siteName: 'GitHub',
    iconDataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    fromSite: true,
  };

  it("describes a page elsewhere without an og:title by its site's home page", async () => {
    const { service } = setup({
      ...githubHome,
      'https://github.com/acme/app/wiki': {
        body: '<head><title>Home · acme/app Wiki</title></head>',
      },
    });

    await expect(service.getPreview(request('https://github.com/acme/app/wiki'))).resolves.toEqual(
      githubSite
    );
  });

  it('describes a page that answered with an error or a sign-in page by its site', async () => {
    const { service } = setup({
      ...githubHome,
      'https://github.com/acme/private/pull/1': { status: 404, body: '<title>Not Found</title>' },
      'https://github.com/acme/settings': {
        url: 'https://github.com/login?return_to=%2Facme%2Fsettings',
        body: '<head><meta property="og:title" content="Sign in to GitHub"></head>',
      },
    });

    await expect(
      service.getPreview(request('https://github.com/acme/private/pull/1'))
    ).resolves.toEqual(githubSite);
    await expect(service.getPreview(request('https://github.com/acme/settings'))).resolves.toEqual(
      githubSite
    );
  });

  it('never loads a sign-in link, which loading could use up, only its site', async () => {
    const { service, fetchLocally } = setup({
      ...githubHome,
      'https://github.com/login/device?user_code=ABCD': { body: '<title>Device</title>' },
    });

    await expect(
      service.getPreview(request('https://github.com/login/device?user_code=ABCD'))
    ).resolves.toEqual(githubSite);
    expect(fetchLocally).not.toHaveBeenCalledWith(
      'https://github.com/login/device?user_code=ABCD',
      expect.anything()
    );
  });

  it('never loads a link meant to be opened once, only its site', async () => {
    const oneTime = [
      'https://github.com/settings/emails/verify?id=1',
      'https://github.com/acme/app/invitations/accept',
      'https://github.com/password_reset/abc123',
      'https://github.com/files/report.pdf?X-Amz-Signature=abc',
      'https://github.com/welcome?access_token=abc',
    ];
    const { service, fetchLocally } = setup({
      ...githubHome,
      ...Object.fromEntries(oneTime.map((url) => [url, { body: '<title>Page</title>' }])),
    });

    for (const url of oneTime) {
      await expect(service.getPreview(request(url))).resolves.toEqual(githubSite);
      expect(fetchLocally).not.toHaveBeenCalledWith(url, expect.anything());
    }
  });

  it('reads a site home page once for all its links', async () => {
    const { service, fetchLocally } = setup(githubHome);

    await service.getPreview(request('https://github.com/a/b/pull/1'));
    await service.getPreview(request('https://github.com/a/b/pull/2'));

    expect(fetchLocally.mock.calls.filter(([url]) => url === 'https://github.com/')).toHaveLength(
      1
    );
  });

  it('keeps Open Graph details for a page elsewhere but not what serves it', async () => {
    const { service } = setup({
      'https://example.com/post': {
        server: 'cloudflare',
        body: `<head><meta property="og:title" content="A post"><meta property="og:site_name" content="Example">
          <meta property="og:description" content="About things"><meta property="og:image" content="https://cdn.example.com/og.png">
          <link rel="icon" href="/icon.png"></head>`,
      },
      'https://example.com/icon.png': { contentType: 'image/png', body: PNG },
    });

    await expect(service.getPreview(request('https://example.com/post'))).resolves.toEqual({
      title: 'A post',
      siteName: 'Example',
      description: 'About things',
      imageUrl: 'https://cdn.example.com/og.png',
      iconDataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });

  it('reads pages elsewhere from the public internet only, and drops local images', async () => {
    const { service, fetchLocally } = setup({
      'https://example.com/post': {
        body: `<head><meta property="og:title" content="A post">
          <meta property="og:image" content="http://localhost:8080/admin/delete"></head>`,
      },
    });

    await expect(service.getPreview(request('https://example.com/post'))).resolves.toEqual({
      title: 'A post',
    });
    for (const [, options] of fetchLocally.mock.calls) {
      expect(options).toMatchObject({ publicOnly: true });
    }
  });

  it('reads a local page from this computer', async () => {
    const { service, fetchLocally } = setup({
      'http://localhost:5173/': { body: '<title>A</title>' },
    });

    await service.getPreview(request('http://localhost:5173/'));

    expect(fetchLocally).toHaveBeenCalledWith(
      'http://localhost:5173/',
      expect.objectContaining({ publicOnly: false })
    );
  });

  it('drops icons that are not images', async () => {
    const { service } = setup({
      'http://localhost:5173/': { body: '<title>App</title>' },
      // Vite answers unknown paths with the app's HTML.
      'http://localhost:5173/favicon.ico': { body: '<title>App</title>' },
    });

    await expect(service.getPreview(request('http://localhost:5173/'))).resolves.toEqual({
      title: 'App',
    });
  });

  it('reads a page on the SSH host there, without its og:image', async () => {
    const { service, fetchLocally, fetchOnSshHost } = setup(
      {},
      {
        'http://localhost:3000/': {
          body: '<head><title>Remote app</title><meta property="og:image" content="http://localhost:3000/og.png"></head>',
        },
      }
    );

    await expect(
      service.getPreview(request('http://localhost:3000/', { onSshHost: true }))
    ).resolves.toEqual({ title: 'Remote app' });
    expect(fetchOnSshHost).toHaveBeenCalledWith(
      'ws-1',
      'http://localhost:3000/',
      expect.objectContaining({ timeoutMs: 5_000 })
    );
    expect(fetchLocally).not.toHaveBeenCalled();
  });

  it('reads a local page again after a minute, or when another process serves it', async () => {
    const { service, fetchLocally, advance } = setup({
      'http://localhost:5173/': { body: '<title>App</title>' },
    });
    const pages = () =>
      fetchLocally.mock.calls.filter(([url]) => url === 'http://localhost:5173/').length;

    await service.getPreview(request('http://localhost:5173/', { pid: 10 }));
    await service.getPreview(request('http://localhost:5173/', { pid: 10 }));
    await service.getPreview(request('http://localhost:5173/'));
    expect(pages()).toBe(2);

    advance(61_000);
    await service.getPreview(request('http://localhost:5173/', { pid: 10 }));
    await service.getPreview(request('http://localhost:5173/'));
    expect(pages()).toBe(3);

    await service.getPreview(request('http://localhost:5173/', { pid: 11 }));
    expect(pages()).toBe(4);
  });

  it('asks once while a fetch is in flight and retries a failure after 30 seconds', async () => {
    const { service, fetchLocally, advance } = setup({});

    const pages = () =>
      fetchLocally.mock.calls.filter(([url]) => url === 'https://example.com/').length;

    await Promise.all([
      service.getPreview(request('https://example.com/')),
      service.getPreview(request('https://example.com/')),
    ]);
    expect(pages()).toBe(1);

    advance(31_000);
    await service.getPreview(request('https://example.com/'));
    expect(pages()).toBe(2);
  });
});

describe('linkPreviewService.getImage', () => {
  it('returns an image as a data URL and refuses anything else', async () => {
    const { service } = setup({
      'https://cdn.example.com/og.png': { contentType: 'image/png', body: PNG },
      'https://cdn.example.com/page': { body: '<html>' },
    });

    await expect(service.getImage('https://cdn.example.com/og.png')).resolves.toBe(
      `data:image/png;base64,${PNG.toString('base64')}`
    );
    await expect(service.getImage('https://cdn.example.com/page')).resolves.toBeNull();
    await expect(service.getImage('https://cdn.example.com/missing')).resolves.toBeNull();
  });

  it('reads an image elsewhere from the public internet only', async () => {
    const { service, fetchLocally } = setup({
      'https://cdn.example.com/og.png': { contentType: 'image/png', body: PNG },
      'http://localhost:5173/og.png': { contentType: 'image/png', body: PNG },
    });

    await service.getImage('https://cdn.example.com/og.png');
    await service.getImage('http://localhost:5173/og.png');

    expect(fetchLocally.mock.calls.map(([url, options]) => [url, options.publicOnly])).toEqual([
      ['https://cdn.example.com/og.png', true],
      ['http://localhost:5173/og.png', false],
    ]);
  });
});
