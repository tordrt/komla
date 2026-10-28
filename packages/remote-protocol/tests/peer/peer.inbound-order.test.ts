// Inbound delivery ordering — proves Peer.inboundChain serializes
// decrypt+dispatch so application callbacks fire in seq order even when
// AES-GCM decrypt resolves out of order between adjacent frames.
//
// Lives in its own file because the test mocks `crypto/aead` at the module
// level to inject controllable per-call latency. A vi.mock there would
// affect every test in the file, so we keep this isolated rather than
// retrofit the bigger integration suite.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mutable state, shared between the mock factory (which runs at
// module load, before any test) and the tests themselves. Each test resets
// `delays` and `idx` in beforeEach.
const decryptPlan = vi.hoisted(() => ({
  delays: [] as number[],
  idx: 0,
}));

vi.mock('../../src/crypto/aead', async (importActual) => {
  const actual = await importActual<typeof import('../../src/crypto/aead')>();
  return {
    ...actual,
    decrypt: async (
      key: Parameters<typeof actual.decrypt>[0],
      nonce: Parameters<typeof actual.decrypt>[1],
      ciphertext: Parameters<typeof actual.decrypt>[2]
    ) => {
      const i = decryptPlan.idx++;
      const delay = decryptPlan.delays[i] ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return actual.decrypt(key, nonce, ciphertext);
    },
  };
});


import { Peer } from '../../src/peer/peer';
import type { DecodedMessage } from '../../src/peer/payload';

import { bindPair, createTransportPair } from './fake-transport';
import { createFakeInstallIdentity } from './fixtures';

beforeEach(() => {
  decryptPlan.delays = [];
  decryptPlan.idx = 0;
});

describe('Peer inbound delivery order', () => {
  it('delivers in seq order even when the first frame decrypts slower than later frames', async () => {
    // The handshake doesn't call decrypt (handshake frames are signed/derived,
    // not AES-GCM-encrypted), so delays index 0 corresponds to the first
    // encrypted application frame the receiver decrypts. Make frame 0 slow
    // and 1/2 fast — without the inbound chain, callbacks would arrive in
    // order [1, 2, 0]. With the chain, decrypt 1 doesn't start until
    // decrypt 0 has resolved AND dispatched, so the order is [0, 1, 2].
    decryptPlan.delays = [40, 0, 0];

    const identity = await createFakeInstallIdentity();
    const { a: clientTransport, b: desktopTransport } = createTransportPair();

    const client = new Peer({
      role: 'client',
      transport: clientTransport,
      expectedFingerprint: identity.fingerprint,
    });
    const desktop = new Peer({
      role: 'desktop',
      transport: desktopTransport,
      sign: identity.sign,
      installPubkey: identity.publicKey,
    });
    bindPair({
      aTransport: clientTransport,
      bTransport: desktopTransport,
      a: client,
      b: desktop,
    });

    await Promise.all([client.connect(), desktop.connect()]);

    const desktopReceived: DecodedMessage[] = [];
    desktop.onMessage((m) => desktopReceived.push(m));

    // Three sends in flight at once. The outbound chain ensures wire order
    // is [0, 1, 2]. The receiver gets three handleMessage calls back-to-back
    // (one per microtask via fake-transport), each enqueues decrypt onto
    // the inbound chain. The mock makes decrypt 0 take 40ms; decrypts 1
    // and 2 are instant. The chain must hold their callbacks behind 0.
    await Promise.all([
      client.sendEncryptedJson({ i: 0 }),
      client.sendEncryptedJson({ i: 1 }),
      client.sendEncryptedJson({ i: 2 }),
    ]);

    // Wait past the slow decrypt + chain dispatch. 40ms + slop.
    await new Promise((r) => setTimeout(r, 80));

    expect(desktopReceived).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const msg = desktopReceived[i]!;
      expect(msg.kind).toBe('json');
      if (msg.kind === 'json') expect(msg.data).toEqual({ i });
    }
  });
});
