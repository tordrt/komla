import { isWslMode, windowsPathToWsl } from '../../lib/wsl';
import { backgroundProcessService } from '../background-process.service';
import { localMirrorService } from '../local-mirror.service';
import { managedRemoteTerminalLifecycleService } from '../managed-remote-terminal-lifecycle.service';
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
    localMirrorService.getMirrorPath(workspace.id, workspace.backend),
  prepareLocalCopy: (workspace) => localMirrorService.prepare(workspace.id, workspace.backend),
  initializeLocalCopy: (workspace) =>
    localMirrorService.initialize(workspace.id, workspace.backend),
  ensureLocalCopyInitialSync: (workspace) =>
    localMirrorService.ensureInitialSync(workspace.id, workspace.backend),
  isWslMode: () => isWslMode(),
  windowsPathToWsl: (path) => windowsPathToWsl(path),
  pty: {
    spawn: (terminalId, cwd, command) => ptyService.spawn(terminalId, cwd, command),
    restart: (terminalId, cwd, command, workspaceId, cols, rows) =>
      ptyService.restart(terminalId, cwd, command, workspaceId, cols, rows),
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
});
