import { BrowserWindow } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { isSshWorkspace, type SshWorkspaceBackend } from '../../../shared/types/workspace';
import { gitRemoteIdentity } from '../../lib/git-remote-identity';
import { createLogger } from '../../lib/logger';
import { gitService } from '../git.service';
import { localCopyService } from '../local-copy.service';
import { projectService } from '../project.service';
import { normalizePersistedTerminalLayout } from '../ssh-workspace-sync/terminal-layout';
import { windowService } from '../window.service';

import {
  hydrateWorkspace,
  normalizePersistedSshTerminals,
  WORKSPACE_VERSION,
} from './persisted-workspace';
import { workspaceProject } from './projects';
import { workspaceStore } from './store';

import type { WorkspaceLifecycle } from './lifecycle';
import type { WorkspaceNaming } from './naming';
import type { Project, Workspace } from '../../../shared/types';
import type {
  SshWorkspaceManifest,
  SshWorkspaceRemovedOnOtherDevice,
} from '../../../shared/types/ssh-workspace-manifest';
import type { SshWorkspacePlacement } from '../ssh-workspace-sync/ssh-workspace-sync';
import type { TerminalAttention } from '../terminal-attention/terminal-attention';

const logger = createLogger('WorkspaceService');

export interface SshWorkspaceAdoptionDeps {
  attention: TerminalAttention;
  lifecycle: WorkspaceLifecycle;
  naming: WorkspaceNaming;
}

/**
 * When a name another device generated counts as generated here: no later than now, as the
 * devices' clocks differ, and now when that device didn't say, as an older version doesn't.
 */
function customNameGeneratedHere(manifest: SshWorkspaceManifest): number | undefined {
  if (manifest.customNameSource !== 'generated') return undefined;
  const now = Date.now();
  return Math.min(manifest.customNameGeneratedAt || now, now);
}

/** Applies what SSH Workspace Sync reads from a host here, and matches SSH workspaces to projects. */
export class SshWorkspaceAdoption {
  private readonly sshHostSyncedListeners = new Set<(hostId: string) => void>();
  // Origin URL per local repository, looked up once per session to match SSH workspaces to projects.
  private readonly gitRemoteUrls = new Map<string, Promise<string | null>>();
  constructor(private readonly deps: SshWorkspaceAdoptionDeps) {}

  /**
   * Marks an SSH workspace whose files are gone from its host although no Komla
   * installation recorded deleting it, so the user decides what to do with it.
   */
  markSshWorkspaceRemoved(workspaceId: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (
      !workspace ||
      !isSshWorkspace(workspace) ||
      workspaceStore.deletingWorkspaceIds.has(workspaceId)
    ) {
      return;
    }
    // provisionError keeps Komla from reconnecting or restarting it; removedFromHost names why.
    workspace.removedFromHost = true;
    workspace.provisionError = 'This workspace’s files are no longer on its SSH host.';
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspacesChanged();
  }

  /** Clears the mark on an SSH workspace whose files are on its host again. */
  markSshWorkspaceFound(workspaceId: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace?.removedFromHost) return;
    workspace.removedFromHost = undefined;
    workspace.provisionError = undefined;
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspacesChanged();
  }

  /** Removes an SSH workspace another installation deleted from its host; the host is left alone. */
  async removeSshWorkspaceDeletedElsewhere(workspaceId: string): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace) || workspaceStore.isDeleting(workspaceId)) return;
    const event: SshWorkspaceRemovedOnOtherDevice = {
      workspaceId,
      name: workspace.customName || workspace.name,
    };
    await this.deps.lifecycle.delete(workspaceId, true, false, { skipBackendCleanup: true });
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.WORKSPACE_REMOVED_ON_OTHER_DEVICE, event);
      }
    }
  }

  /**
   * Takes the names, tabs and layout of a manifest merged with another device's,
   * and returns the ids of the tabs it added.
   */
  applyMergedSshWorkspace(workspaceId: string, merged: SshWorkspaceManifest): string[] {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) return [];
    workspace.name = merged.name;
    // A name another device gave it replaces any being generated here, and starts the count of
    // prompts that drift from it.
    if (merged.customName !== workspace.customName) {
      this.deps.naming.abortAutoNaming(workspaceId);
      workspace.autoNaming = false;
      workspace.promptSubmitsSinceCustomNameGeneration = 0;
    }
    workspace.customName = merged.customName;
    workspace.customDescription = merged.customDescription;
    workspace.customNameSource = merged.customNameSource;
    workspace.customNameGeneratedAt = customNameGeneratedHere(merged);
    const addedTerminalIds = this.takeSshTerminalsFromOtherDevice(workspace, merged.terminals);
    const terminalIds = new Set(workspace.terminals.map((terminal) => terminal.id));
    workspace.terminalLayout = normalizePersistedTerminalLayout(merged.terminalLayout, terminalIds);
    if (!terminalIds.has(workspace.primaryTerminalId ?? '')) {
      workspace.primaryTerminalId = workspace.terminals[0]?.id;
    }
    return addedTerminalIds;
  }

  /** Adds the tabs another device opened and applies its renames; returns the new tabs' ids. */
  private takeSshTerminalsFromOtherDevice(
    workspace: Workspace,
    merged: SshWorkspaceManifest['terminals']
  ): string[] {
    const terminals = new Map(workspace.terminals.map((terminal) => [terminal.id, terminal]));
    const added: string[] = [];
    for (const terminal of merged) {
      const existing = terminals.get(terminal.id);
      if (existing) {
        existing.name = terminal.name;
        continue;
      }
      workspace.terminals.push(
        ...normalizePersistedSshTerminals([{ ...terminal, executionLocation: 'workspace' }])
      );
      added.push(terminal.id);
    }
    return added;
  }

  /**
   * Mirrors another device moving a workspace to the Trash or restoring it, which
   * ended its sessions. Like the Trash here, it never hides a workspace while
   * its agents may run: if they can't be stopped, it rejects and the status stays.
   */
  async applySshWorkspaceStatusFromOtherDevice(
    workspaceId: string,
    status: Workspace['status']
  ): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) return;
    const previous = workspace.status;
    if (previous === 'active' && status !== 'active') await this.deps.lifecycle.stop(workspace.id);
    workspace.status = status;
    // The days count from when this device saw the move.
    if (status !== 'trashed') workspace.trashedAt = undefined;
    else if (previous !== 'trashed') workspace.trashedAt = Date.now();
    this.deps.attention.workspaceStatusChanged();
    if (status === 'trashed') workspace.setupActivities = undefined;
    if (status !== 'trashed' || previous === 'trashed' || !isSshWorkspace(workspace)) return;
    void localCopyService.remove(workspace.id, workspace.backend).catch((error) => {
      logger.warn(
        'Could not remove the local copy of a workspace another device moved to the Trash',
        {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    });
  }

  /** Gives SSH workspaces without a project here the local project for their repository, if any. */
  async assignSshWorkspaceProjects(): Promise<void> {
    const unassigned = () =>
      Array.from(workspaceStore.workspaces.values()).filter(
        (workspace) => isSshWorkspace(workspace) && !workspaceProject(workspace)
      );
    if (unassigned().length === 0) return;
    const projectsByRemote = await this.projectsByGitRemote();
    let assigned = false;
    for (const workspace of unassigned()) {
      if (!isSshWorkspace(workspace)) continue;
      const project = this.sshRepositoryProject(workspace.backend, projectsByRemote);
      if (!project) continue;
      workspace.projectId = project.id;
      assigned = true;
    }
    if (!assigned) return;
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspacesChanged();
  }

  /**
   * Puts an SSH workspace in a project the user chose, along with workspaces
   * without a project that use the same clone on its host.
   */
  linkSshWorkspaceToProject(workspaceId: string, projectId: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) {
      throw new Error(`SSH workspace ${workspaceId} not found`);
    }
    const project = projectService.get(projectId);
    if (!project || project.kind === 'directory') {
      throw new Error(`Git project ${projectId} not found`);
    }
    for (const other of workspaceStore.workspaces.values()) {
      const sameClone =
        isSshWorkspace(other) &&
        other.backend.hostId === workspace.backend.hostId &&
        other.backend.remoteRepoPath === workspace.backend.remoteRepoPath;
      if (other === workspace || (sameClone && !workspaceProject(other))) {
        other.projectId = project.id;
      }
    }
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspacesChanged();
  }

  /** Calls `listener` each time SSH Workspace Sync has read a host. */
  onSshHostSynced(listener: (hostId: string) => void): () => void {
    this.sshHostSyncedListeners.add(listener);
    return () => this.sshHostSyncedListeners.delete(listener);
  }

  /** Resolves to a lookup of this installation's git project for a repository origin. */
  async gitRemoteProjectLookup(): Promise<(gitUrl: string) => Project | undefined> {
    const projectsByRemote = await this.projectsByGitRemote();
    return (gitUrl) => projectsByRemote.get(gitRemoteIdentity(gitUrl));
  }

  /** This installation's git projects by the identity of their origin remote. */
  async projectsByGitRemote(): Promise<Map<string, Project>> {
    const projects = projectService.list().filter((project) => project.kind !== 'directory');
    const remotes = await Promise.all(
      projects.map((project) => {
        const path =
          project.managed && project.managedRepoPath
            ? project.managedRepoPath
            : project.repositoryPath;
        let remote = this.gitRemoteUrls.get(path);
        if (!remote) {
          remote = gitService.getRemoteUrl(path).catch(() => {
            this.gitRemoteUrls.delete(path);
            return null;
          });
          this.gitRemoteUrls.set(path, remote);
        }
        return remote;
      })
    );
    const byRemote = new Map<string, Project>();
    projects.forEach((project, index) => {
      const identity = remotes[index] ? gitRemoteIdentity(remotes[index]) : undefined;
      if (identity && !byRemote.has(identity)) byRemote.set(identity, project);
    });
    return byRemote;
  }

  /** Matches repositories on an SSH host to local projects, as SSH Workspace Sync does. */
  async sshRepositoryProjectLookup(): Promise<
    (
      backend: Pick<SshWorkspaceBackend, 'hostId' | 'remoteRepoPath' | 'gitUrl'>
    ) => string | undefined
  > {
    const projectsByRemote = await this.projectsByGitRemote();
    return (backend) => this.sshRepositoryProject(backend, projectsByRemote)?.id;
  }

  /**
   * The local project for an SSH workspace's repository: that of another
   * workspace using the same clone on the host, else a git project whose
   * origin is the same repository.
   */
  sshRepositoryProject(
    backend: Pick<SshWorkspaceBackend, 'hostId' | 'remoteRepoPath' | 'gitUrl'>,
    projectsByRemote: ReadonlyMap<string, Project>
  ): Project | undefined {
    for (const other of workspaceStore.workspaces.values()) {
      if (
        !isSshWorkspace(other) ||
        other.backend.hostId !== backend.hostId ||
        other.backend.remoteRepoPath !== backend.remoteRepoPath
      ) {
        continue;
      }
      const project = workspaceProject(other);
      if (project) return project;
    }
    return projectsByRemote.get(gitRemoteIdentity(backend.gitUrl));
  }

  /** Adds an SSH workspace adopted from its manifest, placed where SSH Workspace Sync says. */
  addAdoptedSshWorkspace(
    hostId: string,
    manifest: SshWorkspaceManifest,
    { projectId, sibling }: SshWorkspacePlacement
  ): Workspace {
    const { workspace, agentSources } = hydrateWorkspace({
      _version: WORKSPACE_VERSION,
      id: manifest.workspaceId,
      name: manifest.name,
      customName: manifest.customName,
      customDescription: manifest.customDescription,
      customNameSource: manifest.customNameSource,
      customNameGeneratedAt: customNameGeneratedHere(manifest),
      workingDirectory: `ssh://${hostId}${manifest.backend.remoteDirectory}`,
      backend: {
        kind: 'ssh',
        hostId,
        ...manifest.backend,
        ...(sibling?.backend.projectId ? { projectId: sibling.backend.projectId } : {}),
      },
      branchName: manifest.branchName,
      isWorktree: true,
      projectId,
      repoName: manifest.repoName,
      baseBranch: manifest.baseBranch,
      ...(sibling ? { presetId: sibling.presetId, launchModeId: sibling.launchModeId } : {}),
      primaryTerminalId: manifest.primaryTerminalId,
      terminals: manifest.terminals.map((terminal) => ({
        ...terminal,
        executionLocation: 'workspace',
      })),
      terminalLayout: manifest.terminalLayout,
      windowId: null,
      categoryId: null,
      createdAt: manifest.createdAt,
      // When it last changed there, e.g. a new tab or name, rather than when it arrived. Activity
      // this device sees on the host moves it up later, as it does on the device running it.
      lastActivityAt: Math.max(manifest.createdAt, manifest.updatedAt),
      order: 0,
      status: manifest.status,
    });
    // Hydrating clears the window, as on startup, and windows list only their own workspaces.
    workspace.windowId =
      sibling?.windowId ??
      this.windowWithMostWorkspacesOf(workspace.projectId) ??
      windowService.getMainWindowId();
    // It goes on top, like a workspace created here.
    for (const existingWorkspace of workspaceStore.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }
    workspaceStore.workspaces.set(workspace.id, workspace);
    this.deps.attention.restored(workspace, agentSources);
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspacesChanged();
    return workspace;
  }

  /** The window that shows the most of a project's active workspaces, if any shows one. */
  private windowWithMostWorkspacesOf(projectId: string | null): string | null {
    if (!projectId) return null;
    const counts = new Map<string, number>();
    let most: string | null = null;
    let mostCount = 0;
    for (const workspace of workspaceStore.workspaces.values()) {
      if (workspace.projectId !== projectId || workspace.status !== 'active') continue;
      if (!workspace.windowId) continue;
      const count = (counts.get(workspace.windowId) ?? 0) + 1;
      counts.set(workspace.windowId, count);
      if (count > mostCount) {
        most = workspace.windowId;
        mostCount = count;
      }
    }
    return most;
  }

  /** Tells listeners that SSH Workspace Sync has read a host. */
  notifySshHostSynced(hostId: string): void {
    for (const listener of this.sshHostSyncedListeners) listener(hostId);
  }
}
