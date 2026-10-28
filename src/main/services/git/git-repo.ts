import { spawn } from 'child_process';
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  copyFileSync,
  cpSync,
  renameSync,
} from 'fs';
import { lstat, readFile, readdir, stat } from 'fs/promises';
import { extname, isAbsolute, join, basename, dirname, relative, sep } from 'path';

import { shell } from 'electron';

import { isImageFile, isMediaFile, getMediaKind, getMimeType } from '../../../shared/image-utils';
import { applySshAskpassEnv } from '../../lib/ssh-client';
import { askpassService } from '../askpass.service';

import { gitExec, extractGitError, gitUsesPathSsh, GitProgressCallback } from './git-exec';
import {
  KOMLA_FILES_DIR,
  KOMLA_FILES_GITIGNORE,
  KOMLA_FILES_GITIGNORE_CONTENT,
} from './git-status';
import { listFolderFiles } from './list-folder-files';

// Ignored files are listed one by one, so a tree full of them could make the listing huge.
const IGNORED_LISTING_MAX_CHARS = 1_000_000;

export function getImportedFileNameParts(
  sourcePath: string,
  preferredName?: string
): { baseName: string; extension: string } {
  const nameSource = preferredName || basename(sourcePath);
  const rawExt = extname(nameSource) || extname(sourcePath);
  const extChars = rawExt.replace(/[^a-zA-Z0-9]+/g, '');
  const extension = extChars ? `.${extChars.toLowerCase()}` : '';
  const stem = basename(nameSource, rawExt)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return { baseName: stem || 'file', extension };
}

/** A file's path under a listed folder, with forward slashes as `git ls-files` prints them. */
function listedPath(basePath: string, fullPath: string): string {
  return relative(basePath, fullPath).split(sep).join('/');
}

export interface RepoWebInfo {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'unknown';
  webUrl: string | null;
}

class GitRepoService {
  /**
   * Create a bare clone of a repository
   */
  async cloneBare(sourcePath: string, destinationPath: string): Promise<void> {
    // Ensure parent directory exists
    const parentDir = dirname(destinationPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    await gitExec.execGitAsync(parentDir, ['clone', '--bare', '--', sourcePath, destinationPath]);
  }

  /**
   * Create a bare clone directly from a remote URL
   * Uses progress streaming for real-time feedback
   * Supports SSH passphrase prompting via native dialog
   */
  async cloneBareFromRemote(
    url: string,
    destinationPath: string,
    onProgress?: GitProgressCallback
  ): Promise<void> {
    // Ensure parent directory exists
    const parentDir = dirname(destinationPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    await gitExec.execGitWithProgress(
      parentDir,
      [
        'clone',
        '--bare',
        '--progress',
        // Add a fetch refspec so remote-tracking refs (refs/remotes/origin/*)
        // are populated during the clone itself — without this, bare clones only
        // store branches under refs/heads/* and `git branch -r` returns nothing.
        '--config',
        'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*',
        // Never read a URL starting with "-" as an option.
        '--',
        url,
        basename(destinationPath),
      ],
      onProgress,
      { enableAskpass: true }
    );
  }

  /**
   * Clone a repository from a remote URL
   * Uses progress streaming for real-time feedback
   * Supports SSH passphrase prompting via native dialog
   */
  async cloneFromRemote(
    url: string,
    destinationPath: string,
    onProgress?: GitProgressCallback
  ): Promise<void> {
    // Ensure parent directory exists
    const parentDir = dirname(destinationPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    await gitExec.execGitWithProgress(
      parentDir,
      ['clone', '--progress', '--', url, basename(destinationPath)],
      onProgress,
      { enableAskpass: true }
    );
  }

  /**
   * Initialize a new empty git repository
   */
  async initRepo(path: string): Promise<void> {
    // Ensure directory exists
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }

    await gitExec.execGitAsync(path, ['init']);
  }

  /**
   * Initialize a new bare git repository with an initial commit
   * Creates a main branch with an empty initial commit
   */
  async initBareRepo(path: string): Promise<void> {
    // Ensure parent directory exists
    const parentDir = dirname(path);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Initialize bare repo
    await gitExec.execGitAsync(parentDir, ['init', '--bare', path]);

    // Create an initial commit using git low-level commands
    // This creates an empty tree, then a commit pointing to it, then sets main to that commit
    const emptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // Git's well-known empty tree hash

    // Create the initial commit
    const commitHash = await gitExec.execGitAsync(path, [
      'commit-tree',
      emptyTreeHash,
      '-m',
      'Initial commit',
    ]);

    // Set main branch to point to the commit
    await gitExec.execGitAsync(path, ['update-ref', 'refs/heads/main', commitHash]);

    // Set HEAD to point to main
    await gitExec.execGitAsync(path, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }

  /**
   * Add a remote to a repository
   */
  async addRemote(repoPath: string, name: string, url: string): Promise<void> {
    await gitExec.execGitAsync(repoPath, ['remote', 'add', '--', name, url]);
  }

  /** Whether this repo knows of any branch on origin. */
  private async originHasBranches(repoPath: string): Promise<boolean> {
    const branch = await gitExec.execGitAsync(repoPath, [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      'refs/remotes/origin/',
    ]);
    return branch !== '';
  }

  /**
   * Points origin at `url`. An origin with no branches, such as one no repository answers at,
   * is replaced; one with branches is left alone.
   */
  async setOriginRemote(repoPath: string, url: string): Promise<void> {
    if (!(await gitExec.hasRemote(repoPath, 'origin'))) {
      await this.addRemote(repoPath, 'origin', url);
      return;
    }
    if (await this.originHasBranches(repoPath)) {
      throw new Error('origin already has branches. Change its URL with git remote set-url.');
    }
    await gitExec.execGitAsync(repoPath, ['remote', 'set-url', '--', 'origin', url]);
  }

  /**
   * Removes origin when it has no branches, so a project whose first push failed counts as
   * unpublished again. Returns whether it did.
   */
  async removeOriginWithoutBranches(repoPath: string): Promise<boolean> {
    if (await this.originHasBranches(repoPath).catch(() => true)) return false;
    await gitExec.execGitAsync(repoPath, ['remote', 'remove', 'origin']);
    return true;
  }

  /**
   * Remove a remote from a repository
   */
  async removeRemote(repoPath: string, name: string): Promise<void> {
    try {
      await gitExec.execGitAsync(repoPath, ['remote', 'remove', name]);
    } catch {
      // Ignore if remote doesn't exist
    }
  }

  /**
   * Check if a path is a bare git repository
   */
  async isBareRepo(path: string): Promise<boolean> {
    try {
      const result = await gitExec.execGitAsync(path, ['rev-parse', '--is-bare-repository']);
      return result === 'true';
    } catch {
      return false;
    }
  }

  async getRepoName(path: string): Promise<string> {
    // Try to get name from remote origin URL
    try {
      const remoteUrl = await gitExec.execGitAsync(path, ['remote', 'get-url', 'origin']);
      // Extract repo name from URL (handles both HTTPS and SSH formats)
      // Examples:
      //   https://github.com/user/repo.git -> repo
      //   git@github.com:user/repo.git -> repo
      //   https://github.com/user/repo -> repo
      const match = remoteUrl.match(/\/([^/]+?)(\.git)?$/) || remoteUrl.match(/:([^/]+?)(\.git)?$/);
      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // No remote origin, fall through to folder name
    }

    // Fall back to folder name. Managed bare repositories live at <project>/.git,
    // or <project>/repo.git before that, where the parent identifies the actual project.
    const folderName = basename(path);
    if (['.git', 'repo.git'].includes(folderName.toLowerCase()) && (await this.isBareRepo(path))) {
      return basename(dirname(path)) || folderName;
    }
    return folderName;
  }

  async getRemoteUrl(repoPath: string): Promise<string | null> {
    try {
      return await gitExec.execGitAsync(repoPath, ['remote', 'get-url', 'origin']);
    } catch {
      return null;
    }
  }

  async getRemoteUrlByName(repoPath: string, remoteName: string): Promise<string | null> {
    try {
      return await gitExec.execGitAsync(repoPath, ['remote', 'get-url', remoteName]);
    } catch {
      return null;
    }
  }

  async getRepoWebInfo(repoPath: string): Promise<RepoWebInfo> {
    const remoteUrl = await this.getRemoteUrl(repoPath);
    if (!remoteUrl) {
      return { provider: 'unknown', webUrl: null };
    }

    // Parse SSH format: git@github.com:user/repo.git
    // Parse HTTPS format: https://github.com/user/repo.git
    let webUrl: string | null = null;
    let provider: RepoWebInfo['provider'] = 'unknown';

    // Detect provider and normalize URL
    if (
      remoteUrl.includes('dev.azure.com') ||
      remoteUrl.includes('visualstudio.com') ||
      remoteUrl.includes('vs-ssh.visualstudio.com')
    ) {
      provider = 'azure-devops';
    } else if (remoteUrl.includes('github.com')) {
      provider = 'github';
    } else if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab')) {
      provider = 'gitlab';
    } else if (remoteUrl.includes('bitbucket.org') || remoteUrl.includes('bitbucket')) {
      provider = 'bitbucket';
    }

    // Convert to web URL
    const azureSshMatch = remoteUrl.match(
      /^(?:git@ssh\.dev\.azure\.com|[^@]+@vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/(.+)$/
    );
    if (provider === 'azure-devops' && azureSshMatch) {
      const [, organization, project, rawRepo] = azureSshMatch;
      const repo = rawRepo.replace(/\.git$/, '');
      webUrl = remoteUrl.includes('vs-ssh.visualstudio.com')
        ? `https://${organization}.visualstudio.com/${project}/_git/${repo}`
        : `https://dev.azure.com/${organization}/${project}/_git/${repo}`;
    } else if (remoteUrl.startsWith('git@')) {
      // SSH format: git@host:user/repo.git -> https://host/user/repo
      const match = remoteUrl.match(/^git@([^:]+):(.+?)(\.git)?$/);
      if (match) {
        webUrl = `https://${match[1]}/${match[2]}`;
      }
    } else if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
      // HTTPS format: https://host/user/repo.git -> https://host/user/repo, without a user or
      // token stored in the remote, which the web page doesn't need and Settings shows.
      try {
        const parsedUrl = new URL(remoteUrl.replace(/\.git$/, ''));
        parsedUrl.username = '';
        parsedUrl.password = '';
        webUrl = parsedUrl.toString().replace(/\/$/, '');
      } catch {
        webUrl = null;
      }
    }

    return { provider, webUrl };
  }

  private async getRemoteRefs(repoPath: string): Promise<Map<string, string>> {
    const refs = new Map<string, string>();
    try {
      const output = await gitExec.execGitAsync(repoPath, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/remotes/',
      ]);
      for (const line of output.split('\n')) {
        const match = line.match(/^([^ ]+) ([a-f0-9]+)$/);
        if (match) {
          refs.set(match[1], match[2]);
        }
      }
    } catch {
      // Ignore errors
    }
    return refs;
  }

  /**
   * Validate that a remote URL is accessible (without cloning)
   * Uses `git ls-remote` to check connectivity
   * Supports SSH passphrase prompting via native dialog
   */
  async validateRemoteUrl(url: string): Promise<{ valid: boolean; error?: string }> {
    // git would read a URL starting with "-" as an option, and ls-remote
    // before 2.8 rejects `--`.
    if (url.startsWith('-')) {
      return { valid: false, error: 'A Git URL can\'t start with "-".' };
    }
    return new Promise((resolve) => {
      // Build environment with askpass support
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (!applySshAskpassEnv(env, askpassService, () => gitUsesPathSsh(env))) {
        env.GIT_TERMINAL_PROMPT = '0';
      }

      const proc = spawn('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
        env,
        timeout: 30000, // 30 second timeout
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ valid: true });
        } else {
          // Parse common error messages
          let error = 'Repository not found or not accessible';
          if (
            stderr.includes('could not read Username') ||
            stderr.includes('Authentication failed')
          ) {
            error = 'Authentication required. Configure SSH keys or git credential helper.';
          } else if (stderr.includes('not found') || stderr.includes('does not exist')) {
            error = 'Repository not found';
          } else if (
            stderr.includes('unable to access') ||
            stderr.includes('Could not resolve host')
          ) {
            error = 'Unable to connect. Check your internet connection.';
          }
          resolve({ valid: false, error });
        }
      });

      proc.on('error', (err) => {
        resolve({ valid: false, error: err.message || 'Failed to validate URL' });
      });
    });
  }

  /**
   * Untracked directories git ignores whole, relative to `dirPath` and without a trailing slash,
   * by any rule: nested .gitignore files, .git/info/exclude and the global excludes file.
   */
  async listIgnoredDirectories(dirPath: string): Promise<string[]> {
    const { output, truncated } = await gitExec.execGitAsyncRawLimited(
      dirPath,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      IGNORED_LISTING_MAX_CHARS
    );
    const entries = output.split('\0');
    // A cut entry could name a directory's parent.
    if (truncated) entries.pop();
    return entries.filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1));
  }

  async listFiles(
    dirPath: string,
    includeGitIgnored?: boolean
  ): Promise<{ files: string[]; gitIgnoredFiles: string[]; emptyDirs: string[] }> {
    // Guard against deleted directories (e.g. worktree removed during pending file-list fetch)
    if (!existsSync(dirPath)) {
      return { files: [], gitIgnoredFiles: [], emptyDirs: [] };
    }
    const isGit = await gitExec.isGitRepo(dirPath);
    if (isGit) {
      // Use git ls-files for speed and .gitignore awareness (async)
      let files = await this.lsFiles(dirPath, ['--cached', '--others', '--exclude-standard']);

      let gitIgnoredFiles: string[] = [];
      if (includeGitIgnored) {
        try {
          gitIgnoredFiles = await this.lsFiles(dirPath, [
            '--others',
            '--ignored',
            '--exclude-standard',
          ]);
        } catch {
          // Silently ignore errors (e.g. no .gitignore)
        }
      }

      files = await this.seedLinkedWorkspaceSymlinkEntries(dirPath, files);
      files = await this.seedKomlaFileEntries(dirPath, files);

      // Replace any `linked-workspaces/<peer>` symlink entries with the peer's
      // own listing so those subtrees are browsable instead of appearing as a
      // single unopenable file.
      files = await this.expandLinkedWorkspaceSymlinks(dirPath, files);
      gitIgnoredFiles = gitIgnoredFiles.filter((file) => !file.startsWith('linked-workspaces/'));
      gitIgnoredFiles = gitIgnoredFiles.filter((file) => !file.startsWith(`${KOMLA_FILES_DIR}/`));

      // Empty dirs are tracked client-side (injected on user create) rather than
      // scanning the entire directory tree on every file change.
      return { files, gitIgnoredFiles, emptyDirs: [] };
    }
    // Fallback: async recursive readdir for non-git dirs
    let files = await listFolderFiles(dirPath);
    files = await this.seedLinkedWorkspaceSymlinkEntries(dirPath, files);
    files = await this.seedKomlaFileEntries(dirPath, files);
    files = await this.expandLinkedWorkspaceSymlinks(dirPath, files);
    return {
      files,
      gitIgnoredFiles: [],
      emptyDirs: [],
    };
  }

  private async seedLinkedWorkspaceSymlinkEntries(
    rootPath: string,
    files: string[]
  ): Promise<string[]> {
    const linkedDir = 'linked-workspaces';
    const linkedPath = join(rootPath, linkedDir);
    if (!existsSync(linkedPath)) return files;

    const seeded = new Set(files);
    let entries: string[];
    try {
      entries = await readdir(linkedPath);
    } catch {
      return files;
    }

    for (const entry of entries) {
      const linkPath = join(linkedPath, entry);
      try {
        const stats = await lstat(linkPath);
        if (stats.isSymbolicLink()) seeded.add(`${linkedDir}/${entry}`);
      } catch {
        // Ignore entries that disappear during the scan.
      }
    }
    return [...seeded];
  }

  private async seedKomlaFileEntries(rootPath: string, files: string[]): Promise<string[]> {
    const importPath = join(rootPath, KOMLA_FILES_DIR);
    if (!existsSync(importPath)) return files;

    let importedFiles: string[];
    try {
      importedFiles = await this.listKomlaFilesRecursive(importPath, importPath);
    } catch {
      return files;
    }

    const seeded = new Set(files);
    for (const file of importedFiles) {
      seeded.add(`${KOMLA_FILES_DIR}/${file}`);
    }
    // A non-git listing has the folder's own ignore file already; an import with that name stays.
    try {
      const gitignore = await readFile(join(importPath, KOMLA_FILES_GITIGNORE), 'utf-8');
      if (gitignore === KOMLA_FILES_GITIGNORE_CONTENT) {
        seeded.delete(`${KOMLA_FILES_DIR}/${KOMLA_FILES_GITIGNORE}`);
      }
    } catch {
      // No ignore file yet.
    }
    return [...seeded];
  }

  private async listKomlaFilesRecursive(basePath: string, currentPath: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listKomlaFilesRecursive(basePath, fullPath)));
      } else {
        files.push(listedPath(basePath, fullPath));
      }
    }
    return files;
  }

  /**
   * `git ls-files` reports a directory symlink as a single path entry rather
   * than recursing into it. For our `linked-workspaces/<peer>` symlinks, that
   * makes the peer appear as an unreadable file in the file tree. Walk each
   * such entry into the linked working tree (via git ls-files there if it's a
   * repo, or shallow readdir otherwise) and emit `linked-workspaces/<peer>/...`
   * paths so the tree shows real, openable files.
   */
  private async expandLinkedWorkspaceSymlinks(
    rootPath: string,
    files: string[]
  ): Promise<string[]> {
    const linkedDir = 'linked-workspaces/';
    const peers = new Set<string>();
    const others: string[] = [];
    for (const f of files) {
      if (!f.startsWith(linkedDir)) {
        others.push(f);
        continue;
      }
      const peer = f.slice(linkedDir.length).split('/')[0];
      if (peer) peers.add(peer);
    }
    if (peers.size === 0) return files;

    const expanded: string[] = [...others];
    for (const peer of peers) {
      const peerPath = join(rootPath, 'linked-workspaces', peer);
      let isDir = false;
      try {
        // stat() follows symlinks, so this resolves to the link target's type.
        isDir = (await stat(peerPath)).isDirectory();
      } catch {
        // Broken or missing symlink target. Drop the bare entry so the file
        // tree does not try to open a dead linked-workspace symlink as a file.
        continue;
      }
      if (!isDir) {
        expanded.push(`${linkedDir}${peer}`);
        continue;
      }
      const peerFiles = await this.listPeerFiles(peerPath);
      // Drop the peer's own linked-workspaces children to avoid surfacing
      // sibling links recursively. They're still reachable on disk; we just
      // don't enumerate them in the host tree.
      for (const pf of peerFiles) {
        if (pf.startsWith('linked-workspaces/')) continue;
        expanded.push(`${linkedDir}${peer}/${pf}`);
      }
    }
    return expanded;
  }

  /**
   * The paths `git ls-files` lists, NUL-separated so git neither quotes unusual names
   * nor loses their leading spaces to output trimming.
   */
  private async lsFiles(dirPath: string, args: string[]): Promise<string[]> {
    const output = await gitExec.execGitAsyncRaw(dirPath, ['ls-files', '-z', ...args]);
    return output.split('\0').filter(Boolean);
  }

  private async listPeerFiles(peerPath: string): Promise<string[]> {
    try {
      if (await gitExec.isGitRepo(peerPath)) {
        return await this.lsFiles(peerPath, ['--cached', '--others', '--exclude-standard']);
      }
    } catch {
      // fall through to readdir
    }
    try {
      return await listFolderFiles(peerPath);
    } catch {
      return [];
    }
  }

  async readFileContent(dirPath: string, filePath: string): Promise<string> {
    const fullPath = join(dirPath, filePath);
    const { readFile } = await import('fs/promises');
    return readFile(fullPath, 'utf-8');
  }

  async readImageFileContent(
    dirPath: string,
    filePath: string
  ): Promise<{ data: string; mimeType: string }> {
    if (!isImageFile(filePath)) {
      throw new Error('Not an image file');
    }
    const fullPath = join(dirPath, filePath);
    const { readFile } = await import('fs/promises');
    const buffer = await readFile(fullPath);
    // Reject images larger than 10MB
    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error('Image file too large (>10MB)');
    }
    return {
      data: buffer.toString('base64'),
      mimeType: getMimeType(filePath),
    };
  }

  async readMediaFileContent(
    dirPath: string,
    filePath: string
  ): Promise<{ data: string; mimeType: string; kind: 'audio' | 'video' }> {
    const metadata = await this.getMediaFileMetadata(dirPath, filePath);
    if (metadata.size > 50 * 1024 * 1024) {
      throw new Error('Media file too large (>50MB)');
    }
    const fullPath = join(dirPath, filePath);
    const { readFile } = await import('fs/promises');
    const buffer = await readFile(fullPath);
    return {
      data: buffer.toString('base64'),
      mimeType: metadata.mimeType,
      kind: metadata.kind,
    };
  }

  async getMediaFileMetadata(
    dirPath: string,
    filePath: string
  ): Promise<{ mimeType: string; kind: 'audio' | 'video'; size: number; mtimeMs: number }> {
    if (!isMediaFile(filePath)) {
      throw new Error('Not a media file');
    }
    const fullPath = join(dirPath, filePath);
    const { stat } = await import('fs/promises');
    const stats = await stat(fullPath);
    return {
      mimeType: getMimeType(filePath),
      kind: getMediaKind(filePath) ?? 'video',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  async fileExists(dirPath: string, filePath: string): Promise<boolean> {
    return existsSync(join(dirPath, filePath));
  }

  async getFileMetadata(
    dirPath: string,
    filePath: string
  ): Promise<{ size: number; mtimeMs: number }> {
    const stats = await stat(join(dirPath, filePath));
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  }

  async copyFile(workingDir: string, src: string, dest: string): Promise<void> {
    const srcFull = join(workingDir, src);
    const destFull = join(workingDir, dest);
    mkdirSync(dirname(destFull), { recursive: true });
    copyFileSync(srcFull, destFull);
  }

  async copyDirectory(workingDir: string, src: string, dest: string): Promise<void> {
    const srcFull = join(workingDir, src);
    const destFull = join(workingDir, dest);
    cpSync(srcFull, destFull, { recursive: true });
  }

  async importExternalFile(
    workingDir: string,
    sourcePath: string,
    preferredName?: string
  ): Promise<string> {
    if (!isAbsolute(sourcePath)) {
      throw new Error('Source path must be absolute');
    }

    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) {
      throw new Error('Source is not a file');
    }

    const destDir = this.ensureKomlaFilesDir(workingDir);
    const { baseName, extension } = getImportedFileNameParts(sourcePath, preferredName);
    const destName = this.copyIntoKomlaFiles(sourcePath, destDir, baseName, extension);
    // An agent could swap the folder for a symlink during the copy; take back what went through it.
    try {
      this.assertKomlaFilesDir(destDir);
    } catch (err) {
      rmSync(join(destDir, destName), { force: true });
      throw err;
    }
    return `${KOMLA_FILES_DIR}/${destName}`;
  }

  /** Copies exclusively, so it never writes through a symlink planted at a name or overwrites. */
  private copyIntoKomlaFiles(
    sourcePath: string,
    destDir: string,
    baseName: string,
    extension: string,
    firstSuffix = 1
  ): string {
    for (let suffix = firstSuffix; suffix <= 10000; suffix++) {
      const destName =
        suffix === 1 ? `${baseName}${extension}` : `${baseName}-${suffix}${extension}`;
      try {
        copyFileSync(sourcePath, join(destDir, destName), fsConstants.COPYFILE_EXCL);
        return destName;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error('Unable to find a free name in the Komla import folder');
  }

  /** A symlink at `.komla-files` could point copies outside the workspace. */
  private assertKomlaFilesDir(destDir: string): void {
    const stats = lstatSync(destDir);
    if (stats.isSymbolicLink()) throw new Error('Komla import folder cannot be a symlink');
    if (!stats.isDirectory()) throw new Error('Komla import path is not a directory');
  }

  /**
   * Creates `.komla-files/` with a `.gitignore` that ignores everything in it, so git leaves
   * imports out wherever the workspace sits in its repository. An earlier import named
   * `.gitignore` moves to the next free name.
   */
  private ensureKomlaFilesDir(workingDir: string): string {
    const destDir = join(workingDir, KOMLA_FILES_DIR);
    try {
      mkdirSync(destDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    this.assertKomlaFilesDir(destDir);

    const gitignorePath = join(destDir, KOMLA_FILES_GITIGNORE);
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(gitignorePath);
    } catch {
      // No ignore file yet.
    }
    if (existing?.isSymbolicLink()) {
      unlinkSync(gitignorePath);
    } else if (
      existing?.isFile() &&
      readFileSync(gitignorePath, 'utf-8') !== KOMLA_FILES_GITIGNORE_CONTENT
    ) {
      this.copyIntoKomlaFiles(gitignorePath, destDir, KOMLA_FILES_GITIGNORE, '', 2);
      unlinkSync(gitignorePath);
    }
    try {
      writeFileSync(gitignorePath, KOMLA_FILES_GITIGNORE_CONTENT, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return destDir;
  }

  async deleteFile(worktreePath: string, filePath: string, status: string): Promise<void> {
    if (status === 'deleted') {
      // Restore a deleted file by checking it out from HEAD
      await gitExec.execGitAsync(worktreePath, ['checkout', 'HEAD', '--', filePath]);
    } else {
      const fullPath = join(worktreePath, filePath);
      if (existsSync(fullPath)) {
        // Move to the OS trash so a mistaken delete is recoverable. Never fall
        // back to a permanent removal; report the failure instead.
        try {
          await shell.trashItem(fullPath);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not move "${filePath}" to the trash: ${reason}`);
        }
      }
    }
  }

  renameFile(worktreePath: string, oldPath: string, newPath: string): void {
    const fullOldPath = join(worktreePath, oldPath);
    const fullNewPath = join(worktreePath, newPath);
    // Ensure the destination directory exists
    const destDir = dirname(fullNewPath);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    renameSync(fullOldPath, fullNewPath);
  }

  async writeFile(worktreePath: string, filePath: string, content: string): Promise<void> {
    const fullPath = join(worktreePath, filePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, 'utf-8');
  }

  createDirectory(worktreePath: string, dirPath: string): void {
    const fullPath = join(worktreePath, dirPath);
    mkdirSync(fullPath, { recursive: true });
  }

  async restoreFile(
    worktreePath: string,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void> {
    // Literal, so a name like `app/[id]/page.tsx` isn't a pattern matching other files.
    const literal = (path: string) => `:(literal)${path}`;
    switch (status) {
      case 'modified':
      case 'deleted':
        await gitExec.execGitAsync(worktreePath, ['checkout', 'HEAD', '--', literal(filePath)]);
        break;
      case 'added':
        // Staged new file — remove from index and delete
        try {
          await gitExec.execGitAsync(worktreePath, ['rm', '-f', '--', literal(filePath)]);
        } catch {
          // If git rm fails, try manual removal
          const fullPath = join(worktreePath, filePath);
          if (existsSync(fullPath)) unlinkSync(fullPath);
        }
        break;
      case 'untracked': {
        const fullPath = join(worktreePath, filePath);
        if (existsSync(fullPath)) unlinkSync(fullPath);
        break;
      }
      case 'renamed': {
        // A rename's previous path is gone from disk. Without one (as for a rename a commit
        // made), or if that path is back, there is no rename to undo here, so the file rolls
        // back like any tracked file instead of anything being deleted.
        if (!oldPath || existsSync(join(worktreePath, oldPath))) {
          await gitExec.execGitAsync(worktreePath, ['checkout', 'HEAD', '--', literal(filePath)]);
          break;
        }
        // Restore the original file and remove the renamed one
        await gitExec.execGitAsync(worktreePath, ['checkout', 'HEAD', '--', literal(oldPath)]);
        try {
          await gitExec.execGitAsync(worktreePath, ['rm', '-f', '--', literal(filePath)]);
        } catch {
          const renamedPath = join(worktreePath, filePath);
          if (existsSync(renamedPath)) unlinkSync(renamedPath);
        }
        break;
      }
      default:
        // Fallback: try git checkout
        await gitExec.execGitAsync(worktreePath, ['checkout', 'HEAD', '--', literal(filePath)]);
        break;
    }

    // Invalidate uncommitted changes cache after restore
    gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
  }

  /**
   * Discard all uncommitted changes in the working directory
   * Reverts tracked files and removes untracked files
   */
  async discardAllChanges(worktreePath: string): Promise<{ success: boolean; message: string }> {
    try {
      // Check if there are any changes to discard
      const hasChanges = await gitExec.hasUncommittedChanges(worktreePath);
      if (!hasChanges) {
        return { success: true, message: 'No changes to discard' };
      }

      // Reset index and working tree to HEAD (handles modified, deleted, and staged files)
      await gitExec.execGitAsync(worktreePath, ['reset', '--hard', 'HEAD']);

      // Remove untracked files and directories
      await gitExec.execGitAsync(worktreePath, ['clean', '-fd']);

      // Invalidate cache after discarding changes
      gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);

      return { success: true, message: 'Discarded all changes' };
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Failed to discard changes') };
    }
  }
}

export const gitRepoService = new GitRepoService();
