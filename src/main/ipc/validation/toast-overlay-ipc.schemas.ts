import { z } from 'zod';

import { TOAST_OVERLAY_MESSAGE_MAX_LENGTH } from '../../../shared/types';

import { idSchema } from './primitives';

const coordinateSchema = z.number().min(-100_000).max(100_000);
const dimensionSchema = z.number().positive().max(100_000);

const toastSchema = z
  .object({
    id: idSchema,
    message: z.string().max(TOAST_OVERLAY_MESSAGE_MAX_LENGTH),
    type: z.enum(['success', 'error', 'info']),
    actionLabel: z.string().max(200).optional(),
    dismissOnTimeout: z.boolean(),
    progress: z.boolean().optional(),
    quiet: z.boolean().optional(),
  })
  .strip();

const toastOverlayStateSchema = z
  .object({
    bounds: z
      .object({
        x: coordinateSchema,
        y: coordinateSchema,
        width: dimensionSchema,
        height: dimensionSchema,
      })
      .strip(),
    toasts: z.array(toastSchema).min(1).max(10),
    themeClassName: z.string().max(1_000),
    themeStyle: z.string().max(50_000),
    messageMaxHeight: z.number().nonnegative().max(100_000),
  })
  .strip();

export const toastOverlayShowArgsSchema = z.tuple([toastOverlayStateSchema]);
export const toastOverlayHideArgsSchema = z.tuple([]);
export const toastOverlayPointerUpArgsSchema = z.tuple([]);
export const toastOverlayEventArgsSchema = z.tuple([
  z.object({ type: z.enum(['remove', 'action']), id: idSchema }).strip(),
]);
