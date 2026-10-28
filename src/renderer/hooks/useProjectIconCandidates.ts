import { useEffect, useState } from 'react';

import type { ProjectIconCandidate, ProjectIconSource } from '@/types';

const NONE: ProjectIconCandidate[] = [];

/**
 * The images found in a folder or a project's files that could be its icon, best first.
 * Empty while looking, and for no source or an empty folder.
 */
export function useProjectIconCandidates(source: ProjectIconSource | null): ProjectIconCandidate[] {
  const folder = source && 'folder' in source ? source.folder : '';
  const projectId = source && 'projectId' in source ? source.projectId : '';
  const key = folder ? `folder:${folder}` : projectId ? `project:${projectId}` : '';
  const [found, setFound] = useState<{ key: string; candidates: ProjectIconCandidate[] }>();

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void window.api
      .findProjectIcons(folder ? { folder } : { projectId })
      .then((candidates) => {
        if (!cancelled) setFound({ key, candidates });
      })
      .catch((err) => console.error('Failed to look for project icons:', err));
    return () => {
      cancelled = true;
    };
  }, [key, folder, projectId]);

  // Another source's images never show while this one's are found.
  return key && found?.key === key ? found.candidates : NONE;
}
