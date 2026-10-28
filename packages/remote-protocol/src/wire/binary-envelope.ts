// Binary encrypted frames, used once both peers list the binary-frames capability: the same
// seq, nonce and AES-GCM ciphertext as an `e2e:enc` text frame, without the JSON and base64
// around them. Layout: `[ seq u32 BE | nonce(12) | ciphertext ]`.

import { NONCE_BYTES } from '../crypto/aead';

/** Receivers drop a longer binary frame and end the session. */
export const MAX_BINARY_FRAME_BYTES = 65536;

const SEQ_BYTES = 4;
const AEAD_TAG_BYTES = 16;
const PAYLOAD_TAG_BYTES = 1;
const HEADER_BYTES = SEQ_BYTES + NONCE_BYTES;

/** The largest payload body one binary frame carries. */
export const MAX_BINARY_BODY_BYTES =
  MAX_BINARY_FRAME_BYTES - HEADER_BYTES - AEAD_TAG_BYTES - PAYLOAD_TAG_BYTES;

export interface BinaryEnvelope {
  seq: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function encodeBinaryEnvelope({ seq, nonce, ciphertext }: BinaryEnvelope): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + ciphertext.length);
  new DataView(frame.buffer).setUint32(0, seq);
  frame.set(nonce, SEQ_BYTES);
  frame.set(ciphertext, HEADER_BYTES);
  return frame;
}

/** Null for a frame that is too large or too short to hold a tag and a payload. */
export function decodeBinaryEnvelope(frame: Uint8Array): BinaryEnvelope | null {
  if (frame.length > MAX_BINARY_FRAME_BYTES) return null;
  if (frame.length < HEADER_BYTES + AEAD_TAG_BYTES + PAYLOAD_TAG_BYTES) return null;
  return {
    seq: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0),
    nonce: frame.slice(SEQ_BYTES, HEADER_BYTES),
    ciphertext: frame.slice(HEADER_BYTES),
  };
}
