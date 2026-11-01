import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as validators from '../../../../src/main/ipc/validation/ipc-validators';

vi.mock('electron', async () => (await import('../../../mocks/electron')).mockElectron());

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/main/lib/logger', () => ({ createLogger: () => logger }));

const errorReporting = vi.hoisted(() => ({ report: vi.fn(async () => {}) }));
vi.mock('../../../../src/main/services/error-reporting.service', () => ({
  errorReportingService: errorReporting,
}));

// Definitions of each kind, so these tests don't depend on any real channel.
vi.mock('../../../../src/shared/ipc/contract', () => ({
  ipcContract: {
    'test:invoke': { kind: 'invoke', args: z.tuple([z.string().trim()]) },
    'test:send': { kind: 'send', args: z.tuple([z.string().trim()]) },
    'test:sync': { kind: 'sync', args: z.tuple([z.string().trim()]) },
    'test:broken-schema': {
      kind: 'send',
      args: z.tuple([
        z.string().transform(() => {
          throw new Error('schema bug');
        }),
      ]),
    },
  },
}));

// The real channel names don't fit the fake contract above.
const { handleIpc, onIpc, onIpcSync } = validators as unknown as Record<
  'handleIpc' | 'onIpc' | 'onIpcSync',
  (channel: string, handler: (...args: any[]) => unknown) => any
>;

interface MockIpcMain {
  _invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

describe('IPC registration from the contract', () => {
  let ipcMain: MockIpcMain;

  beforeEach(async () => {
    ({ ipcMain } = (await import('electron')) as unknown as { ipcMain: MockIpcMain });
    vi.clearAllMocks();
  });

  function registeredListener(): (event: Record<string, unknown>, ...args: unknown[]) => void {
    return ipcMain.on.mock.calls.at(-1)![1];
  }

  describe('handleIpc', () => {
    it('passes the schema output to the handler and returns its result', async () => {
      const handler = vi.fn((_event: unknown, [text]: [string]) => `${text}!`);
      handleIpc('test:invoke', handler);

      await expect(ipcMain._invoke('test:invoke', '  hi ')).resolves.toBe('hi!');
    });

    it('rejects invalid arguments without running the handler', async () => {
      const handler = vi.fn();
      handleIpc('test:invoke', handler);

      await expect(ipcMain._invoke('test:invoke', 42)).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
        channel: 'test:invoke',
      });
      await expect(ipcMain._invoke('test:invoke', 'hi', 'extra')).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('onIpc', () => {
    it('passes the schema output to the handler', () => {
      const handler = vi.fn();
      onIpc('test:send', handler);
      const event = {};

      registeredListener()(event, '  hi ');

      expect(handler).toHaveBeenCalledExactlyOnceWith(event, ['hi']);
    });

    it('logs and drops an invalid message, which is no error to report', () => {
      const handler = vi.fn();
      onIpc('test:send', handler);

      expect(() => registeredListener()({}, 42)).not.toThrow();

      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(errorReporting.report).not.toHaveBeenCalled();
    });

    // An exception reaching process.on('uncaughtException') would quit the app.
    it('reports a handler that throws, as a bug in it and without quitting', () => {
      const failure = new Error('boom');
      onIpc('test:send', () => {
        throw failure;
      });

      expect(() => registeredListener()({}, 'hi')).not.toThrow();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledOnce();
      expect(errorReporting.report).toHaveBeenCalledExactlyOnceWith(
        failure,
        'uncaughtException',
        { channel: 'test:send' }
      );
    });

    it('reports a schema that throws, rather than blaming the payload', () => {
      const handler = vi.fn();
      onIpc('test:broken-schema', handler);

      expect(() => registeredListener()({}, 'hi')).not.toThrow();

      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(errorReporting.report).toHaveBeenCalledOnce();
    });

    it.each([
      ['a string', 'disk full', 'disk full'],
      ['a value with no text form', Object.create(null), 'IPC listener threw an unprintable value'],
    ])('reports a handler that throws %s', (_kind, thrown, message) => {
      onIpc('test:send', () => {
        throw thrown;
      });

      expect(() => registeredListener()({}, 'hi')).not.toThrow();

      expect(errorReporting.report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message }),
        'uncaughtException',
        { channel: 'test:send' }
      );
    });

    it('returns a function that removes the listener it added', () => {
      const stop = onIpc('test:send', vi.fn());
      const listener = registeredListener();

      expect(ipcMain.removeListener).not.toHaveBeenCalled();
      stop();

      expect(ipcMain.removeListener).toHaveBeenCalledExactlyOnceWith('test:send', listener);
    });
  });

  // A renderer in sendSync stays frozen until main sets a return value.
  describe('onIpcSync', () => {
    it('answers once the handler has run', () => {
      const order: string[] = [];
      onIpcSync('test:sync', (_event, [text]: [string]) => order.push(`handled ${text}`));
      const event = {
        set returnValue(value: unknown) {
          order.push(`answered ${String(value)}`);
        },
      };

      registeredListener()(event as never, '  hi ');

      expect(order).toEqual(['handled hi', 'answered true']);
    });

    it('still answers when the message is invalid', () => {
      const handler = vi.fn();
      onIpcSync('test:sync', handler);
      const event: Record<string, unknown> = {};

      registeredListener()(event, 42);

      expect(handler).not.toHaveBeenCalled();
      expect(event.returnValue).toBe(true);
    });

    it('still answers when reporting the failure itself throws', () => {
      logger.error.mockImplementationOnce(() => {
        throw new Error('log file gone');
      });
      onIpcSync('test:sync', () => {
        throw new Error('boom');
      });
      const event: Record<string, unknown> = {};

      expect(() => registeredListener()(event, 'hi')).toThrow('log file gone');

      expect(event.returnValue).toBe(true);
    });

    it('still answers when the handler throws, and reports it', () => {
      const failure = new Error('boom');
      onIpcSync('test:sync', () => {
        throw failure;
      });
      const event: Record<string, unknown> = {};

      expect(() => registeredListener()(event, 'hi')).not.toThrow();

      expect(event.returnValue).toBe(true);
      expect(errorReporting.report).toHaveBeenCalledExactlyOnceWith(
        failure,
        'uncaughtException',
        { channel: 'test:sync' }
      );
    });
  });
});
