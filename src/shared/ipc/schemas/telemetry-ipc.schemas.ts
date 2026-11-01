import { z } from 'zod';

import { SSH_HOST_ADDED_SOURCES } from '../../types/ssh';

import { idSchema } from './primitives';

export const telemetryTrackSshHostAddedArgsSchema = z.tuple([z.enum(SSH_HOST_ADDED_SOURCES)]);

export const telemetryTrackMonetizationArgsSchema = z.tuple([
  z.enum(['free_limit_hit', 'upgrade_clicked', 'license_activated']),
  z
    .strictObject({
      source: z.enum(['create_workspace', 'start_workspace', 'free_limit_wall']).optional(),
      limit: z.number().int().nonnegative().optional(),
      runningCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
]);

export const telemetryTrackAgentSelectedArgsSchema = z.tuple([idSchema]);
