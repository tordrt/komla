import { existsSync } from 'fs';
import { dirname } from 'path';

import { canDeleteWorkspaceBranch, isSshWorkspace } from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { deleteReleasingOpenCodeLocation } from '../../lib/opencode-service';
import { isSamePath } from '../../lib/same-path';
import { agentPresetService } from '../agent-preset.service';
import { configService } from '../config.service';
import { executionLocations } from '../execution-location';
import { gitService } from '../git.service';
import { localCopyService } from '../local-copy.service';
import { notesService } from '../notes.service';
import { projectService } from '../project.service';
import { ptyService } from '../pty.service';
import { remoteWorkspaceObservationService } from '../remote-workspace-observation.service';
import { markSshHostDisconnected } from '../ssh-host-disconnection';
import { sshHostService } from '../ssh-host.service';
import { sshPortForwardService } from '../ssh-port-forward.service';
import { sshWorkspaceProvisioningService } from '../ssh-workspace-provisioning.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { workspaceLinksService } from '../workspace-links.service';
import { workspaceSetupService } from '../workspace-setup.service';
import { workspaceStatusService } from '../workspace-status.service';
import { worktreeWatcherService } from '../worktree-watcher.service';

import { resolveContinueCommand, resolvePreset } from './agent-launch';
import { moveFolderIntoProject, workspaceProject } from './projects';
import { removeScratchFolder } from './scratch';
import { workspaceStore } from './store';

import type { WorkspaceNaming } from './naming';
import type { WorkspaceProvisioning } from './provisioning';
import type { WorkspaceTerminals } from './terminals';
import type { Terminal, Workspace } from '../../../shared/types';
import type { SshHost } from '../../../shared/types/ssh';
import type { SshWorkspaceSync } from '../ssh-workspace-sync/ssh-workspace-sync';
import type { TerminalAttention } from '../terminal-attention/terminal-attention';

const logger = createLogger('WorkspaceService');

export interface WorkspaceLifecycleDeps {
  attention: TerminalAttention;
  sshSync: SshWorkspaceSync;
  naming: WorkspaceNaming;
  terminals: WorkspaceTerminals;
  provisioning: WorkspaceProvisioning;
}

/** Stops, restarts and deletes workspaces, and clears out those left stale by a crash. */
export class WorkspaceLifecycle {
  constructor(private readonly deps: WorkspaceLifecycleDeps) {}

  async cleanupStaleWorkspaces(ids: string[]): Promise<void> {
    let changed = false;
    for (const id of ids) {
      const ws = workspaceStore.workspaces.get(id);
      if (!ws) continue;

      if (ws.provisioning && isSshWorkspace(ws)) {
        if ((await sshWorkspaceProvisioningService.recover(ws, 'interrupted')) === 'remove') {
          workspaceStore.workspaces.delete(id);
          this.deps.attention.workspaceDeleted(id);
        }
        changed = true;
        continue;
      }

      // Remove workspaces that were mid-provisioning when app quit. If a worktree
      // already exists, delete it before dropping the orphaned workspace record.
      if (ws.provisioning) {
        if (ws.workingDirectory && ws.provisioningRepoPath && existsSync(ws.workingDirectory)) {
          try {
            await gitService.deleteWorktree(ws.provisioningRepoPath, ws.workingDirectory, true, {
              deleteBranch: ws.provisioningBranchCreated === true,
              branchName: ws.branchName,
            });
          } catch (error) {
            logger.warn(`Failed to clean up stale provisioning workspace ${id}:`, error);
          }
        }
        await this.unlinkStaleWorkspace(id, ws);
        logger.info(`Removing stale provisioning workspace ${id}`, { name: ws.name });
        workspaceStore.workspaces.delete(id);
        this.deps.attention.workspaceDeleted(id);
        changed = true;
        continue;
      }
      if (isSshWorkspace(ws)) continue;
      if (ws.isWorktree && !existsSync(ws.workingDirectory)) {
        await this.unlinkStaleWorkspace(id, ws);
        logger.info(`Removing stale workspace ${id} (directory missing)`, { name: ws.name });
        workspaceStore.workspaces.delete(id);
        this.deps.attention.workspaceDeleted(id);
        this.trashNotes(id);
        changed = true;
      }
    }
    const linksChanged = await workspaceLinksService.reconcileAllFromDisk();
    if (changed || linksChanged) {
      await workspaceStore.saveWorkspacesImmediate();
      workspaceStore.broadcastWorkspacesChanged();
    }
  }

  // When the parent folder is gone too (say, an unmounted drive), git can't match the path to
  // its worktree record, and deleteWorktree's fallback prune would drop every worktree there.
  private canCleanUpMissingWorktree(worktreePath: string): boolean {
    return existsSync(dirname(worktreePath));
  }

  private async unlinkStaleWorkspace(id: string, _workspace: Workspace): Promise<void> {
    // Run unconditionally — stale on-disk symlinks pointing at this workspace
    // can exist even when its own metadata is empty.
    try {
      await workspaceLinksService.unlinkAll(id);
    } catch (error) {
      logger.warn(`Failed to unlink stale workspace ${id}:`, error);
    }
  }

  async stop(workspaceId: string): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    await workspaceSetupService.cancel(workspaceId);
    workspaceSetupService.clearActive(workspace.id);
    if (isSshWorkspace(workspace)) {
      this.deps.terminals.cancelDeferredWorkspaceLaunches(workspace);
    }
    try {
      const stopping = executionLocations.stopSessions(workspace);
      if (stopping) await stopping;
    } catch (error) {
      throw new Error(
        `Could not confirm all remote agents stopped; the workspace remains active. ${String(error)}`
      );
    }
    workspace.lastStoppedAt = Date.now();
    // Setup's panes open as it runs; the next start opens the saved layout instead.
    workspace.setupPanes = undefined;

    // Stop all terminals in the workspace (stopping is idempotent)
    for (const terminal of executionLocations.stopAttached(workspace)) {
      terminal.status = 'stopped';
    }
    workspaceSetupService.stopBackground(workspaceId);
    void remoteWorkspaceObservationService.reconcile();
    this.deps.attention.workspaceStopped(workspaceId);

    // Stop file watcher — the renderer retains cached git status
    await worktreeWatcherService.stopWatching(workspaceId);
    await sshPortForwardService.stopPreviewForward(workspaceId);

    workspaceStore.saveWorkspaces();
  }

  // Restart a workspace by adding a new terminal with continue command
  // Re-applies project setup steps (background processes, terminal layout)
  restart(workspaceId: string, remoteSetupStopped = false): Terminal | Promise<Terminal> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (workspace.provisioning) {
      throw new Error(`Workspace ${workspaceId} is still being provisioned`);
    }

    if (!remoteSetupStopped) {
      const setupCleanup = workspaceSetupService.cancel(workspaceId);
      if (setupCleanup) {
        return setupCleanup.then(() => this.restart(workspaceId, true));
      }
    }

    // Restart should clean up the same terminal resources as stop before
    // setup steps and the continue command create fresh terminals.
    this.deps.terminals.cancelDeferredWorkspaceLaunches(workspace);
    for (const terminal of workspace.terminals) {
      ptyService.kill(terminal.id);
      terminal.status = 'stopped';
    }

    // Clear old terminals to avoid stale references
    workspace.terminals = [];
    workspace.terminalLayout = undefined;
    workspace.lastStoppedAt = undefined;

    // Auto-activate dormant workspaces when restarting
    if (workspace.status !== 'active') {
      workspace.status = 'active';
      moveFolderIntoProject(workspace);
      this.deps.attention.workspaceStatusChanged();
      workspaceStore.saveWorkspaces();
    }

    // Start file watcher (stopped when workspace was stopped)
    if (!isSshWorkspace(workspace)) {
      worktreeWatcherService.startWatching(workspaceId, workspace.workingDirectory).catch((err) => {
        logger.error(`Failed to start watcher for workspace ${workspaceId}:`, err);
      });
    }

    // Kill existing background processes so they can be re-spawned from setup steps
    workspaceSetupService.clearActive(workspace.id);
    workspaceSetupService.stopBackground(workspaceId);
    void sshPortForwardService.stopPreviewForward(workspaceId);

    // Auto-heal: if workspace references a deleted preset, fall back to first active
    if (
      workspace.presetId &&
      agentPresetService.get &&
      !agentPresetService.get(workspace.presetId)
    ) {
      const fallback = agentPresetService.getFirstActive?.();
      if (fallback) {
        workspace.presetId = fallback.id;
        workspace.launchModeId = null;
        workspace.reasoningLevelId = null;
        workspace.modelId = null;
        workspaceStore.saveWorkspaces();
      }
    }

    // Build continue command from workspace's preset
    const command = resolveContinueCommand(
      resolvePreset(null, workspace),
      workspace,
      workspace.launchModeId
    );

    // Re-apply setup steps for worktree workspaces with a project
    const primaryTerminal = workspaceSetupService.start(workspace, command, 'start');
    if (primaryTerminal) {
      return primaryTerminal;
    }

    // Default: create single terminal with agent command
    const terminal = this.deps.terminals.addTerminal(workspaceId, workspace.name, command);
    if (terminal instanceof Promise) {
      return terminal.then((startedTerminal) => {
        workspace.primaryTerminalId = startedTerminal.id;
        return startedTerminal;
      });
    }
    workspace.primaryTerminalId = terminal.id;
    return terminal;
  }

  async restartWithCleanup(workspaceId: string): Promise<Terminal> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    try {
      const releasing = executionLocations.releaseSessions(workspace, {
        observeUnknownFirst: true,
      });
      if (releasing) await releasing;
    } catch (error) {
      throw new Error(
        `Could not confirm all remote agents stopped; workspace restart was cancelled. ${String(error)}`
      );
    }
    await sshPortForwardService.stopPreviewForward(workspaceId);
    return this.restart(workspaceId);
  }

  async delete(
    workspaceId: string,
    force = false,
    deleteBranch = false,
    options: { skipBackendCleanup?: boolean } = {}
  ): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (workspaceStore.isDeleting(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} is being deleted`);
    }
    workspaceStore.deletingWorkspaceIds.add(workspaceId);
    try {
      await this.deleteWorkspace(workspace, force, deleteBranch, options);
    } finally {
      workspaceStore.deletingWorkspaceIds.delete(workspaceId);
    }
  }

  private async deleteWorkspace(
    workspace: Workspace,
    force: boolean,
    deleteBranch: boolean,
    options: { skipBackendCleanup?: boolean }
  ): Promise<void> {
    const workspaceId = workspace.id;
    // The renderer offers branch deletion only where this allows it; never delete the target branch.
    const deletesBranch =
      deleteBranch && canDeleteWorkspaceBranch(workspace, workspaceProject(workspace)?.baseBranch);
    workspaceSetupService.cancel(workspace.id, 'pending');

    this.deps.terminals.cancelDeferredWorkspaceLaunches(workspace);
    try {
      const releasing = executionLocations.releaseSessions(workspace, {
        skipRemoteConfirmation: options.skipBackendCleanup,
      });
      if (releasing) await releasing;
    } catch (error) {
      throw new Error(
        `Could not confirm all remote agents stopped; workspace deletion was cancelled. ${String(error)}`
      );
    }
    await workspaceSetupService.cancel(workspaceId);
    workspaceSetupService.cancel(workspaceId, 'updates');

    // Unregister target branch from git service
    if (workspace.workingDirectory && !isSshWorkspace(workspace)) {
      gitService.registerTargetBranch(workspace.workingDirectory, undefined);
    }

    // Stop watching for git status changes
    await worktreeWatcherService.stopWatching(workspaceId);

    // Kill background processes for this workspace. Await exit so live shells
    // don't outlive the worktree removal below (would emit shell-init: getcwd
    // warnings and break any in-flight git push from the PTY).
    await workspaceSetupService.stopBackground(workspaceId, { waitForExit: true });
    const stopPreviewForwardPromise = sshPortForwardService.stopPreviewForward(workspaceId);

    // Mark workspace as provisioning-cancelled so finishProvisioning will bail out early
    if (workspace.provisioning) {
      this.deps.provisioning.markCancelled(workspaceId);
    }

    this.deps.naming.abortAutoNaming(workspaceId);
    this.deps.naming.abortProvisioningNaming(workspaceId);

    // Permanently tear down all terminals and wait for their native processes
    // to exit before removing a worktree or local copy containing their cwd.
    const releasingAttached = executionLocations.releaseAttached(workspace);
    if (releasingAttached) await releasingAttached;

    // Delete worktree if applicable (skip if provisioning never completed)
    if (options.skipBackendCleanup) {
      // Backend already gone or intentionally left in place, along with its manifest.
      await this.deps.sshSync.deleted(workspace, { leftOnHost: true });
    } else if (isSshWorkspace(workspace)) {
      await sshWorkspaceService.deleteWorkspace(
        workspace.backend,
        deletesBranch,
        workspace.branchName,
        { allowBranchToRemain: true }
      );
      await this.deps.sshSync.deleted(workspace, { leftOnHost: false });
    } else if (workspace.isWorktree && workspace.projectId && workspace.workingDirectory) {
      const project = projectService.get(workspace.projectId);
      // A missing directory still leaves git's worktree record (and maybe the branch) to clean
      // up, unless provisioning never got as far as creating it.
      if (
        project &&
        (existsSync(workspace.workingDirectory) ||
          (!workspace.provisioning && this.canCleanUpMissingWorktree(workspace.workingDirectory)))
      ) {
        // For managed projects, use the bare clone path
        const repoPath =
          project.managed && project.managedRepoPath
            ? project.managedRepoPath
            : project.repositoryPath;
        const worktreePath = workspace.workingDirectory;
        await deleteReleasingOpenCodeLocation(worktreePath, () =>
          gitService.deleteWorktree(repoPath, worktreePath, force, {
            deleteBranch: deletesBranch,
            branchName: workspace.branchName,
          })
        );
      }
    } else if (workspace.scratch && !this.scratchFolderInUse(workspace)) {
      // Its folder is Komla's; failing keeps the workspace so deleting can be retried.
      await removeScratchFolder(workspace);
    }

    // A workspace is not fully deleted until its local copy is gone. Keep
    // the workspace record when this fails so deletion can be retried safely;
    // remote cleanup above is idempotent.
    if (isSshWorkspace(workspace)) {
      await localCopyService.remove(workspaceId, workspace.backend);
    }

    // Tear down bidirectional links after worktree deletion succeeds so a
    // failed delete does not silently lose link state.
    try {
      await workspaceLinksService.unlinkAll(workspaceId);
    } catch (err) {
      logger.warn(`Failed to unlink workspace ${workspaceId} during delete:`, err);
    }

    workspaceStore.workspaces.delete(workspaceId);
    this.deps.attention.workspaceDeleted(workspaceId);
    this.trashNotes(workspaceId);
    void remoteWorkspaceObservationService.reconcile();
    await workspaceStatusService.change({ kind: 'workspace-removed', workspaceId });
    // Use immediate save for deletion to ensure consistency
    try {
      await workspaceStore.saveWorkspacesImmediateChecked();
    } catch (error) {
      // Backend deletion cannot be rolled back. Keep the workspace deleted in
      // this session instead of reporting a retryable failure to the renderer.
      logger.warn(`Workspace ${workspaceId} was deleted but could not be persisted:`, error);
      workspaceStore.saveWorkspaces();
    }
    await Promise.all([
      stopPreviewForwardPromise,
      isSshWorkspace(workspace) ? Promise.resolve() : localCopyService.remove(workspaceId),
    ]);
  }

  /**
   * Whether something else uses a scratch workspace's folder: another workspace, or a folder
   * project, as when the folder was opened with Open Folder too. Those say deleting leaves it.
   */
  private scratchFolderInUse(workspace: Workspace): boolean {
    const folder = workspace.workingDirectory;
    for (const other of workspaceStore.workspaces.values()) {
      if (
        other.id !== workspace.id &&
        !isSshWorkspace(other) &&
        isSamePath(other.workingDirectory, folder)
      ) {
        return true;
      }
    }
    return projectService
      .list()
      .some(
        (project) => project.kind === 'directory' && isSamePath(project.repositoryPath, folder)
      );
  }

  /** Notes belong to their workspace; the trash keeps any still wanted. */
  private trashNotes(workspaceId: string): void {
    void notesService.trashAll(workspaceId).catch((error: unknown) => {
      logger.warn(`Could not move workspace ${workspaceId}'s notes to the trash:`, error);
    });
  }

  async deleteAll(): Promise<void> {
    const ids = Array.from(workspaceStore.workspaces.keys());
    for (const id of ids) {
      try {
        await this.delete(id, true);
      } catch (err) {
        logger.error('Failed to delete workspace during deleteAll', err, { workspaceId: id });
      }
    }
  }

  async deleteSshHost(
    hostId: string,
    options: { deleteRemoteData?: boolean } = {}
  ): Promise<{ deletedWorkspaceIds: string[] }> {
    if (!sshHostService.has(hostId)) {
      throw new Error(`SSH host ${hostId} not found`);
    }

    const matchingWorkspaces = Array.from(workspaceStore.workspaces.values()).filter(
      (workspace) => isSshWorkspace(workspace) && workspace.backend.hostId === hostId
    );

    // Without deleteRemoteData the host keeps its workspaces and their agents running, for another
    // device to pick up, so deleting the host needs no connection.
    if (options.deleteRemoteData) {
      await sshWorkspaceService.deleteHostData(hostId);
    }

    for (const workspace of matchingWorkspaces) {
      await this.delete(workspace.id, true, false, {
        skipBackendCleanup: true,
      });
    }

    const lastEnvironment = configService.get().lastWorkspaceEnvironment;
    if (lastEnvironment?.kind === 'ssh' && lastEnvironment.hostId === hostId) {
      configService.update({ lastWorkspaceEnvironment: undefined });
    }
    if (configService.get().agentLaunchDefaultSshHostId === hostId) {
      configService.update({ agentLaunchDefaultSshHostId: undefined });
    }
    const syncDisabledHostIds = configService.get().workspaceSyncDisabledHostIds;
    if (syncDisabledHostIds?.includes(hostId)) {
      configService.update({
        workspaceSyncDisabledHostIds: syncDisabledHostIds.filter((id) => id !== hostId),
      });
    }
    const disconnectedHostIds = configService.get().disconnectedSshHostIds;
    if (disconnectedHostIds?.includes(hostId)) {
      configService.update({
        disconnectedSshHostIds: disconnectedHostIds.filter((id) => id !== hostId),
      });
    }
    markSshHostDisconnected(hostId, false);
    sshWorkspaceService.forgetHost(hostId);
    sshHostService.delete(hostId);
    // Only now: a sync reading the host meanwhile could add them back. Adding the host back does.
    this.deps.sshSync.hostForgotten(matchingWorkspaces.map((workspace) => workspace.id));
    void remoteWorkspaceObservationService.reconcile();
    return { deletedWorkspaceIds: matchingWorkspaces.map((workspace) => workspace.id) };
  }

  assertSshHostConnectionUpdateAllowed(nextHost: SshHost): void {
    const currentHost = sshHostService.get(nextHost.id);
    if (!currentHost) return;
    const lockedHostIds = new Set(
      Array.from(workspaceStore.workspaces.values())
        .filter(isSshWorkspace)
        .map((workspace) => workspace.backend.hostId)
    );

    const connectionProfile = (host: SshHost) =>
      JSON.stringify({
        hostname: host.hostname.trim(),
        user: host.user?.trim() || '',
        port: host.port ?? null,
        identityFile: host.identityFile?.trim() || '',
        extraSshArgs: host.extraSshArgs ?? [],
      });

    if (
      lockedHostIds.has(nextHost.id) &&
      connectionProfile(currentHost) !== connectionProfile(nextHost)
    ) {
      throw new Error(
        'Remove existing SSH workspaces for this host before changing its connection settings.'
      );
    }
  }
}
