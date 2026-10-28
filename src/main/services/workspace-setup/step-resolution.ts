import {
  buildProjectSetupPrompt,
  isProjectSetupPrompt,
} from '../../../shared/constants/project-setup-prompt';
import { isSshWorkspace } from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { substituteVariables } from '../../lib/workspace-launch-variables';

import type {
  SetupStep,
  SetupDestination,
  TerminalExecutionLocation,
  Workspace,
  Project,
  Action,
} from '../../../shared/types';
import type { CommandKind } from '../../../shared/types/workspace';
import type { WorkspaceSetupDependencies } from '../workspace-setup.service';

const logger = createLogger('WorkspaceSetupService');

export type ResolvedSetupStep = SetupStep & {
  commandKind: CommandKind;
  destinationResolution?: SetupDestinationResolution;
  validationError?: string;
};

interface SetupDestinationResolution {
  destination: SetupDestination;
  cwd: string;
  executionLocation: TerminalExecutionLocation;
  shellFamily: 'desktop' | 'posix';
  prepare?: () => Promise<void>;
  unsupportedReason?: string;
}

function getSetupDestination(step: SetupStep): SetupDestination {
  return step.destination ?? 'workspace-repository';
}

export class SetupStepResolver {
  constructor(private readonly dependencies: WorkspaceSetupDependencies) {}

  /**
   * `launchedAction` stands in for the step's saved Action with its launch values filled in, as
   * a terminal launch types it: Setup's variables aren't filled into it again.
   */
  resolve(
    step: SetupStep,
    workspace: Workspace,
    project: Project | undefined,
    strict = false,
    launchedAction?: Action
  ): ResolvedSetupStep | null {
    const reject = (message: string): null => {
      if (strict) throw new Error(message);
      logger.warn(`Setup step "${step.name}": ${message}`);
      return null;
    };
    let destinationResolution: SetupDestinationResolution | null;
    try {
      destinationResolution = this.resolveSetupDestination(step, workspace);
    } catch (error) {
      if (strict) throw error;
      return {
        ...step,
        commandKind: 'host',
        validationError: error instanceof Error ? error.message : String(error),
      };
    }
    if (!destinationResolution) return null;
    const action =
      launchedAction ?? (step.actionId ? this.dependencies.actions.get(step.actionId) : undefined);
    const resolved = this.resolveSetupStep(
      step,
      workspace,
      destinationResolution.shellFamily,
      action
    );
    if (!resolved) return null;

    const launchesAgent = Boolean(step.agent || (action && action.type !== 'command'));
    const runsOnDesktopForSsh = destinationResolution.destination === 'ssh-local-copy';
    if (launchesAgent && runsOnDesktopForSsh) {
      return reject('Agents and Saved Prompts must run in the Workspace repository');
    }
    const filled = launchedAction !== undefined;
    const desktopPathVariable = filled
      ? undefined
      : ['projectPath', 'localProjectPath'].find((variable) =>
          resolved.command.includes(`{{${variable}}}`)
        );
    if (destinationResolution.shellFamily === 'posix' && desktopPathVariable) {
      const message = `desktop-only {{${desktopPathVariable}}} cannot be used in an SSH command; use {{workspacePath}} or {{destinationPath}}`;
      if (strict) throw new Error(message);
      return {
        ...resolved,
        destinationResolution,
        validationError: message,
      };
    }

    const runsOnSshHost =
      isSshWorkspace(workspace) && destinationResolution.executionLocation === 'workspace';
    const forceHostCommand = runsOnDesktopForSsh || runsOnSshHost;
    const setupCommand = filled
      ? resolved.command
      : substituteVariables(
          resolved.command,
          this.getSetupVariables(workspace, project, destinationResolution),
          {
            shellEscape: true,
            shellFamily: destinationResolution.shellFamily,
          }
        );
    return {
      ...resolved,
      command:
        this.dependencies.locations
          .resolve(workspace, destinationResolution.executionLocation)
          .resolveLaunchVariables(setupCommand) ?? '',
      destinationResolution,
      ...(forceHostCommand ? { commandKind: 'host' as const } : {}),
    };
  }

  private resolveSetupDestination(
    step: SetupStep,
    workspace: Workspace
  ): SetupDestinationResolution | null {
    const destination = getSetupDestination(step);
    const ssh = isSshWorkspace(workspace);
    if (destination === 'local-workspace-repository' && ssh) return null;
    if (
      destination !== 'workspace-repository' &&
      destination !== 'local-workspace-repository' &&
      !ssh
    ) {
      return null;
    }
    if (!ssh) {
      return {
        destination,
        cwd: workspace.workingDirectory,
        executionLocation: 'workspace',
        shellFamily: 'desktop',
      };
    }
    if (destination === 'workspace-repository' || destination === 'ssh-workspace-repository') {
      return {
        destination,
        cwd: workspace.backend.remoteDirectory,
        executionLocation: 'workspace',
        shellFamily: 'posix',
      };
    }
    if (destination === 'ssh-local-copy') {
      const mirrorCapability = this.dependencies.hosts.get(workspace.backend.hostId)?.capabilities
        ?.localMirror;
      const unsupported =
        process.platform === 'win32' ||
        mirrorCapability?.platform === 'unsupported' ||
        mirrorCapability?.localRsync === 'missing' ||
        mirrorCapability?.remoteRsync === 'missing';
      const unsupportedReason = 'SSH Local copy requires rsync on this computer and the SSH host';
      return {
        destination,
        cwd: this.dependencies.locations.resolve(workspace, 'local-mirror').workingDirectory(),
        executionLocation: 'local-mirror',
        shellFamily: 'desktop',
        prepare: unsupported
          ? () => Promise.reject(new Error(unsupportedReason))
          : () => this.dependencies.prepareLocalMirror(workspace.id).then(() => undefined),
        ...(unsupported ? { unsupportedReason } : {}),
      };
    }
    logger.warn(`Unknown Setup destination: ${String(destination)}`);
    return null;
  }

  private getSetupVariables(
    workspace: Workspace,
    project: Project | undefined,
    destination: SetupDestinationResolution
  ): Record<string, string> {
    const ssh = isSshWorkspace(workspace);
    const workspacePath = ssh ? workspace.backend.remoteDirectory : workspace.workingDirectory;
    const sshTarget = ssh
      ? this.dependencies.ssh.getRsyncTransport(workspace.backend.hostId).remoteTarget
      : '';
    const sshPort = ssh
      ? String(this.dependencies.hosts.get(workspace.backend.hostId)?.port ?? 22)
      : '';
    return {
      destinationPath: destination.cwd,
      workspacePath,
      localProjectPath: project?.repositoryPath ?? '',
      remoteWorkspacePath: ssh ? workspacePath : '',
      sshTarget,
      sshPort,
      worktreePath: destination.cwd,
      projectPath: project?.repositoryPath ?? '',
      branchName: workspace.branchName || '',
      projectName: project?.name ?? '',
    };
  }

  /**
   * Resolve a single setup step into a ResolvedSetupStep, or null to skip.
   * Plain shell steps and command-type actions run as shell commands;
   * prompt-type actions resolve through the preset's launch mode + command.
   */
  private resolveSetupStep(
    step: SetupStep,
    workspace: Workspace,
    shellFamily: 'desktop' | 'posix',
    action: Action | undefined
  ): ResolvedSetupStep | null {
    if (step.agent) {
      const pinnedPresetId = step.agent.presetId;
      const pinnedPreset = pinnedPresetId
        ? this.dependencies.presets.get?.(pinnedPresetId)
        : undefined;
      const inheritsWorkspace = !pinnedPreset;
      if (pinnedPresetId && !pinnedPreset) {
        logger.warn(
          `Setup step "${step.name}" references deleted agent preset ${pinnedPresetId}, inheriting workspace agent`
        );
      }
      const preset = inheritsWorkspace
        ? this.dependencies.resolvePreset(null, workspace)
        : pinnedPreset;
      const launchModeId = inheritsWorkspace
        ? (workspace.launchModeId ?? undefined)
        : step.agent.launchModeId;
      const command =
        this.dependencies.resolveAgentCommand(
          preset,
          undefined,
          launchModeId,
          inheritsWorkspace ? workspace.reasoningLevelId : undefined
        ) ?? '';
      return { ...step, command, commandKind: 'agent' };
    }

    if (!step.actionId) {
      return { ...step, commandKind: 'host' };
    }

    if (!action) {
      logger.warn(`Setup step "${step.name}" references deleted action ${step.actionId}, skipping`);
      return null;
    }

    if (action.type === 'command') {
      return { ...step, command: action.content, commandKind: 'host' };
    }

    const resolvedCommand = this.resolvePromptActionCommand(action, workspace, shellFamily);
    if (!resolvedCommand) {
      logger.warn(
        `Setup step "${step.name}": no agent found, or it can't start with a prompt; skipping`
      );
      return null;
    }
    return { ...step, command: resolvedCommand, commandKind: 'agent' };
  }

  // Resolve a prompt-type action through its pinned target, or inherit the
  // workspace target when the action is unpinned or its preset was deleted.
  // A launch mode whose id no longer exists silently falls through to promptCommand
  // — matching addAgentTab's behaviour for stale ids.
  private resolvePromptActionCommand(
    action: Action,
    workspace: Workspace,
    shellFamily: 'desktop' | 'posix'
  ): string | null {
    const actionContent =
      isSshWorkspace(workspace) && isProjectSetupPrompt(action.content)
        ? buildProjectSetupPrompt()
        : action.content;
    const pinnedPreset = action.presetId
      ? this.dependencies.presets.get?.(action.presetId)
      : undefined;
    const inheritsWorkspace = !pinnedPreset;
    if (action.presetId && !pinnedPreset) {
      logger.warn(
        `Prompt action "${action.title}" references deleted agent preset ${action.presetId}, inheriting workspace agent`
      );
    }
    const preset = inheritsWorkspace
      ? this.dependencies.resolvePreset(null, workspace)
      : pinnedPreset;
    if (!preset) return null;
    const launchModeId = inheritsWorkspace ? workspace.launchModeId : action.launchModeId;
    return this.dependencies.presets.resolvePresetCommand(
      preset,
      'prompt',
      launchModeId,
      actionContent,
      shellFamily,
      inheritsWorkspace ? workspace.reasoningLevelId : undefined
    );
  }
}
