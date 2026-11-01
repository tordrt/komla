import { chmodSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import {
  komlaSshRemoteDataPort,
  isValidSshBasePath,
  isValidSshHostname,
  normalizeSshBasePath,
  type SshHost,
  type SshHostCapabilities,
  type SshPortForward,
} from '../../shared/types';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

import { ensureKomlaBasePath } from './paths';
import { readLegacySshHosts } from './ssh-host-legacy-database';

const logger = createLogger('SshHostService');

const FILE_NAME = 'ssh-hosts.json';
const LEGACY_DATABASE_FILE_NAME = 'komla.db';
const FILE_MODE = 0o600;
const FILE_VERSION = 1;

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizePortForwards(
  hostId: string,
  portForwards: SshPortForward[] | undefined
): SshPortForward[] {
  if (!portForwards?.length) return [];
  const ids = new Set<string>();
  const enabledLocalPorts = new Set<number>();
  const enabledRemotePorts = new Set<number>();
  return portForwards.map((forward) => {
    const id = forward.id.trim();
    const name = forward.name.trim();
    if (!id || id.length > 256 || ids.has(id)) throw new Error('SSH port forward id is invalid');
    if (!name) throw new Error('SSH port forward name is required');
    if (
      !Number.isInteger(forward.localPort) ||
      forward.localPort < 1 ||
      forward.localPort > 65535
    ) {
      throw new Error('SSH port forward local port must be between 1 and 65535');
    }
    if (
      !Number.isInteger(forward.remotePort) ||
      forward.remotePort < 1 ||
      forward.remotePort > 65535
    ) {
      throw new Error('SSH port forward remote port must be between 1 and 65535');
    }
    const direction = forward.direction ?? 'local-to-remote';
    if (direction !== 'local-to-remote' && direction !== 'remote-to-local') {
      throw new Error('SSH port forward direction is invalid');
    }
    if (direction === 'local-to-remote' && forward.remotePort === komlaSshRemoteDataPort(hostId)) {
      throw new Error(
        `SSH port forward remote port ${forward.remotePort} is reserved by Komla for this host`
      );
    }
    if (
      forward.enabled &&
      direction === 'local-to-remote' &&
      enabledRemotePorts.has(forward.remotePort)
    ) {
      throw new Error(`SSH port forward remote port ${forward.remotePort} is duplicated`);
    }
    if (
      forward.enabled &&
      direction === 'remote-to-local' &&
      enabledLocalPorts.has(forward.localPort)
    ) {
      throw new Error(`SSH port forward local port ${forward.localPort} is duplicated`);
    }
    ids.add(id);
    if (forward.enabled && direction === 'local-to-remote') {
      enabledRemotePorts.add(forward.remotePort);
    }
    if (forward.enabled && direction === 'remote-to-local') {
      enabledLocalPorts.add(forward.localPort);
    }
    return {
      id,
      name,
      ...(forward.direction ? { direction } : {}),
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      enabled: forward.enabled,
    };
  });
}

function normalizeHost(host: SshHost): SshHost {
  const id = host.id.trim();
  const name = host.name.trim();
  const hostname = host.hostname.trim();
  if (!id || id.length > 256) throw new Error('SSH host id is invalid');
  if (!name) throw new Error('SSH host name is required');
  if (!isValidSshHostname(hostname)) {
    throw new Error('SSH hostname must be a hostname or IP address without user or port');
  }
  if (!isValidSshBasePath(host.basePath)) {
    throw new Error(
      'SSH base path must not resolve to the filesystem root or home directory or contain parent traversal'
    );
  }
  if (
    host.port !== undefined &&
    (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)
  ) {
    throw new Error('SSH port must be between 1 and 65535');
  }
  const portForwards = normalizePortForwards(id, host.portForwards);

  return {
    id,
    name,
    hostname,
    ...(optionalTrimmed(host.user) ? { user: optionalTrimmed(host.user) } : {}),
    ...(host.port !== undefined ? { port: host.port } : {}),
    ...(optionalTrimmed(host.identityFile)
      ? { identityFile: optionalTrimmed(host.identityFile) }
      : {}),
    basePath: normalizeSshBasePath(host.basePath),
    ...(host.forwardAgent ? { forwardAgent: true } : {}),
    ...(host.isolated ? { isolated: true } : {}),
    ...(host.extraSshArgs?.length ? { extraSshArgs: [...host.extraSshArgs] } : {}),
    ...(portForwards.length ? { portForwards } : {}),
    ...(host.setupPending ? { setupPending: true } : {}),
    ...(host.capabilities ? { capabilities: structuredClone(host.capabilities) } : {}),
  };
}

function parseExtraSshArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.length > 0 ? value : undefined;
  }
  logger.warn('ignoring invalid SSH argument data');
  return undefined;
}

function parsePortForwards(hostId: string, value: unknown): SshPortForward[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    const forwards = normalizePortForwards(hostId, value as SshPortForward[]);
    return forwards.length > 0 ? forwards : undefined;
  } catch (error) {
    logger.warn('ignoring invalid SSH port forward data', { error: String(error) });
    return undefined;
  }
}

function parseCapabilities(value: unknown): SshHostCapabilities | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const parsed = value as SshHostCapabilities;
  if (
    typeof parsed.checkedAt === 'string' &&
    (parsed.git?.status === 'available' || parsed.git?.status === 'missing') &&
    (parsed.tmux?.status === 'available' ||
      parsed.tmux?.status === 'missing' ||
      parsed.tmux?.status === 'unusable') &&
    (parsed.localMirror?.platform === 'supported' ||
      parsed.localMirror?.platform === 'unsupported') &&
    (parsed.localMirror?.localRsync === 'available' ||
      parsed.localMirror?.localRsync === 'missing') &&
    (parsed.localMirror?.remoteRsync === 'available' ||
      parsed.localMirror?.remoteRsync === 'missing') &&
    (parsed.monitoring === undefined ||
      ((parsed.monitoring?.status === 'available' || parsed.monitoring?.status === 'missing') &&
        Array.isArray(parsed.monitoring.missingRequirements) &&
        parsed.monitoring.missingRequirements.every(
          (requirement) => typeof requirement === 'string'
        )))
  ) {
    return parsed;
  }
  logger.warn('ignoring invalid SSH capability data');
  return undefined;
}

/**
 * A stored host, as it was saved. Deliberately not normalizeHost: a host saved before a check was
 * added stays listed. Damaged optional fields are dropped, and only a host without its identity
 * and connection details is refused.
 */
function parseStoredHost(value: unknown): SshHost {
  const host = (value ?? {}) as Record<string, unknown>;
  const { id, name, hostname, user, port, identityFile, basePath } = host;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof hostname !== 'string' ||
    typeof basePath !== 'string'
  ) {
    throw new Error('a host is missing its id, name, hostname or base path');
  }
  const extraSshArgs = parseExtraSshArgs(host.extraSshArgs);
  const portForwards = parsePortForwards(id, host.portForwards);
  const capabilities = parseCapabilities(host.capabilities);
  const validPort = Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
  return {
    id,
    name,
    hostname,
    ...(typeof user === 'string' && user ? { user } : {}),
    ...(validPort ? { port: port as number } : {}),
    ...(typeof identityFile === 'string' && identityFile ? { identityFile } : {}),
    basePath,
    ...(host.forwardAgent === true ? { forwardAgent: true } : {}),
    ...(host.isolated === true ? { isolated: true } : {}),
    ...(extraSshArgs ? { extraSshArgs } : {}),
    ...(portForwards ? { portForwards } : {}),
    ...(host.setupPending === true ? { setupPending: true } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

/** Unlike existsSync, throws when the answer is unknown: no access isn't the same as no file. */
function fileExists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}

/**
 * The configured SSH hosts, in `<komla-data-dir>/ssh-hosts.json`. Hostnames and paths to keys
 * aren't secret but are private to the user, so the file is theirs alone. It sits outside
 * `settings/`, whose files are copied into settings history, which anyone can read.
 *
 * Loaded on the first read, so later reads can't fail. A write starts from the file as it is then,
 * as development builds run side by side on one data directory and a list loaded earlier would
 * overwrite what another one saved. A file it can't read is an error rather than an empty list: a
 * save would otherwise replace it, and SSH workspaces would see their host as no longer configured.
 */
export class SshHostService {
  private hosts: SshHost[] | null = null;

  /** Resolved on first use so that importing the service doesn't touch the data directory. */
  constructor(private readonly dataDirectory?: string) {}

  list(): SshHost[] {
    return structuredClone(this.load());
  }

  get(hostId: string): SshHost | undefined {
    const host = this.load().find((candidate) => candidate.id === hostId);
    return host ? structuredClone(host) : undefined;
  }

  has(hostId: string): boolean {
    return this.load().some((host) => host.id === hostId);
  }

  /** Whether the host is configured and has finished setup. */
  isReady(hostId: string): boolean {
    const host = this.get(hostId);
    return Boolean(host && !host.setupPending);
  }

  save(host: SshHost): SshHost {
    const normalized = normalizeHost(host);
    const enabledLocalPorts = new Set(
      normalized.portForwards
        ?.filter((forward) => forward.enabled && forward.direction === 'remote-to-local')
        .map((forward) => forward.localPort) ?? []
    );
    const hosts = this.readStored();
    for (const existingHost of hosts) {
      if (existingHost.id === normalized.id) continue;
      const conflictingForward = existingHost.portForwards?.find(
        (forward) =>
          forward.enabled &&
          forward.direction === 'remote-to-local' &&
          enabledLocalPorts.has(forward.localPort)
      );
      if (conflictingForward) {
        throw new Error(
          `SSH port forward local port ${conflictingForward.localPort} is already used by SSH host ${existingHost.name}`
        );
      }
    }
    const exists = hosts.some((existingHost) => existingHost.id === normalized.id);
    this.persist(
      exists
        ? hosts.map((existingHost) =>
            existingHost.id === normalized.id ? normalized : existingHost
          )
        : [...hosts, normalized]
    );
    return structuredClone(normalized);
  }

  delete(hostId: string): boolean {
    const hosts = this.readStored();
    const remaining = hosts.filter((host) => host.id !== hostId);
    if (remaining.length === hosts.length) return false;
    this.persist(remaining);
    return true;
  }

  private get directory(): string {
    return this.dataDirectory ?? ensureKomlaBasePath();
  }

  private get filePath(): string {
    return join(this.directory, FILE_NAME);
  }

  private load(): SshHost[] {
    this.hosts ??= this.readStored();
    return this.hosts;
  }

  private readStored(): SshHost[] {
    return fileExists(this.filePath) ? this.readFile() : this.moveFromLegacyDatabase();
  }

  private readFile(): SshHost[] {
    const path = this.filePath;
    try {
      chmodSync(path, FILE_MODE);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: unknown;
        hosts?: unknown;
      };
      if (parsed.version !== FILE_VERSION) {
        throw new Error(`unsupported version ${String(parsed.version)}`);
      }
      if (!Array.isArray(parsed.hosts)) throw new Error(`'hosts' is not a list`);
      const hosts = parsed.hosts.map(parseStoredHost);
      if (new Set(hosts.map((host) => host.id)).size !== hosts.length) {
        throw new Error('two hosts have the same id');
      }
      return hosts;
    } catch (error) {
      logger.error('SSH hosts file is unreadable', { error: String(error) });
      throw new Error(`Could not read SSH hosts from ${path}: ${String(error)}`);
    }
  }

  /**
   * Moves the hosts of an install that kept them in komla.db, the first time it runs without it.
   * The hosts file, even with no hosts in it, marks the move as done; until the file is complete
   * there isn't one, so a failure here tries again on the next read. The database stays behind for
   * a build rolled back to the last release that reads it.
   */
  private moveFromLegacyDatabase(): SshHost[] {
    const databasePath = join(this.directory, LEGACY_DATABASE_FILE_NAME);
    if (!fileExists(databasePath)) return [];
    let hosts: SshHost[];
    try {
      hosts = readLegacySshHosts(databasePath).map(parseStoredHost);
    } catch (error) {
      logger.error('could not move SSH hosts out of the legacy database', { error: String(error) });
      throw new Error(`Could not read SSH hosts from ${databasePath}: ${String(error)}`);
    }
    this.persist(hosts);
    logger.info('moved SSH hosts out of the legacy database', { count: hosts.length });
    return hosts;
  }

  private persist(hosts: SshHost[]): void {
    writeFileAtomicSync(
      this.filePath,
      JSON.stringify({ version: FILE_VERSION, hosts }, null, 2),
      FILE_MODE
    );
    this.hosts = hosts;
  }
}

export const sshHostService = new SshHostService();
