import { mkdirSync } from 'fs';

import { ipcMain, shell } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { createLogger } from '../../lib/logger';
import { getPluginsPath, pluginsService } from '../../services/plugins.service';
import { windowService } from '../../services/window.service';
import { handleValidated } from '../validation/ipc-validators';
import {
  pluginsListArgsSchema,
  pluginsOpenFolderArgsSchema,
  pluginsSetEnabledArgsSchema,
} from '../validation/plugins-ipc.schemas';

import type { PluginInfo } from '../../../shared/types/plugins';

const logger = createLogger('PluginsHandlers');

export function registerPluginsHandlers(): void {
  pluginsService.onChange(() =>
    windowService.broadcastToAll(IPC.PLUGINS_CHANGED, pluginsService.list())
  );

  ipcMain.handle(
    IPC.PLUGINS_LIST,
    handleValidated(IPC.PLUGINS_LIST, pluginsListArgsSchema, async (): Promise<PluginInfo[]> => {
      await pluginsService.scan();
      return pluginsService.list();
    })
  );

  // Settings lists every command a plugin runs beside its switch, so turning it on there is the
  // user's approval, of the files whose digest Settings showed; it fails if they've changed since.
  ipcMain.handle(
    IPC.PLUGINS_SET_ENABLED,
    handleValidated(
      IPC.PLUGINS_SET_ENABLED,
      pluginsSetEnabledArgsSchema,
      async (_, [id, digest]): Promise<PluginInfo[]> => {
        await pluginsService.scan();
        pluginsService.setEnabled({ [id]: digest });
        return pluginsService.list();
      }
    )
  );

  ipcMain.handle(
    IPC.PLUGINS_OPEN_FOLDER,
    handleValidated(IPC.PLUGINS_OPEN_FOLDER, pluginsOpenFolderArgsSchema, async () => {
      const path = getPluginsPath();
      mkdirSync(path, { recursive: true });
      const error = await shell.openPath(path);
      if (error) logger.warn(`Could not open the plugins folder: ${error}`);
    })
  );
}
