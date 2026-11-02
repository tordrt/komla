import { mkdirSync } from 'fs';

import { shell } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { createLogger } from '../../lib/logger';
import { pluginHostService } from '../../services/plugin-host';
import { getPluginsPath, pluginsService } from '../../services/plugins.service';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

import type { PluginInfo } from '../../../shared/types/plugins';

const logger = createLogger('PluginsHandlers');

/** The plugins, with how the code of those that have it runs. */
function listPlugins(): PluginInfo[] {
  const hosts = pluginHostService.status();
  return pluginsService.list().map((plugin) => {
    const host = plugin.state === 'on' && plugin.main ? hosts[plugin.id] : undefined;
    return host ? { ...plugin, host } : plugin;
  });
}

export function registerPluginsHandlers(): void {
  const broadcast = () => windowService.broadcastToAll(IPC.PLUGINS_CHANGED, listPlugins());
  pluginsService.onChange(broadcast);
  // A plugin's output changes its status often, so windows hear of it at most twice a second.
  let pending: ReturnType<typeof setTimeout> | undefined;
  pluginHostService.onChange(() => {
    pending ??= setTimeout(() => {
      pending = undefined;
      broadcast();
    }, 500);
  });

  handleIpc(IPC.PLUGINS_LIST, async (): Promise<PluginInfo[]> => {
    await pluginsService.scan();
    return listPlugins();
  });

  // Settings lists every command a plugin runs beside its switch, so turning it on there is the
  // user's approval, of the files whose digest Settings showed; it fails if they've changed since.
  handleIpc(IPC.PLUGINS_SET_ENABLED, async (_, [id, digest]): Promise<PluginInfo[]> => {
    await pluginsService.scan();
    pluginsService.setEnabled({ [id]: digest });
    return listPlugins();
  });

  // Only Settings turns it on, beside a warning that the plugin then runs changes unseen.
  handleIpc(IPC.PLUGINS_SET_DEVELOPMENT, async (_, [id, development]): Promise<PluginInfo[]> => {
    await pluginsService.scan();
    pluginsService.setDevelopment(id, development);
    return listPlugins();
  });

  handleIpc(IPC.PLUGINS_OPEN_FOLDER, async () => {
    const path = getPluginsPath();
    mkdirSync(path, { recursive: true });
    const error = await shell.openPath(path);
    if (error) logger.warn(`Could not open the plugins folder: ${error}`);
  });
}
