import { describe, expect, it } from 'vitest';

import {
  hasWholeHead,
  parsePageMetadata,
  serverNameFromHeaders,
} from '../../../../src/main/services/link-preview/page-metadata';

describe('parsePageMetadata', () => {
  it('prefers Open Graph tags and resolves their URLs against the page', () => {
    const html = `<!doctype html><html><head>
      <title>Ignored title</title>
      <meta content="Fix the parser by octocat &middot; Pull Request #42 &#183; acme/demo-app" property="og:title">
      <meta property='og:site_name' content='GitHub'>
      <meta name="description" content="Plain description">
      <meta property="og:description" content="  Fixes   the &quot;parser&quot;.  ">
      <meta property="og:image" content="/og/42.png">
      <link rel="shortcut icon" href="/favicon.svg" type="image/svg+xml">
    </head><body><title>Not this</title></body></html>`;

    expect(parsePageMetadata(html, 'https://github.com/acme/demo-app/pull/42')).toEqual({
      title: 'Fix the parser by octocat · Pull Request #42 · acme/demo-app',
      documentTitle: 'Ignored title',
      siteName: 'GitHub',
      description: 'Fixes the "parser".',
      imageUrl: 'https://github.com/og/42.png',
      iconUrl: 'https://github.com/favicon.svg',
      framework: undefined,
    });
  });

  it('reads the <title> apart and ignores tags inside scripts and comments', () => {
    const html = `<head>
      <!-- <title>Commented out</title> -->
      <script>document.write('<meta property="og:title" content="From a script">')</script>
      <title>
        Acme Admin
      </title>
      <link rel="apple-touch-icon" href="touch.png">
    </head>`;

    expect(parsePageMetadata(html, 'http://localhost:5173/admin/')).toMatchObject({
      title: undefined,
      documentTitle: 'Acme Admin',
      iconUrl: 'http://localhost:5173/admin/touch.png',
    });
  });

  it('names the dev tool whose scripts the page loads', () => {
    const page = (script: string) => `<head><script type="module" src="${script}"></script></head>`;

    expect(parsePageMetadata(page('/@vite/client'), 'http://localhost:5173/').framework).toBe(
      'Vite'
    );
    expect(
      parsePageMetadata(
        `<head><script src="/@vite/client"></script><link href="/_nuxt/entry.css"></head>`,
        'http://localhost:3000/'
      ).framework
    ).toBe('Nuxt');
    expect(
      parsePageMetadata(page('/_next/static/chunks/main.js'), 'http://localhost:3000/').framework
    ).toBe('Next.js');
    expect(
      parsePageMetadata('<head></head><body>/@vite/client</body>', 'http://x/').framework
    ).toBe(undefined);
  });

  it('skips icons and images that are not web URLs', () => {
    const html = `<head><meta property="og:image" content="javascript:alert(1)"><link rel="icon" href="data:,"></head>`;

    expect(parsePageMetadata(html, 'https://example.com/')).toMatchObject({
      imageUrl: undefined,
      iconUrl: undefined,
    });
  });

  it('caps long text', () => {
    const html = `<head><title>${'a'.repeat(1000)}</title></head>`;

    expect(parsePageMetadata(html, 'https://example.com/').documentTitle).toHaveLength(300);
  });
});

describe('hasWholeHead', () => {
  it('is true once the head closes or the body starts', () => {
    expect(hasWholeHead('<head><title>x</title>')).toBe(false);
    expect(hasWholeHead('<head><title>x</title></head>')).toBe(true);
    expect(hasWholeHead('<title>x</title><body class="a">')).toBe(true);
  });
});

describe('serverNameFromHeaders', () => {
  it('names the server without its version, X-Powered-By first', () => {
    expect(serverNameFromHeaders('Next.js', 'nginx/1.25')).toBe('Next.js');
    expect(serverNameFromHeaders(undefined, 'Werkzeug/3.0.1 Python/3.12.1')).toBe('Werkzeug');
    expect(serverNameFromHeaders(undefined, 'SimpleHTTP/0.6 Python/3.12.1')).toBe(
      'Python http.server'
    );
    expect(serverNameFromHeaders(undefined, undefined)).toBeUndefined();
  });
});
