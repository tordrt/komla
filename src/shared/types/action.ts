export type ActionType = 'prompt' | 'command';

// For command-type actions in SSH workspaces: where the command runs, overriding the
// project's "Run Terminal Commands on" choice. Undefined = follow the project.
// 'local-copy' is the Local copy, and falls back to the remote machine when the host can't keep
// one.
export const ACTION_SSH_EXECUTION_LOCATIONS = ['remote', 'local-copy'] as const;
export type ActionSshExecutionLocation = (typeof ACTION_SSH_EXECUTION_LOCATIONS)[number];

export interface Action {
  id: string;
  title: string;
  content: string;
  type?: ActionType;
  projectIds?: string[];
  /** When it last ran. Picks the run button's Action, which pasting doesn't change. */
  lastUsedAt?: number;
  /** When it was last pasted into a terminal, which counts toward the Quick Commands list's order. */
  lastPastedAt?: number;
  lastUserInput?: string;
  presetId?: string;
  launchModeId?: string;
  sshExecutionLocation?: ActionSshExecutionLocation;
  /** Command Actions only: run without a terminal tab and notify when the command ends. */
  background?: boolean;
}
