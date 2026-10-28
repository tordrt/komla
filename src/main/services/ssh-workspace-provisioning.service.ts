import { isSshWorkspace } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';

import { sshWorkspaceService } from './ssh-workspace.service';

import type { CreateWorkspaceParams, SshWorkspaceBackend, Workspace } from '../../shared/types';

const logger = createLogger('SshWorkspaceProvisioningService');
const SSH_BRANCH_ALREADY_EXISTS_CODE = 'SSH_BRANCH_ALREADY_EXISTS';
const SSH_WORKTREE_PATH_CONFLICT_CODE = 'SSH_WORKTREE_PATH_CONFLICT';

export interface SshWorkspaceProvisioningRequest {
  initialBranchName: string;
  params: Pick<CreateWorkspaceParams, 'autoResolveBranchConflicts' | 'useExactBranchName'>;
  branchPrefix: string;
  createPlan: (branchName: string) => ReturnType<typeof sshWorkspaceService.createWorkspacePlan>;
}

export interface SshWorkspaceProvisioningDependencies {
  listWorkspaces(): readonly Workspace[];
  saveWorkspaces(): void;
  persistWorkspaces(): Promise<void>;
  broadcastWorkspaceUpdate(workspace: Workspace): void;
  maxAttempts: number;
  nextBranchName(base: string, prefix: string, attempt: number, exact?: boolean): string;
  workspaceName(branch: string, prefix: string): string;
  branchConflictError(branch: string, workspace: Workspace): Error;
  /** Installs the Remote Companion for workspace setup and returns its executable path. */
  installCompanion(backend: SshWorkspaceBackend): Promise<string>;
  ssh: Pick<
    typeof sshWorkspaceService,
    'ensureWorkspaceReady' | 'withRemoteDirectoryAttempt' | 'deleteWorkspace'
  >;
}

function isSshBranchAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === SSH_BRANCH_ALREADY_EXISTS_CODE
  );
}

function isSshWorktreePathConflictError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === SSH_WORKTREE_PATH_CONFLICT_CODE
  );
}

/**
 * Owns SSH creation retries and automatic recovery. Deferred preparation records verified
 * ownership before its checked save returns; callers then either complete provisioning or
 * recover it. Workspace persistence and Terminal launch remain with their existing owners.
 */
export class SshWorkspaceProvisioningService {
  private readonly preparedSshWorkspaceIds = new Set<string>();

  constructor(private readonly dependencies: SshWorkspaceProvisioningDependencies) {}

  // Setup asks for the companion only when it uses it, and installs it at most once per creation.
  private companionInstaller(
    workspaceId: string,
    backend: SshWorkspaceBackend
  ): () => Promise<string | undefined> {
    const install = async (): Promise<string | undefined> => {
      try {
        return await this.dependencies.installCompanion(backend);
      } catch (error) {
        logger.warn('Preparing SSH workspace without the Remote Companion', { workspaceId, error });
        return undefined;
      }
    };
    let installed: Promise<string | undefined> | undefined;
    return () => (installed ??= install());
  }

  private async prepareSshWorkspace(
    workspace: Workspace,
    companion: () => Promise<string | undefined>
  ): Promise<{ createdBranch: boolean; createdWorktree: boolean }> {
    if (!isSshWorkspace(workspace) || this.preparedSshWorkspaceIds.has(workspace.id)) {
      return { createdBranch: false, createdWorktree: false };
    }

    const originalBackend = workspace.backend;
    for (let attempt = 1; attempt <= this.dependencies.maxAttempts; attempt++) {
      const candidate =
        attempt === 1
          ? originalBackend
          : this.dependencies.ssh.withRemoteDirectoryAttempt(originalBackend, attempt);
      try {
        const result = await this.dependencies.ssh.ensureWorkspaceReady(candidate, companion);
        const resolvedBaseBranch = candidate.baseBranch ? undefined : result?.baseBranch;
        const resolvedDefaultBranch = result?.defaultBranch || resolvedBaseBranch;
        const resolvedBackend =
          resolvedBaseBranch || resolvedDefaultBranch
            ? {
                ...candidate,
                ...(resolvedBaseBranch ? { baseBranch: resolvedBaseBranch } : {}),
                ...(resolvedDefaultBranch ? { defaultBranch: resolvedDefaultBranch } : {}),
              }
            : candidate;
        if (
          resolvedBackend.remoteDirectory !== workspace.backend.remoteDirectory ||
          resolvedBackend.baseBranch !== workspace.backend.baseBranch ||
          resolvedBackend.defaultBranch !== workspace.backend.defaultBranch
        ) {
          workspace.backend = resolvedBackend;
          workspace.workingDirectory = `ssh://${resolvedBackend.hostId}${resolvedBackend.remoteDirectory}`;
          if (this.dependencies.listWorkspaces().some((item) => item.id === workspace.id)) {
            this.dependencies.saveWorkspaces();
            this.dependencies.broadcastWorkspaceUpdate(workspace);
          }
        }
        this.preparedSshWorkspaceIds.add(workspace.id);
        return {
          createdBranch: result?.createdBranch === true,
          createdWorktree: result?.createdWorktree === true,
        };
      } catch (error) {
        if (!isSshWorktreePathConflictError(error)) throw error;
      }
    }

    throw new Error(
      `Could not find an available remote worktree folder after ${this.dependencies.maxAttempts} attempts.`
    );
  }

  private findSshBranchConflict(
    backend: SshWorkspaceBackend,
    branchName: string,
    excludeWorkspaceId?: string
  ): Workspace | undefined {
    return this.dependencies
      .listWorkspaces()
      .find(
        (workspace) =>
          isSshWorkspace(workspace) &&
          workspace.backend.hostId === backend.hostId &&
          workspace.backend.remoteRepoPath === backend.remoteRepoPath &&
          workspace.branchName === branchName &&
          workspace.id !== excludeWorkspaceId
      );
  }

  plan(
    { initialBranchName, params, branchPrefix, createPlan }: SshWorkspaceProvisioningRequest,
    excludeWorkspaceId?: string
  ): {
    remote: ReturnType<typeof sshWorkspaceService.createWorkspacePlan>;
    branchName: string;
  } {
    let branchName = initialBranchName;
    for (let attempt = 1; attempt <= this.dependencies.maxAttempts; attempt++) {
      const remote = createPlan(branchName);
      const conflict = this.findSshBranchConflict(remote.backend, branchName, excludeWorkspaceId);
      if (!conflict) return { remote, branchName };
      if (params.autoResolveBranchConflicts !== true) {
        throw this.dependencies.branchConflictError(branchName, conflict);
      }
      branchName = this.dependencies.nextBranchName(
        initialBranchName,
        branchPrefix,
        attempt,
        params.useExactBranchName
      );
    }
    throw new Error(
      `Could not find an available branch name after ${this.dependencies.maxAttempts} attempts. Please try again.`
    );
  }

  async prepare(
    workspace: Workspace,
    { initialBranchName, params, branchPrefix, createPlan }: SshWorkspaceProvisioningRequest
  ): Promise<void> {
    if (!isSshWorkspace(workspace))
      throw new Error('SSH workspace provisioning requires an SSH workspace');
    const shouldAutoResolve = params.autoResolveBranchConflicts === true;
    let branchName = initialBranchName;
    let lastAttemptedBranchName = initialBranchName;
    let localConflictCount = 0;
    let remoteConflictCount = 0;
    const companion = this.companionInstaller(workspace.id, workspace.backend);

    for (let attempt = 1; attempt <= this.dependencies.maxAttempts; attempt++) {
      lastAttemptedBranchName = branchName;
      const remote = createPlan(branchName);
      const conflict = this.findSshBranchConflict(remote.backend, branchName, workspace.id);
      if (conflict) {
        localConflictCount++;
        if (!shouldAutoResolve) {
          throw this.dependencies.branchConflictError(branchName, conflict);
        }
      } else {
        workspace.backend = remote.backend;
        workspace.workingDirectory = remote.workingDirectory;
        workspace.branchName = branchName;
        if (attempt > 1 && !workspace.customName) {
          workspace.name = this.dependencies.workspaceName(branchName, branchPrefix);
        }
        if (this.dependencies.listWorkspaces().some((item) => item.id === workspace.id)) {
          this.dependencies.saveWorkspaces();
        }

        try {
          const { createdBranch, createdWorktree } = await this.prepareSshWorkspace(
            workspace,
            companion
          );
          if (workspace.provisioning) {
            workspace.provisioningBranchCreated = createdBranch;
            workspace.provisioningWorktreeCreated = createdWorktree;
            await this.dependencies.persistWorkspaces();
          }
          return;
        } catch (error) {
          if (!isSshBranchAlreadyExistsError(error)) throw error;
          remoteConflictCount++;
          if (!shouldAutoResolve) {
            throw new Error(
              `Branch "${branchName}" already exists on the SSH host. Choose a different branch or enable automatic conflict resolution.`
            );
          }
        }
      }

      branchName = this.dependencies.nextBranchName(
        initialBranchName,
        branchPrefix,
        attempt,
        params.useExactBranchName
      );
    }

    throw new Error(
      `Could not find an available SSH branch name after ${this.dependencies.maxAttempts} attempts ` +
        `(${localConflictCount} Komla workspace conflicts, ${remoteConflictCount} existing remote branches). ` +
        `Last candidate: "${lastAttemptedBranchName}". Please choose a different branch name.`
    );
  }

  complete(workspace: Workspace): void {
    if (!isSshWorkspace(workspace))
      throw new Error('SSH workspace provisioning requires an SSH workspace');
    workspace.provisioning = false;
    workspace.provisionStatus = undefined;
    workspace.provisionError = undefined;
    workspace.provisioningBranchCreated = undefined;
    workspace.provisioningWorktreeCreated = undefined;
  }

  /**
   * Automatic recovery may remove only verified creations. Explicit workspace deletion is a
   * separate user operation and does not use this ownership rule. Retain ownership on failure
   * so the workspace can be kept and cleanup retried, including after a restart.
   */
  async recover(
    workspace: Workspace,
    reason: 'interrupted' | 'failed' | 'cancelled'
  ): Promise<'remove' | 'retain'> {
    if (!isSshWorkspace(workspace))
      throw new Error('SSH workspace provisioning requires an SSH workspace');
    if (workspace.provisioningWorktreeCreated !== true) return 'remove';
    try {
      await this.dependencies.ssh.deleteWorkspace(
        workspace.backend,
        workspace.provisioningBranchCreated === true,
        workspace.branchName
      );
      this.preparedSshWorkspaceIds.delete(workspace.id);
      return 'remove';
    } catch (error) {
      logger.warn('Could not recover SSH workspace provisioning', {
        workspaceId: workspace.id,
        reason,
        error,
      });
      if (reason === 'interrupted') {
        workspace.provisioning = false;
        workspace.provisionStatus = undefined;
        workspace.provisionError =
          'Workspace setup was interrupted and its remote resources could not be cleaned up. Delete this workspace to retry cleanup.';
      } else if (reason === 'failed') {
        workspace.provisionError = `${workspace.provisionError} Remote cleanup also failed; delete this workspace to retry cleanup.`;
      }
      return 'retain';
    }
  }
}

const dependencies: SshWorkspaceProvisioningDependencies = {
  listWorkspaces: () => [],
  saveWorkspaces: () => undefined,
  persistWorkspaces: async () => {
    throw new Error('SSH workspace provisioning is not configured');
  },
  broadcastWorkspaceUpdate: () => undefined,
  maxAttempts: 25,
  nextBranchName: () => {
    throw new Error('SSH workspace provisioning is not configured');
  },
  workspaceName: () => {
    throw new Error('SSH workspace provisioning is not configured');
  },
  branchConflictError: () => new Error('SSH workspace provisioning is not configured'),
  installCompanion: () => Promise.reject(new Error('SSH workspace provisioning is not configured')),
  ssh: sshWorkspaceService,
};

export const sshWorkspaceProvisioningService = new SshWorkspaceProvisioningService(dependencies);

export function configureSshWorkspaceProvisioning(
  configured: SshWorkspaceProvisioningDependencies
): void {
  Object.assign(dependencies, configured);
}
