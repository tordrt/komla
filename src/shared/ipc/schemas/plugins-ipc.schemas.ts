import { z } from 'zod';

import { PLUGIN_ID_PATTERN } from '../../types/plugins';

export const pluginsSetEnabledArgsSchema = z.tuple([
  z.string().regex(PLUGIN_ID_PATTERN),
  z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal(false)]),
]);
/** A plugin that is on, and whether it runs as its files change. */
export const pluginsSetDevelopmentArgsSchema = z.tuple([
  z.string().regex(PLUGIN_ID_PATTERN),
  z.boolean(),
]);
