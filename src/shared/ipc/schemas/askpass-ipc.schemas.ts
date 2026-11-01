import { z } from 'zod';

import { idSchema } from './primitives';

export const askpassResponsePayloadSchema = z
  .object({
    id: idSchema,
    passphrase: z.string().nullable(),
    remember: z.boolean().optional(),
  })
  .strip();

export const askpassResponseArgsSchema = z.tuple([askpassResponsePayloadSchema]);
