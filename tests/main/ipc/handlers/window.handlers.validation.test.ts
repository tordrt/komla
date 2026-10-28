import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const broadcastWindowA = { webContents: { send: vi.fn() } };
const broadcastWindowB = { webContents: { send: vi.fn() } };

const senderWindow = {
  minimize: vi.fn(),
  isMaximized: vi.fn(() => false),
  isFullScreen: vi.fn(() => false),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
  close: vi.fn(),
};

const electronModuleMock = mockElectron({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [broadcastWindowA, broadcastWindowB]),
    fromWebContents: vi.fn(() => senderWindow),
  } as unknown as ReturnType<typeof vi.fn>,
});

vi.mock('electron', () => electronModuleMock);

const targetWindow = {
  id: 777,
  isDestroyed: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: {
    send: vi.fn(),
    isLoading: vi.fn(() => false),
    once: vi.fn(),
  },
};

const mockWindowService = {
  createWindow: vi.fn(() => ({ windowId: 'window-2' })),
  getAllWindows_info: vi.fn(() => [{ id: 'window-1', displayNumber: 1 }]),
  getWindow: vi.fn(() => targetWindow),
  getWindowId: vi.fn(() => 'window-1'),
  sendWhenReady: vi.fn((windowId: string, channel: string, ...args: unknown[]) => {
    // Simulate immediate delivery for tests (window assumed ready)
    const win = mockWindowService.getWindow(windowId);
    if (win && !win.isDestroyed?.()) {
      win.webContents.send(channel, ...args);
    }
  }),
  markRendererReady: vi.fn(),
  setUnsavedFiles: vi.fn(),
  showWorkspace: vi.fn((windowId: string) => !!mockWindowService.getWindow(windowId)),
  setShownWorkspace: vi.fn(),
};

const mockWorkspaceService = {
  moveWorkspaceToWindow: vi.fn(),
  setPaneSurfaceWorkspaces: vi.fn(),
  get: vi.fn(() => ({
    id: 'ws-1',
    terminals: [{ id: 'term-1' }, { id: 'term-2' }],
  })),
};

const mockCustomizationService = {
  syncTitleBarOverlay: vi.fn(),
};

const mockPtyService = {
  setTerminalWindow: vi.fn(),
};

const mockLocalMirrorService = {
  getSyncStatuses: vi.fn(() => []),
};

vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: mockWindowService,
}));

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));

vi.mock('../../../../src/main/services/customization.service', () => ({
  customizationService: mockCustomizationService,
}));

vi.mock('../../../../src/main/services/pty.service', () => ({
  ptyService: mockPtyService,
}));

vi.mock('../../../../src/main/services/local-mirror.service', () => ({
  localMirrorService: mockLocalMirrorService,
}));

describe('window IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWindowService.getWindow.mockReturnValue(targetWindow);
    targetWindow.webContents.isLoading.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the workspaces a window shows a browser or note pane of, dropping bad ids', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: { mock: { calls: Array<[string, (...args: unknown[]) => void]> } } };
    };

    registerWindowHandlers();
    const listener = ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'workspace:set-pane-surface-workspaces'
    )?.[1];
    const event = { sender: { id: 7 } };

    listener?.(event, [123]);
    expect(mockWorkspaceService.setPaneSurfaceWorkspaces).not.toHaveBeenCalled();

    listener?.(event, ['ws-1']);
    expect(mockWorkspaceService.setPaneSurfaceWorkspaces).toHaveBeenCalledWith('window-1', [
      'ws-1',
    ]);
  });

  it('records the files a window has unsaved edits to, dropping bad lists', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: { mock: { calls: Array<[string, (...args: unknown[]) => void]> } } };
    };

    registerWindowHandlers();
    const listener = ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'window:set-unsaved-files'
    )?.[1];
    const event = { sender: { id: 7 } };

    listener?.(event, [123]);
    listener?.(event, 'app.ts');
    expect(mockWindowService.setUnsavedFiles).not.toHaveBeenCalled();

    listener?.(event, ['app.ts']);
    expect(mockWindowService.setUnsavedFiles).toHaveBeenCalledWith('window-1', ['app.ts']);
  });

  it('records the workspace a window shows, dropping bad ids', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { on: { mock: { calls: Array<[string, (...args: unknown[]) => void]> } } };
    };

    registerWindowHandlers();
    const listener = ipcMain.on.mock.calls.find(
      ([channel]) => channel === 'window:set-shown-workspace'
    )?.[1];
    const event = { sender: { id: 7 } };

    listener?.(event, 123);
    listener?.(event, ['ws-1']);
    expect(mockWindowService.setShownWorkspace).not.toHaveBeenCalled();

    listener?.(event, 'ws-1');
    expect(mockWindowService.setShownWorkspace).toHaveBeenCalledWith('window-1', 'ws-1');
    listener?.(event, null);
    expect(mockWindowService.setShownWorkspace).toHaveBeenLastCalledWith('window-1', null);
  });

  it('rejects invalid workspace ID for workspace:move-to-window', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await expect(
      ipcMain._invoke('workspace:move-to-window', '   ', 'window-1')
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.moveWorkspaceToWindow).not.toHaveBeenCalled();
  });

  it('rejects invalid window ID type for workspace:move-to-window', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await expect(ipcMain._invoke('workspace:move-to-window', 'ws-1', 123)).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.moveWorkspaceToWindow).not.toHaveBeenCalled();
  });

  it('moves workspace and broadcasts window change', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();
    await ipcMain._invoke('workspace:move-to-window', 'ws-1', 'window-2', { activeTabId: 'tab-1' });

    expect(mockWorkspaceService.moveWorkspaceToWindow).toHaveBeenCalledWith('ws-1', 'window-2');
    expect(mockPtyService.setTerminalWindow).toHaveBeenCalledWith('term-1', 777);
    expect(mockPtyService.setTerminalWindow).toHaveBeenCalledWith('term-2', 777);
    expect(broadcastWindowA.webContents.send).toHaveBeenCalledWith(
      'workspace:window-changed',
      'ws-1',
      'window-2'
    );
    expect(broadcastWindowB.webContents.send).toHaveBeenCalledWith(
      'workspace:window-changed',
      'ws-1',
      'window-2'
    );
    expect(targetWindow.webContents.send).toHaveBeenCalledWith('workspace:moved-here', 'ws-1', {
      activeTabId: 'tab-1',
    });
  });

  it('moves workspace safely when target window does not exist', async () => {
    mockWindowService.getWindow.mockReturnValue(null);

    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();
    await expect(
      ipcMain._invoke('workspace:move-to-window', 'ws-1', 'missing-window', undefined)
    ).resolves.toBeUndefined();

    expect(mockWorkspaceService.moveWorkspaceToWindow).toHaveBeenCalledWith(
      'ws-1',
      'missing-window'
    );
    expect(mockPtyService.setTerminalWindow).not.toHaveBeenCalled();
    expect(targetWindow.webContents.send).not.toHaveBeenCalledWith(
      'workspace:moved-here',
      expect.anything(),
      expect.anything()
    );
    expect(broadcastWindowA.webContents.send).toHaveBeenCalledWith(
      'workspace:window-changed',
      'ws-1',
      'missing-window'
    );
    expect(broadcastWindowB.webContents.send).toHaveBeenCalledWith(
      'workspace:window-changed',
      'ws-1',
      'missing-window'
    );
  });

  it('uses sendWhenReady to deliver workspace:moved-here', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();
    await ipcMain._invoke('workspace:move-to-window', 'ws-1', 'window-2', null);

    expect(mockWindowService.sendWhenReady).toHaveBeenCalledWith(
      'window-2',
      'workspace:moved-here',
      'ws-1',
      null
    );
  });

  it('rejects invalid workspace ID for workspace:focus-window', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await expect(ipcMain._invoke('workspace:focus-window', 42)).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(targetWindow.focus).not.toHaveBeenCalled();
  });

  it('focuses the window showing a workspace and selects it there, on a terminal', async () => {
    mockWorkspaceService.get.mockReturnValueOnce({
      id: 'ws-1',
      status: 'active',
      windowId: 'window-2',
      terminals: [],
    });
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await expect(ipcMain._invoke('workspace:focus-window', 'ws-1', 'term-1')).resolves.toBe(true);
    expect(mockWindowService.showWorkspace).toHaveBeenCalledWith('window-2', 'ws-1', 'term-1');
  });

  it.each([
    ['the workspace is unknown', undefined, targetWindow],
    [
      'the workspace shows in every window',
      { id: 'ws-1', status: 'active', windowId: null, terminals: [] },
      targetWindow,
    ],
    [
      'its window is gone',
      { id: 'ws-1', status: 'active', windowId: 'window-2', terminals: [] },
      undefined,
    ],
    // The Trash keeps the window, but the caller's window should restore it.
    [
      'it was trashed in its window',
      { id: 'ws-1', status: 'trashed', windowId: 'window-2', terminals: [] },
      targetWindow,
    ],
  ])('reports false for workspace:focus-window when %s', async (_case, workspace, window) => {
    mockWorkspaceService.get.mockReturnValueOnce(workspace as never);
    mockWindowService.getWindow.mockReturnValue(window as never);
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await expect(ipcMain._invoke('workspace:focus-window', 'ws-1')).resolves.toBe(false);
    expect(targetWindow.focus).not.toHaveBeenCalled();
    expect(mockWindowService.sendWhenReady).not.toHaveBeenCalled();
    if (workspace?.status !== 'active' || !workspace.windowId) {
      expect(mockWindowService.showWorkspace).not.toHaveBeenCalled();
    }
  });

  it('registers create handler and syncs titlebar overlay', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();
    const result = await ipcMain._invoke('window:create');

    expect(result).toBe('window-2');
    expect(mockCustomizationService.syncTitleBarOverlay).toHaveBeenCalled();
  });

  it('replays active local mirror status when the renderer becomes ready', async () => {
    mockLocalMirrorService.getSyncStatuses.mockReturnValueOnce([
      { workspaceId: 'ws-1', state: 'syncing' },
    ]);
    const sender = { id: 123, send: vi.fn() };
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = await import('electron');

    registerWindowHandlers();
    const readyHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'window:renderer-ready')?.[1];
    expect(readyHandler).toBeTypeOf('function');
    readyHandler?.({ sender });

    expect(sender.send).toHaveBeenCalledWith('workspace:local-mirror-sync-status', {
      workspaceId: 'ws-1',
      state: 'syncing',
    });
  });

  it('handles minimize/maximize/close/is-maximized controls', async () => {
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await ipcMain._invoke('window:minimize');
    expect(senderWindow.minimize).toHaveBeenCalled();

    senderWindow.isMaximized.mockReturnValue(false);
    await ipcMain._invoke('window:maximize');
    expect(senderWindow.maximize).toHaveBeenCalled();

    senderWindow.isMaximized.mockReturnValue(true);
    await ipcMain._invoke('window:maximize');
    expect(senderWindow.unmaximize).toHaveBeenCalled();

    await ipcMain._invoke('window:close');
    expect(senderWindow.close).toHaveBeenCalled();

    senderWindow.isMaximized.mockReturnValue(true);
    await expect(ipcMain._invoke('window:is-maximized')).resolves.toBe(true);
  });

  it('returns fullscreen state from sender window', async () => {
    senderWindow.isFullScreen.mockReturnValue(true);
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await expect(ipcMain._invoke('window:is-fullscreen')).resolves.toBe(true);
    expect(senderWindow.isFullScreen).toHaveBeenCalledTimes(1);
  });

  it('safely handles window controls when sender window is null', async () => {
    vi.mocked(electronModuleMock.BrowserWindow.fromWebContents).mockReturnValue(null);
    const { registerWindowHandlers } =
      await import('../../../../src/main/ipc/handlers/window.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWindowHandlers();

    await expect(ipcMain._invoke('window:minimize')).resolves.toBeUndefined();
    await expect(ipcMain._invoke('window:maximize')).resolves.toBeUndefined();
    await expect(ipcMain._invoke('window:close')).resolves.toBeUndefined();
    await expect(ipcMain._invoke('window:is-maximized')).resolves.toBe(false);

    expect(senderWindow.minimize).not.toHaveBeenCalled();
    expect(senderWindow.maximize).not.toHaveBeenCalled();
    expect(senderWindow.unmaximize).not.toHaveBeenCalled();
    expect(senderWindow.close).not.toHaveBeenCalled();
  });
});
