import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const mockList = vi.fn();
const mockRun = vi.fn();
const mockRunButton = vi.fn();
const mockBroadcast = vi.fn();
const mockPageUrl = vi.fn();
const mockRunData = vi.fn();
const mockFind = vi.fn();
const mockExecute = vi.fn();
let panelsChanged: () => void = () => {};
vi.mock('../../../../src/main/services/sidebar-panels.service', () => ({
  sidebarPanelsService: {
    onChange: (listener: () => void) => {
      panelsChanged = listener;
    },
    list: mockList,
    run: mockRun,
    runButton: mockRunButton,
    pageUrl: mockPageUrl,
    runData: mockRunData,
    find: mockFind,
    scope: (_id: string, workspaceId: string | undefined) => workspaceId ?? '',
  },
}));
vi.mock('../../../../src/main/services/komla-operation.service', () => ({
  komlaOperationService: { execute: mockExecute },
}));
const mockReleaseKeys = vi.fn();
vi.mock('../../../../src/main/services/html-preview.service', () => ({
  htmlPreviewService: { releaseKeys: mockReleaseKeys },
}));
const mockSendPanelMessage = vi.fn();
const mockHosts = vi.fn(() => false);
const mockPanelOpened = vi.fn();
vi.mock('../../../../src/main/services/plugin-host', () => ({
  pluginHostService: {
    sendPanelMessage: mockSendPanelMessage,
    hosts: mockHosts,
    panelOpened: mockPanelOpened,
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

    await (
      await handler('sidebar-panels:run')
    )({ sender: { id: 7 } }, 'ws-1', 'ci', theme);
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

  it("serves a panel's page for the window and runs its data", async () => {
    let closed: () => void = () => {};
    let destroyed = false;
    const window7 = {
      id: 7,
      once: (_event: string, listener: () => void) => (closed = listener),
      isDestroyed: () => destroyed,
    };
    mockPageUrl.mockResolvedValue({ url: 'komla-preview://t/index.html' });
    mockRunData.mockResolvedValue({ data: { count: 1 } });

    await expect(
      (await handler('sidebar-panels:page'))({ sender: window7 }, 'ws-1', 'board')
    ).resolves.toEqual({ url: 'komla-preview://t/index.html' });
    expect(mockPageUrl).toHaveBeenCalledWith('ws-1', 'board', undefined, '7');
    await expect((await handler('sidebar-panels:data'))({}, 'ws-1', 'board')).resolves.toEqual({
      data: { count: 1 },
    });
    // Its pages stop being served once its window closes, or as soon as it's made if the window
    // closed while it was being made.
    closed();
    expect(mockReleaseKeys).toHaveBeenCalledWith('sidebar-panel-page:7:');
    mockReleaseKeys.mockClear();
    destroyed = true;
    await expect(
      (await handler('sidebar-panels:page'))({ sender: window7 }, 'ws-1', 'board')
    ).resolves.toEqual({});
    expect(mockReleaseKeys).toHaveBeenCalledWith('sidebar-panel-page:7:');
  });

  it("runs a page's operation, asking in its window before a risky one", async () => {
    mockFind.mockReturnValue({
      title: 'Board',
      page: 'panels/board',
      capabilities: ['agent.launch.tab'],
    });
    mockExecute.mockResolvedValue({ launched: true });
    electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    const run = await handler('sidebar-panels:operation');

    await expect(
      run(
        { sender: { id: 7 } },
        'ws-1',
        'board',
        { type: 'agent.launch', destination: 'tab', prompt: 'Fix it' },
        { activated: true }
      )
    ).resolves.toEqual({ ok: true, result: { launched: true } });
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Let the sidebar panel “Board” from sidebar-panels.json launch an agent in a new tab?',
        detail: 'destination: tab\nprompt: Fix it',
      })
    );
    expect(mockExecute).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', userConfirmed: true },
      expect.objectContaining({ type: 'agent.launch' })
    );
  });

  it.each([
    ['sidebar-panels:page', ['ws-1']],
    ['sidebar-panels:data', ['ws-1', 'bad id']],
    ['sidebar-panels:operation', ['ws-1', 'board', 'workspace.list', { activated: false }]],
    ['sidebar-panels:operation', ['ws-1', 'board', { type: 'tag.list' }]],
    ['sidebar-panels:operation', ['ws-1', 'board', { type: 'tag.list' }, { activated: 'yes' }]],
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
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
