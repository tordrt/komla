import { z } from 'zod';

import { createLogger } from '../../lib/logger';

import { createIpcValidationError } from './ipc-errors';

import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IpcValidation');

// Any schema that parses to an argument list: a tuple or a union of tuples.
type AnyTupleSchema = z.ZodType<unknown[]>;

function parseTuple<TSchema extends AnyTupleSchema>(
  channel: string,
  schema: TSchema,
  rawArgs: unknown[]
): z.infer<TSchema> {
  const parsed = schema.safeParse(rawArgs);
  if (parsed.success) {
    return parsed.data as z.infer<TSchema>;
  }

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'args',
    message: issue.message,
  }));

  throw createIpcValidationError(channel, issues);
}

export function handleValidated<TSchema extends AnyTupleSchema, TResult>(
  channel: string,
  schema: TSchema,
  handler: (event: IpcMainInvokeEvent, args: z.infer<TSchema>) => TResult | Promise<TResult>
): (event: IpcMainInvokeEvent, ...rawArgs: unknown[]) => TResult | Promise<TResult> {
  return (event: IpcMainInvokeEvent, ...rawArgs: unknown[]) => {
    const args = parseTuple(channel, schema, rawArgs);
    return handler(event, args);
  };
}

export function onValidated<TSchema extends AnyTupleSchema>(
  channel: string,
  schema: TSchema,
  handler: (event: IpcMainEvent, args: z.infer<TSchema>) => void
): (event: IpcMainEvent, ...rawArgs: unknown[]) => void {
  return (event: IpcMainEvent, ...rawArgs: unknown[]) => {
    try {
      const args = parseTuple(channel, schema, rawArgs);
      handler(event, args);
    } catch (error) {
      logger.warn('Dropped invalid IPC event payload', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
