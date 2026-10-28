import { createLogger } from '../lib/logger';

import { ManagedRemoteTerminalLifecycleService } from './managed-remote-terminal-lifecycle/lifecycle';
import { getKomlaBasePath } from './paths';
import { ptyService } from './pty.service';
import { sshWorkspaceService } from './ssh-workspace.service';

import type {
  ManagedRemoteTerminalLifecycleAdapters,
  ManagedRemoteTerminalWorkspaceAdapter,
} from './managed-remote-terminal-lifecycle/lifecycle';

export * from './managed-remote-terminal-lifecycle/lifecycle';

const logger = createLogger('ManagedRemoteTerminalLifecycleService');

const unconfiguredWorkspaceAdapter: ManagedRemoteTerminalWorkspaceAdapter = {
  findTerminal: () => undefined,
  findWorkspace: () => undefined,
  changed: () => undefined,
  prepareObservationBestEffort: () => Promise.resolve(),
  prepareObservationInBackground: () => undefined,
  reconcileObservation: () => undefined,
};

const productionAdapters: ManagedRemoteTerminalLifecycleAdapters = {
  workspace: unconfiguredWorkspaceAdapter,
  session: {
    hasHost: (backend) => sshWorkspaceService.hasHost(backend.hostId),
    supportsPersistence: (backend) =>
      sshWorkspaceService.supportsPersistentTerminalSessions(backend),
    observe: (backend, terminalIds) =>
      sshWorkspaceService.findTerminalSessions(backend, terminalIds),
    stopAndConfirmAbsent: (backend, terminalIds) =>
      sshWorkspaceService.killTerminalSessions(backend, terminalIds),
    buildAttachment: (request) => ({
      cwd: getKomlaBasePath(),
      ...sshWorkspaceService.buildTerminalLaunchCommand(
        request.backend,
        request.command,
        request.terminalId,
        request.workspaceId,
        request.action,
        {
          keepShellOpenAfterCommand: request.keepShellOpenAfterCommand,
          ...(request.companion ? { companion: request.companion } : {}),
        }
      ),
    }),
  },
  attachment: {
    spawn: (request) =>
      ptyService.spawn(
        request.terminalId,
        request.cwd,
        request.command,
        [],
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        request.startupMode,
        request.localLoginShell
      ),
    replace: (request) =>
      ptyService.restart(
        request.terminalId,
        request.cwd,
        request.command,
        request.workspaceId,
        request.cols,
        request.rows,
        request.startupMode,
        request.localLoginShell
      ),
    stop: (terminalId) => ptyService.kill(terminalId),
    release: (terminalId) => ptyService.releaseTerminalAndWait(terminalId),
  },
};

export const managedRemoteTerminalLifecycleService = new ManagedRemoteTerminalLifecycleService(
  productionAdapters
);

export function configureManagedRemoteTerminalLifecycle(
  workspace: ManagedRemoteTerminalWorkspaceAdapter
): void {
  Object.assign(unconfiguredWorkspaceAdapter, workspace);
  logger.debug('Configured Workspace adapter');
}
