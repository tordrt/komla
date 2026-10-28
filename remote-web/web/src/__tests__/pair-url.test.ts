import { describe, expect, it } from 'vitest';

import { pastedPairUrl } from '../pair-url';

const origin = 'https://desk.tail1.ts.net';
const link = `${origin}/remote/pair#fp=${'a'.repeat(64)}&secret=${'b'.repeat(43)}`;

describe('pastedPairUrl', () => {
  it('accepts a pairing link for this page, trimming what the clipboard added', () => {
    expect(pastedPairUrl(`  ${link}\n`, origin)).toBe(link);
  });

  it('refuses text that is not a pairing link for this desktop', () => {
    const code = (text: string) => {
      try {
        pastedPairUrl(text, origin);
        return null;
      } catch (err) {
        return (err as { code: string }).code;
      }
    };
    expect(code('Komla pairing')).toBe('not-a-link');
    expect(code(link.replace(origin, 'https://other.tail1.ts.net'))).toBe('other-origin');
    expect(code(link.replace('/remote/pair', '/remote/'))).toBe('other-origin');
    expect(code(`${origin}/remote/pair#fp=${'a'.repeat(64)}`)).toBe('missing-secret');
  });
});
