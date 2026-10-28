// End-to-end test: two Peer instances (one desktop, one client) wired
// through an in-memory transport pair. No real WebSocket; the entire
// handshake + payload exchange runs in-process.
//
// This is the canonical proof that desktop and client agree on the wire
// format and the cryptographic key derivation. Failure here points to a
// concrete divergence between the two roles.

import { describe, it, expect } from 'vitest';

import { Peer } from '../../src/peer/peer';
import type { DecodedMessage } from '../../src/peer/payload';
import { encodeBase64 } from '../../src/wire/encoding';
import { encodedJsonBytes, FrameTooLargeError } from '../../src/wire/frame-budget';
import { MAX_FRAME_CHARS } from '../../src/wire/messages';

import { bindPair, createTransportPair } from './fake-transport';
import { createFakeInstallIdentity } from './fixtures';

// Mirrors the web client's voice chunk size (remote-web/web/src/main.ts).
// The whole point of this constant living here too is to prove that a chunk
// of this size survives the encrypt + envelope round-trip under the wire cap.
const VOICE_CHUNK_BYTES = 32 * 1024;

describe('Peer integration', () => {
  it('completes the handshake and exchanges 100 ping/pong messages both ways', async () => {
    const identity = await createFakeInstallIdentity();
    const { a: clientTransport, b: desktopTransport } = createTransportPair();

    const client = new Peer({
      role: 'client',
      transport: clientTransport,
      expectedFingerprint: identity.fingerprint,
      handshakeTimeoutMs: 5_000,
    });
    const desktop = new Peer({
      role: 'desktop',
      transport: desktopTransport,
      sign: identity.sign,
      installPubkey: identity.publicKey,
      handshakeTimeoutMs: 5_000,
    });

    bindPair({
      aTransport: clientTransport,
      bTransport: desktopTransport,
      a: client,
      b: desktop,
    });

    const clientReceived: DecodedMessage[] = [];
    const desktopReceived: DecodedMessage[] = [];
    client.onMessage((m) => clientReceived.push(m));
    desktop.onMessage((m) => desktopReceived.push(m));

    // Both roles call connect() concurrently; the in-memory transport delivers
    // the offer to the desktop's handleMessage on the next microtask.
    await Promise.all([client.connect(), desktop.connect()]);

    expect(client.state).toBe('established');
    expect(desktop.state).toBe('established');
    expect(client.getChannelBinding()).toEqual(desktop.getChannelBinding());
    expect(client.getChannelBinding()).toHaveLength(32);

    // Alternate sender to exercise both directions of the seq counter and
    // both nonce-direction bytes.
    for (let i = 0; i < 100; i++) {
      if (i % 2 === 0) {
        await client.sendEncryptedJson({ ping: i });
      } else {
        await desktop.sendEncryptedJson({ pong: i });
      }
      // Yield to the microtask queue so the other side processes the frame
      // before the next iteration sends one.
      await new Promise((r) => setTimeout(r, 0));
    }

    // Allow any trailing in-flight microtasks to flush.
    await new Promise((r) => setTimeout(r, 10));

    expect(clientReceived).toHaveLength(50); // half of 100, the desktop's pongs
    expect(desktopReceived).toHaveLength(50);

    // Strict ordering: the desktop received {ping:0}, {ping:2}, ...
    for (let i = 0; i < 50; i++) {
      const msg = desktopReceived[i]!;
      expect(msg.kind).toBe('json');
      if (msg.kind === 'json') expect(msg.data).toEqual({ ping: i * 2 });
    }
    for (let i = 0; i < 50; i++) {
      const msg = clientReceived[i]!;
      expect(msg.kind).toBe('json');
      if (msg.kind === 'json') expect(msg.data).toEqual({ pong: i * 2 + 1 });
    }
  });

  it('round-trips binary frames as raw bytes', async () => {
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

    const received: DecodedMessage[] = [];
    desktop.onMessage((m) => received.push(m));

    await Promise.all([client.connect(), desktop.connect()]);

    const payload = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xab, 0xcd]);
    await client.sendEncryptedBinary(payload);
    await new Promise((r) => setTimeout(r, 5));

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.kind).toBe('binary');
    if (msg.kind === 'binary') expect(Array.from(msg.data)).toEqual(Array.from(payload));
  });

  it('rejects a replayed encrypted frame as a seq violation', async () => {
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

    // Capture what the client sends so we can replay it manually.
    await client.sendEncryptedJson({ first: true });
    await new Promise((r) => setTimeout(r, 5));

    const lastFrame = clientTransport.sent[clientTransport.sent.length - 1]!;
    // Deliver the SAME frame again — desktop's lastIncomingSeq has advanced
    // past its seq, so it should close as a seq violation.
    desktop.handleMessage(lastFrame);
    await new Promise((r) => setTimeout(r, 5));

    expect(desktop.state).toBe('closed');
    expect(desktopTransport.closed[0]?.code).toBe(4400);
    expect(desktopTransport.closed[0]?.reason).toBe('seq-violation');
  });

  it('rejects a frame that skips a seq, so a dropped frame cannot go unnoticed', async () => {
    // Something in the path could otherwise delete one frame, such as one
    // chunk of typed input, and the session would carry on without it.
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

    // Stop automatic delivery, then hand the desktop only the second frame.
    clientTransport.partner = undefined;
    await client.sendEncryptedJson({ input: 'rm -rf build' });
    await client.sendEncryptedJson({ input: '\r' });
    const second = clientTransport.sent[clientTransport.sent.length - 1]!;
    expect(JSON.parse(second).seq).toBe(1);

    desktop.handleMessage(second);
    await new Promise((r) => setTimeout(r, 5));

    expect(desktop.state).toBe('closed');
    expect(desktopTransport.closed[0]?.code).toBe(4400);
    expect(desktopTransport.closed[0]?.reason).toBe('seq-violation');
  });

  it('reports bytes still waiting to be sent, including what the transport holds', async () => {
    const identity = await createFakeInstallIdentity();
    const { a: clientTransport, b: desktopTransport } = createTransportPair();
    const transportHolds = 100;
    const client = new Peer({
      role: 'client',
      transport: Object.assign(clientTransport, { bufferedAmount: () => transportHolds }),
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
    expect(client.bufferedAmount()).toBe(transportHolds);

    const sending = client.sendEncryptedJson({ output: 'x'.repeat(1_000) });
    expect(client.bufferedAmount()).toBeGreaterThan(transportHolds + 1_000);
    await sending;

    expect(client.bufferedAmount()).toBe(transportHolds);
    expect(desktop.bufferedAmount()).toBe(0);
  });

  it('rejects a tampered ciphertext as a decrypt failure', async () => {
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

    // Build a tampered enc frame manually: take a real one the client just
    // sent, flip a byte in the ciphertext, redeliver.
    await client.sendEncryptedJson({ x: 1 });
    await new Promise((r) => setTimeout(r, 5));

    const real = JSON.parse(clientTransport.sent[clientTransport.sent.length - 1]!);
    const ctBytes = Buffer.from(real.ciphertext, 'base64');
    ctBytes[0] ^= 0xff;
    // Bump both the wire seq and the nonce's encoded seq together so we pass
    // both monotonicity AND nonce-seq-binding and exercise the decrypt path.
    const newSeq = real.seq + 1;
    const nonceBytes = Buffer.from(real.nonce, 'base64');
    nonceBytes.writeUInt32BE(newSeq, 1);
    const tampered = JSON.stringify({
      ...real,
      seq: newSeq,
      nonce: nonceBytes.toString('base64'),
      ciphertext: ctBytes.toString('base64'),
    });

    desktop.handleMessage(tampered);
    await new Promise((r) => setTimeout(r, 5));

    expect(desktop.state).toBe('closed');
    expect(desktopTransport.closed[0]?.code).toBe(4401);
    expect(desktopTransport.closed[0]?.reason).toBe('decrypt-failed');
  });

  it('rejects a reflected encrypted frame with nonce-direction-mismatch', async () => {
    // Threat model: the relay sees encrypted frames opaquely but can replay
    // them. Both peers share the AES-GCM session key, so a frame the client
    // sent (carrying the client→desktop direction byte) would decrypt cleanly
    // if reflected back to the client. The direction-byte check on receive is
    // what prevents the relay from delivering our own outbound message back to
    // us as if it came from the peer.
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

    // Capture the exact frame the client emits — wire seq=0, nonce-direction
    // = client→desktop. Reflecting it back to the client lands at the client's
    // handleEncrypted: client.lastIncomingSeq=-1 so seq=0 passes monotonicity,
    // but the direction byte is wrong from the client's vantage.
    await client.sendEncryptedJson({ outbound: true });
    await new Promise((r) => setTimeout(r, 5));

    const reflected = clientTransport.sent[clientTransport.sent.length - 1]!;
    client.handleMessage(reflected);
    await new Promise((r) => setTimeout(r, 5));

    expect(client.state).toBe('closed');
    expect(clientTransport.closed[0]?.code).toBe(4400);
    expect(clientTransport.closed[0]?.reason).toBe('nonce-direction-mismatch');
  });

  it('rejects a frame whose wire seq disagrees with the seq encoded in the nonce', async () => {
    // The receiver only used to check the cleartext seq, then handed the
    // wire-supplied 12-byte IV straight to AES-GCM. Decoupling wire-seq from
    // nonce-seq is either a buggy sender or an attacker probing for a
    // nonce-reuse opportunity under the shared key. Either way: hard close.
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

    // Real outbound frame has wire seq=0 and nonce-seq=0, and the desktop
    // accepts it. Bump only the wire seq to 1: that is the next seq the
    // desktop expects, so the nonce-seq-binding check is what fires.
    await client.sendEncryptedJson({ first: true });
    await new Promise((r) => setTimeout(r, 5));

    const real = JSON.parse(clientTransport.sent[clientTransport.sent.length - 1]!);
    const forged = JSON.stringify({ ...real, seq: 1 });

    desktop.handleMessage(forged);
    await new Promise((r) => setTimeout(r, 5));

    expect(desktop.state).toBe('closed');
    expect(desktopTransport.closed[0]?.code).toBe(4400);
    expect(desktopTransport.closed[0]?.reason).toBe('nonce-seq-mismatch');
  });

  it('rejects a synchronously-replayed encrypted frame (lastIncomingSeq advanced before decrypt)', async () => {
    // Race scenario the relay can drive: deliver the same frame twice
    // back-to-back, before the first decrypt resolves. The receiver claims
    // its seq slot synchronously (before awaiting decrypt) so the second
    // delivery fails the seq check immediately rather than slipping through
    // on a stale counter.
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

    await client.sendEncryptedJson({ once: true });
    // Snapshot the frame immediately, then deliver the SAME frame a second
    // time synchronously — no microtask yield in between. The first
    // dispatchFrame is suspended at `await decrypt`; without claiming the
    // seq slot synchronously, the second delivery would also pass the seq
    // check and a duplicate would be delivered to the application.
    const frame = clientTransport.sent[clientTransport.sent.length - 1]!;
    desktop.handleMessage(frame);
    await new Promise((r) => setTimeout(r, 10));

    // Load-bearing assertions: the second delivery triggered a seq-violation
    // close, and the application never saw a duplicate. The post-decrypt
    // state guard means the in-flight first frame is suppressed too — which
    // is the right behavior, since we already told the app the channel is
    // dead.
    expect(desktopReceived.length).toBeLessThanOrEqual(1);
    expect(desktop.state).toBe('closed');
    expect(desktopTransport.closed[0]?.code).toBe(4400);
    expect(desktopTransport.closed[0]?.reason).toBe('seq-violation');
  });

  it('preserves wire order across concurrent sendEncryptedJson calls', async () => {
    // Without the outbound chain, two concurrent sends race on `await
    // encrypt(...)`: call 0 holds seq=0, call 1 holds seq=1, but call 1's
    // encrypt may finish first and emit before call 0. The receiver would
    // then close on seq-violation when seq=0 arrived. The chain serializes
    // encrypt+send so wire order matches call order.
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

    // Fire 20 sends concurrently — no `await` between calls. The chain
    // must keep them in original call order on the wire.
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      sends.push(client.sendEncryptedJson({ i }));
    }
    await Promise.all(sends);
    await new Promise((r) => setTimeout(r, 20));

    expect(desktop.state).toBe('established');
    expect(desktopReceived).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      const msg = desktopReceived[i]!;
      expect(msg.kind).toBe('json');
      if (msg.kind === 'json') expect(msg.data).toEqual({ i });
    }
  });

  it('rejects queued sends that dequeue after the peer closes', async () => {
    // The public sendEncrypted* check state at call time, but a queued send
    // can dequeue after the peer has been closed mid-pipeline. Without the
    // in-encryptAndSend state guard, the queued send would call
    // transport.send on a torn-down channel.
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

    // Queue two sends synchronously, then close the client immediately. The
    // first send is in flight (already past its state guard, awaiting
    // encrypt); the second is parked behind it on the chain. When the second
    // dequeues, the post-await guard inside encryptAndSend should make it
    // reject rather than emitting a frame after local close.
    const a = client.sendEncryptedJson({ a: 1 });
    const b = client.sendEncryptedJson({ b: 2 });
    client.handleClose({ code: 1000, reason: 'test' });

    const aResult = await a.then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err })
    );
    const bResult = await b.then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err })
    );

    // The first send may either have completed before close or rejected on
    // its post-await guard — either is fine. The second is parked behind it
    // and must reject; we assert on its rejection specifically.
    expect(bResult.ok).toBe(false);
    if (!bResult.ok) {
      expect((bResult.err as Error).message).toMatch(/peer closed before send/);
    }
    expect(client.state).toBe('closed');
    // Sanity: avoid the unused-binding lint while keeping the assertion above
    // clear about which result we care about.
    void aResult;
  });

  it('switches to binary envelopes, sharing one seq counter with text frames', async () => {
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
    bindPair({ aTransport: clientTransport, bTransport: desktopTransport, a: client, b: desktop });
    const received: DecodedMessage[] = [];
    client.onMessage((m) => received.push(m));
    await Promise.all([client.connect(), desktop.connect()]);

    await desktop.sendEncryptedJson({ n: 1 });
    desktop.enableBinaryFrames();
    await desktop.sendEncryptedJson({ n: 2 });
    await desktop.sendEncryptedBinary(new Uint8Array([7, 8, 9]));
    await new Promise((r) => setTimeout(r, 10));

    expect(received.map((m) => m.data)).toEqual([{ n: 1 }, { n: 2 }, new Uint8Array([7, 8, 9])]);
    // The handshake answer and the first frame went as text.
    expect(desktopTransport.sent).toHaveLength(2);
    expect(desktopTransport.sentBinary).toHaveLength(2);
    // No JSON and no base64: the seq, the nonce, the AES-GCM tag and the payload tag.
    expect(desktopTransport.sentBinary[1]!.length).toBe(4 + 12 + 16 + 1 + 3);
    expect(desktop.maxBodyBytes()).toBeGreaterThan(client.maxBodyBytes());

    // A replayed binary frame is a seq violation like a replayed text frame.
    client.handleBinaryMessage(desktopTransport.sentBinary[0]!);
    await new Promise((r) => setTimeout(r, 10));
    expect(client.state).toBe('closed');
  });

  it('refuses binary frames before the handshake and without a binary transport', async () => {
    const identity = await createFakeInstallIdentity();
    const transport = createTransportPair().a;
    const desktop = new Peer({
      role: 'desktop',
      transport: { send: transport.send.bind(transport), close: transport.close.bind(transport) },
      sign: identity.sign,
      installPubkey: identity.publicKey,
    });
    expect(() => desktop.enableBinaryFrames()).toThrow(/cannot send binary/);
    void desktop.connect().catch(() => {});
    desktop.handleBinaryMessage(new Uint8Array(64));
    await new Promise((r) => setTimeout(r, 10));
    expect(desktop.state).toBe('closed');
  });

  it('delivers a frame that arrived just before the socket closed', async () => {
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
    bindPair({ aTransport: clientTransport, bTransport: desktopTransport, a: client, b: desktop });
    const events: string[] = [];
    client.onMessage((m) => events.push(`message ${JSON.stringify(m.data)}`));
    client.onClose((evt) => events.push(`close ${evt.code}`));
    await Promise.all([client.connect(), desktop.connect()]);

    // A rejection's reason, then the close right behind it, as the desktop sends them.
    await desktop.sendEncryptedJson({ type: 'pair:rejected', reason: 'busy' });
    desktop.close(1000, 'ceremony-complete');
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toEqual(['message {"type":"pair:rejected","reason":"busy"}', 'close 1000']);
    expect(client.state).toBe('closed');
  });

  it('refuses a frame too large for the receiver without spending a seq', async () => {
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
    bindPair({ aTransport: clientTransport, bTransport: desktopTransport, a: client, b: desktop });
    const received: DecodedMessage[] = [];
    client.onMessage((m) => received.push(m));
    await Promise.all([client.connect(), desktop.connect()]);

    // 24 Ki CJK characters: under a character cap, but about 98 K once encrypted and base64'd.
    const tooLarge = { data: '漢'.repeat(24 * 1024) };
    await expect(desktop.sendEncryptedJson(tooLarge)).rejects.toBeInstanceOf(FrameTooLargeError);
    const largest = { data: 'x'.repeat(desktop.maxBodyBytes() - encodedJsonBytes({ data: '' })) };
    await desktop.sendEncryptedJson(largest);
    await desktop.sendEncryptedJson({ after: true });
    await new Promise((r) => setTimeout(r, 10));

    for (const wire of desktopTransport.sent)
      expect(wire.length).toBeLessThanOrEqual(MAX_FRAME_CHARS);
    expect(client.state).toBe('established');
    expect(received.map((m) => m.data)).toEqual([largest, { after: true }]);
  });

  it('delivers a full-size voice chunk within the wire frame cap', async () => {
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

    const received: DecodedMessage[] = [];
    desktop.onMessage((m) => received.push(m));

    await Promise.all([client.connect(), desktop.connect()]);

    // A maximal voice chunk: VOICE_CHUNK_BYTES of PCM, base64'd into `audio`.
    const pcm = new Uint8Array(VOICE_CHUNK_BYTES);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff;
    const frame = {
      type: 'app:voice:transcribe' as const,
      requestId: 'r-voice',
      terminalId: 't1',
      audio: encodeBase64(pcm),
      seq: 0,
      final: true,
      enter: false,
    };

    const sentBefore = clientTransport.sent.length;
    await client.sendEncryptedJson(frame);
    await new Promise((r) => setTimeout(r, 5));

    // The encrypted `e2e:enc` envelope this chunk produced must fit under the
    // receiver's MAX_FRAME_CHARS, or parseFrame drops it and tears down the
    // session. This is the invariant that a 192 KiB chunk violated.
    const wire = clientTransport.sent[sentBefore]!;
    expect(wire.length).toBeLessThanOrEqual(MAX_FRAME_CHARS);

    // And it actually round-trips to the desktop intact.
    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.kind).toBe('json');
    if (msg.kind === 'json') expect(msg.data).toEqual(frame);
  });
});
