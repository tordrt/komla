import { WorkspaceSetupService } from './workspace-setup/automation';

import type { actionService } from './action.service';
import type { agentPresetService } from './agent-preset.service';
import type { backgroundProcessService } from './background-process.service';
import type { ExecutionLocations } from './execution-location';
import type { projectService } from './project.service';
import type { sshHostService } from './ssh-host.service';
import type { sshWorkspaceService } from './ssh-workspace.service';
import type {
  SetupActivityRun,
  SetupStep,
  Workspace,
  Terminal,
  TerminalExecutionLocation,
  AgentPreset,
} from '../../shared/types';
import type { CommandKind } from '../../shared/types/workspace';

/** Internal adapters supplied by the desktop composition root, not by Setup callers. */
export interface WorkspaceSetupDependencies {
  getWorkspace(workspaceId: string): Workspace | undefined;
  broadcastWorkspaceUpdate(workspace: Workspace): void;
  addTerminal(
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: Terminal['layoutHint'],
    commandKind?: CommandKind,
    executionLocation?: TerminalExecutionLocation,
    prepareBeforeLaunch?: () => Promise<void>,
    /** The Setup step it runs, whose place it takes in the workspace's saved layout. */
    setupStepId?: string
  ): Terminal | Promise<Terminal>;
  resolvePreset(presetId?: string | null, workspace?: Workspace): AgentPreset | undefined;
  resolveAgentCommand(
    preset: AgentPreset | undefined,
    prompt: string | undefined,
    launchModeId: string | undefined,
    reasoningLevelId?: string | null,
    modelId?: string | null
  ): string | null;
  locations: Pick<ExecutionLocations, 'resolve'>;
  prepareLocalCopy(workspaceId: string): Promise<string>;
  projects: Pick<typeof projectService, 'get'>;
  actions: Pick<typeof actionService, 'get'>;
  presets: Pick<typeof agentPresetService, 'get' | 'resolvePresetCommand'>;
  hosts: Pick<typeof sshHostService, 'get'>;
  ssh: Pick<typeof sshWorkspaceService, 'getRsyncTransport'>;
  background: Pick<typeof backgroundProcessService, 'killForWorkspace' | 'killForWorkspaceAndWait'>;
  /**
   * Writes a Secret file step's contents to its file where it runs, resolving with whether Git
   * ignores it there.
   */
  writeSecretFile(
    workspace: Workspace,
    step: SetupStep,
    destination: { cwd: string; executionLocation: TerminalExecutionLocation }
  ): Promise<{ gitIgnored?: boolean }>;
  /** Tells the user a background command Action's run ended. */
  notifyActionRunFinished(workspace: Workspace, run: SetupActivityRun): void;
}

export { WorkspaceSetupService };
export const workspaceSetupService = new WorkspaceSetupService();

export function configureWorkspaceSetup(dependencies: WorkspaceSetupDependencies): void {
  workspaceSetupService.configure(dependencies);
}
