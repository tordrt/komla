import { shellEscape } from '../../lib/workspace-launch-variables';

import { resolveLaunchVariables } from './launch-variables';

import type { ManagedRestartRequest, ManagedSessionExecutionLocation } from './execution-location';
import type { SshWorkspaceBackend, Workspace } from '../../../shared/types/workspace';
import type { ManagedRemoteTerminalLifecycleService } from '../managed-remote-terminal-lifecycle/lifecycle';
import type { sshHostService } from '../ssh-host.service';
import type { sshWorkspaceService } from '../ssh-workspace.service';

export interface SshExecutionDependencies {
  managedSessions: Pick<
    ManagedRemoteTerminalLifecycleService,
    'create' | 'reconnect' | 'replace' | 'stop' | 'release'
  >;
  hosts: Pick<typeof sshHostService, 'get'>;
  ssh: Pick<typeof sshWorkspaceService, 'runStreaming'> & {
    /** The shell lines that let a command on the host run `komla`. */
    komlaCliSetup(backend: SshWorkspaceBackend): string[];
  };
}

/**
 * Workspace repository execution on an SSH host, backed by Managed Remote
 * Terminal Sessions.
 */
export function createSshExecution(
  workspace: Workspace & { backend: SshWorkspaceBackend },
  { managedSessions, hosts, ssh }: SshExecutionDependencies
): ManagedSessionExecutionLocation {
  const workspacePath = () => workspace.backend.remoteDirectory;
  const resolveVariables = (command: string | null) =>
    resolveLaunchVariables(command, workspacePath, 'posix');
  const toLifecycleRequest = (request: ManagedRestartRequest) => ({
    terminalId: request.terminalId,
    command: request.command.command,
    keepShellOpenAfterCommand: request.keepShellOpenAfterCommand,
    cols: request.cols,
    rows: request.rows,
    releaseStartSlot: request.releaseStartSlot,
    onAuthorized: request.onAuthorized,
  });
  const confirmStopped = async (stopping: Promise<void>): Promise<void> => {
    try {
      await stopping;
    } catch (error) {
      throw new Error(
        `Could not confirm the remote agent stopped; it may still be running. ${String(error)}`
      );
    }
  };

  return {
    managesSession: true,
    shellFamily: 'posix',
    workingDirectory: workspacePath,
    workspacePath,
    resolveLaunchVariables: resolveVariables,
    buildCommand: (command) => ({ command: resolveVariables(command) }),
    runBackground({ command, onData, onExit, onError }) {
      const host = hosts.get(workspace.backend.hostId);
      if (!host) throw new Error(`SSH host ${workspace.backend.hostId} is not configured`);
      const controller = new AbortController();
      const completion = ssh
        .runStreaming(
          host,
          [
            `cd ${shellEscape(workspacePath(), 'posix')} || exit $?`,
            // So the command can run `komla`, as in the host's terminals.
            ...ssh.komlaCliSetup(workspace.backend),
            `export KOMLA_WORKSPACE_ID=${shellEscape(workspace.id, 'posix')}`,
            command,
          ].join('\n'),
          {
            signal: controller.signal,
            onData,
            onErrorData: onData,
            workspaceId: workspace.id,
          }
        )
        .then(() => onExit(0), onError);
      return {
        cancel() {
          controller.abort();
          return completion;
        },
      };
    },
    spawn({ workspaceId, terminalId, command, keepShellOpenAfterCommand, releaseStartSlot }) {
      const ticket = managedSessions.create({
        workspaceId,
        terminalId,
        command: command.command,
        keepShellOpenAfterCommand,
        releaseStartSlot,
      });
      void ticket.ready;
    },
    reconnect: (request) => managedSessions.reconnect(toLifecycleRequest(request)),
    replace: (request) =>
      managedSessions.replace({ ...toLifecycleRequest(request), explicit: request.explicit }),
    stop: (terminalId, options) =>
      confirmStopped(
        options?.skipTrackedAbsentSession
          ? managedSessions.stop({ terminalId }, { skipTrackedAbsentSessions: true })
          : managedSessions.stop({ terminalId })
      ),
    release: (terminalId) => confirmStopped(managedSessions.release({ terminalId })),
  };
}
