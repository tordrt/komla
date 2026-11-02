import { IPC } from '../../constants/ipc-channels';
import {
  pluginsSetDevelopmentArgsSchema,
  pluginsSetEnabledArgsSchema,
} from '../schemas/plugins-ipc.schemas';

import { invoke } from './define';

import type { PluginInfo } from '../../types/plugins';

export const pluginsContract = {
  [IPC.PLUGINS_LIST]: invoke().returns<PluginInfo[]>(),
  [IPC.PLUGINS_SET_ENABLED]: invoke(pluginsSetEnabledArgsSchema).returns<PluginInfo[]>(),
  [IPC.PLUGINS_OPEN_FOLDER]: invoke().returns<void>(),
  [IPC.PLUGINS_SET_DEVELOPMENT]: invoke(pluginsSetDevelopmentArgsSchema).returns<PluginInfo[]>(),
} as const;
