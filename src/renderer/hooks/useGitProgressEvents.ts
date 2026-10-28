import { useEffect } from 'react';

import { useGitProgressStore } from '@/stores/git-progress.store';

/** Feeds Git's progress reports from the main process into the progress store. */
export function useGitProgressEvents(): void {
  const updateProgress = useGitProgressStore((s) => s.updateProgress);
  useEffect(
    () =>
      window.api.onGitProgress((data) => {
        updateProgress(data.repoPath, data.percent, data.stage);
      }),
    [updateProgress]
  );
}
