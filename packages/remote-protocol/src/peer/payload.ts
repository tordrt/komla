// Application payload tagging.
//
// Inside an `e2e:enc` frame, the AES-GCM plaintext is `[ tag(1) | bytes ]` —
// the tag tells the receiver which `onMessage` shape to deliver. This keeps
// the wire envelope opaque to the relay (no JSON-vs-binary marker leaks
// outside the encrypted payload) while letting the Peer expose a typed
// callback.

export const PAYLOAD_JSON = 0x01;
export const PAYLOAD_BINARY = 0x02;

export type PayloadTag = typeof PAYLOAD_JSON | typeof PAYLOAD_BINARY;

/**
 * Wrap an outbound payload with its tag byte. `kind` is required so callers
 * commit to one shape — there's no auto-detect.
 */
export function tagPayload(kind: PayloadTag, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = kind;
  out.set(body, 1);
  return out;
}

export interface DecodedJsonMessage {
  kind: 'json';
  data: unknown;
}

export interface DecodedBinaryMessage {
  kind: 'binary';
  data: Uint8Array;
}

export type DecodedMessage = DecodedJsonMessage | DecodedBinaryMessage;

/**
 * Inverse of {@link tagPayload}. Returns `null` if the tag byte is unknown
 * or the JSON body fails to parse — the Peer treats both as a session-fatal
 * protocol violation since either implies a sender/receiver disagreement
 * about the payload format.
 */
export function decodePayload(plaintext: Uint8Array): DecodedMessage | null {
  if (plaintext.length === 0) return null;
  const tag = plaintext[0];
  const body = plaintext.subarray(1);
  if (tag === PAYLOAD_JSON) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      return { kind: 'json', data: JSON.parse(text) };
    } catch {
      return null;
    }
  }
  if (tag === PAYLOAD_BINARY) {
    // Copy out of the larger buffer so the caller doesn't hold a reference
    // to the ciphertext-sized allocation.
    return { kind: 'binary', data: new Uint8Array(body) };
  }
  return null;
}
