import { timingSafeEqual } from 'crypto';

import {
  buildDeviceProof,
  decodeBase64,
  deviceIdFromPublicKey,
  encodeBase64,
  parsePairFrame,
  REMOTE_CAPABILITIES,
  verifyDeviceProof,
  type PairAuthChallenge,
  type PairAuthenticated,
  type PairFrame,
  type PairRegistrationChallenge,
  type PairRegistered,
  type PairRejected,
  type PairResumeChallenge,
  type Peer,
} from '@komla/remote-protocol';

import { createLogger } from '../lib/logger';
import { verifyRegistration } from '../lib/webauthn-verify';
import { verifyAuthentication } from '../lib/webauthn-verify-auth';

import type { PairedDeviceRecord } from '../../shared/types/paired-device';
import type { RemoteControlError } from '../../shared/types/remote-control';

const logger = createLogger('RemoteControlAuthentication');

export interface RemoteControlEndpoint {
  httpOrigin: string;
  rpId: string;
}

export interface RemoteControlInstallIdentity {
  getPublicKey(): Promise<Uint8Array>;
  getFingerprint(): Promise<string>;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface RemoteControlPairedDeviceRegistry {
  getByCredentialId(id: string): PairedDeviceRecord | null;
  getByDeviceId(id: string): PairedDeviceRecord | null;
  list(): PairedDeviceRecord[];
  add(record: PairedDeviceRecord): void;
  recordAuthSuccess(credentialId: string, newCounter: number, ts: string): PairedDeviceRecord;
}

export interface RemoteControlPairingOffer {
  pairUrl: string;
  fingerprint: string;
  pairingSecret: string;
}

type CeremonyStage =
  | 'awaiting-hello'
  | 'awaiting-attestation'
  | 'awaiting-auth-response'
  | 'awaiting-resume-response'
  | 'verifying'
  | 'completed';

export interface RemoteControlCeremonyOptions {
  peer: Peer;
  endpoint: RemoteControlEndpoint;
  fingerprint: string;
  registerCeremonyTimeoutMs: number;
  authCeremonyTimeoutMs: number;
  /** How long a sign-in waits for the person to use their passkey. */
  passkeyTimeoutMs: number;
  registry: RemoteControlPairedDeviceRegistry;
  generateChallenge: () => Uint8Array;
  getPairingOffer: () => RemoteControlPairingOffer | null;
  /** Withdraws the offer if it still carries this secret; true for exactly one caller. */
  claimPairingOffer: (pairingSecret: string) => boolean;
  /** Protocol features this endpoint supports (`REMOTE_CAPABILITIES`). */
  capabilities?: readonly string[];
  /** The phone app build this desktop serves, so a page running another one reloads. */
  servedBuild?: () => string | undefined;
  resumption?: {
    issue(deviceId: string, verifiedAt?: number): { token: string; expiresAt: number };
    peek(deviceId: string, token: string): number | null;
    consume(deviceId: string, token: string): number | null;
  };
  onPairVerifying: (deviceLabel: string) => void;
  onAuthenticating: () => void;
  onPairCompleted: (deviceLabel: string, credentialId: string) => void;
  /** `resumeToken` is the grant this connection holds until it ends. */
  onAuthCompleted: (deviceLabel: string, credentialId: string, resumeToken?: string) => void;
  onCeremonyFailed: (err: RemoteControlError) => void;
}

export class RemoteControlCeremony {
  private readonly peer: Peer;
  private readonly opts: RemoteControlCeremonyOptions;
  private stage: CeremonyStage = 'awaiting-hello';
  private mode: 'register' | 'authenticate' | 'resume' | null = null;
  private deviceLabel: string | null = null;
  private challenge: string | null = null;
  private registeringDevicePublicKey: Uint8Array | null = null;
  private registeringDeviceId: string | null = null;
  private authenticatingDevice: PairedDeviceRecord | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  // For register-mode only: the one-time secret we matched against at hello.
  // Re-checked before persisting the new credential so a user cancel/restart
  // mid-ceremony invalidates the in-flight registration even though we've
  // already issued the WebAuthn challenge.
  private acceptedPairingSecret: string | null = null;
  // Features the browser's hello listed.
  private requestedCapabilities: readonly string[] = [];
  // When a resumed device last passed passkey verification.
  private resumedVerifiedAt: number | undefined;
  // The grant a resume redeems once its proof verifies.
  private resumeToken: string | null = null;

  constructor(opts: RemoteControlCeremonyOptions) {
    this.peer = opts.peer;
    this.opts = opts;
    // Wire message dispatch. The Peer's `onMessage` only fires after the
    // e2e channel is established, so by the time this runs the peer is in
    // `established` state.
    this.peer.onMessage((msg) => {
      if (this.cancelled) return;
      if (msg.kind !== 'json') {
        this.fail('attestation-invalid', 'binary frame not expected during ceremony');
        return;
      }
      const frame = parsePairFrame(msg.data);
      if (!frame) {
        this.fail('attestation-invalid', 'unparseable pair frame');
        return;
      }
      void this.handleFrame(frame).catch((err) => {
        logger.warn('ceremony.handleFrame threw', err);
        this.fail('internal', err instanceof Error ? err.message : String(err));
      });
    });
    // Start the wall-clock budget for the FIRST step. We don't yet know
    // whether the browser will register or authenticate, so use the
    // longer (registration) budget here. After `pair:hello` we re-arm
    // with the per-mode budget.
    this.armTimer(this.opts.registerCeremonyTimeoutMs);
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────

  private async handleFrame(frame: PairFrame): Promise<void> {
    if (this.cancelled) return;
    switch (this.stage) {
      case 'awaiting-hello':
        await this.handleHello(frame);
        return;
      case 'awaiting-attestation':
        await this.handleRegistrationResponse(frame);
        return;
      case 'awaiting-auth-response':
        await this.handleAuthResponse(frame);
        return;
      case 'awaiting-resume-response':
        await this.handleResumeResponse(frame);
        return;
      case 'verifying':
      case 'completed':
        // Late-arriving frames (e.g. a duplicate response while we're
        // verifying the first) — drop without re-processing.
        logger.warn('pair frame received after ceremony lock-in', {
          stage: this.stage,
          type: frame.type,
        });
    }
  }

  private async handleHello(frame: PairFrame): Promise<void> {
    if (frame.type !== 'pair:hello') {
      this.fail('attestation-invalid', `unexpected ${frame.type} before hello`);
      return;
    }
    if (frame.mode === 'register') {
      const offer = this.opts.getPairingOffer();
      if (!offer) {
        this.fail('unsupported-mode', 'registration is not currently offered');
        return;
      }
      if (!equalPairingSecrets(frame.pairingSecret, offer.pairingSecret)) {
        this.fail('pairing-secret-invalid', 'pairing secret did not match');
        return;
      }
      const devicePublicKey = decodeBase64(frame.devicePublicKey);
      if (!devicePublicKey) {
        this.fail('device-signature-failed', 'browser installation key was malformed');
        return;
      }
      const deviceId = await deviceIdFromPublicKey(devicePublicKey);
      if (this.cancelled) return;
      if (this.opts.registry.getByDeviceId(deviceId)) {
        this.fail('duplicate-credential', 'this browser installation is already paired');
        return;
      }
      this.mode = 'register';
      this.deviceLabel = frame.proposedLabel;
      this.registeringDevicePublicKey = devicePublicKey;
      this.registeringDeviceId = deviceId;
      this.acceptedPairingSecret = offer.pairingSecret;
      this.opts.onPairVerifying(frame.proposedLabel);
      await this.sendRegistrationChallenge(deviceId);
      this.stage = 'awaiting-attestation';
      this.armTimer(this.opts.registerCeremonyTimeoutMs);
      return;
    }
    const stored = this.reconnectingDevice(frame.deviceId);
    if (!stored) return;
    this.requestedCapabilities = frame.capabilities ?? [];
    if (frame.mode === 'resume') {
      // Checked here, used up only once the proof verifies, so a dropped attempt keeps it.
      if ((this.opts.resumption?.peek(frame.deviceId, frame.resumeToken) ?? null) === null) {
        this.fail('resume-invalid', 'the recent session grant expired or was already used');
        return;
      }
      this.resumeToken = frame.resumeToken;
      this.mode = 'resume';
      this.authenticatingDevice = stored;
      this.opts.onAuthenticating();
      await this.sendResumeChallenge();
      this.stage = 'awaiting-resume-response';
      this.armTimer(this.opts.authCeremonyTimeoutMs);
      return;
    }
    // mode === 'authenticate'
    this.mode = 'authenticate';
    this.authenticatingDevice = stored;
    this.opts.onAuthenticating();
    await this.sendAuthChallenge(stored);
    this.stage = 'awaiting-auth-response';
    this.armTimer(this.opts.passkeyTimeoutMs);
  }

  /** The paired record of a device signing in again, or null once the ceremony has failed. */
  private reconnectingDevice(deviceId: string): PairedDeviceRecord | null {
    const stored = this.opts.registry.getByDeviceId(deviceId);
    if (!stored) {
      this.fail('unknown-device', 'this browser installation is not paired');
      return null;
    }
    if (
      stored.rpId !== this.opts.endpoint.rpId ||
      stored.origin !== this.opts.endpoint.httpOrigin
    ) {
      this.fail('unknown-device', 'this browser installation was paired for a different origin');
      return null;
    }
    return stored;
  }

  private async sendRegistrationChallenge(deviceId: string): Promise<void> {
    const challengeBytes = this.opts.generateChallenge();
    const challenge = encodeBase64Url(challengeBytes);
    this.challenge = challenge;
    const challengeFrame: PairRegistrationChallenge = {
      type: 'pair:registration-challenge',
      challenge,
      rpId: this.opts.endpoint.rpId,
      rpName: 'Komla',
      origin: this.opts.endpoint.httpOrigin,
      user: {
        // A random-looking browser-installation id, not account information or
        // the stable desktop identity.
        id: encodeBase64UrlFromHex(deviceId),
        name: `Komla device (${deviceId.slice(0, 12)})`,
        displayName: 'Komla',
      },
      // Each browser installation pairs with a passkey of its own, so none is
      // excluded: a synced one belongs to another installation (an iPhone's
      // Safari and its Home Screen app share passkeys but not storage), and
      // excluding it would make the authenticator refuse to create this one.
      excludeCredentialIds: [],
    };
    await this.send(challengeFrame);
  }

  private async sendAuthChallenge(device: PairedDeviceRecord): Promise<void> {
    const challengeBytes = this.opts.generateChallenge();
    const challenge = encodeBase64Url(challengeBytes);
    this.challenge = challenge;
    const challengeFrame: PairAuthChallenge = {
      type: 'pair:auth-challenge',
      challenge,
      rpId: this.opts.endpoint.rpId,
      origin: this.opts.endpoint.httpOrigin,
      credentialId: device.credentialId,
    };
    await this.send(challengeFrame);
  }

  private async sendResumeChallenge(): Promise<void> {
    const challenge = encodeBase64Url(this.opts.generateChallenge());
    this.challenge = challenge;
    const challengeFrame: PairResumeChallenge = {
      type: 'pair:resume-challenge',
      challenge,
    };
    await this.send(challengeFrame);
  }

  private async handleRegistrationResponse(frame: PairFrame): Promise<void> {
    if (frame.type !== 'pair:registration-response') {
      this.fail('attestation-invalid', `unexpected ${frame.type} while awaiting attestation`);
      return;
    }
    this.stage = 'verifying';
    if (
      !this.challenge ||
      !this.deviceLabel ||
      !this.registeringDevicePublicKey ||
      !this.registeringDeviceId
    ) {
      this.fail('internal', 'attestation arrived without challenge in flight');
      return;
    }
    const deviceSignature = decodeBase64(frame.deviceSignature);
    if (
      !deviceSignature ||
      !(await verifyDeviceProof(
        this.registeringDevicePublicKey,
        buildDeviceProof('register', this.challenge, this.peer.getChannelBinding()),
        deviceSignature
      ))
    ) {
      this.fail('device-signature-failed', 'browser installation proof did not verify');
      return;
    }
    const result = await verifyRegistration({
      attestationResponse: frame.attestationResponse,
      expectedChallenge: this.challenge,
      expectedOrigin: this.opts.endpoint.httpOrigin,
      expectedRPID: this.opts.endpoint.rpId,
    });
    if (this.cancelled) return;
    if (!result.ok) {
      this.fail(result.reason, result.message);
      return;
    }
    if (this.opts.registry.getByCredentialId(result.credential.credentialId)) {
      this.fail('duplicate-credential', 'this credential is already paired');
      return;
    }
    // The offer we matched at hello may have been withdrawn or replaced while
    // the browser collected the WebAuthn assertion, or another browser holding
    // the same secret may have enrolled first. Claiming it here, with no await
    // before the registry write, keeps each offer to one trusted device.
    if (!this.acceptedPairingSecret || !this.opts.claimPairingOffer(this.acceptedPairingSecret)) {
      this.fail('internal', 'pairing was cancelled or restarted');
      return;
    }
    try {
      this.opts.registry.add({
        deviceId: this.registeringDeviceId,
        devicePublicKey: encodeBase64(this.registeringDevicePublicKey),
        credentialId: result.credential.credentialId,
        publicKey: result.credential.publicKey,
        signCounter: result.credential.signCounter,
        aaguid: result.credential.aaguid,
        label: this.deviceLabel,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        transports: result.credential.transports,
        rpId: this.opts.endpoint.rpId,
        origin: this.opts.endpoint.httpOrigin,
      });
    } catch (err) {
      this.fail('internal', err instanceof Error ? err.message : String(err));
      return;
    }
    const registered: PairRegistered = {
      type: 'pair:registered',
      deviceId: this.registeringDeviceId,
      credentialId: result.credential.credentialId,
      label: this.deviceLabel,
    };
    try {
      await this.send(registered);
    } catch (err) {
      // Past the registry write the device IS paired — log the channel
      // hiccup and let the user see "registered" in the UI even if the
      // browser missed the success frame.
      logger.warn('failed to send pair:registered after persistence', err);
    }
    this.complete();
    this.opts.onPairCompleted(this.deviceLabel, result.credential.credentialId);
  }

  private async handleAuthResponse(frame: PairFrame): Promise<void> {
    if (frame.type !== 'pair:auth-response') {
      this.fail('attestation-invalid', `unexpected ${frame.type} while awaiting auth response`);
      return;
    }
    this.stage = 'verifying';
    if (!this.challenge || !this.authenticatingDevice) {
      this.fail('internal', 'auth response arrived without challenge in flight');
      return;
    }

    const credentialId = frame.authenticationResponse.id;
    const stored = this.authenticatingDevice;
    if (credentialId !== stored.credentialId) {
      this.fail('unknown-credential', 'passkey does not belong to this browser installation');
      return;
    }
    const devicePublicKey = decodeBase64(stored.devicePublicKey);
    const deviceSignature = decodeBase64(frame.deviceSignature);
    if (
      !devicePublicKey ||
      !deviceSignature ||
      !(await verifyDeviceProof(
        devicePublicKey,
        buildDeviceProof('authenticate', this.challenge, this.peer.getChannelBinding()),
        deviceSignature
      ))
    ) {
      this.fail('device-signature-failed', 'browser installation proof did not verify');
      return;
    }
    const result = await verifyAuthentication({
      authenticationResponse: frame.authenticationResponse,
      expectedChallenge: this.challenge,
      expectedOrigin: this.opts.endpoint.httpOrigin,
      expectedRPID: this.opts.endpoint.rpId,
      storedCredential: {
        credentialId: stored.credentialId,
        publicKey: stored.publicKey,
        signCounter: stored.signCounter,
        transports: stored.transports,
      },
    });
    if (this.cancelled) return;
    if (!result.ok) {
      this.fail(result.reason, result.message);
      return;
    }

    let updated: PairedDeviceRecord;
    try {
      updated = this.opts.registry.recordAuthSuccess(
        credentialId,
        result.newCounter,
        new Date().toISOString()
      );
    } catch (err) {
      this.fail('internal', err instanceof Error ? err.message : String(err));
      return;
    }

    await this.finishAuthenticated(updated);
  }

  private async handleResumeResponse(frame: PairFrame): Promise<void> {
    if (frame.type !== 'pair:resume-response') {
      this.fail('attestation-invalid', `unexpected ${frame.type} while awaiting resume response`);
      return;
    }
    this.stage = 'verifying';
    if (!this.challenge || !this.authenticatingDevice) {
      this.fail('internal', 'resume response arrived without challenge in flight');
      return;
    }
    const stored = this.authenticatingDevice;
    const devicePublicKey = decodeBase64(stored.devicePublicKey);
    const deviceSignature = decodeBase64(frame.deviceSignature);
    if (
      !devicePublicKey ||
      !deviceSignature ||
      !(await verifyDeviceProof(
        devicePublicKey,
        buildDeviceProof('resume', this.challenge, this.peer.getChannelBinding()),
        deviceSignature
      ))
    ) {
      this.fail('device-signature-failed', 'browser installation resume proof did not verify');
      return;
    }
    // A connection that dropped while the proof was checked leaves the grant for the next attempt.
    if (this.cancelled) return;
    // Another connection may have redeemed it meanwhile; a grant yields one session.
    const verifiedAt =
      this.resumeToken === null
        ? null
        : (this.opts.resumption?.consume(stored.deviceId, this.resumeToken) ?? null);
    if (verifiedAt === null) {
      this.fail('resume-invalid', 'the recent session grant expired or was already used');
      return;
    }
    this.resumedVerifiedAt = verifiedAt;
    let updated: PairedDeviceRecord;
    try {
      updated = this.opts.registry.recordAuthSuccess(
        stored.credentialId,
        stored.signCounter,
        new Date().toISOString()
      );
    } catch (err) {
      this.fail('internal', err instanceof Error ? err.message : String(err));
      return;
    }
    await this.finishAuthenticated(updated);
  }

  private async finishAuthenticated(device: PairedDeviceRecord): Promise<void> {
    let grant: { token: string; expiresAt: number } | undefined;
    try {
      grant = this.opts.resumption?.issue(device.deviceId, this.resumedVerifiedAt);
    } catch (err) {
      logger.warn('failed to issue remote session resumption grant', err);
    }
    const capabilities = (this.opts.capabilities ?? []).filter((capability) =>
      this.requestedCapabilities.includes(capability)
    );
    const build = this.opts.servedBuild?.();
    const authenticated: PairAuthenticated = {
      type: 'pair:authenticated',
      deviceId: device.deviceId,
      credentialId: device.credentialId,
      label: device.label,
      ...(grant ? { resumeToken: grant.token, resumeExpiresAt: grant.expiresAt } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(build ? { build } : {}),
    };
    try {
      await this.send(authenticated);
    } catch (err) {
      // Same logic as register: the registry update has happened and the
      // session is logically authenticated; the UI's success state should
      // still appear even if the browser misses the ack.
      logger.warn('failed to send pair:authenticated after registry update', err);
    }
    // Both sides now use binary frames; the browser switches when it reads the reply.
    if (capabilities.includes(REMOTE_CAPABILITIES.BINARY_FRAMES)) this.peer.enableBinaryFrames();
    this.complete();
    this.opts.onAuthCompleted(device.label, device.credentialId, grant?.token);
  }

  private complete(): void {
    this.stage = 'completed';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fail(reason: PairRejected['reason'], message: string): void {
    if (this.cancelled || this.stage === 'completed') return;
    this.complete();
    this.cancelled = true;
    const rejected: PairRejected = { type: 'pair:rejected', reason, message };
    void this.send(rejected)
      .catch((err) => {
        logger.warn('failed to send pair:rejected', err);
      })
      .finally(() => {
        this.opts.onCeremonyFailed({
          message: `Remote-control ceremony failed: ${message}`,
          reason,
        });
      });
  }

  private async send(frame: PairFrame): Promise<void> {
    await this.peer.sendEncryptedJson(frame);
  }

  private armTimer(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.cancelled || this.stage === 'completed') return;
      logger.warn('ceremony timed out', { stage: this.stage });
      this.fail('internal', 'ceremony timeout');
    }, ms);
  }
}

function equalPairingSecrets(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encodeBase64UrlFromHex(hex: string): string {
  return encodeBase64Url(new Uint8Array(Buffer.from(hex, 'hex')));
}
