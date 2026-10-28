// Application-defined WebSocket close codes (RFC 6455 reserves 4000–4999).
//
// The numbering mirrors HTTP status codes (4400/4401/4408/4500 for
// 400/401/408/500), so a client needs only one close-code dictionary.
//
// Reasons are short machine-readable strings — clients should branch on them,
// not parse prose. Keep stable: any rename is a public protocol change.

export const PEER_CLOSE = {
  BAD_REQUEST: { code: 4400, reason: 'bad-request' },
  AUTH_FAILED: { code: 4401, reason: 'auth-failed' },
  TIMEOUT: { code: 4408, reason: 'timeout' },
  INTERNAL: { code: 4500, reason: 'internal' },
} as const;

export type PeerCloseCode = (typeof PEER_CLOSE)[keyof typeof PEER_CLOSE];

/** Session-level closes a client acts on. */
export const SESSION_CLOSE = {
  /** The same device signed in again on a newer connection; this one should not reconnect. */
  REPLACED: { code: 4409, reason: 'replaced' },
} as const;
