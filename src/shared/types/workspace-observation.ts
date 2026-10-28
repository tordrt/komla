import type { WorkspaceGitStatusSnapshot } from './workspace';

export type WorkingTreeSnapshot = WorkspaceGitStatusSnapshot['diff'];

/** What a Remote Companion report knows about how an SSH workspace's working tree changed. */
export interface RemoteWorkingTreeChange {
  /** Fingerprint of the files the workspace's file tree lists. */
  fileListHash?: string;
  /** The working-tree paths that changed. Absent when anything may have changed. */
  changedPaths?: readonly string[];
}

export interface BranchStatus {
  currentBranch: string;
  targetBranch: string;
  defaultBranch?: string;
  /** The branch origin/HEAD names, when the repository records one. */
  remoteDefaultBranch?: string;
  aheadTargetBranch: number;
  behindTargetBranch: number;
  hasRemote: boolean;
  hasOriginRemote: boolean;
  unpushedCommits: number;
  behindRemote: number;
  targetBranchHasRemote: boolean;
  targetBranchAheadRemote: number;
  targetBranchBehindRemote: number;
  rebaseInProgress?: boolean;
}

export type WorkspaceObservationConfirmation =
  | { kind: 'current'; confirmedAt: number }
  | { kind: 'stopped'; confirmedAt: number }
  | {
      kind: 'stale';
      staleSince: number;
      lastConfirmedAt?: number;
      reason: 'source-unreachable' | 'snapshot-failed';
    };

export interface WorkspaceObservationProjection {
  workspaceId: string;
  revision: number;
  repositoryRevision: number;
  workingTree: WorkingTreeSnapshot;
  branch: BranchStatus;
  confirmation: WorkspaceObservationConfirmation;
}

export interface RepositorySnapshotObservation {
  kind: 'repository-snapshot';
  workspaceId: string;
  source:
    | {
        kind: 'local-watcher';
        instanceId: string;
        epoch: string;
        sequence: number;
      }
    | {
        kind: 'remote-companion';
        sequence: number;
      };
  observedAt: number;
  stateHash: string;
  workingTreeComplete?: boolean;
  workingTree: WorkingTreeSnapshot;
  branch: BranchStatus;
}

export interface WorkspaceObservationBatch {
  observations: RepositorySnapshotObservation[];
}

export type WorkspaceObservationAcceptance =
  | {
      disposition: 'accepted';
      workspaceId: string;
      stateHash: string;
    }
  | {
      disposition: 'duplicate' | 'superseded';
      workspaceId: string;
      stateHash: string;
    }
  | {
      disposition: 'retry';
      workspaceId: string;
      stateHash: string;
      code: 'temporarily-unavailable' | 'internal-failure';
    };

export interface WorkspaceObservationBatchAcceptance {
  items: WorkspaceObservationAcceptance[];
}

export interface WorkspaceObservationCursor {
  initial: WorkspaceObservationProjection[];
  close(): void;
}
