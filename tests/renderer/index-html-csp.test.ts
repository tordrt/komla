import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(new URL('../../src/renderer/index.html', import.meta.url), 'utf8');

function getContentSecurityPolicy(): string {
  const match = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!match) {
    throw new Error('Content-Security-Policy meta tag not found');
  }
  return match[1];
}

describe('renderer Content-Security-Policy', () => {
  it('keeps loopback dev server sources without invalid IPv6 literals', () => {
    const csp = getContentSecurityPolicy();

    expect(csp).toContain('http://localhost:*');
    expect(csp).toContain('http://127.0.0.1:*');
    expect(csp).toContain('https://localhost:*');
    expect(csp).toContain('https://127.0.0.1:*');
    expect(csp).not.toContain('[::1]');
  });

  it('only permits the preview protocol to embed PDF objects', () => {
    const csp = getContentSecurityPolicy();

    expect(csp).toContain('object-src komla-preview:');
  });
});
