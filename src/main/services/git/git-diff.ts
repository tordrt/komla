import { existsSync } from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';

import lineCountPolicy from '../../../shared/git-line-count-policy.json';
import { isImageFile, getMimeType } from '../../../shared/image-utils';
import { createLogger } from '../../lib/logger';

import { gitExec } from './git-exec';
import {
  isKomlaManagedFilePath,
  parseNameStatusZ,
  parseNumstatEntriesZ,
  parseNumstatZ,
  readPorcelainZ,
} from './git-status';

const logger = createLogger('GitService');

function isBinaryByExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lineCountPolicy.binaryExtensions.some((ext) => lower.endsWith(ext));
}

export interface FileChange {
  path: string;
  /** Previous path when Git reports a rename or copy. */
  originalPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
  additions: number;
  deletions: number;
  /** Untracked file status is known, but its line count was not collected. */
  lineCountsUnavailable?: boolean;
  /** True when git reports this as a directory entry (e.g. untracked dirs with -unormal) */
  isDirectory?: boolean;
}

export interface WorktreeDiff {
  files: FileChange[];
  summary: { additions: number; deletions: number; filesChanged: number };
}

export interface FileDiffContent {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  status: FileChange['status'];
  isBinary: boolean;
  isImage?: boolean;
  mimeType?: string;
  oldImageData?: string | null;
  newImageData?: string | null;
}

interface WorkingTreeStats {
  additions: number;
  deletions: number;
  perFileStats: Map<string, { additions: number; deletions: number }>;
}

/**
 * Resolve the diff target for a branch comparison using merge-base.
 * Returns the merge-base commit so diffs only show changes since diverging,
 * falling back to the branch ref if merge-base fails (e.g. unrelated histories).
 */
async function resolveDiffTarget(
  worktreePath: string,
  branch: string,
  useMergeBase: boolean
): Promise<string> {
  if (!useMergeBase) return branch;
  try {
    const mergeBase = await gitExec.execGitAsync(worktreePath, ['merge-base', branch, 'HEAD']);
    return mergeBase.trim();
  } catch {
    return branch;
  }
}

/**
 * Normalize parsed file changes so each path appears at most once, and identify
 * "replacement" paths (deleted + recreated) that need extra stat accounting.
 */
function normalizeAggregateFiles(
  worktreePath: string,
  files: FileChange[]
): { normalized: FileChange[]; replacementPaths: Set<string> } {
  const byPath = new Map<string, FileChange[]>();

  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing) {
      existing.push(file);
    } else {
      byPath.set(file.path, [file]);
    }
  }

  const normalized: FileChange[] = [];
  const replacementPaths = new Set<string>();

  for (const [path, entries] of byPath) {
    if (entries.length === 1) {
      normalized.push(entries[0]);
      continue;
    }

    const statuses = new Set(entries.map((entry) => entry.status));
    const fullPath = join(worktreePath, path);
    const existsInWorkingTree = existsSync(fullPath);

    // If a tracked file is deleted but a new working-tree file now exists at the same
    // path, present the net HEAD→working-tree result as a single modified file.
    if (
      existsInWorkingTree &&
      statuses.has('deleted') &&
      (statuses.has('untracked') || statuses.has('added'))
    ) {
      const merged = entries.find((entry) => entry.status !== 'deleted') ?? entries[0];
      normalized.push({
        ...merged,
        status: 'modified',
        staged: false,
        isDirectory: false,
      });
      replacementPaths.add(path);
      continue;
    }

    // Otherwise prefer the most informative surviving working-tree state.
    const preferred =
      entries.find((entry) => entry.status === 'renamed') ??
      entries.find((entry) => entry.status === 'modified') ??
      entries.find((entry) => entry.status === 'added') ??
      entries.find((entry) => entry.status === 'untracked') ??
      entries[0];

    normalized.push(preferred);
  }

  return { normalized, replacementPaths };
}

function branchDiffKey(worktreePath: string, branch: string, useMergeBase: boolean): string {
  return `${worktreePath}\0${branch}\0${useMergeBase ? 'merge-base' : 'direct'}`;
}

async function execOrEmpty(worktreePath: string, args: string[]): Promise<string> {
  try {
    return await gitExec.execGitAsync(worktreePath, args);
  } catch {
    return '';
  }
}

function parseDiffStatTotals(stat: string): { additions: number; deletions: number } {
  const addMatch = stat.match(/(\d+) insertions?\(\+\)/);
  const delMatch = stat.match(/(\d+) deletions?\(-\)/);
  return {
    additions: addMatch ? parseInt(addMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

function sumFileTotals(files: FileChange[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

async function readImageAsBase64(
  worktreePath: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  try {
    const buf = await gitExec.execGitAsyncBuffer(worktreePath, ['show', `${ref}:${filePath}`]);
    if (buf.length > 10 * 1024 * 1024) return null;
    return buf.toString('base64');
  } catch {
    return null;
  }
}

async function readImageFromFile(fullPath: string): Promise<string | null> {
  try {
    const buf = await readFile(fullPath);
    if (buf.length > 10 * 1024 * 1024) return null;
    return buf.toString('base64');
  } catch {
    return null;
  }
}

async function readTextAtRef(
  worktreePath: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  try {
    return await gitExec.readBlobText(worktreePath, ref, filePath);
  } catch {
    return null;
  }
}

async function readWorkTreeTextSilent(fullPath: string): Promise<string | null> {
  if (!existsSync(fullPath)) return null;
  try {
    return await readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

class GitDiffService {
  /** Each branch comparison's renamed paths and where they came from, for opening one. */
  private branchRenameSources = new Map<string, Map<string, string>>();

  async getChangedFiles(worktreePath: string): Promise<FileChange[]> {
    // Bail out early if the worktree directory doesn't exist (e.g. during rebase or after removal).
    // Node.js throws a misleading "spawn /bin/sh ENOENT" when cwd is missing.
    if (!existsSync(worktreePath)) {
      return [];
    }

    // -unormal shows untracked directories as single entries (faster than -uall for large repos).
    // execGitAsyncRaw preserves leading whitespace needed for porcelain format parsing.
    const output = await gitExec.execGitAsyncRaw(worktreePath, [
      'status',
      '--porcelain',
      '-unormal',
      '-z',
    ]);
    if (!output) return [];

    const files = await this.parsePorcelainStatus(worktreePath, output);
    return normalizeAggregateFiles(worktreePath, files).normalized;
  }

  /** Recursively list files inside an untracked directory, returning individual FileChange entries.
   *  When `remaining` is provided, expansion stops after the budget is exhausted and further
   *  directories are reported as collapsed entries to prevent excessive fs I/O on the hot path. */
  private async expandUntrackedDir(
    worktreePath: string,
    dirRelPath: string,
    remaining?: { count: number }
  ): Promise<FileChange[]> {
    // Cap reached — report as collapsed directory entry
    if (remaining && remaining.count <= 0) {
      return [
        {
          path: dirRelPath,
          status: 'untracked',
          staged: false,
          additions: 0,
          deletions: 0,
          isDirectory: true,
        },
      ];
    }
    const results: FileChange[] = [];
    try {
      const entries = await readdir(join(worktreePath, dirRelPath), { withFileTypes: true });
      for (const entry of entries) {
        const childPath = dirRelPath + '/' + entry.name;
        if (entry.isDirectory()) {
          results.push(...(await this.expandUntrackedDir(worktreePath, childPath, remaining)));
        } else {
          results.push({
            path: childPath,
            status: 'untracked',
            staged: false,
            additions: 0,
            deletions: 0,
          });
          if (remaining) remaining.count--;
        }
        // Stop expanding once cap is reached
        if (remaining && remaining.count <= 0) break;
      }
    } catch {
      // If we can't read the directory, fall back to reporting it as a directory entry
      results.push({
        path: dirRelPath,
        status: 'untracked',
        staged: false,
        additions: 0,
        deletions: 0,
        isDirectory: true,
      });
    }
    return results;
  }

  async getWorkingTreeDiff(worktreePath: string): Promise<WorktreeDiff> {
    const files = await this.getChangedFiles(worktreePath);

    const stats = await this.getWorkingTreeStats(worktreePath, files);
    const additions = stats.additions;
    const deletions = stats.deletions;
    const perFileStats = stats.perFileStats;

    // Apply per-file stats to files
    for (const file of files) {
      const stats = perFileStats.get(file.path);
      if (stats) {
        file.additions = stats.additions;
        file.deletions = stats.deletions;
      } else {
        file.additions = 0;
        file.deletions = 0;
      }
    }

    return {
      files,
      summary: { additions, deletions, filesChanged: files.length },
    };
  }

  /**
   * Get diff of working tree against a specific branch
   * Shows all differences between working tree and the specified branch
   */
  async getWorkingTreeDiffAgainstBranch(
    worktreePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<WorktreeDiff> {
    const diffTarget = await resolveDiffTarget(worktreePath, branch, useMergeBase);

    // -M overrides a diff.renames=copies setting, so these calls and --stat pair files alike.
    const perFileStats = parseNumstatZ(
      await execOrEmpty(worktreePath, ['diff', diffTarget, '--numstat', '-M', '-z'])
    );
    const changedFiles = parseNameStatusZ(
      await execOrEmpty(worktreePath, ['diff', diffTarget, '--name-status', '-M', '-z']),
      perFileStats
    );
    this.branchRenameSources.set(
      branchDiffKey(worktreePath, branch, useMergeBase),
      new Map(
        changedFiles.flatMap(({ path, originalPath }) =>
          originalPath ? [[path, originalPath]] : []
        )
      )
    );

    const untracked = await this.collectUntrackedForBranchDiff(worktreePath, changedFiles);
    const { normalized: files } = normalizeAggregateFiles(worktreePath, [
      ...changedFiles,
      ...untracked.files,
    ]);

    const { additions: baseAdd, deletions: baseDel } = await this.computeBranchSummaryTotals(
      worktreePath,
      diffTarget,
      files
    );

    let additions = baseAdd;
    const deletions = baseDel;
    for (const file of files) {
      if (file.status === 'untracked') additions += file.additions;
    }

    return {
      files,
      summary: { additions, deletions, filesChanged: files.length },
    };
  }

  private async collectUntrackedForBranchDiff(
    worktreePath: string,
    existingFiles: FileChange[]
  ): Promise<{ files: FileChange[] }> {
    const files: FileChange[] = [];

    const untrackedOutput = await gitExec
      .execGitAsyncRaw(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])
      .catch(() => '');

    for (const filePath of untrackedOutput.split('\0')) {
      if (!filePath || isKomlaManagedFilePath(filePath)) continue;
      if (existingFiles.some((f) => f.path === filePath)) continue;

      if (isBinaryByExtension(filePath)) {
        files.push({
          path: filePath,
          status: 'untracked',
          staged: false,
          additions: 0,
          deletions: 0,
        });
        continue;
      }

      const file = await this.readUntrackedForBranchDiff(worktreePath, filePath);
      if (file) files.push(file);
    }

    return { files };
  }

  private async readUntrackedForBranchDiff(
    worktreePath: string,
    filePath: string
  ): Promise<FileChange | null> {
    try {
      const fullPath = join(worktreePath, filePath);
      const additions = existsSync(fullPath) ? await this.countLinesInPath(fullPath) : 0;
      return {
        path: filePath,
        status: 'untracked',
        staged: false,
        additions,
        deletions: 0,
      };
    } catch {
      return null;
    }
  }

  private async computeBranchSummaryTotals(
    worktreePath: string,
    diffTarget: string,
    files: FileChange[]
  ): Promise<{ additions: number; deletions: number }> {
    try {
      const stat = await gitExec.execGitAsync(worktreePath, ['diff', diffTarget, '--stat', '-M']);
      return parseDiffStatTotals(stat);
    } catch {
      return sumFileTotals(files);
    }
  }

  /**
   * Get full file diff content comparing working tree against a branch
   */
  async getFullFileDiffAgainstBranch(
    worktreePath: string,
    filePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<FileDiffContent> {
    const diffTarget = await resolveDiffTarget(worktreePath, branch, useMergeBase);
    const fullPath = join(worktreePath, filePath);
    const existsInWorkTree = existsSync(fullPath);
    // A renamed file's content on the branch lives at its previous path.
    const branchPath =
      this.branchRenameSources
        .get(branchDiffKey(worktreePath, branch, useMergeBase))
        ?.get(filePath) ?? filePath;

    const oldContent = await readTextAtRef(worktreePath, diffTarget, branchPath);
    const existsInBranch = oldContent !== null;
    const isRenamed = branchPath !== filePath && existsInBranch && existsInWorkTree;

    const isBinary = await this.isFileBinary(worktreePath, filePath);

    if (isBinary) {
      const binaryStatus: FileChange['status'] = isRenamed
        ? 'renamed'
        : existsInBranch
          ? existsInWorkTree
            ? 'modified'
            : 'deleted'
          : 'added';
      return this.buildBranchBinaryDiff(
        worktreePath,
        diffTarget,
        filePath,
        branchPath,
        fullPath,
        binaryStatus,
        existsInBranch,
        existsInWorkTree
      );
    }

    const newContent = await readWorkTreeTextSilent(fullPath);

    let status: FileChange['status'] = 'modified';
    if (isRenamed) {
      status = 'renamed';
    } else if (!existsInBranch && existsInWorkTree) {
      status = 'added';
    } else if (existsInBranch && !existsInWorkTree) {
      status = 'deleted';
    }

    return {
      path: filePath,
      oldContent,
      newContent,
      status,
      isBinary: false,
    };
  }

  private async buildBranchBinaryDiff(
    worktreePath: string,
    diffTarget: string,
    filePath: string,
    branchPath: string,
    fullPath: string,
    status: FileChange['status'],
    existsInBranch: boolean,
    existsInWorkTree: boolean
  ): Promise<FileDiffContent> {
    if (!isImageFile(filePath)) {
      return { path: filePath, oldContent: null, newContent: null, status, isBinary: true };
    }
    const oldImageData = existsInBranch
      ? await readImageAsBase64(worktreePath, diffTarget, branchPath)
      : null;
    const newImageData = existsInWorkTree ? await readImageFromFile(fullPath) : null;
    return {
      path: filePath,
      oldContent: null,
      newContent: null,
      status,
      isBinary: true,
      isImage: true,
      mimeType: getMimeType(filePath),
      oldImageData,
      newImageData,
    };
  }

  async getFullFileDiff(
    worktreePath: string,
    filePath: string,
    _staged = false
  ): Promise<FileDiffContent> {
    const files = await this.getChangedFiles(worktreePath);
    const fileChange = files.find((f) => f.path === filePath);
    const status = fileChange?.status || 'modified';
    const fullPath = join(worktreePath, filePath);
    // A renamed file's HEAD content lives at its previous path.
    const headPath = fileChange?.originalPath ?? filePath;

    if (!fileChange && !existsSync(fullPath)) {
      return {
        path: filePath,
        oldContent: null,
        newContent: null,
        status: 'deleted',
        isBinary: false,
      };
    }

    const isBinary = await this.isFileBinary(worktreePath, filePath);

    if (isBinary) {
      return this.buildHeadBinaryDiff(worktreePath, filePath, headPath, status);
    }

    let oldContent: string | null = null;
    let newContent: string | null = null;

    if (status === 'untracked') {
      newContent = await readWorkTreeTextSilent(fullPath);
    } else {
      if (status !== 'added') oldContent = await this.readHeadTextLogged(worktreePath, headPath);
      if (status !== 'deleted') newContent = await this.readWorkTreeTextLogged(fullPath, filePath);
    }

    return {
      path: filePath,
      oldContent,
      newContent,
      status,
      isBinary: false,
    };
  }

  private async buildHeadBinaryDiff(
    worktreePath: string,
    filePath: string,
    headPath: string,
    status: FileChange['status']
  ): Promise<FileDiffContent> {
    if (!isImageFile(filePath)) {
      return { path: filePath, oldContent: null, newContent: null, status, isBinary: true };
    }
    const fullPath = join(worktreePath, filePath);
    const oldImageData =
      status !== 'added' && status !== 'untracked'
        ? await readImageAsBase64(worktreePath, 'HEAD', headPath)
        : null;
    const newImageData =
      status !== 'deleted' && existsSync(fullPath) ? await readImageFromFile(fullPath) : null;
    return {
      path: filePath,
      oldContent: null,
      newContent: null,
      status,
      isBinary: true,
      isImage: true,
      mimeType: getMimeType(filePath),
      oldImageData,
      newImageData,
    };
  }

  private async readHeadTextLogged(worktreePath: string, filePath: string): Promise<string | null> {
    try {
      return await gitExec.readBlobText(worktreePath, 'HEAD', filePath);
    } catch (err) {
      logger.warn(`Failed to get HEAD content for ${filePath}:`, err);
      return null;
    }
  }

  private async readWorkTreeTextLogged(fullPath: string, filePath: string): Promise<string | null> {
    if (!existsSync(fullPath)) {
      logger.warn(`File not found for diff: ${fullPath}`);
      return null;
    }
    try {
      return await readFile(fullPath, 'utf-8');
    } catch (err) {
      logger.error(`Failed to read working tree file ${filePath}:`, err);
      return null;
    }
  }

  /**
   * Lightweight summary of additions/deletions without producing full diff text.
   * Reuses the coalesced getChangedFilesWithSummary to avoid reading untracked file contents.
   */
  async getDiffSummary(worktreePath: string): Promise<{ additions: number; deletions: number }> {
    const result = await this.getChangedFilesWithSummary(worktreePath);
    return { additions: result.summary.additions, deletions: result.summary.deletions };
  }

  private countLinesInBuffer(buf: Uint8Array): number {
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
    return count;
  }

  // Files above the shared per-file cap skip the read and report an estimated line count
  // derived from byte size. Avoids loading multi-MB untracked files (logs, generated
  // bundles) into memory just to compute display stats — the renderer's per-file gate
  // fires once over its line threshold either way.
  private async countLinesInPath(absPath: string): Promise<number> {
    const stats = await stat(absPath);
    if (stats.size > lineCountPolicy.fileByteCap) {
      return Math.ceil(stats.size / lineCountPolicy.estimatedBytesPerLine);
    }
    return this.countLinesInBuffer(await readFile(absPath));
  }

  private async isFileBinary(worktreePath: string, filePath: string): Promise<boolean> {
    try {
      // Use git's built-in binary detection
      const result = await gitExec.execGitAsync(worktreePath, [
        'diff',
        '--numstat',
        'HEAD',
        '--',
        filePath,
      ]);
      // Binary files show "-" for additions and deletions
      if (result.startsWith('-\t-\t')) return true;
      // For untracked files, git diff returns empty output - fall back to extension check
      if (result.trim() === '') {
        return isBinaryByExtension(filePath);
      }
      return false;
    } catch {
      // If we can't determine, check file extension as fallback
      return isBinaryByExtension(filePath);
    }
  }

  /**
   * Line counts against HEAD for the files `git status` listed. `git diff HEAD -M` pairs
   * renames between HEAD and the working tree, which can differ from the renames status
   * reports: a pair status lists apart is counted again without renames, and a rename
   * status reports that the diff left unpaired counts as a rewrite of its previous path.
   */
  private async headLineStats(
    worktreePath: string,
    numstatOutput: string,
    files: FileChange[]
  ): Promise<Map<string, { additions: number; deletions: number }>> {
    const renameSources = new Map(
      files.flatMap(({ path, originalPath }) => (originalPath ? [[path, originalPath]] : []))
    );
    const stats = new Map<string, { additions: number; deletions: number }>();
    const unpairedPaths: string[] = [];
    for (const { path, originalPath, additions, deletions } of parseNumstatEntriesZ(
      numstatOutput
    )) {
      if (originalPath && renameSources.get(path) !== originalPath) {
        unpairedPaths.push(originalPath, path);
        continue;
      }
      stats.set(path, { additions, deletions });
    }
    if (unpairedPaths.length > 0) {
      const unpaired = parseNumstatZ(
        await execOrEmpty(worktreePath, [
          'diff',
          'HEAD',
          '--numstat',
          '--no-renames',
          '-z',
          '--',
          ...unpairedPaths.map((path) => `:(literal)${path}`),
        ])
      );
      for (const [path, pathStats] of unpaired) stats.set(path, pathStats);
    }
    for (const [path, originalPath] of renameSources) {
      const previous = stats.get(originalPath);
      if (!previous) continue;
      const current = stats.get(path) ?? { additions: 0, deletions: 0 };
      stats.set(path, {
        additions: current.additions + previous.additions,
        deletions: current.deletions + previous.deletions,
      });
      stats.delete(originalPath);
    }
    return stats;
  }

  private async getWorkingTreeStats(
    worktreePath: string,
    files: FileChange[]
  ): Promise<WorkingTreeStats> {
    const perFileStats = await this.headLineStats(
      worktreePath,
      await execOrEmpty(worktreePath, ['diff', 'HEAD', '--numstat', '-M', '-z']),
      files
    );

    await this.applyUntrackedLineCounts(worktreePath, perFileStats);

    let additions = 0;
    let deletions = 0;
    for (const stats of perFileStats.values()) {
      additions += stats.additions;
      deletions += stats.deletions;
    }

    return { additions, deletions, perFileStats };
  }

  private async applyUntrackedLineCounts(
    worktreePath: string,
    perFileStats: Map<string, { additions: number; deletions: number }>
  ): Promise<void> {
    const untrackedOutput = await gitExec
      .execGitAsyncRaw(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])
      .catch(() => '');

    const untrackedFiles: FileChange[] = untrackedOutput
      .split('\0')
      .filter(
        (filePath) =>
          filePath && !isKomlaManagedFilePath(filePath) && !isBinaryByExtension(filePath)
      )
      .map((path) => ({ path, status: 'untracked', staged: false, additions: 0, deletions: 0 }));
    // Read with bounded concurrency rather than one file at a time.
    await this.countLinesIntoStats(worktreePath, untrackedFiles, perFileStats, true);
  }

  /**
   * Lightweight endpoint: returns file list + summary counts without generating
   * full diff text or reading untracked file contents into memory.
   * Request-coalesced per worktree path.
   */
  private inFlightFileStats = new Map<
    string,
    Promise<{
      files: FileChange[];
      summary: { additions: number; deletions: number; filesChanged: number };
    }>
  >();

  async getChangedFilesWithSummary(worktreePath: string): Promise<{
    files: FileChange[];
    summary: { additions: number; deletions: number; filesChanged: number };
  }> {
    const existing = this.inFlightFileStats.get(worktreePath);
    if (existing) return existing;

    const promise = this._getChangedFilesWithSummary(worktreePath);
    this.inFlightFileStats.set(worktreePath, promise);
    try {
      return await promise;
    } finally {
      this.inFlightFileStats.delete(worktreePath);
    }
  }

  /** Max files to expand from untracked directories on the hot path */
  private readonly MAX_UNTRACKED_EXPANSION = 500;
  /** Max concurrent in-process file reads for untracked line counting */
  private readonly LINE_COUNT_CONCURRENCY = 20;

  private async _getChangedFilesWithSummary(worktreePath: string): Promise<{
    files: FileChange[];
    summary: { additions: number; deletions: number; filesChanged: number };
  }> {
    if (!existsSync(worktreePath)) {
      return { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } };
    }

    // Start status and numstat together when the repo lock permits it.
    const [statusOutput, numstatRaw] = await Promise.all([
      gitExec
        .execGitAsyncRaw(worktreePath, ['status', '--porcelain', '-unormal', '-z'])
        .catch(() => ''),
      gitExec.execGitAsync(worktreePath, ['diff', 'HEAD', '--numstat', '-M', '-z']).catch(() => ''),
    ]);

    const remaining = { count: this.MAX_UNTRACKED_EXPANSION };
    const files = await this.parsePorcelainStatus(worktreePath, statusOutput, remaining);
    const perFileStats = await this.headLineStats(worktreePath, numstatRaw, files);

    const { normalized: normalizedFiles, replacementPaths } = normalizeAggregateFiles(
      worktreePath,
      files
    );

    const untrackedFiles = normalizedFiles.filter(
      (f) => f.status === 'untracked' && !f.isDirectory && !isBinaryByExtension(f.path)
    );
    await this.countLinesIntoStats(worktreePath, untrackedFiles, perFileStats, false);

    // When a tracked file is deleted and a new working-tree file is recreated at the same
    // path, the aggregate model treats it as "modified". Git's numstat still reports only the
    // deletion side, so add the recreated file's line count to keep summary stats aligned.
    if (replacementPaths.size > 0) {
      const replacementFiles = normalizedFiles.filter(
        (f) => replacementPaths.has(f.path) && !f.isDirectory && !isBinaryByExtension(f.path)
      );
      await this.countLinesIntoStats(worktreePath, replacementFiles, perFileStats, true);
    }

    let additions = 0;
    let deletions = 0;
    for (const file of normalizedFiles) {
      const stats = perFileStats.get(file.path);
      if (stats) {
        file.additions = stats.additions;
        file.deletions = stats.deletions;
      }
      additions += file.additions;
      deletions += file.deletions;
    }

    return {
      files: normalizedFiles,
      summary: { additions, deletions, filesChanged: normalizedFiles.length },
    };
  }

  private async parsePorcelainStatus(
    worktreePath: string,
    output: string,
    remaining?: { count: number }
  ): Promise<FileChange[]> {
    const files: FileChange[] = [];

    for (const entry of readPorcelainZ(output)) {
      if (entry.status === 'untracked' && entry.path.endsWith('/')) {
        const dirPath = entry.path.slice(0, -1);
        files.push(...(await this.expandUntrackedDir(worktreePath, dirPath, remaining)));
        continue;
      }
      files.push({ ...entry, staged: false, additions: 0, deletions: 0 });
      if (entry.status === 'untracked' && remaining) remaining.count--;
    }
    return files;
  }

  private async countLinesIntoStats(
    worktreePath: string,
    files: FileChange[],
    perFileStats: Map<string, { additions: number; deletions: number }>,
    addToExisting: boolean
  ): Promise<void> {
    for (let i = 0; i < files.length; i += this.LINE_COUNT_CONCURRENCY) {
      const chunk = files.slice(i, i + this.LINE_COUNT_CONCURRENCY);
      await Promise.all(
        chunk.map((f) => this.countLinesForFile(worktreePath, f, perFileStats, addToExisting))
      );
    }
  }

  private async countLinesForFile(
    worktreePath: string,
    file: FileChange,
    perFileStats: Map<string, { additions: number; deletions: number }>,
    addToExisting: boolean
  ): Promise<void> {
    try {
      const lines = await this.countLinesInPath(join(worktreePath, file.path));
      const existing = addToExisting
        ? (perFileStats.get(file.path) ?? { additions: 0, deletions: 0 })
        : { additions: 0, deletions: 0 };
      perFileStats.set(file.path, {
        additions: existing.additions + lines,
        deletions: existing.deletions,
      });
    } catch {
      // Skip unreadable files
    }
  }

  /**
   * Fingerprint of git-visible working tree activity.
   * Includes tracked and untracked changes while respecting git ignore rules.
   */
  async getActivityFingerprint(worktreePath: string): Promise<string> {
    const { files } = await this.getChangedFilesWithSummary(worktreePath);
    return files
      .map(
        (file) => `${file.status}:${file.staged}:${file.path}:${file.additions}:${file.deletions}`
      )
      .join('\n');
  }
}

export const gitDiffService = new GitDiffService();
