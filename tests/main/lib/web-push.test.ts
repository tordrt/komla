import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  assertWebPushSubscription,
  buildWebPushRequest,
  classifyPushResponse,
  createVapidAuthorization,
  encryptPushPayload,
  generateVapidKeys,
  MAX_PUSH_PLAINTEXT_BYTES,
  sendWebPush,
  type WebPushSubscription,
} from '../../../src/main/lib/web-push';

const b64 = (value: string) => Buffer.from(value.replace(/\s+/g, ''), 'base64url');

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

function browserSubscription() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const subscription: WebPushSubscription = {
    endpoint: 'https://push.example.net/push/abc',
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  return { subscription, ua, auth };
}

// Receiver side of RFC 8291, written out separately from the sender code under test.
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  expect(body.readUInt32BE(16)).toBe(4096);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength, body.length - 16);
  const tag = body.subarray(body.length - 16);
  const secret = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  expect(padded[padded.length - 1]).toBe(0x02);
  return padded.subarray(0, -1);
}

describe('web-push encryption', () => {
  it('reproduces the RFC 8291 example message byte for byte', () => {
    const body = encryptPushPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      { salt: b64(RFC.salt), senderPrivateKey: b64(RFC.asPrivate) }
    );

    expect(body.toString('base64url')).toBe(RFC.body.replace(/\s+/g, ''));
  });

  it('encrypts with a fresh salt and sender key that the browser can decrypt', () => {
    const { subscription, ua, auth } = browserSubscription();
    const payload = Buffer.from(JSON.stringify({ title: 'Needs input' }));

    const first = encryptPushPayload(payload, subscription.keys);
    const second = encryptPushPayload(payload, subscription.keys);

    expect(decrypt(first, ua, auth)).toEqual(payload);
    expect(first.subarray(0, 16)).not.toEqual(second.subarray(0, 16));
    expect(first.subarray(21, 86)).not.toEqual(second.subarray(21, 86));
  });

  it('accepts the largest payload one 4096-byte record can carry and rejects one more byte', () => {
    const { subscription, ua, auth } = browserSubscription();
    const largest = Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES, 0x61);

    const body = encryptPushPayload(largest, subscription.keys);

    expect(body.length).toBe(4096);
    expect(decrypt(body, ua, auth)).toEqual(largest);
    expect(() =>
      encryptPushPayload(Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES + 1), subscription.keys)
    ).toThrow(/exceeds/);
  });

  it('rejects subscription keys a PushManager could not have produced', () => {
    const { subscription } = browserSubscription();
    const compressed = Buffer.from(subscription.keys.p256dh, 'base64url');
    compressed[0] = 0x02;

    expect(() =>
      assertWebPushSubscription({ ...subscription, endpoint: 'http://push.example.net/x' })
    ).toThrow(/https/);
    expect(() => assertWebPushSubscription({ ...subscription, endpoint: 'not a url' })).toThrow(
      /URL/
    );
    expect(() =>
      assertWebPushSubscription({
        ...subscription,
        keys: { ...subscription.keys, p256dh: compressed.toString('base64url') },
      })
    ).toThrow(/uncompressed/);
    expect(() =>
      assertWebPushSubscription({
        ...subscription,
        keys: { ...subscription.keys, auth: Buffer.alloc(8).toString('base64url') },
      })
    ).toThrow(/16 bytes/);
    expect(() =>
      assertWebPushSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'a+b/' } })
    ).toThrow(/base64url/);
  });
});

describe('web-push VAPID', () => {
  it('signs an ES256 token for the push service origin that verifies with the public key', () => {
    const vapid = generateVapidKeys();
    const now = 1_800_000_000;

    const header = createVapidAuthorization(
      'https://web.push.apple.com/QGuQ?x=1',
      vapid,
      'https://komla.dev',
      now
    );

    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, encodedHeader, encodedClaims, signature, key] = match!;
    expect(key).toBe(vapid.publicKey);
    expect(JSON.parse(b64(encodedHeader).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b64(encodedClaims).toString())).toEqual({
      aud: 'https://web.push.apple.com',
      exp: now + 12 * 60 * 60,
      sub: 'https://komla.dev',
    });
    const point = b64(vapid.publicKey);
    const publicKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        b64(signature)
      )
    ).toBe(true);
  });

  it('requires a mailto: or https: subject', () => {
    expect(() =>
      createVapidAuthorization('https://push.example.net/x', generateVapidKeys(), 'komla.dev')
    ).toThrow(/subject/);
  });
});

describe('web-push requests', () => {
  it('builds an aes128gcm POST with TTL, urgency and topic headers', () => {
    const { subscription, ua, auth } = browserSubscription();
    const payload = Buffer.from('{"kind":"done"}');

    const request = buildWebPushRequest(subscription, payload, generateVapidKeys(), {
      subject: 'https://komla.dev',
      ttlSeconds: 3600.7,
      urgency: 'high',
      topic: 'ws-1_term-2',
    });

    expect(request.url).toBe(subscription.endpoint);
    expect(request.headers).toMatchObject({
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'high',
      Topic: 'ws-1_term-2',
    });
    expect(request.headers.Authorization).toMatch(/^vapid t=/);
    expect(decrypt(request.body, ua, auth)).toEqual(payload);
  });

  it('rejects a topic the push service would refuse', () => {
    const { subscription } = browserSubscription();

    expect(() =>
      buildWebPushRequest(subscription, Buffer.from('x'), generateVapidKeys(), {
        subject: 'https://komla.dev',
        ttlSeconds: 60,
        topic: 'has spaces',
      })
    ).toThrow(/topic/);
  });

  it('classifies push service responses', () => {
    expect(classifyPushResponse(201)).toBe('delivered');
    expect(classifyPushResponse(404)).toBe('gone');
    expect(classifyPushResponse(410)).toBe('gone');
    expect(classifyPushResponse(413)).toBe('failed');
    expect(classifyPushResponse(429)).toBe('failed');
  });

  it('posts the request without following redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));
    const request = {
      url: 'https://push.example.net/x',
      headers: { TTL: '0' },
      body: Buffer.from('a'),
    };

    const result = await sendWebPush(request, fetchImpl);

    expect(result).toEqual({ outcome: 'gone', status: 410 });
    expect(fetchImpl).toHaveBeenCalledWith('https://push.example.net/x', {
      method: 'POST',
      headers: { TTL: '0' },
      body: new Uint8Array(Buffer.from('a')),
      redirect: 'error',
    });
  });
});
