import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const mockRunStatusCommand = vi.fn();
const mockListStatusCommands = vi.fn();
const mockRunPopover = vi.fn();
const mockRunButton = vi.fn();
vi.mock('../../../../src/main/services/status-commands.service', () => ({
  statusCommandsService: {
    onChange: vi.fn(),
    onResult: vi.fn(),
    list: mockListStatusCommands,
    run: mockRunStatusCommand,
    runPopover: mockRunPopover,
    runButton: mockRunButton,
  },
}));
vi.mock('../../../../src/main/services/status-items.service', () => ({
  statusItemsService: { onChange: vi.fn(), list: vi.fn(() => []) },
}));
vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: { broadcastToAll: vi.fn() },
}));

async function handler(channel: string) {
  const { registerStatusItemsHandlers } =
    await import('../../../../src/main/ipc/handlers/status-items.handlers');
  registerStatusItemsHandlers();
  return electronMock.ipcMain._getHandler(channel)!;
}

describe('status items IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("lists and runs a workspace's status commands", async () => {
    mockListStatusCommands.mockReturnValue({ items: [] });
    mockRunStatusCommand.mockResolvedValue({ id: 'ci' });

    expect((await handler('status-items:commands-list'))({}, 'ws-1')).toEqual({ items: [] });
    await expect((await handler('status-items:command-run'))({}, 'ws-1', 'ci')).resolves.toEqual({
      id: 'ci',
    });
    expect(mockListStatusCommands).toHaveBeenCalledWith('ws-1');
    expect(mockRunStatusCommand).toHaveBeenCalledWith('ws-1', 'ci');
  });

  it("runs an item's popover command and its buttons' commands", async () => {
    mockRunPopover.mockResolvedValue({ id: 'pr', content: null });
    mockRunButton.mockResolvedValue({});

    // Each window gets pages of its own.
    const fromWindow = { sender: { id: 7 } };
    await expect(
      (await handler('status-items:popover-run'))(fromWindow, 'ws-1', 'pr')
    ).resolves.toEqual({
      id: 'pr',
      content: null,
    });
    await expect(
      (await handler('status-items:button-run'))({}, 'ws-1', 'pr', 'rerun')
    ).resolves.toEqual({});
    expect(mockRunPopover).toHaveBeenCalledWith('ws-1', 'pr', undefined, '7');
    const theme = { scheme: 'dark', colors: { success: '0.7 0.15 150' } };
    await (
      await handler('status-items:popover-run')
    )(fromWindow, 'ws-1', 'pr', theme);
    expect(mockRunPopover).toHaveBeenLastCalledWith('ws-1', 'pr', theme, '7');
    expect(mockRunButton).toHaveBeenCalledWith('ws-1', 'pr', 'rerun');
  });

  it('leaves out popover theme colors that are not channels', async () => {
    await (
      await handler('status-items:popover-run')
    )({ sender: { id: 7 } }, 'ws-1', 'pr', {
      scheme: 'dark',
      colors: { success: '1 0 0; } body {', primary: '#339fee', foreground: '0.9 0 0' },
    });
    expect(mockRunPopover).toHaveBeenLastCalledWith(
      'ws-1',
      'pr',
      {
        scheme: 'dark',
        colors: { foreground: '0.9 0 0' },
      },
      '7'
    );
  });

  it.each([[['ws-1', 'pr', { scheme: 'dark', colors: { evil: '1 0 0' } }]]])(
    'rejects a popover theme color Komla has none of %j',
    async (args) => {
      const run = await handler('status-items:popover-run');
      await expect(Promise.resolve().then(() => run({}, ...args))).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
      expect(mockRunPopover).not.toHaveBeenCalled();
    }
  );

  it.each([[['ws-1', 'pr']], [['ws-1', 'pr', 'gh run rerun']], [['ws-1', 'pr', 'rerun', 'x']]])(
    'rejects invalid button arguments %j',
    async (args) => {
      const run = await handler('status-items:button-run');
      await expect(Promise.resolve().then(() => run({}, ...args))).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
      expect(mockRunButton).not.toHaveBeenCalled();
    }
  );

  it.each([[['ws-1']], [['ws-1', 'bad id']], [['  ', 'ci']], [['ws-1', 'ci', 'extra']]])(
    'rejects invalid run arguments %j',
    async (args) => {
      const run = await handler('status-items:command-run');
      await expect(Promise.resolve().then(() => run({}, ...args))).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
      expect(mockRunStatusCommand).not.toHaveBeenCalled();
    }
  );
});
