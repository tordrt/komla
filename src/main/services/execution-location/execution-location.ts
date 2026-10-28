import { isSshWorkspace, type CommandKind, type Workspace } from '../../../shared/types/workspace';

import { createLocalExecution, type LocalExecutionDependencies } from './local.adapter';
import { createSshExecution, type SshExecutionDependencies } from './ssh.adapter';

import type { ShellFamily } from './launch-variables';
import type { Terminal, TerminalExecutionLocation } from '../../../shared/types/terminal';
import type { ManagedRemoteTerminalAttachmentResult } from '../managed-remote-terminal-lifecycle/types';

export type { ShellFamily };

export interface LaunchCommandOptions {
  commandKind?: CommandKind;
  terminalId?: string;
}

export interface LaunchCommand {
  command: string | null;
}

export interface SpawnTerminalRequest {
  workspaceId: string;
  terminalId: string;
  command: LaunchCommand;
  /** Keep a remote shell open after the command exits. */
  keepShellOpenAfterCommand: boolean;
  /** Called once the launch no longer needs its start slot, whether it succeeded or not. */
  releaseStartSlot: () => void;
}

export interface RestartTerminalRequest {
  workspaceId: string;
  terminalId: string;
  command: LaunchCommand;
  cols?: number;
  rows?: number;
  /** Called once the launch no longer needs its start slot, whether it succeeded or not. */
  releaseStartSlot: () => void;
}

export interface ManagedRestartRequest extends RestartTerminalRequest {
  keepShellOpenAfterCommand: boolean;
  /** Called when the restart is allowed to replace the Terminal's current execution. */
  onAuthorized: () => void;
}

export interface BackgroundRunRequest {
  /** Shown as the background process name. */
  name: string;
  command: string;
  onData: (chunk: string) => void;
  /** Called once when the command exits. */
  onExit: (exitCode: number) => void;
  /** Called once when the run fails without an exit code, or is cancelled (an AbortError). */
  onError: (error: unknown) => void;
}

export interface BackgroundRun {
  /**
   * Present when the run is cancelled on its own; other runs stop with the
   * workspace's background processes. Resolves once the run has settled.
   */
  cancel?: () => Promise<void>;
  /** Present when a local run can be stopped on its own, as when the user stops it. */
  stop?: () => Promise<void>;
}

interface ExecutionLocationBase {
  readonly shellFamily: ShellFamily;
  /** The directory execution starts in. */
  workingDirectory(): string;
  /** The directory commands see as `{{workspacePath}}`. */
  workspacePath(): string;
  /** Expands `{{workspacePath}}` and the agent auto-trust placeholders for this location. */
  resolveLaunchVariables(command: string | null): string | null;
  /** Expands launch variables for this location. */
  buildCommand(command: string | null, options?: LaunchCommandOptions): LaunchCommand;
  /** Starts a background command here. Throws when it cannot start. */
  runBackground(request: BackgroundRunRequest): BackgroundRun;
  /** Starts a new Terminal's execution here. Throws when the launch fails immediately. */
  spawn(request: SpawnTerminalRequest): void;
  /**
   * Stops a Terminal's execution. Returns a promise only when stopping must be confirmed.
   * `skipTrackedAbsentSession` skips confirming a remote session already seen to stop.
   */
  stop(terminalId: string, options?: { skipTrackedAbsentSession?: boolean }): Promise<void> | void;
  /** Permanently tears down a Terminal's execution before the Terminal is removed. */
  release(terminalId: string): Promise<void> | void;
}

/** Execution that lives only as long as its Terminal Attachment. */
export interface AttachedExecutionLocation extends ExecutionLocationBase {
  readonly managesSession: false;
  /** Present when launching here needs preparation first (a Local copy). */
  prepare?(command: string | null): Promise<void>;
  restart(request: RestartTerminalRequest): void;
}

/** Execution backed by a Managed Remote Terminal Session. */
export interface ManagedSessionExecutionLocation extends ExecutionLocationBase {
  readonly managesSession: true;
  reconnect(
    request: ManagedRestartRequest
  ): ManagedRemoteTerminalAttachmentResult | Promise<ManagedRemoteTerminalAttachmentResult>;
  replace(
    request: ManagedRestartRequest & { explicit: boolean }
  ): Promise<ManagedRemoteTerminalAttachmentResult>;
}

/**
 * Where a Terminal or Setup step runs for one workspace: its Workspace
 * repository or, for an SSH workspace, its Local copy.
 */
export type ExecutionLocation = AttachedExecutionLocation | ManagedSessionExecutionLocation;

export type ExecutionLocationDependencies = LocalExecutionDependencies & SshExecutionDependencies;

export interface ReleaseSessionsOptions {
  /** Release locally without waiting for the SSH host to confirm. */
  skipRemoteConfirmation?: boolean;
  /** Observe sessions in an unknown state before releasing them. */
  observeUnknownFirst?: boolean;
}

export interface ExecutionLocations {
  /** Throws when the location does not exist for the workspace. */
  resolve(workspace: Workspace, location?: TerminalExecutionLocation): ExecutionLocation;
  /** Whether execution at this location is backed by a Managed Remote Terminal Session. */
  managesSession(workspace: Workspace, location?: TerminalExecutionLocation): boolean;
  /**
   * Stops every Managed Remote Terminal Session in the workspace. Returns a
   * promise, rejected when a stop cannot be confirmed, only for a workspace
   * that has them.
   */
  stopSessions(workspace: Workspace): Promise<void> | void;
  /**
   * Stops every attached execution in the workspace and returns the
   * Terminals it belonged to.
   */
  stopAttached(workspace: Workspace): Terminal[];
  /**
   * Permanently tears down every Managed Remote Terminal Session in the
   * workspace. Returns a promise only for a workspace that has them.
   */
  releaseSessions(workspace: Workspace, options?: ReleaseSessionsOptions): Promise<void> | void;
  /**
   * Permanently tears down every attached execution in the workspace and
   * waits for it to exit, so its working directory can be removed. Returns a
   * promise only when there is attached execution to wait for.
   */
  releaseAttached(workspace: Workspace): Promise<void> | void;
}

export function createExecutionLocations(
  dependencies: ExecutionLocationDependencies
): ExecutionLocations {
  const managesSession = (workspace: Workspace, location?: TerminalExecutionLocation) =>
    isSshWorkspace(workspace) && location !== 'local-mirror';
  const attachedTerminals = (workspace: Workspace) =>
    workspace.terminals.filter(
      (terminal) => !managesSession(workspace, terminal.executionLocation)
    );

  return {
    resolve(workspace, location = 'workspace') {
      if (!isSshWorkspace(workspace)) {
        if (location === 'local-mirror') {
          throw new Error('Local terminals require an SSH workspace');
        }
        return createLocalExecution(workspace, { kind: 'workspace' }, dependencies);
      }
      if (location === 'local-mirror') {
        return createLocalExecution(
          workspace,
          {
            kind: 'local-copy',
            path: () => dependencies.getLocalCopyPath(workspace),
            prepare: (command) =>
              (command?.trim()
                ? dependencies.prepareLocalCopy(workspace)
                : dependencies.initializeLocalCopy(workspace)
              ).then(() => undefined),
            ensureInitialSync: () => dependencies.ensureLocalCopyInitialSync(workspace),
          },
          dependencies
        );
      }
      return createSshExecution(workspace, dependencies);
    },
    managesSession,
    stopSessions(workspace) {
      if (!isSshWorkspace(workspace)) return;
      return dependencies.managedSessions.stop({ workspaceId: workspace.id });
    },
    stopAttached(workspace) {
      const terminals = attachedTerminals(workspace);
      for (const terminal of terminals) dependencies.pty.kill(terminal.id);
      return terminals;
    },
    releaseSessions(workspace, options = {}) {
      if (!isSshWorkspace(workspace)) return;
      return dependencies.managedSessions.release({ workspaceId: workspace.id }, options);
    },
    releaseAttached(workspace) {
      const terminals = attachedTerminals(workspace);
      if (terminals.length === 0) return;
      return Promise.all(
        terminals.map((terminal) => dependencies.pty.releaseTerminalAndWait(terminal.id))
      ).then(() => undefined);
    },
  };
}
