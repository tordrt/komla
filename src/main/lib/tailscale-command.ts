import { accessSync, constants, statSync } from 'fs';
import path from 'path';

import { COMMON_EXECUTABLE_PATHS } from './host-tool-env';

/** The Mac app's own binary also works as the CLI, for installs that never ran "Install CLI". */
const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export interface TailscaleCommand {
  file: string;
  /**
   * Started outside a shell, the Mac app binary tries to open the GUI and prints "The
   * Tailscale GUI failed to start" unless TAILSCALE_BE_CLI is set. The Go CLI ignores it.
   */
  env: NodeJS.ProcessEnv;
  /** What Settings shows to run in a terminal. */
  display: string;
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The tailscale CLI to run on this computer. Komla opened from Finder or the Dock inherits
 * only the system PATH, which leaves out /usr/local/bin, where the Mac app installs its CLI.
 * Falls back to the bare name, so a missing CLI still fails with ENOENT.
 */
export function tailscaleCommand({
  platform = process.platform,
  env = process.env,
  isExecutable = isExecutableFile,
}: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (filePath: string) => boolean;
} = {}): TailscaleCommand {
  const command = (file: string, display = 'tailscale'): TailscaleCommand => ({
    file,
    env: { ...env, TAILSCALE_BE_CLI: '1' },
    display,
  });
  if (platform === 'win32') return command('tailscale');
  const directories = [
    ...(env.PATH ?? '').split(path.posix.delimiter).filter(Boolean),
    ...COMMON_EXECUTABLE_PATHS,
  ];
  const onPath = directories
    .map((directory) => path.posix.join(directory, 'tailscale'))
    .find((candidate) => isExecutable(candidate));
  if (onPath) return command(onPath);
  if (platform === 'darwin' && isExecutable(MAC_APP_BINARY)) {
    return command(MAC_APP_BINARY, MAC_APP_BINARY);
  }
  return command('tailscale');
}
