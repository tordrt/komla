/** The file a new Secret file step writes, relative to where it runs. */
export const DEFAULT_SECRET_FILE = '.env';

/** The most a Secret file's contents can hold, in characters. */
export const MAX_SECRET_FILE_CONTENTS = 64 * 1024;

const MAX_SECRET_FILE_PATH = 1024;

/**
 * Why a Secret file step can't write to `file`, or undefined when it can. The file is relative to
 * where the step runs and stays inside it, so a step a host's Project manifest changed can't write
 * the contents anywhere else on this computer or the host.
 */
export function secretFileProblem(file: string | undefined): string | undefined {
  const path = file ?? '';
  if (!path.trim()) return 'Name the file to write, such as .env';
  if (path.length > MAX_SECRET_FILE_PATH) return 'The file’s path is too long';
  if (path.includes('\0')) return 'The file’s path holds a character it can’t';
  if (path.includes('\\')) return 'Separate folders with /';
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) {
    return 'Give a path inside the workspace, such as apps/web/.env';
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) {
    return 'The file must be inside the workspace, without ..';
  }
  if (segments.some(isGitFolder)) return 'Komla doesn’t write inside .git';
  const name = segments.at(-1) ?? '';
  if (name === '' || name === '.') return 'Name a file, not a folder';
  return undefined;
}

/**
 * Whether a path segment names Git's folder on some filesystem: in any case on macOS and Windows,
 * and on Windows with trailing dots or spaces, or as its short name.
 */
function isGitFolder(segment: string): boolean {
  const name = segment.toLowerCase().replace(/[. ]+$/, '');
  return name === '.git' || /^git~\d+$/.test(name);
}

/**
 * The names a `.env` file sets, in order, such as `API_KEY` from `API_KEY=…` or
 * `export API_KEY=…`. Settings lists them, so a Secret file shows what it holds without its values.
 */
export function secretFileNames(contents: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(line);
    const name = match?.[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}
