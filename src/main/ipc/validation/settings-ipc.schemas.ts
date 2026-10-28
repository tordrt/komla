import { z } from 'zod';

import { idSchema } from './primitives';

export const settingsApprovalResolveArgsSchema = z.tuple([idSchema, z.enum(['apply', 'cancel'])]);
export const settingsApprovalRequestPendingArgsSchema = z.tuple([]);
export const settingsHistoryListArgsSchema = z.tuple([]);
export const settingsHistoryRevertArgsSchema = z.tuple([idSchema]);
