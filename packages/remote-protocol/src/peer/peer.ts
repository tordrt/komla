// Peer — one side of the end-to-end encrypted channel.
//
// Owns the handshake FSM, the ephemeral ECDH keypair, the derived AES-GCM
// session key, and the per-direction sequence counters. Stateless across
// instances: two Peers in the same process don't share any module-level
// state, so the package is safe to use for multiple simultaneous sessions.
//
// Roles are asymmetric:
//
//   client  — initiator. On `connect()` generates an ephemeral keypair and
//             sends `e2e:offer`. On receiving `e2e:answer`, verifies the
//             desktop's install pubkey matches the expected URL fingerprint
//             AND that the signature over `clientEphemSPKI ‖ desktopEphemSPKI`
//             checks out. Then derives the session key and is `established`.
//
//   desktop — responder. On `connect()` waits for `e2e:offer`. On receipt
//             generates its own ephemeral, derives the session key, signs the
//             concat with the install private key (via the injected `sign`
//             callback), sends `e2e:answer`, and is `established`.
//
// The desktop's install identity (the long-term ECDSA-P256 key) is never
// touched directly by this module — it stays in the Electron main process's
// install-identity service, which exposes its `sign` method to this Peer
// through the `sign` option. Likewise the install public key is passed in as
// raw SPKI-DER bytes; the package never reads it from disk or Keychain.

import {
  decrypt,
  DIRECTION_CLIENT_TO_DESKTOP,
  DIRECTION_DESKTOP_TO_CLIENT,
  encrypt,
  type Direction,
} from '../crypto/aead';
import {
  deriveSessionKey,
  generateEphemeralKeyPair,
  importPeerPublicKey,
  type EphemeralKeyPair,
} from '../crypto/ecdh';
import { fingerprintFromPublicKey } from '../crypto/fingerprint';
import { verifySignature } from '../crypto/signature';
import { buildHandshakeTranscript, hashHandshakeTranscript } from '../crypto/transcript';
import { PEER_CLOSE } from '../wire/close-codes';
import { decodeBase64, encodeBase64 } from '../wire/encoding';
import {
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  MAX_BINARY_BODY_BYTES,
} from '../wire/binary-envelope';
import { FrameTooLargeError, MAX_ENCRYPTED_BODY_BYTES } from '../wire/frame-budget';
import {
  parseFrame,
  type E2EAnswer,
  type E2EEnc,
  type E2EFrame,
  type E2EOffer,
} from '../wire/messages';

import {
  decodePayload,
  PAYLOAD_BINARY,
  PAYLOAD_JSON,
  tagPayload,
  type DecodedMessage,
} from './payload';
import type { PeerTransport } from './transport';

export type PeerState = 'idle' | 'awaitingPeer' | 'established' | 'closed';

export interface PeerLogger {
  debug?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
}

interface CommonOptions {
  transport: PeerTransport;
  /** Wall-clock budget for the handshake. Defaults to 10s. */
  handshakeTimeoutMs?: number;
  logger?: PeerLogger;
}

export interface ClientPeerOptions extends CommonOptions {
  role: 'client';
  /** The 64-hex-char SHA-256(SPKI) the URL pinned. */
  expectedFingerprint: string;
}

export interface DesktopPeerOptions extends CommonOptions {
  role: 'desktop';
  /**
   * Sign a buffer with the desktop's long-term install key. Must produce an
   * ECDSA-P256/SHA-256 signature in IEEE-P1363 (r||s, 64 bytes) form —
   * matching `dsaEncoding: 'ieee-p1363'` in Node `crypto`.
   *
   * Injected so this package never imports Electron / Node `crypto` and the
   * install private key never leaves the desktop's install-identity service.
   */
  sign: (data: Uint8Array) => Promise<Uint8Array>;
  /** SPKI-DER bytes of the install public key — sent in the `e2e:answer`. */
  installPubkey: Uint8Array;
}

export type PeerOptions = ClientPeerOptions | DesktopPeerOptions;

export interface PeerCloseEvent {
  code?: number;
  reason?: string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * One side of an end-to-end encrypted session. Construct, register listeners,
 * call `connect()`, then wire the underlying socket's events into
 * `handleMessage` / `handleClose` / `handleError`.
 */
export class Peer {
  private _state: PeerState = 'idle';
  private readonly options: PeerOptions;
  private readonly logger: PeerLogger;

  private ephemeral: EphemeralKeyPair | null = null;
  private sessionKey: CryptoKey | null = null;
  private channelBinding: Uint8Array | null = null;

  private outgoingSeq = 0;
  // Serializes the encrypt+send pair so concurrent sendEncrypted* calls
  // don't reorder on the wire. seq is assigned synchronously, so call N
  // gets a lower seq than call N+1, but the AES-GCM await can resolve in
  // the opposite order — without serialization the receiver would see seq
  // N+1 first and close on seq-violation when seq N arrives.
  private outboundChain: Promise<void> = Promise.resolve();
  // Plaintext bytes handed to sendEncrypted* that haven't reached the transport.
  private queuedOutboundBytes = 0;
  // Mirror of outboundChain on the receive side: serializes decrypt+dispatch
  // so application callbacks fire in seq order even when AES-GCM decrypt
  // resolves out of order between adjacent frames. The synchronous seq
  // claim in handleEncrypted protects the *counter*; this chain protects
  // the *delivery order* the application sees.
  private inboundChain: Promise<void> = Promise.resolve();
  // Tracks the last seq we've accepted from the peer; -1 sentinel means
  // "haven't seen any yet" so seq=0 is the legal first frame.
  private lastIncomingSeq = -1;
  // The socket closed; frames already received are being delivered first.
  private closing = false;
  // Encrypted frames go out as binary envelopes once both peers agreed to it.
  private binaryFrames = false;

  private handshakeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private establishedDeferred: Deferred<void> | null = null;

  private messageHandlers: Array<(msg: DecodedMessage) => void> = [];
  private establishedHandlers: Array<() => void> = [];
  private closeHandlers: Array<(evt: PeerCloseEvent) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  constructor(options: PeerOptions) {
    this.options = options;
    this.logger = options.logger ?? {};
  }

  get state(): PeerState {
    return this._state;
  }

  /** Hash of the authenticated handshake transcript for binding later authorization proofs. */
  getChannelBinding(): Uint8Array {
    if (this._state !== 'established' || !this.channelBinding) {
      throw new Error(`channel binding unavailable in state ${this._state}`);
    }
    return this.channelBinding.slice();
  }

  /**
   * Begin the handshake. Resolves when the session is `established`; rejects
   * if the handshake closes for any reason before that.
   *
   * On the client side this synchronously sends an `e2e:offer` after
   * generating the ephemeral keypair. On the desktop side it just installs
   * the timeout and waits for the client's offer to arrive via
   * `handleMessage`.
   */
  connect(): Promise<void> {
    if (this._state !== 'idle') {
      return Promise.reject(new Error(`Peer.connect called in state ${this._state}`));
    }

    this.establishedDeferred = createDeferred<void>();
    this._state = 'awaitingPeer';

    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeTimeoutId = setTimeout(() => {
      this.failHandshake(PEER_CLOSE.TIMEOUT.code, PEER_CLOSE.TIMEOUT.reason, 'handshake timeout');
    }, timeoutMs);

    if (this.options.role === 'client') {
      // Kick off the offer asynchronously so any synchronous error in the
      // caller's wiring doesn't race with the deferred we just built.
      void this.sendOffer().catch((err) => this.fatalError(err, 'failed to send e2e:offer'));
    }

    return this.establishedDeferred.promise;
  }

  /** Encrypt and send a JSON-serializable value. */
  async sendEncryptedJson(value: unknown): Promise<void> {
    if (this._state !== 'established') {
      throw new Error(`sendEncryptedJson in state ${this._state}`);
    }
    const body = new TextEncoder().encode(JSON.stringify(value));
    await this.sendEncryptedTagged(PAYLOAD_JSON, body);
  }

  /** Encrypt and send arbitrary binary bytes. */
  async sendEncryptedBinary(bytes: Uint8Array): Promise<void> {
    if (this._state !== 'established') {
      throw new Error(`sendEncryptedBinary in state ${this._state}`);
    }
    await this.sendEncryptedTagged(PAYLOAD_BINARY, bytes);
  }

  /**
   * Bytes sent but not yet taken by the network: still queued for encryption
   * here, plus whatever the transport buffers. Lets a sender notice a slow
   * connection before it queues more.
   */
  bufferedAmount(): number {
    return this.queuedOutboundBytes + (this.options.transport.bufferedAmount?.() ?? 0);
  }

  close(code?: number, reason?: string): void {
    if (this._state === 'closed') return;
    this._state = 'closed';
    this.clearHandshakeTimer();
    try {
      this.options.transport.close(code, reason);
    } catch (err) {
      this.logger.warn?.('transport.close threw', err);
    }
    if (this.establishedDeferred) {
      this.establishedDeferred.reject(
        new Error(`Peer closed (${code ?? '<no-code>'} ${reason ?? ''})`.trim())
      );
      this.establishedDeferred = null;
    }
    for (const cb of this.closeHandlers) {
      try {
        cb({ code, reason });
      } catch (err) {
        this.logger.warn?.('onClose handler threw', err);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Inbound socket events — called by the caller from their WS adapter.
  // ────────────────────────────────────────────────────────────────────────

  handleMessage(raw: string): void {
    if (this._state === 'closed') return;

    const frame = parseFrame(raw);
    if (!frame) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        'unparseable frame'
      );
      return;
    }

    void this.dispatchFrame(frame).catch((err) => this.fatalError(err, 'frame dispatch threw'));
  }

  /** A binary WebSocket message: an encrypted frame in a binary envelope. */
  handleBinaryMessage(bytes: Uint8Array): void {
    if (this._state === 'closed') return;
    const envelope = this._state === 'established' ? decodeBinaryEnvelope(bytes) : null;
    if (!envelope) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        `unexpected binary frame in ${this._state}`
      );
      return;
    }
    void this.receiveEncrypted(envelope.seq, envelope.nonce, envelope.ciphertext).catch((err) =>
      this.fatalError(err, 'binary frame dispatch threw')
    );
  }

  handleClose(evt: PeerCloseEvent): void {
    if (this._state === 'closed' || this.closing) return;
    this.closing = true;
    // Frames that arrived before the close are still delivered first: a
    // rejection is sent just before the socket closes, and its reason matters.
    void this.inboundChain.then(() => this.finishClose(evt));
  }

  private finishClose(evt: PeerCloseEvent): void {
    if (this._state === 'closed') return;
    this._state = 'closed';
    this.clearHandshakeTimer();
    if (this.establishedDeferred) {
      this.establishedDeferred.reject(
        new Error(
          `socket closed mid-handshake (${evt.code ?? '<no-code>'} ${evt.reason ?? ''})`.trim()
        )
      );
      this.establishedDeferred = null;
    }
    for (const cb of this.closeHandlers) {
      try {
        cb(evt);
      } catch (err) {
        this.logger.warn?.('onClose handler threw', err);
      }
    }
  }

  handleError(err: Error): void {
    for (const cb of this.errorHandlers) {
      try {
        cb(err);
      } catch (handlerErr) {
        this.logger.warn?.('onError handler threw', handlerErr);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Listener registration
  // ────────────────────────────────────────────────────────────────────────

  onMessage(cb: (msg: DecodedMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onEstablished(cb: () => void): void {
    this.establishedHandlers.push(cb);
  }

  onClose(cb: (evt: PeerCloseEvent) => void): void {
    this.closeHandlers.push(cb);
  }

  onError(cb: (err: Error) => void): void {
    this.errorHandlers.push(cb);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Frame dispatch — the FSM lives here.
  // ────────────────────────────────────────────────────────────────────────

  private async dispatchFrame(frame: E2EFrame): Promise<void> {
    if (this._state === 'awaitingPeer') {
      if (frame.type === 'e2e:offer' && this.options.role === 'desktop') {
        await this.handleOffer(frame);
        return;
      }
      if (frame.type === 'e2e:answer' && this.options.role === 'client') {
        await this.handleAnswer(frame);
        return;
      }
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        `unexpected ${frame.type} in awaitingPeer (${this.options.role})`
      );
      return;
    }
    if (this._state === 'established') {
      if (frame.type === 'e2e:enc') {
        await this.handleEncrypted(frame);
        return;
      }
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        `unexpected ${frame.type} in established`
      );
      return;
    }
    // 'idle' or 'closed' — no inbound is legal here.
    this.failHandshake(
      PEER_CLOSE.BAD_REQUEST.code,
      PEER_CLOSE.BAD_REQUEST.reason,
      `inbound frame in state ${this._state}`
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Client side
  // ────────────────────────────────────────────────────────────────────────

  private async sendOffer(): Promise<void> {
    if (this.options.role !== 'client') return;
    this.ephemeral = await generateEphemeralKeyPair();
    const offer: E2EOffer = {
      type: 'e2e:offer',
      ephemeralPubkey: encodeBase64(this.ephemeral.publicKey),
    };
    this.options.transport.send(JSON.stringify(offer));
  }

  private async handleAnswer(answer: E2EAnswer): Promise<void> {
    if (this.options.role !== 'client') return;
    if (!this.ephemeral) {
      // Defensive: should be impossible — we generate the ephemeral before
      // sending the offer, and the only way to land here is after sending it.
      this.failHandshake(
        PEER_CLOSE.INTERNAL.code,
        PEER_CLOSE.INTERNAL.reason,
        'no client ephemeral'
      );
      return;
    }

    const desktopEphem = decodeBase64(answer.ephemeralPubkey);
    const installPub = decodeBase64(answer.installPubkey);
    const signature = decodeBase64(answer.signature);
    if (!desktopEphem || !installPub || !signature) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        'answer field failed base64 decode'
      );
      return;
    }

    // 1. The install pubkey the desktop just sent must hash to the
    //    fingerprint the client pulled out of the URL. If a malicious relay
    //    swapped the install pubkey, this catches it before signature verify
    //    even runs.
    const fp = await fingerprintFromPublicKey(installPub);
    // If the socket closed while the await above was in flight, handleClose
    // already cleaned up — bail silently rather than continuing to crunch
    // crypto and possibly call transport.send on a torn-down socket. Same
    // pattern at every await-boundary in this method and in handleOffer.
    if (this._state !== 'awaitingPeer') return;
    if (fp !== this.options.expectedFingerprint) {
      this.failHandshake(
        PEER_CLOSE.AUTH_FAILED.code,
        PEER_CLOSE.AUTH_FAILED.reason,
        'install pubkey fingerprint mismatch'
      );
      return;
    }

    // 2. The signature must verify over `clientEphemSPKI ‖ desktopEphemSPKI`
    //    using the install pubkey we just authenticated. This binds the
    //    handshake to the install identity end-to-end — a relay can't swap
    //    either ephemeral without invalidating the signature, because both
    //    are inside the signed material.
    const transcript = buildHandshakeTranscript({
      clientEphemeral: this.ephemeral.publicKey,
      desktopEphemeral: desktopEphem,
      desktopIdentity: installPub,
    });
    const sigOk = await verifySignature(transcript, signature, installPub);
    if (this._state !== 'awaitingPeer') return;
    if (!sigOk) {
      this.failHandshake(
        PEER_CLOSE.AUTH_FAILED.code,
        PEER_CLOSE.AUTH_FAILED.reason,
        'signature verify failed'
      );
      return;
    }

    // 3. Derive the session key. importPeerPublicKey throws on malformed or
    //    wrong-curve SPKI — that's attacker-controlled wire data, so map it
    //    to BAD_REQUEST rather than letting it bubble up as INTERNAL.
    try {
      const peerKey = await importPeerPublicKey(desktopEphem);
      this.channelBinding = await hashHandshakeTranscript(transcript);
      this.sessionKey = await deriveSessionKey({
        myPrivateKey: this.ephemeral.privateKey,
        peerPublicKey: peerKey,
        clientEphemPubKey: this.ephemeral.publicKey,
        desktopEphemPubKey: desktopEphem,
        transcriptHash: this.channelBinding,
      });
    } catch (err) {
      if (this._state !== 'awaitingPeer') return;
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        `peer ephemeral SPKI rejected: ${(err as Error).message}`
      );
      return;
    }
    if (this._state !== 'awaitingPeer') return;
    this.transitionToEstablished();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Desktop side
  // ────────────────────────────────────────────────────────────────────────

  private async handleOffer(offer: E2EOffer): Promise<void> {
    if (this.options.role !== 'desktop') return;

    const clientEphem = decodeBase64(offer.ephemeralPubkey);
    if (!clientEphem) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        'offer ephemeralPubkey failed base64 decode'
      );
      return;
    }

    this.ephemeral = await generateEphemeralKeyPair();
    if (this._state !== 'awaitingPeer') return;

    const transcript = buildHandshakeTranscript({
      clientEphemeral: clientEphem,
      desktopEphemeral: this.ephemeral.publicKey,
      desktopIdentity: this.options.installPubkey,
    });
    this.channelBinding = await hashHandshakeTranscript(transcript);
    if (this._state !== 'awaitingPeer') return;

    // importPeerPublicKey throws on malformed or wrong-curve SPKI — that's
    // attacker-controlled wire data, so map it to BAD_REQUEST rather than
    // letting it bubble up as INTERNAL.
    try {
      const peerKey = await importPeerPublicKey(clientEphem);
      this.sessionKey = await deriveSessionKey({
        myPrivateKey: this.ephemeral.privateKey,
        peerPublicKey: peerKey,
        clientEphemPubKey: clientEphem,
        desktopEphemPubKey: this.ephemeral.publicKey,
        transcriptHash: this.channelBinding,
      });
    } catch (err) {
      if (this._state !== 'awaitingPeer') return;
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        `peer ephemeral SPKI rejected: ${(err as Error).message}`
      );
      return;
    }
    if (this._state !== 'awaitingPeer') return;

    const signature = await this.options.sign(transcript);
    if (this._state !== 'awaitingPeer') return;

    const answer: E2EAnswer = {
      type: 'e2e:answer',
      ephemeralPubkey: encodeBase64(this.ephemeral.publicKey),
      installPubkey: encodeBase64(this.options.installPubkey),
      signature: encodeBase64(signature),
    };
    this.options.transport.send(JSON.stringify(answer));
    this.transitionToEstablished();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Established phase: encrypt/decrypt, seq counter discipline
  // ────────────────────────────────────────────────────────────────────────

  /** The largest JSON or binary body one encrypted frame carries. */
  maxBodyBytes(): number {
    return this.binaryFrames ? MAX_BINARY_BODY_BYTES : MAX_ENCRYPTED_BODY_BYTES;
  }

  /**
   * Sends later encrypted frames as binary envelopes. Call only once the
   * other peer listed the binary-frames capability; incoming frames may be
   * either kind at any time, and share one seq counter.
   */
  enableBinaryFrames(): void {
    if (!this.options.transport.sendBinary) {
      throw new Error('this transport cannot send binary frames');
    }
    this.binaryFrames = true;
  }

  /** Whether encrypted frames go out as binary envelopes. */
  usesBinaryFrames(): boolean {
    return this.binaryFrames;
  }

  private sendEncryptedTagged(tag: number, body: Uint8Array): Promise<void> {
    // The receiver would end the session on an oversized frame. Refuse it
    // here instead, before it takes a seq, so only this send fails.
    if (body.length > this.maxBodyBytes()) {
      return Promise.reject(new FrameTooLargeError(body.length, this.maxBodyBytes()));
    }
    // Chain behind any in-flight encrypt+send so wire order matches call
    // order. Catch on the chain swallows rejections so one failure doesn't
    // poison subsequent sends — each caller still receives their own
    // rejection via the returned promise.
    this.queuedOutboundBytes += body.length;
    const next = this.outboundChain
      .then(() => this.encryptAndSend(tag, body))
      .finally(() => {
        this.queuedOutboundBytes -= body.length;
      });
    this.outboundChain = next.catch(() => {});
    return next;
  }

  private async encryptAndSend(tag: number, body: Uint8Array): Promise<void> {
    // The public sendEncrypted* wrappers check state at call time, but a
    // queued send may run after the peer has closed. Re-check at queue
    // dequeue and again after the encrypt await — sessionKey isn't nulled
    // on close, so we can't rely on that guard alone, and emitting a frame
    // after local close would either silently drop on the fake transport
    // or throw on a real WebSocket.
    if (this._state !== 'established') throw new Error('peer closed before send');
    if (!this.sessionKey) throw new Error('no session key');
    const seq = this.outgoingSeq++;
    if (seq > 0xffffffff) {
      // 32-bit counter overflow — close the session rather than wrapping
      // into nonce reuse. A new ECDH would reset the counters.
      this.close(PEER_CLOSE.INTERNAL.code, 'seq-overflow');
      throw new Error('outgoing seq counter overflowed');
    }
    const direction = this.outgoingDirection();
    const payload = tagPayload(tag as 0x01 | 0x02, body);
    const { nonce, ciphertext } = await encrypt(this.sessionKey, direction, seq, payload);
    if (this._state !== 'established') throw new Error('peer closed before send');
    if (this.binaryFrames) {
      this.options.transport.sendBinary!(encodeBinaryEnvelope({ seq, nonce, ciphertext }));
      return;
    }
    const frame: E2EEnc = {
      type: 'e2e:enc',
      seq,
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(ciphertext),
    };
    this.options.transport.send(JSON.stringify(frame));
  }

  private async handleEncrypted(frame: E2EEnc): Promise<void> {
    const nonce = decodeBase64(frame.nonce);
    const ciphertext = decodeBase64(frame.ciphertext);
    if (!nonce || !ciphertext) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        'enc frame field failed base64 decode'
      );
      return;
    }
    return this.receiveEncrypted(frame.seq, nonce, ciphertext);
  }

  /** One encrypted frame, from a text or a binary envelope. */
  private async receiveEncrypted(
    seq: number,
    nonce: Uint8Array,
    ciphertext: Uint8Array
  ): Promise<void> {
    if (!this.sessionKey) {
      this.failHandshake(PEER_CLOSE.INTERNAL.code, PEER_CLOSE.INTERNAL.reason, 'no session key');
      return;
    }
    // Frames must arrive with consecutive seqs. A repeat is a replay; a gap
    // means a frame was dropped in transit, such as one chunk of typed input.
    if (seq !== this.lastIncomingSeq + 1) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        'seq-violation',
        `seq ${seq} did not follow ${this.lastIncomingSeq}`
      );
      return;
    }

    // The wire-supplied nonce is opaque to AES-GCM, but we trust its layout
    // for our own anti-replay invariants. Validate both fields the sender is
    // supposed to encode:
    //   - byte 0 must be the *incoming* direction. Without this check the
    //     relay can reflect our own outbound frame back to us; both peers
    //     share the session key, so the reflected frame would decrypt cleanly
    //     and be delivered as if it came from the peer.
    //   - bytes 1..4 BE must equal the cleartext seq. Mismatch means the
    //     sender is decoupling wire-seq from nonce-seq, which is either a
    //     bug or an attacker probing for nonce-reuse opportunities.
    if (nonce.length !== 12) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        `nonce length ${nonce.length} (expected 12)`
      );
      return;
    }
    if (nonce[0] !== this.incomingDirection()) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        'nonce-direction-mismatch',
        `nonce direction byte ${nonce[0]} (expected ${this.incomingDirection()})`
      );
      return;
    }
    const nonceSeq = ((nonce[1]! << 24) | (nonce[2]! << 16) | (nonce[3]! << 8) | nonce[4]!) >>> 0;
    if (nonceSeq !== seq) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        'nonce-seq-mismatch',
        `nonce seq ${nonceSeq} did not match wire seq ${seq}`
      );
      return;
    }

    // Claim the seq slot BEFORE awaiting decrypt. handleMessage dispatches
    // each frame as fire-and-forget, so two frames delivered back-to-back
    // both reach this point synchronously — without claiming early, both
    // pass the `seq <= lastIncomingSeq` check on the same stale counter and
    // a replay (or a legitimate seq=N+1 racing seq=N) gets through. Failed
    // decrypt is session-fatal anyway, so there's no "burned slot" cost to
    // advancing first.
    this.lastIncomingSeq = seq;

    // Capture the session key at the sync point so a later teardown can't
    // null it out from under decryptAndDeliver.
    const key = this.sessionKey;

    // Queue decrypt+dispatch behind any in-flight inbound work. AES-GCM
    // decrypt time varies between frames; without serializing here, frame
    // N+1's decrypt could resolve before frame N's and the application
    // would see callbacks in nonce order rather than wire order. Catch on
    // the chain swallows rejections so one decrypt failure doesn't poison
    // subsequent dispatches — each call still propagates its own rejection
    // through the returned promise.
    const next = this.inboundChain.then(() => this.decryptAndDeliver(key, nonce, ciphertext));
    this.inboundChain = next.catch(() => {});
    return next;
  }

  private async decryptAndDeliver(
    key: CryptoKey,
    nonce: Uint8Array,
    ciphertext: Uint8Array
  ): Promise<void> {
    // A frame queued before close (e.g. behind a slow predecessor that
    // ultimately failed decrypt) — drop without callbacks.
    if (this._state !== 'established') return;

    let plaintext: Uint8Array;
    try {
      plaintext = await decrypt(key, nonce, ciphertext);
    } catch (err) {
      // AES-GCM tag mismatch in an established session means the relay (or
      // someone in the path) tampered with the frame. Session-fatal.
      this.failHandshake(
        PEER_CLOSE.AUTH_FAILED.code,
        'decrypt-failed',
        `decrypt error: ${(err as Error).message}`
      );
      return;
    }
    // A frame delivered while we were awaiting decrypt may have closed the
    // session (seq-violation, etc.). Don't deliver this frame's payload
    // after the close — the application has already been told the channel
    // is dead.
    if (this._state !== 'established') return;

    const decoded = decodePayload(plaintext);
    if (!decoded) {
      this.failHandshake(
        PEER_CLOSE.BAD_REQUEST.code,
        PEER_CLOSE.BAD_REQUEST.reason,
        'unknown payload tag'
      );
      return;
    }

    for (const cb of this.messageHandlers) {
      try {
        cb(decoded);
      } catch (err) {
        this.logger.warn?.('onMessage handler threw', err);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  private transitionToEstablished(): void {
    if (this._state !== 'awaitingPeer') return;
    this._state = 'established';
    this.clearHandshakeTimer();
    if (this.establishedDeferred) {
      this.establishedDeferred.resolve();
      this.establishedDeferred = null;
    }
    for (const cb of this.establishedHandlers) {
      try {
        cb();
      } catch (err) {
        this.logger.warn?.('onEstablished handler threw', err);
      }
    }
  }

  private failHandshake(code: number, reason: string, debug: string): void {
    this.logger.warn?.(`peer fatal: ${debug}`, { code, reason });
    this.close(code, reason);
  }

  private fatalError(err: unknown, debug: string): void {
    this.logger.error?.(debug, err);
    this.close(PEER_CLOSE.INTERNAL.code, PEER_CLOSE.INTERNAL.reason);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimeoutId) {
      clearTimeout(this.handshakeTimeoutId);
      this.handshakeTimeoutId = null;
    }
  }

  private outgoingDirection(): Direction {
    return this.options.role === 'desktop'
      ? DIRECTION_DESKTOP_TO_CLIENT
      : DIRECTION_CLIENT_TO_DESKTOP;
  }

  private incomingDirection(): Direction {
    return this.options.role === 'desktop'
      ? DIRECTION_CLIENT_TO_DESKTOP
      : DIRECTION_DESKTOP_TO_CLIENT;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
