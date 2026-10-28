import { describe, expect, it } from 'vitest';

import {
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  MAX_BINARY_BODY_BYTES,
  MAX_BINARY_FRAME_BYTES,
} from '../../src/wire/binary-envelope';

describe('binary envelope', () => {
  it('carries the seq, nonce and ciphertext as they are', () => {
    const envelope = {
      seq: 0xfffffffe,
      nonce: new Uint8Array(12).fill(7),
      ciphertext: new Uint8Array(40).fill(9),
    };

    expect(decodeBinaryEnvelope(encodeBinaryEnvelope(envelope))).toEqual(envelope);
  });

  it('rejects frames too short to hold a tag or longer than the limit', () => {
    expect(decodeBinaryEnvelope(new Uint8Array(4 + 12 + 16))).toBeNull();
    expect(decodeBinaryEnvelope(new Uint8Array(MAX_BINARY_FRAME_BYTES + 1))).toBeNull();
    expect(decodeBinaryEnvelope(new Uint8Array(MAX_BINARY_FRAME_BYTES))).not.toBeNull();
    expect(MAX_BINARY_BODY_BYTES).toBe(65_503);
  });
});
