// Standard base64 (RFC 4648 §4): `+`/`/` alphabet, padding `=` required.
// Both peers use this codec, so a frame produced on one side parses on the
// other. Not base64url.

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode standard-alphabet base64. Returns `null` on any malformed input
 * (wrong alphabet, bad padding, non-multiple-of-4 length, atob throw).
 *
 * Stricter than raw `atob`: rejects unpadded input and base64url, so a
 * malformed wire frame surfaces as a parse error rather than a misleading
 * downstream auth/decrypt failure.
 */
export function decodeBase64(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
