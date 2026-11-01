import { z } from 'zod';

import { idSchema } from './primitives';

export const mcpGetStatusArgsSchema = z.tuple([idSchema.optional(), idSchema.optional()]);
