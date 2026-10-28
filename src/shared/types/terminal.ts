/**
 * Terminal-related types shared between main and renderer processes.
 */

import type { WorkspaceAttention } from './workspace';

export type TerminalStatus = 'starting' | 'running' | 'stopped';
export type TerminalExecutionLocation = 'workspace' | 'local-mirror';
/** Launch-time target. `remote` explicitly bypasses an SSH project's Local copy policy. */
export type TerminalLaunchLocation = TerminalExecutionLocation | 'remote';

export function isLocalTerminalExecutionLocation(
  location: TerminalExecutionLocation | undefined
): boolean {
  return location === 'local-mirror';
}

export interface TerminalHostInfo {
  hostname: string;
  isLocal: boolean;
}

export interface Terminal {
  id: string;
  name: string;
  status: TerminalStatus;
  dynamicTitle?: string;
  createdAt: number;
  layoutHint?: 'tab' | 'split-right' | 'split-bottom';
  /** Where this terminal executes. Undefined means the workspace's normal location. */
  executionLocation?: TerminalExecutionLocation;
  /** Startup failure shown in the terminal pane when no PTY could be created. */
  startupError?: string;
  /** Why its SSH connection last failed or dropped, until it runs again. Not saved. */
  connectionError?: string;
  // Terminal Execution State, stored as three fields. Only shared/lib/terminal-execution-state
  // reads them; ask its questions instead.
  /** Compatibility projection of Managed Remote Terminal Session presence. */
  remoteSessionActive?: boolean;
  /** Compatibility projection of Managed Remote Terminal Session persistence support. */
  remoteSessionResumable?: boolean;
  /**
   * Whether the last sync found this tab's tmux session on its SSH host while
   * this device wasn't attached, e.g. because another device runs it.
   */
  remoteSessionOnHost?: boolean;
  agentActive?: boolean;
  /** When the agent started processing, while `agentActive`. */
  agentActiveSince?: number;
  /** The spinner is on only for commands run with `komla notify --`, not for an agent. */
  commandActive?: boolean;
  attention?: WorkspaceAttention;
  /** Durable idempotency cursor for the latest accepted remote terminal hook. */
  lastAcceptedHookDeliveryId?: string;
}
