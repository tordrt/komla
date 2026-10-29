/** Common executable locations that GUI-launched apps may not inherit. */
export const COMMON_EXECUTABLE_PATHS = [
  '/opt/homebrew/bin', // Apple Silicon Homebrew
  '/usr/local/bin', // Intel Homebrew
  '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
];

/**
 * Return a copy of the supplied environment with common package-manager bin
 * directories appended to PATH. Packaged macOS apps launched from Finder or
 * the Dock commonly inherit only the system PATH.
 */
export function hostToolEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const current = source.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const parts = new Set(current.split(delimiter).filter(Boolean));
  const missing = COMMON_EXECUTABLE_PATHS.filter((path) => !parts.has(path));
  return missing.length === 0
    ? { ...source }
    : { ...source, PATH: [current, ...missing].filter(Boolean).join(delimiter) };
}
