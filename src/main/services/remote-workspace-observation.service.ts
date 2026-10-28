import { posix as pathPosix } from 'path';

import { isMonitored } from '../../shared/lib/terminal-execution-state';
import { komlaSshRemoteDataPort, type SshHost } from '../../shared/types/ssh';
import {
  isSshWorkspace,
  type SshWorkspaceBackend,
  type Workspace,
} from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';

import type {
  RemoteCompanionRuntime,
  StartRemoteCompanionOptions,
} from './remote-companion.service';

const logger = createLogger('RemoteWorkspaceObservationService');
const REMOTE_COMPANION_RETRY_INTERVAL_MS = 10_000;

export interface RemoteWorkspaceObservationDependencies {
  listWorkspaces: () => readonly Workspace[];
  waitForKomlaPort: () => Promise<number>;
  ensureKomlaDataTunnel: (
    hostId: string,
    localPort: number,
    onConnected: () => void
  ) => Promise<void>;
  stopKomlaDataTunnelsExcept: (activeHostIds: ReadonlySet<string>) => void;
  getHost: (hostId: string) => SshHost;
  ensureRemoteNotificationScript: (backend: SshWorkspaceBackend) => Promise<void>;
  ensureRemoteCompanion: (
    host: SshHost,
    options: StartRemoteCompanionOptions
  ) => Promise<RemoteCompanionRuntime | undefined>;
  invalidateRemoteCompanion: (hostId: string) => void;
  companionInstallationId: (hostId: string) => string;
  resolveCompanionRuntime: (
    remoteBasePath: string,
    installationId: string
  ) => RemoteCompanionRuntime;
  markRemoteDisconnected: (workspaceIds: string[]) => Promise<unknown>;
  refreshWorkspaceStatus: (workspaceId: string, reason?: 'reconnected') => Promise<unknown>;
  isWorkspaceDeleting: (workspaceId: string) => boolean;
  /** Called when a host's data tunnel connects, once per lifecycle connection. */
  hostConnected?: (hostId: string) => void;
}

interface HostSnapshotRefresh {
  lifecycleToken: symbol;
  pending: Set<string>;
  running: boolean;
  retryDelayMs: number;
  retryTimer?: NodeJS.Timeout;
}

export class RemoteWorkspaceObservationService {
  private readonly companionRuntimes = new Map<string, RemoteCompanionRuntime>();
  private readonly companionRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly snapshotRefreshes = new Map<string, HostSnapshotRefresh>();
  private reconcileRequested = false;
  private waitForTunnelRequested = false;
  private readonly hostLifecycleTokens = new Map<string, symbol>();
  private readonly pendingDisconnectedWorkspaceIdsByHost = new Map<string, Set<string>>();
  private activeReconciliation: Promise<void> | undefined;

  constructor(private readonly dependencies: RemoteWorkspaceObservationDependencies) {}

  /**
   * Converge host observation resources on the latest workspace state after the current tunnel and
   * companion preparation attempts settle.
   */
  reconcile(): Promise<void> {
    return this.requestReconciliation(true);
  }

  /**
   * Reconcile after restoring a Terminal Attachment without waiting for its data tunnel. Companion
   * preparation proceeds independently; a connected data tunnel triggers fresh status snapshots.
   */
  reconcileAfterReconnect(): Promise<void> {
    return this.requestReconciliation(false);
  }

  private requestReconciliation(waitForTunnel: boolean): Promise<void> {
    this.syncKomlaDataTunnels();
    this.reconcileRequested = true;
    this.waitForTunnelRequested ||= waitForTunnel;
    if (!this.activeReconciliation) {
      const reconciliation = this.reconcileUntilCurrent();
      this.activeReconciliation = reconciliation;
      const clearActive = (): void => {
        if (this.activeReconciliation === reconciliation) this.activeReconciliation = undefined;
      };
      void reconciliation.then(clearActive, clearActive);
    }
    return this.activeReconciliation;
  }

  companionForHost(hostId: string): RemoteCompanionRuntime | undefined {
    return this.companionRuntimes.get(hostId);
  }

  companionForWorkspace(backend: SshWorkspaceBackend): RemoteCompanionRuntime {
    return (
      this.companionRuntimes.get(backend.hostId) ??
      this.dependencies.resolveCompanionRuntime(
        pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot)),
        this.dependencies.companionInstallationId(backend.hostId)
      )
    );
  }

  private async reconcileUntilCurrent(): Promise<void> {
    do {
      this.reconcileRequested = false;
      const waitForTunnel = this.waitForTunnelRequested;
      this.waitForTunnelRequested = false;
      await this.reconcileOnce(waitForTunnel);
    } while (this.reconcileRequested);
  }

  private async reconcileOnce(waitForTunnel: boolean): Promise<void> {
    const sshWorkspaces = this.dependencies.listWorkspaces().filter(isSshWorkspace);
    const monitoredByHost = new Map<string, Workspace[]>();
    for (const workspace of sshWorkspaces) {
      if (!isMonitored(workspace)) continue;
      const monitored = monitoredByHost.get(workspace.backend.hostId) ?? [];
      monitored.push(workspace);
      monitoredByHost.set(workspace.backend.hostId, monitored);
    }

    const activeHostIds = new Set(monitoredByHost.keys());
    for (const hostId of activeHostIds) {
      if (!this.hostLifecycleTokens.has(hostId)) {
        this.hostLifecycleTokens.set(hostId, Symbol(hostId));
      }
    }

    const operations: Promise<void>[] = [];
    for (const [hostId, workspaceIds] of this.pendingDisconnectedWorkspaceIdsByHost) {
      this.pendingDisconnectedWorkspaceIdsByHost.delete(hostId);
      operations.push(this.markRemoteDisconnected(hostId, Array.from(workspaceIds)));
    }
    for (const [hostId, workspaces] of monitoredByHost) {
      operations.push(this.ensureHostObservation(hostId, workspaces, waitForTunnel));
    }
    await Promise.all(operations);
  }

  private syncKomlaDataTunnels(): void {
    const sshWorkspaces = this.dependencies.listWorkspaces().filter(isSshWorkspace);
    const activeHostIds = new Set(
      sshWorkspaces.filter(isMonitored).map((workspace) => workspace.backend.hostId)
    );
    const trackedHostIds = new Set([
      ...this.hostLifecycleTokens.keys(),
      ...this.companionRuntimes.keys(),
      ...this.companionRetryTimers.keys(),
    ]);
    for (const hostId of trackedHostIds) {
      if (activeHostIds.has(hostId)) continue;
      this.retireHostLifecycle(
        hostId,
        sshWorkspaces
          .filter((workspace) => workspace.backend.hostId === hostId)
          .map((workspace) => workspace.id)
      );
    }
    this.dependencies.stopKomlaDataTunnelsExcept(activeHostIds);
  }

  private retireHostLifecycle(hostId: string, workspaceIds: string[]): void {
    this.hostLifecycleTokens.delete(hostId);
    const refresh = this.snapshotRefreshes.get(hostId);
    if (refresh?.retryTimer) clearTimeout(refresh.retryTimer);
    this.snapshotRefreshes.delete(hostId);
    if (this.companionRuntimes.delete(hostId)) {
      this.dependencies.invalidateRemoteCompanion(hostId);
    }
    const retryTimer = this.companionRetryTimers.get(hostId);
    if (retryTimer) clearTimeout(retryTimer);
    this.companionRetryTimers.delete(hostId);
    if (workspaceIds.length > 0) {
      this.pendingDisconnectedWorkspaceIdsByHost.set(hostId, new Set(workspaceIds));
    }
  }

  private async ensureHostObservation(
    hostId: string,
    workspaces: Workspace[],
    waitForTunnel: boolean
  ): Promise<void> {
    const representative = workspaces[0];
    if (!representative || !isSshWorkspace(representative)) return;
    const lifecycleToken = this.hostLifecycleTokens.get(hostId);
    if (!lifecycleToken) return;

    const companion = this.ensureRemoteCompanionBestEffort(hostId, representative, workspaces);
    const tunnel = this.ensureKomlaDataTunnelBestEffort(
      hostId,
      representative.id,
      lifecycleToken,
      companion
    );
    await (waitForTunnel ? Promise.all([tunnel, companion]) : companion);
  }

  private async ensureKomlaDataTunnelBestEffort(
    hostId: string,
    workspaceId: string,
    lifecycleToken: symbol,
    companion: Promise<void>
  ): Promise<void> {
    try {
      const localPort = await this.dependencies.waitForKomlaPort();
      if (this.hostLifecycleTokens.get(hostId) !== lifecycleToken) return;
      await this.dependencies.ensureKomlaDataTunnel(hostId, localPort, () => {
        // Installation can still be in progress when the tunnel connects. Keep recovery off the
        // terminal reconnect path, and refresh even when the remote companion was already running.
        void companion.then(() => this.requestSnapshotRefresh(hostId, lifecycleToken));
      });
    } catch (error) {
      logger.warn('SSH terminal will continue without Komla data integrations', {
        workspaceId,
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestSnapshotRefresh(hostId: string, lifecycleToken: symbol): void {
    if (this.hostLifecycleTokens.get(hostId) !== lifecycleToken) return;
    this.dependencies.hostConnected?.(hostId);
    let refresh = this.snapshotRefreshes.get(hostId);
    if (!refresh) {
      refresh = {
        lifecycleToken,
        pending: new Set(),
        running: false,
        retryDelayMs: REMOTE_COMPANION_RETRY_INTERVAL_MS,
      };
      this.snapshotRefreshes.set(hostId, refresh);
    }
    if (refresh.retryTimer) clearTimeout(refresh.retryTimer);
    refresh.retryTimer = undefined;
    refresh.retryDelayMs = REMOTE_COMPANION_RETRY_INTERVAL_MS;
    for (const workspace of this.dependencies.listWorkspaces()) {
      if (this.isSnapshotRefreshEligible(workspace, hostId)) refresh.pending.add(workspace.id);
    }
    void this.refreshPendingSnapshots(hostId, refresh);
  }

  private isSnapshotRefreshEligible(workspace: Workspace, hostId: string): boolean {
    return (
      isSshWorkspace(workspace) &&
      workspace.backend.hostId === hostId &&
      isMonitored(workspace) &&
      !this.dependencies.isWorkspaceDeleting(workspace.id)
    );
  }

  private async refreshPendingSnapshots(
    hostId: string,
    refresh: HostSnapshotRefresh
  ): Promise<void> {
    if (refresh.running) return;
    refresh.running = true;
    const failed = new Set<string>();
    // One SSH scan per host at a time. A connection arriving during a scan queues another pass.
    while (refresh.pending.size > 0) {
      if (this.hostLifecycleTokens.get(hostId) !== refresh.lifecycleToken) return;
      const workspaceId = refresh.pending.values().next().value!;
      refresh.pending.delete(workspaceId);
      const workspace = this.dependencies.listWorkspaces().find((item) => item.id === workspaceId);
      if (!workspace || !this.isSnapshotRefreshEligible(workspace, hostId)) continue;
      // Without a running companion, nothing else reports files changed while disconnected.
      const reason = this.companionRuntimes.has(hostId) ? 'reconnected' : undefined;
      try {
        await this.dependencies.refreshWorkspaceStatus(workspaceId, reason);
        failed.delete(workspaceId);
      } catch (error) {
        failed.add(workspaceId);
        logger.warn('Could not refresh SSH workspace status after connection', {
          hostId,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    refresh.running = false;
    if (this.hostLifecycleTokens.get(hostId) !== refresh.lifecycleToken) return;
    for (const workspaceId of failed) refresh.pending.add(workspaceId);
    if (refresh.pending.size === 0) return;
    refresh.retryTimer = setTimeout(() => {
      refresh.retryTimer = undefined;
      void this.refreshPendingSnapshots(hostId, refresh);
    }, refresh.retryDelayMs);
    refresh.retryDelayMs = Math.min(refresh.retryDelayMs * 2, 60_000);
    refresh.retryTimer.unref?.();
  }

  private async ensureRemoteCompanionBestEffort(
    hostId: string,
    representative: Workspace & { backend: SshWorkspaceBackend },
    workspaces: Workspace[]
  ): Promise<void> {
    const existingRuntime = this.companionRuntimes.get(hostId);
    const releaseAuthority = async (): Promise<void> => {
      if (existingRuntime) return;
      this.companionRuntimes.delete(hostId);
      await this.markRemoteDisconnected(
        hostId,
        workspaces.map((workspace) => workspace.id)
      );
    };

    try {
      const host = this.dependencies.getHost(hostId);
      const remoteBasePath = pathPosix.dirname(
        pathPosix.dirname(representative.backend.remoteProjectRoot)
      );
      const monitored = workspaces.map((workspace) => {
        if (!isSshWorkspace(workspace)) throw new Error('Expected SSH workspace');
        return {
          workspaceId: workspace.id,
          workingTree: workspace.backend.remoteDirectory,
          targetBranch: workspace.baseBranch || workspace.backend.baseBranch || 'main',
        };
      });
      await this.dependencies.ensureRemoteNotificationScript(representative.backend);
      const runtime = await this.dependencies.ensureRemoteCompanion(host, {
        remoteBasePath,
        endpoint: `http://127.0.0.1:${komlaSshRemoteDataPort(hostId)}/api/v1/ssh-workspace-status`,
        installationId: this.dependencies.companionInstallationId(hostId),
        workspaces: monitored,
      });
      if (!runtime) {
        await releaseAuthority();
        this.scheduleCompanionRetry(hostId);
        return;
      }
      const stillMonitored = this.dependencies
        .listWorkspaces()
        .some(
          (workspace) =>
            isSshWorkspace(workspace) &&
            workspace.backend.hostId === hostId &&
            isMonitored(workspace)
        );
      if (!stillMonitored) {
        this.dependencies.invalidateRemoteCompanion(hostId);
        return;
      }
      const retryTimer = this.companionRetryTimers.get(hostId);
      if (retryTimer) clearTimeout(retryTimer);
      this.companionRetryTimers.delete(hostId);
      this.companionRuntimes.set(hostId, runtime);
    } catch (error) {
      await releaseAuthority();
      this.scheduleCompanionRetry(hostId);
      logger.warn('Remote Companion unavailable; SSH status remains stale until it reconnects', {
        workspaceId: representative.id,
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleCompanionRetry(hostId: string): void {
    if (this.companionRetryTimers.has(hostId)) return;
    if (!this.hasRetryEligibleWorkspace(hostId)) return;
    const timer = setTimeout(() => {
      this.companionRetryTimers.delete(hostId);
      if (!this.hasRetryEligibleWorkspace(hostId)) return;
      void this.reconcile().catch((error) => {
        logger.error('Remote Workspace Observation reconciliation failed', {
          hostId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, REMOTE_COMPANION_RETRY_INTERVAL_MS);
    timer.unref?.();
    this.companionRetryTimers.set(hostId, timer);
  }

  private hasRetryEligibleWorkspace(hostId: string): boolean {
    return this.dependencies
      .listWorkspaces()
      .some(
        (workspace) =>
          isSshWorkspace(workspace) &&
          workspace.backend.hostId === hostId &&
          !this.dependencies.isWorkspaceDeleting(workspace.id) &&
          isMonitored(workspace)
      );
  }

  private async markRemoteDisconnected(hostId: string, workspaceIds: string[]): Promise<void> {
    try {
      await this.dependencies.markRemoteDisconnected(workspaceIds);
    } catch (error) {
      logger.warn('Could not persist Stale Workspace Status', {
        hostId,
        workspaceIds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const unconfiguredDependencies: RemoteWorkspaceObservationDependencies = {
  listWorkspaces: () => [],
  waitForKomlaPort: () =>
    Promise.reject(new Error('Remote Workspace Observation is not configured')),
  ensureKomlaDataTunnel: () => Promise.resolve(),
  stopKomlaDataTunnelsExcept: () => undefined,
  getHost: () => {
    throw new Error('Remote Workspace Observation is not configured');
  },
  ensureRemoteNotificationScript: () => Promise.resolve(),
  ensureRemoteCompanion: () => Promise.resolve(undefined),
  invalidateRemoteCompanion: () => undefined,
  companionInstallationId: () => '',
  resolveCompanionRuntime: () => {
    throw new Error('Remote Workspace Observation is not configured');
  },
  markRemoteDisconnected: () => Promise.resolve(),
  refreshWorkspaceStatus: () => Promise.resolve(),
  isWorkspaceDeleting: () => false,
};

export const remoteWorkspaceObservationService = new RemoteWorkspaceObservationService(
  unconfiguredDependencies
);

export function configureRemoteWorkspaceObservation(
  dependencies: RemoteWorkspaceObservationDependencies
): void {
  Object.assign(unconfiguredDependencies, dependencies);
  logger.debug('Configured Remote Workspace Observation adapters');
}
