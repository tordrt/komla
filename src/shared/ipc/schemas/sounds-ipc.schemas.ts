import { z } from 'zod';

import { safeStringSchema } from './primitives';

export const soundsGetDataUrlArgsSchema = z.tuple([safeStringSchema]);
