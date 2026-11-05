import { accessSync, constants, statSync } from 'fs';
import path from 'path';

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform !== 'win32') accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The executables found in PATH's directories, trying each PATHEXT extension on Windows. */
export function findOnPath(
  executables: string[],
  pathValue: string,
  {
    platform = process.platform,
    pathExt = '.COM;.EXE;.BAT;.CMD',
    isExecutable = isExecutableFile,
  }: {
    platform?: NodeJS.Platform;
    pathExt?: string;
    isExecutable?: (filePath: string) => boolean;
  } = {}
): Set<string> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const directories = pathValue.split(pathApi.delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? pathExt.split(';').filter(Boolean) : [''];
  const found = new Set<string>();
  for (const executable of executables) {
    const isFound = directories.some((directory) =>
      extensions.some((extension) => isExecutable(pathApi.join(directory, executable + extension)))
    );
    if (isFound) found.add(executable);
  }
  return found;
}
