import type { KomlaEventType } from './komla-events';
import type { StatusItemTone, StatusPopoverContent } from './status-items';
import type { AgentCapabilityId } from '../constants/agent-capabilities';

/** The longest title a sidebar panel's tab shows. */
export const MAX_SIDEBAR_PANEL_TITLE = 24;
/** The longest badge a panel's tab shows, such as a count. */
export const MAX_SIDEBAR_PANEL_BADGE = 12;

/** A short mark on a panel's tab, such as how many pull requests wait on a review. */
export interface SidebarPanelBadge {
  text: string;
  tone?: StatusItemTone;
}

/**
 * What a panel's page or its plugin's code set for a panel, beside what its command prints: its
 * badge, and the data its plugin's code posted for its page. `workspaceId` is empty for every
 * workspace, as for a panel that runs on this computer.
 */
export interface SidebarPanelState {
  workspaceId: string;
  id: string;
  badge?: SidebarPanelBadge;
  /** What the plugin's code posted last, which the page gets as its command's output. */
  data?: SidebarPanelData;
  /** Changes each time the plugin's code posts other data, so windows needn't compare it. */
  revision?: number;
}

/**
 * A panel from sidebar-panels.json or a plugin that runs, shown as a tab beside Diff and Files in
 * a workspace's sidebar: a page a command prints, which Komla runs while the panel is open, or a
 * page of the panel's own that stays loaded and gets what its command prints as data.
 */
export interface SidebarPanel {
  id: string;
  title: string;
  /** The tab's icon, as an image data URL Komla read and checked. */
  icon?: string;
  /** Shows the icon's shape in this color: a theme color or a hex color. */
  iconColor?: string;
  intervalSeconds: number;
  /** The panel has a page of its own, which Komla serves with `komla` in it. */
  page?: true;
  /** It has a command, which a page of its own gets the output of as data. */
  command?: true;
  /** Runs on this computer, the same for every workspace, not where the workspace's files are. */
  runOn?: 'local';
  /** Events in the workspace that run its command again at once while it's open. */
  refreshOn?: KomlaEventType[];
  /** The name of the plugin the panel comes from, when it isn't sidebar-panels.json's. */
  plugin?: string;
  /** Changes with its plugin's files, so its page loads again. */
  revision?: string;
  /** Its plugin runs as its files change, so the panel offers to inspect and reload its page. */
  development?: true;
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

/**
 * What one run of a page panel's command printed, for its page's `komla.onData`: the JSON it
 * printed, or its text without terminal colors.
 */
export interface SidebarPanelData {
  data?: unknown;
  /** Why the command failed. */
  error?: string;
}

/** What an operation a panel's page sent through `komla.call` returned. */
export type SidebarPanelOperationResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

/**
 * Capabilities a page may use only once the user agrees, each time: they run code with text the
 * caller wrote, or reach past what's on screen (ADR 0008).
 */
export const RISKY_PANEL_CAPABILITIES: readonly AgentCapabilityId[] = [
  'agent.launch.tab',
  'agent.launch.workspace',
  // Types a prompt into another agent, as launching one starts it with a prompt.
  'terminal.send',
  'workspace.trash',
  'workspace.link',
  'folder.open',
];
