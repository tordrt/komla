const HANDSHAKE_CONTEXT = new TextEncoder().encode('komla/remote-secure-channel/v2');

export function buildHandshakeTranscript(args: {
  clientEphemeral: Uint8Array;
  desktopEphemeral: Uint8Array;
  desktopIdentity: Uint8Array;
}): Uint8Array {
  return concatLengthPrefixed([
    HANDSHAKE_CONTEXT,
    args.clientEphemeral,
    args.desktopEphemeral,
    args.desktopIdentity,
  ]);
}

export async function hashHandshakeTranscript(transcript: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', transcript as BufferSource)
  );
}

/** Each part after its length as a big-endian u32, so no two part lists encode alike. */
export function concatLengthPrefixed(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + 4 + part.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
