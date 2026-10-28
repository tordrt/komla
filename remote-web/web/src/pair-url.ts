// Parse the pair URL the desktop hands the user. The desktop emits exactly
//   <httpOrigin>/remote/pair#fp=<64-hex>&secret=<base64url-32-bytes>
// — fingerprint and one-time enrollment secret stay in the fragment so they
// never reach HTTP access logs. We mirror that strictness here: any deviation is rejected with a
// human-readable error so a copy/paste mistake surfaces clearly instead of
// silently opening a WebSocket against a bogus fingerprint.

import { isValidFingerprint } from '@komla/remote-protocol';

export interface ParsedPairUrl {
  /** Lowercase 64-hex install fingerprint extracted from the fragment. */
  fingerprint: string;
  /** One-time 256-bit enrollment secret encoded as unpadded base64url. */
  pairingSecret: string;
  /** Origin of the desktop-hosted browser application. */
  origin: string;
}

export type PairUrlParseError =
  | 'missing-fragment'
  | 'missing-fp'
  | 'invalid-fingerprint'
  | 'missing-secret'
  | 'invalid-secret'
  | 'not-a-link'
  | 'other-origin';

export class PairUrlError extends Error {
  readonly code: PairUrlParseError;
  constructor(code: PairUrlParseError, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Extract the install fingerprint from the current page URL's fragment.
 * Throws `PairUrlError` if the fragment is missing or malformed.
 */
export function parsePairUrl(href: string): ParsedPairUrl {
  const url = new URL(href);
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (!fragment) {
    throw new PairUrlError(
      'missing-fragment',
      'No fragment in URL — expected `#fp=<fingerprint>`.'
    );
  }
  // URLSearchParams handles `fp=…&extra=…` cleanly; we don't refuse extras
  // so a future protocol revision can carry additional fragment fields
  // without breaking older clients.
  const params = new URLSearchParams(fragment);
  const fp = params.get('fp');
  if (!fp) {
    throw new PairUrlError('missing-fp', 'URL fragment missing `fp` parameter.');
  }
  if (!isValidFingerprint(fp)) {
    throw new PairUrlError(
      'invalid-fingerprint',
      'Fingerprint must be 64 lowercase hex characters.'
    );
  }
  const pairingSecret = params.get('secret');
  if (!pairingSecret) {
    throw new PairUrlError('missing-secret', 'URL fragment missing `secret` parameter.');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(pairingSecret)) {
    throw new PairUrlError(
      'invalid-secret',
      'Pairing secret must be a 256-bit unpadded base64url value.'
    );
  }
  return { fingerprint: fp, pairingSecret, origin: url.origin };
}

/**
 * The pairing link pasted into this page, checked before the page opens it. The link must pair
 * with the desktop that served this page: a Home Screen app keeps its own storage, so it pairs
 * itself, at its own address.
 */
export function pastedPairUrl(text: string, pageOrigin: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new PairUrlError('not-a-link', "That isn't a link. Copy the whole pairing link again.");
  }
  if (url.origin !== pageOrigin || url.pathname !== '/remote/pair') {
    throw new PairUrlError(
      'other-origin',
      `That link pairs with ${url.origin}, but this app opens ${pageOrigin}.`
    );
  }
  parsePairUrl(url.href);
  return url.href;
}
