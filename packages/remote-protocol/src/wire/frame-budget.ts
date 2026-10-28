// What fits in one encrypted frame.
//
// A receiver ends the session on a text frame longer than MAX_FRAME_CHARS, so
// every sender sizes a frame before it spends a sequence number on it, and
// splits what does not fit. Sizes count encoded bytes, not characters: a CJK
// character is 3 UTF-8 bytes, and an ESC becomes the 6-byte `\u001b` in JSON,
// before base64 grows the ciphertext by a third.

import { MAX_FRAME_CHARS } from './messages';

const AEAD_TAG_BYTES = 16;
const PAYLOAD_TAG_BYTES = 1;

/** The `e2e:enc` envelope around an empty ciphertext, at the longest seq. */
const TEXT_ENVELOPE_CHARS = JSON.stringify({
  type: 'e2e:enc',
  seq: 0xffffffff,
  nonce: 'A'.repeat(16),
  ciphertext: '',
}).length;

/** The largest payload body (JSON bytes, or raw bytes) one text frame carries. */
export const MAX_ENCRYPTED_BODY_BYTES =
  Math.floor((MAX_FRAME_CHARS - TEXT_ENVELOPE_CHARS) / 4) * 3 - AEAD_TAG_BYTES - PAYLOAD_TAG_BYTES;

/** A frame was refused before sending because it would not fit; the session is unaffected. */
export class FrameTooLargeError extends Error {
  constructor(
    readonly bodyBytes: number,
    readonly maxBodyBytes: number
  ) {
    super(`frame of ${bodyBytes} bytes exceeds the ${maxBodyBytes}-byte limit`);
    this.name = 'FrameTooLargeError';
  }
}

/** UTF-8 bytes of `value` once serialized with `JSON.stringify`. */
export function encodedJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** UTF-8 bytes one UTF-16 code unit adds inside a JSON string, or 0 for a pair's low half. */
function codeUnitBytes(text: string, index: number): number {
  const unit = text.charCodeAt(index);
  if (unit === 0x22 || unit === 0x5c) return 2; // \" and \\
  if (unit < 0x20) {
    // \b \t \n \f \r; every other control character is \u00XX.
    return unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d
      ? 2
      : 6;
  }
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    // A surrogate pair is one 4-byte character; a lone surrogate is escaped as \uXXXX.
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6;
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    const previous = text.charCodeAt(index - 1);
    return previous >= 0xd800 && previous <= 0xdbff ? 0 : 6;
  }
  return 3;
}

/** UTF-8 bytes of `text` inside a JSON string, without the quotes. */
export function jsonStringBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) bytes += codeUnitBytes(text, index);
  return bytes;
}

/**
 * Splits `text` into pieces of at most `maxBytes` JSON-string bytes each,
 * never between the halves of a surrogate pair. Returns `[text]` when it fits.
 */
export function splitJsonString(text: string, maxBytes: number): string[] {
  if (maxBytes < 6) throw new RangeError(`maxBytes must be at least 6, got ${maxBytes}`);
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const add = codeUnitBytes(text, index);
    if (bytes + add > maxBytes) {
      pieces.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += add;
    // Keep a surrogate pair's low half with its high half.
    if (add === 4) index++;
  }
  pieces.push(text.slice(start));
  return pieces;
}
