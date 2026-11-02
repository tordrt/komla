import { randomBytes } from 'crypto';

import {
  buildProjectSetupPrompt,
  isProjectSetupPrompt,
} from '../../../shared/constants/project-setup-prompt';
import { resolveSshWorkspaceMode } from '../../../shared/lib/ssh-workspace-mode';
import { encodeTerminalExecution } from '../../../shared/lib/terminal-execution-state';
import {
  isSshWorkspace,
  type CommandKind,
  type RestartTerminalOptions,
} from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { agentPresetService } from '../agent-preset.service';
import { configService } from '../config.service';
import { executionLocations } from '../execution-location';
import { managedRemoteTerminalLifecycleService } from '../managed-remote-terminal-lifecycle.service';
import { metricsCollectorService } from '../metrics-collector.service';
import { projectService } from '../project.service';
import { remoteWorkspaceObservationService } from '../remote-workspace-observation.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { worktreeWatcherService } from '../worktree-watcher.service';

import { resolveAgentCommand, resolveLaunchModeId, resolvePreset } from './agent-launch';
import { moveFolderIntoProject } from './projects';
import { workspaceStore } from './store';

import type { FreeSshSlots } from './free-ssh-slots';
import type { ManagedTmuxFindResult } from '../../../shared/lib/ssh-tmux-attach';
import type {
  AddAgentTabOptions,
  Terminal,
  TerminalExecutionLocation,
  TerminalLaunchLocation,
  TerminalStatus,
  Workspace,
} from '../../../shared/types';
import type { TerminalAttention } from '../terminal-attention/terminal-attention';

const logger = createLogger('WorkspaceService');

const TERMINAL_ID_RANDOM_BYTES = 9;

export interface WorkspaceTerminalsDeps {
  attention: TerminalAttention;
  slots: FreeSshSlots;
}

/** Starts, restarts and stops the Terminals of workspaces, including launches waiting on a Local copy. */
export class WorkspaceTerminals {
  private deferredTerminalLaunches = new Map<
    string,
    { token: symbol; mayHaveRemoteSession: boolean; onCancel: () => void }
  >();
  constructor(private readonly deps: WorkspaceTerminalsDeps) {}

  private beginDeferredTerminalLaunch(
    terminalId: string,
    mayHaveRemoteSession: boolean,
    onCancel: () => void
  ): symbol {
    this.cancelDeferredTerminalLaunch(terminalId);
    const token = Symbol(terminalId);
    this.deferredTerminalLaunches.set(terminalId, {
      token,
      mayHaveRemoteSession,
      onCancel,
    });
    return token;
  }

  private isDeferredTerminalLaunchCurrent(terminalId: string, token: symbol): boolean {
    return this.deferredTerminalLaunches.get(terminalId)?.token === token;
  }

  private finishDeferredTerminalLaunch(terminalId: string, token: symbol): void {
    if (this.isDeferredTerminalLaunchCurrent(terminalId, token)) {
      this.deferredTerminalLaunches.delete(terminalId);
    }
  }

  private cancelDeferredTerminalLaunch(
    terminalId: string
  ): { mayHaveRemoteSession: boolean } | undefined {
    const pending = this.deferredTerminalLaunches.get(terminalId);
    if (!pending) return undefined;
    this.deferredTerminalLaunches.delete(terminalId);
    pending.onCancel();
    return { mayHaveRemoteSession: pending.mayHaveRemoteSession };
  }

  cancelDeferredWorkspaceLaunches(workspace: Workspace): Set<string> {
    const terminalsWithoutRemoteSessions = new Set<string>();
    for (const terminal of workspace.terminals) {
      const pending = this.cancelDeferredTerminalLaunch(terminal.id);
      if (pending) terminal.status = 'stopped';
      if (pending && !pending.mayHaveRemoteSession) {
        terminalsWithoutRemoteSessions.add(terminal.id);
      }
    }
    return terminalsWithoutRemoteSessions;
  }

  private generateTerminalId(): string {
    let terminalId: string;
    do {
      terminalId = randomBytes(TERMINAL_ID_RANDOM_BYTES).toString('base64url');
    } while (workspaceStore.findWorkspaceByTerminalId(terminalId));
    return terminalId;
  }

  private getSshWorkspaceMode(workspace: Workspace) {
    const project = workspace.projectId ? projectService.get(workspace.projectId) : undefined;
    return resolveSshWorkspaceMode(
      configService.get().defaultSshWorkspaceMode,
      project?.sshWorkspaceMode
    );
  }

  // Find the lowest available terminal number for a workspace
  private nextTerminalNumber(workspace: Workspace): number {
    const usedNumbers = new Set(
      workspace.terminals
        .map((t) => {
          const match = t.name.match(/^Terminal (\d+)$/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((n): n is number => n !== null)
    );
    let n = 1;
    while (usedNumbers.has(n)) n++;
    return n;
  }

  addTerminal(
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    commandKind: CommandKind = 'agent',
    executionLocation: TerminalExecutionLocation = 'workspace',
    prepareBeforeLaunch?: () => Promise<void>
  ): Terminal | Promise<Terminal> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (workspaceStore.isDeleting(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} is being deleted`);
    }
    const location = executionLocations.resolve(workspace, executionLocation);

    const terminalId = this.generateTerminalId();

    // Resolve the spawn command FIRST — if this throws, we must not leave
    // behind a phantom terminal, inflated pendingRemoteStarts, or a saved
    // auto-activation that never actually started a PTY.
    const resolved = location.buildCommand(command ?? null, { commandKind, terminalId });

    // Check if the running workspace limit allows it (before auto-activating dormant state).
    const reservedStartSlot = this.deps.slots.reserveWorkspaceStartSlot(
      workspace,
      executionLocation
    );
    let startSlotReleased = false;
    const releaseStartSlot = () => {
      if (!reservedStartSlot || startSlotReleased) return;
      startSlotReleased = true;
      this.deps.slots.releaseStartSlot();
    };

    // Auto-activate dormant workspaces when starting (after license check passes)
    if (workspace.status !== 'active') {
      workspace.status = 'active';
      moveFolderIntoProject(workspace);
      this.deps.attention.workspaceStatusChanged();
      workspaceStore.saveWorkspaces();
      // Restart watcher (was stopped when workspace was made dormant)
      if (!isSshWorkspace(workspace)) {
        worktreeWatcherService
          .startWatching(workspaceId, workspace.workingDirectory)
          .catch((err) => {
            logger.error(
              `Failed to start watcher for auto-activated workspace ${workspaceId}:`,
              err
            );
          });
      }
    }

    const terminalNumber = this.nextTerminalNumber(workspace);
    const terminalName = name || `Terminal ${terminalNumber}`;

    const terminal: Terminal = {
      id: terminalId,
      name: terminalName,
      status: 'starting',
      createdAt: Date.now(),
      executionLocation,
      ...(layoutHint ? { layoutHint } : {}),
    };

    workspace.terminals.push(terminal);

    const spawnRequest = {
      workspaceId,
      terminalId,
      command: resolved,
      keepShellOpenAfterCommand: commandKind === 'host',
      releaseStartSlot,
    };

    if (location.managesSession) {
      try {
        location.spawn(spawnRequest);
        return terminal;
      } catch (error) {
        const terminalIndex = workspace.terminals.indexOf(terminal);
        if (terminalIndex !== -1) workspace.terminals.splice(terminalIndex, 1);
        void remoteWorkspaceObservationService.reconcile();
        throw error;
      }
    }

    const failDeferredTerminal = (error: unknown): Terminal => {
      terminal.status = 'stopped';
      terminal.startupError = error instanceof Error ? error.message : String(error);
      void remoteWorkspaceObservationService.reconcile();
      workspaceStore.saveWorkspaces();
      workspaceStore.broadcastWorkspacesChanged();
      return terminal;
    };

    const launchTerminal = (keepOnFailure = false): Terminal => {
      // Spawn PTY — on synchronous failure (e.g. invalid cwd, native pty
      // failure) remove the terminal we just pushed so the workspace doesn't
      // end up with a permanently-'starting' ghost tab.
      try {
        location.spawn(spawnRequest);
      } catch (err) {
        if (keepOnFailure) {
          return failDeferredTerminal(err);
        }
        const idx = workspace.terminals.indexOf(terminal);
        if (idx !== -1) workspace.terminals.splice(idx, 1);
        void remoteWorkspaceObservationService.reconcile();
        throw err;
      }

      // A Local copy Terminal of an SSH workspace is persisted with it.
      if (isSshWorkspace(workspace)) {
        workspaceStore.saveWorkspaces();
      }

      return terminal;
    };

    const deferredPreparation = prepareBeforeLaunch;

    if (deferredPreparation) {
      const launchToken = this.beginDeferredTerminalLaunch(terminal.id, false, releaseStartSlot);
      void deferredPreparation().then(
        () => {
          if (
            !this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken) ||
            workspaceStore.workspaces.get(workspaceId) !== workspace ||
            !workspace.terminals.includes(terminal) ||
            terminal.status !== 'starting'
          ) {
            releaseStartSlot();
            return terminal;
          }
          this.finishDeferredTerminalLaunch(terminal.id, launchToken);
          return launchTerminal(true);
        },
        (error) => {
          releaseStartSlot();
          if (
            !this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken) ||
            workspaceStore.workspaces.get(workspaceId) !== workspace ||
            !workspace.terminals.includes(terminal)
          ) {
            return terminal;
          }
          this.finishDeferredTerminalLaunch(terminal.id, launchToken);
          failDeferredTerminal(error);
          return terminal;
        }
      );
      return terminal;
    }

    return launchTerminal();
  }

  async addTerminalWithPreparation(
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    commandKind: CommandKind = 'agent',
    executionLocation: TerminalLaunchLocation = 'workspace'
  ): Promise<Terminal> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

    const effectiveLocation: TerminalExecutionLocation =
      executionLocation === 'remote'
        ? 'workspace'
        : isSshWorkspace(workspace) &&
            (executionLocation === 'local-mirror' ||
              (this.getSshWorkspaceMode(workspace) === 'local-mirror-actions' &&
                commandKind === 'host'))
          ? 'local-mirror'
          : executionLocation;
    const localCopyPreparation =
      effectiveLocation === 'local-mirror'
        ? () => {
            const location = executionLocations.resolve(workspace, effectiveLocation);
            return location.managesSession
              ? Promise.resolve()
              : (location.prepare?.(command ?? null) ?? Promise.resolve());
          }
        : undefined;
    return this.addTerminal(
      workspaceId,
      name,
      command,
      layoutHint,
      commandKind,
      effectiveLocation,
      localCopyPreparation
    );
  }

  // Add an agent tab to a workspace, resolving the command from the active preset.
  // keepWorkspaceAgent leaves the workspace's agent and the last agent used as they were,
  // for a one-off tab such as agent setup.
  addAgentTab(
    workspaceId: string,
    prompt?: string,
    launchModeId?: string,
    presetId?: string,
    { keepWorkspaceAgent = false, reasoningLevelId }: AddAgentTabOptions = {}
  ): Terminal | Promise<Terminal> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    const resolvedPresetId = presetId ?? workspace?.presetId;
    const activePreset = resolvePreset(resolvedPresetId);
    const effectivePrompt =
      workspace && isSshWorkspace(workspace) && isProjectSetupPrompt(prompt)
        ? buildProjectSetupPrompt()
        : prompt;
    const command = resolveAgentCommand(
      activePreset,
      effectivePrompt,
      launchModeId,
      workspace && isSshWorkspace(workspace) ? 'posix' : undefined,
      reasoningLevelId
    );

    // Apply the preset to the workspace BEFORE spawning. Stash the prior values
    // and restore them if spawn fails, otherwise a failed launch would
    // permanently corrupt the workspace's preset selection.
    const prevPresetId = workspace?.presetId;
    const prevLaunchModeId = workspace?.launchModeId;
    let persistChanges = false;
    if (workspace && !keepWorkspaceAgent) {
      if (activePreset && workspace.presetId !== activePreset.id) {
        workspace.presetId = activePreset.id;
        persistChanges = true;
      }
      const resolvedLaunchModeId = resolveLaunchModeId(activePreset, launchModeId);
      if (activePreset && (workspace.launchModeId ?? null) !== resolvedLaunchModeId) {
        workspace.launchModeId = resolvedLaunchModeId;
        persistChanges = true;
      }
    }

    const finish = (terminal: Terminal): Terminal => {
      if (persistChanges) {
        workspaceStore.saveWorkspaces();
      }
      metricsCollectorService.increment('agentTabsCreated');

      if (activePreset && !keepWorkspaceAgent) {
        agentPresetService.recordPresetUsage?.(activePreset.id, launchModeId);
      }

      return terminal;
    };
    const rollback = (error: unknown): never => {
      if (workspace && persistChanges) {
        workspace.presetId = prevPresetId;
        workspace.launchModeId = prevLaunchModeId;
      }
      throw error;
    };

    try {
      const terminal = this.addTerminal(workspaceId, undefined, command);
      return terminal instanceof Promise ? terminal.then(finish, rollback) : finish(terminal);
    } catch (err) {
      return rollback(err);
    }
  }

  // Remove a terminal from a workspace
  async removeTerminal(workspaceId: string, terminalId: string): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found in workspace ${workspaceId}`);
    }

    const pendingLaunch = this.cancelDeferredTerminalLaunch(terminal.id);
    if (pendingLaunch) terminal.status = 'stopped';
    // Permanently tear down the Terminal's execution (idempotent - safe if not running)
    const released = executionLocations
      .resolve(workspace, terminal.executionLocation)
      .release(terminalId);
    if (released) await released;
    this.deps.attention.removed(workspaceId, terminalId);

    // Found again: session recovery can replace the list while the release runs.
    const terminalIndex = workspace.terminals.findIndex((t) => t.id === terminalId);
    if (terminalIndex !== -1) workspace.terminals.splice(terminalIndex, 1);

    // If the removed terminal was the primary, update to first remaining terminal
    if (workspace.primaryTerminalId === terminalId) {
      workspace.primaryTerminalId =
        workspace.terminals.length > 0 ? workspace.terminals[0].id : undefined;
    }
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspaceUpdate(workspace);
  }

  async stopTerminal(terminalId: string): Promise<void> {
    const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
    if (!workspace) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (terminal) {
      const pendingLaunch = this.cancelDeferredTerminalLaunch(terminal.id);
      if (pendingLaunch) terminal.status = 'stopped';
      const stopped = executionLocations
        .resolve(workspace, terminal.executionLocation)
        .stop(terminalId);
      if (stopped) await stopped;
      terminal.status = 'stopped';
      this.deps.attention.ended(terminalId);
      void remoteWorkspaceObservationService.reconcile();
    }
  }

  restartTerminal(
    terminalId: string,
    presetId?: string,
    launchModeId?: string,
    cols?: number,
    rows?: number,
    options: Partial<RestartTerminalOptions> & {
      plainShell?: boolean;
      sshAction?: 'reconnect' | 'replace';
    } = {}
  ): Terminal | Promise<Terminal> {
    const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
    if (!workspace) {
      throw new Error(`Terminal ${terminalId} not found`);
    }
    if (workspaceStore.isDeleting(workspace.id)) {
      throw new Error(`Workspace ${workspace.id} is being deleted`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`);
    }
    if (options.executionLocation === 'local-mirror') {
      return this.restartTerminalInLocalCopy(workspace, terminal, cols, rows);
    }
    // An agent always runs on the SSH host, so it moves a Local copy terminal back there, as
    // does a shell asked for there.
    if (
      isSshWorkspace(workspace) &&
      terminal.executionLocation === 'local-mirror' &&
      (options.executionLocation === 'workspace' ||
        (options.sshAction === 'replace' && !options.plainShell))
    ) {
      return this.restartTerminalOnHost(workspace, terminal, presetId, launchModeId, cols, rows, {
        ...options,
        // Asked only to move, it gets a shell there; a replacement without one starts an agent.
        plainShell: options.plainShell ?? options.sshAction !== 'replace',
        sshAction: 'replace',
      });
    }

    const replaceWithRemoteAgent =
      isSshWorkspace(workspace) && options.sshAction === 'replace' && !options.plainShell;
    if (replaceWithRemoteAgent) {
      terminal.executionLocation = 'workspace';
      terminal.startupError = undefined;
    }
    const location = executionLocations.resolve(workspace, terminal.executionLocation);

    const shouldCountAsStart = this.deps.slots.reserveWorkspaceStartSlot(
      workspace,
      terminal.executionLocation
    );
    let startSlotReleased = false;
    const releaseStartSlot = () => {
      if (!shouldCountAsStart || startSlotReleased) return;
      startSlotReleased = true;
      this.deps.slots.releaseStartSlot();
    };
    const activePreset = options.plainShell
      ? null
      : options.command !== undefined && !presetId
        ? undefined
        : resolvePreset(presetId, workspace);
    const command = options?.command ?? resolveAgentCommand(activePreset, undefined, launchModeId);
    const resolved = location.buildCommand(command, {
      commandKind: options?.commandKind ?? 'agent',
      terminalId,
    });

    const applyRestartMetadata = (): void => {
      this.deps.attention.replaced(terminalId);
      terminal.dynamicTitle = undefined;
    };
    if (!location.managesSession) {
      applyRestartMetadata();
      terminal.status = 'starting';
      terminal.startupError = undefined;
    }
    const completeRestart = (): Terminal => {
      let persistChanges = false;
      if (activePreset && workspace.presetId !== activePreset.id) {
        workspace.presetId = activePreset.id;
        persistChanges = true;
      }
      const resolvedLaunchModeId = resolveLaunchModeId(activePreset, launchModeId);
      if (activePreset && (workspace.launchModeId ?? null) !== resolvedLaunchModeId) {
        workspace.launchModeId = resolvedLaunchModeId;
        persistChanges = true;
      }
      if (persistChanges) workspaceStore.saveWorkspaces();
      if (activePreset) agentPresetService.recordPresetUsage?.(activePreset.id, launchModeId);
      return terminal;
    };
    if (!location.managesSession) {
      const launchTerminal = (): Terminal => {
        try {
          location.restart({
            workspaceId: workspace.id,
            terminalId,
            command: resolved,
            cols,
            rows,
            releaseStartSlot,
          });
        } catch (error) {
          terminal.status = 'stopped';
          void remoteWorkspaceObservationService.reconcile();
          throw error;
        }
        return completeRestart();
      };

      if (location.prepare) {
        const launchToken = this.beginDeferredTerminalLaunch(terminal.id, false, releaseStartSlot);
        return location
          .prepare(resolved.command)
          .then(() => {
            if (
              !this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken) ||
              workspaceStore.workspaces.get(workspace.id) !== workspace ||
              !workspace.terminals.includes(terminal) ||
              terminal.status !== 'starting'
            ) {
              releaseStartSlot();
              return terminal;
            }
            this.finishDeferredTerminalLaunch(terminal.id, launchToken);
            return launchTerminal();
          })
          .catch((error) => {
            if (this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken)) {
              this.finishDeferredTerminalLaunch(terminal.id, launchToken);
              terminal.status = 'stopped';
              terminal.startupError = error instanceof Error ? error.message : String(error);
            }
            releaseStartSlot();
            throw error;
          });
      }
      return launchTerminal();
    }
    const managedRequest = {
      workspaceId: workspace.id,
      terminalId,
      command: resolved,
      keepShellOpenAfterCommand: options.commandKind === 'host',
      cols,
      rows,
      releaseStartSlot,
      onAuthorized: applyRestartMetadata,
    };
    const launch =
      options.sshAction === 'reconnect'
        ? location.reconnect(managedRequest)
        : location.replace({ ...managedRequest, explicit: options.sshAction === 'replace' });
    const finishManagedRestart = (result: { kind: 'ready' | 'superseded' }): Terminal =>
      result.kind === 'ready' ? completeRestart() : terminal;
    return launch instanceof Promise
      ? launch.then(finishManagedRestart)
      : finishManagedRestart(launch);
  }

  /** Replaces a Terminal's remote session with a plain shell in the workspace's Local copy. */
  private async restartTerminalInLocalCopy(
    workspace: Workspace,
    terminal: Terminal,
    cols?: number,
    rows?: number
  ): Promise<Terminal> {
    if (!isSshWorkspace(workspace)) {
      throw new Error('Local terminals require an SSH workspace');
    }
    if (executionLocations.managesSession(workspace, terminal.executionLocation)) {
      const isCurrent = () =>
        !workspaceStore.isDeleting(workspace.id) &&
        workspaceStore.workspaces.get(workspace.id) === workspace &&
        workspace.terminals.includes(terminal);
      // Prepare first so a Local copy that cannot start leaves the remote session running.
      const localCopy = executionLocations.resolve(workspace, 'local-mirror');
      if (!localCopy.managesSession) await localCopy.prepare?.(null);
      if (!isCurrent()) return terminal;
      await executionLocations.resolve(workspace, terminal.executionLocation).stop(terminal.id, {
        skipTrackedAbsentSession: true,
      });
      if (!isCurrent()) return terminal;
      terminal.executionLocation = 'local-mirror';
      Object.assign(terminal, encodeTerminalExecution({ kind: 'moved-to-local-copy' }));
      workspaceStore.saveWorkspaces();
      void remoteWorkspaceObservationService.reconcile();
    }
    return this.restartTerminal(terminal.id, undefined, undefined, cols, rows, {
      plainShell: true,
      commandKind: 'host-shell',
    });
  }

  /**
   * Replaces a Local copy Terminal's shell with a session on the SSH host. The Local shell stops
   * first, so a host that can't be reached leaves the Terminal stopped on the host instead of
   * marked as on the host over a Local shell still running.
   */
  private async restartTerminalOnHost(
    workspace: Workspace,
    terminal: Terminal,
    presetId: string | undefined,
    launchModeId: string | undefined,
    cols: number | undefined,
    rows: number | undefined,
    options: Partial<RestartTerminalOptions> & { plainShell?: boolean; sshAction: 'replace' }
  ): Promise<Terminal> {
    const isCurrent = () =>
      !workspaceStore.isDeleting(workspace.id) &&
      workspaceStore.workspaces.get(workspace.id) === workspace &&
      workspace.terminals.includes(terminal);
    // A Local shell still waiting on its first sync must not start once the Terminal has moved.
    this.cancelDeferredTerminalLaunch(terminal.id);
    await executionLocations.resolve(workspace, terminal.executionLocation).stop(terminal.id);
    if (!isCurrent()) return terminal;
    terminal.executionLocation = 'workspace';
    terminal.startupError = undefined;
    workspaceStore.saveWorkspaces();
    void remoteWorkspaceObservationService.reconcile();
    return this.restartTerminal(terminal.id, presetId, launchModeId, cols, rows, {
      ...options,
      executionLocation: undefined,
    });
  }

  reconnectSshTerminal(
    terminalId: string,
    cols?: number,
    rows?: number
  ): Terminal | Promise<Terminal> {
    const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
    const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
    if (!workspace || !executionLocations.managesSession(workspace, terminal?.executionLocation)) {
      throw new Error(`SSH terminal ${terminalId} not found`);
    }
    return this.restartTerminal(terminalId, undefined, undefined, cols, rows, {
      plainShell: true,
      sshAction: 'reconnect',
    });
  }

  findInSshTerminal(terminalId: string, query: string): Promise<ManagedTmuxFindResult> {
    const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
    const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
    const backend = workspace?.backend;
    if (
      !workspace ||
      backend?.kind !== 'ssh' ||
      !executionLocations.managesSession(workspace, terminal?.executionLocation)
    ) {
      throw new Error(`SSH terminal ${terminalId} not found`);
    }
    return sshWorkspaceService.findInTerminalSession(backend, terminalId, query);
  }

  updateTerminal(terminalId: string, updates: Partial<Omit<Terminal, 'id'>>): Terminal {
    const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
    if (!workspace) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    Object.assign(terminal, updates);
    return terminal;
  }

  updateTerminalStatus(terminalId: string, status: TerminalStatus): void {
    const terminal = workspaceStore
      .findWorkspaceByTerminalId(terminalId)
      ?.terminals.find((t) => t.id === terminalId);
    if (terminal && status === 'running') terminal.connectionError = undefined;
    if (managedRemoteTerminalLifecycleService.attachmentStatusChanged(terminalId, status)) return;
    if (terminal) terminal.status = status;
  }
}
