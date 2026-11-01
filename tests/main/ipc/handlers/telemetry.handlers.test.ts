import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const telemetry = vi.hoisted(() => ({
  sendSshHostAdded: vi.fn(),
  sendMonetizationEvent: vi.fn(),
  sendAgentSelected: vi.fn(),
}));

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

  it('reports a monetization event with its properties', async () => {
    const props = { source: 'free_limit_wall', limit: 3, runningCount: 2 };

    await handlers.get(IPC.TELEMETRY_TRACK_MONETIZATION)?.({}, 'free_limit_hit', props);
    await handlers.get(IPC.TELEMETRY_TRACK_MONETIZATION)?.({}, 'license_activated');

    expect(telemetry.sendMonetizationEvent).toHaveBeenCalledWith('free_limit_hit', props);
    expect(telemetry.sendMonetizationEvent).toHaveBeenCalledWith('license_activated', undefined);
  });

  it.each([
    [['unknown_event']],
    [[]],
    [[42]],
    [['free_limit_hit', { source: 'wizard' }]],
    [['free_limit_hit', { limit: 'many' }]],
    [['free_limit_hit', { runningCount: -1 }]],
    [['free_limit_hit', { source: 'free_limit_wall', secret: 'x' }]],
    [['free_limit_hit', 'props']],
  ])('rejects the monetization event %j', async (args) => {
    await expect(async () =>
      handlers.get(IPC.TELEMETRY_TRACK_MONETIZATION)?.({}, ...args)
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });

    expect(telemetry.sendMonetizationEvent).not.toHaveBeenCalled();
  });

  it('reports the selected agent, trimmed', async () => {
    await handlers.get(IPC.TELEMETRY_TRACK_AGENT_SELECTED)?.({}, '  Claude Code ');

    expect(telemetry.sendAgentSelected).toHaveBeenCalledExactlyOnceWith('Claude Code');
  });

  it.each([[[]], [['']], [['   ']], [[42]], [[null]]])(
    'rejects the selected agent %j',
    async (args) => {
      await expect(async () =>
        handlers.get(IPC.TELEMETRY_TRACK_AGENT_SELECTED)?.({}, ...args)
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });

      expect(telemetry.sendAgentSelected).not.toHaveBeenCalled();
    }
  );
});
