/** A plugin's id: short, so `<plugin>.<id>` still fits a status item's or hook's id. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * Whether a plugin runs: `on` while turned on and its files are as they were then, `changed` when
 * it was turned on but its files changed since, `off`, or `invalid` when Komla can't read it.
 */
export type PluginState = 'on' | 'off' | 'changed' | 'invalid';

/** One status bar item, hook or sidebar panel a plugin adds, as Settings lists it. */
export interface PluginContributionInfo {
  kind: 'status-item' | 'hook' | 'sidebar-panel';
  /** `<plugin>.<id>`, as `komla status refresh` takes it. */
  id: string;
  title: string;
  /** Its command; a sidebar panel with a page of its own may have none. */
  command?: string;
  /** A sidebar panel's own page, in the plugin's folder. */
  page?: string;
  /** What a sidebar panel's page may change through Komla. */
  capabilities?: string[];
  /** When it runs, such as "Every 60 seconds" or "An agent finishes". */
  when: string;
  /** Runs on this computer, in the home folder, not where the workspace's files are. */
  runOn?: 'local';
  /** Its other commands, such as its popover's or its buttons', which it runs when clicked. */
  moreCommands?: { label: string; command: string }[];
}

export interface PluginInfo {
  /** The manifest's id, or for a plugin Komla can't read, its folder's name. */
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Its code, a module in its folder, which runs while it's on. */
  main?: string;
  /** It runs as its files change, without being turned on again, as while the user writes it. */
  development?: true;
  /** How its code runs, while it's on and has code. */
  host?: PluginHostStatus;
  /** The plugin's folder, in the plugins folder. */
  folder: string;
  state: PluginState;
  /** Why Komla can't read the plugin, which keeps it from running. */
  problem?: string;
  /** Changes when any of the plugin's files do; turning it on takes the one the user saw. */
  digest?: string;
  contributions: PluginContributionInfo[];
}

/** How a plugin's code runs: starting, running, or failed and left off until it changes. */
export type PluginHostState = 'starting' | 'running' | 'failed';

export interface PluginHostStatus {
  state: PluginHostState;
  /** Why it failed, or why it's starting again. */
  error?: string;
  /** What its code printed last, oldest first. */
  log: string[];
}
