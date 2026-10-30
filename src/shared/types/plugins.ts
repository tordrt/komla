/** A plugin's id: short, so `<plugin>.<id>` still fits a status item's or hook's id. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * Whether a plugin runs: `on` while turned on and its files are as they were then, `changed` when
 * it was turned on but its files changed since, `off`, or `invalid` when Komla can't read it.
 */
export type PluginState = 'on' | 'off' | 'changed' | 'invalid';

/** One status bar item or hook a plugin adds, as Settings lists it. */
export interface PluginContributionInfo {
  kind: 'status-item' | 'hook';
  /** `<plugin>.<id>`, as `komla status refresh` takes it. */
  id: string;
  title: string;
  command: string;
  /** When it runs, such as "Every 60 seconds" or "An agent finishes". */
  when: string;
  /** Runs on this computer, in the home folder, not where the workspace's files are. */
  runOn?: 'local';
  /** The item's other commands, such as its popover's, which it runs when clicked. */
  moreCommands?: { label: string; command: string }[];
}

export interface PluginInfo {
  /** The manifest's id, or for a plugin Komla can't read, its folder's name. */
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** The plugin's folder, in the plugins folder. */
  folder: string;
  state: PluginState;
  /** Why Komla can't read the plugin, which keeps it from running. */
  problem?: string;
  /** Changes when any of the plugin's files do; turning it on takes the one the user saw. */
  digest?: string;
  contributions: PluginContributionInfo[];
}
