import { describe, expect, it } from 'vitest';

import { parsePairUrl, PairUrlError } from '../../web/src/pair-url';

const FP = 'a'.repeat(64);
const FP_MIXED = 'a'.repeat(63) + 'A';
const SECRET = 'A'.repeat(43);

describe('parsePairUrl', () => {
  it('extracts the fingerprint and origin from a well-formed pair URL', () => {
    const parsed = parsePairUrl(`https://mac.tailnet.ts.net/pair#fp=${FP}&secret=${SECRET}`);
    expect(parsed.fingerprint).toBe(FP);
    expect(parsed.pairingSecret).toBe(SECRET);
    expect(parsed.origin).toBe('https://mac.tailnet.ts.net');
  });

  it('accepts http origins for the desktop localhost server', () => {
    const parsed = parsePairUrl(`http://localhost:52864/pair#fp=${FP}&secret=${SECRET}`);
    expect(parsed.origin).toBe('http://localhost:52864');
  });

  it('tolerates extra fragment params for forward compatibility', () => {
    const parsed = parsePairUrl(`https://x.test/pair#fp=${FP}&secret=${SECRET}&v=2`);
    expect(parsed.fingerprint).toBe(FP);
  });

  it('rejects URLs with no fragment', () => {
    expectRejection('https://x.test/pair', 'missing-fragment');
  });

  it('rejects URLs with a fragment but no fp', () => {
    expectRejection(`https://x.test/pair#secret=${SECRET}`, 'missing-fp');
  });

  it('rejects URLs without a pairing secret', () => {
    expectRejection(`https://x.test/pair#fp=${FP}`, 'missing-secret');
  });

  it('rejects short pairing secrets', () => {
    expectRejection(`https://x.test/pair#fp=${FP}&secret=123456`, 'invalid-secret');
  });

  it('rejects malformed fingerprints (too short)', () => {
    expectRejection(`https://x.test/pair#fp=abc&secret=${SECRET}`, 'invalid-fingerprint');
  });

  it('rejects fingerprints with uppercase hex (the desktop emits lowercase)', () => {
    expectRejection(`https://x.test/pair#fp=${FP_MIXED}&secret=${SECRET}`, 'invalid-fingerprint');
  });

  it('rejects fingerprints with non-hex characters', () => {
    const badFp = 'g'.repeat(64);
    expectRejection(`https://x.test/pair#fp=${badFp}&secret=${SECRET}`, 'invalid-fingerprint');
  });
});

function expectRejection(href: string, expectedCode: PairUrlError['code']): void {
  expect(() => parsePairUrl(href)).toThrow(PairUrlError);
  try {
    parsePairUrl(href);
  } catch (err) {
    expect((err as PairUrlError).code).toBe(expectedCode);
  }
}
