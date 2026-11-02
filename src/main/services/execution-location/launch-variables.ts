import { substituteVariables, usesPowerShell } from '../../lib/workspace-launch-variables';

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

export function resolveLaunchVariables(
  launchCommand: string | null,
  workspacePath: () => string,
  shellFamily: ShellFamily
): string | null {
  if (!launchCommand) return launchCommand;
  const command = resolveAutoTrustArgs(launchCommand, shellFamily);
  if (!command.includes('{{workspacePath}}')) return command;

  return substituteVariables(
    command,
    { workspacePath: workspacePath() },
    { shellEscape: true, shellFamily }
  ).trim();
}
