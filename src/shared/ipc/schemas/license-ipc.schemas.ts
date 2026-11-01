import { z } from 'zod';

import { idSchema, nonEmptyStringSchema } from './primitives';

export const licenseActivateArgsSchema = z.tuple([nonEmptyStringSchema]);
export const licenseGetActivationsArgsSchema = z.tuple([nonEmptyStringSchema]);
export const licenseRevokeActivationArgsSchema = z.tuple([idSchema, nonEmptyStringSchema]);
