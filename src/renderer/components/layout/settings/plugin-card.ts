/**
 * The id of a plugin's row in Settings → Plugins, which a plugin's page opens Settings at with
 * `komla.openSettings()`. Plugin ids are lowercase letters, digits and dashes, so each has its own.
 */
export function pluginCardId(pluginId: string): string {
  return `settings-plugin-${pluginId}`;
}
