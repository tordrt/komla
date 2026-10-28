import { describe, expect, it } from 'vitest';

import {
  encodedJsonBytes,
  jsonStringBytes,
  MAX_ENCRYPTED_BODY_BYTES,
  splitJsonString,
} from '../../src/wire/frame-budget';

const SAMPLES = [
  'plain ascii',
  '漢字かな交じり文',
  '\x1b[31mred\x1b[0m\r\n',
  'quote " and backslash \\',
  'emoji 😀 and 👩‍💻',
  'lone \ud800 high and \udc00 low',
  '  \x7f\x00',
];

describe('frame budget', () => {
  it('counts the bytes JSON.stringify produces for a string', () => {
    for (const sample of SAMPLES) {
      expect(jsonStringBytes(sample)).toBe(encodedJsonBytes(sample) - 2);
    }
  });

  it('splits text into pieces that each fit and rejoin to the original', () => {
    const text = SAMPLES.join('').repeat(400);
    for (const maxBytes of [6, 7, 64, 1000]) {
      const pieces = splitJsonString(text, maxBytes);
      expect(pieces.join('')).toBe(text);
      for (const piece of pieces) expect(jsonStringBytes(piece)).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('never splits a surrogate pair', () => {
    const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
    const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
    const pieces = splitJsonString('a😀'.repeat(100), 7);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(isHigh(piece.charCodeAt(piece.length - 1))).toBe(false);
      expect(isLow(piece.charCodeAt(0))).toBe(false);
    }
  });

  it('returns text that fits unchanged', () => {
    expect(splitJsonString('short', 100)).toEqual(['short']);
    expect(splitJsonString('', 100)).toEqual(['']);
  });

  it('leaves room in a frame for the largest body it allows', () => {
    // 64 Ki wire characters minus the envelope, base64 and the AES-GCM tag.
    expect(MAX_ENCRYPTED_BODY_BYTES).toBe(49_075);
  });
});
