import { useEffect, useMemo } from 'react';

import { useWorkspaceProjectId } from '@/hooks/useProject';
import { isHiddenInProject } from '@/lib/project-hidden-items';
import { panelView } from '@/lib/sidebar-tabs';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import {
  followSidebarPanelStates,
  loadSidebarPanels,
  useSidebarPanelsStore,
} from '@/stores/sidebar-panels.store';

import type { SidebarPanel, SidebarPanelList } from '../../shared/types/sidebar-panels';

const NO_PANELS: SidebarPanelList = { panels: [] };

/**
 * The panels sidebar-panels.json and the plugins that run give a workspace, as they change. A
 * workspace opened before shows the list it had while it's listed again.
 */
export function useSidebarPanels(workspaceId: string): SidebarPanelList {
  const list = useSidebarPanelsStore((s) => s.lists[workspaceId]);
  useEffect(() => {
    followSidebarPanelStates();
    const load = () => void loadSidebarPanels(workspaceId).catch(() => {});
    load();
    return window.api.onSidebarPanelsChange(load);
  }, [workspaceId]);
  return list ?? NO_PANELS;
}

/**
 * The panels a workspace's sidebar offers, less those the user hid in its project, the one it
 * showed last, and whether the sidebar shows that one in place of the file tree. Without a panel
 * picked that the workspace still has, `current` is its first.
 */
export function useSidebarPanelChoice(workspaceId: string): {
  list: SidebarPanelList;
  current: SidebarPanel | undefined;
  shown: boolean;
} {
  const allPanels = useSidebarPanels(workspaceId);
  const projectId = useWorkspaceProjectId(workspaceId);
  const projectHiddenItems = useConfigStore((s) => s.config?.projectHiddenItems);
  const list = useMemo(
    () => ({
      ...allPanels,
      panels: allPanels.panels.filter(
        (panel) => !isHiddenInProject({ projectHiddenItems }, projectId, panelView(panel.id))
      ),
    }),
    [allPanels, projectHiddenItems, projectId]
  );
  const picked = useFileViewerStore((s) => s.inlineSidebarPanelByWorkspace[workspaceId]);
  const chosen = picked && list.panels.find((panel) => panel.id === picked.id);
  return {
    list,
    current: chosen ?? list.panels[0],
    shown: Boolean(chosen && picked.shown),
  };
}
