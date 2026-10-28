import { z } from 'zod';

import { idSchema, safeStringSchema } from './primitives';

export const ptyInputArgsSchema = z.tuple([idSchema, safeStringSchema]);
export const terminalSetFocusArgsSchema = z.tuple([idSchema, z.boolean()]);
export const terminalClaimSizeArgsSchema = z.tuple([idSchema]);
export const ptyResizeArgsSchema = z.tuple([
  idSchema,
  z.number().int().min(1).max(2000),
  z.number().int().min(1).max(2000),
]);
export const ptyGetBufferArgsSchema = z.tuple([idSchema]);
export const ptyAckArgsSchema = z.tuple([idSchema, z.number().int().positive()]);
