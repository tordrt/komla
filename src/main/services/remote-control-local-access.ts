import {
  resolveSshWorkspaceMode,
  type SshWorkspaceMode,
} from '../../shared/lib/ssh-workspace-mode';
import {
  isSshWorkspace,
  type Workspace,
  type WorkspaceAttention,
} from '../../shared/types/workspace';

import type { Project } from '../../shared/types/project';
import type { Terminal } from '../../shared/types/terminal';

interface LocalAccessConfig {
  directRemoteLocalAccess?: boolean;
  defaultSshWorkspaceMode?: SshWorkspaceMode;
}

/** Settings → Remote → "Allow access to this computer", which is on unless turned off. */
export function remoteLocalAccessAllowed(config: LocalAccessConfig): boolean {
  return config.directRemoteLocalAccess !== false;
}

/** Whether paired devices may see a workspace: any, or only SSH ones while this computer is off limits. */
export function remoteMayOpenWorkspace(
  config: LocalAccessConfig,
  workspace: Pick<Workspace, 'backend'>
): boolean {
  return remoteLocalAccessAllowed(config) || isSshWorkspace(workspace);
}

/** A Local copy shell in an SSH workspace runs on this computer, so it is off limits too. */
export function remoteMayOpenTerminal(
  config: LocalAccessConfig,
  workspace: Pick<Workspace, 'backend'>,
  terminal: Pick<Terminal, 'executionLocation'>
): boolean {
  return (
    remoteLocalAccessAllowed(config) ||
    (isSshWorkspace(workspace) && terminal.executionLocation !== 'local-mirror')
  );
}

/** Attention from a terminal devices may not open doesn't reach them either. */
export function remoteMayOpenAttention(
  config: LocalAccessConfig,
  workspace: Pick<Workspace, 'backend' | 'terminals'>,
  attention: Pick<WorkspaceAttention, 'terminalId'>
): boolean {
  if (!remoteMayOpenWorkspace(config, workspace)) return false;
  const terminal = attention.terminalId
    ? workspace.terminals.find((candidate) => candidate.id === attention.terminalId)
    : undefined;
  return !terminal || remoteMayOpenTerminal(config, workspace, terminal);
}

/** A command Action in an SSH workspace runs in its Local copy when the project sends Actions there. */
export function remoteMayRunActionCommand(
  config: LocalAccessConfig,
  workspace: Pick<Workspace, 'backend'>,
  project: Pick<Project, 'sshWorkspaceMode'> | undefined
): boolean {
  return (
    remoteLocalAccessAllowed(config) ||
    (isSshWorkspace(workspace) &&
      resolveSshWorkspaceMode(config.defaultSshWorkspaceMode, project?.sshWorkspaceMode) !==
        'local-mirror-actions')
  );
}
