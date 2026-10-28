import { useMemo, type CSSProperties } from 'react';

import { getProjectInfo } from '@/components/dashboard/dashboard-view-model';
import { resolveDefaultOpenMode } from '@/components/workspaces/file-viewer/search-open-target';
import { useFileSearchState } from '@/components/workspaces/file-viewer/useFileViewerState';
import { useContentSearch } from '@/hooks/useContentSearch';
import { useActivePalette } from '@/lib/palette-runtime';
import { primaryForMode } from '@/lib/primary-color';
import { colorToOklchValues } from '@/lib/project-colors';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useProjectsStore } from '@/stores/projects.store';

import type { CommandCenterMode } from '@/stores/command-center.store';
import type { Workspace } from '@/types';

/**
 * The command center's file and content search over `workspace`'s directory. Each
 * search runs only while its mode shows; `query` is the command center's own input.
 */
export function useCommandCenterFileSearch(
  workspace: Workspace | undefined,
  mode: CommandCenterMode,
  query: string,
  setQuery: (query: string) => void
) {
  const workspaceId = workspace?.id;
  const workingDirectory = workspace?.workingDirectory ?? '';
  const sharedQuery = useMemo(() => ({ query, setQuery }), [query, setQuery]);
  const includeGitIgnored = useFileViewerStore(
    (s) => !!workspaceId && !!s.showGitIgnoredByWorkspace[workspaceId]
  );
  const toggleShowGitIgnored = useFileViewerStore((s) => s.toggleShowGitIgnored);
  const fileState = useFileSearchState(
    workingDirectory,
    mode === 'files',
    sharedQuery,
    includeGitIgnored,
    workspaceId
  );
  const contentState = useContentSearch(
    workspaceId ?? '',
    mode === 'content' && !!workspaceId,
    undefined,
    sharedQuery
  );
  const search = mode === 'content' ? contentState : fileState;
  const results: Array<{ path: string; lineNumber?: number }> =
    mode === 'content' ? contentState.results : fileState.filteredFiles;

  const configuredOpenMode = useConfigStore((s) => s.config?.defaultSearchOpenMode ?? 'current');
  const fileViewerOpenForWorkspace = useFileViewerStore(
    (s) => !!workspaceId && s.fileViewerWorkspaceId === workspaceId
  );

  // File results use the workspace's project color, as its file viewer does.
  const projects = useProjectsStore((s) => s.projects);
  const paletteMode = useActivePalette().mode;
  const projectColor = useMemo(() => {
    if (!workspace) return undefined;
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    return getProjectInfo(workspace, projects, projectMap)?.color;
  }, [workspace, projects]);
  const projectColorOklch = projectColor ? colorToOklchValues(projectColor) : null;

  return {
    fileState,
    contentState,
    results,
    loading: search.loading,
    error: search.error,
    // Results can shrink before the search resets its selection.
    selectedIndex: Math.min(search.selectedIndex, results.length - 1),
    setSelectedIndex: search.setSelectedIndex,
    includeGitIgnored,
    toggleIncludeGitIgnored: () => {
      if (workspaceId) toggleShowGitIgnored(workspaceId);
    },
    defaultOpenMode: resolveDefaultOpenMode(configuredOpenMode, fileViewerOpenForWorkspace),
    projectColorStyle: projectColorOklch
      ? ({ '--primary': primaryForMode(projectColorOklch, paletteMode) } as CSSProperties)
      : undefined,
  };
}
