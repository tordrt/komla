import { createHash } from 'crypto';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, parse, posix as pathPosix, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { gunzip } from 'zlib';

import { getMimeType, getViewableFileKind, isImageFile } from '../../shared/image-utils';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import {
  isLocalTerminalExecutionLocation,
  type TerminalExecutionLocation,
} from '../../shared/types/terminal';
import { isSshWorkspace } from '../../shared/types/workspace';
import { assertSafeRelativePath } from '../ipc/validation/path-safety';
import { createLogger } from '../lib/logger';
import { isWithinRoot } from '../lib/same-path';

import { getImportedFileNameParts } from './git/git-repo';
import {
  KOMLA_FILES_DIR,
  KOMLA_FILES_GITIGNORE,
  KOMLA_FILES_GITIGNORE_CONTENT,
} from './git/git-status';
import { gitService } from './git.service';
import { htmlPreviewService } from './html-preview.service';
import { localMirrorService } from './local-mirror.service';
import { getKomlaBasePath } from './paths';
import { remoteCompanionService } from './remote-companion.service';
import {
  buildContentSearch,
  fileSizeInBytes,
  parseRipgrepOutput,
  searchService,
  type ContentSearchOptions,
  type ContentSearchResult,
} from './search.service';
import { sshWorkspaceService } from './ssh-workspace.service';
import { workspaceStatusService } from './workspace-status.service';
import { workspaceService } from './workspace.service';

import type { Workspace } from '../../shared/types';
import type {
  ViewerFile,
  ViewerFileSource,
  ViewerFolderFile,
} from '../../shared/types/viewer-file';

const logger = createLogger('WorkspaceFileService');
const REMOTE_TEXT_BYTE_CAP = 5 * 1024 * 1024;
const REMOTE_IMAGE_BYTE_CAP = 7 * 1024 * 1024;
const LOCAL_IMAGE_BYTE_CAP = 10 * 1024 * 1024;
const LOCAL_MEDIA_BYTE_CAP = 50 * 1024 * 1024;
const VIEWER_FOLDER_FILE_LIMIT = 200;
// Folders like /tmp can hold thousands of entries, so a listing looks up when at most this
// many folders and this many files were modified.
const VIEWER_FOLDER_NAME_LIMIT = 5_000;
const LINKED_WORKSPACES_DIR = 'linked-workspaces';
// As much output as the git commands behind a local listing may print.
const SSH_FILE_LIST_MAX_BYTES = 50 * 1024 * 1024;

const gunzipAsync = promisify(gunzip);

export interface WorkspaceFileList {
  files: string[];
  gitIgnoredFiles: string[];
  emptyDirs: string[];
  managedLinkPaths?: string[];
  /** An SSH listing's fingerprint, comparable with the Remote Companion's. */
  fileListHash?: string;
}

export interface WorkspaceImageFile {
  data: string;
  mimeType: string;
}

/**
 * The largest file the file viewer reads. Remote reads come back base64-encoded through
 * a 10 MB SSH output buffer, so remote media and PDFs share the remote image cap.
 */
function viewerByteCap(filePath: string, remote: boolean): number {
  switch (getViewableFileKind(filePath)) {
    case 'image':
      return remote ? REMOTE_IMAGE_BYTE_CAP : LOCAL_IMAGE_BYTE_CAP;
    case 'pdf':
    case 'audio':
    case 'video':
      return remote ? REMOTE_IMAGE_BYTE_CAP : LOCAL_MEDIA_BYTE_CAP;
    default:
      return REMOTE_TEXT_BYTE_CAP;
  }
}

/**
 * The real path of a page's folder when the file viewer may serve it so the page's own files
 * load, or null. The page can read every file there, so only a folder in the terminal's own
 * workspace folder, in one of Komla's worktrees or in a temp folder, never a hidden folder, the
 * filesystem root, the home folder or a folder holding it. A page elsewhere, such as in
 * ~/Downloads, is shown on its own.
 */
async function servableViewerFolder(directory: string, ownFolder: string): Promise<string | null> {
  const real = (path: string) => realpath(path).catch(() => null);
  const [folder, home, own, worktrees, ...temps] = await Promise.all(
    [directory, homedir(), ownFolder, join(getKomlaBasePath(), 'worktrees')]
      .concat([...new Set([tmpdir(), '/tmp'])])
      .map(real)
  );
  if (
    !folder ||
    folder === parse(folder).root ||
    isWithinRoot(folder, home ?? resolve(homedir()))
  ) {
    return null;
  }
  // Two levels down in worktrees or temp: one level holds a project's worktrees or an app's files.
  const roots = [
    { root: own, depth: 0 },
    ...[worktrees, ...temps].map((root) => ({ root, depth: 2 })),
  ];
  const servable = roots.some(({ root, depth }) => {
    if (!root || !isWithinRoot(root, folder)) return false;
    const segments = relative(root, folder).split(sep).filter(Boolean);
    return segments.length >= depth && !segments.some((segment) => segment.startsWith('.'));
  });
  return servable ? folder : null;
}

/** Reads a file on this computer for the file viewer, base64-encoded. */
async function readLocalViewerFile(
  fullPath: string,
  byteCap: number,
  followSymlinks: boolean
): Promise<string> {
  const info = followSymlinks ? await stat(fullPath) : await lstat(fullPath);
  if (info.isSymbolicLink()) throw new Error('Source symlinks are not supported');
  if (!info.isFile()) throw new Error('Source is not a regular file');
  if (info.size > byteCap) throw new Error(`File is too large to view (${info.size} bytes)`);
  return (await readFile(fullPath)).toString('base64');
}

/**
 * Whether a folder listing for the file viewer includes an entry, named with a trailing
 * slash for a folder: a folder or a file it can show, not hidden.
 */
function isViewerFolderEntry(name: string): boolean {
  return !name.startsWith('.') && (name.endsWith('/') || getViewableFileKind(name) !== null);
}

/**
 * Folders, then files, each in its order and up to the listing limit, so many subfolders
 * never crowd out the files.
 */
function foldersThenFiles(entries: ViewerFolderFile[]): ViewerFolderFile[] {
  const folders = entries.filter(({ name }) => name.endsWith('/'));
  const files = entries.filter(({ name }) => !name.endsWith('/'));
  return [
    ...folders.slice(0, VIEWER_FOLDER_FILE_LIMIT),
    ...files.slice(0, VIEWER_FOLDER_FILE_LIMIT),
  ];
}

/**
 * A terminal's path on this computer, with a leading ~ for the home folder expanded.
 * Not joined, which would drop `..` after a symlinked folder that a shell follows first.
 */
function expandTerminalHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? `${homedir().replace(/\/$/, '')}/${path.slice(2)}` : path;
}

/** Quotes a terminal's path for a script, expanding a leading ~ to the HOME where it runs. */
function shellQuoteTerminalPath(path: string): string {
  if (path === '~') return '"$HOME"';
  return path.startsWith('~/')
    ? `"$HOME"/${shellQuotePosix(path.slice(2))}`
    : shellQuotePosix(path);
}

/** The folder a viewer path lists: itself for a path ending in a slash, else its parent. */
function viewerFolderOf(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) || '/' : pathPosix.dirname(path);
}

/**
 * The folders and the files the file viewer can show in a folder on this computer,
 * each newest first.
 */
async function listLocalViewerFolder(directory: string): Promise<ViewerFolderFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.isFile() ? entry.name : ''))
    .filter(isViewerFolderEntry);
  // readdir's order isn't by time, so in a bigger folder the newest may be left out.
  const stated = [
    ...names.filter((name) => name.endsWith('/')).slice(0, VIEWER_FOLDER_NAME_LIMIT),
    ...names.filter((name) => !name.endsWith('/')).slice(0, VIEWER_FOLDER_NAME_LIMIT),
  ];
  const files = await Promise.all(
    stated.map(async (name) => {
      const info = await lstat(join(directory, name)).catch(() => null);
      return info ? { name, modifiedMs: info.mtimeMs } : null;
    })
  );
  return foldersThenFiles(
    files
      .filter((file) => file !== null)
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .map(({ name, modifiedMs }) => viewerFolderFile(name, modifiedMs))
  );
}

/** A folder file, with its modified time unless that is past what a Date can hold. */
function viewerFolderFile(name: string, modifiedMs: number | undefined): ViewerFolderFile {
  return modifiedMs === undefined || Number.isNaN(new Date(modifiedMs).getTime())
    ? { name }
    : { name, modifiedMs };
}

/**
 * Modified times by file name, from the lines `stat` printed in a folder listing script:
 * seconds since the epoch, a slash, then the name. Other lines are skipped.
 */
function parseStatModifiedTimes(value: string): Map<string, number> {
  const times = new Map<string, number>();
  for (const line of decodeNullSeparatedBase64(value)) {
    const match = /^(-?\d+)\/(.+)$/.exec(line);
    if (match) times.set(match[2], Number(match[1]) * 1000);
  }
  return times;
}

function assertSafeRemoteRelativePath(filePath: string): void {
  if (filePath.includes('\0')) throw new Error('filePath contains invalid null byte');
  if (!filePath || filePath.trim().length === 0 || filePath.startsWith('/')) {
    throw new Error('filePath must be relative');
  }
  const normalized = pathPosix.normalize(filePath);
  if (normalized === '.' || normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('filePath escapes the workspace');
  }
}

function assertCanonicalRemoteRelativePath(filePath: string): void {
  assertSafeRemoteRelativePath(filePath);
  if (pathPosix.normalize(filePath) !== filePath || filePath.endsWith('/')) {
    throw new Error('filePath must be a canonical relative path');
  }
}

function assertCanonicalLocalRelativePath(rootPath: string, filePath: string): void {
  assertSafeRelativePath(rootPath, filePath, 'filePath');
  const nativeSegments = filePath.split(sep);
  if (
    nativeSegments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    filePath.endsWith(sep)
  ) {
    throw new Error('filePath must be a canonical relative path');
  }
  assertCanonicalRemoteRelativePath(filePath);
}

function splitNullSeparated(bytes: Buffer): string[] {
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

function decodeNullSeparatedBase64(value: string | undefined): string[] {
  if (!value) return [];
  return splitNullSeparated(Buffer.from(value, 'base64'));
}

/**
 * Decodes the NUL-separated lists an SSH listing script printed. The script gzips them first
 * when the host has gzip, which shrinks a large repository's paths about ninefold.
 */
async function decodeFileLists<Key extends string>(
  values: Map<string, string>,
  keys: readonly Key[]
): Promise<Record<Key, Buffer>> {
  const gzipped = values.get('ENCODING') === 'gzip';
  const lists = await Promise.all(
    keys.map(async (key) => {
      const bytes = Buffer.from(values.get(key) ?? '', 'base64');
      return gzipped && bytes.length > 0
        ? gunzipAsync(bytes, { maxOutputLength: SSH_FILE_LIST_MAX_BYTES })
        : bytes;
    })
  );
  return Object.fromEntries(keys.map((key, index) => [key, lists[index]])) as Record<Key, Buffer>;
}

/**
 * Fingerprints a workspace's tracked and unignored untracked files, then the deleted ones,
 * exactly as the Remote Companion does. No path is empty, so the extra NUL marks where the
 * first NUL-terminated list ends.
 */
function fileListFingerprint(listed: Buffer, deleted: Buffer): string {
  return createHash('sha256').update(listed).update('\0').update(deleted).digest('hex');
}

function prefixLinkedWorkspaceFiles(peerDirectory: string, list: Buffer): string[] {
  return splitNullSeparated(list).map((filePath) => `${peerDirectory}/${filePath}`);
}

class WorkspaceFileService {
  // Each SSH workspace's running content search, stopped when a newer one starts.
  private readonly contentSearches = new Map<string, AbortController>();

  async listFiles(workspaceId: string, includeGitIgnored = false): Promise<WorkspaceFileList> {
    const workspace = this.getWorkspace(workspaceId);
    if (!isSshWorkspace(workspace)) {
      const [fileList, managedLinkPaths] = await Promise.all([
        gitService.listFiles(workspace.workingDirectory, includeGitIgnored),
        this.getManagedLocalLinkPaths(workspace),
      ]);
      const visiblePaths = [...fileList.files, ...fileList.gitIgnoredFiles];
      const emptyManagedLinks = managedLinkPaths.filter(
        (linkPath) =>
          !visiblePaths.some((filePath) => filePath.startsWith(`${linkPath}/`)) &&
          !fileList.emptyDirs.some(
            (directory) => directory === linkPath || directory.startsWith(`${linkPath}/`)
          )
      );
      return {
        ...fileList,
        emptyDirs: [...new Set([...fileList.emptyDirs, ...emptyManagedLinks])],
        ...(managedLinkPaths.length > 0 ? { managedLinkPaths } : {}),
      };
    }
    if (workspace.provisioning || workspace.provisionError) {
      return { files: [], gitIgnoredFiles: [], emptyDirs: [] };
    }

    logger.debug('listing SSH workspace files', { workspaceId, includeGitIgnored });
    const script = [
      this.remoteBase64Function(),
      this.remoteBase64AvailabilityCheck(),
      this.remoteFileListFunction(),
      this.remoteRecordedPeerFunction(workspace),
      `komla_files_dir=${shellQuotePosix(KOMLA_FILES_DIR)}`,
      `linked_workspaces_dir=${shellQuotePosix(LINKED_WORKSPACES_DIR)}`,
      'files_b64=$(git ls-files --cached --others --exclude-standard -z | komla_list_b64)',
      'komla_files_b64=$({',
      '  if [ -d "$komla_files_dir" ] && [ ! -L "$komla_files_dir" ]; then',
      // The folder's own ignore file stays out; an import with that name doesn't.
      `    komla_gitignore=${shellQuotePosix(`${KOMLA_FILES_DIR}/${KOMLA_FILES_GITIGNORE}`)}`,
      `    if [ -f "$komla_gitignore" ] && [ "$(cat "$komla_gitignore")" = ${shellQuotePosix(KOMLA_FILES_GITIGNORE_CONTENT.trimEnd())} ]; then`,
      '      find "$komla_files_dir" -type f ! -path "$komla_gitignore" -print0',
      '    else',
      '      find "$komla_files_dir" -type f -print0',
      '    fi',
      '  fi',
      '} | komla_list_b64)',
      'peers_b64=$({',
      '  if [ -d "$linked_workspaces_dir" ] && [ ! -L "$linked_workspaces_dir" ]; then',
      '    for peer in "$linked_workspaces_dir"/*; do',
      '      komla_recorded_peer_root "$peer" >/dev/null || continue',
      '      peer_name=${peer#"$linked_workspaces_dir"/}',
      '      printf \'%s\\000\' "$peer_name"',
      '    done',
      '  fi',
      '} | komla_list_b64)',
      'deleted_b64=$(git ls-files --deleted -z | komla_list_b64)',
      includeGitIgnored
        ? 'ignored_b64=$(git ls-files --others --ignored --exclude-standard -z | komla_list_b64)'
        : 'ignored_b64=',
      'printf "STATUS=OK\\nENCODING=%s\\nFILES=%s\\nKOMLA_FILES=%s\\nPEERS=%s\\nIGNORED=%s\\nDELETED=%s\\n" "$komla_list_encoding" "$files_b64" "$komla_files_b64" "$peers_b64" "$ignored_b64" "$deleted_b64"',
    ].join('\n');
    const values = this.parseKeyValueOutput(await this.runSsh(workspace, script));
    this.assertRemoteEncodingAvailable(values);
    const lists = await decodeFileLists(values, [
      'FILES',
      'KOMLA_FILES',
      'PEERS',
      'IGNORED',
      'DELETED',
    ]);
    const peerNames = [
      ...new Set(
        splitNullSeparated(lists.PEERS).filter(
          (peerName) =>
            peerName !== '.' &&
            peerName !== '..' &&
            !peerName.includes('/') &&
            !peerName.includes('\0')
        )
      ),
    ];
    const linkedFiles: string[] = [];
    const linkedDeletedFiles: string[] = [];
    const linkedIgnoredFiles: string[] = [];
    const peerDirectories: string[] = [];
    for (const peerName of peerNames) {
      const peerDirectory = `${LINKED_WORKSPACES_DIR}/${peerName}`;
      const peerScript = [
        this.remoteBase64Function(),
        this.remoteBase64AvailabilityCheck(),
        this.remoteFileListFunction(),
        this.remoteRecordedPeerFunction(workspace),
        `peer=${shellQuotePosix(peerDirectory)}`,
        'peer_root=$(komla_recorded_peer_root "$peer") || { printf "STATUS=STALE\\n"; exit 0; }',
        'files_b64=$(git -C "$peer_root" ls-files --cached --others --exclude-standard -z | komla_list_b64)',
        'deleted_b64=$(git -C "$peer_root" ls-files --deleted -z | komla_list_b64)',
        includeGitIgnored
          ? 'ignored_b64=$(git -C "$peer_root" ls-files --others --ignored --exclude-standard -z | komla_list_b64)'
          : 'ignored_b64=',
        'printf "STATUS=OK\\nENCODING=%s\\nFILES=%s\\nIGNORED=%s\\nDELETED=%s\\n" "$komla_list_encoding" "$files_b64" "$ignored_b64" "$deleted_b64"',
      ].join('\n');
      const peerValues = this.parseKeyValueOutput(await this.runSsh(workspace, peerScript));
      this.assertRemoteEncodingAvailable(peerValues);
      if (peerValues.get('STATUS') === 'STALE') continue;
      if (peerValues.get('STATUS') !== 'OK')
        throw new Error('Failed to list linked workspace files');
      const peerLists = await decodeFileLists(peerValues, ['FILES', 'IGNORED', 'DELETED']);
      peerDirectories.push(peerDirectory);
      linkedFiles.push(...prefixLinkedWorkspaceFiles(peerDirectory, peerLists.FILES));
      linkedDeletedFiles.push(...prefixLinkedWorkspaceFiles(peerDirectory, peerLists.DELETED));
      linkedIgnoredFiles.push(...prefixLinkedWorkspaceFiles(peerDirectory, peerLists.IGNORED));
    }
    const deletedFiles = new Set([...splitNullSeparated(lists.DELETED), ...linkedDeletedFiles]);
    const files = [
      ...splitNullSeparated(lists.FILES),
      ...splitNullSeparated(lists.KOMLA_FILES),
      ...linkedFiles,
    ].filter((filePath) => !deletedFiles.has(filePath));
    const gitIgnoredFiles = [
      ...splitNullSeparated(lists.IGNORED).filter(
        (file) =>
          !file.startsWith(`${KOMLA_FILES_DIR}/`) && !file.startsWith(`${LINKED_WORKSPACES_DIR}/`)
      ),
      ...linkedIgnoredFiles.filter((file) => {
        const peerRelativePath = file.split('/').slice(2).join('/');
        return (
          !peerRelativePath.startsWith(`${KOMLA_FILES_DIR}/`) &&
          !peerRelativePath.startsWith(`${LINKED_WORKSPACES_DIR}/`)
        );
      }),
    ];
    const visibleFiles = includeGitIgnored ? [...files, ...gitIgnoredFiles] : files;
    const emptyDirs = peerDirectories.filter(
      (directory) => !visibleFiles.some((filePath) => filePath.startsWith(`${directory}/`))
    );
    return {
      files: [...new Set(files)],
      gitIgnoredFiles,
      emptyDirs,
      ...(peerDirectories.length > 0 ? { managedLinkPaths: peerDirectories } : {}),
      fileListHash: fileListFingerprint(lists.FILES, lists.DELETED),
    };
  }

  async readFile(workspaceId: string, filePath: string): Promise<string> {
    const workspace = this.getWorkspace(workspaceId);
    if (!isSshWorkspace(workspace)) {
      return gitService.readFileContent(workspace.workingDirectory, filePath);
    }

    const data = await this.readRemoteFile(workspace, filePath, REMOTE_TEXT_BYTE_CAP);
    return Buffer.from(data, 'base64').toString('utf8');
  }

  async searchContent(
    workspaceId: string,
    query: string,
    options?: ContentSearchOptions
  ): Promise<ContentSearchResult[]> {
    const workspace = this.getWorkspace(workspaceId);
    if (!isSshWorkspace(workspace)) {
      return searchService.searchContent(workspace.workingDirectory, query, options);
    }
    if (!query.trim() || workspace.provisioning || workspace.provisionError) return [];

    // Replace the previous search before awaiting anything, so searches stay in request order.
    this.contentSearches.get(workspaceId)?.abort();
    const controller = new AbortController();
    this.contentSearches.set(workspaceId, controller);
    logger.debug('searching SSH workspace contents', { workspaceId });
    // The Remote Companion searches on the host the way ripgrep searches locally.
    const search = buildContentSearch(query, options);
    const host = sshWorkspaceService.getHost(workspace.backend.hostId);
    let output = '';
    let errorOutput = '';
    try {
      const companionPath = await remoteCompanionService.ensureInstalled(
        host,
        pathPosix.dirname(pathPosix.dirname(workspace.backend.remoteProjectRoot))
      );
      if (controller.signal.aborted) return [];
      const args = [
        companionPath,
        '__search',
        '--max-results',
        String(search.maxResults),
        '--max-filesize',
        String(fileSizeInBytes(search.maxFileSize)),
        ...(search.ignoreCase ? ['--ignore-case'] : []),
        ...(search.multiline ? ['--multiline'] : []),
        '--',
        search.pattern,
      ];
      // A streaming run gives up its SSH run slot once it starts, so a slow search
      // can't hold up file reads and git status on the host.
      await sshWorkspaceService.runStreaming(
        host,
        `cd ${shellQuotePosix(workspace.backend.remoteDirectory)} || exit 1; ${args.map(shellQuotePosix).join(' ')}`,
        {
          signal: controller.signal,
          onData: (data) => {
            output += data;
          },
          onErrorData: (data) => {
            errorOutput = (errorOutput + data).slice(-8192);
          },
        }
      );
    } catch (error) {
      // A newer search replaced this one; its caller has stopped waiting for it.
      if (controller.signal.aborted) return [];
      logger.warn('SSH content search failed', { workspaceId, error, errorOutput });
      const reason =
        errorOutput.trim().split('\n').pop() || (error instanceof Error ? error.message : '');
      throw new Error(`Couldn't search the SSH host${reason ? `: ${reason}` : ''}`, {
        cause: error,
      });
    } finally {
      if (this.contentSearches.get(workspaceId) === controller) {
        this.contentSearches.delete(workspaceId);
      }
    }
    const results = parseRipgrepOutput(output, search.maxResults);
    if (
      results.length === 0 &&
      output.split('\n').some((line) => line.startsWith('{"type":"stopped"'))
    ) {
      throw new Error('The search took too long on the SSH host. Try a more specific query.');
    }
    return results;
  }

  async readImageFile(workspaceId: string, filePath: string): Promise<WorkspaceImageFile> {
    if (!isImageFile(filePath)) throw new Error('Not an image file');
    const workspace = this.getWorkspace(workspaceId);
    if (!isSshWorkspace(workspace)) {
      return gitService.readImageFileContent(workspace.workingDirectory, filePath);
    }

    return {
      data: await this.readRemoteFile(workspace, filePath, REMOTE_IMAGE_BYTE_CAP),
      mimeType: getMimeType(filePath),
    };
  }

  /**
   * An SSH workspace's own files as Git lists them, untracked ones included, without ignored
   * ones: one call, without the linked workspaces and Komla files listFiles adds.
   */
  async listRemoteGitFiles(workspaceId: string): Promise<string[]> {
    const workspace = this.getWorkspace(workspaceId);
    const script = [
      this.remoteBase64Function(),
      this.remoteBase64AvailabilityCheck(),
      this.remoteFileListFunction(),
      'files_b64=$(git ls-files --cached --others --exclude-standard -z | komla_list_b64)',
      'printf "STATUS=OK\\nENCODING=%s\\nFILES=%s\\n" "$komla_list_encoding" "$files_b64"',
    ].join('\n');
    const values = this.parseKeyValueOutput(await this.runSsh(workspace, script));
    this.assertRemoteEncodingAvailable(values);
    if (values.get('STATUS') !== 'OK') throw new Error('Failed to list remote files');
    const { FILES } = await decodeFileLists(values, ['FILES']);
    return splitNullSeparated(FILES);
  }

  /** An SSH workspace file's bytes, read only when it is at most byteCap bytes. */
  async readRemoteFileBytes(
    workspaceId: string,
    filePath: string,
    byteCap: number
  ): Promise<Buffer> {
    const workspace = this.getWorkspace(workspaceId);
    return Buffer.from(await this.readRemoteFile(workspace, filePath, byteCap), 'base64');
  }

  async writeFile(workspaceId: string, filePath: string, content: string): Promise<void> {
    const workspace = this.getWorkspace(workspaceId);
    if (!isSshWorkspace(workspace)) {
      assertCanonicalLocalRelativePath(workspace.workingDirectory, filePath);
      return gitService.writeFile(workspace.workingDirectory, filePath, content);
    }

    assertCanonicalRemoteRelativePath(filePath);
    logger.debug('writing SSH workspace file', { workspaceId, filePath });
    const linkedPeerPath = this.getLinkedPeerPath(filePath);
    // Receive the whole upload before touching the target so a dropped
    // connection can't leave a truncated file. The final in-place write keeps
    // the file's mode, owner, and hard links, matching local saves.
    let output: string;
    try {
      output = await this.runSsh(
        workspace,
        [
          this.remoteRecordedPeerFunction(workspace),
          `file=${shellQuotePosix(filePath)}`,
          `expected_size=${Buffer.byteLength(content, 'utf8')}`,
          "temp_path=''",
          'cleanup_write() { if [ -n "$temp_path" ]; then rm -f "$temp_path"; fi; }',
          'trap cleanup_write 0',
          "trap 'exit 1' HUP INT TERM",
          'temp_path=$(mktemp "${TMPDIR:-/tmp}/komla-write.XXXXXX") || exit 1',
          'cat > "$temp_path" || exit 1',
          'actual_size=$(wc -c < "$temp_path" | tr -d "[:space:]")',
          'if [ "$actual_size" != "$expected_size" ]; then',
          '  printf "Incomplete upload: expected %s bytes, received %s bytes\\n" "$expected_size" "$actual_size" >&2',
          '  exit 1',
          'fi',
          'workspace_root=$(pwd -P)',
          linkedPeerPath
            ? `allowed_root=$(komla_recorded_peer_root ${shellQuotePosix(linkedPeerPath)}) || { printf "STATUS=UNSAFE\\n"; exit 0; }`
            : 'allowed_root=$workspace_root',
          linkedPeerPath
            ? `peer_workspace_id=$(komla_recorded_peer_id ${shellQuotePosix(linkedPeerPath)}) || { printf "STATUS=UNSAFE\\n"; exit 0; }`
            : 'peer_workspace_id=',
          'parent=${file%/*}',
          'name=${file##*/}',
          'if [ "$parent" = "$file" ]; then parent=.; fi',
          '(',
          ...this.remoteResolveContainedFileScript(),
          '  if [ -e "$file" ] && [ ! -f "$file" ]; then printf "STATUS=NOT_A_FILE\\n"; exit 0; fi',
          '  cat "$temp_path" > "$file" || exit 1',
          '  printf "STATUS=OK\\n"',
          '  if [ -n "$peer_workspace_id" ]; then printf "PEER_ID=%s\\n" "$peer_workspace_id"; fi',
          ')',
        ].join('\n'),
        content
      );
    } catch (error) {
      await this.refreshSshWorkspace(workspace.id);
      throw error;
    }
    const values = this.parseKeyValueOutput(output);
    const status = values.get('STATUS');
    if (status === 'NOT_FOUND') throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
    if (status === 'UNSAFE') {
      throw new Error(`Refusing to write path outside the workspace: '${filePath}'`);
    }
    if (status === 'NOT_A_FILE') throw new Error(`'${filePath}' is not a regular file`);
    if (status !== 'OK') throw new Error('Failed to write remote file');
    await this.refreshSshWorkspace(workspace.id);
    const peerId = values.get('PEER_ID');
    if (peerId && workspaceService.get(peerId)) await this.refreshSshWorkspace(peerId);
  }

  async deletePath(workspaceId: string, filePath: string): Promise<void> {
    const workspace = this.getWorkspace(workspaceId);
    if (!isSshWorkspace(workspace)) {
      assertCanonicalLocalRelativePath(workspace.workingDirectory, filePath);
      if (
        filePath === LINKED_WORKSPACES_DIR ||
        (this.getDirectLinkedWorkspaceEntry(filePath) &&
          (await this.getManagedLocalLinkPaths(workspace)).includes(filePath))
      ) {
        throw new Error('Remove linked workspaces through the linked workspaces dialog');
      }
      return gitService.deleteFile(workspace.workingDirectory, filePath, 'modified');
    }

    assertCanonicalRemoteRelativePath(filePath);
    if (filePath === LINKED_WORKSPACES_DIR) {
      throw new Error('Remove linked workspaces through the linked workspaces dialog');
    }
    logger.info('deleting SSH workspace path', { workspaceId, filePath });
    const linkedPeerPath = this.getLinkedPeerPath(filePath);
    const directLinkCandidate = this.getDirectLinkedWorkspaceEntry(filePath);
    let output: string;
    try {
      output = await this.runSsh(
        workspace,
        [
          'set -e',
          this.remoteRecordedPeerFunction(workspace),
          `target=${shellQuotePosix(filePath)}`,
          'workspace_root=$(pwd -P)',
          directLinkCandidate
            ? 'if komla_recorded_peer_root "$target" >/dev/null; then'
            : 'if false; then',
          '  printf "STATUS=MANAGED_LINK\\n"',
          '  exit 0',
          'fi',
          linkedPeerPath
            ? `allowed_root=$(komla_recorded_peer_root ${shellQuotePosix(linkedPeerPath)}) || { printf "STATUS=UNSAFE\\n"; exit 0; }`
            : 'allowed_root=$workspace_root',
          linkedPeerPath
            ? `peer_workspace_id=$(komla_recorded_peer_id ${shellQuotePosix(linkedPeerPath)}) || { printf "STATUS=UNSAFE\\n"; exit 0; }`
            : 'peer_workspace_id=',
          'parent=${target%/*}',
          'name=${target##*/}',
          'if [ "$parent" = "$target" ]; then parent=.; fi',
          '(',
          '  if ! CDPATH= cd -P -- "$parent" 2>/dev/null; then',
          '    printf "STATUS=NOT_FOUND\\n"',
          '    exit 0',
          '  fi',
          '  canonical_parent=$(pwd -P)',
          '  case "$canonical_parent/" in',
          '    "$allowed_root/"*) ;;',
          '    *) printf "STATUS=UNSAFE\\n"; exit 0 ;;',
          '  esac',
          '  target=./"$name"',
          '  if [ -L "$target" ] || [ -f "$target" ]; then',
          '    rm -f -- "$target"',
          '  elif [ -d "$target" ]; then',
          '    rm -rf -- "$target"',
          '  elif [ -e "$target" ]; then',
          '    rm -f -- "$target"',
          '  else',
          '    printf "STATUS=NOT_FOUND\\n"',
          '    exit 0',
          '  fi',
          '  printf "STATUS=OK\\n"',
          '  if [ -n "$peer_workspace_id" ]; then printf "PEER_ID=%s\\n" "$peer_workspace_id"; fi',
          ')',
        ].join('\n')
      );
    } catch (error) {
      await workspaceStatusService.change({
        kind: 'repository-mutated',
        workspaceId: workspace.id,
      });
      throw error;
    }
    const values = this.parseKeyValueOutput(output);
    const status = values.get('STATUS');
    if (status === 'NOT_FOUND') {
      throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
    }
    if (status === 'UNSAFE') {
      throw new Error(`Refusing to delete path outside the workspace: '${filePath}'`);
    }
    if (status === 'MANAGED_LINK') {
      throw new Error('Remove linked workspaces through the linked workspaces dialog');
    }
    if (status !== 'OK') throw new Error('Failed to delete remote path');
    await this.refreshSshWorkspace(workspace.id);
    const peerId = values.get('PEER_ID');
    if (peerId && workspaceService.get(peerId)) await this.refreshSshWorkspace(peerId);
  }

  async importExternalFile(
    workspaceId: string,
    sourcePath: string,
    preferredName?: string,
    executionLocation: TerminalExecutionLocation = 'workspace'
  ): Promise<string> {
    return this.importExternalFileInto(
      this.getWorkspace(workspaceId),
      sourcePath,
      preferredName,
      executionLocation
    );
  }

  /** Imports into a workspace object, which creation may not have published yet. */
  async importExternalFileInto(
    workspace: Workspace,
    sourcePath: string,
    preferredName?: string,
    executionLocation: TerminalExecutionLocation = 'workspace'
  ): Promise<string> {
    if (isLocalTerminalExecutionLocation(executionLocation)) {
      if (!isSshWorkspace(workspace)) {
        throw new Error('Local copy file imports require an SSH workspace');
      }
      const mirrorPath = localMirrorService.getMirrorPath(workspace.id, workspace.backend);
      return gitService.importExternalFile(mirrorPath, sourcePath, preferredName);
    }
    if (!isSshWorkspace(workspace)) {
      return gitService.importExternalFile(workspace.workingDirectory, sourcePath, preferredName);
    }
    if (!isAbsolute(sourcePath)) throw new Error('Source path must be absolute');
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) throw new Error('Source is not a file');

    const { baseName, extension } = getImportedFileNameParts(sourcePath, preferredName);
    logger.debug('importing file into SSH workspace', {
      workspaceId: workspace.id,
      preferredName,
    });
    const script = [
      'set -e',
      `import_dir=${shellQuotePosix(KOMLA_FILES_DIR)}`,
      `base_name=${shellQuotePosix(baseName)}`,
      `extension=${shellQuotePosix(extension)}`,
      `expected_size=${sourceStats.size}`,
      `gitignore_path=${shellQuotePosix(`${KOMLA_FILES_DIR}/${KOMLA_FILES_GITIGNORE}`)}`,
      'if [ -L "$import_dir" ]; then printf "Komla import folder cannot be a symlink\\n" >&2; exit 1; fi',
      'mkdir -p "$import_dir"',
      'if [ ! -d "$import_dir" ]; then printf "Komla import path is not a directory\\n" >&2; exit 1; fi',
      // Ignores everything in the folder wherever it sits in the repository. An earlier
      // import named .gitignore moves to the next free name.
      'if [ -L "$gitignore_path" ]; then rm -f "$gitignore_path"; fi',
      `if [ -f "$gitignore_path" ] && [ "$(cat "$gitignore_path")" != ${shellQuotePosix(KOMLA_FILES_GITIGNORE_CONTENT.trimEnd())} ]; then`,
      '  gitignore_suffix=2',
      '  while [ -e "$gitignore_path-$gitignore_suffix" ] || [ -L "$gitignore_path-$gitignore_suffix" ]; do',
      '    gitignore_suffix=$((gitignore_suffix + 1))',
      '  done',
      '  mv "$gitignore_path" "$gitignore_path-$gitignore_suffix"',
      'fi',
      'if [ ! -e "$gitignore_path" ] && [ ! -L "$gitignore_path" ]; then',
      `  (set -C; printf '%s' ${shellQuotePosix(KOMLA_FILES_GITIGNORE_CONTENT)} > "$gitignore_path") 2>/dev/null || true`,
      'fi',
      ...this.remoteImportDestinationScript(),
      'temp_path=$(mktemp "$import_dir/.komla-upload.XXXXXX")',
      'cat > "$temp_path"',
      'actual_size=$(wc -c < "$temp_path" | tr -d "[:space:]")',
      'if [ "$actual_size" != "$expected_size" ]; then',
      '  printf "Incomplete upload: expected %s bytes, received %s bytes\n" "$expected_size" "$actual_size" >&2',
      '  exit 1',
      'fi',
      'chmod 600 "$temp_path"',
      'mv -f "$temp_path" "$result_path"',
      "temp_path=''",
      // An agent could swap the folder for a symlink during the upload; take back what went through it.
      'if [ -L "$import_dir" ]; then printf "Komla import folder cannot be a symlink\\n" >&2; exit 1; fi',
      "reserved_path=''",
      'trap - 0 HUP INT TERM',
      'printf "STATUS=OK\\nPATH=%s\\n" "$result_path"',
    ].join('\n');
    const values = this.parseKeyValueOutput(
      await this.runSshWithFile(workspace, script, sourcePath)
    );
    if (values.get('STATUS') !== 'OK') throw new Error('Failed to import file into SSH workspace');
    const importedPath = values.get('PATH') ?? '';
    assertSafeRemoteRelativePath(importedPath);
    if (!importedPath.startsWith(`${KOMLA_FILES_DIR}/`)) {
      throw new Error('SSH import returned an unexpected path');
    }
    return importedPath;
  }

  /**
   * Reads a file for the file viewer without copying it: from the workspace, or wherever
   * the terminal that printed its path runs.
   */
  async readViewerFile(
    workspaceId: string,
    terminalId: string | null,
    source: ViewerFileSource
  ): Promise<ViewerFile> {
    if (source.kind === 'workspace') {
      const workspace = this.getWorkspace(workspaceId);
      const { filePath } = source;
      const mimeType = getMimeType(filePath);
      if (isSshWorkspace(workspace)) {
        return {
          data: await this.readRemoteFile(workspace, filePath, viewerByteCap(filePath, true)),
          mimeType,
        };
      }
      assertSafeRelativePath(workspace.workingDirectory, filePath, 'filePath');
      return {
        data: await readLocalViewerFile(
          join(workspace.workingDirectory, filePath),
          viewerByteCap(filePath, false),
          true
        ),
        mimeType,
      };
    }

    const { fullPath } = source;
    const { workspace, terminal } = this.getTerminalFileSource(workspaceId, terminalId, fullPath);
    const mimeType = getMimeType(fullPath);
    const run = this.getTerminalFileRunner(workspace, terminal);
    if (run) {
      return { data: await this.readTerminalFileWith(fullPath, run), mimeType };
    }
    return {
      data: await readLocalViewerFile(
        expandTerminalHome(fullPath),
        viewerByteCap(fullPath, false),
        false
      ),
      mimeType,
    };
  }

  /**
   * A preview URL that shows an HTML page or PDF in the file viewer. With `replacesPrevious`, a
   * file shown on its own replaces the copy the last such call made of it, for a view that asks
   * again and again, as each hover of the files list does, and no other view uses.
   */
  async getViewerPreviewUrl(
    workspaceId: string,
    terminalId: string | null,
    source: ViewerFileSource,
    options: { replacesPrevious?: boolean } = {}
  ): Promise<string> {
    const filePath = source.kind === 'workspace' ? source.filePath : source.fullPath;
    const kind = getViewableFileKind(filePath);
    if (kind !== 'html' && kind !== 'pdf') throw new Error('Not an HTML or PDF file');

    // Served from its folder, so a page's own stylesheets, scripts and images load.
    if (source.kind === 'workspace') {
      const workspace = this.getWorkspace(workspaceId);
      if (
        !isSshWorkspace(workspace) &&
        !source.filePath.split('/').some((segment) => segment.startsWith('.'))
      ) {
        return htmlPreviewService.createPreviewUrl(workspace.workingDirectory, source.filePath);
      }
    } else {
      const { workspace, terminal } = this.getTerminalFileSource(
        workspaceId,
        terminalId,
        source.fullPath
      );
      const localPath = expandTerminalHome(source.fullPath);
      const name = pathPosix.basename(localPath);
      if (!this.getTerminalFileRunner(workspace, terminal) && !name.startsWith('.')) {
        // A Local copy terminal of an SSH workspace runs in the workspace's mirror.
        const ownFolder = isSshWorkspace(workspace)
          ? localMirrorService.getMirrorPath(workspace.id, workspace.backend)
          : workspace.workingDirectory;
        const folder = await servableViewerFolder(pathPosix.dirname(localPath), ownFolder);
        if (folder) return htmlPreviewService.createPreviewUrl(folder, name);
      }
    }

    // Otherwise the file is shown on its own.
    const content = Buffer.from(
      (await this.readViewerFile(workspaceId, terminalId, source)).data,
      'base64'
    );
    // Keyed by the file, so the copy before goes instead of staying for an hour.
    const owner = source.kind === 'workspace' ? 'workspace' : `terminal:${terminalId}`;
    return htmlPreviewService.createContentPreviewUrl(
      pathPosix.basename(filePath),
      kind === 'pdf' ? content : content.toString('utf8'),
      options.replacesPrevious
        ? { web: true, key: `viewer:${workspaceId}:${owner}:${filePath}` }
        : { web: true }
    );
  }

  /**
   * The folders and the files the file viewer can show in a file's folder, or in a folder
   * whose path ends in a slash, each newest first: in the workspace, or wherever the
   * terminal that printed the path runs.
   */
  async listViewerFolder(
    workspaceId: string,
    terminalId: string | null,
    source: ViewerFileSource
  ): Promise<ViewerFolderFile[]> {
    if (source.kind === 'workspace') {
      const workspace = this.getWorkspace(workspaceId);
      const folder = viewerFolderOf(source.filePath);
      if (isSshWorkspace(workspace)) {
        assertCanonicalRemoteRelativePath(source.filePath.endsWith('/') ? folder : source.filePath);
        return this.listViewerFolderWith(folder, (script) => this.runSsh(workspace, script), true);
      }
      assertSafeRelativePath(workspace.workingDirectory, source.filePath, 'filePath');
      return listLocalViewerFolder(join(workspace.workingDirectory, folder));
    }

    const { fullPath } = source;
    const { workspace, terminal } = this.getTerminalFileSource(workspaceId, terminalId, fullPath);
    const folder = viewerFolderOf(fullPath);
    const run = this.getTerminalFileRunner(workspace, terminal);
    return run
      ? this.listViewerFolderWith(folder, run, false)
      : listLocalViewerFolder(expandTerminalHome(folder));
  }

  /** Runs a script where a terminal's files are, or returns null when that is this computer. */
  private getTerminalFileRunner(
    workspace: Workspace,
    terminal: Workspace['terminals'][number]
  ): ((script: string) => Promise<string>) | null {
    if (isSshWorkspace(workspace) && terminal.executionLocation !== 'local-mirror') {
      return (script) => this.runSsh(workspace, script);
    }
    return null;
  }

  private async readTerminalFileWith(
    sourcePath: string,
    run: (script: string) => Promise<string>
  ): Promise<string> {
    const values = this.parseKeyValueOutput(
      await run(
        [
          this.remoteBase64Function(),
          this.remoteBase64AvailabilityCheck(),
          `source_path=${shellQuoteTerminalPath(sourcePath)}`,
          `cap=${viewerByteCap(sourcePath, true)}`,
          'if [ -L "$source_path" ]; then printf "STATUS=SYMLINK\\n"; exit 0; fi',
          'if [ ! -f "$source_path" ] || [ ! -r "$source_path" ]; then printf "STATUS=NOT_FOUND\\n"; exit 0; fi',
          'size=$(wc -c <"$source_path" | tr -d " ")',
          'if [ "$size" -gt "$cap" ] 2>/dev/null; then printf "STATUS=TOO_LARGE\\nSIZE=%s\\n" "$size"; exit 0; fi',
          'printf "STATUS=OK\\nDATA="',
          'komla_b64 <"$source_path"',
          'printf "\\n"',
        ].join('\n')
      )
    );
    this.assertRemoteEncodingAvailable(values);
    const status = values.get('STATUS');
    if (status === 'NOT_FOUND') {
      throw new Error(`ENOENT: no such readable file, '${sourcePath}'`);
    }
    if (status === 'SYMLINK') throw new Error('Source symlinks are not supported');
    if (status === 'TOO_LARGE') {
      throw new Error(`File is too large to view (${values.get('SIZE') ?? 'unknown'} bytes)`);
    }
    if (status !== 'OK') throw new Error('Failed to read terminal file');
    return values.get('DATA') ?? '';
  }

  /**
   * Lists a folder for the file viewer by script, naming folders with a trailing slash and
   * counting folders and files apart, so subfolders never crowd out the files. `ls -t` sorts
   * newest first and leaves out hidden files; symlinks are left out too, since the viewer
   * won't read them. `stat` adds when each was modified (GNU and BusyBox take `-c`, macOS
   * and BSD `-f`); the names are listed without it where `stat` or `xargs` is missing.
   */
  private async listViewerFolderWith(
    folder: string,
    run: (script: string) => Promise<string>,
    insideWorkingDirectory: boolean
  ): Promise<ViewerFolderFile[]> {
    const values = this.parseKeyValueOutput(
      await run(
        [
          this.remoteBase64Function(),
          this.remoteBase64AvailabilityCheck(),
          'working_directory=$(pwd -P)',
          // Only a terminal's path can start at its user's home folder.
          `folder=${insideWorkingDirectory ? shellQuotePosix(folder) : shellQuoteTerminalPath(folder)}`,
          `limit=${VIEWER_FOLDER_NAME_LIMIT}`,
          'cd -P -- "$folder" 2>/dev/null || { printf "STATUS=NOT_FOUND\\n"; exit 0; }',
          ...(insideWorkingDirectory
            ? [
                'case "$(pwd -P)/" in "$working_directory"/*) ;; *) printf "STATUS=UNSAFE\\n"; exit 0 ;; esac',
              ]
            : []),
          'if stat -c %Y . >/dev/null 2>&1; then',
          '  stat_flag=-c stat_format=%Y/%n',
          'else',
          '  stat_flag=-f stat_format=%m/%N',
          'fi',
          'list_files() {',
          '  ls -t 2>/dev/null | {',
          '    files=0 folders=0',
          '    while IFS= read -r name; do',
          '      if [ -L "$name" ]; then continue; fi',
          '      if [ -f "$name" ] && [ "$files" -lt "$limit" ]; then',
          '        printf \'%s\\000\' "$name"',
          '        files=$((files + 1))',
          '      elif [ -d "$name" ] && [ "$folders" -lt "$limit" ]; then',
          '        printf \'%s/\\000\' "$name"',
          '        folders=$((folders + 1))',
          '      fi',
          '      if [ "$files" -ge "$limit" ] && [ "$folders" -ge "$limit" ]; then break; fi',
          '    done',
          '  }',
          '}',
          'names_b64=$(list_files | komla_b64)',
          'times_b64=$({ list_files | xargs -0 stat "$stat_flag" "$stat_format" --; } 2>/dev/null | tr "\\n" "\\000" | komla_b64)',
          'printf "STATUS=OK\\nNAMES=%s\\nTIMES=%s\\n" "$names_b64" "$times_b64"',
        ].join('\n')
      )
    );
    this.assertRemoteEncodingAvailable(values);
    const status = values.get('STATUS');
    if (status === 'NOT_FOUND') throw new Error(`ENOENT: no such folder, '${folder}'`);
    if (status === 'UNSAFE') {
      throw new Error(`Refusing to list a folder outside the workspace: '${folder}'`);
    }
    if (status !== 'OK') throw new Error('Failed to list folder');
    const modifiedTimes = parseStatModifiedTimes(values.get('TIMES') ?? '');
    return foldersThenFiles(
      decodeNullSeparatedBase64(values.get('NAMES') ?? '')
        .filter(isViewerFolderEntry)
        .map((name) => viewerFolderFile(name, modifiedTimes.get(name)))
    );
  }

  private getTerminalFileSource(
    workspaceId: string,
    terminalId: string | null,
    sourcePath: string
  ) {
    if (terminalId === null) throw new Error('A terminal file needs its terminal');
    const workspace = this.getWorkspace(workspaceId);
    if (!pathPosix.isAbsolute(sourcePath) && !sourcePath.startsWith('~/')) {
      throw new Error('Source path must be an absolute POSIX path or start with ~/');
    }
    if (sourcePath.includes('\0')) throw new Error('Source path contains an invalid null byte');
    const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal) throw new Error(`Terminal ${terminalId} not found in workspace ${workspaceId}`);
    return { workspace, terminal };
  }

  private remoteImportDestinationScript(): string[] {
    return [
      "reserved_path=''",
      "temp_path=''",
      'cleanup_import() {',
      '  if [ -n "$temp_path" ]; then rm -f "$temp_path"; fi',
      '  if [ -n "$reserved_path" ]; then rm -f "$reserved_path"; fi',
      '}',
      'trap cleanup_import 0 HUP INT TERM',
      'suffix=1',
      'while :; do',
      '  if [ "$suffix" -eq 1 ]; then',
      '    candidate="$import_dir/$base_name$extension"',
      '  else',
      '    candidate="$import_dir/$base_name-$suffix$extension"',
      '  fi',
      '  if (set -C; : > "$candidate") 2>/dev/null; then reserved_path=$candidate; result_path=$candidate; break; fi',
      '  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then',
      '    printf "Unable to reserve remote import path: %s\\n" "$candidate" >&2',
      '    exit 1',
      '  fi',
      '  suffix=$((suffix + 1))',
      '  if [ "$suffix" -gt 10000 ]; then',
      '    printf "Unable to reserve remote import path after 10000 attempts\\n" >&2',
      '    exit 1',
      '  fi',
      'done',
    ];
  }

  private getWorkspace(workspaceId: string): Workspace {
    const workspace = workspaceService.get(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    return workspace;
  }

  private async readRemoteFile(
    workspace: Workspace,
    filePath: string,
    byteCap: number
  ): Promise<string> {
    assertCanonicalRemoteRelativePath(filePath);
    logger.debug('reading SSH workspace file', { workspaceId: workspace.id, filePath });
    const linkedPeerPath = this.getLinkedPeerPath(filePath);
    const output = await this.runSsh(
      workspace,
      [
        this.remoteBase64Function(),
        this.remoteBase64AvailabilityCheck(),
        this.remoteRecordedPeerFunction(workspace),
        `file=${shellQuotePosix(filePath)}`,
        `cap=${byteCap}`,
        'workspace_root=$(pwd -P)',
        linkedPeerPath
          ? `allowed_root=$(komla_recorded_peer_root ${shellQuotePosix(linkedPeerPath)}) || { printf "STATUS=UNSAFE\\n"; exit 0; }`
          : 'allowed_root=$workspace_root',
        'parent=${file%/*}',
        'name=${file##*/}',
        'if [ "$parent" = "$file" ]; then parent=.; fi',
        '(',
        ...this.remoteResolveContainedFileScript(),
        '  if [ ! -f "$file" ]; then printf "STATUS=NOT_FOUND\\n"; exit 0; fi',
        '  size=$(wc -c <"$file" 2>/dev/null | tr -d " " || printf "0")',
        '  if [ "$size" -gt "$cap" ] 2>/dev/null; then printf "STATUS=TOO_LARGE\\nSIZE=%s\\n" "$size"; exit 0; fi',
        '  printf "STATUS=OK\\nDATA="',
        '  komla_b64 <"$file"',
        '  printf "\\n"',
        ')',
      ].join('\n')
    );
    const values = this.parseKeyValueOutput(output);
    this.assertRemoteEncodingAvailable(values);
    const status = values.get('STATUS');
    if (status === 'NOT_FOUND') throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
    if (status === 'UNSAFE') {
      throw new Error(`Refusing to read path outside the workspace: '${filePath}'`);
    }
    if (status === 'TOO_LARGE') {
      const size = values.get('SIZE') ?? 'unknown';
      throw new Error(`Remote file is too large to view (${size} bytes)`);
    }
    if (status !== 'OK') throw new Error('Failed to read remote file');
    return values.get('DATA') ?? '';
  }

  /**
   * Shell lines, run inside a subshell, that cd into the canonical parent of
   * "$parent/$name" and leave "$file" naming it. Symlinks are followed only
   * while they stay under "$allowed_root"; anything else prints STATUS=UNSAFE
   * or STATUS=NOT_FOUND and exits the subshell.
   */
  private remoteResolveContainedFileScript(): string[] {
    return [
      '  if ! CDPATH= cd -P -- "$parent" 2>/dev/null; then',
      '    printf "STATUS=NOT_FOUND\\n"',
      '    exit 0',
      '  fi',
      '  canonical_parent=$(pwd -P)',
      '  case "$canonical_parent/" in',
      '    "$allowed_root/"*) ;;',
      '    *) printf "STATUS=UNSAFE\\n"; exit 0 ;;',
      '  esac',
      '  file=./"$name"',
      '  link_hops=0',
      '  while [ -L "$file" ]; do',
      '    link_hops=$((link_hops + 1))',
      '    if [ "$link_hops" -gt 40 ]; then printf "STATUS=UNSAFE\\n"; exit 0; fi',
      '    link_target=$(readlink "$file") || { printf "STATUS=UNSAFE\\n"; exit 0; }',
      '    case "$link_target" in',
      '      /*) next_path=$link_target ;;',
      '      *) next_path=$canonical_parent/$link_target ;;',
      '    esac',
      '    next_parent=${next_path%/*}',
      '    next_name=${next_path##*/}',
      '    if [ -z "$next_parent" ]; then next_parent=/; fi',
      '    if ! CDPATH= cd -P -- "$next_parent" 2>/dev/null; then',
      '      printf "STATUS=NOT_FOUND\\n"',
      '      exit 0',
      '    fi',
      '    canonical_parent=$(pwd -P)',
      '    case "$canonical_parent/" in',
      '      "$allowed_root/"*) ;;',
      '      *) printf "STATUS=UNSAFE\\n"; exit 0 ;;',
      '    esac',
      '    file=./"$next_name"',
      '  done',
    ];
  }

  private remoteBase64Function(): string {
    return [
      'komla_b64() {',
      '  if command -v base64 >/dev/null 2>&1; then base64 | tr -d "\\n"; return; fi',
      '  if command -v openssl >/dev/null 2>&1; then openssl base64 -A; return; fi',
      '  printf "Remote host needs base64 or openssl\\n" >&2',
      '  return 127',
      '}',
    ].join('\n');
  }

  /** Defines komla_list_b64, which gzips a listing before encoding it when the host has gzip. */
  private remoteFileListFunction(): string {
    return [
      'if command -v gzip >/dev/null 2>&1; then',
      '  komla_list_encoding=gzip',
      '  komla_list_b64() { gzip -c | komla_b64; }',
      'else',
      '  komla_list_encoding=plain',
      '  komla_list_b64() { komla_b64; }',
      'fi',
    ].join('\n');
  }

  private getLinkedPeerPath(filePath: string): string | undefined {
    const segments = filePath.split('/');
    if (segments[0] !== LINKED_WORKSPACES_DIR || segments.length < 3) return undefined;
    return `${LINKED_WORKSPACES_DIR}/${segments[1]}`;
  }

  private getDirectLinkedWorkspaceEntry(filePath: string): string | undefined {
    const segments = filePath.split('/');
    return segments[0] === LINKED_WORKSPACES_DIR && segments.length === 2 ? filePath : undefined;
  }

  private async getManagedLocalLinkPaths(workspace: Workspace): Promise<string[]> {
    const peerDirectories = new Set(
      (workspace.linkedWorkspaceIds ?? [])
        .map((id) => workspaceService.get(id))
        .filter((peer): peer is Workspace => peer !== undefined && !isSshWorkspace(peer))
        .map((peer) => resolve(peer.workingDirectory))
    );
    if (peerDirectories.size === 0) return [];

    const folder = join(workspace.workingDirectory, LINKED_WORKSPACES_DIR);
    try {
      const entries = await readdir(folder);
      const managedLinks = await Promise.all(
        entries.map(async (entry) => {
          try {
            const linkPath = join(folder, entry);
            const stats = await lstat(linkPath);
            if (!stats.isSymbolicLink()) return undefined;
            const targetPath = resolve(dirname(linkPath), await readlink(linkPath));
            return peerDirectories.has(targetPath)
              ? `${LINKED_WORKSPACES_DIR}/${entry}`
              : undefined;
          } catch {
            return undefined;
          }
        })
      );
      return managedLinks.filter((linkPath): linkPath is string => linkPath !== undefined);
    } catch {
      return [];
    }
  }

  private async refreshSshWorkspace(workspaceId: string): Promise<void> {
    await workspaceStatusService.change({ kind: 'repository-mutated', workspaceId });
  }

  private remoteRecordedPeerFunction(workspace: Workspace): string {
    const peers = (workspace.linkedWorkspaceIds ?? [])
      .map((id) => workspaceService.get(id))
      .filter(
        (peer): peer is Workspace =>
          peer !== undefined &&
          isSshWorkspace(peer) &&
          isSshWorkspace(workspace) &&
          peer.backend.hostId === workspace.backend.hostId
      );
    return [
      'komla_resolve_recorded_peer() {',
      '  candidate=$1',
      '  [ -L "$candidate" ] && [ -d "$candidate" ] || return 1',
      '  candidate_root=$(CDPATH= cd -P -- "$candidate" 2>/dev/null && pwd -P) || return 1',
      ...peers.flatMap((peer) => [
        `  allowed_root=$(CDPATH= cd -P -- ${shellQuotePosix(isSshWorkspace(peer) ? peer.backend.remoteDirectory : peer.workingDirectory)} 2>/dev/null && pwd -P) || allowed_root=`,
        '  if [ -n "$allowed_root" ] && [ "$candidate_root" = "$allowed_root" ]; then',
        `    komla_peer_id=${shellQuotePosix(peer.id)}`,
        '    komla_peer_root=$allowed_root',
        '    return 0',
        '  fi',
      ]),
      '  return 1',
      '}',
      'komla_recorded_peer_root() {',
      '  komla_resolve_recorded_peer "$1" || return 1',
      '  printf "%s\\n" "$komla_peer_root"',
      '}',
      'komla_recorded_peer_id() {',
      '  komla_resolve_recorded_peer "$1" || return 1',
      '  printf "%s\\n" "$komla_peer_id"',
      '}',
    ].join('\n');
  }

  private remoteBase64AvailabilityCheck(): string {
    return [
      'if ! command -v base64 >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then',
      '  printf "STATUS=ENCODING_UNAVAILABLE\\n"',
      '  exit 0',
      'fi',
    ].join('\n');
  }

  private assertRemoteEncodingAvailable(values: Map<string, string>): void {
    if (values.get('STATUS') === 'ENCODING_UNAVAILABLE') {
      throw new Error('Remote host needs base64 or openssl to view files');
    }
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

  private async runSsh(workspace: Workspace, script: string, input?: string): Promise<string> {
    if (!isSshWorkspace(workspace)) throw new Error('Workspace is not an SSH workspace');
    const host = sshWorkspaceService.getHost(workspace.backend.hostId);
    const command = `cd ${shellQuotePosix(workspace.backend.remoteDirectory)} || exit 1; ${script}`;
    return input === undefined
      ? sshWorkspaceService.run(host, command, { purpose: { kind: 'interactive' } })
      : sshWorkspaceService.runWithInput(host, command, input, {
          purpose: { kind: 'interactive' },
        });
  }

  private async runSshWithFile(
    workspace: Workspace,
    script: string,
    sourcePath: string
  ): Promise<string> {
    if (!isSshWorkspace(workspace)) throw new Error('Workspace is not an SSH workspace');
    const host = sshWorkspaceService.getHost(workspace.backend.hostId);
    return sshWorkspaceService.runWithFileInput(
      host,
      `cd ${shellQuotePosix(workspace.backend.remoteDirectory)} || exit 1; ${script}`,
      sourcePath,
      { purpose: { kind: 'interactive' } }
    );
  }
}

export const workspaceFileService = new WorkspaceFileService();
