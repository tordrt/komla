import { z } from 'zod';

import { idSchema } from './primitives';

export const clipboardImportImageArgsSchema = z.tuple([
  idSchema,
  z.enum(['workspace', 'local-copy']).optional(),
]);

export const clipboardRunCommandArgsSchema = z.tuple([z.enum(['cut', 'copy', 'paste'])]);

export const agentUsageRefreshArgsSchema = z.tuple([
  z
    .object({
      sources: z
        .array(z.enum(['claude-code', 'codex']))
        .min(1)
        .max(2),
      force: z.boolean().optional(),
    })
    .strict(),
]);

// The SSH hosts to read besides this computer.
export const resourceUsageArgsSchema = z.tuple([
  idSchema.nullable(),
  z
    .object({
      prompt: z.boolean().optional(),
      maxAgeMs: z.number().int().min(0).max(60_000).optional(),
    })
    .strict()
    .optional(),
]);

export const announcementsDismissArgsSchema = z.tuple([idSchema]);

// Copied exactly as given, including whitespace, or nothing at all.
export const clipboardWriteTextArgsSchema = z.tuple([z.string()]);
