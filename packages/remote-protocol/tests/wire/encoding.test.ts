import { describe, it, expect } from 'vitest';

import { decodeBase64, encodeBase64 } from '../../src/wire/encoding';

describe('base64 encoding', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x80, 0xab]);
    const encoded = encodeBase64(bytes);
    const decoded = decodeBase64(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('produces standard alphabet (no -, _) and required padding', () => {
    expect(encodeBase64(new Uint8Array([0xff]))).toBe('/w==');
    expect(encodeBase64(new Uint8Array([0xff, 0xff]))).toBe('//8=');
    expect(encodeBase64(new Uint8Array([0xff, 0xff, 0xff]))).toBe('////');
  });

  describe('decodeBase64 strictness', () => {
    it('rejects empty input', () => {
      expect(decodeBase64('')).toBeNull();
    });

    it('rejects non-multiple-of-4 length', () => {
      expect(decodeBase64('AAA')).toBeNull();
      expect(decodeBase64('AAAAA')).toBeNull();
    });

    it('rejects base64url alphabet', () => {
      expect(decodeBase64('AA-A')).toBeNull();
      expect(decodeBase64('AA_A')).toBeNull();
    });

    it('rejects misplaced padding', () => {
      expect(decodeBase64('AA=A')).toBeNull();
      expect(decodeBase64('A===')).toBeNull();
    });

    it('rejects characters outside the alphabet', () => {
      expect(decodeBase64('!@#$')).toBeNull();
      expect(decodeBase64('AAAA AAAA'.replace(' ', ''))).not.toBeNull(); // sanity: real one ok
    });

    it('accepts canonical padded forms', () => {
      expect(decodeBase64('/w==')).toEqual(new Uint8Array([0xff]));
      expect(decodeBase64('//8=')).toEqual(new Uint8Array([0xff, 0xff]));
      expect(decodeBase64('////')).toEqual(new Uint8Array([0xff, 0xff, 0xff]));
    });
  });
});
