import { z } from 'zod';

import { BRANCH_NAME_PATTERN, idSchema, nonEmptyStringSchema } from './primitives';

const automationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('ssh'), hostId: idSchema }).strict(),
]);

const saveAutomationSchema = z
  .object({
    id: idSchema.optional(),
    previousTarget: automationTargetSchema.optional(),
    name: z.string().max(200),
    prompt: z.string().max(32_000),
    projectId: idSchema,
    target: automationTargetSchema,
    presetId: idSchema.optional(),
    launchModeId: idSchema.optional(),
    startBranch: z
      .string()
      .max(1024)
      .regex(BRANCH_NAME_PATTERN, 'must be a branch name')
      .optional(),
    schedule: z
      .object({ cron: nonEmptyStringSchema.max(256), timeZone: nonEmptyStringSchema.max(64) })
      .strict(),
    enabled: z.boolean(),
    missedRunGraceMinutes: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60),
  })
  .strict();

export const automationListArgsSchema = z.tuple([
  z.object({ readHosts: z.enum(['all', 'in-use']).optional() }).strict(),
]);
export const automationSaveArgsSchema = z.tuple([saveAutomationSchema]);
export const automationSetEnabledArgsSchema = z.tuple([
  automationTargetSchema,
  idSchema,
  z.boolean(),
]);
export const automationDeleteArgsSchema = z.tuple([automationTargetSchema, idSchema]);
export const automationRunNowArgsSchema = z.tuple([automationTargetSchema, idSchema]);
