import { z } from 'zod';

import { SSH_HOST_ADDED_SOURCES } from '../../../shared/types/ssh';

export const telemetryTrackSshHostAddedArgsSchema = z.tuple([z.enum(SSH_HOST_ADDED_SOURCES)]);
