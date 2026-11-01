import { ipcMain } from 'electron';
import { z } from 'zod';

import { ipcContract } from '../../../shared/ipc/contract';
import { createLogger } from '../../lib/logger';

import { createIpcValidationError } from './ipc-errors';

import type {
  IpcArgs,
  IpcContract,
  IpcInvokeChannel,
  IpcResult,
  IpcSendChannel,
  IpcSyncChannel,
} from '../../../shared/ipc/contract';
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
    return parsed.data;
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

function parseChannelArgs<C extends keyof IpcContract>(channel: C, rawArgs: unknown[]): IpcArgs<C> {
  return parseTuple(channel, ipcContract[channel].args as AnyTupleSchema, rawArgs) as IpcArgs<C>;
}

/** Registers a call's handler. Its arguments are validated, and its result checked at compile time. */
export function handleIpc<C extends IpcInvokeChannel>(
  channel: C,
  handler: (event: IpcMainInvokeEvent, args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>
): void {
  ipcMain.handle(channel, (event, ...rawArgs) =>
    handler(event, parseChannelArgs(channel, rawArgs))
  );
}

/** A validating listener for a message, for a service that removes it again when it stops. */
export function ipcListener<C extends IpcSendChannel>(
  channel: C,
  handler: (event: IpcMainEvent, args: IpcArgs<C>) => void
): (event: IpcMainEvent, ...rawArgs: unknown[]) => void {
  return (event, ...rawArgs) => {
    try {
      handler(event, parseChannelArgs(channel, rawArgs));
    } catch (error) {
      logger.warn('Dropped invalid IPC event payload', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/** Registers a message's listener. A message that fails validation is logged and dropped. */
export function onIpc<C extends IpcSendChannel>(
  channel: C,
  handler: (event: IpcMainEvent, args: IpcArgs<C>) => void
): void {
  ipcMain.on(channel, ipcListener(channel, handler));
}

/**
 * Registers the listener of a message the renderer may block on. A blocked renderer stays frozen
 * until it gets a return value, so this answers whatever happens: true if the handler ran.
 */
export function onIpcSync<C extends IpcSyncChannel>(
  channel: C,
  handler: (event: IpcMainEvent, args: IpcArgs<C>) => void
): void {
  ipcMain.on(channel, (event, ...rawArgs) => {
    let handled = false;
    try {
      handler(event, parseChannelArgs(channel, rawArgs));
      handled = true;
    } catch (error) {
      logger.warn('Dropped an IPC message that could not be handled', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    event.returnValue = handled;
  });
}
