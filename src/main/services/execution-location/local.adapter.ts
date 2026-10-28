import { realpathSync } from 'fs';
import { basename, dirname, join } from 'path';

import { createLogger } from '../../lib/logger';

import { resolveLaunchVariables } from './launch-variables';

import type { AttachedExecutionLocation } from './execution-location';
import type { SshWorkspaceBackend, Workspace } from '../../../shared/types/workspace';

const logger = createLogger('ExecutionLocation');

export interface LocalExecutionDependencies {
  getLocalCopyPath(workspace: SshWorkspace): string;
  prepareLocalCopy(workspace: SshWorkspace): Promise<unknown>;
  initializeLocalCopy(workspace: SshWorkspace): Promise<unknown>;
  ensureLocalCopyInitialSync(workspace: SshWorkspace): void;
  isWslMode(): boolean;
  windowsPathToWsl(path: string): string;
  pty: {
    spawn(terminalId: string, cwd: string, command: string | null): void;
    restart(
      terminalId: string,
      cwd: string,
      command: string | null,
      workspaceId: string,
      cols?: number,
      rows?: number
    ): void;
    kill(terminalId: string): void;
    releaseTerminal(terminalId: string): void;
    releaseTerminalAndWait(terminalId: string): Promise<void>;
  };
  background: {
    spawn(
      workspaceId: string,
      command: string,
      cwd: string,
      name: string,
      callbacks: { onData(data: string): void; onExit(event: { exitCode: number }): void }
    ): { stop(): Promise<void> };
  };
}

type SshWorkspace = Workspace & { backend: SshWorkspaceBackend };

export type LocalExecutionRoot =
  | { kind: 'workspace' }
  | {
      kind: 'local-copy';
      // Looked up lazily: looking up the Local copy path reserves its folder.
      path: () => string;
      prepare: (command: string | null) => Promise<void>;
      ensureInitialSync: () => void;
    };

/**
 * Execution on this computer: a local Workspace repository, or an SSH
 * workspace's Local copy.
 */
export function createLocalExecution(
  workspace: Workspace,
  root: LocalExecutionRoot,
  dependencies: LocalExecutionDependencies
): AttachedExecutionLocation {
  const workspacePath = (): string => {
    const directoryPath = root.kind === 'local-copy' ? root.path() : workspace.workingDirectory;
    const launchPath = canonicalizeLaunchPath(directoryPath);
    return dependencies.isWslMode() ? dependencies.windowsPathToWsl(launchPath) : launchPath;
  };

  const resolveVariables = (command: string | null) =>
    resolveLaunchVariables(command, workspacePath, 'desktop');

  const buildCommand: AttachedExecutionLocation['buildCommand'] = (
    rawCommand,
    { commandKind = 'agent' } = {}
  ) => {
    const command = resolveVariables(rawCommand);
    if (root.kind === 'local-copy') return { command };
    return commandKind === 'host-shell' ? { command: null } : { command };
  };

  // PTYs start in the configured directory; only {{workspacePath}} is canonicalized.
  const spawnCwd = () => (root.kind === 'local-copy' ? root.path() : workspace.workingDirectory);
  const afterLaunch = () => {
    if (root.kind === 'local-copy') root.ensureInitialSync();
  };

  return {
    managesSession: false,
    shellFamily: 'desktop',
    workingDirectory: spawnCwd,
    workspacePath,
    resolveLaunchVariables: resolveVariables,
    buildCommand,
    ...(root.kind === 'local-copy' ? { prepare: root.prepare } : {}),
    runBackground({ name, command, onData, onExit }) {
      const process = dependencies.background.spawn(workspace.id, command, spawnCwd(), name, {
        onData,
        onExit: ({ exitCode }) => onExit(exitCode),
      });
      return { stop: () => process.stop() };
    },
    spawn({ terminalId, command, releaseStartSlot }) {
      try {
        dependencies.pty.spawn(terminalId, spawnCwd(), command.command);
      } finally {
        releaseStartSlot();
      }
      afterLaunch();
    },
    restart({ workspaceId, terminalId, command, cols, rows, releaseStartSlot }) {
      try {
        dependencies.pty.restart(terminalId, spawnCwd(), command.command, workspaceId, cols, rows);
      } finally {
        releaseStartSlot();
      }
      afterLaunch();
    },
    stop: (terminalId) => dependencies.pty.kill(terminalId),
    release: (terminalId) => dependencies.pty.releaseTerminal(terminalId),
  };
}

function canonicalizeLaunchPath(directoryPath: string): string {
  let candidate = directoryPath;
  const missingSegments: string[] = [];
  let originalError: unknown;
  while (true) {
    try {
      return join(realpathSync(candidate), ...missingSegments);
    } catch (error) {
      originalError ??= error;
      const parent = dirname(candidate);
      if (parent === candidate) break;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
  logger.warn(`Could not canonicalize workspace path ${directoryPath}:`, originalError);
  return directoryPath;
}
