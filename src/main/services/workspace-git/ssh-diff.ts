import { posix as pathPosix } from 'path';

import { getMimeType, isImageFile } from '../../../shared/image-utils';
import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { commitInfoLogArgs, parseCommitInfo, toCommitDiff } from '../git/git-history';
import { parseNameStatusZ, parseNumstatZ } from '../git/git-status';
import { parsePorcelainZ, REMOTE_UNTRACKED_NUMSTAT_COMMAND } from '../ssh-git-status';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { workspaceStatusService } from '../workspace-status.service';

import type { SshWorkspaceBackend, Workspace } from '../../../shared/types/workspace';
import type { CommitDiff, FileChange, FileDiffContent, WorktreeDiff } from '../git.service';

const BINARY_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.flac',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
];

const REMOTE_TEXT_BYTE_CAP = 5 * 1024 * 1024;
// Matches the SSH file viewer's image cap; the combined cap still bounds both sides.
const REMOTE_IMAGE_BYTE_CAP = 7 * 1024 * 1024;
const REMOTE_DIFF_COMBINED_BYTE_CAP = 7 * 1024 * 1024;

function getBackend(workspace: Workspace): SshWorkspaceBackend {
  if (workspace.backend?.kind !== 'ssh') {
    throw new Error(`Workspace ${workspace.id} is not an SSH workspace`);
  }
  return workspace.backend;
}

function isBinaryByExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function assertSafeRemoteRelativePath(filePath: string): void {
  if (filePath.includes('\0')) throw new Error('filePath contains invalid null byte');
  if (!filePath || filePath.startsWith('/')) throw new Error('filePath must be relative');
  const normalized = pathPosix.normalize(filePath);
  if (normalized === '.' || normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('filePath escapes the workspace');
  }
}

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function summarize(files: FileChange[]): WorktreeDiff['summary'] {
  return files.reduce(
    (summary, file) => ({
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
      filesChanged: summary.filesChanged + 1,
    }),
    { additions: 0, deletions: 0, filesChanged: 0 }
  );
}

function remoteBase64Function(): string {
  return [
    'komla_b64() {',
    '  if command -v base64 >/dev/null 2>&1; then base64 | tr -d "\\n"; return; fi',
    '  if command -v openssl >/dev/null 2>&1; then openssl base64 -A; return; fi',
    '  return 127',
    '}',
  ].join('\n');
}

function remoteBase64AvailabilityCheck(): string {
  return [
    'if ! command -v base64 >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then',
    '  printf "STATUS=ENCODING_UNAVAILABLE\\n"',
    '  exit 0',
    'fi',
  ].join('\n');
}

/** Reads text sides, and an image's sides though git calls them binary, when they fit the caps. */
function readSidesDecision(): string[] {
  return [
    'read_sides=$image',
    'if [ "$binary" = "0" ]; then read_sides=1; fi',
    'if [ "$too_big" = "1" ]; then read_sides=0; binary=1; fi',
  ];
}

function assertRemoteEncodingAvailable(output: string): void {
  if (output.split('\n').includes('STATUS=ENCODING_UNAVAILABLE')) {
    throw new Error('Remote host needs base64 or openssl to view diffs');
  }
}

class SshWorkspaceDiff {
  private renameSources = new Map<string, Map<string, string>>();

  async getWorkingTreeDiff(workspace: Workspace): Promise<WorktreeDiff> {
    if (workspace.provisioning || workspace.provisionError) {
      return { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } };
    }

    const snapshot = workspaceStatusService.read({
      kind: 'working-tree-for-diff',
      workspaceId: workspace.id,
    });
    if (snapshot) {
      this.rememberRenameSources(workspace.id, 'HEAD', snapshot.files);
      return snapshot;
    }

    const output = await this.run(
      workspace,
      [
        remoteBase64Function(),
        remoteBase64AvailabilityCheck(),
        'git status --porcelain=v1 -z -uall 2>/dev/null | komla_b64',
        'printf "\\n__KOMLA_NUMSTAT__\\n"',
        `(git diff HEAD --numstat -z 2>/dev/null; ${REMOTE_UNTRACKED_NUMSTAT_COMMAND}) | komla_b64`,
      ].join('\n')
    );
    assertRemoteEncodingAvailable(output);
    const [statusB64 = '', numstatB64 = ''] = output.split('\n__KOMLA_NUMSTAT__\n');
    const files = parsePorcelainZ(decodeBase64(statusB64), decodeBase64(numstatB64));
    this.rememberRenameSources(workspace.id, 'HEAD', files);
    return { files, summary: summarize(files) };
  }

  async getWorkingTreeDiffAgainstBranch(
    workspace: Workspace,
    branch: string,
    useMergeBase: boolean
  ): Promise<WorktreeDiff> {
    if (workspace.provisioning || workspace.provisionError) {
      return { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } };
    }

    const output = await this.run(
      workspace,
      [
        `branch=${shellQuotePosix(branch)}`,
        `use_merge_base=${useMergeBase ? '1' : '0'}`,
        'target="$branch"',
        'if ! git rev-parse --verify "$target" >/dev/null 2>&1 && git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then',
        '  target="origin/$branch"',
        'fi',
        'if [ "$use_merge_base" = "1" ]; then',
        '  target=$(git merge-base "$target" HEAD 2>/dev/null || printf "%s" "$target")',
        'fi',
        remoteBase64Function(),
        remoteBase64AvailabilityCheck(),
        // -M overrides a diff.renames=copies setting, as the local comparison does.
        'git diff "$target" --name-status -M -z 2>/dev/null | komla_b64',
        'printf "\\n__KOMLA_NUMSTAT__\\n"',
        'git diff "$target" --numstat -M -z 2>/dev/null | komla_b64',
      ].join('\n')
    );
    assertRemoteEncodingAvailable(output);
    const [nameStatusB64 = '', numstatB64 = ''] = output.split('\n__KOMLA_NUMSTAT__\n');
    const files = parseNameStatusZ(
      decodeBase64(nameStatusB64),
      parseNumstatZ(decodeBase64(numstatB64))
    );
    // Untracked files are absent from git diff. Reuse the working-tree counts so
    // branch comparisons follow the same counting policy as workspace cards.
    const workingTree = await this.getWorkingTreeDiff(workspace);
    const existingPaths = new Set(files.map((file) => file.path));
    files.push(
      ...workingTree.files.filter(
        (file) => file.status === 'untracked' && !existingPaths.has(file.path)
      )
    );
    this.rememberRenameSources(workspace.id, this.branchDiffKey(branch, useMergeBase), files);
    return { files, summary: summarize(files) };
  }

  async getFullFileDiff(
    workspace: Workspace,
    filePath: string,
    _staged: boolean
  ): Promise<FileDiffContent> {
    assertSafeRemoteRelativePath(filePath);
    return this.getFileDiff(
      workspace,
      filePath,
      'HEAD',
      this.renameSources.get(`${workspace.id}:HEAD`)?.get(filePath)
    );
  }

  async getFullFileDiffAgainstBranch(
    workspace: Workspace,
    filePath: string,
    branch: string,
    useMergeBase: boolean
  ): Promise<FileDiffContent> {
    assertSafeRemoteRelativePath(filePath);
    return this.getFileDiff(
      workspace,
      filePath,
      { branch, useMergeBase },
      this.renameSources
        .get(`${workspace.id}:${this.branchDiffKey(branch, useMergeBase)}`)
        ?.get(filePath)
    );
  }

  /** A commit and what it changed against its first parent, as git-history reads it locally. */
  async getCommitDiff(workspace: Workspace, commitHash: string): Promise<CommitDiff> {
    // Each part encoded on its own line, so no message or path can pass for the next part.
    const output = await this.run(
      workspace,
      [
        remoteBase64Function(),
        remoteBase64AvailabilityCheck(),
        `hash=${shellQuotePosix(commitHash)}`,
        `info=$(git ${commitInfoLogArgs(commitHash).map(shellQuotePosix).join(' ')}) || exit $?`,
        'if parent=$(git rev-parse --verify --quiet "$hash^1"); then',
        '  set -- "$parent" "$hash"',
        'else',
        '  set -- --root --no-commit-id "$hash"',
        'fi',
        'printf "%s" "$info" | komla_b64',
        'printf "\\n"',
        'git diff-tree -r -z --numstat "$@" | komla_b64',
        'printf "\\n"',
        'git diff-tree -r -z --name-status "$@" | komla_b64',
        'printf "\\n"',
      ].join('\n')
    );
    assertRemoteEncodingAvailable(output);
    const [info = '', numstat = '', nameStatus = ''] = output.split('\n');
    return toCommitDiff(
      parseCommitInfo(decodeBase64(info)),
      decodeBase64(numstat),
      decodeBase64(nameStatus)
    );
  }

  /** A file as a commit changed it, against the commit's first parent. */
  async getCommitFileDiff(
    workspace: Workspace,
    commitHash: string,
    filePath: string
  ): Promise<FileDiffContent> {
    assertSafeRemoteRelativePath(filePath);
    const output = await this.run(
      workspace,
      [
        remoteBase64Function(),
        remoteBase64AvailabilityCheck(),
        `hash=${shellQuotePosix(commitHash)}`,
        `file=${shellQuotePosix(filePath)}`,
        `image=${isImageFile(filePath) ? 1 : 0}`,
        `cap=${isImageFile(filePath) ? REMOTE_IMAGE_BYTE_CAP : REMOTE_TEXT_BYTE_CAP}`,
        `combined_cap=${REMOTE_DIFF_COMBINED_BYTE_CAP}`,
        'parent=$(git rev-parse --verify --quiet "$hash^1" 2>/dev/null)',
        'old_exists=0',
        'new_exists=0',
        'old_b64=',
        'new_b64=',
        'old_size=0',
        'new_size=0',
        'if [ -n "$parent" ] && git cat-file -e "$parent:$file" 2>/dev/null; then',
        '  old_exists=1',
        '  old_size=$(git cat-file -s "$parent:$file" 2>/dev/null || printf "0")',
        'fi',
        'if git cat-file -e "$hash:$file" 2>/dev/null; then',
        '  new_exists=1',
        '  new_size=$(git cat-file -s "$hash:$file" 2>/dev/null || printf "0")',
        'fi',
        'if [ -n "$parent" ]; then set -- "$parent" "$hash"; else set -- --root --no-commit-id "$hash"; fi',
        'numstat=$(git --literal-pathspecs diff-tree -r --numstat "$@" -- "$file" 2>/dev/null)',
        'binary=0',
        // Binary files show as "-\t-\t" in numstat.
        'case "$numstat" in "-\t-\t"*) binary=1 ;; esac',
        'too_big=0',
        'if [ "$old_size" -gt "$cap" ] 2>/dev/null; then too_big=1; fi',
        'if [ "$new_size" -gt "$cap" ] 2>/dev/null; then too_big=1; fi',
        'if [ $((old_size + new_size)) -gt "$combined_cap" ] 2>/dev/null; then too_big=1; fi',
        ...readSidesDecision(),
        'if [ "$read_sides" = "1" ] && [ "$old_exists" = "1" ]; then',
        '  old_b64=$(git show "$parent:$file" 2>/dev/null | komla_b64)',
        'fi',
        'if [ "$read_sides" = "1" ] && [ "$new_exists" = "1" ]; then',
        '  new_b64=$(git show "$hash:$file" 2>/dev/null | komla_b64)',
        'fi',
        'printf "OLD_EXISTS=%s\\nNEW_EXISTS=%s\\nBINARY=%s\\nOLD_B64=%s\\nNEW_B64=%s\\n" "$old_exists" "$new_exists" "$binary" "$old_b64" "$new_b64"',
      ].join('\n')
    );
    return this.toFileDiffContent(output, filePath);
  }

  private async getFileDiff(
    workspace: Workspace,
    filePath: string,
    ref: string | { branch: string; useMergeBase: boolean },
    originalPath?: string
  ): Promise<FileDiffContent> {
    // Resolve the comparison ref on the host in the same command that reads both sides.
    const resolveRef =
      typeof ref === 'string'
        ? [`ref=${shellQuotePosix(ref)}`]
        : [
            `branch=${shellQuotePosix(ref.branch)}`,
            'ref="$branch"',
            'if ! git rev-parse --verify "$ref" >/dev/null 2>&1 && git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then',
            '  ref="origin/$branch"',
            'fi',
            ...(ref.useMergeBase
              ? ['ref=$(git merge-base "$ref" HEAD 2>/dev/null || printf "%s" "$ref")']
              : []),
          ];
    const output = await this.run(
      workspace,
      [
        ...resolveRef,
        remoteBase64Function(),
        remoteBase64AvailabilityCheck(),
        `file=${shellQuotePosix(filePath)}`,
        `old_file=${shellQuotePosix(originalPath ?? filePath)}`,
        `image=${isImageFile(filePath) ? 1 : 0}`,
        `cap=${isImageFile(filePath) ? REMOTE_IMAGE_BYTE_CAP : REMOTE_TEXT_BYTE_CAP}`,
        `combined_cap=${REMOTE_DIFF_COMBINED_BYTE_CAP}`,
        'old_exists=0',
        'new_exists=0',
        'old_b64=',
        'new_b64=',
        'old_size=0',
        'new_size=0',
        'if git cat-file -e "$ref:$old_file" 2>/dev/null; then',
        '  old_exists=1',
        '  old_size=$(git cat-file -s "$ref:$old_file" 2>/dev/null || printf "0")',
        'fi',
        'if [ -f "$file" ]; then',
        '  new_exists=1',
        '  new_size=$(wc -c <"$file" 2>/dev/null | tr -d " " || printf "0")',
        'fi',
        'binary=0',
        'numstat=$(git diff --numstat "$ref" -- "$old_file" "$file" 2>/dev/null || printf "")',
        'first_add=$(printf "%s\\n" "$numstat" | awk -F "\\t" \'NR==1 { print $1 }\')',
        'first_del=$(printf "%s\\n" "$numstat" | awk -F "\\t" \'NR==1 { print $2 }\')',
        'if [ "$first_add" = "-" ] && [ "$first_del" = "-" ]; then binary=1; fi',
        'too_big=0',
        'if [ "$old_size" -gt "$cap" ] 2>/dev/null; then too_big=1; fi',
        'if [ "$new_size" -gt "$cap" ] 2>/dev/null; then too_big=1; fi',
        'combined_size=$((old_size + new_size))',
        'if [ "$combined_size" -gt "$combined_cap" ] 2>/dev/null; then too_big=1; fi',
        ...readSidesDecision(),
        'if [ "$read_sides" = "1" ] && [ "$old_exists" = "1" ]; then',
        '  old_b64=$(git show "$ref:$old_file" 2>/dev/null | komla_b64)',
        'fi',
        'if [ "$read_sides" = "1" ] && [ "$new_exists" = "1" ]; then',
        '  new_b64=$(komla_b64 <"$file")',
        'fi',
        'printf "OLD_EXISTS=%s\\nNEW_EXISTS=%s\\nBINARY=%s\\nOLD_B64=%s\\nNEW_B64=%s\\n" "$old_exists" "$new_exists" "$binary" "$old_b64" "$new_b64"',
      ].join('\n')
    );
    return this.toFileDiffContent(output, filePath, originalPath);
  }

  private toFileDiffContent(
    output: string,
    filePath: string,
    originalPath?: string
  ): FileDiffContent {
    assertRemoteEncodingAvailable(output);
    const values = this.parseKeyValueOutput(output);
    const oldExists = values.get('OLD_EXISTS') === '1';
    const newExists = values.get('NEW_EXISTS') === '1';
    const gitSaysBinary = values.get('BINARY') === '1';
    const isBinary = gitSaysBinary || isBinaryByExtension(filePath);
    const status =
      originalPath && originalPath !== filePath && oldExists && newExists
        ? 'renamed'
        : this.statusFromExistence(oldExists, newExists);

    // An image path git reads as text, like a Git LFS pointer, isn't image data.
    if (gitSaysBinary && isImageFile(filePath)) {
      return {
        path: filePath,
        oldContent: null,
        newContent: null,
        status,
        isBinary: true,
        isImage: true,
        mimeType: getMimeType(filePath),
        oldImageData: (oldExists && values.get('OLD_B64')) || null,
        newImageData: (newExists && values.get('NEW_B64')) || null,
      };
    }
    if (isBinary) {
      return { path: filePath, oldContent: null, newContent: null, status, isBinary: true };
    }
    return {
      path: filePath,
      oldContent: oldExists ? decodeBase64(values.get('OLD_B64') ?? '') : null,
      newContent: newExists ? decodeBase64(values.get('NEW_B64') ?? '') : null,
      status,
      isBinary: false,
    };
  }

  private statusFromExistence(oldExists: boolean, newExists: boolean): FileChange['status'] {
    if (!oldExists && newExists) return 'added';
    if (oldExists && !newExists) return 'deleted';
    return 'modified';
  }

  private branchDiffKey(branch: string, useMergeBase: boolean): string {
    return `branch:${branch}:${useMergeBase ? 'merge-base' : 'direct'}`;
  }

  private rememberRenameSources(workspaceId: string, diffKey: string, files: FileChange[]): void {
    const sources = new Map<string, string>();
    for (const file of files) {
      if (file.originalPath) sources.set(file.path, file.originalPath);
    }
    this.renameSources.set(`${workspaceId}:${diffKey}`, sources);
  }

  private parseKeyValueOutput(output: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const line of output.split('\n')) {
      const index = line.indexOf('=');
      if (index <= 0) continue;
      values.set(line.slice(0, index), line.slice(index + 1));
    }
    return values;
  }

  private run(workspace: Workspace, script: string): Promise<string> {
    const backend = getBackend(workspace);
    const host = sshWorkspaceService.getHost(backend.hostId);
    return sshWorkspaceService.run(
      host,
      `cd ${shellQuotePosix(backend.remoteDirectory)} || exit 1; ${script}`
    );
  }
}

export const sshWorkspaceDiff = new SshWorkspaceDiff();
