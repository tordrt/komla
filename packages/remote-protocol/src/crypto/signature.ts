// ECDSA-P256 / SHA-256 verification, IEEE-P1363 signature encoding.
//
// Algorithm-pinned: a non-P256 SPKI fails at importKey and we return false. We
// don't try other curves, and we don't accept DER-encoded signatures — the
// desktop's signing path produces P1363 (`dsaEncoding: 'ieee-p1363'`), and
// every consumer of this package is paired with that signer.
//
// Returns false rather than throwing on malformed input so callers can use it
// as a yes/no admission gate without try/catch boilerplate.

export async function verifySignature(
  data: Uint8Array,
  signature: Uint8Array,
  spkiDer: Uint8Array
): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'spki',
      spkiDer as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature as BufferSource,
      data as BufferSource
    );
  } catch {
    return false;
  }
}
