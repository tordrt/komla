import { substituteVariables, usesPowerShell } from '../../lib/workspace-launch-variables';

import type { Workspace } from '../../../shared/types/workspace';

export type ShellFamily = 'desktop' | 'posix';

// Antigravity CLI skips its folder-trust prompt when --add-dir names its
// working directory exactly, symlinks and junctions included, so the launch
// shell supplies the directory it is in rather than the canonical path.
function antigravityAutoTrustArgs(shellFamily: ShellFamily): string {
  return usesPowerShell(shellFamily) ? '--add-dir $PWD.ProviderPath' : '--add-dir "$PWD"';
}

/**
 * Expands the auto-trust placeholders for a POSIX shell started in the
 * workspace, for launches Komla prepares before the workspace path is known.
 */
export function resolvePosixAutoTrustArgs(command: string): string {
  return resolveAutoTrustArgs(command, 'posix');
}

/** Expands the auto-trust placeholders for a shell of the given family started in the workspace. */
export function resolveAutoTrustArgs(command: string, shellFamily: ShellFamily): string {
  return command.replaceAll('{{antigravityAutoTrustArgs}}', antigravityAutoTrustArgs(shellFamily));
}

/** The workspace's values a command, rather than an agent's prompt, can name. */
export interface CommandValues {
  branchName: string;
  projectName: string;
}

export interface CommandValuesDependencies {
  /** The name of the workspace's project, or '' without one. */
  projectName(workspace: Workspace): string;
}

export function commandValuesOf(
  workspace: Workspace,
  dependencies: CommandValuesDependencies
): () => CommandValues {
  return () => ({
    branchName: workspace.branchName || '',
    projectName: dependencies.projectName(workspace),
  });
}

const COMMAND_VARIABLE = /\{\{(?:workspacePath|worktreePath|branchName|projectName)\}\}/;

/**
 * Fills in `{{workspacePath}}`, and with `commandValues` also `{{worktreePath}}` (the same folder),
 * `{{branchName}}` and `{{projectName}}`, each quoted for the shell the command runs in.
 */
export function resolveLaunchVariables(
  launchCommand: string | null,
  workspacePath: () => string,
  shellFamily: ShellFamily,
  commandValues?: () => CommandValues
): string | null {
  if (!launchCommand) return launchCommand;
  const command = resolveAutoTrustArgs(launchCommand, shellFamily);
  const variable = commandValues ? COMMAND_VARIABLE : /\{\{workspacePath\}\}/;
  if (!variable.test(command)) return command;

  const path = workspacePath();
  return substituteVariables(
    command,
    commandValues
      ? { workspacePath: path, worktreePath: path, ...commandValues() }
      : { workspacePath: path },
    { shellEscape: true, shellFamily }
  ).trim();
}
