import { z } from 'zod';

import { PLUGIN_ID_PATTERN } from '../../../shared/types/plugins';

export const pluginsListArgsSchema = z.tuple([]);
export const pluginsSetEnabledArgsSchema = z.tuple([
  z.string().regex(PLUGIN_ID_PATTERN),
  z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal(false)]),
]);
export const pluginsOpenFolderArgsSchema = z.tuple([]);
