import { useEffect, useRef } from 'react';

import type { FileChange } from '@/types';

interface UseLiveFollowParams {
  liveFollow: boolean;
  diffFiles: FileChange[] | undefined;
  hasFullDiff: boolean;
  onSelectMostChanged: (path: string) => void;
}

export function pickMostChangedFile(
  prevFiles: FileChange[],
  currentFiles: FileChange[]
): string | null {
  const prevByPath = new Map<string, FileChange>();
  for (const f of prevFiles) {
    prevByPath.set(f.path, f);
  }

  let bestPath: string | null = null;
  let bestScore = -1;

  for (const f of currentFiles) {
    if (f.isDirectory) continue;
    const prev = prevByPath.get(f.path);
    const score = prev
      ? Math.abs(f.additions - prev.additions) + Math.abs(f.deletions - prev.deletions)
      : 10000 + f.additions + f.deletions;
    if (score > bestScore) {
      bestScore = score;
      bestPath = f.path;
    }
  }

  return bestScore > 0 ? bestPath : null;
}

/**
 * Live-follow: when enabled, automatically navigate to the file with the most
 * changes on each diff refresh. Skips first load (no comparison baseline).
 */
export function useLiveFollow({
  liveFollow,
  diffFiles,
  hasFullDiff,
  onSelectMostChanged,
}: UseLiveFollowParams): void {
  const prevDiffFilesRef = useRef<FileChange[] | null>(null);
  const onSelectRef = useRef(onSelectMostChanged);
  onSelectRef.current = onSelectMostChanged;

  useEffect(() => {
    // Don't baseline from the loading placeholder (hasFullDiff is false while
    // fetchDiff is in-flight with a cold cache, which creates files: []).
    if (!liveFollow || !diffFiles || !hasFullDiff) {
      if (hasFullDiff) {
        prevDiffFilesRef.current = diffFiles ?? null;
      }
      return;
    }

    const prevFiles = prevDiffFilesRef.current;
    prevDiffFilesRef.current = diffFiles;

    if (!prevFiles) return;

    const bestPath = pickMostChangedFile(prevFiles, diffFiles);
    if (bestPath) onSelectRef.current(bestPath);
  }, [liveFollow, diffFiles, hasFullDiff]);
}
