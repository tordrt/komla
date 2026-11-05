import { getShell, getShellArgs } from './shell';

function getShellBaseName(shell: string): string {
  return shell.split(/[\\/]/).pop()?.toLowerCase() ?? shell.toLowerCase();
}

/** Whether the shell is wsl.exe, which starts the user's shell in WSL. */
export function isWslShell(shell: string): boolean {
  const baseName = getShellBaseName(shell);
  return baseName === 'wsl' || baseName === 'wsl.exe';
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

  if (isWslShell(shell)) {
    return { shell, args: [...args, '--exec', 'sh', '-lc', script] };
  }

  return { shell, args: [...args, '-c', script] };
}
