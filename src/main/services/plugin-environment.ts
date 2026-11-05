import { isSshWorkspace, type Workspace } from '../../shared/types/workspace';

/**
 * What a plugin's commands get on top of a terminal's environment: its folder, `KOMLA_PLUGIN_DIR`,
 * and its settings, `KOMLA_SETTING_<ID>`. On an SSH host the folder is Komla's copy of it there,
 * and the settings leave out its secrets, which never leave this computer.
 */
type SettingsEnvironment = (pluginId: string, withSecrets: boolean) => Record<string, string>;
/**
 * Where a plugin has its files on an SSH host: with `wait`, copied there first if they aren't;
 * without, only if Komla knows they're there now.
 */
type HostFolder = (hostId: string, pluginId: string, wait: boolean) => Promise<string | undefined>;

let settingsEnvironment: SettingsEnvironment = () => ({});
let hostFolder: HostFolder = async () => undefined;

/** Where the settings come from, which Komla sets once it has read them. */
export function providePluginSettingsEnvironment(provider: SettingsEnvironment): void {
  settingsEnvironment = provider;
}

/** Where plugins' copies on SSH hosts come from, which Komla sets as it starts. */
export function providePluginHostFolders(provider: HostFolder): void {
  hostFolder = provider;
}

/**
 * The environment for a plugin's `command` that runs in `workspace`, which for an SSH workspace
 * is on its host, or on this computer without one. On a host, a command that names
 * `KOMLA_PLUGIN_DIR` waits for the plugin's copy there, and throws when Komla can't make it; one
 * that doesn't runs at once, with it only if Komla knows the copy is there, so a failed copy
 * fails only commands that need it.
 */
export async function pluginEnvironment(
  plugin: { id: string; name?: string; dir: string },
  workspace?: Workspace,
  command?: string
): Promise<Record<string, string>> {
  if (!workspace || !isSshWorkspace(workspace)) {
    return { ...settingsEnvironment(plugin.id, true), KOMLA_PLUGIN_DIR: plugin.dir };
  }
  let folder: string | undefined;
  try {
    const wait = command?.includes('KOMLA_PLUGIN_DIR') ?? false;
    folder = await hostFolder(workspace.backend.hostId, plugin.id, wait);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Komla couldn't copy plugin ${plugin.name ?? plugin.id} to the SSH host: ${reason}`,
      { cause: error }
    );
  }
  return {
    ...settingsEnvironment(plugin.id, false),
    ...(folder !== undefined && { KOMLA_PLUGIN_DIR: folder }),
  };
}
