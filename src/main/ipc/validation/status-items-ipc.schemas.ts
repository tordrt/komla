import { z } from 'zod';

import {
  STATUS_ITEM_ID_PATTERN,
  STATUS_POPOVER_THEME_COLORS,
} from '../../../shared/types/status-items';
import { OKLCH_CHANNELS } from '../../services/status-popover-page';

import { idSchema } from './primitives';

export const statusItemsListArgsSchema = z.tuple([]);
export const statusCommandsListArgsSchema = z.tuple([idSchema]);
const statusItemIdSchema = z.string().regex(STATUS_ITEM_ID_PATTERN);

export const statusCommandRunArgsSchema = z.tuple([idSchema, statusItemIdSchema]);
// A theme can set a color that isn't OKLCH channels, such as a hex accent: the page goes
// without it rather than the popover failing.
const popoverThemeSchema = z
  .object({
    scheme: z.enum(['light', 'dark']),
    colors: z
      .partialRecord(z.enum(STATUS_POPOVER_THEME_COLORS), z.string().max(200))
      .transform((colors): typeof colors =>
        Object.fromEntries(
          Object.entries(colors).filter(([, channels]) => OKLCH_CHANNELS.test(channels))
        )
      ),
  })
  .strict();

export const statusPopoverRunArgsSchema = z.tuple([
  idSchema,
  statusItemIdSchema,
  popoverThemeSchema.optional(),
]);
export const statusButtonRunArgsSchema = z.tuple([
  idSchema,
  statusItemIdSchema,
  statusItemIdSchema,
]);
