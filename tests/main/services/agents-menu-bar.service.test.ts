import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTerminal, createWorkspace } from '../../factories';

import type { Workspace, WorkspaceAttention } from '../../../src/shared/types';

type Listener = (...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  function emitter() {
    const handlers = new Map<string, Listener>();
    return {
      handlers,
      on: (event: string, handler: Listener) => void handlers.set(event, handler),
      emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    };
  }

  const trays: Tray[] = [];
  class Tray {
    events = emitter();
    on = this.events.on;
    setImage = vi.fn();
    setToolTip = vi.fn();
    popUpContextMenu = vi.fn();
    destroy = vi.fn();
    getBounds = vi.fn(() => ({ x: 900, y: 0, width: 60, height: 24 }));
    constructor() {
      trays.push(this);
    }
    isDestroyed() {
      return this.destroy.mock.calls.length > 0;
    }
  }

  const windows: BrowserWindow[] = [];
  const focus = { window: null as { webContents: { id: number } } | null };
  const appEvents = emitter();
  class BrowserWindow {
    static getFocusedWindow = () => focus.window;
    events = emitter();
    on = this.events.on;
    visible = false;
    destroyed = false;
    webContents = {
      id: 500 + windows.length,
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    };
    setBounds = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    show = vi.fn(() => {
      this.visible = true;
    });
    focus = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    constructor(public options: Record<string, unknown>) {
      windows.push(this);
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
  }

  const image = {
    addRepresentation: vi.fn(),
    setTemplateImage: vi.fn(),
    isEmpty: vi.fn(() => false),
  };
  const nativeTheme = { ...emitter(), shouldUseDarkColors: false };
  return {
    trays,
    windows,
    image,
    focus,
    appEvents,
    nativeTheme,
    module: {
      app: { on: appEvents.on },
      Tray,
      BrowserWindow,
      Menu: { buildFromTemplate: vi.fn((template: unknown[]) => ({ template })) },
      nativeTheme,
      nativeImage: {
        createEmpty: vi.fn(() => image),
        // Each image names its bytes, to tell which one shows.
        createFromBuffer: vi.fn((buffer: Buffer) => ({
          frame: buffer.toString('base64'),
          isEmpty: () => false,
        })),
      },
      screen: {
        getDisplayNearestPoint: vi.fn(() => ({
          workArea: { x: 0, y: 24, width: 1440, height: 876 },
        })),
        getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
      },
    },
  };
});

vi.mock('electron', () => electron.module);
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  showWorkspace: vi.fn((_windowId: string, _workspaceId: string, _terminalId?: string) => true),
  getMainWindowId: vi.fn(() => 'main-window'),
  sendToWindowOrNext: vi.fn(),
}));

vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    showWorkspace: mocks.showWorkspace,
    getMainWindowId: mocks.getMainWindowId,
    sendToWindowOrNext: mocks.sendToWindowOrNext,
  },
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function attention(kind: WorkspaceAttention['kind']): WorkspaceAttention {
  return { kind, source: 'claude-code', updatedAt: 1 };
}

describe('countAgents', () => {
  it("counts every window's agents by state, most urgent first", async () => {
    const { countAgents, summarizeCounts } =
      await import('../../../src/main/services/agents-menu-bar.service');
    const workspaces = [
      createWorkspace({
        windowId: 'window-1',
        agentActive: true,
        terminals: [
          createTerminal({ status: 'running', agentActive: true }),
          createTerminal({ status: 'running', agentActive: true }),
        ],
      }),
      createWorkspace({
        windowId: 'window-2',
        terminals: [
          createTerminal({ status: 'running', attention: attention('input-required') }),
          createTerminal({ status: 'running', attention: attention('turn-complete') }),
          createTerminal({ status: 'running' }),
        ],
      }),
      // Trashed workspaces run no agents the user can reach.
      createWorkspace({ status: 'trashed', attention: attention('error') }),
    ] as Workspace[];

    const counts = countAgents(workspaces);

    expect(counts).toEqual([
      { state: 'input', count: 1 },
      { state: 'done', count: 1 },
      { state: 'working', count: 2 },
    ]);
    expect(summarizeCounts(counts)).toBe('1 needs input, 1 done, 2 working');
    // Clearing the overview's finished agents leaves those out, until another finishes.
    expect(countAgents(workspaces, 1)).toEqual([
      { state: 'input', count: 1 },
      { state: 'working', count: 2 },
    ]);
  });
});

describe('agentsMenuBarService', () => {
  const waiting = createWorkspace({
    name: 'waiting',
    windowId: 'window-2',
    terminals: [
      createTerminal({ id: 'codex', status: 'running', attention: attention('input-required') }),
    ],
  });
  let workspaces: Workspace[];
  const deps = {
    listWorkspaces: () => workspaces,
    getWorkspace: (workspaceId: string) => workspaces.find(({ id }) => id === workspaceId),
    listProjects: () => [{ id: 'project-1', name: 'komla' }],
    onTerminalStatus: vi.fn(() => () => {}),
    openWindow: vi.fn(() => 'new-window'),
    moveToWindow: vi.fn(),
    updateConfig: vi.fn(),
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    electron.trays.length = 0;
    electron.windows.length = 0;
    electron.focus.window = null;
    electron.nativeTheme.handlers.clear();
    electron.nativeTheme.shouldUseDarkColors = false;
    workspaces = [waiting as Workspace];
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  async function startService() {
    const { agentsMenuBarService } =
      await import('../../../src/main/services/agents-menu-bar.service');
    agentsMenuBarService.init(deps);
    agentsMenuBarService.setEnabled(true);
    return agentsMenuBarService;
  }

  it('shows only on macOS', async () => {
    setPlatform('linux');
    await startService();

    expect(electron.trays).toHaveLength(0);
  });

  const input = [{ state: 'input' as const, count: 1 }];
  const png = (bytes: string) => `data:image/png;base64,${bytes}`;
  const shown = () => electron.trays[0].setImage.mock.calls.map(([image]) => image.frame);

  it("asks Komla's main window, or the next one to open, to draw the counts, and shows what it drew", async () => {
    const service = await startService();

    expect(mocks.sendToWindowOrNext).toHaveBeenCalledWith(null, 'agents-menu-bar:draw', {
      counts: input,
      dark: false,
    });
    expect(electron.trays[0].setToolTip).toHaveBeenCalledWith('Komla agents: 1 needs input');
    electron.trays[0].setImage.mockClear();

    service.setImage({ counts: input, dataUrl: png('AAAA'), width: 30, height: 18 });

    expect(electron.module.nativeImage.createFromBuffer).toHaveBeenCalledWith(
      Buffer.from('AAAA', 'base64'),
      { scaleFactor: 2, width: 60, height: 36 }
    );
    expect(shown()).toEqual(['AAAA']);
  });

  it('ignores an image for counts that have changed since, or that is no PNG', async () => {
    const service = await startService();
    electron.trays[0].setImage.mockClear();

    service.setImage({
      counts: [{ state: 'done', count: 2 }],
      dataUrl: png('AAAA'),
      width: 30,
      height: 18,
    });
    service.setImage({
      counts: input,
      dataUrl: 'data:image/svg+xml;base64,AAAA',
      width: 30,
      height: 18,
    });

    expect(electron.trays[0].setImage).not.toHaveBeenCalled();
  });

  it('shows only while no Komla window is in front, when asked, with the image it last drew', async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const service = await startService();
    service.setImage({ counts: input, dataUrl: png('AAAA'), width: 30, height: 18 });
    electron.focus.window = { webContents: { id: 1 } };
    service.setInBackgroundOnly(true);
    expect(electron.trays[0].destroy).toHaveBeenCalled();

    mocks.sendToWindowOrNext.mockClear();
    electron.focus.window = null;
    electron.appEvents.emit('browser-window-blur');
    vi.advanceTimersByTime(100);

    expect(electron.trays).toHaveLength(2);
    expect(electron.trays[1].setImage.mock.calls.map(([image]) => image.frame)).toEqual(['AAAA']);
    expect(mocks.sendToWindowOrNext).not.toHaveBeenCalled();
  });

  it("stays away as Komla quits, though hiding Komla's windows blurs them", async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const service = await startService();
    service.setInBackgroundOnly(true);

    service.stop();
    electron.appEvents.emit('browser-window-blur');
    vi.advanceTimersByTime(100);

    expect(electron.trays).toHaveLength(1);
    expect(electron.trays[0].destroy).toHaveBeenCalled();
  });

  it("redraws in a new theme's colors", async () => {
    const service = await startService();
    service.setTheme({ className: 'dark', style: '' });
    mocks.sendToWindowOrNext.mockClear();

    service.setTheme({ className: 'dark', style: '' });
    expect(mocks.sendToWindowOrNext).not.toHaveBeenCalled();

    service.setTheme({ className: 'light', style: '' });
    expect(mocks.sendToWindowOrNext).toHaveBeenCalledWith(null, 'agents-menu-bar:draw', {
      counts: input,
      dark: false,
    });
  });

  it("redraws for a dark menu bar when macOS's appearance changes", async () => {
    await startService();
    mocks.sendToWindowOrNext.mockClear();

    electron.nativeTheme.shouldUseDarkColors = true;
    electron.nativeTheme.emit('updated');

    expect(mocks.sendToWindowOrNext).toHaveBeenCalledWith(null, 'agents-menu-bar:draw', {
      counts: input,
      dark: true,
    });
  });

  it("offers the item's settings on a right-click", async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const service = await startService();
    service.setInBackgroundOnly(true);
    vi.advanceTimersByTime(100);

    electron.trays[0].events.emit('right-click');

    expect(electron.windows).toHaveLength(0);
    const [[menu]] = electron.trays[0].popUpContextMenu.mock.calls as [
      [{ template: Array<{ label: string; checked: boolean; click: () => void }> }],
    ];
    expect(menu.template.map(({ label, checked }) => [label, checked])).toEqual([
      ['Show in Menu Bar', true],
      ['Only While Komla Is in the Background', true],
    ]);
    menu.template[1].click();
    expect(deps.updateConfig).toHaveBeenLastCalledWith({ agentsMenuBarInBackgroundOnly: false });
    menu.template[0].click();
    expect(deps.updateConfig).toHaveBeenLastCalledWith({ showAgentsInMenuBar: false });
  });

  it('opens the popover under the item, on every Space, once its page has drawn, with the theme', async () => {
    const service = await startService();
    service.setTheme({ className: 'dark', style: '--background: 0 0 0' });

    electron.trays[0].events.emit('click');
    const [popover] = electron.windows;
    expect(popover.options).toMatchObject({ show: false, frame: false, transparent: true });
    expect(popover.visible).toBe(false);
    // Without skipping it, Electron would hide Komla's Dock icon each time.
    expect(popover.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });

    // Its page asks, once it listens.
    service.sendState();
    expect(popover.webContents.send).toHaveBeenCalledWith('agents-menu-bar:state', {
      workspaces: [waiting],
      projects: [{ id: 'project-1', name: 'komla' }],
      theme: { className: 'dark', style: '--background: 0 0 0' },
    });

    expect(service.isPopover(popover.webContents.id)).toBe(true);
    service.resizePopover(400, 200);
    expect(popover.setBounds).toHaveBeenLastCalledWith({
      x: 888,
      y: 24,
      width: 424,
      height: 224,
    });
    expect(popover.visible).toBe(true);

    // A row's card beside the panel widens the window to the left; the panel stays put.
    service.resizePopover(730, 300);
    expect(popover.setBounds).toHaveBeenLastCalledWith({
      x: 558,
      y: 24,
      width: 754,
      height: 324,
    });
  });

  it("opens an agent's pane in the window that shows it, and closes the popover", async () => {
    const service = await startService();
    electron.trays[0].events.emit('click');

    service.open(waiting.id, 'codex');

    expect(mocks.showWorkspace).toHaveBeenCalledWith('window-2', waiting.id, 'codex');
    expect(electron.windows[0].destroy).toHaveBeenCalled();
  });

  it('moves the workspace to the main window when its own is gone', async () => {
    mocks.showWorkspace.mockImplementation((windowId) => windowId === 'main-window');
    const service = await startService();

    service.open(waiting.id, undefined);

    expect(deps.moveToWindow).toHaveBeenCalledWith(waiting.id, 'main-window');
    expect(mocks.showWorkspace.mock.calls).toEqual([
      ['window-2', waiting.id, undefined],
      ['main-window', waiting.id, undefined],
    ]);
  });

  it('opens a window for a workspace when none is open', async () => {
    mocks.showWorkspace.mockImplementation((windowId) => windowId === 'new-window');
    mocks.getMainWindowId.mockReturnValueOnce(null as unknown as string);
    const service = await startService();

    service.open(waiting.id, 'codex');

    expect(deps.openWindow).toHaveBeenCalledOnce();
    expect(deps.moveToWindow).toHaveBeenCalledWith(waiting.id, 'new-window');
    expect(mocks.showWorkspace).toHaveBeenLastCalledWith('new-window', waiting.id, 'codex');
  });

  it('closes on a click away, and the click on the item that blurred it keeps it closed', async () => {
    const service = await startService();
    electron.trays[0].events.emit('click');
    const [popover] = electron.windows;

    popover.events.emit('blur');
    electron.trays[0].events.emit('click');

    expect(popover.destroy).toHaveBeenCalled();
    expect(electron.windows).toHaveLength(1);
    expect(service.isPopover(popover.webContents.id)).toBe(false);
  });

  it('shows only while it has agents to count', async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const terminalStatus: Array<() => void> = [];
    deps.onTerminalStatus.mockImplementationOnce((listener: () => void) => {
      terminalStatus.push(listener);
      return () => {};
    });
    workspaces = [];
    await startService();
    expect(electron.trays).toHaveLength(0);

    workspaces = [waiting as Workspace];
    terminalStatus.forEach((listener) => listener());
    vi.advanceTimersByTime(250);
    expect(electron.trays).toHaveLength(1);

    workspaces = [];
    terminalStatus.forEach((listener) => listener());
    vi.advanceTimersByTime(250);
    expect(electron.trays[0].destroy).toHaveBeenCalled();
  });

  it('keeps the item while its popover is open, and removes it once closed', async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const terminalStatus: Array<() => void> = [];
    deps.onTerminalStatus.mockImplementationOnce((listener: () => void) => {
      terminalStatus.push(listener);
      return () => {};
    });
    await startService();
    electron.trays[0].events.emit('click');
    const [popover] = electron.windows;

    workspaces = [];
    terminalStatus.forEach((listener) => listener());
    vi.advanceTimersByTime(250);
    expect(electron.trays[0].destroy).not.toHaveBeenCalled();
    expect(popover.destroy).not.toHaveBeenCalled();

    popover.events.emit('blur');
    vi.advanceTimersByTime(250);
    expect(electron.trays[0].destroy).toHaveBeenCalled();
  });

  it('removes the item and its popover when turned off', async () => {
    const service = await startService();
    electron.trays[0].events.emit('click');

    service.setEnabled(false);

    expect(electron.trays[0].destroy).toHaveBeenCalled();
    expect(electron.windows[0].destroy).toHaveBeenCalled();
  });
});
