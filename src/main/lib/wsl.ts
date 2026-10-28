import { execFileSync } from 'child_process';

import { configService } from '../services/config.service';

import { createLogger } from './logger';

const logger = createLogger('WSL');

/**
 * Returns true when the app is running on Windows and the user has selected WSL as their shell.
 */
export function isWslMode(): boolean {
  return process.platform === 'win32' && configService.get().shellMode === 'wsl';
}

/**
 * Returns the shell binary to use for WSL mode.
 */
export function getWslShell(): string {
  return 'wsl.exe';
}

/**
 * Returns the arguments to pass to wsl.exe when spawning a shell.
 * If a specific distro is configured, includes `-d <distro>`.
 */
export function getWslShellArgs(distro?: string): string[] {
  if (distro) {
    return ['-d', distro];
  }
  return [];
}

/**
 * Converts a Windows path (e.g. `C:\Users\foo\project`) to a WSL mount path
 * (e.g. `/mnt/c/Users/foo/project`).
 *
 * - Drive letter is lowercased
 * - Backslashes are converted to forward slashes
 * - UNC paths (`\\server\share`) are passed through unchanged
 * - Paths that don't look like Windows paths are passed through unchanged
 */
export function windowsPathToWsl(winPath: string): string {
  // Already a Unix-style path — pass through
  if (winPath.startsWith('/')) {
    return winPath;
  }

  // UNC paths — can't translate, pass through
  if (winPath.startsWith('\\\\')) {
    logger.warn('Cannot translate UNC path to WSL:', winPath);
    return winPath;
  }

  // Match drive letter pattern: C:\ or C:/
  const driveMatch = winPath.match(/^([a-zA-Z]):[/\\]/);
  if (!driveMatch) {
    // Not a recognizable Windows path — pass through
    return winPath;
  }

  const driveLetter = driveMatch[1].toLowerCase();
  const rest = winPath.slice(3).replace(/\\/g, '/');
  return `/mnt/${driveLetter}/${rest}`;
}

/**
 * Detects installed WSL distributions by running `wsl.exe -l -q`.
 * Returns an array of distro names, or an empty array if WSL is not available.
 */
export function detectWslDistros(): string[] {
  if (process.platform !== 'win32') {
    return [];
  }

  try {
    const result = execFileSync('wsl.exe', ['-l', '-q'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    // wsl.exe may output UTF-16LE — convert buffer to string and strip BOM / null bytes
    const output = result
      .toString('utf16le')
      .replaceAll('\u0000', '')
      .replace(/^\uFEFF/, '');

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    logger.debug('Failed to detect WSL distros:', error);
    return [];
  }
}
