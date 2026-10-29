// Application-layer frames for the pair / remote-control ceremonies.
//
// These travel inside `e2e:enc` payloads. The shape is the contract between the desktop remote-control
// service and the browser/RN client. They live in this package so both
// peers can import the same schemas; the channel-level protocol below them
// is unchanged.
//
// The browser drives. The hello frame's `mode` discriminates between the
// two ceremonies the desktop supports on the same channel:
//
//   register      first-time enrollment — the browser proves possession of
//                 the QR secret and installation key, then returns a
//                 user-verified WebAuthn attestation.
//
//   authenticate  returning paired browser — desktop responds with an
//                 authentication challenge, browser returns a WebAuthn
//                 assertion, desktop verifies against the paired-device
//                 registry, updates the sign counter, and accepts.
//
// Ceremony shapes:
//
//   register:
//     1. browser → desktop  pair:hello {mode:'register', pairingSecret, devicePublicKey, proposedLabel}
//     2. desktop → browser  pair:registration-challenge
//     3. browser → desktop  pair:registration-response   attestation
//     4. desktop → browser  pair:registered | pair:rejected
//
//   authenticate:
//     1. browser → desktop  pair:hello {mode:'authenticate'}
//     2. desktop → browser  pair:auth-challenge
//     3. browser → desktop  pair:auth-response           assertion
//     4. desktop → browser  pair:authenticated | pair:rejected
//
// On any terminal frame the desktop ends the current ceremony Peer so the
// next browser begins a fresh ECDH session.

import { z } from 'zod';

export const PAIR_PROTOCOL_VERSION = 2;

const DeviceIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const StandardBase64Schema = z
  .string()
  .min(4)
  .max(2048)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const PairHelloRegisterSchema = z
  .object({
    type: z.literal('pair:hello'),
    protocolVersion: z.literal(PAIR_PROTOCOL_VERSION),
    mode: z.literal('register'),
    /** One-time 256-bit enrollment secret carried only in the QR URL fragment. */
    pairingSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    /** User-supplied or UA-derived label, e.g. "Chrome on macOS". */
    proposedLabel: z.string().min(1).max(120),
    /** SPKI-DER P-256 browser-installation public key, standard base64. */
    devicePublicKey: StandardBase64Schema,
  })
  .strict();

/**
 * Optional protocol features. The browser lists the ones it supports in its
 * hello; the endpoint answers in pair:authenticated with those it will use.
 * Neither side uses a feature the other didn't list, so an older peer just
 * keeps the baseline protocol.
 */
export const REMOTE_CAPABILITIES = {
  /** Binary envelopes, and binary terminal output and input payloads. */
  BINARY_FRAMES: 'binary-frames',
  /** Projects' icons in launch options, which an older page's strict schema would reject. */
  PROJECT_ICONS: 'project-icons',
} as const;

const CapabilitiesSchema = z.array(z.string().min(1).max(64)).max(32);

const PairHelloAuthenticateSchema = z
  .object({
    type: z.literal('pair:hello'),
    protocolVersion: z.literal(PAIR_PROTOCOL_VERSION),
    mode: z.literal('authenticate'),
    /** Fingerprint of the browser-installation key being authenticated. */
    deviceId: DeviceIdSchema,
    capabilities: CapabilitiesSchema.optional(),
  })
  .strict();

const PairHelloResumeSchema = z
  .object({
    type: z.literal('pair:hello'),
    protocolVersion: z.literal(PAIR_PROTOCOL_VERSION),
    mode: z.literal('resume'),
    deviceId: DeviceIdSchema,
    /** Single-use, short-lived grant issued only after recent passkey verification. */
    resumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    capabilities: CapabilitiesSchema.optional(),
  })
  .strict();

export const PairHelloSchema = z.discriminatedUnion('mode', [
  PairHelloRegisterSchema,
  PairHelloAuthenticateSchema,
  PairHelloResumeSchema,
]);

export const PairRegistrationChallengeSchema = z
  .object({
    type: z.literal('pair:registration-challenge'),
    /** base64url WebAuthn challenge (32 random bytes). */
    challenge: z.string().min(1).max(256),
    /** WebAuthn relying party id — registrable suffix of the page origin. */
    rpId: z.string().min(1).max(253),
    /** RP display name, e.g. "Komla". */
    rpName: z.string().min(1).max(120),
    /**
     * The exact origin the desktop will accept in `clientDataJSON.origin`.
     * Sent so the browser can sanity-check before invoking the authenticator.
     */
    origin: z.string().min(1).max(2048),
    user: z
      .object({
        /** base64url stable per-install id (so the same install dedupes passkeys). */
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(120),
        displayName: z.string().min(1).max(120),
      })
      .strict(),
    /**
     * base64url credential ids the authenticator should refuse to re-register.
     * Cap is 256 so a user with many paired devices still fits in one
     * challenge frame at realistic ~64-byte credential ids (256 × ~86 base64url
     * chars ≈ 22 KB, comfortably under the 64 KB e2e frame budget).
     */
    excludeCredentialIds: z.array(z.string().min(1).max(512)).max(256),
  })
  .strict();

// SimpleWebAuthn's RegistrationResponseJSON contract — we accept the fields
// the server library reads, plus pass-through for anything else the spec
// adds. Keeping this loose intentionally: the deep validation lives in
// `verifyRegistrationResponse`, and re-deriving its checks here would be a
// drift hazard.
const AttestationResponseSchema = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        attestationObject: z.string().min(1),
      })
      .passthrough(),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const PairRegistrationResponseSchema = z
  .object({
    type: z.literal('pair:registration-response'),
    attestationResponse: AttestationResponseSchema,
    /** Browser-installation signature over the registration challenge and channel binding. */
    deviceSignature: StandardBase64Schema,
  })
  .strict();

export const PairRegisteredSchema = z
  .object({
    type: z.literal('pair:registered'),
    deviceId: DeviceIdSchema,
    /** base64url credential id the desktop persisted. */
    credentialId: z.string().min(1).max(1024),
    /** Final label as persisted (may differ from the proposedLabel if normalized). */
    label: z.string().min(1).max(120),
  })
  .strict();

// SimpleWebAuthn's AuthenticationResponseJSON — same passthrough strategy as
// the attestation shape above.
const AuthenticationResponseSchema = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        authenticatorData: z.string().min(1),
        signature: z.string().min(1),
        // userHandle is optional in the spec; we use it on the *browser* side
        // (to recover the install fingerprint pre-handshake) and don't
        // re-validate it here — the credential-id lookup is the trust anchor.
        userHandle: z.string().optional(),
      })
      .passthrough(),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const PairAuthChallengeSchema = z
  .object({
    type: z.literal('pair:auth-challenge'),
    /** base64url WebAuthn challenge (32 random bytes). */
    challenge: z.string().min(1).max(256),
    /** WebAuthn relying party id — registrable suffix of the page origin. */
    rpId: z.string().min(1).max(253),
    /** Exact origin the desktop will accept in `clientDataJSON.origin`. */
    origin: z.string().min(1).max(2048),
    /** Credential bound to the trusted browser installation. */
    credentialId: z.string().min(1).max(1024),
  })
  .strict();

export const PairAuthResponseSchema = z
  .object({
    type: z.literal('pair:auth-response'),
    authenticationResponse: AuthenticationResponseSchema,
    /** Browser-installation signature over the authentication challenge and channel binding. */
    deviceSignature: StandardBase64Schema,
  })
  .strict();

export const PairResumeChallengeSchema = z
  .object({
    type: z.literal('pair:resume-challenge'),
    challenge: z.string().min(1).max(256),
  })
  .strict();

export const PairResumeResponseSchema = z
  .object({
    type: z.literal('pair:resume-response'),
    /** Installation-key proof over the challenge and fresh encrypted transcript. */
    deviceSignature: StandardBase64Schema,
  })
  .strict();

export const PairAuthenticatedSchema = z
  .object({
    type: z.literal('pair:authenticated'),
    deviceId: DeviceIdSchema,
    /** base64url credential id the desktop authenticated against. */
    credentialId: z.string().min(1).max(1024),
    /** Friendly label of the device, looked up from the registry. */
    label: z.string().min(1).max(120),
    /** Rotating grant for silent recovery of this browser tab after a transient disconnect. */
    resumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    resumeExpiresAt: z.number().int().positive().optional(),
    /** The hello's capabilities this endpoint will use. */
    capabilities: CapabilitiesSchema.optional(),
    /**
     * The phone app build the desktop serves. A page running another build
     * reloads, so a page left open across a Komla update doesn't keep talking
     * to it with old code. SSH hosts don't serve the app and leave it out.
     */
    build: z.string().min(1).max(64).optional(),
  })
  .strict();

// Desktop-emitted failure. `reason` is a stable machine-readable token that
// callers can branch on; `message` is human-readable for display.
export const PairRejectedSchema = z
  .object({
    type: z.literal('pair:rejected'),
    reason: z.enum([
      // Register flow
      'pairing-secret-invalid',
      'unsupported-mode',
      'attestation-invalid',
      'duplicate-credential',
      'protocol-version-mismatch',
      // Auth flow
      'unknown-credential',
      'unknown-device',
      'device-signature-failed',
      'signature-failed',
      'counter-regression',
      'not-paired',
      'resume-invalid',
      // Another trusted device is using remote control; this one may retry later.
      'busy',
      // Either
      'internal',
    ]),
    message: z.string().min(1).max(500),
  })
  .strict();

// Outer schema is a plain union — `pair:hello` is itself a discriminated
// union over `mode`, and Zod doesn't allow a discriminator's leaves to share
// a value. The performance cost (try-each on parse) is negligible here:
// every reachable shape rejects on first-mismatched-key in O(1) and frame
// parses are not in a hot path.
export const PairFrameSchema = z.union([
  PairHelloSchema,
  PairRegistrationChallengeSchema,
  PairRegistrationResponseSchema,
  PairRegisteredSchema,
  PairAuthChallengeSchema,
  PairAuthResponseSchema,
  PairResumeChallengeSchema,
  PairResumeResponseSchema,
  PairAuthenticatedSchema,
  PairRejectedSchema,
]);

export type PairHello = z.infer<typeof PairHelloSchema>;
export type PairHelloRegister = z.infer<typeof PairHelloRegisterSchema>;
export type PairHelloAuthenticate = z.infer<typeof PairHelloAuthenticateSchema>;
export type PairHelloResume = z.infer<typeof PairHelloResumeSchema>;
export type PairRegistrationChallenge = z.infer<typeof PairRegistrationChallengeSchema>;
export type PairRegistrationResponse = z.infer<typeof PairRegistrationResponseSchema>;
export type PairRegistered = z.infer<typeof PairRegisteredSchema>;
export type PairAuthChallenge = z.infer<typeof PairAuthChallengeSchema>;
export type PairAuthResponse = z.infer<typeof PairAuthResponseSchema>;
export type PairResumeChallenge = z.infer<typeof PairResumeChallengeSchema>;
export type PairResumeResponse = z.infer<typeof PairResumeResponseSchema>;
export type PairAuthenticated = z.infer<typeof PairAuthenticatedSchema>;
export type PairRejected = z.infer<typeof PairRejectedSchema>;
export type PairFrame = z.infer<typeof PairFrameSchema>;

/**
 * Parse the JSON value carried inside a `e2e:enc` PAYLOAD_JSON frame into a
 * typed pair-ceremony frame, or `null` if it doesn't match any known shape.
 */
export function parsePairFrame(value: unknown): PairFrame | null {
  const result = PairFrameSchema.safeParse(value);
  return result.success ? result.data : null;
}
