import { useEffect } from 'react';

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
 * The panels a workspace's sidebar offers, the one its panel tab stands for, and whether the
 * sidebar shows it in place of the file tree. The tab stands for the panel picked last while the
 * workspace still has it, or else its first.
 */
export function useSidebarPanelChoice(workspaceId: string): {
  list: SidebarPanelList;
  current: SidebarPanel | undefined;
  shown: boolean;
} {
  const list = useSidebarPanels(workspaceId);
  const picked = useFileViewerStore((s) => s.inlineSidebarPanelByWorkspace[workspaceId]);
  const chosen = picked && list.panels.find((panel) => panel.id === picked.id);
  return {
    list,
    current: chosen ?? list.panels[0],
    shown: Boolean(chosen && picked.shown),
  };
}
