import { isImageFile, getMimeType } from '../../../shared/image-utils';

import { gitExec } from './git-exec';

import type { FileChange } from './git-diff';
import type {
  CommitGraph,
  CommitGraphQuery,
  CommitGraphRef,
} from '../../../shared/types/commit-graph';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  parentHashes: string[];
  refs: CommitGraphRef[];
}

export interface CommitDiff {
  commit: CommitInfo;
  files: FileChange[];
  summary: { additions: number; deletions: number; filesChanged: number };
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

async function execOrEmpty(worktreePath: string, args: string[]): Promise<string> {
  try {
    return await gitExec.execGitAsync(worktreePath, args);
  } catch {
    return '';
  }
}

/** Parses `diff-tree -z --numstat` output, where a rename's paths follow its counts. */
function parseNumstat(output: string): Map<string, NumstatEntry> {
  const fileStats = new Map<string, NumstatEntry>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const parts = records[index].split('\t');
    if (parts.length < 3) continue;
    const isBinary = parts[0] === '-' && parts[1] === '-';
    const adds = isBinary ? 0 : parseInt(parts[0], 10) || 0;
    const dels = isBinary ? 0 : parseInt(parts[1], 10) || 0;
    let filePath = parts.slice(2).join('\t');
    if (!filePath) {
      // For renames, use new name
      index += 2;
      filePath = records[index] ?? '';
    }
    if (filePath) fileStats.set(filePath, { additions: adds, deletions: dels, isBinary });
  }
  return fileStats;
}

/** Parses `diff-tree -z --name-status` output: each status, then its path or a rename's two. */
function parseNameStatus(output: string): Map<string, FileChange['status']> {
  const statusMap = new Map<string, FileChange['status']>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const statusChar = records[index][0];
    if (!statusChar) continue;
    // For renames, use new name
    index += statusChar === 'R' || statusChar === 'C' ? 2 : 1;
    const filePath = records[index];
    if (filePath) statusMap.set(filePath, statusCharToFileStatus(statusChar));
  }
  return statusMap;
}

function statusCharToFileStatus(statusChar: string): FileChange['status'] {
  if (statusChar === 'A') return 'added';
  if (statusChar === 'D') return 'deleted';
  if (statusChar === 'R') return 'renamed';
  return 'modified';
}

function mergeFileChanges(
  fileStats: Map<string, NumstatEntry>,
  statusMap: Map<string, FileChange['status']>
): FileChange[] {
  const allPaths = new Set([...fileStats.keys(), ...statusMap.keys()]);
  const files: FileChange[] = [];
  for (const filePath of allPaths) {
    const stats = fileStats.get(filePath) ?? { additions: 0, deletions: 0, isBinary: false };
    const status = statusMap.get(filePath) ?? 'modified';
    files.push({
      path: filePath,
      status,
      staged: false,
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }
  return files;
}

/**
 * `git diff-tree` arguments for what a commit changed: against its first parent, so a merge shows
 * what it brought in, or against nothing for a first commit.
 */
export function commitDiffTreeArgs(
  commitHash: string,
  firstParent: string | undefined,
  mode: '--name-status' | '--numstat',
  filePath?: string
): string[] {
  // A path is the file's own name, never a pattern such as `:/` for the repository root.
  const [literal, path] = filePath ? [['--literal-pathspecs'], ['--', filePath]] : [[], []];
  // -z keeps paths as they are, where git would otherwise quote one that isn't plain ASCII.
  return firstParent
    ? [...literal, 'diff-tree', '-r', '-z', mode, firstParent, commitHash, ...path]
    : [...literal, 'diff-tree', '--root', '--no-commit-id', '-r', '-z', mode, commitHash, ...path];
}

const COMMIT_INFO_FIELD_SEP = '\x1f';
// Git's own fields come first: a name or message that imitates the separator can only shift the
// fields after it, never the hashes that go back to git. Ref names can't hold control characters.
const COMMIT_INFO_FORMAT = ['%H', '%h', '%P', '%at', '%D', '%aN', '%aE', '%B'].join('%x1f');

/** `git log` arguments for one commit's `parseCommitInfo`. */
export function commitInfoLogArgs(commitHash: string): string[] {
  return [
    'log',
    '-1',
    // A signature check would print before the commit.
    '--no-show-signature',
    '--no-color',
    '--decorate=full',
    `--format=${COMMIT_INFO_FORMAT}`,
    commitHash,
    '--',
  ];
}

/** Parses `commitInfoLogArgs` output. */
export function parseCommitInfo(output: string): CommitInfo {
  const [
    hash = '',
    shortHash = '',
    parents = '',
    timestamp = '',
    decorations = '',
    author = '',
    authorEmail = '',
    ...message
  ] = output.trim().split(COMMIT_INFO_FIELD_SEP);
  return {
    hash,
    shortHash,
    message: message.join(COMMIT_INFO_FIELD_SEP),
    author,
    authorEmail,
    timestamp: parseInt(timestamp, 10),
    parentHashes: parents.split(' ').filter((parent) => /^[0-9a-f]{40,64}$/.test(parent)),
    refs: parseDecorations(decorations).refs,
  };
}

/** A commit's changes from its `commitDiffTreeArgs` `--numstat` and `--name-status` output. */
export function toCommitDiff(
  commit: CommitInfo,
  numstatOutput: string,
  nameStatusOutput: string
): CommitDiff {
  const files = mergeFileChanges(parseNumstat(numstatOutput), parseNameStatus(nameStatusOutput));
  return {
    commit,
    files,
    summary: {
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      filesChanged: files.length,
    },
  };
}

const GRAPH_FIELD_SEP = '\x1f';
const GRAPH_FORMAT = ['%H', '%P', '%aN', '%at', '%D', '%B'].join('%x1f');

function shortRefName(fullName: string): CommitGraphRef | null {
  if (fullName.startsWith('refs/heads/')) {
    return { kind: 'branch', name: fullName.slice('refs/heads/'.length) };
  }
  if (fullName.startsWith('refs/remotes/')) {
    const name = fullName.slice('refs/remotes/'.length);
    // origin/HEAD only repeats the remote's default branch.
    return name.endsWith('/HEAD') ? null : { kind: 'remote', name };
  }
  if (fullName.startsWith('refs/tags/')) {
    return { kind: 'tag', name: fullName.slice('refs/tags/'.length) };
  }
  return null;
}

/** The refs in a `--decorate=full` `%D`, and the branch HEAD names among them. */
function parseDecorations(field: string): { refs: CommitGraphRef[]; headBranch: string | null } {
  const refs: CommitGraphRef[] = [];
  let headBranch: string | null = null;
  // Ref names can't contain spaces, so ", " only ever separates them.
  for (const decoration of field ? field.split(', ') : []) {
    const isHead = decoration.startsWith('HEAD -> ');
    const ref = shortRefName(decoration.replace(/^HEAD -> /, '').replace(/^tag: /, ''));
    if (!ref) continue;
    if (isHead) headBranch = ref.name;
    refs.push(ref);
  }
  return { refs, headBranch };
}

/** Parses `git log -z --decorate=full --format=GRAPH_FORMAT` output. */
function parseCommitGraphLog(output: string): {
  commits: CommitGraph['commits'];
  currentBranch: string | null;
} {
  const commits: CommitGraph['commits'] = [];
  let currentBranch: string | null = null;
  for (const record of output.split('\0')) {
    if (!record.trim()) continue;
    const fields = record.split(GRAPH_FIELD_SEP);
    if (fields.length < 6) continue;
    const { refs, headBranch } = parseDecorations(fields[4]);
    currentBranch = headBranch ?? currentBranch;
    commits.push({
      hash: fields[0].trim(),
      parentHashes: fields[1] ? fields[1].split(' ') : [],
      author: fields[2],
      timestamp: parseInt(fields[3], 10),
      message: fields.slice(5).join(GRAPH_FIELD_SEP).trim(),
      refs,
    });
  }
  return { commits, currentBranch };
}

/**
 * `git log` arguments for the commit graph, asking for one commit more to tell whether there are
 * older ones. `--follow` would count `--skip` over commits that leave the file alone, so a file's
 * history is read from its newest commit and toCommitGraph drops the skipped ones.
 */
export function commitGraphLogArgs({
  limit,
  skip = 0,
  ref = 'HEAD',
  path,
}: CommitGraphQuery): string[] {
  const gitSkip = path ? 0 : skip;
  return [
    ...(path ? ['--literal-pathspecs'] : []),
    'log',
    '--no-show-signature',
    '--no-color',
    path ? '--follow' : '--topo-order',
    '--decorate=full',
    '-z',
    `--format=${GRAPH_FORMAT}`,
    '-n',
    String(skip - gitSkip + limit + 1),
    ...(gitSkip > 0 ? ['--skip', String(gitSkip)] : []),
    ref,
    '--',
    ...(path ? [path] : []),
  ];
}

/** The graph from `commitGraphLogArgs` output and the full ref name of the upstream, if any. */
export function toCommitGraph(
  logOutput: string,
  upstreamRef: string | null,
  { limit, skip = 0, path }: CommitGraphQuery
): CommitGraph {
  const { commits: read, currentBranch } = parseCommitGraphLog(logOutput);
  const commits = path ? read.slice(skip) : read;
  return {
    commits: commits.slice(0, limit),
    hasMore: commits.length > limit,
    currentBranch,
    upstream: upstreamRef ? (shortRefName(upstreamRef.trim())?.name ?? null) : null,
  };
}

async function readFirstParent(
  worktreePath: string,
  commitHash: string
): Promise<string | undefined> {
  const output = await execOrEmpty(worktreePath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${commitHash}^1`,
  ]);
  return output.trim() || undefined;
}

async function readFileStatus(
  worktreePath: string,
  firstParent: string | undefined,
  commitHash: string,
  filePath: string
): Promise<FileChange['status']> {
  const output = await execOrEmpty(
    worktreePath,
    commitDiffTreeArgs(commitHash, firstParent, '--name-status', filePath)
  );
  const statusChar = output.trim().split('\t')[0]?.[0];
  return statusCharToFileStatus(statusChar ?? '');
}

async function readIsFileBinary(
  worktreePath: string,
  firstParent: string | undefined,
  commitHash: string,
  filePath: string
): Promise<boolean> {
  const output = await execOrEmpty(
    worktreePath,
    commitDiffTreeArgs(commitHash, firstParent, '--numstat', filePath)
  );
  const parts = output.trim().split('\t');
  return parts[0] === '-' && parts[1] === '-';
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

async function readImageAtRef(
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

class GitHistoryService {
  /**
   * The newest commits reachable from HEAD or the queried ref in topological order, with the
   * branches and tags on each, for drawing the commit graph.
   */
  async getCommitGraph(worktreePath: string, query: CommitGraphQuery): Promise<CommitGraph> {
    const readUpstream = gitExec
      .execGitAsync(worktreePath, ['rev-parse', '--symbolic-full-name', '@{upstream}'])
      .catch(() => null);
    let output: string;
    try {
      output = await gitExec.execGitAsync(worktreePath, commitGraphLogArgs(query));
    } catch (error) {
      // A branch without commits yet has no history to show.
      const hasHead = await gitExec
        .execGitAsync(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD'])
        .then(
          () => true,
          () => false
        );
      if (hasHead) throw error;
      output = '';
    }
    return toCommitGraph(output, await readUpstream, query);
  }

  /**
   * Get diff summary for a single commit.
   */
  async getCommitDiff(worktreePath: string, commitHash: string): Promise<CommitDiff> {
    const commit = parseCommitInfo(
      await gitExec.execGitAsync(worktreePath, commitInfoLogArgs(commitHash))
    );
    const firstParent = commit.parentHashes[0];
    const [numstatOutput, nameStatusOutput] = await Promise.all([
      execOrEmpty(worktreePath, commitDiffTreeArgs(commitHash, firstParent, '--numstat')),
      execOrEmpty(worktreePath, commitDiffTreeArgs(commitHash, firstParent, '--name-status')),
    ]);
    return toCommitDiff(commit, numstatOutput, nameStatusOutput);
  }

  /**
   * Get file diff content for a specific commit.
   */
  async getCommitFileDiff(
    worktreePath: string,
    commitHash: string,
    filePath: string
  ): Promise<import('./git-diff').FileDiffContent> {
    const firstParent = await readFirstParent(worktreePath, commitHash);
    const isRoot = !firstParent;
    const [status, isBinary] = await Promise.all([
      readFileStatus(worktreePath, firstParent, commitHash, filePath),
      readIsFileBinary(worktreePath, firstParent, commitHash, filePath),
    ]);

    if (isBinary) {
      return this.buildBinaryDiff(worktreePath, commitHash, filePath, status, isRoot);
    }

    const [oldContent, newContent] = await Promise.all([
      !isRoot && status !== 'added'
        ? readTextAtRef(worktreePath, `${commitHash}^`, filePath)
        : null,
      status !== 'deleted' ? readTextAtRef(worktreePath, commitHash, filePath) : null,
    ]);

    return { path: filePath, oldContent, newContent, status, isBinary: false };
  }

  private async buildBinaryDiff(
    worktreePath: string,
    commitHash: string,
    filePath: string,
    status: FileChange['status'],
    isRoot: boolean
  ): Promise<import('./git-diff').FileDiffContent> {
    if (!isImageFile(filePath)) {
      return { path: filePath, oldContent: null, newContent: null, status, isBinary: true };
    }

    const [oldImageData, newImageData] = await Promise.all([
      !isRoot && status !== 'added'
        ? readImageAtRef(worktreePath, `${commitHash}^`, filePath)
        : null,
      status !== 'deleted' ? readImageAtRef(worktreePath, commitHash, filePath) : null,
    ]);

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
}

export const gitHistoryService = new GitHistoryService();
