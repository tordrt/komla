import { useEffect, useState } from 'react';

import { projectRepoPath } from '../../shared/lib/project-repo-path';

import type { Project } from '@/types';

// Name of the repository's default branch, for labelling "from <branch>".
export function useDetectedMainBranch(project: Project | undefined, enabled: boolean): string {
  const repoPath =
    enabled && project && project.kind !== 'directory' ? projectRepoPath(project) : null;
  const [mainBranch, setMainBranch] = useState('');
  useEffect(() => {
    setMainBranch('');
    if (!repoPath) return;
    let cancelled = false;
    window.api
      .getMainBranch(repoPath)
      .then((branch) => {
        if (!cancelled) setMainBranch(branch ?? '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath]);
  return mainBranch;
}
