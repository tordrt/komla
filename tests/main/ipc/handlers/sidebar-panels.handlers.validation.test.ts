import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const mockList = vi.fn();
const mockRun = vi.fn();
const mockRunButton = vi.fn();
const mockBroadcast = vi.fn();
let panelsChanged: () => void = () => {};
vi.mock('../../../../src/main/services/sidebar-panels.service', () => ({
  sidebarPanelsService: {
    onChange: (listener: () => void) => {
      panelsChanged = listener;
    },
    list: mockList,
    run: mockRun,
    runButton: mockRunButton,
  },
}));
vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: { broadcastToAll: mockBroadcast },
}));

async function handler(channel: string) {
  const { registerSidebarPanelsHandlers } =
    await import('../../../../src/main/ipc/handlers/sidebar-panels.handlers');
  registerSidebarPanelsHandlers();
  return electronMock.ipcMain._getHandler(channel)!;
}

describe('sidebar panels IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("lists a workspace's panels and tells windows when they change", async () => {
    mockList.mockResolvedValue({ panels: [] });
    await expect((await handler('sidebar-panels:list'))({}, 'ws-1')).resolves.toEqual({
      panels: [],
    });
    expect(mockList).toHaveBeenCalledWith('ws-1');
    panelsChanged();
    expect(mockBroadcast).toHaveBeenCalledWith('sidebar-panels:changed');
  });

  it("runs a panel in the window's theme, one page per window, and its buttons", async () => {
    mockRun.mockResolvedValue({ id: 'ci', content: null });
    mockRunButton.mockResolvedValue({});
    const theme = { scheme: 'dark', colors: { success: '0.7 0.15 150', primary: '#339fee' } };

    await (await handler('sidebar-panels:run'))({ sender: { id: 7 } }, 'ws-1', 'ci', theme);
    // A color that isn't OKLCH channels is left out.
    expect(mockRun).toHaveBeenCalledWith(
      'ws-1',
      'ci',
      { scheme: 'dark', colors: { success: '0.7 0.15 150' } },
      '7'
    );
    await expect(
      (await handler('sidebar-panels:button-run'))({}, 'ws-1', 'ci', 'rerun')
    ).resolves.toEqual({});
    expect(mockRunButton).toHaveBeenCalledWith('ws-1', 'ci', 'rerun');
  });

  it.each([
    ['sidebar-panels:list', []],
    ['sidebar-panels:list', ['  ']],
    ['sidebar-panels:run', ['ws-1']],
    ['sidebar-panels:run', ['ws-1', 'bad id']],
    ['sidebar-panels:run', ['ws-1', 'ci', { scheme: 'dark', colors: { evil: '1 0 0' } }]],
    ['sidebar-panels:button-run', ['ws-1', 'ci']],
    ['sidebar-panels:button-run', ['ws-1', 'ci', 'gh run rerun']],
    ['sidebar-panels:button-run', ['ws-1', 'ci', 'rerun', 'extra']],
  ])('rejects invalid %s arguments %j', async (channel, args) => {
    const run = await handler(channel);
    await expect(Promise.resolve().then(() => run({}, ...args))).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRunButton).not.toHaveBeenCalled();
  });
});
