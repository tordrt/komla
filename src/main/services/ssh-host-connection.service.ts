import { IPC } from '../../shared/constants/ipc-channels';
import { isSshWorkspace } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';

import { configService } from './config.service';
import { managedRemoteTerminalLifecycleService } from './managed-remote-terminal-lifecycle.service';
import { remoteWorkspaceObservationService } from './remote-workspace-observation.service';
import { sshConnectionService } from './ssh-connection.service';
import {
  isSshHostDisconnected,
  loadDisconnectedSshHosts,
  markSshHostDisconnected,
} from './ssh-host-disconnection';
import { sshHostService } from './ssh-host.service';
import { sshPortForwardService } from './ssh-port-forward.service';
import { windowService } from './window.service';
import { workspaceService } from './workspace.service';

import type { SshHost } from '../../shared/types';

const logger = createLogger('SshHostConnectionService');

/**
 * Disconnecting from an SSH host, and connecting again. While disconnected Komla sends the host
 * nothing: its terminals detach, leaving their tmux sessions running, its tunnels and shared
 * connections close, and SSH Workspace Sync, status and fetches leave it alone. It stays
 * disconnected across restarts until the user connects again.
 */
class SshHostConnectionService {
  /**
   * Each host's switch in progress: a connect waits for a disconnect to close the host's tunnels
   * and connections.
   */
  private readonly switching = new Map<string, Promise<void>>();

  /** Reads which hosts the user disconnected from, before anything reaches them. */
  load(): void {
    loadDisconnectedSshHosts(configService.get().disconnectedSshHostIds);
  }

  setConnected(hostId: string, connected: boolean): Promise<void> {
    const previous = this.switching.get(hostId) ?? Promise.resolve();
    const next = previous.then(() => this.switchTo(hostId, connected));
    const settled = next.catch(() => undefined);
    this.switching.set(hostId, settled);
    void settled.then(() => {
      if (this.switching.get(hostId) === settled) this.switching.delete(hostId);
    });
    return next;
  }

  private async switchTo(hostId: string, connected: boolean): Promise<void> {
    const host = sshHostService.get(hostId);
    if (!host) throw new Error(`SSH host ${hostId} not found`);
    if (isSshHostDisconnected(hostId) !== connected) return;
    markSshHostDisconnected(hostId, !connected);
    this.save(hostId, !connected);
    if (connected) this.connect(host);
    else await this.disconnect(host);
  }

  private save(hostId: string, disconnected: boolean): void {
    const others = (configService.get().disconnectedSshHostIds ?? []).filter((id) => id !== hostId);
    const config = configService.update({
      disconnectedSshHostIds: disconnected ? [...others, hostId] : others,
    });
    windowService.broadcastToAll(IPC.CONFIG_CHANGED, config);
  }

  private async disconnect(host: SshHost): Promise<void> {
    const workspaceIds = workspaceService
      .list()
      .filter((workspace) => isSshWorkspace(workspace) && workspace.backend.hostId === host.id)
      .map((workspace) => workspace.id);
    for (const workspaceId of workspaceIds) {
      try {
        managedRemoteTerminalLifecycleService.detach({ workspaceId });
      } catch (error) {
        logger.warn('Could not detach the terminals of a workspace on a disconnected SSH host', {
          hostId: host.id,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Its workspaces are no longer observed. Not awaited: a pass covers every host, and may be
    // waiting on another one; this host's tunnels close below either way.
    void remoteWorkspaceObservationService.reconcile().catch((error: unknown) =>
      logger.warn('Could not stop observing a disconnected SSH host', {
        hostId: host.id,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    await sshPortForwardService.closeHost(host.id);
    await sshConnectionService.closeConnections(host, workspaceIds);
  }

  private connect(host: SshHost): void {
    void sshPortForwardService.reconcileHostPortForwards(host).catch((error: unknown) =>
      logger.warn('Could not start saved SSH port forwards after connecting', {
        hostId: host.id,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    void remoteWorkspaceObservationService.reconcile();
    // Catches up on what other installations changed meanwhile, and publishes what changed here.
    void workspaceService.sshSync.syncSoon(host.id, { now: true });
    void sshConnectionService.checkHost(host);
  }
}

export const sshHostConnectionService = new SshHostConnectionService();
