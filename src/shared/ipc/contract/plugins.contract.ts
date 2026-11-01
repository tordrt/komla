import { IPC } from '../../constants/ipc-channels';
import {
  pluginsListArgsSchema,
  pluginsSetEnabledArgsSchema,
  pluginsOpenFolderArgsSchema,
} from '../schemas/plugins-ipc.schemas';

import { invoke } from './define';

import type { PluginInfo } from '../../types/plugins';

export const pluginsContract = {
  [IPC.PLUGINS_LIST]: invoke(pluginsListArgsSchema).returns<PluginInfo[]>(),
  [IPC.PLUGINS_SET_ENABLED]: invoke(pluginsSetEnabledArgsSchema).returns<PluginInfo[]>(),
  [IPC.PLUGINS_OPEN_FOLDER]: invoke(pluginsOpenFolderArgsSchema).returns<void>(),
} as const;
