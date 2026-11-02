/**
 * What a plugin's commands get on top of a terminal's environment: its folder, `KOMLA_PLUGIN_DIR`,
 * and its settings, `KOMLA_SETTING_<ID>`, when they run on this computer, and only its settings
 * that aren't secrets on an SSH host, which has neither the folder nor the secrets.
 */
type SettingsEnvironment = (pluginId: string, withSecrets: boolean) => Record<string, string>;

let settingsEnvironment: SettingsEnvironment = () => ({});

/** Where the settings come from, which Komla sets once it has read them. */
export function providePluginSettingsEnvironment(provider: SettingsEnvironment): void {
  settingsEnvironment = provider;
}

export function pluginEnvironment(
  plugin: { id: string; dir: string },
  onThisComputer: boolean
): Record<string, string> {
  return {
    ...settingsEnvironment(plugin.id, onThisComputer),
    ...(onThisComputer && { KOMLA_PLUGIN_DIR: plugin.dir }),
  };
}
