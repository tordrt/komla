import type { SshHost } from '../../shared/types';

/**
 * The user disconnected from the SSH host: Komla sends it nothing until they connect again, so a
 * command that would have reached it fails with this instead.
 */
export class SshHostDisconnectedError extends Error {
  constructor(host: Pick<SshHost, 'name'>) {
    super(`Disconnected from ${host.name}. Connect to it to use it again.`);
    this.name = 'SshHostDisconnectedError';
  }
}

/**
 * The SSH hosts the user disconnected from, which Komla leaves alone until they connect again.
 * `sshHostConnectionService` saves them in the config and loads them at startup; this module only
 * answers, so the services that reach hosts can ask without depending on the config.
 */
const disconnectedHostIds = new Set<string>();
/** How often the user disconnected from each host, so a command can tell it was cut off by one. */
const disconnects = new Map<string, number>();

export function loadDisconnectedSshHosts(hostIds: readonly string[] | undefined): void {
  disconnectedHostIds.clear();
  for (const hostId of hostIds ?? []) disconnectedHostIds.add(hostId);
}

export function markSshHostDisconnected(hostId: string, disconnected: boolean): void {
  if (disconnected && !disconnectedHostIds.has(hostId)) {
    disconnects.set(hostId, sshHostDisconnects(hostId) + 1);
  }
  if (disconnected) disconnectedHostIds.add(hostId);
  else disconnectedHostIds.delete(hostId);
}

/**
 * How often the user disconnected from the host this session. A command that started at one
 * count and failed at another was cut off by the disconnect, even if the user connected again.
 */
export function sshHostDisconnects(hostId: string): number {
  return disconnects.get(hostId) ?? 0;
}

/** Whether the user disconnected from the host, which Komla then leaves alone. */
export function isSshHostDisconnected(hostId: string): boolean {
  return disconnectedHostIds.has(hostId);
}

/** Throws a SshHostDisconnectedError when the user disconnected from the host. */
export function assertSshHostConnected(host: Pick<SshHost, 'id' | 'name'>): void {
  if (isSshHostDisconnected(host.id)) throw new SshHostDisconnectedError(host);
}
