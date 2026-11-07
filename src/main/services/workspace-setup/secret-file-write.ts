import { lstatSync, mkdirSync, statSync, type Stats } from 'fs';
import { join, relative } from 'path';

import { secretFileProblem } from '../../../shared/lib/secret-file';
import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { isSshWorkspace } from '../../../shared/types/workspace';
import { writeFileAtomicSync } from '../../lib/atomic-write';

import type { SetupStep, TerminalExecutionLocation, Workspace } from '../../../shared/types';

/** What writing a Secret file found out. */
export interface SecretFileWritten {
  /** Whether Git ignores the file, when it was written in a Workspace repository and Git could say. */
  gitIgnored?: boolean;
}

export interface SecretFileWriteDependencies {
  /** The step's contents, or undefined when Settings has none for it. */
  read(projectId: string, stepId: string): Promise<string | undefined>;
  /** Writes `file` inside `root` on this computer, as `writeLocalSecretFile` does. */
  writeLocal(root: string, file: string, contents: string): void;
  /** Whether Git ignores `file` in the repository at `cwd`, or undefined when Git can't say. */
  gitIgnoresLocally(cwd: string, file: string): Promise<boolean | undefined>;
  /** Runs `command` on the SSH host with `input` as its stdin, resolving with what it printed. */
  runOnHost(hostId: string, command: string, input: string): Promise<string>;
}

export const SECRET_FILE_NO_CONTENTS =
  'This Secret file has no contents on this computer yet. Add them in its project’s Workspace Setup.';

const IGNORED_MARKER = 'komla-secret-file-ignored:';

/**
 * Writes a Secret file step's contents to its file where the step runs: in the SSH host's
 * Workspace repository through stdin, so the contents never appear in a command line, or else on
 * this computer. The file replaces what was there, a link too rather than what it points at.
 */
export async function writeSecretFile(
  dependencies: SecretFileWriteDependencies,
  workspace: Workspace,
  step: SetupStep,
  destination: { cwd: string; executionLocation: TerminalExecutionLocation }
): Promise<SecretFileWritten> {
  const problem = secretFileProblem(step.file);
  if (problem) throw new Error(problem);
  const file = step.file!;
  if (!workspace.projectId) throw new Error('The workspace has no project');
  const contents = await dependencies.read(workspace.projectId, step.id);
  if (contents === undefined) throw new Error(SECRET_FILE_NO_CONTENTS);
  const inRepository = destination.executionLocation === 'workspace';
  if (isSshWorkspace(workspace) && inRepository) {
    const output = await dependencies.runOnHost(
      workspace.backend.hostId,
      remoteSecretFileCommand(destination.cwd, file),
      contents
    );
    const marker = output.lastIndexOf(IGNORED_MARKER);
    if (marker < 0) return {};
    return { gitIgnored: output.startsWith('yes', marker + IGNORED_MARKER.length) };
  }
  dependencies.writeLocal(destination.cwd, file, contents);
  if (!inRepository) return {};
  const gitIgnored = await dependencies.gitIgnoresLocally(destination.cwd, file);
  return gitIgnored === undefined ? {} : { gitIgnored };
}

/** The folders `file` is in, inside where it's written, and its name. */
function secretFilePath(file: string): { folders: string[]; name: string } {
  const segments = file.split('/').filter((segment) => segment !== '' && segment !== '.');
  return { folders: segments.slice(0, -1), name: segments.at(-1) ?? '' };
}

const LINKED_FOLDER = 'is a link or not a folder, which Komla doesn’t write through';

/**
 * Writes `contents` to `file` inside `root`, readable by the user alone, through a temporary file
 * renamed over it, so a link at `file` is replaced rather than followed. It makes the folders it
 * needs inside `root`, but never `root` itself, which may be a workspace removed meanwhile, and it
 * refuses a folder on the way that is a link, which a repository could point anywhere.
 */
export function writeLocalSecretFile(root: string, file: string, contents: string): void {
  if (!statSync(root).isDirectory()) throw new Error(`${root} isn’t a folder`);
  const { folders, name } = secretFilePath(file);
  let folder = root;
  for (const segment of folders) {
    folder = join(folder, segment);
    let stats: Stats | undefined;
    try {
      stats = lstatSync(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!stats) mkdirSync(folder);
    else if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${relative(root, folder)} ${LINKED_FOLDER}`);
    }
  }
  const target = join(folder, name);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isDirectory()) throw new Error(`${file} is a folder`);
  writeFileAtomicSync(target, contents, 0o600);
}

/**
 * A POSIX command that writes its stdin to `file` in `directory`, readable by the user alone,
 * through a temporary file renamed over it, then says whether Git ignores it. As on this computer,
 * a link at `file` is replaced rather than followed, a folder there is left alone, and a folder on
 * the way that is a link is refused. Paths start with `./`, so no name reads as an option.
 */
export function remoteSecretFileCommand(directory: string, file: string): string {
  const { folders, name } = secretFilePath(file);
  return [
    'set -e',
    `cd -- ${shellQuotePosix(directory)}`,
    'folder=.',
    ...(folders.length > 0
      ? [
          `for segment in ${folders.map(shellQuotePosix).join(' ')}; do`,
          '  folder="$folder/$segment"',
          '  if [ -L "$folder" ] || { [ -e "$folder" ] && [ ! -d "$folder" ]; }; then',
          `    printf "%s ${LINKED_FOLDER}\\n" "$folder" >&2`,
          '    exit 1',
          '  fi',
          '  if [ ! -e "$folder" ]; then mkdir -- "$folder"; fi',
          'done',
        ]
      : []),
    `target="$folder"/${shellQuotePosix(name)}`,
    'if [ -d "$target" ] && [ ! -L "$target" ]; then',
    '  printf "%s is a folder\\n" "$target" >&2',
    '  exit 1',
    'fi',
    'temp_path=$(mktemp "$target.komla.XXXXXX")',
    'cleanup_temp() { if [ -n "$temp_path" ]; then rm -f "$temp_path"; fi; }',
    'trap cleanup_temp 0',
    "trap 'exit 1' HUP INT TERM",
    'cat > "$temp_path"',
    'chmod 600 "$temp_path"',
    'if [ -L "$target" ]; then rm -f "$target"; fi',
    'mv -f "$temp_path" "$target"',
    "temp_path=''",
    'trap - 0 HUP INT TERM',
    // `git check-ignore` exits 1 for a file it doesn't ignore, and more when it can't tell.
    `{ git check-ignore -q -- "$target" 2>/dev/null && printf '${IGNORED_MARKER}yes'; } || { [ $? -eq 1 ] && printf '${IGNORED_MARKER}no'; } || true`,
  ].join('\n');
}
