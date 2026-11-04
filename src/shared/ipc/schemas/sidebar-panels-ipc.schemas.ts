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
export const sidebarPanelPageArgsSchema = sidebarPanelRunArgsSchema;
export const sidebarPanelDataArgsSchema = z.tuple([idSchema, panelIdSchema]);
/**
 * A workspace, a panel, a Komla Operation its page sent, which Komla reads as it reads the CLI's,
 * and whether the user was clicking in the page, with the workspace to act on in place of its own.
 */
export const sidebarPanelOperationArgsSchema = z.tuple([
  idSchema,
  panelIdSchema,
  z.record(z.string(), z.unknown()),
  z.object({ activated: z.boolean(), workspace: idSchema.optional() }).strict(),
]);
/**
 * A workspace, a panel, a message its page sends its plugin's code, as JSON, and whether the user
 * was clicking in the page.
 */
export const sidebarPanelMessageArgsSchema = z.tuple([
  idSchema,
  panelIdSchema,
  z.unknown(),
  z.object({ activated: z.boolean() }).strict(),
]);
