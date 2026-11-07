import { isWslMode, windowsPathToWsl } from '../../lib/wsl';
import { backgroundProcessService } from '../background-process.service';
import { localCopyService } from '../local-copy.service';
import { managedRemoteTerminalLifecycleService } from '../managed-remote-terminal-lifecycle.service';
import { projectService } from '../project.service';
import { ptyService } from '../pty.service';
import { sshHostService } from '../ssh-host.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { remoteKomlaCliSetup } from '../workspace-command';

import { createExecutionLocations } from './execution-location';

export type {
  AttachedExecutionLocation,
  BackgroundRun,
  BackgroundRunRequest,
  ExecutionLocation,
  ExecutionLocations,
  LaunchCommand,
  LaunchCommandOptions,
  ManagedSessionExecutionLocation,
  ReleaseSessionsOptions,
  ShellFamily,
} from './execution-location';
export { createExecutionLocations } from './execution-location';

export const executionLocations = createExecutionLocations({
  getLocalCopyPath: (workspace) =>
    localCopyService.getLocalCopyPath(workspace.id, workspace.backend),
  prepareLocalCopy: (workspace) => localCopyService.prepare(workspace.id, workspace.backend),
  initializeLocalCopy: (workspace) => localCopyService.initialize(workspace.id, workspace.backend),
  ensureLocalCopyInitialSync: (workspace) =>
    localCopyService.ensureInitialSync(workspace.id, workspace.backend),
  isWslMode: () => isWslMode(),
  windowsPathToWsl: (path) => windowsPathToWsl(path),
  pty: {
    // Only a command bound for the shell history passes ptyService's trailing options; the rest
    // are left to its defaults.
    spawn: (terminalId, cwd, command, addToHistory) =>
      addToHistory
        ? ptyService.spawn(
            terminalId,
            cwd,
            command,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true
          )
        : ptyService.spawn(terminalId, cwd, command),
    restart: (terminalId, cwd, command, workspaceId, cols, rows, addToHistory) =>
      addToHistory
        ? ptyService.restart(
            terminalId,
            cwd,
            command,
            workspaceId,
            cols,
            rows,
            undefined,
            undefined,
            true
          )
        : ptyService.restart(terminalId, cwd, command, workspaceId, cols, rows),
    kill: (terminalId) => ptyService.kill(terminalId),
    releaseTerminal: (terminalId) => ptyService.releaseTerminal(terminalId),
    releaseTerminalAndWait: (terminalId) => ptyService.releaseTerminalAndWait(terminalId),
  },
  background: {
    spawn: (...args) => {
      const process = backgroundProcessService.spawn(...args);
      return { stop: () => backgroundProcessService.stop(process) };
    },
  },
  managedSessions: managedRemoteTerminalLifecycleService,
  hosts: { get: (hostId) => sshHostService.get(hostId) },
  ssh: {
    runStreaming: (...args) => sshWorkspaceService.runStreaming(...args),
    komlaCliSetup: remoteKomlaCliSetup,
  },
  projectName: (workspace) =>
    (workspace.projectId && projectService.get(workspace.projectId)?.name) || '',
});
