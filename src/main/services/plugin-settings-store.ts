import { join } from 'path';

import { safeStorage } from 'electron';

import { canUseSecureStorageAsync } from '../lib/secure-storage';

import { getKomlaBasePath } from './paths';
import { providePluginSettingsEnvironment } from './plugin-environment';
import { PluginSettingsStore } from './plugin-settings';
import { pluginsService } from './plugins.service';
import { sidebarPanelsService } from './sidebar-panels.service';
import { statusCommandsService } from './status-commands.service';

/** What the user set for plugins' settings, with secrets encrypted by the OS keychain. */
export const pluginSettingsStore = new PluginSettingsStore(
  join(getKomlaBasePath(), 'settings', 'plugin-settings.json'),
  {
    available: canUseSecureStorageAsync,
    encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
    decrypt: async (base64) => {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
        Buffer.from(base64, 'base64')
      );
      return { text: result, reEncrypt: shouldReEncrypt };
    },
  }
);

let stopFeeding: (() => void) | undefined;

/**
 * Reads the settings, before plugins run, and gives them to the plugins' commands. Resolves once
 * the secrets are decrypted too, which can wait on the keychain's prompt.
 */
export async function loadPluginSettings(): Promise<void> {
  // Before reading them, so plugins' commands still get what the user sets should reading fail.
  providePluginSettingsEnvironment((pluginId, withSecrets) =>
    pluginSettingsStore.environment(pluginId, pluginsService.settingFields(pluginId), withSecrets)
  );
  // Windows run the plugins' items and panels again, so they show what the new settings give.
  stopFeeding = pluginSettingsStore.onChange(() => {
    statusCommandsService.setPluginItems(pluginsService.statusItems());
    sidebarPanelsService.setPluginPanels(pluginsService.sidebarPanels());
  });
  await pluginSettingsStore.load();
}

/** Stops running plugins' items again for their settings, as when the keychain answers after quit. */
export function stopFeedingPluginSettings(): void {
  stopFeeding?.();
  stopFeeding = undefined;
}
