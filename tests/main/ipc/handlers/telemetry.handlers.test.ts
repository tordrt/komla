import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const telemetry = vi.hoisted(() => ({ sendSshHostAdded: vi.fn() }));

vi.mock('../../../../src/main/services/telemetry.service', () => ({
  telemetryService: telemetry,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { registerTelemetryHandlers } from '../../../../src/main/ipc/handlers/telemetry.handlers';
import { IPC } from '../../../../src/shared/constants/ipc-channels';

describe('telemetry IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerTelemetryHandlers();
  });

  it('reports an SSH host added from a known source', async () => {
    await handlers.get(IPC.TELEMETRY_TRACK_SSH_HOST_ADDED)?.({}, 'new_workspace');

    expect(telemetry.sendSshHostAdded).toHaveBeenCalledExactlyOnceWith('new_workspace');
  });

  it.each([['wizard'], [''], [42], [undefined], [{ source: 'tips' }]])(
    'rejects an SSH host added from an unknown source %j',
    async (source) => {
      await expect(async () =>
        handlers.get(IPC.TELEMETRY_TRACK_SSH_HOST_ADDED)?.({}, source)
      ).rejects.toThrow();

      expect(telemetry.sendSshHostAdded).not.toHaveBeenCalled();
    }
  );
});
