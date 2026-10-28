import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from 'http';
import { createConnection, createServer } from 'net';
import { isDeepStrictEqual } from 'util';

import { resolveKomlaRequestRoute } from '../lib/komla-request-route';
import { createLogger } from '../lib/logger';
import { buildSshEnv, sshTarget } from '../lib/ssh-client';
import { keepSshLeaseAlive, sshHeartbeatLeaseCommand } from '../lib/ssh-heartbeat-lease';

import { askpassService } from './askpass.service';
import { sshTunnelControlPath } from './ssh-connection/policy';
import { remoteKomlaDataPort, sshWorkspaceService } from './ssh-workspace.service';

import type {
  SshForwardedPort,
  SshHost,
  SshLinkForward,
  SshPreviewForward,
  SshPreviewScheme,
  SshWorkspaceBackend,
  SshPortForwardStatus,
} from '../../shared/types';

const logger = createLogger('SshPortForwardService');
const FORWARD_READY_TIMEOUT_MS = 10_000;
const FORWARD_READY_POLL_MS = 75;
const STDERR_PREVIEW_LIMIT = 8192;
const SSH_CONFIG_RESOLUTION_TIMEOUT_MS = 5_000;
const SSH_CONFIG_RESOLUTION_MAX_BUFFER = 1024 * 1024;
const SSH_CONTROL_COMMAND_TIMEOUT_MS = 5_000;
const KOMLA_DATA_TUNNEL_READY_MARKER = '__KOMLA_DATA_TUNNEL_READY__';
const KOMLA_DATA_RETRY_INITIAL_MS = 1_000;
const KOMLA_DATA_RETRY_MAX_MS = 30_000;
const CONFIGURED_FORWARD_READY_MARKER = '__KOMLA_PORT_FORWARDS_READY__';
const CONFIGURED_FORWARD_STDOUT_LIMIT = 1024 * 1024;
const CONFIGURED_FORWARD_RETRY_INITIAL_MS = 1_000;
const CONFIGURED_FORWARD_RETRY_MAX_MS = 30_000;
const KOMLA_SSH_HOST_HEADER = 'x-komla-ssh-host-id';
// Routes the remote Komla helper calls, optionally under /terminals/<id>. /api/v1/mcp serves
// remote MCP configs written before the stdio adapter (Oct 2026), and /api/v1/settings/ is the
// settings alias docs/CLI.md documents. Everything else stays local.
const REMOTE_GATEWAY_ROUTES = new Set([
  '/api/v1/health',
  '/api/v1/notify',
  '/api/v1/ssh-workspace-status',
  '/api/v1/commands',
  '/api/v1/cli/mcp',
  '/api/v1/mcp',
]);
const REMOTE_GATEWAY_ROUTE_PREFIXES = ['/settings/', '/api/v1/settings/', '/skills/'];
const SSH_PARENT_LEASE_COMMAND = 'exec cat >/dev/null';
// Processes that hold remote listeners use the heartbeat lease so a dropped connection cannot keep
// a reverse-forwarded port bound on the host.
const SSH_HEARTBEAT_LEASE_COMMAND = sshHeartbeatLeaseCommand();
const SSH_PARENT_LEASE_OPTIONS = [
  '-o',
  'IgnoreUnknown=StdinNull,ForkAfterAuthentication,SessionType',
  '-o',
  'RemoteCommand=none',
  '-o',
  'StdinNull=no',
  '-o',
  'ForkAfterAuthentication=no',
  '-o',
  'SessionType=default',
];

interface SshEndpointIdentity {
  resolvedKey?: string;
}

interface TrackedForward extends SshPreviewForward {
  tabId: string;
  hostId: string;
  hostEndpoint: SshEndpointIdentity;
  /** A link's in the default browser, which nothing shows, so another workspace may take its port. */
  givesWay?: boolean;
}

interface TrackedPreviewTunnel {
  hostId: string;
  process: ChildProcess;
  stderr: string;
}

interface TrackedHostPreviewTunnel extends TrackedPreviewTunnel {
  /** Its own control socket, through which its forwards change without a new connection. */
  controlPath?: string;
  /** Its arguments without forwards; others mean the host was edited since it started. */
  baseArgs: string[];
  /** Where ssh connected it; another means the ssh config sends the host elsewhere now. */
  hostEndpoint: SshEndpointIdentity;
  /** The `-L` specs it forwards now. */
  forwardSpecs: string[];
}

interface TrackedVncTunnel extends TrackedPreviewTunnel {
  remotePort: number;
  sshArgs: string[];
  localPort: number;
}

interface TrackedKomlaDataTunnel {
  hostId: string;
  localPort: number;
  gatewayPort: number;
  remotePort: number;
  gateway: HttpServer;
  process: ChildProcess;
  stderr: string;
  stdout: string;
  startedAt: number;
}

interface TrackedConfiguredForwardTunnel {
  hostId: string;
  configKey: string;
  remotePorts: number[];
  process: ChildProcess;
  stderr: string;
  stdout: string;
}

interface KomlaDataTunnelTarget {
  localPort: number;
  retryAttempt: number;
  onConnected?: () => void;
}

interface KillableForward {
  process: ChildProcess;
}

export interface StartSshPreviewForwardArgs {
  workspaceId: string;
  /**
   * The browser tab it serves, or a key of its own for a link opened in the default browser.
   * Each tab keeps its own, so showing another tab moves none.
   */
  tabId: string;
  backend: SshWorkspaceBackend;
  remotePort: number;
  scheme?: SshPreviewScheme;
}

export type StartSshLinkForwardArgs = Omit<StartSshPreviewForwardArgs, 'tabId'>;

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
}

function normalizeSshHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const scopeIndex = trimmed.indexOf('%');
  const address = scopeIndex === -1 ? trimmed : trimmed.slice(0, scopeIndex);
  const scope = scopeIndex === -1 ? '' : trimmed.slice(scopeIndex);
  return `${address.replace(/\.$/, '').toLowerCase()}${scope}`;
}

function isRemoteGatewayRoute(rawUrl: string | undefined): boolean {
  // Parsed exactly as Komla routes it, dot segments and terminal prefix included.
  const route = rawUrl ? resolveKomlaRequestRoute(rawUrl)?.route : undefined;
  if (route === undefined) return false;
  return (
    REMOTE_GATEWAY_ROUTES.has(route) ||
    REMOTE_GATEWAY_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix))
  );
}

function usesSshExpansionToken(value: string, token: string): boolean {
  for (let index = 0; index < value.length - 1; index++) {
    if (value[index] !== '%') continue;
    const next = value[index + 1];
    if (next === '%') {
      index += 1;
      continue;
    }
    if (next === token) return true;
    index += 1;
  }
  return false;
}

function resolvedSshEndpointKey(config: string, host: SshHost): string {
  const values = new Map<string, string>();
  for (const line of config.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).toLowerCase();
    if (!values.has(key)) values.set(key, line.slice(separator + 1).trim());
  }

  const hostname = values.get('hostname');
  const port = values.get('port');
  if (!hostname || !port) throw new Error('SSH configuration did not resolve a hostname and port');
  const proxyRoutes = [values.get('proxyjump'), values.get('proxycommand')].filter(
    (route): route is string => route !== undefined
  );

  return JSON.stringify([
    'resolved',
    normalizeSshHostname(hostname),
    port,
    values.get('proxyjump') ?? null,
    values.get('proxycommand') ?? null,
    values.get('addressfamily') ?? null,
    values.get('bindaddress') ?? null,
    values.get('bindinterface') ?? null,
    values.get('rdomain') ?? null,
    proxyRoutes.some((route) => usesSshExpansionToken(route, 'n')) ? host.hostname : null,
    proxyRoutes.some((route) => usesSshExpansionToken(route, 'r'))
      ? (values.get('user') ?? host.user ?? null)
      : null,
  ]);
}

async function sshHostEndpoint(host: SshHost): Promise<SshEndpointIdentity> {
  try {
    const config = await new Promise<string>((resolve, reject) => {
      execFile(
        'ssh',
        [...sshOptionArgs(host), '-G', sshTarget(host), SSH_PARENT_LEASE_COMMAND],
        {
          encoding: 'utf8',
          env: buildSshEnv(askpassService),
          maxBuffer: SSH_CONFIG_RESOLUTION_MAX_BUFFER,
          timeout: SSH_CONFIG_RESOLUTION_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        }
      );
    });
    return { resolvedKey: resolvedSshEndpointKey(config, host) };
  } catch (error) {
    logger.warn('Failed to resolve effective SSH preview endpoint', {
      hostId: host.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function sshEndpointsConflict(first: SshEndpointIdentity, second: SshEndpointIdentity): boolean {
  if (first.resolvedKey === undefined || second.resolvedKey === undefined) return true;
  return first.resolvedKey === second.resolvedKey;
}

function sshOptionArgs(host: SshHost): string[] {
  // IgnoreUnknown keeps pre-8.7 clients compatible and must precede the newer
  // lease options. The lease and RemoteCommand overrides must precede user
  // arguments and ~/.ssh/config because OpenSSH uses the first value it
  // obtains. Direct flags are removed below because -n, -f, and -N override
  // the -o values.
  const args: string[] = [...SSH_PARENT_LEASE_OPTIONS];
  if (host.port) args.push('-p', String(host.port));
  if (host.identityFile) args.push('-i', host.identityFile);
  if (host.extraSshArgs) {
    for (const arg of host.extraSshArgs) {
      const shortFlags = arg.match(/^-([46AaCfGgKkMNnqsTtVvXxYy]+)$/)?.[1];
      if (!shortFlags) {
        args.push(arg);
        continue;
      }
      const leaseCompatibleFlags = shortFlags.replace(/[fNn]/g, '');
      if (leaseCompatibleFlags) args.push(`-${leaseCompatibleFlags}`);
    }
  }
  return args;
}

function localForwardSpec(forward: { localPort: number; remotePort: number }): string {
  return `127.0.0.1:${forward.localPort}:localhost:${forward.remotePort}`;
}

function localForwardArgs(
  host: SshHost,
  forwards: Array<{ localPort: number; remotePort: number }>,
  controlPath?: string
): string[] {
  return [
    // A master of its own, which the forwards die with. These come first because OpenSSH keeps
    // the first value, so ~/.ssh/config can't make it persist in the background.
    ...(controlPath ? ['-o', 'ControlMaster=yes', '-o', 'ControlPersist=no'] : []),
    ...sshOptionArgs(host),
    // This process owns the forwards and must remain alive until Komla stops
    // it. Do not hand them to a ControlMaster configured by the user, because
    // a multiplex client can leave the forwards attached to the shared master
    // after this child exits.
    '-S',
    controlPath ?? 'none',
    '-T',
    ...forwards.flatMap((forward) => ['-L', localForwardSpec(forward)]),
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    sshTarget(host),
    SSH_PARENT_LEASE_COMMAND,
  ];
}

function runSshControlCommand(
  controlPath: string,
  host: SshHost,
  command: 'forward' | 'cancel',
  specs: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-S', controlPath, '-O', command, ...specs.flatMap((spec) => ['-L', spec]), sshTarget(host)],
      {
        encoding: 'utf8',
        env: buildSshEnv(askpassService),
        timeout: SSH_CONTROL_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve();
      }
    );
  });
}

function previewForwardKey(workspaceId: string, tabId: string): string {
  return JSON.stringify([workspaceId, tabId]);
}

/** Whether no server listens on [::1] at `port`. A computer without IPv6 counts as free. */
function isFreeOnIpv6Loopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'EADDRINUSE'));
    server.listen(port, '::1', () => server.close(() => resolve(true)));
  });
}

function vncTunnelKey(hostId: string, remotePort: number): string {
  return `${hostId}:${remotePort}`;
}

function summarizeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return 'SSH port forward failed';
  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
}

function listenerHost(token: string, port: number): string | undefined {
  const colonSuffix = `:${port}`;
  const dotSuffix = `.${port}`;
  let host: string;
  if (token.endsWith(colonSuffix)) {
    host = token.slice(0, -colonSuffix.length);
  } else if (token.endsWith(dotSuffix)) {
    host = token.slice(0, -dotSuffix.length);
  } else {
    return undefined;
  }
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function assertLoopbackRemoteListeners(stdout: string, remotePorts: number[]): void {
  const listenerLines = stdout
    .slice(0, stdout.indexOf(CONFIGURED_FORWARD_READY_MARKER))
    .split('\n')
    .filter((line) => /\bLISTEN\b/.test(line));

  for (const port of remotePorts) {
    const hosts = listenerLines
      .flatMap((line) => line.trim().split(/\s+/))
      .map((token) => listenerHost(token, port))
      .filter((host): host is string => host !== undefined);
    if (hosts.length === 0) {
      throw new Error(`Could not verify SSH remote port ${port} is listening on loopback`);
    }
    if (hosts.some((host) => host !== '127.0.0.1' && host !== '::1')) {
      throw new Error(
        `SSH remote port ${port} is not loopback-only (check the server's GatewayPorts setting)`
      );
    }
  }
}

class SshPortForwardService {
  private disposed = false;
  private forwards = new Map<string, TrackedForward>();
  private previewTunnels = new Map<string, TrackedHostPreviewTunnel>();
  private vncTunnels = new Map<string, TrackedVncTunnel>();
  private komlaDataTunnels = new Map<string, TrackedKomlaDataTunnel>();
  private komlaDataTargets = new Map<string, KomlaDataTunnelTarget>();
  private komlaDataRetryTimers = new Map<string, NodeJS.Timeout>();
  private komlaDataMutations = new Map<string, Promise<void>>();
  private komlaDataVersions = new Map<string, number>();
  private configuredForwardTargets = new Map<string, SshHost>();
  private configuredForwardTunnels = new Map<string, TrackedConfiguredForwardTunnel>();
  private configuredForwardStatuses = new Map<string, SshPortForwardStatus>();
  private configuredForwardRetryTimers = new Map<string, NodeJS.Timeout>();
  private configuredForwardRetryAttempts = new Map<string, number>();
  private configuredForwardMutations = new Map<string, Promise<void>>();
  private previewMutation: Promise<void> = Promise.resolve();

  async startPreviewForward(args: StartSshPreviewForwardArgs): Promise<SshPreviewForward> {
    this.assertNotDisposed();
    validatePort(args.remotePort, 'remotePort');
    return this.serializePreviewMutation(() => this.startPreviewForwardLocked(args));
  }

  /**
   * Forwards a port of the SSH host for a link opened in the default browser. A forward
   * the host already has to that port serves it, so no tunnel restarts. Otherwise it gets
   * one of its own, which runs until its workspace stops or another workspace forwards the port.
   */
  async startLinkForward(args: StartSshLinkForwardArgs): Promise<SshLinkForward> {
    this.assertNotDisposed();
    validatePort(args.remotePort, 'remotePort');
    return this.serializePreviewMutation(async () => {
      const existing = Array.from(this.forwards.values()).find(
        (forward) =>
          forward.hostId === args.backend.hostId && forward.remotePort === args.remotePort
      );
      if (existing) {
        // A tunnel that dropped, e.g. while the computer slept, starts again for it.
        if (this.previewTunnels.get(existing.hostId)?.process.exitCode !== null) {
          await this.restartPreviewTunnel(
            existing.hostId,
            sshWorkspaceService.getHost(existing.hostId)
          );
        }
        const { id, workspaceId, localUrl, localPort, remotePort } = existing;
        return { id, workspaceId, localUrl, localPort, remotePort, started: false };
      }
      const forward = await this.startPreviewForwardLocked(
        { ...args, tabId: `default-browser:${args.remotePort}` },
        { givesWay: true }
      );
      return { ...forward, started: true };
    });
  }

  /** Stops a forward startLinkForward started, and no forward of a browser tab. */
  async stopLinkForward(workspaceId: string, forwardId: string): Promise<void> {
    return this.serializePreviewMutation(async () => {
      const forward = Array.from(this.forwards.values()).find(
        (candidate) =>
          candidate.givesWay && candidate.workspaceId === workspaceId && candidate.id === forwardId
      );
      if (forward) await this.stopPreviewForwardLocked(workspaceId, forward.tabId);
    });
  }

  private async startPreviewForwardLocked(
    args: StartSshPreviewForwardArgs,
    { givesWay = false }: { givesWay?: boolean } = {}
  ): Promise<SshPreviewForward> {
    const key = previewForwardKey(args.workspaceId, args.tabId);
    const previous = this.forwards.get(key);
    const existingTunnel = this.previewTunnels.get(args.backend.hostId);
    if (
      previous?.hostId === args.backend.hostId &&
      previous.remotePort === args.remotePort &&
      existingTunnel?.process.exitCode === null
    ) {
      previous.localUrl = `${args.scheme ?? 'http'}://127.0.0.1:${previous.localPort}`;
      return {
        id: previous.id,
        workspaceId: previous.workspaceId,
        localUrl: previous.localUrl,
        localPort: previous.localPort,
        remotePort: previous.remotePort,
      };
    }
    const host = sshWorkspaceService.getHost(args.backend.hostId);
    const hostEndpoint = await sshHostEndpoint(host);
    const givingWay = this.forwardsGivingWayTo(args, hostEndpoint);
    const conflictingForward = Array.from(this.forwards.values()).find(
      (forward) =>
        !givingWay.includes(forward) &&
        forward.workspaceId !== args.workspaceId &&
        (forward.hostId === args.backend.hostId ||
          sshEndpointsConflict(forward.hostEndpoint, hostEndpoint)) &&
        forward.remotePort === args.remotePort
    );
    if (conflictingForward) {
      throw new Error(
        `Remote port ${args.remotePort} on this SSH host is already forwarded by another workspace. Stop that workspace's forward or start this dev server on a different port.`
      );
    }
    this.assertPreviewEndpointAvailable(
      args.backend.hostId,
      hostEndpoint,
      Array.from(this.forwards.values()).filter(
        (forward) => forward.hostId === args.backend.hostId && forward !== previous
      ),
      givingWay
    );
    // Nothing else stands in the way, so the links give their forwards up, and get them
    // back if this start fails.
    for (const forward of givingWay) {
      this.forwards.delete(previewForwardKey(forward.workspaceId, forward.tabId));
    }
    await this.restartTunnelsOfOtherHosts(givingWay, args.backend.hostId);
    if (previous) {
      this.forwards.delete(key);
      if (previous.hostId !== args.backend.hostId) {
        await this.restartPreviewTunnel(
          previous.hostId,
          sshWorkspaceService.getHost(previous.hostId)
        );
      }
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < 5; attempt++) {
      // A link opens at localhost, which browsers try on [::1] first.
      const localPort = await this.allocateLocalPort(args.remotePort, { ipv6Too: givesWay });
      validatePort(localPort, 'localPort');

      const tracked: TrackedForward = {
        id: randomUUID(),
        workspaceId: args.workspaceId,
        tabId: args.tabId,
        hostId: args.backend.hostId,
        hostEndpoint,
        localUrl: `${args.scheme ?? 'http'}://127.0.0.1:${localPort}`,
        localPort,
        remotePort: args.remotePort,
        givesWay,
      };
      this.forwards.set(key, tracked);

      try {
        await this.restartPreviewTunnel(args.backend.hostId, host, hostEndpoint);
        logger.info('SSH preview forward started', {
          workspaceId: args.workspaceId,
          hostId: args.backend.hostId,
          localPort,
          remotePort: args.remotePort,
        });
        return {
          id: tracked.id,
          workspaceId: tracked.workspaceId,
          localUrl: tracked.localUrl,
          localPort: tracked.localPort,
          remotePort: tracked.remotePort,
        };
      } catch (error) {
        lastError = error;
        if (this.forwards.get(key)?.id === tracked.id) {
          this.forwards.delete(key);
        }
        logger.warn('SSH preview forward start attempt failed', {
          workspaceId: args.workspaceId,
          remotePort: args.remotePort,
          localPort,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (previous) {
      this.forwards.set(key, previous);
    }
    for (const forward of givingWay) {
      this.forwards.set(previewForwardKey(forward.workspaceId, forward.tabId), forward);
    }
    await Promise.all([
      this.restartPreviewTunnel(args.backend.hostId, host),
      previous && previous.hostId !== args.backend.hostId
        ? this.restartPreviewTunnel(previous.hostId, sshWorkspaceService.getHost(previous.hostId))
        : Promise.resolve(),
    ]).catch((error) => {
      logger.warn('Failed to restore previous SSH preview forwards after start failure', {
        hostId: args.backend.hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.restartTunnelsOfOtherHosts(givingWay, args.backend.hostId);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Forwards the VNC port of one of an SSH host's virtual desktops, for a VNC app on this
   * computer, and returns the local port. Each desktop's forward has its own tunnel: the preview
   * tunnel restarts whenever a workspace preview starts or stops, and a tunnel shared by the
   * desktops would restart as they come and go, either of which would disconnect the VNC app.
   * `runningPorts`, the VNC ports of the host's running desktops, closes forwards to stopped ones.
   */
  async startVncForward(
    hostId: string,
    remotePort: number,
    runningPorts?: number[]
  ): Promise<number> {
    this.assertNotDisposed();
    validatePort(remotePort, 'remotePort');
    return this.serializePreviewMutation(() =>
      this.startVncForwardLocked(hostId, remotePort, runningPorts)
    );
  }

  private async startVncForwardLocked(
    hostId: string,
    remotePort: number,
    runningPorts: number[] | undefined
  ): Promise<number> {
    const stopped = Array.from(this.vncTunnels.values()).filter(
      (tunnel) =>
        tunnel.hostId === hostId &&
        tunnel.remotePort !== remotePort &&
        runningPorts?.includes(tunnel.remotePort) === false
    );
    await Promise.all(stopped.map((tunnel) => this.stopVncTunnel(tunnel)));
    const host = sshWorkspaceService.getHost(hostId);
    const key = vncTunnelKey(hostId, remotePort);
    const existing = this.vncTunnels.get(key);
    // A tunnel from before the host was edited may reach another machine.
    if (
      existing?.process.exitCode === null &&
      isDeepStrictEqual(
        existing.sshArgs,
        localForwardArgs(host, [{ localPort: existing.localPort, remotePort }])
      )
    ) {
      return existing.localPort;
    }
    if (existing) await this.stopVncTunnel(existing);

    const localPort = await this.allocateLocalPort(remotePort);
    validatePort(localPort, 'localPort');
    const sshArgs = localForwardArgs(host, [{ localPort, remotePort }]);
    const child = spawn('ssh', sshArgs, {
      env: buildSshEnv(askpassService),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const tracked: TrackedVncTunnel = {
      hostId,
      remotePort,
      process: child,
      stderr: '',
      sshArgs,
      localPort,
    };
    const forget = () => {
      if (this.vncTunnels.get(key) === tracked) this.vncTunnels.delete(key);
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      tracked.stderr = `${tracked.stderr}${chunk.toString('utf8')}`.slice(-STDERR_PREVIEW_LIMIT);
    });
    child.once('exit', forget);
    child.once('error', forget);
    this.vncTunnels.set(key, tracked);

    try {
      await this.waitUntilLocalPortAcceptsConnections(tracked, localPort);
    } catch (error) {
      forget();
      await this.killForward(tracked);
      throw error;
    }
    logger.info('SSH VNC forward started', { hostId, localPort, remotePort });
    return localPort;
  }

  /** Stops the forward of one of the host's virtual desktops, which disconnects its VNC app. */
  async stopDesktopForward(hostId: string, remotePort: number): Promise<void> {
    return this.serializePreviewMutation(async () => {
      const tunnel = this.vncTunnels.get(vncTunnelKey(hostId, remotePort));
      if (tunnel) await this.stopVncTunnel(tunnel);
    });
  }

  /** The ports forwarded to and from SSH hosts, for the SSH hosts menu. */
  listForwardedPorts(): SshForwardedPort[] {
    const ports: SshForwardedPort[] = [];
    for (const forward of this.forwards.values()) {
      const { id, hostId, localPort, remotePort, workspaceId } = forward;
      const owner = forward.givesWay
        ? { kind: 'link' as const, workspaceId }
        : { kind: 'browser-tab' as const, workspaceId, tabId: forward.tabId };
      // A tunnel that dropped starts again when its tab or link is used.
      const state =
        this.previewTunnels.get(hostId)?.process.exitCode === null ? 'connected' : 'stopped';
      ports.push({
        id,
        hostId,
        direction: 'remote-to-local',
        localPort,
        remotePort,
        ...owner,
        state,
      });
    }
    for (const { hostId, localPort, remotePort } of this.vncTunnels.values()) {
      ports.push({
        id: `desktop:${vncTunnelKey(hostId, remotePort)}`,
        hostId,
        kind: 'desktop',
        direction: 'remote-to-local',
        localPort,
        remotePort,
      });
    }
    for (const [hostId, host] of this.configuredForwardTargets) {
      const { state } = this.getHostPortForwardStatus(hostId);
      for (const forward of host.portForwards ?? []) {
        if (!forward.enabled) continue;
        ports.push({
          id: `saved:${hostId}:${forward.id}`,
          hostId,
          kind: 'saved',
          direction: forward.direction ?? 'local-to-remote',
          localPort: forward.localPort,
          remotePort: forward.remotePort,
          name: forward.name,
          state,
        });
      }
    }
    for (const { hostId, gatewayPort, remotePort } of this.komlaDataTunnels.values()) {
      ports.push({
        id: `komla:${hostId}`,
        hostId,
        kind: 'komla',
        direction: 'local-to-remote',
        localPort: gatewayPort,
        remotePort,
      });
    }
    return ports;
  }

  async stopVncForward(hostId: string): Promise<void> {
    return this.serializePreviewMutation(async () => {
      const tunnels = Array.from(this.vncTunnels.values()).filter(
        (tunnel) => tunnel.hostId === hostId
      );
      await Promise.all(tunnels.map((tunnel) => this.stopVncTunnel(tunnel)));
    });
  }

  private async stopVncTunnel(tracked: TrackedVncTunnel): Promise<void> {
    const key = vncTunnelKey(tracked.hostId, tracked.remotePort);
    if (this.vncTunnels.get(key) === tracked) this.vncTunnels.delete(key);
    await this.killForward(tracked);
  }

  /** Stops the forward of one of the workspace's browser tabs, or without a tab, all of them. */
  async stopPreviewForward(workspaceId: string, tabId?: string): Promise<void> {
    return this.serializePreviewMutation(() => this.stopPreviewForwardLocked(workspaceId, tabId));
  }

  private async stopPreviewForwardLocked(workspaceId: string, tabId?: string): Promise<void> {
    const stopping = Array.from(this.forwards.values()).filter(
      (forward) =>
        forward.workspaceId === workspaceId && (tabId === undefined || forward.tabId === tabId)
    );
    for (const hostId of new Set(stopping.map((forward) => forward.hostId))) {
      const host = sshWorkspaceService.getHost(hostId);
      const remainingHostForwards = Array.from(this.forwards.values()).filter(
        (forward) => forward.hostId === hostId && !stopping.includes(forward)
      );
      const hostEndpoint =
        remainingHostForwards.length === 0 ? undefined : await sshHostEndpoint(host);
      for (const forward of stopping) {
        this.forwards.delete(previewForwardKey(forward.workspaceId, forward.tabId));
      }
      if (hostEndpoint) {
        try {
          this.assertPreviewEndpointAvailable(hostId, hostEndpoint, remainingHostForwards);
        } catch (error) {
          const existing = this.previewTunnels.get(hostId);
          if (existing) {
            this.previewTunnels.delete(hostId);
            await this.killForward(existing);
          }
          logger.warn('Stopped SSH preview tunnel instead of migrating conflicting forwards', {
            workspaceId,
            hostId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
      await this.restartPreviewTunnel(hostId, host, hostEndpoint);
    }
  }

  reconcileHostPortForwards(host: SshHost): Promise<void> {
    this.assertNotDisposed();
    this.configuredForwardTargets.set(host.id, structuredClone(host));
    this.clearConfiguredForwardRetry(host.id);
    this.configuredForwardRetryAttempts.delete(host.id);
    return this.serializeConfiguredForwardMutation(host.id, () =>
      this.reconcileHostPortForwardsLocked(host.id)
    );
  }

  async stopHostPortForwards(hostId: string): Promise<void> {
    this.configuredForwardTargets.delete(hostId);
    this.clearConfiguredForwardRetry(hostId);
    this.configuredForwardRetryAttempts.delete(hostId);
    await Promise.all([
      this.serializeConfiguredForwardMutation(hostId, async () => {
        await this.stopConfiguredForwardTunnel(hostId);
        this.configuredForwardStatuses.delete(hostId);
      }),
      this.stopVncForward(hostId),
    ]);
  }

  getHostPortForwardStatus(hostId: string): SshPortForwardStatus {
    return (
      this.configuredForwardStatuses.get(hostId) ?? {
        hostId,
        state: 'stopped',
      }
    );
  }

  startConfiguredHostPortForwards(hosts: SshHost[]): void {
    for (const host of hosts) {
      void this.reconcileHostPortForwards(host).catch((error) => {
        logger.warn('Failed to start configured SSH port forwards', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.configuredForwardRetryTimers.values()) clearTimeout(timer);
    this.configuredForwardRetryTimers.clear();
    this.configuredForwardTargets.clear();
    const configuredForwardTunnels = Array.from(this.configuredForwardTunnels.values());
    this.configuredForwardTunnels.clear();
    await Promise.all(configuredForwardTunnels.map((tunnel) => this.killForward(tunnel)));
    await Promise.allSettled(this.configuredForwardMutations.values());
    this.configuredForwardStatuses.clear();
    for (const timer of this.komlaDataRetryTimers.values()) clearTimeout(timer);
    this.komlaDataRetryTimers.clear();
    this.komlaDataTargets.clear();
    for (const hostId of new Set([
      ...this.komlaDataMutations.keys(),
      ...this.komlaDataTunnels.keys(),
    ])) {
      this.cancelPendingKomlaDataStarts(hostId);
    }
    const komlaDataTunnels = Array.from(this.komlaDataTunnels.values());
    this.komlaDataTunnels.clear();
    await Promise.all(komlaDataTunnels.map((tunnel) => this.closeKomlaDataTunnel(tunnel)));
    await this.previewMutation;
    await Promise.allSettled(this.komlaDataMutations.values());
    const previewTunnels = [...this.previewTunnels.values(), ...this.vncTunnels.values()];
    this.forwards.clear();
    this.previewTunnels.clear();
    this.vncTunnels.clear();
    await Promise.all(previewTunnels.map((tunnel) => this.killForward(tunnel)));
  }

  private serializePreviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.previewMutation.then(operation, operation);
    this.previewMutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private serializeConfiguredForwardMutation(
    hostId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const previous = this.configuredForwardMutations.get(hostId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.configuredForwardMutations.set(hostId, settled);
    void settled.finally(() => {
      if (this.configuredForwardMutations.get(hostId) === settled) {
        this.configuredForwardMutations.delete(hostId);
      }
    });
    return result;
  }

  private async reconcileHostPortForwardsLocked(hostId: string): Promise<void> {
    const host = this.configuredForwardTargets.get(hostId);
    if (!host) {
      await this.stopConfiguredForwardTunnel(hostId);
      return;
    }
    const enabledForwards = host.portForwards?.filter((forward) => forward.enabled) ?? [];
    if (enabledForwards.length === 0) {
      await this.stopConfiguredForwardTunnel(hostId);
      this.configuredForwardStatuses.set(hostId, { hostId, state: 'stopped' });
      return;
    }

    const configKey = JSON.stringify({
      hostname: host.hostname,
      user: host.user,
      port: host.port,
      identityFile: host.identityFile,
      extraSshArgs: host.extraSshArgs,
      forwards: enabledForwards.map(({ direction, localPort, remotePort }) => ({
        direction: direction ?? 'local-to-remote',
        localPort,
        remotePort,
      })),
    });
    const existing = this.configuredForwardTunnels.get(hostId);
    if (existing?.configKey === configKey && existing.process.exitCode === null) return;
    await this.stopConfiguredForwardTunnel(hostId);
    if (this.configuredForwardTargets.get(hostId) !== host) return;
    this.configuredForwardStatuses.set(hostId, { hostId, state: 'connecting' });

    try {
      const tracked = this.spawnConfiguredForwardTunnel(host, configKey);
      this.configuredForwardTunnels.set(hostId, tracked);
      await this.waitForConfiguredForwardReady(tracked);
      if (this.configuredForwardTunnels.get(hostId) !== tracked) return;
      this.configuredForwardRetryAttempts.delete(hostId);
      this.configuredForwardStatuses.set(hostId, { hostId, state: 'connected' });
      logger.info('Configured SSH port forwards connected', {
        hostId,
        forwards: enabledForwards.map(({ direction, localPort, remotePort }) => ({
          direction: direction ?? 'local-to-remote',
          localPort,
          remotePort,
        })),
      });
    } catch (error) {
      const tracked = this.configuredForwardTunnels.get(hostId);
      if (tracked) {
        this.configuredForwardTunnels.delete(hostId);
        await this.killForward(tracked);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.configuredForwardStatuses.set(hostId, { hostId, state: 'error', error: message });
      this.scheduleConfiguredForwardRetry(hostId, message);
    }
  }

  private spawnConfiguredForwardTunnel(
    host: SshHost,
    configKey: string
  ): TrackedConfiguredForwardTunnel {
    const enabledForwards = host.portForwards?.filter((forward) => forward.enabled) ?? [];
    const remotePorts = enabledForwards
      .filter((forward) => forward.direction !== 'remote-to-local')
      .map((forward) => forward.remotePort);
    const remoteCommand = remotePorts.length
      ? `if command -v ss >/dev/null 2>&1; then ss -H -ltn || exit 1; elif command -v netstat >/dev/null 2>&1; then netstat -an || exit 1; elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP -sTCP:LISTEN || exit 1; else printf '[komla] cannot verify remote port binding; install ss, netstat, or lsof\\n' >&2; exit 1; fi; printf '${CONFIGURED_FORWARD_READY_MARKER}\\n'; ${SSH_HEARTBEAT_LEASE_COMMAND}`
      : `printf '${CONFIGURED_FORWARD_READY_MARKER}\\n'; ${SSH_HEARTBEAT_LEASE_COMMAND}`;
    const args = [
      '-o',
      'ClearAllForwardings=no',
      '-o',
      'ExitOnForwardFailure=yes',
      ...sshOptionArgs(host),
      '-S',
      'none',
      '-T',
      ...enabledForwards.flatMap((forward) =>
        forward.direction === 'remote-to-local'
          ? ['-L', `127.0.0.1:${forward.localPort}:127.0.0.1:${forward.remotePort}`]
          : ['-R', `127.0.0.1:${forward.remotePort}:127.0.0.1:${forward.localPort}`]
      ),
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      sshTarget(host),
      remoteCommand,
    ];
    const child = spawn('ssh', args, {
      env: buildSshEnv(askpassService),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    keepSshLeaseAlive(child);
    const tracked: TrackedConfiguredForwardTunnel = {
      hostId: host.id,
      configKey,
      remotePorts,
      process: child,
      stderr: '',
      stdout: '',
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      tracked.stderr = `${tracked.stderr}${chunk.toString('utf8')}`.slice(-STDERR_PREVIEW_LIMIT);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      tracked.stdout = `${tracked.stdout}${chunk.toString('utf8')}`.slice(
        -CONFIGURED_FORWARD_STDOUT_LIMIT
      );
    });
    child.once('exit', (code, signal) => {
      if (this.configuredForwardTunnels.get(host.id) !== tracked) return;
      this.configuredForwardTunnels.delete(host.id);
      const message = `${summarizeStderr(tracked.stderr)} (ssh exited with ${signal ?? `code ${code}`})`;
      this.configuredForwardStatuses.set(host.id, {
        hostId: host.id,
        state: 'error',
        error: message,
      });
      this.scheduleConfiguredForwardRetry(host.id, message);
    });
    child.once('error', (error) => {
      if (this.configuredForwardTunnels.get(host.id) !== tracked) return;
      this.configuredForwardTunnels.delete(host.id);
      const message = `${summarizeStderr(tracked.stderr)} (${error.message})`;
      this.configuredForwardStatuses.set(host.id, {
        hostId: host.id,
        state: 'error',
        error: message,
      });
      this.scheduleConfiguredForwardRetry(host.id, message);
    });
    return tracked;
  }

  private waitForConfiguredForwardReady(tracked: TrackedConfiguredForwardTunnel): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () => finish(new Error('Timed out waiting for SSH port forwards to start')),
        FORWARD_READY_TIMEOUT_MS
      );
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        tracked.process.stdout?.off('data', onStdout);
        tracked.process.off('error', onError);
        tracked.process.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onStdout = () => {
        if (!tracked.stdout.includes(CONFIGURED_FORWARD_READY_MARKER)) return;
        try {
          assertLoopbackRemoteListeners(tracked.stdout, tracked.remotePorts);
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onError = (error: Error) => {
        finish(new Error(`${summarizeStderr(tracked.stderr)} (${error.message})`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new Error(
            `${summarizeStderr(tracked.stderr)} (ssh exited with ${signal ?? `code ${code}`})`
          )
        );
      };
      tracked.process.stdout?.on('data', onStdout);
      tracked.process.once('error', onError);
      tracked.process.once('exit', onExit);
      onStdout();
    });
  }

  private async stopConfiguredForwardTunnel(hostId: string): Promise<void> {
    const tracked = this.configuredForwardTunnels.get(hostId);
    if (!tracked) return;
    this.configuredForwardTunnels.delete(hostId);
    await this.killForward(tracked);
  }

  private scheduleConfiguredForwardRetry(hostId: string, reason: string): void {
    if (
      !this.configuredForwardTargets.has(hostId) ||
      this.configuredForwardRetryTimers.has(hostId)
    ) {
      return;
    }
    const attempt = this.configuredForwardRetryAttempts.get(hostId) ?? 0;
    const delay = Math.min(
      CONFIGURED_FORWARD_RETRY_INITIAL_MS * 2 ** Math.min(attempt, 5),
      CONFIGURED_FORWARD_RETRY_MAX_MS
    );
    this.configuredForwardRetryAttempts.set(hostId, attempt + 1);
    const timer = setTimeout(() => {
      this.configuredForwardRetryTimers.delete(hostId);
      void this.serializeConfiguredForwardMutation(hostId, () =>
        this.reconcileHostPortForwardsLocked(hostId)
      );
    }, delay);
    this.configuredForwardRetryTimers.set(hostId, timer);
    logger.info('Configured SSH port forward retry scheduled', { hostId, delayMs: delay, reason });
  }

  private clearConfiguredForwardRetry(hostId: string): void {
    const timer = this.configuredForwardRetryTimers.get(hostId);
    if (!timer) return;
    clearTimeout(timer);
    this.configuredForwardRetryTimers.delete(hostId);
  }

  ensureKomlaDataTunnel(
    hostId: string,
    localPort: number,
    onConnected?: () => void
  ): Promise<void> {
    this.assertNotDisposed();
    validatePort(localPort, 'localPort');
    const previousTarget = this.komlaDataTargets.get(hostId);
    const target: KomlaDataTunnelTarget =
      previousTarget?.localPort === localPort ? previousTarget : { localPort, retryAttempt: 0 };
    if (onConnected) target.onConnected = onConnected;
    this.komlaDataTargets.set(hostId, target);
    this.clearKomlaDataRetry(hostId);
    const version = this.komlaDataVersions.get(hostId) ?? 0;

    return this.serializeKomlaDataMutation(hostId, async () => {
      if ((this.komlaDataVersions.get(hostId) ?? 0) !== version) {
        throw new Error('SSH Komla data tunnel start was cancelled');
      }
      const previousTunnel = this.komlaDataTunnels.get(hostId);
      await this.ensureKomlaDataTunnelLocked(hostId, localPort);
      if (
        this.komlaDataTargets.get(hostId) !== target ||
        (this.komlaDataVersions.get(hostId) ?? 0) !== version
      ) {
        await this.stopMatchingKomlaDataTunnel(hostId, localPort);
        throw new Error('SSH Komla data tunnel start was cancelled');
      }
      target.retryAttempt = 0;
      if (this.komlaDataTunnels.get(hostId) !== previousTunnel) {
        this.reportKomlaDataTunnelConnected(hostId, target);
      }
    }).catch((error) => {
      if ((this.komlaDataVersions.get(hostId) ?? 0) === version) {
        this.scheduleKomlaDataRetry(hostId, target, error instanceof Error ? error : undefined);
      }
      throw error;
    });
  }

  stopKomlaDataTunnel(hostId: string): Promise<void> {
    this.komlaDataTargets.delete(hostId);
    this.clearKomlaDataRetry(hostId);
    this.cancelPendingKomlaDataStarts(hostId);
    return this.serializeKomlaDataMutation(hostId, async () => {
      const tracked = this.komlaDataTunnels.get(hostId);
      if (!tracked) return;
      this.komlaDataTunnels.delete(hostId);
      await this.closeKomlaDataTunnel(tracked);
    });
  }

  private async ensureKomlaDataTunnelLocked(hostId: string, localPort: number): Promise<void> {
    const existing = this.komlaDataTunnels.get(hostId);
    if (existing && existing.localPort === localPort && existing.process.exitCode === null) {
      return;
    }
    if (existing) {
      this.komlaDataTunnels.delete(hostId);
      await this.closeKomlaDataTunnel(existing);
    }

    const host = sshWorkspaceService.getHost(hostId);
    const remotePort = remoteKomlaDataPort(hostId);
    validatePort(remotePort, 'remotePort');
    const gateway = await this.startHostScopedGateway(hostId, localPort);
    const address = gateway.address();
    if (!address || typeof address === 'string') {
      await this.closeServer(gateway);
      throw new Error('Could not allocate SSH Komla data gateway port');
    }
    const gatewayPort = address.port;
    const args = [
      ...sshOptionArgs(host),
      // This process must own the reverse forward so an SSH ControlMaster
      // cannot outlive it or cause this client to exit after registration.
      '-S',
      'none',
      '-T',
      '-R',
      `127.0.0.1:${remotePort}:127.0.0.1:${gatewayPort}`,
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      sshTarget(host),
      `printf '${KOMLA_DATA_TUNNEL_READY_MARKER}\\n'; ${SSH_HEARTBEAT_LEASE_COMMAND}`,
    ];

    const child = spawn('ssh', args, {
      env: buildSshEnv(askpassService),
      // The open stdin pipe is the tunnel's parent lease. If Komla exits
      // without cleanup, EOF reaches the remote lease and SSH exits too.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    keepSshLeaseAlive(child);
    const tracked: TrackedKomlaDataTunnel = {
      hostId,
      localPort,
      gatewayPort,
      remotePort,
      gateway,
      process: child,
      stderr: '',
      stdout: '',
      startedAt: Date.now(),
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      tracked.stderr = `${tracked.stderr}${chunk.toString('utf8')}`.slice(-STDERR_PREVIEW_LIMIT);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      tracked.stdout = `${tracked.stdout}${chunk.toString('utf8')}`.slice(
        -KOMLA_DATA_TUNNEL_READY_MARKER.length * 2
      );
    });
    child.once('exit', (code, signal) => {
      const wasCurrent = this.komlaDataTunnels.get(hostId) === tracked;
      if (wasCurrent) {
        this.komlaDataTunnels.delete(hostId);
      }
      void this.closeServer(gateway);
      const message = summarizeStderr(tracked.stderr);
      if (!wasCurrent) {
        logger.debug('SSH Komla data tunnel exited', { hostId, remotePort, code, signal });
      } else {
        const retryInMs = this.scheduleKomlaDataRetry(hostId, undefined, message);
        logger.warn('SSH Komla data tunnel exited unexpectedly', {
          hostId,
          target: sshTarget(host),
          localPort,
          gatewayPort,
          remotePort,
          code,
          signal,
          message,
          stderr: tracked.stderr.trim() || undefined,
          uptimeMs: Date.now() - tracked.startedAt,
          retryInMs,
        });
      }
    });
    child.once('error', (error) => {
      const wasCurrent = this.komlaDataTunnels.get(hostId) === tracked;
      if (wasCurrent) {
        this.komlaDataTunnels.delete(hostId);
      }
      void this.closeServer(gateway);
      if (wasCurrent) {
        const retryInMs = this.scheduleKomlaDataRetry(hostId, undefined, error);
        logger.warn('SSH Komla data tunnel process error', {
          hostId,
          target: sshTarget(host),
          localPort,
          gatewayPort,
          remotePort,
          error: error.message,
          stderr: tracked.stderr.trim() || undefined,
          uptimeMs: Date.now() - tracked.startedAt,
          retryInMs,
        });
      }
    });

    this.komlaDataTunnels.set(hostId, tracked);
    try {
      await this.waitForKomlaDataTunnelReady(tracked);
    } catch (error) {
      if (this.komlaDataTunnels.get(hostId) === tracked) {
        this.komlaDataTunnels.delete(hostId);
      }
      await this.closeKomlaDataTunnel(tracked);
      throw error;
    }
    logger.info('SSH Komla data tunnel started', {
      hostId,
      localPort,
      gatewayPort,
      remotePort,
    });
  }

  private startHostScopedGateway(hostId: string, localPort: number): Promise<HttpServer> {
    const server = createHttpServer((req, res) => {
      if (!isRemoteGatewayRoute(req.url)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const headers = { ...req.headers };
      delete headers[KOMLA_SSH_HOST_HEADER];
      headers[KOMLA_SSH_HOST_HEADER] = hostId;
      headers.host = `127.0.0.1:${localPort}`;
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: localPort,
          method: req.method,
          path: req.url,
          headers,
        },
        (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        }
      );
      upstream.on('error', () => {
        res.shouldKeepAlive = false;
        if (!res.headersSent) {
          res.writeHead(502, {
            'Content-Type': 'application/json',
            Connection: 'close',
          });
        }
        res.end(JSON.stringify({ error: 'Komla data service unavailable' }));
      });
      const abortUpstream = () => upstream.destroy();
      req.once('aborted', abortUpstream);
      res.once('close', () => {
        if (!res.writableEnded) abortUpstream();
      });
      req.pipe(upstream);
    });

    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
  }

  private serializeKomlaDataMutation(
    hostId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const previous = this.komlaDataMutations.get(hostId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.komlaDataMutations.set(hostId, settled);
    void settled.finally(() => {
      if (this.komlaDataMutations.get(hostId) === settled) {
        this.komlaDataMutations.delete(hostId);
      }
    });
    return result;
  }

  private waitForKomlaDataTunnelReady(tracked: TrackedKomlaDataTunnel): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error('Timed out waiting for SSH Komla data tunnel to start'));
      }, FORWARD_READY_TIMEOUT_MS);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        tracked.process.stdout?.off('data', onStdout);
        tracked.process.off('error', onError);
        tracked.process.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onStdout = () => {
        if (tracked.stdout.includes(KOMLA_DATA_TUNNEL_READY_MARKER)) finish();
      };
      const onError = (error: Error) => {
        finish(new Error(`${summarizeStderr(tracked.stderr)} (${error.message})`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new Error(
            `${summarizeStderr(tracked.stderr)} (ssh exited with ${signal ?? `code ${code}`})`
          )
        );
      };

      tracked.process.stdout?.on('data', onStdout);
      tracked.process.once('error', onError);
      tracked.process.once('exit', onExit);
      onStdout();
    });
  }

  private scheduleKomlaDataRetry(
    hostId: string,
    expectedTarget?: KomlaDataTunnelTarget,
    reason?: Error | string
  ): number | undefined {
    const target = this.komlaDataTargets.get(hostId);
    if (!target || (expectedTarget && target !== expectedTarget)) return undefined;
    if (this.komlaDataRetryTimers.has(hostId)) return undefined;

    const delay = Math.min(
      KOMLA_DATA_RETRY_INITIAL_MS * 2 ** Math.min(target.retryAttempt, 5),
      KOMLA_DATA_RETRY_MAX_MS
    );
    target.retryAttempt++;
    const timer = setTimeout(() => {
      this.komlaDataRetryTimers.delete(hostId);
      if (this.komlaDataTargets.get(hostId) !== target) return;
      const version = this.komlaDataVersions.get(hostId) ?? 0;
      void this.serializeKomlaDataMutation(hostId, async () => {
        if (
          this.komlaDataTargets.get(hostId) !== target ||
          (this.komlaDataVersions.get(hostId) ?? 0) !== version
        ) {
          return;
        }
        const previousTunnel = this.komlaDataTunnels.get(hostId);
        await this.ensureKomlaDataTunnelLocked(hostId, target.localPort);
        if (
          this.komlaDataTargets.get(hostId) !== target ||
          (this.komlaDataVersions.get(hostId) ?? 0) !== version
        ) {
          await this.stopMatchingKomlaDataTunnel(hostId, target.localPort);
          return;
        }
        target.retryAttempt = 0;
        if (this.komlaDataTunnels.get(hostId) !== previousTunnel) {
          this.reportKomlaDataTunnelConnected(hostId, target);
        }
      }).catch((error) => {
        logger.warn('SSH Komla data tunnel restart failed', {
          hostId,
          attempt: target.retryAttempt,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleKomlaDataRetry(hostId, target, error instanceof Error ? error : undefined);
      });
    }, delay);
    this.komlaDataRetryTimers.set(hostId, timer);
    logger.info('SSH Komla data tunnel restart scheduled', {
      hostId,
      attempt: target.retryAttempt,
      delayMs: delay,
      reason: reason instanceof Error ? reason.message : reason,
    });
    return delay;
  }

  private clearKomlaDataRetry(hostId: string): void {
    const timer = this.komlaDataRetryTimers.get(hostId);
    if (!timer) return;
    clearTimeout(timer);
    this.komlaDataRetryTimers.delete(hostId);
  }

  private reportKomlaDataTunnelConnected(hostId: string, target: KomlaDataTunnelTarget): void {
    if (this.komlaDataTargets.get(hostId) !== target) return;
    try {
      target.onConnected?.();
    } catch (error) {
      logger.warn('SSH Komla data tunnel connection listener failed', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopMatchingKomlaDataTunnel(hostId: string, localPort: number): Promise<void> {
    const tracked = this.komlaDataTunnels.get(hostId);
    if (!tracked || tracked.localPort !== localPort) return;
    this.komlaDataTunnels.delete(hostId);
    await this.closeKomlaDataTunnel(tracked);
  }

  stopKomlaDataTunnelsExcept(activeHostIds: ReadonlySet<string>): void {
    for (const hostId of this.komlaDataTargets.keys()) {
      if (activeHostIds.has(hostId)) continue;
      this.komlaDataTargets.delete(hostId);
      this.clearKomlaDataRetry(hostId);
      this.cancelPendingKomlaDataStarts(hostId);
    }
    for (const hostId of this.komlaDataMutations.keys()) {
      if (!activeHostIds.has(hostId)) this.cancelPendingKomlaDataStarts(hostId);
    }
    for (const [hostId, tracked] of this.komlaDataTunnels) {
      if (activeHostIds.has(hostId)) continue;
      this.komlaDataTunnels.delete(hostId);
      void this.closeKomlaDataTunnel(tracked);
    }
  }

  private cancelPendingKomlaDataStarts(hostId: string): void {
    this.komlaDataVersions.set(hostId, (this.komlaDataVersions.get(hostId) ?? 0) + 1);
  }

  private async closeKomlaDataTunnel(tracked: TrackedKomlaDataTunnel): Promise<void> {
    await Promise.all([this.killForward(tracked), this.closeServer(tracked.gateway)]);
  }

  private closeServer(server: HttpServer): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  private async restartPreviewTunnel(
    hostId: string,
    host: SshHost,
    hostEndpoint?: SshEndpointIdentity
  ): Promise<void> {
    const hostForwards = Array.from(this.forwards.values()).filter(
      (forward) => forward.hostId === hostId
    );
    const refreshedHostEndpoint =
      hostForwards.length === 0 ? undefined : (hostEndpoint ?? (await sshHostEndpoint(host)));

    if (refreshedHostEndpoint) {
      this.assertPreviewEndpointAvailable(hostId, refreshedHostEndpoint, hostForwards);
    }

    const existing = this.previewTunnels.get(hostId);
    const controlPath = sshTunnelControlPath(host, 'preview');
    const baseArgs = localForwardArgs(host, [], controlPath);
    if (
      refreshedHostEndpoint &&
      existing &&
      (await this.changePreviewForwardsInPlace(
        existing,
        host,
        baseArgs,
        refreshedHostEndpoint,
        hostForwards
      ))
    ) {
      this.refreshPreviewEndpoints(hostForwards, refreshedHostEndpoint);
      return;
    }
    if (existing) {
      this.previewTunnels.delete(hostId);
      await this.killForward(existing);
    }

    if (!refreshedHostEndpoint) return;

    // A master killed before it could remove its socket would leave the next one unshared.
    if (controlPath) rmSync(controlPath, { force: true });
    const child = spawn('ssh', localForwardArgs(host, hostForwards, controlPath), {
      env: buildSshEnv(askpassService),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const tracked: TrackedHostPreviewTunnel = {
      hostId,
      process: child,
      stderr: '',
      controlPath,
      baseArgs,
      hostEndpoint: refreshedHostEndpoint,
      forwardSpecs: hostForwards.map(localForwardSpec),
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      tracked.stderr = `${tracked.stderr}${chunk.toString('utf8')}`.slice(-STDERR_PREVIEW_LIMIT);
    });
    child.once('exit', (code, signal) => {
      if (this.previewTunnels.get(hostId) === tracked) {
        this.previewTunnels.delete(hostId);
      }
      logger.debug('SSH preview forward exited', {
        hostId,
        ports: hostForwards.map((forward) => ({
          localPort: forward.localPort,
          remotePort: forward.remotePort,
        })),
        code,
        signal,
      });
    });
    child.once('error', (error) => {
      if (this.previewTunnels.get(hostId) === tracked) {
        this.previewTunnels.delete(hostId);
      }
      logger.warn('SSH preview forward process error', {
        hostId,
        error: error.message,
      });
    });

    this.previewTunnels.set(hostId, tracked);

    try {
      await Promise.all(
        hostForwards.map((forward) =>
          this.waitUntilLocalPortAcceptsConnections(tracked, forward.localPort)
        )
      );
    } catch (error) {
      if (this.previewTunnels.get(hostId) === tracked) {
        this.previewTunnels.delete(hostId);
      }
      await this.killForward(tracked);
      throw error;
    }

    this.refreshPreviewEndpoints(hostForwards, refreshedHostEndpoint);

    logger.info('SSH preview tunnel started', {
      hostId,
      forwardCount: hostForwards.length,
      ports: hostForwards.map((forward) => ({
        localPort: forward.localPort,
        remotePort: forward.remotePort,
      })),
    });
  }

  private refreshPreviewEndpoints(
    hostForwards: TrackedForward[],
    hostEndpoint: SshEndpointIdentity
  ): void {
    for (const forward of hostForwards) {
      const current = this.forwards.get(previewForwardKey(forward.workspaceId, forward.tabId));
      if (current?.id === forward.id) current.hostEndpoint = hostEndpoint;
    }
  }

  /**
   * Cancels and adds forwards through the running tunnel's own master, which keeps the forwards
   * that stay, and their connections, up and needs no new SSH connection. False when the tunnel
   * can't, so the caller starts a new one with every forward.
   */
  private async changePreviewForwardsInPlace(
    tunnel: TrackedHostPreviewTunnel,
    host: SshHost,
    baseArgs: string[],
    hostEndpoint: SshEndpointIdentity,
    hostForwards: TrackedForward[]
  ): Promise<boolean> {
    const { controlPath } = tunnel;
    if (
      !controlPath ||
      tunnel.process.exitCode !== null ||
      !isDeepStrictEqual(tunnel.baseArgs, baseArgs) ||
      !isDeepStrictEqual(tunnel.hostEndpoint, hostEndpoint)
    ) {
      return false;
    }
    const wanted = hostForwards.map(localForwardSpec);
    const cancelled = tunnel.forwardSpecs.filter((spec) => !wanted.includes(spec));
    const added = wanted.filter((spec) => !tunnel.forwardSpecs.includes(spec));
    try {
      if (cancelled.length > 0) {
        await runSshControlCommand(controlPath, host, 'cancel', cancelled);
        tunnel.forwardSpecs = tunnel.forwardSpecs.filter((spec) => !cancelled.includes(spec));
      }
      if (added.length > 0) {
        await runSshControlCommand(controlPath, host, 'forward', added);
        tunnel.forwardSpecs.push(...added);
      }
    } catch (error) {
      logger.warn('Restarting SSH preview tunnel after an in-place forward change failed', {
        hostId: tunnel.hostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    logger.info('SSH preview tunnel forwards changed', {
      hostId: tunnel.hostId,
      forwardCount: hostForwards.length,
    });
    return true;
  }

  /** Other workspaces' link forwards to the port `args` forwards, which give it up. */
  private forwardsGivingWayTo(
    args: StartSshPreviewForwardArgs,
    hostEndpoint: SshEndpointIdentity
  ): TrackedForward[] {
    return Array.from(this.forwards.values()).filter(
      (forward) =>
        forward.givesWay &&
        forward.workspaceId !== args.workspaceId &&
        forward.remotePort === args.remotePort &&
        (forward.hostId === args.backend.hostId ||
          sshEndpointsConflict(forward.hostEndpoint, hostEndpoint))
    );
  }

  /**
   * Restarts the tunnels of the hosts other than `hostId` that `forwards` are on, whose
   * forwards changed. Their failure is logged: it isn't the failure of `hostId`'s start.
   */
  private async restartTunnelsOfOtherHosts(
    forwards: TrackedForward[],
    hostId: string
  ): Promise<void> {
    const otherHostIds = new Set(
      forwards.map((forward) => forward.hostId).filter((other) => other !== hostId)
    );
    await Promise.all(
      Array.from(otherHostIds, (other) =>
        this.restartPreviewTunnel(other, sshWorkspaceService.getHost(other)).catch((error) => {
          logger.warn('Failed to restart an SSH preview tunnel after its link forwards changed', {
            hostId: other,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      )
    );
  }

  private assertPreviewEndpointAvailable(
    hostId: string,
    hostEndpoint: SshEndpointIdentity,
    hostForwards: TrackedForward[],
    ignoring: TrackedForward[] = []
  ): void {
    for (const hostForward of hostForwards) {
      const conflictingForward = Array.from(this.forwards.values()).find(
        (forward) =>
          !ignoring.includes(forward) &&
          forward.hostId !== hostId &&
          forward.remotePort === hostForward.remotePort &&
          sshEndpointsConflict(forward.hostEndpoint, hostEndpoint)
      );
      if (conflictingForward) {
        throw new Error(
          `Remote port ${hostForward.remotePort} on this SSH host is already forwarded by another workspace. Stop that workspace's forward or start this dev server on a different port.`
        );
      }
    }
  }

  /**
   * A port free on 127.0.0.1, where tunnels listen, preferably `preferredPort`. With
   * `ipv6Too` it is free on [::1] as well, so localhost can't reach another server there.
   */
  private async allocateLocalPort(
    preferredPort: number,
    { ipv6Too = false }: { ipv6Too?: boolean } = {}
  ): Promise<number> {
    let port: number;
    try {
      port = await this.reserveAvailableLocalPort(preferredPort);
    } catch {
      port = await this.reserveAvailableLocalPort(0);
    }
    for (let attempt = 0; ipv6Too && !(await isFreeOnIpv6Loopback(port)); attempt++) {
      if (attempt === 5) throw new Error('Failed to allocate a local port free on [::1] too');
      port = await this.reserveAvailableLocalPort(0);
    }
    return port;
  }

  private reserveAvailableLocalPort(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to allocate a local port'));
            return;
          }
          resolve(address.port);
        });
      });
    });
  }

  private waitUntilLocalPortAcceptsConnections(
    tracked: TrackedPreviewTunnel,
    localPort: number
  ): Promise<void> {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      if (tracked.process.exitCode !== null) {
        finish(
          new Error(
            `${summarizeStderr(tracked.stderr)} (ssh exited with code ${tracked.process.exitCode})`
          )
        );
        return;
      }

      tracked.process.once('error', (error) => {
        finish(new Error(`${summarizeStderr(tracked.stderr)} (${error.message})`));
      });

      tracked.process.once('exit', (code, signal) => {
        finish(
          new Error(
            `${summarizeStderr(tracked.stderr)} (ssh exited with ${signal ?? `code ${code}`})`
          )
        );
      });

      const probe = () => {
        if (Date.now() - startedAt > FORWARD_READY_TIMEOUT_MS) {
          finish(new Error('Timed out waiting for SSH port forward to start'));
          return;
        }

        const socket = createConnection({ host: '127.0.0.1', port: localPort });
        socket.once('connect', () => {
          socket.destroy();
          finish();
        });
        socket.once('error', () => {
          socket.destroy();
          timer = setTimeout(probe, FORWARD_READY_POLL_MS);
        });
      };

      probe();
    });
  }

  private killForward(tracked: KillableForward): Promise<void> {
    return new Promise((resolve) => {
      if (tracked.process.exitCode !== null || tracked.process.killed) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        try {
          tracked.process.kill('SIGKILL');
        } catch {
          // Process may already be gone.
        }
        resolve();
      }, 1000);

      tracked.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        tracked.process.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('SSH port forward service is shutting down');
  }
}

export const sshPortForwardService = new SshPortForwardService();
