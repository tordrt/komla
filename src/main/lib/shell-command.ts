import { getShell, getShellArgs } from './shell';

function getShellBaseName(shell: string): string {
  return shell.split(/[\\/]/).pop()?.toLowerCase() ?? shell.toLowerCase();
}

/** The user's shell and the arguments that make it run `script` and exit. */
export function getConfiguredShellCommand(
  script: string,
  wslDistro?: string
): { shell: string; args: string[] } {
  const shell = getShell();
  const args = getShellArgs(wslDistro);
  const baseName = getShellBaseName(shell);

  if (baseName === 'pwsh' || baseName === 'pwsh.exe' || baseName === 'powershell.exe') {
    return { shell, args: [...args, '-Command', script] };
  }

  if (baseName === 'cmd' || baseName === 'cmd.exe') {
    return { shell, args: [...args, '/d', '/s', '/c', script] };
  }

  if (baseName === 'wsl' || baseName === 'wsl.exe') {
    return { shell, args: [...args, '--exec', 'sh', '-lc', script] };
  }

  return { shell, args: [...args, '-c', script] };
}
