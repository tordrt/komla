import type { FileChange } from '@/types';

/**
 * Pure scoring for InlineFileTreePanel live-follow auto-navigation.
 * Extracted so it can be tested without React rendering.
 */

/**
 * Pick the most-changed file between two diff snapshots.
 *
 * New files (not present in `prevFiles`) get the highest priority. Existing
 * files are scored by the absolute delta in additions + deletions. Returns
 * `null` when no file has a positive score (no meaningful change), when
 * `prevFiles` is null (first load — nothing to compare against), or when
 * every candidate file is a directory.
 */
export function pickBestLiveFollowFile(
  prevFiles: FileChange[] | null,
  currentFiles: FileChange[]
): string | null {
  if (!prevFiles) return null;

  const prevByPath = new Map<string, FileChange>();
  for (const f of prevFiles) {
    prevByPath.set(f.path, f);
  }

  let bestPath: string | null = null;
  let bestScore = -1;

  for (const f of currentFiles) {
    if (f.isDirectory) continue;
    const score = scoreFileChange(f, prevByPath.get(f.path));
    if (score > bestScore) {
      bestScore = score;
      bestPath = f.path;
    }
  }

  return bestScore > 0 ? bestPath : null;
}

function scoreFileChange(current: FileChange, prev: FileChange | undefined): number {
  if (!prev) {
    // New file — highest priority
    return 10000 + current.additions + current.deletions;
  }
  return (
    Math.abs(current.additions - prev.additions) + Math.abs(current.deletions - prev.deletions)
  );
}
