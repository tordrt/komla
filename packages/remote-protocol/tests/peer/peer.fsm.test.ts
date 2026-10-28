// Unit tests for the Peer FSM in isolation — single Peer instance per test,
// the partner side simulated by manually feeding frames into handleMessage
// (so we can assert exactly what each transition does, including invalid
// transitions). Two-Peer integration is in peer.integration.test.ts.

import { generateKeyPairSync } from 'node:crypto';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { decodeBase64, encodeBase64 } from '../../src/wire/encoding';
import { generateEphemeralKeyPair } from '../../src/crypto/ecdh';
import { buildHandshakeTranscript } from '../../src/crypto/transcript';
import { Peer } from '../../src/peer/peer';

import { createFakeTransport, type FakeTransport } from './fake-transport';
import { createFakeInstallIdentity, type FakeInstallIdentity } from './fixtures';

describe('Peer FSM', () => {
  let identity: FakeInstallIdentity;

  beforeEach(async () => {
    identity = await createFakeInstallIdentity();
  });

  describe('initial state', () => {
    it('client starts idle', () => {
      const peer = new Peer({
        role: 'client',
        transport: createFakeTransport(),
        expectedFingerprint: identity.fingerprint,
      });
      expect(peer.state).toBe('idle');
    });

    it('desktop starts idle', () => {
      const peer = new Peer({
        role: 'desktop',
        transport: createFakeTransport(),
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      expect(peer.state).toBe('idle');
    });
  });

  describe('client → connect()', () => {
    it('transitions to awaitingPeer and sends e2e:offer', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'client',
        transport,
        expectedFingerprint: identity.fingerprint,
      });
      const connectPromise = peer.connect();
      await waitForSent(transport, 1);

      expect(peer.state).toBe('awaitingPeer');
      expect(transport.sent).toHaveLength(1);
      const sent = JSON.parse(transport.sent[0]!);
      expect(sent.type).toBe('e2e:offer');
      expect(typeof sent.ephemeralPubkey).toBe('string');

      // Avoid an unhandled-rejection: explicitly close so the pending
      // connectPromise rejects, and swallow.
      peer.close(1000, 'test cleanup');
      await connectPromise.catch(() => {});
    });

    it('rejects a second connect()', async () => {
      const peer = new Peer({
        role: 'client',
        transport: createFakeTransport(),
        expectedFingerprint: identity.fingerprint,
      });
      const first = peer.connect();
      await flushMicrotasks();
      await expect(peer.connect()).rejects.toThrow(/awaitingPeer/);
      peer.close(1000);
      await first.catch(() => {});
    });
  });

  // Wait helper used by client-side tests where connect() triggers an async
  // crypto chain that takes more than one microtask flush to settle.

  describe('desktop → connect()', () => {
    it('transitions to awaitingPeer without sending anything', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      const p = peer.connect();
      await flushMicrotasks();

      expect(peer.state).toBe('awaitingPeer');
      expect(transport.sent).toHaveLength(0);

      peer.close(1000);
      await p.catch(() => {});
    });
  });

  describe('handshake timeout', () => {
    it('closes with TIMEOUT if handshake does not complete', async () => {
      vi.useFakeTimers();
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
        handshakeTimeoutMs: 50,
      });
      const connectPromise = peer.connect();
      vi.advanceTimersByTime(60);

      expect(peer.state).toBe('closed');
      expect(transport.closed).toEqual([{ code: 4408, reason: 'timeout' }]);
      await expect(connectPromise).rejects.toThrow();
      vi.useRealTimers();
    });
  });

  describe('client receives e2e:answer (auth checks)', () => {
    async function runClientHandshake(args: {
      tamper?: (answer: {
        ephemeralPubkey: string;
        installPubkey: string;
        signature: string;
      }) => void;
      installPubkey?: Uint8Array;
    }): Promise<{ peer: Peer; transport: FakeTransport; result: Promise<void> }> {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'client',
        transport,
        expectedFingerprint: identity.fingerprint,
        handshakeTimeoutMs: 5_000,
      });
      const result = peer.connect();
      await waitForSent(transport, 1);

      const offer = JSON.parse(transport.sent[0]!) as { ephemeralPubkey: string };
      const clientEphemB64 = offer.ephemeralPubkey;

      const desktopEphem = await generateEphemeralKeyPair();
      const transcript = buildHandshakeTranscript({
        clientEphemeral: decodeBase64(clientEphemB64)!,
        desktopEphemeral: desktopEphem.publicKey,
        desktopIdentity: identity.publicKey,
      });
      const signature = await identity.sign(transcript);

      const answerFields = {
        ephemeralPubkey: encodeBase64(desktopEphem.publicKey),
        installPubkey: encodeBase64(args.installPubkey ?? identity.publicKey),
        signature: encodeBase64(signature),
      };
      if (args.tamper) args.tamper(answerFields);

      peer.handleMessage(JSON.stringify({ type: 'e2e:answer', ...answerFields }));
      await flushMicrotasks();

      return { peer, transport, result };
    }

    it('reaches established on a valid answer', async () => {
      const { peer, result } = await runClientHandshake({});
      await result;
      expect(peer.state).toBe('established');
    });

    it('closes AUTH_FAILED when install pubkey fingerprint mismatches', async () => {
      const other = await createFakeInstallIdentity();
      const { peer, transport, result } = await runClientHandshake({
        installPubkey: other.publicKey,
      });
      await expect(result).rejects.toThrow();
      expect(peer.state).toBe('closed');
      expect(transport.closed).toEqual([{ code: 4401, reason: 'auth-failed' }]);
    });

    it('closes AUTH_FAILED when signature is tampered', async () => {
      const { peer, transport, result } = await runClientHandshake({
        tamper(a) {
          // Flip a byte in the signature.
          const sig = Buffer.from(a.signature, 'base64');
          sig[0] ^= 0xff;
          a.signature = sig.toString('base64');
        },
      });
      await expect(result).rejects.toThrow();
      expect(peer.state).toBe('closed');
      expect(transport.closed).toEqual([{ code: 4401, reason: 'auth-failed' }]);
    });

    it('closes BAD_REQUEST on a malformed answer field', async () => {
      const { peer, transport, result } = await runClientHandshake({
        tamper(a) {
          a.signature = 'not-base64!';
        },
      });
      await expect(result).rejects.toThrow();
      expect(peer.state).toBe('closed');
      expect(transport.closed[0]?.code).toBe(4400);
    });
  });

  describe('illegal transitions', () => {
    it('client receives e2e:offer → BAD_REQUEST', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'client',
        transport,
        expectedFingerprint: identity.fingerprint,
      });
      const p = peer.connect();
      await flushMicrotasks();

      peer.handleMessage(
        JSON.stringify({ type: 'e2e:offer', ephemeralPubkey: encodeBase64(new Uint8Array(91)) })
      );
      await flushMicrotasks();
      expect(peer.state).toBe('closed');
      expect(transport.closed[0]?.code).toBe(4400);
      await p.catch(() => {});
    });

    it('desktop receives e2e:answer → BAD_REQUEST', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      const p = peer.connect();
      await flushMicrotasks();

      peer.handleMessage(
        JSON.stringify({
          type: 'e2e:answer',
          ephemeralPubkey: encodeBase64(new Uint8Array(91)),
          installPubkey: encodeBase64(identity.publicKey),
          signature: encodeBase64(new Uint8Array(64)),
        })
      );
      await flushMicrotasks();
      expect(peer.state).toBe('closed');
      expect(transport.closed[0]?.code).toBe(4400);
      await p.catch(() => {});
    });

    it('e2e:enc before established → BAD_REQUEST', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      const p = peer.connect();
      await flushMicrotasks();

      peer.handleMessage(
        JSON.stringify({
          type: 'e2e:enc',
          seq: 0,
          nonce: encodeBase64(new Uint8Array(12)),
          ciphertext: encodeBase64(new Uint8Array(32)),
        })
      );
      await flushMicrotasks();
      expect(peer.state).toBe('closed');
      expect(transport.closed[0]?.code).toBe(4400);
      await p.catch(() => {});
    });

    it('unparseable frame → BAD_REQUEST', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      const p = peer.connect();
      await flushMicrotasks();

      peer.handleMessage('not json');
      await flushMicrotasks();
      expect(peer.state).toBe('closed');
      expect(transport.closed[0]?.code).toBe(4400);
      await p.catch(() => {});
    });
  });

  describe('send guards', () => {
    it('throws when sending before established', async () => {
      const peer = new Peer({
        role: 'client',
        transport: createFakeTransport(),
        expectedFingerprint: identity.fingerprint,
      });
      await expect(peer.sendEncryptedJson({ x: 1 })).rejects.toThrow(/idle/);
      await expect(peer.sendEncryptedBinary(new Uint8Array(4))).rejects.toThrow(/idle/);
    });

    it('throws when sending after close', async () => {
      const peer = new Peer({
        role: 'client',
        transport: createFakeTransport(),
        expectedFingerprint: identity.fingerprint,
      });
      peer.close(1000);
      await expect(peer.sendEncryptedJson({ x: 1 })).rejects.toThrow(/closed/);
    });
  });

  describe('malformed peer SPKI', () => {
    // importPeerPublicKey throws synchronously on garbage / wrong-curve SPKI.
    // Without local handling that throw escapes the handler and the peer
    // closes 4500 internal — which is wrong: this is attacker-controlled wire
    // input, not an internal bug. Both sides must collapse it to 4400.

    it('desktop closes BAD_REQUEST on malformed e2e:offer ephemeralPubkey', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      // Attach the catch eagerly: handleOffer's async chain will reject the
      // connect() promise before any later `await` we add for sequencing,
      // so deferring the catch flags it as unhandled.
      const p = peer.connect().catch(() => {});
      await flushMicrotasks();

      // 91 zero bytes: valid base64, valid SPKI length for P-256, but not a
      // real SPKI structure — importKey throws.
      peer.handleMessage(
        JSON.stringify({ type: 'e2e:offer', ephemeralPubkey: encodeBase64(new Uint8Array(91)) })
      );
      // handleOffer awaits generateEphemeralKeyPair then importPeerPublicKey
      // before our catch fires — give the chain time to settle.
      await new Promise((r) => setTimeout(r, 20));

      expect(peer.state).toBe('closed');
      expect(transport.closed[0]?.code).toBe(4400);
      expect(transport.closed[0]?.code).not.toBe(4500);
      await p;
    });

    it('client closes BAD_REQUEST on malformed e2e:answer ephemeralPubkey', async () => {
      // Build a real client up to the awaitingPeer state, then feed it an
      // answer whose ephemeralPubkey is garbage. The signature check will
      // also fail (signature is over the garbage SPKI), but importPeerPublicKey
      // would also throw on the derive step — either way the close must be
      // 4400, never 4500.
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'client',
        transport,
        expectedFingerprint: identity.fingerprint,
        handshakeTimeoutMs: 5_000,
      });
      const result = peer.connect();
      await waitForSent(transport, 1);

      const offer = JSON.parse(transport.sent[0]!) as { ephemeralPubkey: string };
      const garbageEphem = new Uint8Array(91); // valid length, invalid SPKI
      const signature = await identity.sign(
        buildHandshakeTranscript({
          clientEphemeral: decodeBase64(offer.ephemeralPubkey)!,
          desktopEphemeral: garbageEphem,
          desktopIdentity: identity.publicKey,
        })
      );

      peer.handleMessage(
        JSON.stringify({
          type: 'e2e:answer',
          ephemeralPubkey: encodeBase64(garbageEphem),
          installPubkey: encodeBase64(identity.publicKey),
          signature: encodeBase64(signature),
        })
      );
      await flushMicrotasks();
      await flushMicrotasks();

      await expect(result).rejects.toThrow();
      expect(peer.state).toBe('closed');
      // We don't care which check caught it (signature verify or SPKI import),
      // only that it's not surfaced as our internal failure.
      expect(transport.closed[0]?.code).toBe(4400);
      expect(transport.closed[0]?.code).not.toBe(4500);
    });

    it('desktop closes BAD_REQUEST on real P-384 SPKI in e2e:offer', async () => {
      // Real well-formed SPKI but for the wrong curve. importPeerPublicKey
      // requests P-256 specifically, so WebCrypto throws "named curve mismatch"
      // (or similar). That throw is attacker-controlled wire data — must map
      // to 4400, not 4500.
      const wrongCurveSpki = generateP384Spki();
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      const p = peer.connect().catch(() => {});
      await flushMicrotasks();

      peer.handleMessage(
        JSON.stringify({ type: 'e2e:offer', ephemeralPubkey: encodeBase64(wrongCurveSpki) })
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(peer.state).toBe('closed');
      expect(transport.closed[0]).toEqual({ code: 4400, reason: 'bad-request' });
      await p;
    });

    it('client closes 4400 on real P-384 SPKI in e2e:answer', async () => {
      // The client checks fingerprint → signature → ECDH derive in that order.
      // Even with a perfectly-signed concat over the P-384 SPKI, the curve
      // mismatch is only caught when importPeerPublicKey runs after signature
      // verification, so the close reason ends up `bad-request` (the SPKI
      // path), not `auth-failed`.
      const wrongCurveSpki = generateP384Spki();
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'client',
        transport,
        expectedFingerprint: identity.fingerprint,
        handshakeTimeoutMs: 5_000,
      });
      // Attach the catch eagerly: the rejection fires from the async crypto
      // chain before the assertions below can `await` the result.
      const result = peer.connect();
      const settled = result.then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err })
      );
      await waitForSent(transport, 1);

      const offer = JSON.parse(transport.sent[0]!) as { ephemeralPubkey: string };
      const signature = await identity.sign(
        buildHandshakeTranscript({
          clientEphemeral: decodeBase64(offer.ephemeralPubkey)!,
          desktopEphemeral: wrongCurveSpki,
          desktopIdentity: identity.publicKey,
        })
      );

      peer.handleMessage(
        JSON.stringify({
          type: 'e2e:answer',
          ephemeralPubkey: encodeBase64(wrongCurveSpki),
          installPubkey: encodeBase64(identity.publicKey),
          signature: encodeBase64(signature),
        })
      );
      await new Promise((r) => setTimeout(r, 20));

      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      expect(peer.state).toBe('closed');
      expect(transport.closed[0]).toEqual({ code: 4400, reason: 'bad-request' });
    });
  });

  describe('socket close mid-handshake', () => {
    it('rejects the connect() promise', async () => {
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      const p = peer.connect();
      await flushMicrotasks();
      peer.handleClose({ code: 1006, reason: 'abnormal' });
      await expect(p).rejects.toThrow(/socket closed mid-handshake/);
      expect(peer.state).toBe('closed');
    });

    it('desktop does not send e2e:answer if socket closes during handleOffer crypto', async () => {
      // handleMessage schedules dispatchFrame as fire-and-forget, so calling
      // handleClose synchronously right after lands the close before
      // generateEphemeralKeyPair (and the rest of the async chain) resolves.
      // The state-recheck guards in handleOffer must observe the close and
      // bail before transport.send / transitionToEstablished — otherwise on a
      // real WebSocket adapter the post-close send would throw.
      const clientEphem = await generateEphemeralKeyPair();
      const transport = createFakeTransport();
      const peer = new Peer({
        role: 'desktop',
        transport,
        sign: identity.sign,
        installPubkey: identity.publicKey,
      });
      const p = peer.connect().catch(() => {});
      await flushMicrotasks();

      peer.handleMessage(
        JSON.stringify({
          type: 'e2e:offer',
          ephemeralPubkey: encodeBase64(clientEphem.publicKey),
        })
      );
      // Close immediately — before any awaited crypto in handleOffer settles.
      peer.handleClose({ code: 1006, reason: 'abnormal' });

      // Let the full handshake chain run; the bail-out guards should keep
      // transport.send from ever being called.
      await new Promise((r) => setTimeout(r, 50));

      expect(peer.state).toBe('closed');
      expect(transport.sent).toHaveLength(0);
      // handleClose itself doesn't push to transport.closed (no transport.close
      // call) — it only marks state. Confirm we didn't somehow re-close with
      // a 4500.
      expect(transport.closed).toHaveLength(0);
      await p;
    });
  });
});

function generateP384Spki(): Uint8Array {
  // Real well-formed SPKI-DER for an ECDH-P-384 public key — 120 bytes,
  // distinct from the P-256 91-byte fixture above. importPeerPublicKey
  // requests P-256 specifically, so loading this as the peer ephemeral
  // exercises the wrong-curve rejection path.
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  return new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

/**
 * Wait until the transport has at least `n` queued sent frames. Used in
 * client-side tests where `connect()` triggers an async crypto chain
 * (`generateEphemeralKeyPair` → `transport.send`) that needs more than one
 * microtask flush to complete.
 */
async function waitForSent(t: FakeTransport, n: number, maxIters = 200): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (t.sent.length >= n) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${n} sent frame(s); have ${t.sent.length}`);
}

function concatBase64Pair(aB64: string, bB64: string): Uint8Array {
  const a = Buffer.from(aB64, 'base64');
  const b = Buffer.from(bB64, 'base64');
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
