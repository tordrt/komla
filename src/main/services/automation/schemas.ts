import { z } from 'zod';

const AUTOMATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const text = (max: number) => z.string().max(max);

export const automationScheduleSchema = z.object({
  cron: text(256),
  timeZone: text(64),
});

export const automationRunSchema = z.object({
  id: text(128),
  automationId: z.string().regex(AUTOMATION_ID_PATTERN),
  trigger: z.enum(['schedule', 'manual']),
  scheduledFor: z.number().finite().optional(),
  startedAt: z.number().finite(),
  status: z.enum(['started', 'failed', 'skipped']),
  workspaceId: text(128).optional(),
  branch: text(4096).optional(),
  message: text(4096).optional(),
});

export const automationSchedulerStatusSchema = z.object({
  available: z.boolean(),
  message: text(4096).optional(),
});

/**
 * An automation as an SSH host stores it; see HostAutomation. Fields this version doesn't know
 * are kept, so saving a listed one again doesn't drop a newer device's.
 */
export const hostAutomationSchema = z.looseObject({
  schema: z.literal(1),
  id: z.string().regex(AUTOMATION_ID_PATTERN),
  name: text(4096),
  prompt: text(64 * 1024),
  enabled: z.boolean(),
  schedule: automationScheduleSchema,
  missedRunGraceMinutes: z.number().finite().nonnegative(),
  project: z.object({
    remoteRepoPath: text(4096),
    remoteProjectRoot: text(4096),
    gitUrl: text(4096),
    projectName: text(4096).optional(),
    baseBranch: text(4096).optional(),
    defaultBranch: text(4096).optional(),
    branchPrefix: text(4096).optional(),
  }),
  startBranch: text(4096).optional(),
  launch: z.object({
    agentName: text(4096),
    promptCommand: text(16_384),
    openCommand: text(16_384),
  }),
  desktop: z
    .object({
      projectId: text(128).optional(),
      presetId: text(128).optional(),
      launchModeId: text(128).optional(),
    })
    .optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  writtenBy: text(128).optional(),
});

/** What `komla automation list --json` prints on an SSH host. */
export const hostAutomationListSchema = z.object({
  automations: z.array(z.unknown()),
  runs: z.record(z.string(), z.array(z.unknown())),
  scheduler: automationSchedulerStatusSchema,
});
