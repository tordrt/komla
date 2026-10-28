// Unit tests for HtmlPreviewService. Uses a real temp directory so symlink
// containment behavior is exercised against the actual filesystem rather than
// a mocked fs layer (the symlink-escape defense is the whole point of the
// realpath check, so mocking that out would defeat the test).

import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

const fonts = vi.hoisted(() => ({ paths: {} as Record<string, string> }));
vi.mock('../../../src/main/lib/bundled-fonts', () => ({
  bundledFontPath: (name: string) => fonts.paths[name] ?? null,
}));

const { protocol } = (await import('electron')) as unknown as {
  protocol: { handle: ReturnType<typeof vi.fn> };
};

import {
  HtmlPreviewService,
  HTML_PREVIEW_PROTOCOL_SCHEME,
} from '../../../src/main/services/html-preview.service';

type ProtocolHandler = (request: Request) => Promise<Response>;

function makeServiceWithHandler(): { service: HtmlPreviewService; handler: ProtocolHandler } {
  let handler: ProtocolHandler | null = null;
  protocol.handle.mockImplementation((_scheme: string, fn: ProtocolHandler) => {
    handler = fn;
  });
  const service = new HtmlPreviewService();
  service.registerProtocolHandler();
  if (!handler) throw new Error('protocol.handle was not called');
  return { service, handler };
}

function urlFor(token: string, path = ''): string {
  return `${HTML_PREVIEW_PROTOCOL_SCHEME}://${token}/${path}`;
}

function tokenFromUrl(url: string): string {
  return new URL(url).hostname;
}

describe('HtmlPreviewService', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-html-preview-'));
    writeFileSync(join(root, 'index.html'), '<html><body>hi</body></html>');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'app.css'), 'body{}');
    writeFileSync(join(root, 'document.pdf'), '%PDF-1.7');
    writeFileSync(join(root, '.env'), 'SECRET=value');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    protocol.handle.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('createPreviewUrl', () => {
    it('returns a komla-preview URL with a UUID hostname and encoded path', async () => {
      const { service } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const parsed = new URL(url);
      expect(parsed.protocol).toBe(`${HTML_PREVIEW_PROTOCOL_SCHEME}:`);
      expect(parsed.hostname).toMatch(/^[0-9a-f-]{36}$/);
      expect(parsed.pathname).toBe('/index.html');
    });

    it('rejects entry paths that escape the root', async () => {
      const { service } = makeServiceWithHandler();
      await expect(service.createPreviewUrl(root, '../etc/passwd')).rejects.toThrow();
    });

    it('rejects entry paths containing a dotfile segment', async () => {
      const { service } = makeServiceWithHandler();
      await expect(service.createPreviewUrl(root, '.env')).rejects.toThrow(/hidden file/);
      await expect(service.createPreviewUrl(root, '.git/config')).rejects.toThrow(/hidden file/);
    });

    it('accepts absolute entry paths when the root is under a hidden parent', async () => {
      const hiddenParent = mkdtempSync(join(tmpdir(), '.komla-html-preview-parent-'));
      const hiddenRoot = join(hiddenParent, 'repo');
      mkdirSync(hiddenRoot);
      writeFileSync(join(hiddenRoot, 'index.html'), '<html><body>ok</body></html>');
      try {
        const { service } = makeServiceWithHandler();
        const url = await service.createPreviewUrl(hiddenRoot, join(hiddenRoot, 'index.html'));

        expect(new URL(url).pathname).toBe('/index.html');
      } finally {
        rmSync(hiddenParent, { recursive: true, force: true });
      }
    });

    it('still rejects relative dotfile entry paths under hidden parents', async () => {
      const hiddenParent = mkdtempSync(join(tmpdir(), '.komla-html-preview-parent-'));
      const hiddenRoot = join(hiddenParent, 'repo');
      mkdirSync(hiddenRoot);
      writeFileSync(join(hiddenRoot, '.env'), 'SECRET=value');
      try {
        const { service } = makeServiceWithHandler();

        await expect(service.createPreviewUrl(hiddenRoot, '.env')).rejects.toThrow(/hidden file/);
      } finally {
        rmSync(hiddenParent, { recursive: true, force: true });
      }
    });
  });

  describe('createContentPreviewUrl', () => {
    it('serves self-contained HTML without exposing neighboring files', async () => {
      const { service, handler } = makeServiceWithHandler();
      const html = '<html><style>body{color:red}</style><body>Remote report</body></html>';
      const url = await service.createContentPreviewUrl('.komla-files/report.html', html);

      const response = await handler(new Request(url));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const assetResponse = await handler(
        new Request(new URL('neighbor.js', url).toString(), {
          headers: { accept: 'text/javascript' },
        })
      );
      expect(assetResponse.status).toBe(404);
    });

    it('serves a PDF from its bytes', async () => {
      const { service, handler } = makeServiceWithHandler();
      const pdf = Buffer.from('%PDF-1.4 remote paper');
      const url = await service.createContentPreviewUrl('paper.pdf', pdf);

      const response = await handler(new Request(url));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf);
      expect(response.headers.get('content-type')).toBe('application/pdf');
    });

    it('serves an SVG from its text', async () => {
      const { service, handler } = makeServiceWithHandler();
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>';
      const url = await service.createContentPreviewUrl('diagram.svg', svg);

      const response = await handler(new Request(url));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(svg);
      expect(response.headers.get('content-type')).toBe('image/svg+xml');
    });

    it('replaces the page made with the same key, keeping the one on screen while it loads', async () => {
      const { service, handler } = makeServiceWithHandler();
      const first = await service.createContentPreviewUrl('popover.html', 'one', { key: 'pr' });
      const other = await service.createContentPreviewUrl('popover.html', 'other', { key: 'ci' });
      const second = await service.createContentPreviewUrl('popover.html', 'two', { key: 'pr' });

      expect(await (await handler(new Request(first))).text()).toBe('one');
      expect(await (await handler(new Request(second))).text()).toBe('two');

      const third = await service.createContentPreviewUrl('popover.html', 'three', { key: 'pr' });
      expect((await handler(new Request(first))).status).toBe(404);
      expect(await (await handler(new Request(second))).text()).toBe('two');
      expect(await (await handler(new Request(third))).text()).toBe('three');
      expect(await (await handler(new Request(other))).text()).toBe('other');
    });

    it("serves Komla's fonts, cross-origin, only to pages that may load them", async () => {
      const { service, handler } = makeServiceWithHandler();
      writeFileSync(join(root, 'Geist.woff2'), 'font bytes');
      fonts.paths = { 'geist.woff2': join(root, 'Geist.woff2') };
      const withFonts = await service.createContentPreviewUrl('popover.html', '<p>hi</p>', {
        fonts: true,
      });
      const without = await service.createContentPreviewUrl('report.html', '<p>hi</p>');

      const font = await handler(new Request(new URL('/__komla/fonts/geist.woff2', withFonts)));
      expect(font.status).toBe(200);
      expect(await font.text()).toBe('font bytes');
      expect(font.headers.get('content-type')).toBe('font/woff2');
      expect(font.headers.get('access-control-allow-origin')).toBe('*');
      expect(
        (await handler(new Request(new URL('/__komla/fonts/other.ttf', withFonts)))).status
      ).toBe(404);
      expect(
        (await handler(new Request(new URL('/__komla/fonts/geist.woff2', without)))).status
      ).toBe(404);
    });

    it('rejects other types and escaping entry paths', async () => {
      const { service } = makeServiceWithHandler();

      await expect(service.createContentPreviewUrl('report.png', 'png')).rejects.toThrow(
        /HTML, SVG or PDF entry path/
      );
      await expect(service.createContentPreviewUrl('../report.html', '<html />')).rejects.toThrow(
        /escapes/
      );
    });
  });

  describe('handler — serving files', () => {
    it('serves the entry HTML at the root path', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(new Request(urlFor(tokenFromUrl(url))));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toContain('<html>');
    });

    it('serves a subdirectory asset with the correct MIME type', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(new Request(urlFor(tokenFromUrl(url), 'assets/app.css')));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
      expect(await response.text()).toBe('body{}');
    });

    it('serves PDFs with the MIME type required by Chromium PDF viewer', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'document.pdf');
      const response = await handler(new Request(url));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/pdf');
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
      expect(response.headers.get('Content-Length')).toBe('8');
      expect(await response.text()).toBe('%PDF-1.7');
    });

    it('streams only the requested PDF byte range', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'document.pdf');
      const response = await handler(
        new Request(url, {
          headers: { range: 'bytes=1-4' },
        })
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 1-4/8');
      expect(response.headers.get('Content-Length')).toBe('4');
      expect(await response.text()).toBe('PDF-');
    });

    it('rejects unsatisfiable PDF byte ranges', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'document.pdf');
      const response = await handler(
        new Request(url, {
          headers: { range: 'bytes=100-200' },
        })
      );

      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */8');
    });

    it('falls back to the entry directory for missing root-relative assets', async () => {
      mkdirSync(join(root, 'dist'));
      mkdirSync(join(root, 'dist', 'assets'));
      writeFileSync(
        join(root, 'dist', 'index.html'),
        '<link rel="stylesheet" href="/assets/app.css">'
      );
      writeFileSync(join(root, 'dist', 'assets', 'nested.css'), '.nested{}');

      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'dist/index.html');
      const response = await handler(
        new Request(urlFor(tokenFromUrl(url), 'assets/nested.css'), {
          headers: { accept: 'text/css,*/*' },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
      expect(await response.text()).toBe('.nested{}');
    });

    it('prefers workspace-root assets over the entry-directory fallback', async () => {
      mkdirSync(join(root, 'dist'));
      mkdirSync(join(root, 'dist', 'assets'));
      writeFileSync(
        join(root, 'dist', 'index.html'),
        '<link rel="stylesheet" href="/assets/app.css">'
      );
      writeFileSync(join(root, 'dist', 'assets', 'app.css'), '.nested{}');

      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'dist/index.html');
      const response = await handler(
        new Request(urlFor(tokenFromUrl(url), 'assets/app.css'), {
          headers: { accept: 'text/css,*/*' },
        })
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('body{}');
    });

    it('serves index.html when a directory is requested', async () => {
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'index.html'), '<p>sub</p>');
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(new Request(urlFor(tokenFromUrl(url), 'sub/')));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<p>sub</p>');
    });

    it('falls back to the entry HTML for SPA navigation requests', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(
        new Request(urlFor(tokenFromUrl(url), 'unknown/route'), {
          headers: { accept: 'text/html' },
        })
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<html>');
    });

    it('404s missing assets for non-navigation requests', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(
        new Request(urlFor(tokenFromUrl(url), 'missing.js'), {
          headers: { accept: '*/*' },
        })
      );
      expect(response.status).toBe(404);
    });

    it('lets a page load from https: sites, never http: or ws:, unless it is kept offline', async () => {
      const { service, handler } = makeServiceWithHandler();
      const csp = async (url: string) =>
        (await handler(new Request(urlFor(tokenFromUrl(url))))).headers.get(
          'Content-Security-Policy'
        ) ?? '';

      for (const url of [
        await service.createPreviewUrl(root, 'index.html'),
        await service.createContentPreviewUrl('report.html', '<p>hi</p>', { web: true }),
      ]) {
        const policy = await csp(url);
        expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' https:");
        expect(policy).toContain("connect-src 'self' https: wss:");
        expect(policy).toContain("frame-src 'self'");
        expect(policy).not.toMatch(/http:|ws:/);
      }
      const offline = await csp(await service.createContentPreviewUrl('popover.html', '<p>hi</p>'));
      expect(offline).toContain("connect-src 'self';");
      expect(offline).not.toMatch(/https:|http:|wss:|ws:/);
    });
  });

  describe('handler — security boundaries', () => {
    it('404s requests with an unknown token', async () => {
      const { handler } = makeServiceWithHandler();
      const response = await handler(new Request(urlFor('not-a-real-token', 'index.html')));
      expect(response.status).toBe(404);
    });

    it('404s percent-encoded traversal attempts', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(
        new Request(`${urlFor(tokenFromUrl(url))}%2e%2e/%2e%2e/etc/passwd`)
      );
      expect(response.status).toBe(404);
    });

    it('refuses to serve dotfiles like .env', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(
        new Request(urlFor(tokenFromUrl(url), '.env'), {
          headers: { accept: '*/*' },
        })
      );
      expect(response.status).toBe(404);
    });

    it('refuses to serve files inside .git', async () => {
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(
        new Request(urlFor(tokenFromUrl(url), '.git/config'), {
          headers: { accept: '*/*' },
        })
      );
      expect(response.status).toBe(404);
    });

    it.skipIf(platform() === 'win32')('blocks symlinks that escape the worktree root', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'komla-html-preview-outside-'));
      try {
        writeFileSync(join(outsideDir, 'secret'), 'id_rsa-equivalent');
        symlinkSync(join(outsideDir, 'secret'), join(root, 'leak'));

        const { service, handler } = makeServiceWithHandler();
        const url = await service.createPreviewUrl(root, 'index.html');
        const response = await handler(
          new Request(urlFor(tokenFromUrl(url), 'leak'), {
            headers: { accept: '*/*' },
          })
        );
        expect(response.status).toBe(404);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it.skipIf(platform() === 'win32')(
      'blocks intra-root symlinks that resolve to a dotfile',
      async () => {
        // A symlink like `public-env -> .env` stays inside realRootPath, so
        // the lexical containment check passes; the dotfile rule must be
        // re-applied to the canonical path to catch this.
        symlinkSync(join(root, '.env'), join(root, 'public-env'));
        const { service, handler } = makeServiceWithHandler();
        const url = await service.createPreviewUrl(root, 'index.html');
        const response = await handler(
          new Request(urlFor(tokenFromUrl(url), 'public-env'), {
            headers: { accept: '*/*' },
          })
        );
        expect(response.status).toBe(404);
      }
    );

    it.skipIf(platform() === 'win32')(
      'blocks intra-root symlinks that resolve into .git',
      async () => {
        symlinkSync(join(root, '.git', 'config'), join(root, 'git-config'));
        const { service, handler } = makeServiceWithHandler();
        const url = await service.createPreviewUrl(root, 'index.html');
        const response = await handler(
          new Request(urlFor(tokenFromUrl(url), 'git-config'), {
            headers: { accept: '*/*' },
          })
        );
        expect(response.status).toBe(404);
      }
    );

    it('serves intra-root symlinks (canonicalized via realpath)', async () => {
      writeFileSync(join(root, 'real.css'), '.real{}');
      symlinkSync(join(root, 'real.css'), join(root, 'alias.css'));
      const { service, handler } = makeServiceWithHandler();
      const url = await service.createPreviewUrl(root, 'index.html');
      const response = await handler(
        new Request(urlFor(tokenFromUrl(url), 'alias.css'), {
          headers: { accept: '*/*' },
        })
      );
      // On platforms where symlink creation is restricted (or filesystem
      // doesn't support it) the symlinkSync would have thrown earlier; if we
      // got here, the alias must resolve successfully.
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('.real{}');
    });
  });

  describe('attachNavigationGuard', () => {
    type FakeWebContents = EventEmitter & {
      emitNav: (fromUrl: string, toUrl: string) => { defaultPrevented: boolean };
    };

    function makeFakeWebContents(): FakeWebContents {
      const emitter = new EventEmitter() as FakeWebContents;
      emitter.emitNav = (fromUrl, toUrl) => {
        let defaultPrevented = false;
        emitter.emit('will-frame-navigate', {
          url: toUrl,
          frame: { url: fromUrl },
          preventDefault: () => {
            defaultPrevented = true;
          },
        });
        return { defaultPrevented };
      };
      return emitter;
    }

    it('blocks navigations from a komla-preview frame to an external URL', () => {
      const { service } = makeServiceWithHandler();
      const wc = makeFakeWebContents();
      service.attachNavigationGuard(wc);

      const { defaultPrevented } = wc.emitNav(
        `${HTML_PREVIEW_PROTOCOL_SCHEME}://abc/index.html`,
        'https://evil.example.com/?leak=secret'
      );
      expect(defaultPrevented).toBe(true);
    });

    it('blocks navigations to data: and about: URLs from a preview frame', () => {
      const { service } = makeServiceWithHandler();
      const wc = makeFakeWebContents();
      service.attachNavigationGuard(wc);

      expect(
        wc.emitNav(`${HTML_PREVIEW_PROTOCOL_SCHEME}://abc/index.html`, 'data:text/html,x')
          .defaultPrevented
      ).toBe(true);
      expect(
        wc.emitNav(`${HTML_PREVIEW_PROTOCOL_SCHEME}://abc/index.html`, 'about:blank')
          .defaultPrevented
      ).toBe(true);
    });

    it('allows in-protocol navigation between komla-preview URLs', () => {
      const { service } = makeServiceWithHandler();
      const wc = makeFakeWebContents();
      service.attachNavigationGuard(wc);

      const { defaultPrevented } = wc.emitNav(
        `${HTML_PREVIEW_PROTOCOL_SCHEME}://abc/index.html`,
        `${HTML_PREVIEW_PROTOCOL_SCHEME}://abc/other.html`
      );
      expect(defaultPrevented).toBe(false);
    });

    it('allows the initial src load when the frame is at about:blank', () => {
      const { service } = makeServiceWithHandler();
      const wc = makeFakeWebContents();
      service.attachNavigationGuard(wc);

      const { defaultPrevented } = wc.emitNav(
        'about:blank',
        `${HTML_PREVIEW_PROTOCOL_SCHEME}://abc/index.html`
      );
      expect(defaultPrevented).toBe(false);
    });

    it('does not interfere with navigations from non-preview frames', () => {
      const { service } = makeServiceWithHandler();
      const wc = makeFakeWebContents();
      service.attachNavigationGuard(wc);

      const { defaultPrevented } = wc.emitNav('file:///app/index.html', 'https://example.com/');
      expect(defaultPrevented).toBe(false);
    });
  });

  describe('handler — session expiry', () => {
    it('evicts content sessions when their TTL elapses without another request', async () => {
      vi.useFakeTimers();
      try {
        const createdAt = new Date('2026-08-18T10:00:00Z');
        vi.setSystemTime(createdAt);
        const { service, handler } = makeServiceWithHandler();
        const url = await service.createContentPreviewUrl('report.html', '<html>report</html>');

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        vi.setSystemTime(createdAt);

        const response = await handler(new Request(url));
        expect(response.status).toBe(404);
      } finally {
        vi.useRealTimers();
      }
    });

    it('404s requests after the session TTL has elapsed', async () => {
      vi.useFakeTimers();
      try {
        const { service, handler } = makeServiceWithHandler();
        const url = await service.createPreviewUrl(root, 'index.html');
        vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
        const response = await handler(new Request(urlFor(tokenFromUrl(url))));
        expect(response.status).toBe(404);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
