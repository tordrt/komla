import { createHash } from 'crypto';

import { toGitBranchQuickStatus } from '../../shared/lib/workspace-branch-status';
import { isSshWorkspace } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';

import { parsePorcelainZ } from './ssh-git-status';

import type { GitBranchQuickStatus } from './git.service';
import type { SshWorkspaceGitSnapshot } from './workspace-git/ssh-git';
import type {
  BranchStatus,
  RemoteWorkingTreeChange,
  SshWorkspaceBackend,
  Workspace,
  WorkspaceObservationAcceptance,
  WorkspaceObservationCursor,
  WorkspaceObservationProjection,
  WorkingTreeSnapshot,
} from '../../shared/types';

const logger = createLogger('WorkspaceStatusService');

export interface RemoteCompanionWorkspaceStatusSnapshot {
  source: { kind: 'remote-companion'; sequence: number };
  workspaceId: string;
  hostId?: string;
  cwd: string;
  observedAt: number;
  stateHash: string;
  statusB64?: string;
  numstatB64?: string;
  statusTooLarge?: boolean;
  workingTreeChanged?: boolean;
  fileListHash?: string;
  changedPaths?: readonly string[];
  branch: Partial<BranchStatus>;
}

export interface LocalWorkspaceStatusSnapshot {
  source: {
    kind: 'local-watcher';
    instanceId: string;
    epoch: string;
    sequence: number;
  };
  workspaceId: string;
  observedAt: number;
  workingTree: WorkingTreeSnapshot;
  branch: GitBranchQuickStatus;
}

export type WorkspaceStatusChange =
  | {
      kind: 'snapshot-observed';
      snapshot: RemoteCompanionWorkspaceStatusSnapshot | LocalWorkspaceStatusSnapshot;
    }
  | { kind: 'restore' }
  | { kind: 'remote-source-unreachable'; workspaceIds: readonly string[] }
  | {
      kind: 'refresh-requested';
      workspaceId: string;
      /** `fetched`: origin's refs moved, so the local copy syncs only if files changed too. */
      reason?: 'reconnected' | 'fetched';
    }
  | { kind: 'repository-mutated'; workspaceId: string }
  | { kind: 'workspace-removed'; workspaceId: string };

export type WorkspaceStatusReceipt =
  | WorkspaceObservationAcceptance
  | {
      disposition: 'applied';
      change:
        | 'restored'
        | 'remote-source-unreachable'
        | 'refresh-requested'
        | 'repository-mutated'
        | 'workspace-removed';
      workspaceIds: readonly string[];
    }
  | {
      disposition: 'rejected';
      workspaceId: string;
      code: 'workspace-not-found' | 'target-mismatch';
    };

export interface WorkspaceStatusServiceDependencies {
  getWorkspace(workspaceId: string): Workspace | undefined;
  listWorkspaces(): readonly Workspace[];
  saveWorkspaces(): void | Promise<void>;
  broadcastWorkspaceUpdate(workspace: Workspace): void;
  publishWorkingTreeChange(
    workspaceId: string,
    changeTypes: readonly ('file' | 'git-head' | 'git-branch')[],
    activityAt: number,
    remoteChange: RemoteWorkingTreeChange | undefined
  ): void;
  requestLocalCopySync(workspaceId: string): void;
  isLocalCopyCurrent(workspaceId: string): boolean;
  getSshSnapshot(
    backend: SshWorkspaceBackend,
    targetBranch: string
  ): Promise<SshWorkspaceGitSnapshot>;
  restartLocalWatcher(workspaceId: string, workingDirectory: string): Promise<void>;
  now(): number;
}

type WorkspaceStatusSource =
  | RemoteCompanionWorkspaceStatusSnapshot['source']
  | LocalWorkspaceStatusSnapshot['source'];

interface StoredObservation {
  source: WorkspaceStatusSource;
  stateHash: string;
}

interface WorkspaceOperationQueue {
  readonly waiters: Array<() => void>;
}

function isRemoteCompanionSnapshot(
  snapshot: RemoteCompanionWorkspaceStatusSnapshot | LocalWorkspaceStatusSnapshot
): snapshot is RemoteCompanionWorkspaceStatusSnapshot {
  return snapshot.source.kind === 'remote-companion';
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function snapshotConfirmation(
  complete: boolean,
  observedAt: number,
  previous: WorkspaceObservationProjection['confirmation'] | undefined,
  cachedConfirmedAt?: number
): WorkspaceObservationProjection['confirmation'] {
  if (complete) return { kind: 'current', confirmedAt: observedAt };
  const lastConfirmedAt = previous
    ? previous.kind === 'stale'
      ? previous.lastConfirmedAt
      : previous.confirmedAt
    : cachedConfirmedAt;
  return {
    kind: 'stale',
    staleSince: observedAt,
    ...(lastConfirmedAt === undefined ? {} : { lastConfirmedAt }),
    reason: 'snapshot-failed',
  };
}

function summarizeWorkingTree(files: WorkingTreeSnapshot['files']): WorkingTreeSnapshot['summary'] {
  return files.reduce(
    (summary, file) => ({
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
      filesChanged: summary.filesChanged + 1,
    }),
    { additions: 0, deletions: 0, filesChanged: 0 }
  );
}

function activityFingerprint(workingTree: WorkingTreeSnapshot): string {
  return workingTree.files
    .map((file) => `${file.status}:${file.staged}:${file.path}:${file.additions}:${file.deletions}`)
    .join('\n');
}

// Remote Companions that predate these fields leave them out, so anything may have changed.
function remoteWorkingTreeChange(
  snapshot: RemoteCompanionWorkspaceStatusSnapshot | LocalWorkspaceStatusSnapshot
): RemoteWorkingTreeChange | undefined {
  if (!('stateHash' in snapshot)) return undefined;
  const { fileListHash, changedPaths } = snapshot;
  return fileListHash || changedPaths ? { fileListHash, changedPaths } : undefined;
}

// A snapshot without the flag, such as a local watcher's, counts as a file change.
function reportsWorkingTreeChange(
  snapshot: RemoteCompanionWorkspaceStatusSnapshot | LocalWorkspaceStatusSnapshot
): boolean {
  return !('workingTreeChanged' in snapshot) || snapshot.workingTreeChanged !== false;
}

function createImmutableProjection(
  projection: WorkspaceObservationProjection
): WorkspaceObservationProjection {
  const files = projection.workingTree.files.map((file) => Object.freeze({ ...file }));
  Object.freeze(files);
  const workingTree = {
    files,
    summary: Object.freeze({ ...projection.workingTree.summary }),
  };
  Object.freeze(workingTree);
  return Object.freeze({
    ...projection,
    workingTree,
    branch: Object.freeze({ ...projection.branch }),
    confirmation: Object.freeze({ ...projection.confirmation }),
  });
}

export class WorkspaceStatusService {
  // Remote scan start times, never desktop wall-clock time. Keep these across disconnects.
  private readonly remoteObservationFloors = new Map<string, number>();
  private readonly observations = new Map<string, StoredObservation>();
  private readonly projections = new Map<string, WorkspaceObservationProjection>();
  private readonly completeWorkingTrees = new Map<string, WorkingTreeSnapshot>();
  private readonly listeners = new Set<(projection: WorkspaceObservationProjection) => void>();
  private readonly workspaceOperationQueues = new Map<string, WorkspaceOperationQueue>();
  // Reconnect refreshes that skipped the local copy sync. A snapshot such a refresh
  // supersedes may be the only signal for files changed while disconnected.
  private readonly skippedReconnectSyncs = new Set<string>();
  private nextRevision = 1;

  constructor(private readonly dependencies: WorkspaceStatusServiceDependencies) {}

  async change(change: WorkspaceStatusChange): Promise<WorkspaceStatusReceipt> {
    if (change.kind === 'restore') return this.restore();
    if (change.kind === 'remote-source-unreachable') {
      await Promise.all(
        change.workspaceIds.map((workspaceId) =>
          this.runWorkspaceOperation(workspaceId, () =>
            this.markRemoteSourceUnreachable(workspaceId)
          )
        )
      );
      return {
        disposition: 'applied',
        change: change.kind,
        workspaceIds: change.workspaceIds,
      };
    }
    if (change.kind === 'refresh-requested') {
      const workspace = this.dependencies.getWorkspace(change.workspaceId);
      if (!workspace) throw new Error(`Workspace ${change.workspaceId} not found`);
      if (isSshWorkspace(workspace)) {
        await this.runWorkspaceOperation(change.workspaceId, () =>
          this.refresh(change.workspaceId, change.reason)
        );
      } else {
        // Restart publishes through change(), which acquires the workspace queue itself.
        await this.dependencies.restartLocalWatcher(workspace.id, workspace.workingDirectory);
      }
      return {
        disposition: 'applied',
        change: change.kind,
        workspaceIds: [change.workspaceId],
      };
    }
    if (change.kind === 'repository-mutated' || change.kind === 'workspace-removed') {
      await this.runWorkspaceOperation(change.workspaceId, async () => {
        this.completeWorkingTrees.delete(change.workspaceId);
        if (change.kind === 'workspace-removed') {
          this.remoteObservationFloors.delete(change.workspaceId);
          this.observations.delete(change.workspaceId);
          this.projections.delete(change.workspaceId);
          this.skippedReconnectSyncs.delete(change.workspaceId);
          return;
        }
      });
      return {
        disposition: 'applied',
        change: change.kind,
        workspaceIds: [change.workspaceId],
      };
    }
    return this.runWorkspaceOperation(change.snapshot.workspaceId, () =>
      this.applySnapshot(change.snapshot)
    );
  }

  private async refresh(workspaceId: string, reason?: 'reconnected' | 'fetched'): Promise<void> {
    const workspace = this.dependencies.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    if (!isSshWorkspace(workspace)) {
      await this.dependencies.restartLocalWatcher(workspace.id, workspace.workingDirectory);
      return;
    }

    const retainedWorkingTree =
      this.completeWorkingTrees.get(workspace.id) ?? workspace.lastKnownGitStatus?.diff;
    this.completeWorkingTrees.delete(workspace.id);
    let snapshot: SshWorkspaceGitSnapshot;
    try {
      snapshot = await this.dependencies.getSshSnapshot(
        workspace.backend,
        workspace.baseBranch || workspace.backend.baseBranch || 'main'
      );
    } catch (error) {
      await this.markRemoteSourceUnreachable(workspaceId);
      throw error;
    }
    if (snapshot.observedAt !== undefined) {
      this.remoteObservationFloors.set(workspaceId, snapshot.observedAt);
    }
    const files = snapshot.statusTooLarge
      ? (retainedWorkingTree?.files ?? [])
      : parsePorcelainZ(snapshot.statusText, snapshot.numstatText);
    const workingTree = snapshot.statusTooLarge
      ? (retainedWorkingTree ?? { files, summary: summarizeWorkingTree(files) })
      : { files, summary: summarizeWorkingTree(files) };

    const previousProjection = this.projections.get(workspace.id);
    const confirmedAt = this.dependencies.now();
    const projection = createImmutableProjection({
      workspaceId: workspace.id,
      revision: this.nextRevision++,
      repositoryRevision: (previousProjection?.repositoryRevision ?? 0) + 1,
      workingTree,
      branch: this.toBranchStatus(snapshot.branch),
      confirmation: snapshotConfirmation(
        !snapshot.statusTooLarge,
        confirmedAt,
        previousProjection?.confirmation,
        workspace.lastKnownGitStatus?.lastConfirmedAt ?? undefined
      ),
    });
    // Remote Companion snapshots carry file changes made while disconnected, so a
    // reconnect refresh syncs only a local copy that is not already current. A fetch
    // changes no files, so its refresh syncs only for changes it happened to find.
    const previousWorkingTree = workspace.lastKnownGitStatus?.diff;
    const syncLocalCopy =
      reason === 'fetched'
        ? !previousWorkingTree ||
          activityFingerprint(previousWorkingTree) !== activityFingerprint(workingTree)
        : reason !== 'reconnected' || !this.dependencies.isLocalCopyCurrent(workspace.id);
    if (process.env.KOMLA_DIAGNOSTICS === '1' && reason === 'reconnected') {
      logger.info('SSH reconnect refresh local copy sync decision', {
        workspaceId: workspace.id,
        syncLocalCopy,
      });
    }
    await this.applySshProjection(workspace, projection, syncLocalCopy);
    if (syncLocalCopy) {
      this.skippedReconnectSyncs.delete(workspace.id);
    } else if (reason === 'reconnected') {
      this.skippedReconnectSyncs.add(workspace.id);
    }
    if (!snapshot.statusTooLarge) {
      this.completeWorkingTrees.set(workspace.id, projection.workingTree);
    }
    const observation = this.observations.get(workspace.id);
    if (observation?.source.kind === 'remote-companion') {
      this.observations.delete(workspace.id);
    }
    this.projections.set(workspace.id, projection);
    this.notifyListeners(projection);
  }

  private async markRemoteSourceUnreachable(workspaceId: string): Promise<void> {
    const observation = this.observations.get(workspaceId);
    if (observation?.source.kind === 'remote-companion') {
      this.observations.delete(workspaceId);
    }
    const projection = this.projections.get(workspaceId);
    if (!projection || projection.confirmation.kind === 'stale') return;
    const stale = createImmutableProjection({
      ...projection,
      revision: this.nextRevision++,
      confirmation: {
        kind: 'stale',
        staleSince: this.dependencies.now(),
        lastConfirmedAt: projection.confirmation.confirmedAt,
        reason: 'source-unreachable',
      },
    });
    this.projections.set(workspaceId, stale);
    this.notifyListeners(stale);
  }

  private restore(): WorkspaceStatusReceipt {
    const restoredWorkspaceIds: string[] = [];
    const staleSince = this.dependencies.now();
    for (const workspace of this.dependencies.listWorkspaces()) {
      const status = workspace.lastKnownGitStatus;
      if (!status || !isSshWorkspace(workspace)) continue;
      const lastConfirmedAt = status.lastConfirmedAt ?? undefined;
      this.projections.set(
        workspace.id,
        createImmutableProjection({
          workspaceId: workspace.id,
          revision: this.nextRevision++,
          repositoryRevision: 0,
          workingTree: status.diff,
          branch: this.toBranchStatus(status.branch),
          confirmation: {
            kind: 'stale',
            staleSince,
            ...(lastConfirmedAt === undefined ? {} : { lastConfirmedAt }),
            reason: 'source-unreachable',
          },
        })
      );
      restoredWorkspaceIds.push(workspace.id);
    }
    return { disposition: 'applied', change: 'restored', workspaceIds: restoredWorkspaceIds };
  }

  private async applySnapshot(
    snapshot: RemoteCompanionWorkspaceStatusSnapshot | LocalWorkspaceStatusSnapshot
  ): Promise<WorkspaceStatusReceipt> {
    const workspace = this.dependencies.getWorkspace(snapshot.workspaceId);
    if (!workspace) {
      return {
        disposition: 'rejected',
        workspaceId: snapshot.workspaceId,
        code: 'workspace-not-found',
      };
    }
    if (
      isRemoteCompanionSnapshot(snapshot) &&
      (!isSshWorkspace(workspace) ||
        (snapshot.hostId !== undefined && snapshot.hostId !== workspace.backend.hostId) ||
        stripTrailingSlash(snapshot.cwd) !== stripTrailingSlash(workspace.backend.remoteDirectory))
    ) {
      return {
        disposition: 'rejected',
        workspaceId: snapshot.workspaceId,
        code: 'target-mismatch',
      };
    }

    if (isRemoteCompanionSnapshot(snapshot) && 'stateHash' in snapshot) {
      const floor = this.remoteObservationFloors.get(workspace.id);
      if (floor !== undefined && snapshot.observedAt <= floor) {
        const syncLocalCopy =
          this.skippedReconnectSyncs.has(workspace.id) && reportsWorkingTreeChange(snapshot);
        if (process.env.KOMLA_DIAGNOSTICS === '1') {
          logger.info('SSH superseded snapshot local copy sync decision', {
            workspaceId: workspace.id,
            observedAt: snapshot.observedAt,
            stateHash: snapshot.stateHash,
            workingTreeChanged: snapshot.workingTreeChanged,
            syncLocalCopy,
          });
        }
        if (syncLocalCopy) {
          this.skippedReconnectSyncs.delete(workspace.id);
          this.dependencies.requestLocalCopySync(workspace.id);
        }
        return {
          disposition: 'superseded',
          workspaceId: workspace.id,
          stateHash: snapshot.stateHash,
        };
      }
    }

    const stateHash = isRemoteCompanionSnapshot(snapshot)
      ? snapshot.stateHash
      : createHash('sha256')
          .update(JSON.stringify([snapshot.workingTree, snapshot.branch]))
          .digest('hex');
    const ordering = this.compareObservation(
      this.observations.get(snapshot.workspaceId),
      snapshot.source,
      stateHash
    );
    if (ordering !== 'newer') {
      return {
        disposition: ordering,
        workspaceId: snapshot.workspaceId,
        stateHash,
      };
    }

    const normalized = isRemoteCompanionSnapshot(snapshot)
      ? this.normalizeRemoteSnapshot(workspace, snapshot)
      : {
          workingTree: snapshot.workingTree,
          branch: this.toBranchStatus(snapshot.branch),
        };
    const previousProjection = this.projections.get(workspace.id);
    const snapshotComplete =
      !isRemoteCompanionSnapshot(snapshot) || snapshot.statusTooLarge !== true;
    const workingTree = snapshotComplete
      ? normalized.workingTree
      : (previousProjection?.workingTree ?? normalized.workingTree);
    const projection = createImmutableProjection({
      workspaceId: workspace.id,
      revision: this.nextRevision++,
      repositoryRevision: (previousProjection?.repositoryRevision ?? 0) + 1,
      workingTree,
      branch: normalized.branch,
      confirmation: snapshotConfirmation(
        snapshotComplete,
        snapshot.observedAt,
        previousProjection?.confirmation
      ),
    });

    if (isSshWorkspace(workspace)) {
      if (process.env.KOMLA_DIAGNOSTICS === '1') {
        logger.debug('SSH snapshot local copy sync decision', {
          workspaceId: workspace.id,
          source: snapshot.source.kind,
          observedAt: snapshot.observedAt,
          stateHash,
          workingTreeChanged:
            'workingTreeChanged' in snapshot ? snapshot.workingTreeChanged : undefined,
        });
      }
      try {
        await this.applySshProjection(
          workspace,
          projection,
          reportsWorkingTreeChange(snapshot),
          remoteWorkingTreeChange(snapshot)
        );
      } catch (error) {
        logger.error('Could not apply Workspace Status projection', {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          disposition: 'retry',
          workspaceId: workspace.id,
          stateHash,
          code: 'internal-failure',
        };
      }
      // The companion carries undelivered file changes into newer snapshots.
      this.skippedReconnectSyncs.delete(workspace.id);
      if (projection.confirmation.kind === 'current') {
        this.completeWorkingTrees.set(workspace.id, projection.workingTree);
      } else if (
        projection.confirmation.kind === 'stale' &&
        projection.confirmation.reason === 'snapshot-failed'
      ) {
        this.completeWorkingTrees.delete(workspace.id);
      }
    }

    if (snapshot.source.kind === 'remote-companion') {
      // Equal millisecond timestamps still use the companion's duplicate check.
      this.remoteObservationFloors.set(
        workspace.id,
        Math.max(this.remoteObservationFloors.get(workspace.id) ?? -1, snapshot.observedAt - 1)
      );
    }
    this.observations.set(workspace.id, { source: snapshot.source, stateHash });
    this.projections.set(workspace.id, projection);
    this.notifyListeners(projection);
    logger.debug('Accepted Workspace Status snapshot', { workspaceId: workspace.id });
    return {
      disposition: 'accepted',
      workspaceId: workspace.id,
      stateHash,
    };
  }

  read(): readonly WorkspaceObservationProjection[];
  read(workspaceId: string): WorkspaceObservationProjection | undefined;
  read(query: {
    kind: 'working-tree-for-diff';
    workspaceId: string;
  }): WorkingTreeSnapshot | undefined;
  read(
    request?: string | { kind: 'working-tree-for-diff'; workspaceId: string }
  ):
    | readonly WorkspaceObservationProjection[]
    | WorkspaceObservationProjection
    | WorkingTreeSnapshot
    | undefined {
    if (typeof request === 'object') {
      return this.completeWorkingTrees.get(request.workspaceId);
    }
    return request === undefined
      ? Array.from(this.projections.values())
      : this.projections.get(request);
  }

  observe(
    listener: (projection: WorkspaceObservationProjection) => void
  ): WorkspaceObservationCursor {
    this.listeners.add(listener);
    return {
      initial: Array.from(this.projections.values()),
      close: () => this.listeners.delete(listener),
    };
  }

  private notifyListeners(projection: WorkspaceObservationProjection): void {
    for (const listener of this.listeners) {
      try {
        listener(projection);
      } catch (error) {
        logger.warn('Workspace Status listener failed', {
          workspaceId: projection.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private compareObservation(
    current: StoredObservation | undefined,
    candidate: WorkspaceStatusSource,
    stateHash: string
  ): 'newer' | 'duplicate' | 'superseded' {
    if (!current) return 'newer';
    if (candidate.kind === 'remote-companion') {
      return current.source.kind === 'remote-companion' &&
        current.source.sequence === candidate.sequence &&
        current.stateHash === stateHash
        ? 'duplicate'
        : 'newer';
    }
    if (
      current.source.kind !== 'local-watcher' ||
      current.source.instanceId !== candidate.instanceId ||
      current.source.epoch !== candidate.epoch
    ) {
      return 'newer';
    }
    if (candidate.sequence > current.source.sequence) return 'newer';
    if (candidate.sequence === current.source.sequence && current.stateHash === stateHash) {
      return 'duplicate';
    }
    return 'superseded';
  }

  private normalizeRemoteSnapshot(
    workspace: Workspace,
    snapshot: RemoteCompanionWorkspaceStatusSnapshot
  ): { workingTree: WorkingTreeSnapshot; branch: BranchStatus } {
    // applySnapshot rejects companion snapshots for workspaces that aren't on SSH.
    const backend = isSshWorkspace(workspace) ? workspace.backend : undefined;
    const files = parsePorcelainZ(
      Buffer.from(snapshot.statusB64 ?? '', 'base64').toString('utf8'),
      Buffer.from(snapshot.numstatB64 ?? '', 'base64').toString('utf8')
    );
    const targetBranch =
      snapshot.branch.targetBranch || workspace.baseBranch || backend?.baseBranch || 'main';
    return {
      workingTree: { files, summary: summarizeWorkingTree(files) },
      branch: {
        currentBranch: snapshot.branch.currentBranch ?? workspace.branchName ?? '',
        targetBranch,
        defaultBranch: snapshot.branch.defaultBranch ?? backend?.defaultBranch ?? targetBranch,
        aheadTargetBranch: snapshot.branch.aheadTargetBranch ?? 0,
        behindTargetBranch: snapshot.branch.behindTargetBranch ?? 0,
        hasRemote: snapshot.branch.hasRemote ?? false,
        hasOriginRemote:
          snapshot.branch.hasOriginRemote ??
          snapshot.branch.targetBranchHasRemote ??
          snapshot.branch.hasRemote ??
          false,
        unpushedCommits: snapshot.branch.unpushedCommits ?? 0,
        behindRemote: snapshot.branch.behindRemote ?? 0,
        targetBranchHasRemote: snapshot.branch.targetBranchHasRemote ?? false,
        targetBranchAheadRemote: snapshot.branch.targetBranchAheadRemote ?? 0,
        targetBranchBehindRemote: snapshot.branch.targetBranchBehindRemote ?? 0,
      },
    };
  }

  private toBranchStatus(branch: GitBranchQuickStatus): BranchStatus {
    return {
      currentBranch: branch.currentBranch,
      targetBranch: branch.mainBranch,
      defaultBranch: branch.defaultBranch,
      ...(branch.remoteDefaultBranch ? { remoteDefaultBranch: branch.remoteDefaultBranch } : {}),
      aheadTargetBranch: branch.aheadTargetBranch,
      behindTargetBranch: branch.behindTargetBranch,
      hasRemote: branch.hasRemote,
      hasOriginRemote: branch.hasOriginRemote,
      unpushedCommits: branch.unpushedCommits,
      behindRemote: branch.behindRemote,
      targetBranchHasRemote: branch.targetBranchHasRemote,
      targetBranchAheadRemote: branch.targetBranchAheadRemote,
      targetBranchBehindRemote: branch.targetBranchBehindRemote,
      rebaseInProgress: branch.rebaseInProgress,
    };
  }

  private async applySshProjection(
    workspace: Workspace & { backend: SshWorkspaceBackend },
    projection: WorkspaceObservationProjection,
    syncLocalCopy = true,
    remoteChange?: RemoteWorkingTreeChange
  ): Promise<void> {
    const branch = toGitBranchQuickStatus(projection.branch, workspace.backend.defaultBranch);
    const previousWorkingTree = workspace.lastKnownGitStatus?.diff;
    // Match the local watcher's activity comparison. Initial scans establish a baseline;
    // reconnects and status-only refreshes must not make an idle workspace look active.
    if (
      projection.confirmation.kind === 'current' &&
      previousWorkingTree &&
      activityFingerprint(previousWorkingTree) !== activityFingerprint(projection.workingTree)
    ) {
      workspace.lastActivityAt = this.dependencies.now();
    }
    workspace.lastKnownGitStatus = {
      branch,
      diff: projection.workingTree,
      updatedAt:
        projection.confirmation.kind === 'stale'
          ? projection.confirmation.staleSince
          : projection.confirmation.confirmedAt,
      lastConfirmedAt:
        projection.confirmation.kind === 'stale'
          ? (projection.confirmation.lastConfirmedAt ?? null)
          : projection.confirmation.confirmedAt,
    };
    const branchChanged = !!branch.currentBranch && branch.currentBranch !== workspace.branchName;
    if (branchChanged) {
      workspace.branchName = branch.currentBranch;
      workspace.backend.branchName = branch.currentBranch;
    }
    await this.dependencies.saveWorkspaces();
    if (branchChanged) this.dependencies.broadcastWorkspaceUpdate(workspace);
    this.dependencies.publishWorkingTreeChange(
      workspace.id,
      branchChanged ? ['file', 'git-head', 'git-branch'] : ['file'],
      workspace.lastActivityAt,
      // A scan can see a checkout before the Remote Companion sees the files it changed.
      branchChanged && remoteChange ? { fileListHash: remoteChange.fileListHash } : remoteChange
    );
    if (syncLocalCopy) this.dependencies.requestLocalCopySync(workspace.id);
  }

  private async runWorkspaceOperation<A>(
    workspaceId: string,
    operation: () => Promise<A>
  ): Promise<A> {
    let queue = this.workspaceOperationQueues.get(workspaceId);
    if (queue) {
      const { waiters } = queue;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    } else {
      queue = { waiters: [] };
      this.workspaceOperationQueues.set(workspaceId, queue);
    }
    try {
      return await operation();
    } finally {
      const next = queue.waiters.shift();
      if (next) {
        next();
      } else if (this.workspaceOperationQueues.get(workspaceId) === queue) {
        this.workspaceOperationQueues.delete(workspaceId);
      }
    }
  }
}

const workspaceStatusDependencies: WorkspaceStatusServiceDependencies = {
  getWorkspace: () => undefined,
  listWorkspaces: () => [],
  saveWorkspaces: () => undefined,
  broadcastWorkspaceUpdate: () => undefined,
  publishWorkingTreeChange: () => undefined,
  requestLocalCopySync: () => undefined,
  isLocalCopyCurrent: () => false,
  getSshSnapshot: async () => {
    throw new Error('Workspace Status SSH adapter is not configured');
  },
  restartLocalWatcher: async () => undefined,
  now: () => Date.now(),
};

export const workspaceStatusService = new WorkspaceStatusService(workspaceStatusDependencies);

export function configureWorkspaceStatus(dependencies: WorkspaceStatusServiceDependencies): void {
  Object.assign(workspaceStatusDependencies, dependencies);
}
