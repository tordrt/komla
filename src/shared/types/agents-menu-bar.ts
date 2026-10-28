import type { Project } from './project';
import type { Workspace } from './workspace';
import type { AgentState } from '../lib/agent-state';

/** Komla's theme as its windows' root carries it, for pages drawn outside them. */
export interface AgentsMenuBarTheme {
  className: string;
  style: string;
}

/** What the popover shows of a workspace's project, as the sidebar shows it. */
export type AgentsMenuBarProject = Pick<Project, 'id' | 'name' | 'color' | 'icon' | 'kind'>;

/** What the macOS menu bar's agents popover shows, sent from main to its page. */
export interface AgentsMenuBarState {
  /** Every window's active workspaces, whose agents the page counts and lists. */
  workspaces: Workspace[];
  projects: AgentsMenuBarProject[];
  theme: AgentsMenuBarTheme | null;
}

/** How many agents are in each state, most urgent first; states without any are left out. */
export type AgentsMenuBarCounts = Array<{ state: AgentState; count: number }>;

/** What main asks Komla's window to draw for the menu bar item. */
export interface AgentsMenuBarDrawRequest {
  counts: AgentsMenuBarCounts;
  /** Whether macOS is in dark mode, where the menu bar is dark whatever the wallpaper. */
  dark: boolean;
}

/**
 * The menu bar item's image as Komla's window draws it, for the counts it was asked to draw: a PNG
 * at twice its size in points.
 */
export interface AgentsMenuBarImage {
  counts: AgentsMenuBarCounts;
  dataUrl: string;
  width: number;
  height: number;
}

/** Big enough for every state's icon and a four-digit count, at twice the size. */
export const AGENTS_MENU_BAR_IMAGE_MAX_DATA_URL_LENGTH = 200_000;
