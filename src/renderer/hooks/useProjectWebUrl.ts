import { useEffect, useState } from 'react';

import { projectRepoPath } from '../../shared/lib/project-repo-path';

import type { Project } from '@/types';

/**
 * The web page of a git project's origin remote, looked up in the clone Komla works in.
 * Undefined while it's looked up; null for a directory project or a repository without one.
 */
export function useProjectWebUrl(project: Project): string | null | undefined {
  const isDirectory = project.kind === 'directory';
  const repoPath = projectRepoPath(project);
  const [lookup, setLookup] = useState<{ repoPath: string; webUrl: string | null }>();

  useEffect(() => {
    if (isDirectory) return;
    let cancelled = false;
    window.api.getRepoWebInfo(repoPath).then(
      (info) => {
        if (!cancelled) setLookup({ repoPath, webUrl: webPageOrNull(info.webUrl) });
      },
      () => {
        if (!cancelled) setLookup({ repoPath, webUrl: null });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isDirectory, repoPath]);

  if (isDirectory) return null;
  return lookup?.repoPath === repoPath ? lookup.webUrl : undefined;
}

/**
 * A host without a dot is usually an ~/.ssh/config alias, such as github-work for a second
 * account, whose made-up https URL leads nowhere, so the folder shows instead.
 */
function webPageOrNull(webUrl: string | null): string | null {
  if (!webUrl) return null;
  try {
    return new URL(webUrl).hostname.includes('.') ? webUrl : null;
  } catch {
    return null;
  }
}

/** A web page as a project's location reads, such as github.com/acme/web. */
export function webUrlLabel(webUrl: string): string {
  return webUrl.replace(/^https?:\/\//, '');
}
