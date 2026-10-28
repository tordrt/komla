// Browser-side WebAuthn helpers — pure conversions between the JSON shapes
// the desktop pair-mode service sends/expects and the ArrayBuffer-typed
// fields `navigator.credentials.create()` consumes/returns.
//
// Kept in their own module so they can be unit-tested without a DOM. The
// helpers only depend on globals available in both browsers and Node 18+
// (`atob`, `btoa`, `Uint8Array`, `ArrayBuffer`).

// TS 5.7+ types `new Uint8Array(N)` as `Uint8Array<ArrayBuffer>` — the more
// specific generic that satisfies WebAuthn's `BufferSource` parameter type.
// Returning that branded type lets call sites assign directly into
// `PublicKeyCredentialCreationOptions` without casts.
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(std);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// `navigator.credentials.create()` returns ArrayBuffer-typed fields. We
// transcribe them into the JSON shape `@simplewebauthn/server.verifyRegistrationResponse`
// expects (RegistrationResponseJSON), which the desktop parses with our
// `PairRegistrationResponseSchema`.
export function attestationToJSON(cred: PublicKeyCredential): Record<string, unknown> {
  const response = cred.response as AuthenticatorAttestationResponse & {
    getTransports?: () => string[];
  };
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
  return {
    id: cred.id,
    rawId: bytesToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      attestationObject: bytesToBase64Url(response.attestationObject),
      transports,
    },
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

/**
 * Same shape transformation for `navigator.credentials.get()` results — the
 * desktop verifies these with `verifyAuthenticationResponse`. `userHandle`
 * is the per-credential install-fingerprint binding the registration set;
 * we surface it raw here so callers can recover the fingerprint without a
 * second WebAuthn round-trip.
 */
export function assertionToJSON(cred: PublicKeyCredential): Record<string, unknown> {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      signature: bytesToBase64Url(response.signature),
      userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : undefined,
    },
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

/** Decode the userHandle bytes (set by registration to base64url(install-fp-hex))
 *  back to the lowercase 64-hex install fingerprint. Returns null if the
 *  shape doesn't match a 32-byte / 64-hex value. */
export function userHandleToFingerprint(userHandle: ArrayBuffer | Uint8Array): string | null {
  const bytes = userHandle instanceof Uint8Array ? userHandle : new Uint8Array(userHandle);
  if (bytes.length !== 32) return null;
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}
