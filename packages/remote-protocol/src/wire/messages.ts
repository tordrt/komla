// Wire-format message envelopes for the end-to-end encrypted channel.
//
// Three frame types travel between desktop and client through the relay:
//
//   e2e:offer  — client's ephemeral ECDH pubkey (sent first by the client)
//   e2e:answer — desktop's ephemeral ECDH pubkey + install pubkey + signature
//                over `clientEphemSPKI ‖ desktopEphemSPKI` (sent in reply)
//   e2e:enc    — opaque encrypted application frame (after handshake)
//
// All frames are JSON text with binary fields carried as standard base64
// (RFC 4648 §4) — same convention as the slice 2 admission protocol so a
// frame produced by either side parses on the other.
//
// The relay parses `e2e:offer` and `e2e:answer` only, to wire the two peers
// together. Encrypted frames pass through opaquely; the relay can never
// decrypt them.

import { z } from 'zod';

import { decodeBase64 } from './encoding';

/**
 * Hard cap on inbound text frame size (UTF-16 code units, what `string.length`
 * returns). Handshake frames are well under 1 KB; encrypted application
 * frames need headroom for the pair-ceremony WebAuthn attestation, which
 * with `attestationType: 'none'` lands around 1 KB but can grow to a few KB
 * with extension outputs. 64 KB bounds memory while leaving room.
 */
export const MAX_FRAME_CHARS = 65536;

const Base64String = z
  .string()
  .min(4)
  .refine((s) => decodeBase64(s) !== null, { message: 'invalid base64' });

// Each envelope is `.strict()` so unknown fields are rejected, not silently
// stripped. Without this, a future protocol revision that adds a field could
// be quietly ignored by older peers, creating downgrade ambiguity. Fail
// closed at the wire boundary instead.
export const E2EOfferSchema = z
  .object({
    type: z.literal('e2e:offer'),
    /** base64 of the SPKI-DER P-256 ephemeral public key (91 bytes plain). */
    ephemeralPubkey: Base64String,
  })
  .strict();

export const E2EAnswerSchema = z
  .object({
    type: z.literal('e2e:answer'),
    /** base64 of the SPKI-DER P-256 ephemeral public key. */
    ephemeralPubkey: Base64String,
    /** base64 of the SPKI-DER install (long-term) public key. */
    installPubkey: Base64String,
    /**
     * base64 IEEE-P1363 ECDSA-P256/SHA-256 signature over the bytes
     * `clientEphemSPKI ‖ desktopEphemSPKI` (plain concat — both 91 bytes).
     */
    signature: Base64String,
  })
  .strict();

export const E2EEncSchema = z
  .object({
    type: z.literal('e2e:enc'),
    /**
     * 32-bit unsigned, consecutive per direction. Receiver must reject
     * anything other than its `lastReceivedSeq` counter plus one.
     * Carried in clear so the receiver can drop replayed/reordered frames
     * before attempting decryption (an out-of-order frame would still fail
     * AES-GCM, but the seq check is cheaper and surfaces the violation
     * unambiguously).
     */
    seq: z.number().int().min(0).max(0xffffffff),
    /** base64 of the 12-byte AES-GCM nonce. */
    nonce: Base64String,
    /** base64 of the AES-GCM ciphertext (plaintext + 16-byte auth tag). */
    ciphertext: Base64String,
  })
  .strict();

export const E2EFrameSchema = z.discriminatedUnion('type', [
  E2EOfferSchema,
  E2EAnswerSchema,
  E2EEncSchema,
]);

export type E2EOffer = z.infer<typeof E2EOfferSchema>;
export type E2EAnswer = z.infer<typeof E2EAnswerSchema>;
export type E2EEnc = z.infer<typeof E2EEncSchema>;
export type E2EFrame = z.infer<typeof E2EFrameSchema>;

/**
 * Parse an inbound text frame into a typed envelope, or `null` if it's
 * malformed for any reason (oversized, non-JSON, wrong shape, bad base64).
 *
 * Callers translate `null` into a session-fatal `bad-request` close — at
 * the protocol level a malformed envelope is unrecoverable, even before
 * decryption, because the FSM doesn't know what state transition to apply.
 */
export function parseFrame(raw: string): E2EFrame | null {
  if (raw.length > MAX_FRAME_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = E2EFrameSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
