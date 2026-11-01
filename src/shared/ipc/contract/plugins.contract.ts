import { IPC } from '../../constants/ipc-channels';
import { pluginsSetEnabledArgsSchema } from '../schemas/plugins-ipc.schemas';

import { invoke } from './define';

import type { PluginInfo } from '../../types/plugins';

export const pluginsContract = {
  [IPC.PLUGINS_LIST]: invoke().returns<PluginInfo[]>(),
  [IPC.PLUGINS_SET_ENABLED]: invoke(pluginsSetEnabledArgsSchema).returns<PluginInfo[]>(),
  [IPC.PLUGINS_OPEN_FOLDER]: invoke().returns<void>(),
} as const;
