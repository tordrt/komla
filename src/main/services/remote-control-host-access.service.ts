// Phone access to SSH hosts (ADR 0005): the Remote Companion on a host serves the phone directly,
// so the phone keeps working while the desktop sleeps or would need a new SSH login.
//
// The desktop stays the authority. Over a connection it already has open, it installs the
// companion's phone server, writes the phones it trusts with a renewable lease and what they may
// start there (projects and agent commands), and publishes the server with Tailscale Serve on the
// host. It never opens a connection just for this, because a
// fingerprint-protected SSH agent would ask the user; changes wait for the next connection.
//
// `remote-host-access.json` in the Komla data dir keeps, per host, whether phone access is on and
// what the phone needs to reach it (URL and host fingerprint).

import { createHash, createPublicKey } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, posix as pathPosix } from 'path';

import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';

import { remotePasskeyWindowMs } from '../../shared/lib/remote-passkey-window';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { MANAGED_TMUX_SOCKET_NAME } from '../../shared/lib/ssh-tmux-attach';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

import { configService } from './config.service';
import { pairedDeviceRegistryService } from './paired-device-registry.service';
import { ensureKomlaBasePath } from './paths';
import { remoteCompanionService } from './remote-companion.service';
import { buildHostLaunchFile } from './remote-control-host-launch';
import { hasFunnel, hasHttpsRoute } from './remote-control-tailscale.service';
import { sshConnectionService } from './ssh-connection.service';
import { sshHostService } from './ssh-host.service';
import { sshCompanionInstallationId, sshWorkspaceService } from './ssh-workspace.service';

import type { SshHost } from '../../shared/types';
import type { PairedDeviceRecord } from '../../shared/types/paired-device';
import type {
  RemoteControlHostAccessStatus,
  RemoteControlHostEndpoint,
} from '../../shared/types/remote-control';

const logger = createLogger('RemoteControlHostAccessService');

export const PHONE_ACCESS_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_RENEW_AFTER_MS = 60 * 60 * 1000;
const PHONE_SERVER_PORT_BASE = 48100;
const PHONE_SERVER_PORT_SPAN = 800;
const SOCKET_PATH = '/remote/ws';
const SYNC_TIMEOUT_MS = 60_000;
const MARKER = '__KOMLA_PHONE__';

interface StoredHostAccess {
  enabled: boolean;
  fingerprint?: string;
  url?: string;
  state: RemoteControlHostAccessStatus['state'];
  message?: string;
  syncedAt?: number;
  trustDigest?: string;
  /** What the host last got of `launch.json`. */
  launchDigest?: string;
  /** The server may still run there: remote control or phone access was turned off meanwhile. */
  stopPending?: boolean;
}

interface StoredFile {
  version: 1;
  hosts: Record<string, StoredHostAccess>;
}

export interface RemoteControlHostAccessDeps {
  statePath?: string;
  hosts?: { list(): SshHost[]; get(hostId: string): SshHost | undefined };
  devices?: {
    list(): PairedDeviceRecord[];
    onChange(listener: (devices: PairedDeviceRecord[]) => void): () => void;
  };
  isRemoteControlEnabled?: () => boolean;
  /** Settings → Remote → "Ask for passkey again after", which hosts apply too. */
  passkeyWindowMs?: () => number;
  installationId?: (hostId: string) => string;
  resolveBasePath?: (hostId: string) => Promise<string>;
  ensureCompanion?: (host: SshHost, basePath: string) => Promise<string>;
  runWithInput?: (host: SshHost, script: string, input: string) => Promise<string>;
  /** What phones may start on the host, as `launch.json`. */
  launchFile?: (host: SshHost, basePath: string) => Promise<string>;
  hasOpenConnection?: (host: SshHost) => Promise<boolean>;
  now?: () => number;
}

/** The passkey's ES256 public key as standard-base64 SPKI, or null for another algorithm. */
export function credentialSpkiFromCose(publicKey: string): string | null {
  try {
    const key = decodeCredentialPublicKey(new Uint8Array(Buffer.from(publicKey, 'base64url')));
    if (
      !cose.isCOSEPublicKeyEC2(key) ||
      key.get(cose.COSEKEYS.alg) !== cose.COSEALG.ES256 ||
      key.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256
    ) {
      return null;
    }
    const x = key.get(cose.COSEKEYS.x);
    const y = key.get(cose.COSEKEYS.y);
    if (!x || !y) return null;
    const spki = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(x).toString('base64url'),
        y: Buffer.from(y).toString('base64url'),
      },
    }).export({ type: 'spki', format: 'der' });
    return spki.toString('base64');
  } catch {
    return null;
  }
}

/** HTTPS, or plain-HTTP localhost while developing, as for the desktop's own origins. */
function isAllowedPhoneOrigin(origin: string): boolean {
  return origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

/**
 * The phones a host may let in: those paired over HTTPS with an ES256 passkey. `resumeWindowMs` is
 * how long one that left may come back without its passkey.
 */
export function buildTrustFile(
  devices: PairedDeviceRecord[],
  expiresAt: number,
  resumeWindowMs: number
): string {
  return JSON.stringify({
    version: 1,
    expiresAt,
    resumeWindowMs,
    devices: devices.flatMap((device) => {
      const credentialPublicKey = credentialSpkiFromCose(device.publicKey);
      if (!credentialPublicKey || !isAllowedPhoneOrigin(device.origin)) return [];
      return [
        {
          deviceId: device.deviceId,
          devicePublicKey: device.devicePublicKey,
          credentialId: device.credentialId,
          credentialPublicKey,
          label: device.label,
          rpId: device.rpId,
          origin: device.origin,
        },
      ];
    }),
  });
}

/** What changes the host's trust, without the lease time. */
function trustDigest(devices: PairedDeviceRecord[], resumeWindowMs: number): string {
  const relevant = devices
    .map((device) =>
      JSON.stringify([device.deviceId, device.credentialId, device.label, device.origin])
    )
    .sort((left, right) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify([resumeWindowMs, ...relevant]))
    .digest('hex')
    .slice(0, 16);
}

function launchDigest(launch: string): string {
  return createHash('sha256').update(launch).digest('hex').slice(0, 16);
}

export function phoneServerKey(installationId: string): string {
  return createHash('sha256').update(`phone\0${installationId}`).digest('hex').slice(0, 16);
}

export function phoneServerPort(key: string): number {
  return PHONE_SERVER_PORT_BASE + (Number.parseInt(key.slice(0, 8), 16) % PHONE_SERVER_PORT_SPAN);
}

const TAILSCALE_LOOKUP = [
  'ts=$(command -v tailscale 2>/dev/null || true)',
  'if [ -z "$ts" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then',
  '  ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'fi',
];

interface PhoneServerPlan {
  stateDir: string;
  socket: string;
  port: number;
  binary: string;
  config: string;
  signature: string;
}

/**
 * Writes trust (stdin's first line), launch options (the rest of stdin) and config, (re)starts the
 * server unless Funnel is on for its port, then reports Tailscale's state.
 */
export function buildSyncScript(plan: PhoneServerPlan): string {
  const state = shellQuotePosix(plan.stateDir);
  const socket = shellQuotePosix(plan.socket);
  const serve = [
    'exec',
    shellQuotePosix(plan.binary),
    '__phone-serve',
    shellQuotePosix(`${plan.stateDir}/config.json`),
    `2>>${shellQuotePosix(`${plan.stateDir}/server.log`)}`,
  ].join(' ');
  return [
    'set -eu',
    'umask 077',
    `state=${state}`,
    'mkdir -p "$state"',
    `printf '${MARKER}init\\n'`,
    `${shellQuotePosix(plan.binary)} __phone-init "$state"`,
    // The shell's read takes exactly one line from a pipe, leaving the rest for cat.
    'IFS= read -r trust',
    `printf '%s\\n' "$trust" > "$state/trust.json.tmp"`,
    'mv -f "$state/trust.json.tmp" "$state/trust.json"',
    'cat > "$state/launch.json.tmp"',
    'if [ -s "$state/launch.json.tmp" ]; then mv -f "$state/launch.json.tmp" "$state/launch.json"; else rm -f "$state/launch.json.tmp"; fi',
    `printf '%s' ${shellQuotePosix(plan.config)} > "$state/config.json.tmp"`,
    'mv -f "$state/config.json.tmp" "$state/config.json"',
    ...TAILSCALE_LOOKUP,
    'serve=""',
    'if [ -n "$ts" ]; then serve=$("$ts" serve status --json 2>&1 || true); fi',
    // With Funnel on for the port, the server would be on the public internet, so it doesn't
    // start, and one already running stops.
    `if printf '%s' "$serve" | tr -d ' \\t\\r\\n' | grep -q '"AllowFunnel":{[^}]*:${plan.port}":true'; then`,
    `  tmux -L ${socket} kill-server 2>/dev/null || true`,
    `  printf '${MARKER}funnel\\n'`,
    'else',
    `  running=$(tmux -L ${socket} show-options -gqv @komla_runtime 2>/dev/null || true)`,
    `  if [ "$running" != ${shellQuotePosix(plan.signature)} ] || ! tmux -L ${socket} has-session -t ${shellQuotePosix(`=${plan.socket}`)} 2>/dev/null; then`,
    `    tmux -L ${socket} kill-server 2>/dev/null || true`,
    `    tmux -L ${socket} -f /dev/null new-session -d -s ${socket} ${shellQuotePosix(serve)}`,
    `    tmux -L ${socket} set-option -g @komla_runtime ${shellQuotePosix(plan.signature)} 2>/dev/null || true`,
    '    sleep 1',
    `    if ! tmux -L ${socket} has-session -t ${shellQuotePosix(`=${plan.socket}`)} 2>/dev/null; then`,
    `      printf '${MARKER}exited\\n'`,
    '      tail -n 5 "$state/server.log" 2>/dev/null || true',
    '    fi',
    '  fi',
    'fi',
    `printf '\\n${MARKER}status\\n'`,
    'if [ -z "$ts" ]; then printf "missing\\n"; else "$ts" status --json 2>&1 || true; fi',
    `printf '\\n${MARKER}serve\\n'`,
    `printf '%s\\n' "$serve"`,
  ].join('\n');
}

function buildServeScript(port: number): string {
  return [
    ...TAILSCALE_LOOKUP,
    `if out=$("$ts" serve --bg --https=${port} http://127.0.0.1:${port} 2>&1); then`,
    `  printf '${MARKER}served\\n'`,
    'else',
    `  printf '${MARKER}refused\\n%s\\n' "$out"`,
    'fi',
  ].join('\n');
}

function buildStopScript(stateDir: string, socket: string, port: number): string {
  return [
    `tmux -L ${shellQuotePosix(socket)} kill-server 2>/dev/null || true`,
    `rm -f ${shellQuotePosix(`${stateDir}/trust.json`)} ${shellQuotePosix(`${stateDir}/launch.json`)}`,
    ...TAILSCALE_LOOKUP,
    `if [ -n "$ts" ]; then "$ts" serve --https=${port} off >/dev/null 2>&1 || true; fi`,
  ].join('\n');
}

function sections(output: string): Map<string, string> {
  const result = new Map<string, string>();
  const parts = output.split(MARKER);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    const name = newline < 0 ? part : part.slice(0, newline);
    result.set(name.trim(), newline < 0 ? '' : part.slice(newline + 1).trim());
  }
  return result;
}

function parseJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RemoteControlHostAccessService {
  private readonly deps: Required<Omit<RemoteControlHostAccessDeps, 'statePath'>>;
  private readonly explicitStatePath: string | null;
  private stored: StoredFile | null = null;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private unsubscribeDevices: (() => void) | null = null;

  constructor(deps: RemoteControlHostAccessDeps = {}) {
    this.explicitStatePath = deps.statePath ?? null;
    this.deps = {
      hosts: deps.hosts ?? sshHostService,
      devices: deps.devices ?? pairedDeviceRegistryService,
      isRemoteControlEnabled:
        deps.isRemoteControlEnabled ?? (() => Boolean(configService.get().directRemoteEnabled)),
      passkeyWindowMs: deps.passkeyWindowMs ?? (() => remotePasskeyWindowMs(configService.get())),
      installationId: deps.installationId ?? sshCompanionInstallationId,
      resolveBasePath:
        deps.resolveBasePath ?? ((hostId) => sshWorkspaceService.resolveWorkspaceBasePath(hostId)),
      ensureCompanion:
        deps.ensureCompanion ??
        ((host, basePath) => remoteCompanionService.ensureInstalled(host, basePath)),
      runWithInput:
        deps.runWithInput ??
        ((host, script, input) =>
          sshWorkspaceService.runWithInput(host, script, input, {
            purpose: { kind: 'background' },
            timeout: SYNC_TIMEOUT_MS,
          })),
      launchFile: deps.launchFile ?? ((host, basePath) => buildHostLaunchFile(host.id, basePath)),
      hasOpenConnection:
        deps.hasOpenConnection ?? ((host) => sshConnectionService.hasOpenConnection(host)),
      now: deps.now ?? Date.now,
    };
  }

  /** Rewrites trust on connected hosts as soon as a phone is added, renamed or removed. */
  start(): void {
    if (this.unsubscribeDevices) return;
    this.unsubscribeDevices = this.deps.devices.onChange(() => {
      void this.devicesChanged();
    });
  }

  stop(): void {
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): RemoteControlHostAccessStatus[] {
    const stored = this.load();
    return this.deps.hosts.list().map((host) => {
      const entry = stored.hosts[host.id];
      return {
        hostId: host.id,
        hostName: host.name,
        enabled: entry?.enabled ?? false,
        state: entry?.enabled ? entry.state : 'off',
        ...(entry?.enabled && entry.message ? { message: entry.message } : {}),
        ...(entry?.enabled && entry.url ? { url: entry.url } : {}),
        ...(entry?.syncedAt ? { syncedAt: entry.syncedAt } : {}),
      };
    });
  }

  /** What a signed-in phone may open besides the desktop. */
  phoneHosts(): RemoteControlHostEndpoint[] {
    if (!this.deps.isRemoteControlEnabled()) return [];
    const stored = this.load();
    return this.deps.hosts.list().flatMap((host) => {
      const entry = stored.hosts[host.id];
      // A pending host still lets in the phones it already trusts; it decides, not the desktop.
      const reachable = entry?.state === 'ready' || entry?.state === 'pending';
      if (!entry?.enabled || !reachable || !entry.url || !entry.fingerprint) return [];
      return [{ id: host.id, name: host.name, url: entry.url, fingerprint: entry.fingerprint }];
    });
  }

  /** Turned on or off in Settings, with the user present to approve an SSH login. */
  async setEnabled(hostId: string, enabled: boolean): Promise<RemoteControlHostAccessStatus> {
    const host = this.deps.hosts.get(hostId);
    if (!host) throw new Error('Unknown SSH host');
    this.update(hostId, (entry) =>
      enabled
        ? { ...entry, enabled: true, state: 'setting-up', message: undefined }
        : { ...entry, enabled: false, state: 'off', message: undefined, stopPending: true }
    );
    await this.serialize(hostId, () => (enabled ? this.sync(host) : this.stopOn(host)));
    return this.list().find((status) => status.hostId === hostId)!;
  }

  /** Komla connected to the host for its workspaces: renew the lease or catch up. */
  hostConnected(hostId: string): void {
    const host = this.deps.hosts.get(hostId);
    const entry = this.load().hosts[hostId];
    if (!host || !entry) return;
    const active = entry.enabled && this.deps.isRemoteControlEnabled();
    if (!active) {
      if (entry.stopPending) void this.serialize(hostId, () => this.stopOn(host));
      return;
    }
    const due =
      entry.state !== 'ready' ||
      entry.trustDigest !== trustDigest(this.deps.devices.list(), this.deps.passkeyWindowMs()) ||
      this.deps.now() - (entry.syncedAt ?? 0) >= LEASE_RENEW_AFTER_MS;
    void this.serialize(hostId, () => (due ? this.sync(host) : this.syncIfLaunchChanged(host)));
  }

  /** Remote control was turned off: stop every host's server that Komla can reach now. */
  async remoteControlTurnedOff(): Promise<void> {
    await Promise.all(
      Object.entries(this.load().hosts)
        .filter(([, entry]) => entry.enabled)
        .map(async ([hostId]) => {
          const host = this.deps.hosts.get(hostId);
          if (!host) return;
          this.update(hostId, (entry) => ({ ...entry, stopPending: true }));
          if (await this.deps.hasOpenConnection(host)) {
            await this.serialize(hostId, () => this.stopOn(host));
          }
        })
    );
  }

  /** "Ask for passkey again after" changed: hosts Komla can reach get it now, others on connect. */
  passkeyWindowChanged(): void {
    void this.devicesChanged(
      'Your passkey setting reaches this host the next time Komla connects to it.'
    );
  }

  private async devicesChanged(
    pendingMessage = 'Your device list reaches this host the next time Komla connects to it.'
  ): Promise<void> {
    if (!this.deps.isRemoteControlEnabled()) return;
    // A sign-in also saves the device list; only what the host's trust holds is worth a sync.
    const digest = trustDigest(this.deps.devices.list(), this.deps.passkeyWindowMs());
    await Promise.all(
      Object.entries(this.load().hosts)
        .filter(([, entry]) => entry.enabled && entry.trustDigest !== digest)
        .map(async ([hostId]) => {
          const host = this.deps.hosts.get(hostId);
          if (!host) return;
          if (await this.deps.hasOpenConnection(host)) {
            await this.serialize(hostId, () => this.sync(host));
            return;
          }
          this.update(hostId, (entry) => ({
            ...entry,
            state: 'pending',
            message: pendingMessage,
          }));
        })
    );
  }

  /** Projects or agents changed since the host got them: send it the new launch options. */
  private async syncIfLaunchChanged(host: SshHost): Promise<void> {
    const launch = await this.buildLaunch(host, await this.deps.resolveBasePath(host.id));
    if (launch === null || launchDigest(launch) === this.load().hosts[host.id]?.launchDigest) {
      return;
    }
    await this.sync(host, launch);
  }

  /** `launch.json` for the host, or null when it can't be built; trust is written regardless. */
  private async buildLaunch(host: SshHost, basePath: string): Promise<string | null> {
    try {
      return await this.deps.launchFile(host, basePath);
    } catch (error) {
      logger.warn('could not build launch options for SSH host', {
        hostId: host.id,
        error: errorText(error),
      });
      return null;
    }
  }

  private async plan(host: SshHost): Promise<{ basePath: string; plan: PhoneServerPlan }> {
    const basePath = await this.deps.resolveBasePath(host.id);
    const binary = await this.deps.ensureCompanion(host, basePath);
    const key = phoneServerKey(this.deps.installationId(host.id));
    const port = phoneServerPort(key);
    const config = JSON.stringify({
      version: 1,
      port,
      basePath,
      tmuxSocket: MANAGED_TMUX_SOCKET_NAME,
      hostName: host.name,
    });
    return {
      basePath,
      plan: {
        stateDir: pathPosix.join(basePath, 'helpers', 'companion', `phone-${key}`),
        socket: `komla-phone-${key}`,
        port,
        binary,
        config,
        signature: createHash('sha256').update(`${binary}\0${config}`).digest('hex').slice(0, 16),
      },
    };
  }

  private async sync(host: SshHost, built?: string): Promise<void> {
    if (!this.deps.isRemoteControlEnabled()) {
      this.update(host.id, (entry) => ({
        ...entry,
        state: 'needs-attention',
        message: 'Turn on remote control to let your devices reach this host.',
      }));
      return;
    }
    const devices = this.deps.devices.list();
    const resumeWindowMs = this.deps.passkeyWindowMs();
    try {
      const { basePath, plan } = await this.plan(host);
      // Without a new launch file the host keeps the one it has, and the next sync tries again.
      const launch = built ?? (await this.buildLaunch(host, basePath));
      const output = await this.deps.runWithInput(
        host,
        buildSyncScript(plan),
        `${buildTrustFile(devices, this.deps.now() + PHONE_ACCESS_LEASE_MS, resumeWindowMs)}\n${launch ?? ''}`
      );
      const parts = sections(output);
      const init = parseJson(parts.get('init')) as { fingerprint?: unknown } | null;
      const fingerprint = typeof init?.fingerprint === 'string' ? init.fingerprint : undefined;
      if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw new Error('the Komla companion on this host could not create its identity');
      }
      if (parts.has('exited')) {
        throw new Error(
          `the phone server on this host stopped right away: ${parts.get('exited') || 'no details'}`
        );
      }
      const dnsName = this.tailscaleName(parts.get('status'));
      const serveStatus = parseJson(parts.get('serve'));
      const httpsPort = String(plan.port);
      if (parts.has('funnel') || hasFunnel(serveStatus, httpsPort)) {
        await this.deps.runWithInput(
          host,
          buildStopScript(plan.stateDir, plan.socket, plan.port),
          ''
        );
        throw new Error(
          `Tailscale Funnel is on for port ${httpsPort} on this host, which would put remote control on the public internet. Turn it off with "tailscale funnel --https=${httpsPort} off" there, then try again.`
        );
      }
      if (!hasHttpsRoute(serveStatus, httpsPort, `127.0.0.1:${plan.port}`)) {
        const served = sections(
          await this.deps.runWithInput(host, buildServeScript(plan.port), '')
        );
        if (!served.has('served')) {
          throw new Error(this.serveFailureMessage(served.get('refused') ?? ''));
        }
      }
      this.update(host.id, (entry) => ({
        ...entry,
        state: 'ready',
        message: undefined,
        fingerprint,
        url: `wss://${dnsName}:${plan.port}${SOCKET_PATH}`,
        syncedAt: this.deps.now(),
        trustDigest: trustDigest(devices, resumeWindowMs),
        ...(launch !== null ? { launchDigest: launchDigest(launch) } : {}),
        stopPending: false,
      }));
    } catch (error) {
      logger.warn('phone access to SSH host not ready', {
        hostId: host.id,
        error: errorText(error),
      });
      this.update(host.id, (entry) => ({
        ...entry,
        state: 'needs-attention',
        message: errorText(error),
      }));
    }
  }

  private tailscaleName(statusText: string | undefined): string {
    if (!statusText || statusText === 'missing') {
      throw new Error('Tailscale is not installed on this host. Install it and join your tailnet.');
    }
    const status = parseJson(statusText) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown };
    } | null;
    if (!status)
      throw new Error(`Tailscale on this host did not answer: ${statusText.slice(0, 200)}`);
    if (status.BackendState !== 'Running') {
      throw new Error('Tailscale on this host is not connected. Run "tailscale up" there.');
    }
    const dnsName = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName : '';
    const name = dnsName.replace(/\.$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) {
      throw new Error('This host has no Tailscale DNS name. Turn on MagicDNS for your tailnet.');
    }
    return name;
  }

  private serveFailureMessage(output: string): string {
    if (/access denied|permission|operator|not permitted/i.test(output)) {
      return 'Tailscale Serve needs permission on this host. Run "sudo tailscale set --operator=$USER" there, then turn direct access off and on.';
    }
    if (/https|cert/i.test(output)) {
      return 'Tailscale Serve needs HTTPS certificates. Turn on HTTPS for your tailnet in the Tailscale admin console.';
    }
    return `Tailscale Serve did not start on this host: ${output.slice(0, 300)}`;
  }

  private async stopOn(host: SshHost): Promise<void> {
    try {
      const { plan } = await this.plan(host);
      await this.deps.runWithInput(
        host,
        buildStopScript(plan.stateDir, plan.socket, plan.port),
        ''
      );
      this.update(host.id, (entry) => ({
        ...entry,
        stopPending: false,
        ...(entry.enabled ? { state: 'pending' as const } : {}),
      }));
    } catch (error) {
      logger.warn('could not stop phone access on SSH host', {
        hostId: host.id,
        error: errorText(error),
      });
    }
  }

  private serialize(hostId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(hostId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(hostId, next);
    return next;
  }

  private statePath(): string {
    return this.explicitStatePath ?? join(ensureKomlaBasePath(), 'remote-host-access.json');
  }

  private load(): StoredFile {
    if (this.stored) return this.stored;
    const path = this.statePath();
    let stored: StoredFile = { version: 1, hosts: {} };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredFile;
        if (parsed.version === 1 && parsed.hosts && typeof parsed.hosts === 'object') {
          stored = parsed;
        }
      } catch (error) {
        logger.warn('ignoring unreadable remote-host-access.json', { error: errorText(error) });
      }
    }
    this.stored = stored;
    return stored;
  }

  private update(hostId: string, change: (entry: StoredHostAccess) => StoredHostAccess): void {
    const stored = this.load();
    const next = change(stored.hosts[hostId] ?? { enabled: false, state: 'off' });
    for (const key of Object.keys(next) as Array<keyof StoredHostAccess>) {
      if (next[key] === undefined) delete next[key];
    }
    stored.hosts[hostId] = next;
    writeFileAtomicSync(this.statePath(), `${JSON.stringify(stored, null, 2)}\n`);
    for (const listener of this.listeners) listener();
  }
}

export const remoteControlHostAccessService = new RemoteControlHostAccessService();
