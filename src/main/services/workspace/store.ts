import { existsSync, readFileSync } from 'fs';

import { BrowserWindow } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { isRunningHere, isRunningOnSshHost } from '../../../shared/lib/terminal-execution-state';
import { writeFileAtomic } from '../../lib/atomic-write';
import { createLogger } from '../../lib/logger';
import { publishRemoteWorkspaceChange } from '../remote-workspace-events';

import {
  isValidPersistedWorkspace,
  serializeWorkspace,
  type PersistedTerminalSources,
  type PersistedWorkspace,
} from './persisted-workspace';

import type { Terminal, TerminalStatus, Workspace } from '../../../shared/types';

const logger = createLogger('WorkspaceService');

// Debounce delay for workspace persistence
const SAVE_DEBOUNCE_MS = 500;

/** Who owns the store: where it saves, and the parts of a save that live with others. */
export interface WorkspaceStoreOwner {
  workspacesPath: string;
  /** A Terminal's status as its PTY last reported it, newer than the one on the workspace. */
  terminalStatus: (terminalId: string) => TerminalStatus | null;
  /** Runs before each save, so SSH Workspace Sync publishes what is being saved. */
  saving: (workspaces: Iterable<Workspace>) => void;
  persistedSources: (workspaceId: string, terminalId: string) => PersistedTerminalSources;
}

/** Calls each listener with `value`; one that throws doesn't stop the rest. */
export function notifyListeners<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      logger.warn('Workspace listener failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * The workspaces of this Komla installation: looking them up, saving them, and telling windows of
 * changes. It imports no service singleton, so modules that workspace operations depend on, such
 * as workspace links and files, can read and save workspaces without importing those operations
 * back. Loading is its owner's: workspace.service.ts fills `workspaces` once it can restore what
 * hangs off them.
 */
class WorkspaceStore {
  readonly workspaces: Map<string, Workspace> = new Map();
  readonly deletingWorkspaceIds = new Set<string>();
  /** Local workspaces Komla is quitting with running, saved so the next launch can restart them. */
  readonly runningAtQuitIds = new Set<string>();
  private owner: WorkspaceStoreOwner | null = null;
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private pendingSave = false;
  private writePromise: Promise<void> = Promise.resolve();
  private persistenceTransactionActive = false;
  private readonly persistenceTransactionWaiters: Array<() => void> = [];
  private workspaceUpdateListeners = new Set<(workspace: Workspace) => void>();

  attach(owner: WorkspaceStoreOwner): void {
    this.owner = owner;
  }

  saveWorkspaces(): void {
    publishRemoteWorkspaceChange();
    // Debounce saves to avoid excessive disk writes
    this.pendingSave = true;
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      void this.doSaveWorkspaces();
    }, SAVE_DEBOUNCE_MS);
  }

  // Immediate save for existing best-effort callers such as cleanup and deletion.
  saveWorkspacesImmediate(): Promise<void> {
    publishRemoteWorkspaceChange();
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    return this.doSaveWorkspaces();
  }

  // Checked immediate save for transactions that must roll back when persistence fails.
  saveWorkspacesImmediateChecked(): Promise<void> {
    publishRemoteWorkspaceChange();
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    return this.doSaveWorkspaces(true);
  }

  async withPersistenceTransaction<T>(
    transaction: (save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    return this.withPersistenceLock(() =>
      transaction(() => {
        publishRemoteWorkspaceChange();
        if (this.saveDebounceTimer) {
          clearTimeout(this.saveDebounceTimer);
          this.saveDebounceTimer = null;
        }
        return this.doSaveWorkspacesUnlocked(true);
      })
    );
  }

  private doSaveWorkspaces(propagateError = false): Promise<void> {
    return this.withPersistenceLock(() => this.doSaveWorkspacesUnlocked(propagateError));
  }

  private async withPersistenceLock<T>(transaction: () => Promise<T>): Promise<T> {
    if (this.persistenceTransactionActive) {
      await new Promise<void>((resolve) => this.persistenceTransactionWaiters.push(resolve));
    } else {
      this.persistenceTransactionActive = true;
    }
    try {
      return await transaction();
    } finally {
      const next = this.persistenceTransactionWaiters.shift();
      if (next) next();
      else this.persistenceTransactionActive = false;
    }
  }

  private doSaveWorkspacesUnlocked(propagateError = false): Promise<void> {
    this.pendingSave = false;
    this.owner?.saving(this.workspaces.values());
    try {
      // Local terminals are ephemeral. SSH terminal identities are durable because
      // their managed tmux sessions can outlive the local Komla process.
      if (!this.owner) throw new Error('The workspace store has no owner to save for');
      const { workspacesPath, persistedSources } = this.owner;
      const workspacesList = Array.from(this.workspaces.values()).map((w) =>
        serializeWorkspace(w, persistedSources, this.runningAtQuitIds.has(w.id))
      );

      // Serialize async writes to prevent concurrent writes racing on the same .tmp file
      const data = JSON.stringify(workspacesList, null, 2);
      const write = this.writePromise.then(() => writeFileAtomic(workspacesPath, data));
      this.writePromise = write.catch((error) => {
        logger.error('Failed to save workspaces:', error);
      });
      return propagateError ? write : this.writePromise;
    } catch (error) {
      logger.error('Failed to save workspaces:', error);
      return propagateError ? Promise.reject(error) : this.writePromise;
    }
  }

  readPersistedWorkspaces(): PersistedWorkspace[] | null {
    const workspacesPath = this.owner?.workspacesPath;
    if (!workspacesPath || !existsSync(workspacesPath)) return null;
    const data = readFileSync(workspacesPath, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      logger.error('Workspaces file is not an array, resetting to empty list');
      return null;
    }
    const workspacesList: PersistedWorkspace[] = [];
    for (const item of parsed) {
      if (isValidPersistedWorkspace(item)) {
        workspacesList.push(item);
      } else {
        logger.warn('Skipping invalid workspace entry in workspaces.json', {
          id: (item as Record<string, unknown>)?.['id'],
        });
      }
    }
    return workspacesList;
  }

  /** Calls `listener` with each workspace update broadcast to the windows, until unsubscribed. */
  onWorkspaceUpdated(listener: (workspace: Workspace) => void): () => void {
    this.workspaceUpdateListeners.add(listener);
    return () => this.workspaceUpdateListeners.delete(listener);
  }

  /** Broadcast a workspace update to all renderer windows. */
  broadcastWorkspaceUpdate(workspace: Workspace): void {
    publishRemoteWorkspaceChange();
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.WORKSPACE_UPDATED, workspace);
      }
    }
    notifyListeners(this.workspaceUpdateListeners, workspace);
  }

  broadcastWorkspacesChanged(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.WORKSPACES_CHANGED);
      }
    }
  }

  countWorkspaces(predicate: (workspace: Workspace) => boolean): number {
    let count = 0;
    for (const ws of this.workspaces.values()) {
      if (predicate(ws)) count++;
    }
    return count;
  }

  getRunningWorkspaceCount(): number {
    return this.countWorkspaces(isRunningHere);
  }

  /** SSH workspaces running on their hosts, the ones the free plan limits. */
  getRunningRemoteWorkspaceCount(): number {
    return this.countWorkspaces(isRunningOnSshHost);
  }

  // Find which workspace a terminal belongs to
  findWorkspaceByTerminalId(terminalId: string): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.terminals.some((t) => t.id === terminalId)) {
        return workspace;
      }
    }
    return undefined;
  }

  // Get terminal by ID
  getTerminal(terminalId: string): Terminal | undefined {
    for (const workspace of this.workspaces.values()) {
      const terminal = workspace.terminals.find((t) => t.id === terminalId);
      if (terminal) {
        return terminal;
      }
    }
    return undefined;
  }

  getWorkspacesByProjectId(projectId: string): Workspace[] {
    return Array.from(this.workspaces.values()).filter(
      (workspace) => workspace.projectId === projectId
    );
  }

  list(): Workspace[] {
    // Update terminal statuses from PTY service
    for (const workspace of this.workspaces.values()) {
      for (const terminal of workspace.terminals) {
        const ptyStatus = this.owner?.terminalStatus(terminal.id);
        if (ptyStatus) terminal.status = ptyStatus;
      }
    }
    return Array.from(this.workspaces.values());
  }

  get(workspaceId: string): Workspace | undefined {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      // Update terminal statuses
      for (const terminal of workspace.terminals) {
        const ptyStatus = this.owner?.terminalStatus(terminal.id);
        if (ptyStatus) terminal.status = ptyStatus;
      }
    }
    return workspace;
  }

  isDeleting(workspaceId: string): boolean {
    return this.deletingWorkspaceIds.has(workspaceId);
  }

  getDiagnostics(): {
    workspaceCount: number;
    runningWorkspaceCount: number;
    stoppedWorkspaceCount: number;
    trashedWorkspaceCount: number;
    terminalCount: number;
    pendingSave: boolean;
  } {
    let runningWorkspaceCount = 0;
    let stoppedWorkspaceCount = 0;
    let trashedWorkspaceCount = 0;
    let terminalCount = 0;

    for (const workspace of this.workspaces.values()) {
      if (workspace.status === 'trashed') trashedWorkspaceCount++;
      else if (workspace.status === 'active') {
        if (isRunningHere(workspace)) runningWorkspaceCount++;
        else stoppedWorkspaceCount++;
      }
      terminalCount += workspace.terminals.length;
    }

    return {
      workspaceCount: this.workspaces.size,
      runningWorkspaceCount,
      stoppedWorkspaceCount,
      trashedWorkspaceCount,
      terminalCount,
      pendingSave: this.pendingSave,
    };
  }

  /** Sets who a workspace is linked with and saves it, as `workspaceService.update` would. */
  updateLinkedWorkspaceIds(workspaceId: string, linkedWorkspaceIds: string[] | undefined): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    workspace.linkedWorkspaceIds = linkedWorkspaceIds;
    // Restarting a workspace from the Trash leaves this set until something next updates it.
    if (workspace.status !== 'trashed') workspace.trashedAt = undefined;
    this.saveWorkspaces();
  }
}

export const workspaceStore = new WorkspaceStore();
