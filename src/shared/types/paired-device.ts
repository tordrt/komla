// Wire-shape types for paired-device records. Shared between the main
// service (source of truth) and the renderer (consumer) so the preload
// surface stays a single typed seam.

/**
 * One trusted browser installation enrolled with this Komla install. All
 * fields are public material — both private keys remain on their respective
 * devices.
 */
export interface PairedDeviceRecord {
  /** SHA-256(SPKI) fingerprint of the browser installation key. */
  deviceId: string;
  /** Base64 SPKI-DER P-256 browser installation public key. */
  devicePublicKey: string;
  /** base64url credential id reported by the authenticator. */
  credentialId: string;
  /** base64url COSE-encoded public key bytes. Used to verify future assertions. */
  publicKey: string;
  /** Per-credential signature counter. Bumped on each successful assertion. */
  signCounter: number;
  /** Authenticator AAGUID as a UUID string, or null if the authenticator omitted it (all-zero AAGUID). */
  aaguid: string | null;
  /** User-facing label, e.g. "Chrome on macOS". */
  label: string;
  /** ISO timestamp of registration. */
  createdAt: string;
  /** ISO timestamp of last successful assertion, or null if never used. */
  lastUsedAt: string | null;
  /** Optional transports list reported by the authenticator. */
  transports: string[] | null;
  /** WebAuthn relying-party id under which this device was enrolled. */
  rpId: string;
  /** Exact WebAuthn origin under which this device was enrolled. */
  origin: string;
}
