import type { FileChange } from './git-diff';

export const KOMLA_FILES_DIR = '.komla-files';
/** Ignores everything in `.komla-files/`, the folder included, wherever it sits in a repository. */
export const KOMLA_FILES_GITIGNORE = '.gitignore';
export const KOMLA_FILES_GITIGNORE_CONTENT = '*\n';

type LineStats = Map<string, { additions: number; deletions: number }>;

/** A changed path as `git status` reports it against HEAD. */
export interface PorcelainEntry {
  path: string;
  status: FileChange['status'];
  /** Previous path of a rename. */
  originalPath?: string;
}

// `.komla-files/` is reserved Komla-managed import space. Files users want to
// track should be moved into normal project folders before committing.
export function isKomlaManagedFilePath(filePath: string): boolean {
  return filePath === KOMLA_FILES_DIR || filePath.startsWith(`${KOMLA_FILES_DIR}/`);
}

/**
 * Derive the aggregate HEAD→working-tree status from porcelain XY codes.
 * Returns null when the net effect is no change from HEAD (e.g. AD).
 */
export function deriveAggregateStatus(
  indexStatus: string,
  workTreeStatus: string
): FileChange['status'] | null {
  // A copy's source is untouched, so the copy is just a new file. ' A' is a file
  // `git add -N` names without staging it.
  const isNewFile = indexStatus === 'A' || indexStatus === 'C' || workTreeStatus === 'A';
  // AD/CD: added to index then deleted from working tree — no net change from HEAD
  if (isNewFile && workTreeStatus === 'D') return null;
  // A*/C*/ A: file doesn't exist in HEAD → added
  if (isNewFile) return 'added';
  // *D or D*: file removed from working tree → deleted
  if (workTreeStatus === 'D' || indexStatus === 'D') return 'deleted';
  // R* or *R (a rename `git add -N` shows in the working tree): renamed
  if (indexStatus === 'R' || workTreeStatus === 'R') return 'renamed';
  // M*, *M, MM, etc.: modified
  return 'modified';
}

/**
 * Read `git status --porcelain -z`. -z keeps paths unquoted and gives a rename's or copy's
 * previous path its own record. Paths with no net change from HEAD and Komla-managed paths
 * are left out; an untracked directory keeps its trailing slash.
 */
export function readPorcelainZ(output: string): PorcelainEntry[] {
  const records = output.split('\0');
  const entries: PorcelainEntry[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const indexStatus = record[0];
    const workTreeStatus = record[1];
    const sourcePath = [indexStatus, workTreeStatus].some(
      (status) => status === 'R' || status === 'C'
    )
      ? records[++index]
      : undefined;
    const status =
      indexStatus === '?' && workTreeStatus === '?'
        ? 'untracked'
        : deriveAggregateStatus(indexStatus, workTreeStatus);
    if (status === null) continue;
    // A rename whose new file is gone again leaves only its previous path's deletion.
    const undoneRenameSource = status === 'deleted' ? sourcePath : undefined;
    const path = undoneRenameSource ?? record.slice(3);
    if (!path || isKomlaManagedFilePath(path)) continue;
    const originalPath =
      [indexStatus, workTreeStatus].includes('R') && !undoneRenameSource ? sourcePath : undefined;
    entries.push({ path, status, ...(originalPath ? { originalPath } : {}) });
  }

  return entries;
}

/** One `git diff --numstat -z` record; a rename's carries its previous path. */
export interface NumstatEntry {
  path: string;
  originalPath?: string;
  additions: number;
  deletions: number;
}

export function parseNumstatEntriesZ(output: string): NumstatEntry[] {
  const records = output.split('\0');
  const entries: NumstatEntry[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;

    const additionsRaw = record.slice(0, firstTab);
    const deletionsRaw = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    let originalPath: string | undefined;
    if (!filePath) {
      index++;
      originalPath = records[index] || undefined;
      index++;
      filePath = records[index] ?? originalPath ?? '';
    }
    if (!filePath || isKomlaManagedFilePath(filePath)) continue;
    entries.push({
      path: filePath,
      ...(originalPath ? { originalPath } : {}),
      additions: additionsRaw === '-' ? 0 : parseInt(additionsRaw, 10) || 0,
      deletions: deletionsRaw === '-' ? 0 : parseInt(deletionsRaw, 10) || 0,
    });
  }

  return entries;
}

export function parseNumstatZ(output: string): LineStats {
  return new Map(
    parseNumstatEntriesZ(output).map(({ path, additions, deletions }) => [
      path,
      { additions, deletions },
    ])
  );
}

function nameStatusToFileStatus(statusCode: string): FileChange['status'] {
  // A copy's source is untouched, so the copy is just a new file.
  if (statusCode === 'A' || statusCode === 'C') return 'added';
  if (statusCode === 'D') return 'deleted';
  if (statusCode === 'R') return 'renamed';
  return 'modified';
}

export function parseNameStatusZ(output: string, stats: LineStats): FileChange[] {
  const records = output.split('\0');
  const files: FileChange[] = [];

  for (let index = 0; index < records.length; index++) {
    const statusRaw = records[index];
    if (!statusRaw) continue;
    const statusCode = statusRaw[0] ?? 'M';
    index++;
    let filePath = records[index] ?? '';
    let originalPath: string | undefined;
    if (statusCode === 'R' || statusCode === 'C') {
      if (statusCode === 'R') originalPath = filePath;
      index++;
      filePath = records[index] ?? filePath;
    }
    if (!filePath || isKomlaManagedFilePath(filePath)) continue;
    const stat = stats.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({
      path: filePath,
      status: nameStatusToFileStatus(statusCode),
      staged: false,
      additions: stat.additions,
      deletions: stat.deletions,
      ...(originalPath ? { originalPath } : {}),
    });
  }

  return files;
}
