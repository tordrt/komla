import { ipcMain } from 'electron';

import { ipcContract } from '../../../shared/ipc/contract';
import { createLogger } from '../../lib/logger';
import { errorReportingService } from '../../services/error-reporting.service';

import { createIpcValidationError, isIpcValidationError } from './ipc-errors';

import type {
  IpcArgs,
  IpcContract,
  IpcInvokeChannel,
  IpcResult,
  IpcSendChannel,
  IpcSyncChannel,
} from '../../../shared/ipc/contract';
import type { IpcArgsSchema } from '../../../shared/ipc/contract/define';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IpcValidation');

function parseChannelArgs<C extends keyof IpcContract>(channel: C, rawArgs: unknown[]): IpcArgs<C> {
  const parsed = (ipcContract[channel].args as IpcArgsSchema).safeParse(rawArgs);
  if (parsed.success) {
    return parsed.data as IpcArgs<C>;
  }

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'args',
    message: issue.message,
  }));

  throw createIpcValidationError(channel, issues);
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

function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  try {
    return new Error(String(thrown));
  } catch {
    return new Error('IPC listener threw an unprintable value');
  }
}

/**
 * A message's listener. A bad payload is logged and dropped. Anything else that throws is a bug, so
 * it's reported, but not rethrown: an uncaught exception in main quits the app.
 */
function messageListener<C extends IpcSendChannel | IpcSyncChannel>(
  channel: C,
  handler: (event: IpcMainEvent, args: IpcArgs<C>) => void
): (event: IpcMainEvent, ...rawArgs: unknown[]) => void {
  return (event, ...rawArgs) => {
    try {
      handler(event, parseChannelArgs(channel, rawArgs));
    } catch (error) {
      if (isIpcValidationError(error)) {
        logger.warn('Dropped invalid IPC event payload', { channel, error: error.message });
        return;
      }
      const failure = toError(error);
      logger.error('IPC listener failed', {
        channel,
        message: failure.message,
        stack: failure.stack,
      });
      void errorReportingService.report(failure, 'uncaughtException', { channel });
    }
  };
}

/** Registers a message's listener, and returns a function that removes it again. */
export function onIpc<C extends IpcSendChannel>(
  channel: C,
  handler: (event: IpcMainEvent, args: IpcArgs<C>) => void
): () => void {
  const listener = messageListener(channel, handler);
  ipcMain.on(channel, listener);
  return () => {
    ipcMain.removeListener(channel, listener);
  };
}

/**
 * Registers the listener of a message the renderer may block on. A blocked renderer stays frozen
 * until it gets a return value, so this always answers, once the listener is done.
 */
export function onIpcSync<C extends IpcSyncChannel>(
  channel: C,
  handler: (event: IpcMainEvent, args: IpcArgs<C>) => void
): void {
  const listener = messageListener(channel, handler);
  ipcMain.on(channel, (event, ...rawArgs) => {
    try {
      listener(event, ...rawArgs);
    } finally {
      event.returnValue = true;
    }
  });
}
