import type { AgentPreset, Workspace } from '@/types';

export type WorkspaceRestartAgent = 'resume' | 'start' | 'none';

// Presets are read from disk without a schema, so either command can be missing.
export function getWorkspaceRestartAgent(
  preset: Partial<Pick<AgentPreset, 'openCommand' | 'continueCommand'>> | null | undefined
): WorkspaceRestartAgent {
  const continueCommand = preset?.continueCommand?.trim();
  if (!continueCommand) return 'none';
  // A continue command that only repeats the open command starts a new session.
  return continueCommand === preset?.openCommand?.trim() ? 'start' : 'resume';
}

/**
 * Retrying an agent whose session ended resumes its last session once a prompt has been
 * submitted in its Terminal. Before that there is no session of its own to resume, so it starts
 * one rather than take over another pane's.
 */
export function retryResumesAgent(
  workspace: Pick<Workspace, 'promptSubmits'>,
  terminalId: string,
  preset: Parameters<typeof getWorkspaceRestartAgent>[0]
): boolean {
  return (
    !!workspace.promptSubmits?.some((submit) => submit.terminalId === terminalId) &&
    getWorkspaceRestartAgent(preset) === 'resume'
  );
}

const RESTART_DESCRIPTIONS: Record<WorkspaceRestartAgent, { local: string; ssh: string }> = {
  resume: {
    local: 'Resuming agent session',
    ssh: 'Connecting to the remote host and resuming agent session',
  },
  start: {
    local: 'Starting agent',
    ssh: 'Connecting to the remote host and starting agent',
  },
  none: {
    local: 'Starting shell',
    ssh: 'Connecting to the remote host and starting shell',
  },
};

export function getWorkspaceRestartDescription(
  isSsh: boolean,
  restartAgent: WorkspaceRestartAgent
): string {
  const descriptions = RESTART_DESCRIPTIONS[restartAgent];
  return isSsh ? descriptions.ssh : descriptions.local;
}
