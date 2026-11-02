import { z } from 'zod';

import { STATUS_ITEM_ID_PATTERN } from '../../types/status-items';

import { idSchema } from './primitives';
import { popoverThemeSchema } from './status-items-ipc.schemas';

const panelIdSchema = z.string().regex(STATUS_ITEM_ID_PATTERN);

export const sidebarPanelsListArgsSchema = z.tuple([idSchema]);
/** A workspace, a panel and the window's theme, for its HTML page. */
export const sidebarPanelRunArgsSchema = z.tuple([
  idSchema,
  panelIdSchema,
  popoverThemeSchema.optional(),
]);
export const sidebarPanelButtonRunArgsSchema = z.tuple([idSchema, panelIdSchema, panelIdSchema]);
