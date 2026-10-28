import {
  komlaSshRemoteDataPort,
  isValidSshBasePath,
  isValidSshHostname,
  normalizeSshBasePath,
  type SshHost,
  type SshHostCapabilities,
  type SshPortForward,
} from '../../shared/types';
import { createLogger } from '../lib/logger';

import { databaseService, type DatabaseService } from './database.service';

import type { DatabaseSync } from 'node:sqlite';

const logger = createLogger('SshHostService');

interface SshHostRow {
  id: string;
  name: string;
  hostname: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  base_path: string;
  forward_agent: number;
  isolated: number;
  extra_ssh_args_json: string | null;
  port_forwards_json: string | null;
  setup_pending: number;
  capabilities_json: string | null;
}

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

function parseExtraSshArgs(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed.length > 0 ? parsed : undefined;
    }
  } catch (error) {
    logger.warn('ignoring invalid SSH argument data', { error: String(error) });
  }
  return undefined;
}

function parsePortForwards(hostId: string, value: string | null): SshPortForward[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const forwards = normalizePortForwards(hostId, parsed as SshPortForward[]);
    return forwards.length > 0 ? forwards : undefined;
  } catch (error) {
    logger.warn('ignoring invalid SSH port forward data', { error: String(error) });
    return undefined;
  }
}

function parseCapabilities(value: string | null): SshHostCapabilities | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as SshHostCapabilities;
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
        ((parsed.monitoring.status === 'available' || parsed.monitoring.status === 'missing') &&
          Array.isArray(parsed.monitoring.missingRequirements) &&
          parsed.monitoring.missingRequirements.every(
            (requirement) => typeof requirement === 'string'
          )))
    ) {
      return parsed;
    }
  } catch (error) {
    logger.warn('ignoring invalid SSH capability data', { error: String(error) });
  }
  return undefined;
}

function mapRow(row: SshHostRow): SshHost {
  const extraSshArgs = parseExtraSshArgs(row.extra_ssh_args_json);
  const capabilities = parseCapabilities(row.capabilities_json);
  const portForwards = parsePortForwards(row.id, row.port_forwards_json);
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    ...(row.user ? { user: row.user } : {}),
    ...(row.port !== null ? { port: row.port } : {}),
    ...(row.identity_file ? { identityFile: row.identity_file } : {}),
    basePath: row.base_path,
    ...(row.forward_agent === 1 ? { forwardAgent: true } : {}),
    ...(row.isolated === 1 ? { isolated: true } : {}),
    ...(extraSshArgs ? { extraSshArgs } : {}),
    ...(portForwards ? { portForwards } : {}),
    ...(row.setup_pending === 1 ? { setupPending: true } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

export class SshHostService {
  constructor(private readonly database: Pick<DatabaseService, 'get'> = databaseService) {}

  list(): SshHost[] {
    return (
      this.connection
        .prepare(
          `SELECT id, name, hostname, user, port, identity_file, base_path,
                  forward_agent, isolated, extra_ssh_args_json, port_forwards_json,
                  setup_pending, capabilities_json
             FROM ssh_hosts
         ORDER BY sort_order, rowid`
        )
        .all() as unknown as SshHostRow[]
    ).map(mapRow);
  }

  get(hostId: string): SshHost | undefined {
    const row = this.connection
      .prepare(
        `SELECT id, name, hostname, user, port, identity_file, base_path,
                forward_agent, isolated, extra_ssh_args_json, port_forwards_json,
                setup_pending, capabilities_json
           FROM ssh_hosts
          WHERE id = ?`
      )
      .get(hostId) as unknown as SshHostRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  has(hostId: string): boolean {
    return Boolean(this.connection.prepare('SELECT 1 FROM ssh_hosts WHERE id = ?').get(hostId));
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
    for (const existingHost of this.list()) {
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
    this.connection
      .prepare(
        `INSERT INTO ssh_hosts (
           id, name, hostname, user, port, identity_file, base_path,
           forward_agent, isolated, extra_ssh_args_json, port_forwards_json,
           setup_pending, capabilities_json, sort_order
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT MAX(sort_order) + 1 FROM ssh_hosts), 0)
         )
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           hostname = excluded.hostname,
           user = excluded.user,
           port = excluded.port,
           identity_file = excluded.identity_file,
           base_path = excluded.base_path,
           forward_agent = excluded.forward_agent,
           isolated = excluded.isolated,
           extra_ssh_args_json = excluded.extra_ssh_args_json,
           port_forwards_json = excluded.port_forwards_json,
           setup_pending = excluded.setup_pending,
           capabilities_json = excluded.capabilities_json`
      )
      .run(
        normalized.id,
        normalized.name,
        normalized.hostname,
        normalized.user ?? null,
        normalized.port ?? null,
        normalized.identityFile ?? null,
        normalized.basePath,
        normalized.forwardAgent ? 1 : 0,
        normalized.isolated ? 1 : 0,
        normalized.extraSshArgs ? JSON.stringify(normalized.extraSshArgs) : null,
        normalized.portForwards ? JSON.stringify(normalized.portForwards) : null,
        normalized.setupPending ? 1 : 0,
        normalized.capabilities ? JSON.stringify(normalized.capabilities) : null
      );
    return normalized;
  }

  delete(hostId: string): boolean {
    return this.connection.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(hostId).changes > 0;
  }

  private get connection(): DatabaseSync {
    return this.database.get();
  }
}

export const sshHostService = new SshHostService();
