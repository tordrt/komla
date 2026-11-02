import type { StatusPopoverContent } from './status-items';

/** The longest title a sidebar panel's tab shows. */
export const MAX_SIDEBAR_PANEL_TITLE = 24;

/**
 * A panel from sidebar-panels.json or a plugin that runs, shown as a tab beside Diff and Files in
 * a workspace's sidebar: a page a command prints, which Komla runs while the panel is open.
 */
export interface SidebarPanel {
  id: string;
  title: string;
  /** The tab's icon, as an image data URL Komla read and checked. */
  icon?: string;
  /** Shows the icon's shape in this color: a theme color or a hex color. */
  iconColor?: string;
  intervalSeconds: number;
  /** Runs on this computer, the same for every workspace, not where the workspace's files are. */
  runOn?: 'local';
  /** The name of the plugin the panel comes from, when it isn't sidebar-panels.json's. */
  plugin?: string;
}

export interface SidebarPanelList {
  panels: SidebarPanel[];
  /** What is wrong with sidebar-panels.json, when Komla can't read it. */
  problem?: string;
}

/** What one run of a panel's command shows. */
export interface SidebarPanelResult {
  id: string;
  workspaceId: string;
  content: StatusPopoverContent | null;
  /** Why the command failed. */
  error?: string;
}
