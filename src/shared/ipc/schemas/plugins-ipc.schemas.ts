import { z } from 'zod';

import {
  MAX_PLUGIN_SECRET,
  MAX_PLUGIN_SETTING_ID,
  MAX_PLUGIN_SETTINGS,
  PLUGIN_ID_PATTERN,
} from '../../types/plugins';

export const pluginsSetEnabledArgsSchema = z.tuple([
  z.string().regex(PLUGIN_ID_PATTERN),
  z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal(false)]),
]);
/**
 * Some of a plugin's settings, each a value or null to clear it, from Settings or the plugin's
 * code. The plugin's manifest decides which settings it has and what each takes, which main checks.
 */
export const pluginSettingChangesSchema = z
  .record(
    z.string().max(MAX_PLUGIN_SETTING_ID),
    z.union([z.string().max(MAX_PLUGIN_SECRET), z.number(), z.boolean(), z.null()])
  )
  .refine(
    (changes) => Object.keys(changes).length <= MAX_PLUGIN_SETTINGS,
    `at most ${MAX_PLUGIN_SETTINGS} settings at once`
  );
export const pluginsSetSettingsArgsSchema = z.tuple([
  z.string().regex(PLUGIN_ID_PATTERN),
  pluginSettingChangesSchema,
]);
/** A plugin that is on, and whether it runs as its files change. */
export const pluginsSetDevelopmentArgsSchema = z.tuple([
  z.string().regex(PLUGIN_ID_PATTERN),
  z.boolean(),
]);
