import type {
  SshWorkspaceBackend,
  WorkspaceCustomNameSource,
  WorkspaceStatus,
  WorkspaceTerminalLayout,
} from './workspace';

/**
 * Portable description of an SSH workspace, written to
 * `<base path>/workspaces/<workspaceId>.json` on its host so another Komla
 * installation can adopt it. Installation-local ids (host, project, window)
 * are deliberately absent.
 */
export interface SshWorkspaceManifest {
  schema: 1;
  workspaceId: string;
  name: string;
  customName?: string;
  customDescription?: string;
  customNameSource?: WorkspaceCustomNameSource;
  branchName?: string;
  baseBranch?: string;
  repoName?: string;
  backend: Omit<SshWorkspaceBackend, 'kind' | 'hostId' | 'projectId'>;
  terminals: Array<{
    id: string;
    name: string;
    createdAt: number;
    layoutHint?: 'tab' | 'split-right' | 'split-bottom';
  }>;
  primaryTerminalId?: string;
  terminalLayout?: WorkspaceTerminalLayout;
  status?: WorkspaceStatus;
  createdAt: number;
  updatedAt: number;
  /** The installation that wrote this copy, so others know which changes to merge. */
  writtenBy?: string;
  /**
   * The installation that wrote this copy syncs with the host. Others merge
   * only such copies; one without it may hold changes it never took in.
   */
  syncs?: boolean;
  /**
   * The installation that wrote this copy syncs how tabs and panes are
   * arranged. Older ones keep their own, so others don't take theirs.
   */
  syncsLayout?: boolean;
  /**
   * How to start another agent like this workspace's. The host's `komla` CLI
   * uses it to create workspaces while no Komla installation is connected.
   */
  launch?: SshWorkspaceLaunch;
  /** The workspace an agent created this one from on the host. */
  sourceWorkspaceId?: string;
  /** Created on the host while Komla was disconnected; the next installation to connect adds it. */
  adoptOnConnect?: boolean;
}

/** An agent preset's POSIX launch commands, resolved for one workspace. */
export interface SshWorkspaceLaunch {
  agentName: string;
  /** Command line with a `{{prompt}}` placeholder for a shell-quoted prompt. */
  promptCommand: string;
  /** Command line that starts the agent without a prompt. */
  openCommand: string;
  /** Command line that resumes the agent's last session, for starting the workspace again. */
  continueCommand?: string;
}

/** A workspace found on an SSH host, as listed for adoption. */
export interface RemoteSshWorkspace {
  workspaceId: string;
  name: string;
  branchName?: string;
  repoName?: string;
  terminalCount: number;
  updatedAt: number;
  /** True when this installation already has the workspace. */
  adopted: boolean;
  /** Deleting the host's Komla data would delete it on another device too. */
  mayBeOnOtherDevices: boolean;
}

/**
 * Sent to the renderer when another device opened agent tabs in a workspace,
 * `terminalIds`, or `arranged` its tabs and panes.
 */
export interface SshWorkspaceLayoutChangedOnOtherDevice {
  workspaceId: string;
  terminalIds: string[];
  arranged: boolean;
}

/** Sent to the renderer after an SSH workspace another device deleted is removed here. */
export interface SshWorkspaceRemovedOnOtherDevice {
  workspaceId: string;
  name: string;
}
