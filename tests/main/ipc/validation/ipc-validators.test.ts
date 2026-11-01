import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());
vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Definitions of each kind, so these tests don't depend on any real channel.
vi.mock('../../../../src/shared/ipc/contract', () => ({
  ipcContract: {
    'test:invoke': { kind: 'invoke', args: z.tuple([z.string().trim()]) },
    'test:send': { kind: 'send', args: z.tuple([z.string().trim()]) },
    'test:sync': { kind: 'sync', args: z.tuple([z.string().trim()]) },
  },
}));

import * as validators from '../../../../src/main/ipc/validation/ipc-validators';

// The real channel names don't fit the fake contract above.
const { handleIpc, ipcListener, onIpc, onIpcSync } = validators as unknown as Record<
  'handleIpc' | 'ipcListener' | 'onIpc' | 'onIpcSync',
  (channel: string, handler: (...args: any[]) => unknown) => any
>;

interface MockIpcMain {
  _invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on: ReturnType<typeof vi.fn>;
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

    it('drops an invalid message without throwing', () => {
      const handler = vi.fn();
      onIpc('test:send', handler);

      expect(() => registeredListener()({}, 42)).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('ipcListener', () => {
    it('returns a validating listener and leaves registering it to the caller', () => {
      const handler = vi.fn();
      const listener = ipcListener('test:send', handler);

      expect(ipcMain.on).not.toHaveBeenCalled();
      listener({}, 42);
      expect(handler).not.toHaveBeenCalled();
      listener({}, 'hi');
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // A renderer in sendSync stays frozen until main sets a return value.
  describe('onIpcSync', () => {
    it('answers true once the handler has run', () => {
      const handler = vi.fn();
      onIpcSync('test:sync', handler);
      const event: Record<string, unknown> = {};

      registeredListener()(event, '  hi ');

      expect(handler).toHaveBeenCalledExactlyOnceWith(event, ['hi']);
      expect(event.returnValue).toBe(true);
    });

    it('still answers when the message is invalid', () => {
      const handler = vi.fn();
      onIpcSync('test:sync', handler);
      const event: Record<string, unknown> = {};

      registeredListener()(event, 42);

      expect(handler).not.toHaveBeenCalled();
      expect(event.returnValue).toBe(false);
    });

    it('still answers when the handler throws', () => {
      onIpcSync('test:sync', () => {
        throw new Error('boom');
      });
      const event: Record<string, unknown> = {};

      expect(() => registeredListener()(event, 'hi')).not.toThrow();
      expect(event.returnValue).toBe(false);
    });
  });
});
