import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { join, normalize, resolve, sep } from 'path';

import { app } from 'electron';

import {
  classifyRelayFrame,
  Peer,
  REMOTE_CAPABILITIES,
  SESSION_CLOSE,
  type PeerTransport,
} from '@komla/remote-protocol';

import { IPC } from '../../shared/constants/ipc-channels';
import { remotePasskeyWindowMs } from '../../shared/lib/remote-passkey-window';
import { createLogger } from '../lib/logger';
import { RemoteSessionResumptionStore } from '../lib/remote-session-resumption';

import { configService } from './config.service';
import { installIdentityService } from './install-identity.service';
import { pairedDeviceRegistryService } from './paired-device-registry.service';
import {
  RemoteControlCeremony,
  type RemoteControlEndpoint,
  type RemoteControlInstallIdentity,
  type RemoteControlPairedDeviceRegistry,
  type RemoteControlPairingOffer,
} from './remote-control-authentication';
import {
  remoteControlSessionService,
  type RemoteControlSession,
  type RemoteSessionDevice,
} from './remote-control-session.service';
import { windowService } from './window.service';

import type {
  RemoteControlConnectedDevice,
  RemoteControlDirectPortChange,
  RemoteControlDirectState,
} from '../../shared/types/remote-control';
import type { Duplex } from 'stream';

const logger = createLogger('RemoteControlDirectService');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PUBLIC_HOST = 'localhost';
export const DEFAULT_DIRECT_REMOTE_PORT = 52864;
const DEFAULT_REGISTER_CEREMONY_TIMEOUT_MS = 120_000;
const DEFAULT_AUTH_CEREMONY_TIMEOUT_MS = 30_000;
// Long enough to tap Unlock, miss Face ID and type the passcode; the phone can ask again meanwhile.
const DEFAULT_PASSKEY_TIMEOUT_MS = 120_000;
const DEFAULT_PEER_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_PAIRING_OFFER_TIMEOUT_MS = 10 * 60_000;
// A silent phone is pinged every 15 s and dropped after three unanswered pings: one late pong
// on a phone's radio isn't a dead link (Orca Mobile #12790). The same device signing in again
// replaces a connection that is still waiting here.
const DEFAULT_HEARTBEAT_PING_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_RESUME_MAX_AGE_MS = 8 * 60 * 60_000;
const MAX_FRAME_BYTES = 1024 * 1024;
// Logins still in progress. A new connection replaces the oldest instead of
// the only one, so a stray connection can't cut off a phone mid-passkey.
const MAX_PENDING_SESSIONS = 4;
const DEFAULT_DEV_WEB_ASSET_DIR = join(process.cwd(), 'remote-web', 'public');

export interface RemoteControlDirectServerOptions {
  host?: string;
  port?: number;
  publicHost?: string;
  publicOrigin?: string;
}

export interface RemoteControlDirectServerInfo {
  host: string;
  port: number;
  preferredPort: number;
  localOrigin: string;
  httpOrigin: string;
  wsUrl: string;
  fingerprint: string;
}

export interface RemoteControlDirectServiceDeps {
  installIdentity?: RemoteControlInstallIdentity;
  pairedDeviceRegistry?: RemoteControlPairedDeviceRegistry;
  createAppSession?: (peer: Peer, device: RemoteSessionDevice) => RemoteControlSession;
  createServer?: typeof createServer;
  rng?: {
    challenge: () => Uint8Array;
    pairingSecret: () => string;
  };
  resumption?: RemoteSessionResumptionStore;
  registerCeremonyTimeoutMs?: number;
  authCeremonyTimeoutMs?: number;
  passkeyTimeoutMs?: number;
  peerHandshakeTimeoutMs?: number;
  pairingOfferTimeoutMs?: number;
  heartbeatPingMs?: number;
  heartbeatTimeoutMs?: number;
  webAssetDir?: string;
  emitStateChange?: (state: RemoteControlDirectState) => void;
  terminalPresentationTracking?: {
    enable(): void;
    disable(): void;
  };
}

class DirectPeerSession {
  private readonly peer: Peer;
  private ceremony: RemoteControlCeremony | null = null;
  private appSession: RemoteControlSession | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInboundMs = Date.now();
  private lastPingSentMs = 0;
  private connectedDevice: RemoteControlConnectedDevice | null = null;
  private resumeToken: string | undefined;
  private disposed = false;

  constructor(
    private readonly conn: DirectWebSocketConnection,
    private readonly opts: {
      endpoint: RemoteControlEndpoint;
      fingerprint: string;
      installPubkey: Uint8Array;
      sign: (data: Uint8Array) => Promise<Uint8Array>;
      registry: RemoteControlPairedDeviceRegistry;
      resumption: RemoteSessionResumptionStore;
      createAppSession: (peer: Peer, device: RemoteSessionDevice) => RemoteControlSession;
      generateChallenge: () => Uint8Array;
      getPairingOffer: () => RemoteControlPairingOffer | null;
      claimPairingOffer: (pairingSecret: string) => boolean;
      servedBuild: () => string | undefined;
      registerCeremonyTimeoutMs: number;
      authCeremonyTimeoutMs: number;
      passkeyTimeoutMs: number;
      peerHandshakeTimeoutMs: number;
      heartbeatPingMs: number;
      heartbeatTimeoutMs: number;
      onPairCompleted: (label: string, credentialId: string) => void;
      onAuthCompleted: (label: string, credentialId: string) => void;
      onCeremonyFailed: (err: { message: string }) => void;
      onClose: () => void;
    }
  ) {
    const transport: PeerTransport = {
      send: (data) => this.conn.send(data),
      sendBinary: (data) => this.conn.sendBinary(data),
      close: (code, reason) => this.conn.close(code, reason),
      bufferedAmount: () => this.conn.bufferedAmount(),
    };
    this.peer = new Peer({
      role: 'desktop',
      transport,
      installPubkey: opts.installPubkey,
      sign: opts.sign,
      handshakeTimeoutMs: opts.peerHandshakeTimeoutMs,
      logger: { warn: (msg, meta) => logger.warn(msg, meta) },
    });
    this.peer.onEstablished(() => this.startCeremony());
    this.peer.onClose(() => this.dispose({ connectionDropped: true }));
    this.conn.onMessage((data) => this.handleSocketMessage(data));
    this.conn.onBinaryMessage((data) => {
      this.lastInboundMs = Date.now();
      this.peer.handleBinaryMessage(data);
    });
    this.conn.onClose(() => this.dispose({ connectionDropped: true }));
    this.scheduleHeartbeat();
    void this.peer.connect().catch((err) => {
      logger.warn('direct peer.connect rejected', err);
      this.dispose();
    });
  }

  /**
   * `connectionDropped`: the phone lost this connection (or replaced it) rather
   * than the desktop ending the session, so it may come straight back.
   */
  dispose({
    code = 1000,
    reason = 'direct-session-disposed',
    connectionDropped = false,
  }: { code?: number; reason?: string; connectionDropped?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    // The phone can resume silently for a short while after this connection ends.
    if (this.resumeToken) this.opts.resumption.release(this.resumeToken);
    this.ceremony?.cancel();
    this.ceremony = null;
    this.appSession?.dispose({ connectionDropped });
    this.appSession = null;
    this.connectedDevice = null;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.peer.handleClose({ code, reason });
    this.conn.close(code, reason);
    this.opts.onClose();
  }

  getConnectedDevice(): RemoteControlConnectedDevice | null {
    return this.connectedDevice;
  }

  disconnectCredential(credentialId: string): boolean {
    if (this.connectedDevice?.credentialId !== credentialId) return false;
    this.dispose();
    return true;
  }

  private handleSocketMessage(data: string): void {
    this.lastInboundMs = Date.now();
    const relay = classifyRelayFrame(data);
    if (relay === 'pong') return;
    if (relay === 'ping') {
      this.conn.send(JSON.stringify({ type: 'relay:pong' }));
      return;
    }
    this.peer.handleMessage(data);
  }

  private scheduleHeartbeat(): void {
    if (this.disposed) return;
    this.heartbeatTimer = setTimeout(() => this.checkHeartbeat(), this.opts.heartbeatPingMs);
  }

  private checkHeartbeat(): void {
    this.heartbeatTimer = null;
    if (this.disposed) return;
    const now = Date.now();
    const stalenessMs = now - this.lastInboundMs;
    if (stalenessMs >= this.opts.heartbeatTimeoutMs) {
      this.conn.close(4408, 'heartbeat-timeout');
      this.dispose({ connectionDropped: true });
      return;
    }
    if (
      stalenessMs >= this.opts.heartbeatPingMs &&
      now - this.lastPingSentMs >= this.opts.heartbeatPingMs
    ) {
      this.lastPingSentMs = now;
      this.conn.send(JSON.stringify({ type: 'relay:ping' }));
    }
    const nextStalenessMs = Date.now() - this.lastInboundMs;
    const nextDelay = Math.max(
      1,
      Math.min(this.opts.heartbeatPingMs, this.opts.heartbeatTimeoutMs - nextStalenessMs)
    );
    this.heartbeatTimer = setTimeout(() => this.checkHeartbeat(), nextDelay);
  }

  private startCeremony(): void {
    if (this.disposed) return;
    this.ceremony = new RemoteControlCeremony({
      peer: this.peer,
      endpoint: this.opts.endpoint,
      fingerprint: this.opts.fingerprint,
      registerCeremonyTimeoutMs: this.opts.registerCeremonyTimeoutMs,
      authCeremonyTimeoutMs: this.opts.authCeremonyTimeoutMs,
      passkeyTimeoutMs: this.opts.passkeyTimeoutMs,
      registry: this.opts.registry,
      resumption: this.opts.resumption,
      generateChallenge: this.opts.generateChallenge,
      getPairingOffer: this.opts.getPairingOffer,
      claimPairingOffer: this.opts.claimPairingOffer,
      capabilities: [REMOTE_CAPABILITIES.BINARY_FRAMES, REMOTE_CAPABILITIES.PROJECT_ICONS],
      servedBuild: this.opts.servedBuild,
      onPairVerifying: () => {},
      onAuthenticating: () => {},
      onPairCompleted: (label, credentialId) => {
        this.opts.onPairCompleted(label, credentialId);
        this.dispose();
      },
      onAuthCompleted: (label, credentialId, resumeToken, capabilities) => {
        this.resumeToken = resumeToken;
        this.connectedDevice = { credentialId, label, connectedAt: Date.now() };
        this.opts.onAuthCompleted(label, credentialId);
        this.startAppSession({ credentialId, capabilities });
      },
      onCeremonyFailed: (err) => {
        this.opts.onCeremonyFailed(err);
        this.dispose();
      },
    });
  }

  private startAppSession(device: RemoteSessionDevice): void {
    if (this.disposed) return;
    this.ceremony?.cancel();
    this.ceremony = null;
    this.appSession?.dispose();
    this.appSession = this.opts.createAppSession(this.peer, device);
  }
}

export class RemoteControlDirectService {
  private server: Server | null = null;
  private info: RemoteControlDirectServerInfo | null = null;
  private fingerprint = '';
  private installPubkey: Uint8Array | null = null;
  private pairingOffer: RemoteControlPairingOffer | null = null;
  private pairingOfferTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingSessions = new Set<DirectPeerSession>();
  private activeSession: DirectPeerSession | null = null;
  private portChange: RemoteControlDirectPortChange | null = null;
  private terminalPresentationTrackingActive = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  private readonly stateListeners = new Set<(state: RemoteControlDirectState) => void>();
  private readonly deps: {
    installIdentity: RemoteControlInstallIdentity;
    pairedDeviceRegistry: RemoteControlPairedDeviceRegistry;
    createAppSession: (peer: Peer, device: RemoteSessionDevice) => RemoteControlSession;
    createServer: typeof createServer;
    rng: NonNullable<RemoteControlDirectServiceDeps['rng']>;
    resumption: RemoteSessionResumptionStore;
    registerCeremonyTimeoutMs: number;
    authCeremonyTimeoutMs: number;
    passkeyTimeoutMs: number;
    peerHandshakeTimeoutMs: number;
    pairingOfferTimeoutMs: number;
    heartbeatPingMs: number;
    heartbeatTimeoutMs: number;
    webAssetDir: string;
    emitStateChange?: (state: RemoteControlDirectState) => void;
    terminalPresentationTracking: NonNullable<
      RemoteControlDirectServiceDeps['terminalPresentationTracking']
    >;
  };

  constructor(deps: RemoteControlDirectServiceDeps = {}) {
    this.deps = {
      installIdentity: deps.installIdentity ?? wrapElectronInstallIdentity(),
      pairedDeviceRegistry: deps.pairedDeviceRegistry ?? pairedDeviceRegistryService,
      createAppSession:
        deps.createAppSession ??
        ((peer, device) => remoteControlSessionService.attachPeer(peer, device)),
      createServer: deps.createServer ?? createServer,
      rng: deps.rng ?? {
        challenge: () => randomBytes(32),
        pairingSecret: defaultPairingSecret,
      },
      resumption:
        deps.resumption ??
        new RemoteSessionResumptionStore({
          generateToken: () => randomBytes(32),
          now: () => Date.now(),
          ttlMs: () => remotePasskeyWindowMs(configService.get()),
          maxAgeMs: DEFAULT_RESUME_MAX_AGE_MS,
        }),
      registerCeremonyTimeoutMs:
        deps.registerCeremonyTimeoutMs ?? DEFAULT_REGISTER_CEREMONY_TIMEOUT_MS,
      authCeremonyTimeoutMs: deps.authCeremonyTimeoutMs ?? DEFAULT_AUTH_CEREMONY_TIMEOUT_MS,
      passkeyTimeoutMs: deps.passkeyTimeoutMs ?? DEFAULT_PASSKEY_TIMEOUT_MS,
      peerHandshakeTimeoutMs: deps.peerHandshakeTimeoutMs ?? DEFAULT_PEER_HANDSHAKE_TIMEOUT_MS,
      pairingOfferTimeoutMs: deps.pairingOfferTimeoutMs ?? DEFAULT_PAIRING_OFFER_TIMEOUT_MS,
      heartbeatPingMs: deps.heartbeatPingMs ?? DEFAULT_HEARTBEAT_PING_MS,
      heartbeatTimeoutMs: deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      webAssetDir: deps.webAssetDir ?? defaultWebAssetDir(),
      emitStateChange: deps.emitStateChange,
      terminalPresentationTracking: deps.terminalPresentationTracking ?? {
        enable: () => remoteControlSessionService.enableTerminalPresentationTracking(),
        disable: () => remoteControlSessionService.disableTerminalPresentationTracking(),
      },
    };
  }

  getInfo(): RemoteControlDirectServerInfo | null {
    return this.info;
  }

  onStateChange(listener: (state: RemoteControlDirectState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  getState(): RemoteControlDirectState {
    const connectedDevice = this.activeSession?.getConnectedDevice() ?? null;
    return {
      server: this.info,
      pairingOffer: this.pairingOffer,
      portChange: this.portChange,
      ...(connectedDevice ? { connectedDevice } : {}),
    };
  }

  async start(
    options: RemoteControlDirectServerOptions = {}
  ): Promise<RemoteControlDirectServerInfo> {
    return this.enqueueLifecycle(() => this.startInternal(options));
  }

  async stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopInternal());
  }

  async startPairing(
    options: RemoteControlDirectServerOptions = {}
  ): Promise<RemoteControlPairingOffer> {
    return this.enqueueLifecycle(async () => {
      const info = await this.startInternal(options);
      const pairingSecret = this.deps.rng.pairingSecret();
      this.setPairingOffer({
        pairUrl: pairUrl(info, pairingSecret),
        fingerprint: info.fingerprint,
        pairingSecret,
      });
      this.emitStateChange();
      return this.pairingOffer!;
    });
  }

  private async startInternal(
    options: RemoteControlDirectServerOptions
  ): Promise<RemoteControlDirectServerInfo> {
    const normalizedPublicOrigin =
      options.publicOrigin === undefined
        ? undefined
        : normalizePublicHttpsOrigin(options.publicOrigin);
    if (this.info) {
      if (normalizedPublicOrigin) this.setPublicOrigin(normalizedPublicOrigin);
      return this.info;
    }

    const host = options.host ?? DEFAULT_HOST;
    assertAllowedBindHost(host);

    const [fingerprint, installPubkey] = await Promise.all([
      this.deps.installIdentity.getFingerprint(),
      this.deps.installIdentity.getPublicKey(),
    ]);
    this.fingerprint = fingerprint;
    this.installPubkey = installPubkey;

    const server = this.deps.createServer((req, res) => this.handleRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server = server;

    try {
      const preferredPort = options.port ?? DEFAULT_DIRECT_REMOTE_PORT;
      await listenWithFallback(server, preferredPort, host);

      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('direct remote-control server did not expose a TCP address');
      }

      const publicHost = options.publicHost ?? DEFAULT_PUBLIC_HOST;
      const localOrigin = `http://${formatHostForUrl(publicHost)}:${address.port}`;
      const httpOrigin = normalizedPublicOrigin ?? localOrigin;
      this.portChange =
        address.port === preferredPort ? null : { oldPort: preferredPort, newPort: address.port };
      this.info = {
        host,
        port: address.port,
        preferredPort,
        localOrigin,
        httpOrigin,
        wsUrl: `${httpOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/remote/ws?fp=${fingerprint}`,
        fingerprint,
      };
      this.deps.terminalPresentationTracking.enable();
      this.terminalPresentationTrackingActive = true;
      logger.info('direct remote-control server started', {
        host,
        port: address.port,
        preferredPort,
      });
      this.emitStateChange();
      return this.info;
    } catch (err) {
      await this.stopInternal();
      throw err;
    }
  }

  private async stopInternal(): Promise<void> {
    this.clearPairingOffer();
    // Turning remote access off must not leave a silent way back in.
    this.deps.resumption.revokeAll();
    const pendingSessions = [...this.pendingSessions];
    this.pendingSessions.clear();
    for (const session of pendingSessions) session.dispose();
    const activeSession = this.activeSession;
    this.activeSession = null;
    activeSession?.dispose();
    const server = this.server;
    this.server = null;
    this.info = null;
    this.portChange = null;
    this.fingerprint = '';
    this.installPubkey = null;
    if (this.terminalPresentationTrackingActive) {
      this.deps.terminalPresentationTracking.disable();
      this.terminalPresentationTrackingActive = false;
    }
    this.emitStateChange();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) logger.warn('direct remote-control server close failed', err);
        resolve();
      });
    });
  }

  cancelPairing(): void {
    this.clearPairingOffer();
    this.emitStateChange();
  }

  disconnectCredential(credentialId: string): boolean {
    this.revokeResumeGrants(credentialId);
    return this.activeSession?.disconnectCredential(credentialId) ?? false;
  }

  disconnectActiveClient(): boolean {
    const device = this.activeSession?.getConnectedDevice();
    if (!this.activeSession || !device) return false;
    // Otherwise the phone's automatic reload resumes without the passkey.
    this.revokeResumeGrants(device.credentialId);
    this.activeSession.dispose();
    return true;
  }

  private revokeResumeGrants(credentialId: string): void {
    const device = this.deps.pairedDeviceRegistry.getByCredentialId(credentialId);
    if (device) this.deps.resumption.revokeDevice(device.deviceId);
  }

  setPublicOrigin(publicOrigin: string | undefined): RemoteControlDirectServerInfo | null {
    if (!this.info) return null;
    const httpOrigin = publicOrigin
      ? normalizePublicHttpsOrigin(publicOrigin)
      : this.info.localOrigin;
    this.info = {
      ...this.info,
      httpOrigin,
      wsUrl: `${httpOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/remote/ws?fp=${
        this.info.fingerprint
      }`,
    };
    // Registration checks the phone's origin against the new one, so an open offer moves with it.
    if (this.pairingOffer) {
      this.pairingOffer = {
        ...this.pairingOffer,
        pairUrl: pairUrl(this.info, this.pairingOffer.pairingSecret),
      };
    }
    this.emitStateChange();
    return this.info;
  }

  private emitStateChange(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) listener(state);
    if (this.deps.emitStateChange) {
      this.deps.emitStateChange(state);
      return;
    }
    windowService.broadcastWhenReady(IPC.REMOTE_CONTROL_DIRECT_STATE_CHANGED, state);
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private setPairingOffer(offer: RemoteControlPairingOffer): void {
    this.clearPairingOfferTimer();
    this.pairingOffer = offer;
    this.pairingOfferTimer = setTimeout(
      () => this.expirePairingOffer(),
      this.deps.pairingOfferTimeoutMs
    );
  }

  private clearPairingOffer(): void {
    this.clearPairingOfferTimer();
    this.pairingOffer = null;
  }

  private claimPairingOffer(pairingSecret: string): boolean {
    if (this.pairingOffer?.pairingSecret !== pairingSecret) return false;
    this.clearPairingOffer();
    return true;
  }

  private clearPairingOfferTimer(): void {
    if (!this.pairingOfferTimer) return;
    clearTimeout(this.pairingOfferTimer);
    this.pairingOfferTimer = null;
  }

  private expirePairingOffer(): void {
    if (!this.pairingOffer) return;
    this.clearPairingOffer();
    this.emitStateChange();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      redirect(res, '/remote/');
      return;
    }
    if (pathname === '/remote') {
      redirect(res, '/remote/');
      return;
    }
    if (pathname === '/remote/pair/') {
      redirect(res, '/remote/pair');
      return;
    }
    if (pathname === '/remote/' || pathname === '/remote/pair') {
      if (!this.info) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('direct remote-control server is not ready');
        return;
      }
      void this.serveRemoteAsset('index.html', res);
      return;
    }
    if (pathname === '/remote/config') {
      if (!this.info) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not-ready' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ fingerprint: this.info.fingerprint, wsUrl: this.info.wsUrl }));
      return;
    }
    if (pathname === '/remote/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname.startsWith('/remote/')) {
      const path = pathname.slice('/remote/'.length);
      void this.serveRemoteAsset(path, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  private async serveRemoteAsset(path: string, res: ServerResponse): Promise<void> {
    const assetPath = safeAssetPath(this.deps.webAssetDir, path);
    if (!assetPath || !existsSync(assetPath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    try {
      const content = await readFile(assetPath);
      const headers = {
        'content-type': contentTypeForPath(assetPath),
        'content-security-policy':
          "default-src 'none'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self';",
        'cache-control': cacheControlForAsset(path),
      };
      res.writeHead(200, headers);
      res.end(content);
    } catch (err) {
      logger.warn('failed to serve direct remote app asset', err);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('failed to serve remote app');
    }
  }

  /** The phone app build this desktop serves, which its `build.json` names. */
  private servedBuild(): string | undefined {
    try {
      const { build } = JSON.parse(readFileSync(join(this.deps.webAssetDir, 'build.json'), 'utf8'));
      return typeof build === 'string' && build.length > 0 && build.length <= 64
        ? build
        : undefined;
    } catch {
      return undefined;
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.info || !this.installPubkey) {
      rejectUpgrade(socket, 503, 'direct remote-control server is not ready');
      return;
    }
    const url = new URL(req.url ?? '/', this.info.httpOrigin);
    if (url.pathname !== '/remote/ws' || url.searchParams.get('fp') !== this.fingerprint) {
      rejectUpgrade(socket, 403, 'forbidden');
      return;
    }
    // Browsers always send Origin, so this turns away pages from other sites,
    // which can reach a localhost server too.
    const origin = req.headers.origin;
    if (origin !== this.info.httpOrigin && origin !== this.info.localOrigin) {
      rejectUpgrade(socket, 403, 'forbidden');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      rejectUpgrade(socket, 400, 'missing websocket key');
      return;
    }

    // An active session doesn't refuse the upgrade: a newer sign-in replaces it.
    if (this.pendingSessions.size >= MAX_PENDING_SESSIONS) {
      const [oldest] = this.pendingSessions;
      this.pendingSessions.delete(oldest);
      oldest.dispose();
    }
    acceptUpgrade(socket, key);
    const conn = new DirectWebSocketConnection(socket);
    const endpoint: RemoteControlEndpoint = {
      httpOrigin: this.info.httpOrigin,
      rpId: new URL(this.info.httpOrigin).hostname,
    };
    const session = new DirectPeerSession(conn, {
      endpoint,
      fingerprint: this.fingerprint,
      installPubkey: this.installPubkey,
      sign: (data) => this.deps.installIdentity.sign(data),
      registry: this.deps.pairedDeviceRegistry,
      resumption: this.deps.resumption,
      createAppSession: this.deps.createAppSession,
      generateChallenge: this.deps.rng.challenge,
      getPairingOffer: () => this.pairingOffer,
      claimPairingOffer: (pairingSecret) => this.claimPairingOffer(pairingSecret),
      servedBuild: () => this.servedBuild(),
      registerCeremonyTimeoutMs: this.deps.registerCeremonyTimeoutMs,
      authCeremonyTimeoutMs: this.deps.authCeremonyTimeoutMs,
      passkeyTimeoutMs: this.deps.passkeyTimeoutMs,
      peerHandshakeTimeoutMs: this.deps.peerHandshakeTimeoutMs,
      heartbeatPingMs: this.deps.heartbeatPingMs,
      heartbeatTimeoutMs: this.deps.heartbeatTimeoutMs,
      onPairCompleted: () => {
        this.clearPairingOffer();
        this.emitStateChange();
      },
      onAuthCompleted: (_label, credentialId) => {
        // The device may have been removed while its ceremony was finishing.
        if (
          !this.pendingSessions.has(session) ||
          !this.deps.pairedDeviceRegistry.getByCredentialId(credentialId)
        ) {
          session.dispose();
          return;
        }
        this.pendingSessions.delete(session);
        // The newest sign-in wins: it replaces the connection this device left behind, or the one
        // another device has open.
        const replaced = this.activeSession;
        replaced?.dispose({
          code: SESSION_CLOSE.REPLACED.code,
          reason: SESSION_CLOSE.REPLACED.reason,
          // Only the same device's reconnect may take over its size leases.
          connectionDropped: replaced.getConnectedDevice()?.credentialId === credentialId,
        });
        this.activeSession = session;
        this.emitStateChange();
      },
      onCeremonyFailed: (err) => logger.warn('direct ceremony failed', err),
      onClose: () => {
        if (this.pendingSessions.delete(session)) {
          this.emitStateChange();
        }
        if (this.activeSession === session) {
          this.activeSession = null;
          this.emitStateChange();
        }
      },
    });
    this.pendingSessions.add(session);
    if (head.length > 0) conn.handleData(head);
  }
}

class DirectWebSocketConnection {
  private messageHandlers: Array<(data: string) => void> = [];
  private binaryHandlers: Array<(data: Uint8Array) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly socket: Duplex) {
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.emitClose());
    socket.on('error', (err) => {
      logger.warn('direct websocket socket error', err);
      this.emitClose();
    });
  }

  onMessage(cb: (data: string) => void): void {
    this.messageHandlers.push(cb);
  }

  onBinaryMessage(cb: (data: Uint8Array) => void): void {
    this.binaryHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  send(data: string): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(data, 'utf8')));
  }

  sendBinary(data: Uint8Array): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
  }

  /** Bytes written that the socket hasn't handed to the kernel yet. */
  bufferedAmount(): number {
    return this.socket.writableLength;
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    const reasonBytes = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.socket.write(encodeFrame(0x8, payload), () => this.socket.end());
    this.emitClose();
  }

  handleData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length > 0) {
        const parsed = decodeFrame(this.buffer);
        if (!parsed) return;
        this.buffer = this.buffer.subarray(parsed.consumed);
        if (parsed.opcode === 0x8) {
          this.close(1000, '');
          return;
        }
        if (parsed.opcode === 0x9) {
          this.socket.write(encodeFrame(0xa, parsed.payload));
          continue;
        }
        if (parsed.opcode === 0x2) {
          for (const cb of this.binaryHandlers) cb(new Uint8Array(parsed.payload));
          continue;
        }
        if (parsed.opcode !== 0x1) {
          this.close(1003, 'unsupported frame');
          return;
        }
        const text = parsed.payload.toString('utf8');
        for (const cb of this.messageHandlers) cb(text);
      }
    } catch (err) {
      logger.warn('invalid direct websocket frame', err);
      this.close(1002, 'protocol error');
    }
  }

  private emitClose(): void {
    if (!this.closed) this.closed = true;
    const handlers = this.closeHandlers.splice(0);
    this.messageHandlers = [];
    this.binaryHandlers = [];
    for (const cb of handlers) cb();
  }
}

function assertAllowedBindHost(host: string): void {
  if (host === '0.0.0.0' || host === '::') {
    throw new Error('direct remote-control server must not bind a wildcard address');
  }
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return;
  throw new Error(
    'direct remote-control server currently only supports localhost until HTTPS origins are available'
  );
}

function pairUrl(info: RemoteControlDirectServerInfo, pairingSecret: string): string {
  return `${info.httpOrigin}/remote/pair#fp=${info.fingerprint}&secret=${pairingSecret}`;
}

function normalizePublicHttpsOrigin(rawOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error('Tailscale origin must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Tailscale origin must start with https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Tailscale origin must not include credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Tailscale origin must be an origin only, without a path, query, or fragment');
  }
  return parsed.origin;
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(
  server: Server,
  preferredPort: number,
  host: string
): Promise<void> {
  try {
    await listenOn(server, preferredPort, host);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'EADDRINUSE') throw err;
    logger.warn('direct remote-control preferred port in use, using fallback port', {
      preferredPort,
    });
    await listenOn(server, 0, host);
  }
}

function acceptUpgrade(socket: Duplex, key: string): void {
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n')
  );
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    [
      `HTTP/1.1 ${status} ${message}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(message)}`,
      '',
      message,
    ].join('\r\n')
  );
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(308, {
    location,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`redirecting to ${location}`);
}

function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (!fin) throw new Error('fragmented websocket frames are not supported');
  if (!masked) throw new Error('client websocket frames must be masked');
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error('websocket frame too large');
    payloadLength = low;
    offset += 8;
  }
  if (payloadLength > MAX_FRAME_BYTES) throw new Error('websocket frame too large');
  if (buffer.length < offset + 4 + payloadLength) return null;

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, consumed: offset + payloadLength };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x80 | opcode;
  if (payload.length < 126) {
    frame[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(payload.length, 6);
  }
  payload.copy(frame, headerLength);
  return frame;
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function defaultWebAssetDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'remote-app') : DEFAULT_DEV_WEB_ASSET_DIR;
}

function safeAssetPath(root: string, requestPath: string): string | null {
  const normalized = normalize(requestPath).replace(/^(\.\.(?:\/|\\|$))+/, '');
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, normalized || 'index.html');
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return null;
  }
  return resolvedPath;
}

function contentTypeForPath(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webmanifest')) return 'application/manifest+json';
  if (path.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

// The page itself is never cached. The service worker and manifest are revalidated on every
// load, so a Komla update reaches an installed phone app; hashed assets and icons can be reused.
function cacheControlForAsset(path: string): string {
  if (path === 'index.html') return 'no-store';
  if (path === 'sw.js' || path === 'manifest.webmanifest') return 'no-cache';
  return 'public, max-age=3600';
}

function defaultPairingSecret(): string {
  return randomBytes(32).toString('base64url');
}

function wrapElectronInstallIdentity(): RemoteControlInstallIdentity {
  return {
    async getPublicKey() {
      return new Uint8Array(await installIdentityService.getPublicKey());
    },
    getFingerprint() {
      return installIdentityService.getFingerprint();
    },
    async sign(data: Uint8Array) {
      const sig = await installIdentityService.sign(Buffer.from(data));
      return new Uint8Array(sig);
    },
  };
}

export const remoteControlDirectService = new RemoteControlDirectService();
