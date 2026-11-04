import { z } from 'zod';

import { SSH_HOST_ADDED_SOURCES } from '../../types/ssh';

import { idSchema } from './primitives';

export const telemetryTrackSshHostAddedArgsSchema = z.tuple([z.enum(SSH_HOST_ADDED_SOURCES)]);

export const telemetryTrackAgentSelectedArgsSchema = z.tuple([idSchema]);
