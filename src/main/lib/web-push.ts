import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
} from 'crypto';

// Web Push (RFC 8030) sent straight from the desktop to the browser vendor's push service.
// Payloads are encrypted to the subscription's keys (RFC 8291, aes128gcm per RFC 8188), so the
// push service relays ciphertext only. The sender authenticates with a per-install VAPID key
// (RFC 8292), so no shared Komla secret or hosted gateway exists.
//
// Pure Node: no Electron imports, so the key handling stays testable without a keychain.

const CURVE = 'prime256v1';
const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const AUTH_SECRET_BYTES = 16;
const UNCOMPRESSED_POINT_BYTES = 65;
const PRIVATE_KEY_BYTES = 32;
const TAG_BYTES = 16;
const HEADER_BYTES = SALT_BYTES + 4 + 1 + UNCOMPRESSED_POINT_BYTES;
// One record carries plaintext + the 0x02 last-record delimiter + the GCM tag (RFC 8291 §4).
export const MAX_PUSH_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - 1 - TAG_BYTES;
// RFC 8292 §2: exp must not be more than 24 hours ahead.
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface WebPushSubscription {
  endpoint: string;
  keys: {
    /** base64url uncompressed P-256 point of the browser's push key. */
    p256dh: string;
    /** base64url 16-byte authentication secret. */
    auth: string;
  };
}

export interface VapidKeys {
  /** base64url uncompressed P-256 point; the browser's `applicationServerKey`. */
  publicKey: string;
  /** base64url 32-byte private scalar. */
  privateKey: string;
}

export interface EncryptOptions {
  /** Fixed salt, for test vectors only. */
  salt?: Buffer;
  /** Fixed ephemeral sender private key, for test vectors only. */
  senderPrivateKey?: Buffer;
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface WebPushRequestOptions {
  /** `mailto:` or `https:` contact the push service may use (RFC 8292 §2.1). */
  subject: string;
  ttlSeconds: number;
  urgency?: PushUrgency;
  /** Replaces an undelivered message with the same topic (RFC 8030 §5.4). */
  topic?: string;
  nowSeconds?: number;
}

export interface WebPushRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export type WebPushOutcome = 'delivered' | 'gone' | 'failed';

export interface WebPushResult {
  outcome: WebPushOutcome;
  status: number;
}

function toBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function decodeBase64Url(value: string, name: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error(`${name} is not base64url`);
  }
  return Buffer.from(value, 'base64url');
}

function fromBase64Url(value: string, expectedBytes: number, name: string): Buffer {
  const decoded = decodeBase64Url(value, name);
  if (decoded.length !== expectedBytes) {
    throw new Error(`${name} must be ${expectedBytes} bytes`);
  }
  return decoded;
}

// ECDH.getPrivateKey() drops leading zero bytes, so about 1 in 256 scalars comes back short.
function padPrivateScalar(scalar: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(PRIVATE_KEY_BYTES - scalar.length), scalar]);
}

function decodePrivateScalar(value: string, name: string): Buffer {
  const decoded = decodeBase64Url(value, name);
  // Keys stored before scalars were padded may be shorter than 32 bytes.
  if (decoded.length === 0 || decoded.length > PRIVATE_KEY_BYTES) {
    throw new Error(`${name} must be ${PRIVATE_KEY_BYTES} bytes`);
  }
  return padPrivateScalar(decoded);
}

function decodePublicPoint(value: string, name: string): Buffer {
  const point = fromBase64Url(value, UNCOMPRESSED_POINT_BYTES, name);
  if (point[0] !== 0x04) {
    throw new Error(`${name} must be an uncompressed P-256 point`);
  }
  return point;
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: toBase64Url(ecdh.getPublicKey()),
    privateKey: toBase64Url(padPrivateScalar(ecdh.getPrivateKey())),
  };
}

/** Throws when `subscription` could not have come from a browser's PushManager. */
export function assertWebPushSubscription(subscription: WebPushSubscription): void {
  let url: URL;
  try {
    url = new URL(subscription.endpoint);
  } catch {
    throw new Error('push endpoint is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('push endpoint must use https');
  }
  decodePublicPoint(subscription.keys.p256dh, 'p256dh');
  fromBase64Url(subscription.keys.auth, AUTH_SECRET_BYTES, 'auth');
}

export function encryptPushPayload(
  plaintext: Buffer,
  keys: WebPushSubscription['keys'],
  options: EncryptOptions = {}
): Buffer {
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new Error(`push payload exceeds ${MAX_PUSH_PLAINTEXT_BYTES} bytes`);
  }
  const uaPublic = decodePublicPoint(keys.p256dh, 'p256dh');
  const authSecret = fromBase64Url(keys.auth, AUTH_SECRET_BYTES, 'auth');
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) {
    throw new Error(`salt must be ${SALT_BYTES} bytes`);
  }

  const sender = createECDH(CURVE);
  if (options.senderPrivateKey) {
    sender.setPrivateKey(options.senderPrivateKey);
  } else {
    sender.generateKeys();
  }
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);

  // RFC 8291 §3.4: combine the ECDH secret with the auth secret, bound to both public keys.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  // RFC 8188 §2.2–2.3: content encryption key and nonce for the single record.
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(UNCOMPRESSED_POINT_BYTES, SALT_BYTES + 4);
  asPublic.copy(header, SALT_BYTES + 5);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.concat([header, ciphertext]);
}

function vapidSigningKey(vapid: VapidKeys) {
  const publicPoint = decodePublicPoint(vapid.publicKey, 'VAPID public key');
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: toBase64Url(decodePrivateScalar(vapid.privateKey, 'VAPID private key')),
      x: toBase64Url(publicPoint.subarray(1, 33)),
      y: toBase64Url(publicPoint.subarray(33, 65)),
    },
  });
}

/** RFC 8292 `Authorization` header value for one push service origin. */
export function createVapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  subject: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error('VAPID subject must be a mailto: or https: URL');
  }
  const encode = (value: object) => toBase64Url(Buffer.from(JSON.stringify(value)));
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + VAPID_TOKEN_LIFETIME_SECONDS,
    sub: subject,
  })}`;
  const signature = cryptoSign('sha256', Buffer.from(unsigned), {
    key: vapidSigningKey(vapid),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}

export function buildWebPushRequest(
  subscription: WebPushSubscription,
  payload: Buffer,
  vapid: VapidKeys,
  options: WebPushRequestOptions
): WebPushRequest {
  assertWebPushSubscription(subscription);
  if (options.topic !== undefined && !TOPIC_PATTERN.test(options.topic)) {
    throw new Error('push topic must be 1-32 base64url characters');
  }
  const headers: Record<string, string> = {
    Authorization: createVapidAuthorization(
      subscription.endpoint,
      vapid,
      options.subject,
      options.nowSeconds
    ),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.floor(options.ttlSeconds))),
  };
  if (options.urgency) {
    headers.Urgency = options.urgency;
  }
  if (options.topic) {
    headers.Topic = options.topic;
  }
  return {
    url: subscription.endpoint,
    headers,
    body: encryptPushPayload(payload, subscription.keys),
  };
}

/** 404 and 410 mean the browser dropped the subscription (RFC 8030 §7.3). */
export function classifyPushResponse(status: number): WebPushOutcome {
  if (status >= 200 && status < 300) {
    return 'delivered';
  }
  if (status === 404 || status === 410) {
    return 'gone';
  }
  return 'failed';
}

export async function sendWebPush(
  request: WebPushRequest,
  fetchImpl: typeof fetch = fetch
): Promise<WebPushResult> {
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: new Uint8Array(request.body),
    redirect: 'error',
  });
  return { outcome: classifyPushResponse(response.status), status: response.status };
}
