import { mkdirSync } from 'fs';

import { shell } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { createLogger } from '../../lib/logger';
import { getPluginsPath, pluginsService } from '../../services/plugins.service';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

import type { PluginInfo } from '../../../shared/types/plugins';

const logger = createLogger('PluginsHandlers');

export function registerPluginsHandlers(): void {
  pluginsService.onChange(() =>
    windowService.broadcastToAll(IPC.PLUGINS_CHANGED, pluginsService.list())
  );

  handleIpc(IPC.PLUGINS_LIST, async (): Promise<PluginInfo[]> => {
    await pluginsService.scan();
    return pluginsService.list();
  });

  // Settings lists every command a plugin runs beside its switch, so turning it on there is the
  // user's approval, of the files whose digest Settings showed; it fails if they've changed since.
  handleIpc(IPC.PLUGINS_SET_ENABLED, async (_, [id, digest]): Promise<PluginInfo[]> => {
    await pluginsService.scan();
    pluginsService.setEnabled({ [id]: digest });
    return pluginsService.list();
  });

  handleIpc(IPC.PLUGINS_OPEN_FOLDER, async () => {
    const path = getPluginsPath();
    mkdirSync(path, { recursive: true });
    const error = await shell.openPath(path);
    if (error) logger.warn(`Could not open the plugins folder: ${error}`);
  });
}
