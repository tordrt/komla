import { join } from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createMockBrowserWindow } from '../../mocks/electron';

type AnyFn = (...args: any[]) => any;

interface WindowDouble {
  window: ReturnType<typeof createMockBrowserWindow> & {
    loadFile: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    setTitleBarOverlay: ReturnType<typeof vi.fn>;
  };
  emitWindow: (event: string, ...args: unknown[]) => void;
  emitWebContents: (event: string, ...args: unknown[]) => void;
  hasWindowListener: (event: string) => boolean;
  getWindowOpenHandler: () => AnyFn | undefined;
}

const createdWindows: WindowDouble[] = [];
let windowCounter = 0;
const mainFrameNavigation = { isMainFrame: true, isSameDocument: false };
const originalPlatform = process.platform;
const originalResourcesPath = process.resourcesPath;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function setResourcesPath(resourcesPath: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesPath,
    configurable: true,
  });
}

function createWindowDouble(): WindowDouble {
  windowCounter += 1;
  const windowListeners = new Map<string, AnyFn[]>();
  const wcListeners = new Map<string, AnyFn[]>();
  let windowOpenHandler: AnyFn | undefined;

  const win = createMockBrowserWindow({
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 100 + windowCounter,
      send: vi.fn(),
      on: vi.fn((event: string, cb: AnyFn) => {
        const existing = wcListeners.get(event) || [];
        wcListeners.set(event, [...existing, cb]);
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setZoomLevel: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
    },
  }) as WindowDouble['window'];

  win.on = vi.fn((event: string, cb: AnyFn) => {
    const existing = windowListeners.get(event) || [];
    windowListeners.set(event, [...existing, cb]);
    return win;
  });
  win.loadFile = vi.fn(() => Promise.resolve());
  win.loadURL = vi.fn(() => Promise.resolve());
  win.setTitleBarOverlay = vi.fn();
  (
    win.webContents as WindowDouble['window']['webContents'] & {
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
    }
  ).setWindowOpenHandler = vi.fn((handler: AnyFn) => {
    windowOpenHandler = handler;
  });

  return {
    window: win,
    emitWindow(event: string, ...args: unknown[]) {
      for (const cb of windowListeners.get(event) || []) cb(...args);
    },
    emitWebContents(event: string, ...args: unknown[]) {
      for (const cb of wcListeners.get(event) || []) cb(...args);
    },
    hasWindowListener(event: string) {
      return (windowListeners.get(event) || []).length > 0;
    },
    getWindowOpenHandler() {
      return windowOpenHandler;
    },
  };
}

const browserWindowCtor = vi.fn(function BrowserWindowMock() {
  const double = createWindowDouble();
  createdWindows.push(double);
  return double.window;
});

const shellOpenExternal = vi.fn(() => Promise.resolve());
const showMessageBoxSync = vi.fn(() => 1);
let paneCloseShortcut = 'Cmd+W';

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
}));

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: vi.fn(() => `window-${createdWindows.length + 1}`),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') },
  BrowserWindow: browserWindowCtor,
  dialog: { showMessageBoxSync },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: shellOpenExternal },
}));

vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => ({ zoomLevel: 0 })),
    set: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/shortcuts.service', () => ({
  shortcutsService: {
    getShortcut: vi.fn((action: string) =>
      action === 'pane.close' ? paneCloseShortcut : undefined
    ),
  },
}));

const reportError = vi.fn();
vi.mock('../../../src/main/services/error-reporting.service', () => ({
  errorReportingService: { report: reportError },
}));

const writePty = vi.fn();
vi.mock('../../../src/main/services/pty.service', () => ({
  ptyService: { write: writePty },
}));

describe('WindowService', () => {
  beforeEach(() => {
    createdWindows.length = 0;
    windowCounter = 0;
    vi.clearAllMocks();
    vi.resetModules();
    paneCloseShortcut = 'Cmd+W';
    setPlatform(originalPlatform);
    setResourcesPath('/mock/resources');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    setResourcesPath(originalResourcesPath);
  });

  it('creates BrowserWindow with renderer sandbox enabled', async () => {
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();

    const constructorArgs = browserWindowCtor.mock.calls[0]?.[0];
    expect(constructorArgs.webPreferences.preload).toContain(join('/', 'preload', 'index.cjs'));
    expect(constructorArgs.webPreferences.sandbox).toBe(true);
    expect(constructorArgs.webPreferences.contextIsolation).toBe(true);
    expect(constructorArgs.webPreferences.nodeIntegration).toBe(false);
    expect(constructorArgs.webPreferences.plugins).toBe(true);
  });

  it('persists the state of one window at a time, passing the name on once it closes', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { windowService } = await import('../../../src/main/services/window.service');
    vi.unstubAllEnvs();

    windowService.createWindow();
    windowService.createWindow();
    createdWindows[0].emitWindow('closed');
    windowService.createWindow();

    const options = browserWindowCtor.mock.calls.map((call) => call[0]);
    expect(options[0]).toMatchObject({ name: 'main', windowStatePersistence: true });
    expect(options[1].name).toBeUndefined();
    expect(options[1].windowStatePersistence).toBeUndefined();
    expect(options[2]).toMatchObject({ name: 'main', windowStatePersistence: true });
  });

  it('persists no window state in test runs, which share one Electron profile', async () => {
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();

    const options = browserWindowCtor.mock.calls[0]?.[0];
    expect(options.name).toBeUndefined();
    expect(options.windowStatePersistence).toBeUndefined();
  });

  it('registers window open handler that denies popup and opens external URL', async () => {
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const windowOpenHandler = createdWindows[0]?.getWindowOpenHandler();

    const result = windowOpenHandler?.({ url: 'https://komla.dev' });

    expect(shellOpenExternal).toHaveBeenCalledWith('https://komla.dev');
    expect(result).toEqual({ action: 'deny' });
  });

  it('handles ready-to-show and pane-close shortcut side effects', async () => {
    setPlatform('darwin');
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];

    firstWindow.emitWindow('ready-to-show');
    expect(firstWindow.window.show).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    firstWindow.emitWebContents(
      'before-input-event',
      { preventDefault },
      {
        meta: true,
        control: false,
        key: 'w',
        alt: false,
        shift: false,
        type: 'keyDown',
      }
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(firstWindow.window.webContents.send).toHaveBeenCalledWith('shortcut:pane-close');
  });

  it('does not intercept Ctrl+W when pane close is remapped on Windows/Linux', async () => {
    setPlatform('linux');
    paneCloseShortcut = 'Cmd+Alt+W';
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];

    const preventDefault = vi.fn();
    firstWindow.emitWebContents(
      'before-input-event',
      { preventDefault },
      {
        meta: false,
        control: true,
        key: 'w',
        alt: false,
        shift: false,
        type: 'keyDown',
      }
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(firstWindow.window.webContents.send).not.toHaveBeenCalledWith('shortcut:pane-close');
  });

  it('intercepts the configured pane-close shortcut on Windows/Linux', async () => {
    setPlatform('linux');
    paneCloseShortcut = 'Cmd+Alt+W';
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];

    const preventDefault = vi.fn();
    firstWindow.emitWebContents(
      'before-input-event',
      { preventDefault },
      {
        meta: false,
        control: true,
        key: 'w',
        alt: true,
        shift: false,
        type: 'keyDown',
      }
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(firstWindow.window.webContents.send).toHaveBeenCalledWith('shortcut:pane-close');
  });

  it('forwards macOS Ctrl+R to the focused terminal', async () => {
    setPlatform('darwin');
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];
    windowService.setTerminalFocus(firstWindow.window.webContents.id, 'terminal-1', true);

    const preventDefault = vi.fn();
    firstWindow.emitWebContents(
      'before-input-event',
      { preventDefault },
      {
        meta: false,
        control: true,
        key: 'r',
        alt: false,
        shift: false,
        type: 'keyDown',
      }
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith('terminal-1', '\x12');
  });

  it('does not intercept macOS Ctrl+R when a terminal is not focused', async () => {
    setPlatform('darwin');
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];

    const preventDefault = vi.fn();
    firstWindow.emitWebContents(
      'before-input-event',
      { preventDefault },
      {
        meta: false,
        control: true,
        key: 'r',
        alt: false,
        shift: false,
        type: 'keyDown',
      }
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(writePty).not.toHaveBeenCalled();
  });

  it('only clears terminal focus for the terminal that lost it', async () => {
    setPlatform('darwin');
    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];
    const webContentsId = firstWindow.window.webContents.id;
    windowService.setTerminalFocus(webContentsId, 'terminal-1', true);
    windowService.setTerminalFocus(webContentsId, 'terminal-2', true);
    windowService.setTerminalFocus(webContentsId, 'terminal-1', false);

    firstWindow.emitWebContents(
      'before-input-event',
      { preventDefault: vi.fn() },
      {
        meta: false,
        control: true,
        key: 'r',
        alt: false,
        shift: false,
        type: 'keyDown',
      }
    );

    expect(writePty).toHaveBeenCalledWith('terminal-2', '\x12');
  });

  it('uses the macOS traffic-light position offset', async () => {
    setPlatform('darwin');

    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();

    expect(browserWindowCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        trafficLightPosition: { x: 15, y: 12 },
      })
    );
  });

  it('broadcasts fullscreen state changes on macOS', async () => {
    setPlatform('darwin');

    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];

    firstWindow.emitWindow('enter-full-screen');
    expect(firstWindow.window.webContents.send).toHaveBeenCalledWith(
      'window:fullscreen-change',
      true
    );

    firstWindow.emitWindow('leave-full-screen');
    expect(firstWindow.window.webContents.send).toHaveBeenCalledWith(
      'window:fullscreen-change',
      false
    );
  });

  it('broadcasts fullscreen state changes on Linux', async () => {
    setPlatform('linux');

    const { windowService } = await import('../../../src/main/services/window.service');

    windowService.createWindow();
    const firstWindow = createdWindows[0];

    expect(firstWindow.hasWindowListener('enter-full-screen')).toBe(true);
    expect(firstWindow.hasWindowListener('leave-full-screen')).toBe(true);

    firstWindow.emitWindow('enter-full-screen');
    expect(firstWindow.window.webContents.send).toHaveBeenCalledWith(
      'window:fullscreen-change',
      true
    );

    firstWindow.emitWindow('leave-full-screen');
    expect(firstWindow.window.webContents.send).toHaveBeenCalledWith(
      'window:fullscreen-change',
      false
    );
  });

  it('tracks window IDs and re-elects main window when original is removed', async () => {
    const { windowService } = await import('../../../src/main/services/window.service');

    const first = windowService.createWindow();
    const second = windowService.createWindow();

    expect(windowService.getMainWindowId()).toBe(first.windowId);
    expect(windowService.getWindowId(createdWindows[0].window.webContents.id)).toBe(first.windowId);

    createdWindows[0].emitWindow('closed');
    expect(windowService.getMainWindowId()).toBe(second.windowId);
  });

  it('cleans up on close and calls orphan reassignment callback', async () => {
    const { windowService } = await import('../../../src/main/services/window.service');

    const first = windowService.createWindow();
    windowService.createWindow();

    const onClosed = vi.fn();
    windowService.onWindowClosed = onClosed;

    createdWindows[0].emitWindow('closed');

    expect(onClosed).toHaveBeenCalledWith(first.windowId);
    expect(windowService.getAllWindowIds()).toEqual(['window-2']);
  });

  it('does not access a BrowserWindow after Electron destroys it on close', async () => {
    const { windowService } = await import('../../../src/main/services/window.service');
    const first = windowService.createWindow();
    windowService.createWindow();
    const destroyedWindow = createdWindows[0];
    Object.defineProperty(destroyedWindow.window, 'webContents', {
      configurable: true,
      get: () => {
        throw new TypeError('Object has been destroyed');
      },
    });

    expect(() => destroyedWindow.emitWindow('closed')).not.toThrow();
    expect(windowService.getAllWindowIds()).not.toContain(first.windowId);
  });

  describe('unsaved files', () => {
    const DISCARD = 0;
    const CANCEL = 1;

    function close(double: WindowDouble): { preventDefault: ReturnType<typeof vi.fn> } {
      const event = { preventDefault: vi.fn() };
      double.emitWindow('close', event);
      return event;
    }

    it('asks before a window with unsaved edits closes, and keeps it open on Cancel', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      windowService.setUnsavedFiles(windowId, ['app.ts']);

      showMessageBoxSync.mockReturnValueOnce(CANCEL);
      expect(close(createdWindows[0]).preventDefault).toHaveBeenCalled();
      expect(showMessageBoxSync).toHaveBeenCalledWith(
        createdWindows[0].window,
        expect.objectContaining({ message: 'app.ts has unsaved changes. Discard them?' })
      );

      showMessageBoxSync.mockReturnValueOnce(DISCARD);
      expect(close(createdWindows[0]).preventDefault).not.toHaveBeenCalled();
    });

    it('closes a window without unsaved edits without asking', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      windowService.setUnsavedFiles(windowId, ['app.ts']);
      windowService.setUnsavedFiles(windowId, []);

      expect(close(createdWindows[0]).preventDefault).not.toHaveBeenCalled();
      expect(showMessageBoxSync).not.toHaveBeenCalled();
    });

    it('asks once before quitting with unsaved edits in any window', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const first = windowService.createWindow();
      const second = windowService.createWindow();
      windowService.setUnsavedFiles(first.windowId, ['app.ts']);
      windowService.setUnsavedFiles(second.windowId, ['README.md']);

      showMessageBoxSync.mockReturnValueOnce(CANCEL);
      expect(windowService.confirmQuit()).toBe(false);
      expect(showMessageBoxSync).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'app.ts, README.md have unsaved changes. Discard them?',
        })
      );

      showMessageBoxSync.mockReturnValueOnce(DISCARD);
      expect(windowService.confirmQuit()).toBe(true);
      // The windows then close without asking again.
      showMessageBoxSync.mockClear();
      expect(close(createdWindows[0]).preventDefault).not.toHaveBeenCalled();
      expect(showMessageBoxSync).not.toHaveBeenCalled();
    });

    it('quits without asking when nothing is unsaved', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      windowService.setUnsavedFiles(windowId, ['app.ts']);
      createdWindows[0].emitWindow('closed');

      expect(windowService.confirmQuit()).toBe(true);
      expect(showMessageBoxSync).not.toHaveBeenCalled();
    });

    it('forgets the unsaved files of a reloaded renderer', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      windowService.setUnsavedFiles(windowId, ['app.ts']);
      createdWindows[0].emitWebContents('did-start-navigation', mainFrameNavigation);

      expect(windowService.confirmQuit()).toBe(true);
      expect(showMessageBoxSync).not.toHaveBeenCalled();
    });
  });

  describe('showWorkspace', () => {
    it('brings the window forward and selects the workspace there, on a terminal', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const { window } = createdWindows[0];
      windowService.markRendererReady(windowId);
      window.isMinimized = vi.fn(() => true);
      (window.webContents.send as ReturnType<typeof vi.fn>).mockClear();

      expect(windowService.showWorkspace(windowId, 'ws-1', 'term-1')).toBe(true);

      expect(window.restore).toHaveBeenCalled();
      expect(window.show).toHaveBeenCalled();
      expect(window.focus).toHaveBeenCalled();
      expect(window.webContents.send).toHaveBeenCalledWith('workspace:select', 'ws-1', 'term-1');
    });

    it('reports false when the window is gone', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');

      expect(windowService.showWorkspace('missing', 'ws-1')).toBe(false);
    });
  });

  describe('shown workspaces', () => {
    it('counts a workspace off screen only while every window shows another one', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const first = windowService.createWindow();
      const second = windowService.createWindow();
      expect(windowService.isWorkspaceOffScreen('ws-1')).toBe(false);

      windowService.setShownWorkspace(first.windowId, 'ws-2');
      windowService.setShownWorkspace(second.windowId, 'ws-2');
      expect(windowService.isWorkspaceOffScreen('ws-1')).toBe(true);
      expect(windowService.isWorkspaceOffScreen('ws-2')).toBe(false);

      // The overview shows every workspace.
      windowService.setShownWorkspace(second.windowId, null);
      expect(windowService.isWorkspaceOffScreen('ws-1')).toBe(false);

      windowService.setShownWorkspace(second.windowId, 'ws-1');
      expect(windowService.isWorkspaceOffScreen('ws-1')).toBe(false);
      expect(windowService.isWorkspaceOffScreen('ws-3')).toBe(true);
    });

    it("treats a window that hasn't reported yet as showing every workspace", async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const first = windowService.createWindow();
      windowService.createWindow();
      windowService.setShownWorkspace(first.windowId, 'ws-2');

      // E.g. a window a workspace was just moved to.
      expect(windowService.isWorkspaceOffScreen('ws-1')).toBe(false);
    });

    it('ignores what hidden and minimized windows show', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const first = windowService.createWindow();
      const second = windowService.createWindow();
      windowService.setShownWorkspace(first.windowId, 'ws-1');
      windowService.setShownWorkspace(second.windowId, 'ws-2');

      createdWindows[1].window.isMinimized.mockReturnValue(true);
      expect(windowService.isWorkspaceOffScreen('ws-2')).toBe(true);

      createdWindows[1].window.isMinimized.mockReturnValue(false);
      createdWindows[1].window.isVisible.mockReturnValue(false);
      expect(windowService.isWorkspaceOffScreen('ws-2')).toBe(true);
      expect(windowService.isWorkspaceOffScreen('ws-1')).toBe(false);
    });

    it('says which workspace a window started showing', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const onShown = vi.fn();
      windowService.onWorkspaceShown = onShown;

      windowService.setShownWorkspace(windowId, 'ws-1');
      windowService.setShownWorkspace(windowId, 'ws-1');
      windowService.setShownWorkspace(windowId, null);

      expect(onShown.mock.calls).toEqual([['ws-1'], [null]]);
    });

    it('forgets what a closed or reloaded window showed, but not on an iframe load', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const first = windowService.createWindow();
      const second = windowService.createWindow();
      windowService.setShownWorkspace(first.windowId, 'ws-1');
      windowService.setShownWorkspace(second.windowId, 'ws-2');

      createdWindows[1].emitWindow('closed');
      expect(windowService.isWorkspaceOffScreen('ws-2')).toBe(true);

      // Iframes (status item popovers, browser previews) start loading in the same window.
      createdWindows[0].emitWebContents('did-start-loading');
      createdWindows[0].emitWebContents('did-start-navigation', {
        isMainFrame: false,
        isSameDocument: false,
      });
      createdWindows[0].emitWebContents('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: true,
      });
      expect(windowService.isWorkspaceOffScreen('ws-2')).toBe(true);

      createdWindows[0].emitWebContents('did-start-navigation', mainFrameNavigation);
      expect(windowService.isWorkspaceOffScreen('ws-2')).toBe(false);
    });
  });

  describe('sendWhenReady / markRendererReady', () => {
    it('queues messages before renderer is ready and flushes on markRendererReady', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;
      (wc.send as ReturnType<typeof vi.fn>).mockClear();

      windowService.sendWhenReady(windowId, 'test:channel', 'arg1', 'arg2');
      expect(wc.send).not.toHaveBeenCalled();

      windowService.markRendererReady(windowId);
      expect(wc.send).toHaveBeenCalledWith('test:channel', 'arg1', 'arg2');
    });

    it('sends immediately when renderer is already ready', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;

      windowService.markRendererReady(windowId);
      (wc.send as ReturnType<typeof vi.fn>).mockClear();
      windowService.sendWhenReady(windowId, 'test:channel', 'data');

      expect(wc.send).toHaveBeenCalledWith('test:channel', 'data');
    });

    it('preserves message order in the queue', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;
      (wc.send as ReturnType<typeof vi.fn>).mockClear();

      windowService.sendWhenReady(windowId, 'ch:first', 'a');
      windowService.sendWhenReady(windowId, 'ch:second', 'b');
      windowService.sendWhenReady(windowId, 'ch:third', 'c');

      windowService.markRendererReady(windowId);

      const calls = (wc.send as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
        (c[0] as string).startsWith('ch:')
      );
      expect(calls).toEqual([
        ['ch:first', 'a'],
        ['ch:second', 'b'],
        ['ch:third', 'c'],
      ]);
    });

    it('sends to the main window when the named one is gone, or else to the next window', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');

      windowService.sendToWindowOrNext('closed-window', 'ch:next', 'a');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;
      (wc.send as ReturnType<typeof vi.fn>).mockClear();
      windowService.markRendererReady(windowId);
      expect(wc.send).toHaveBeenCalledWith('ch:next', 'a');

      (wc.send as ReturnType<typeof vi.fn>).mockClear();
      windowService.sendToWindowOrNext('closed-window', 'ch:main', 'b');
      expect(wc.send).toHaveBeenCalledWith('ch:main', 'b');
    });

    it('resets readiness on renderer reload', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;

      windowService.markRendererReady(windowId);

      // Simulate reload
      createdWindows[0].emitWebContents('did-start-navigation', mainFrameNavigation);

      // Should queue again since readiness was reset
      (wc.send as ReturnType<typeof vi.fn>).mockClear();
      windowService.sendWhenReady(windowId, 'test:after-reload', 'x');
      expect(wc.send).not.toHaveBeenCalled();

      // Re-ready flushes the queue
      windowService.markRendererReady(windowId);
      expect(wc.send).toHaveBeenCalledWith('test:after-reload', 'x');
    });

    it('keeps readiness, unsaved files and terminal focus when an iframe loads', async () => {
      setPlatform('darwin');
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const double = createdWindows[0];
      const wc = double.window.webContents;
      windowService.markRendererReady(windowId);
      windowService.setUnsavedFiles(windowId, ['app.ts']);
      windowService.setTerminalFocus(wc.id, 'terminal-1', true);

      // Status item popovers and browser previews load iframes in the window.
      double.emitWebContents('did-start-loading');
      double.emitWebContents('did-start-navigation', { isMainFrame: false, isSameDocument: false });

      windowService.sendWhenReady(windowId, 'test:after-iframe', 'x');
      expect(wc.send).toHaveBeenCalledWith('test:after-iframe', 'x');
      double.emitWebContents(
        'before-input-event',
        { preventDefault: vi.fn() },
        { meta: false, control: true, key: 'r', alt: false, shift: false, type: 'keyDown' }
      );
      expect(writePty).toHaveBeenCalledWith('terminal-1', '\x12');
      showMessageBoxSync.mockReturnValueOnce(1); // Cancel
      expect(windowService.confirmQuit()).toBe(false);
    });

    it('resets readiness on render-process-gone', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;

      windowService.markRendererReady(windowId);

      // Simulate crash
      createdWindows[0].emitWebContents(
        'render-process-gone',
        {},
        { reason: 'clean-exit', exitCode: 0 }
      );

      (wc.send as ReturnType<typeof vi.fn>).mockClear();
      windowService.sendWhenReady(windowId, 'test:after-crash', 'y');
      expect(wc.send).not.toHaveBeenCalled();

      windowService.markRendererReady(windowId);
      expect(wc.send).toHaveBeenCalledWith('test:after-crash', 'y');
    });

    it('reports non-clean renderer crashes to error reporting', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      windowService.createWindow();

      reportError.mockClear();
      createdWindows[0].emitWebContents(
        'render-process-gone',
        {},
        { reason: 'crashed', exitCode: 134 }
      );

      expect(reportError).toHaveBeenCalledTimes(1);
      const [errArg, typeArg, ctxArg] = reportError.mock.calls[0];
      expect(errArg).toBeInstanceOf(Error);
      expect((errArg as Error).message).toContain('crashed');
      expect((errArg as Error).message).toContain('134');
      expect(typeArg).toBe('processGone');
      expect(ctxArg).toEqual({ reason: 'crashed', exitCode: 134 });
    });

    it('does not report clean renderer exits', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      windowService.createWindow();

      reportError.mockClear();
      createdWindows[0].emitWebContents(
        'render-process-gone',
        {},
        { reason: 'clean-exit', exitCode: 0 }
      );

      expect(reportError).not.toHaveBeenCalled();
    });

    it('drops messages for destroyed windows', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;
      (wc.send as ReturnType<typeof vi.fn>).mockClear();

      createdWindows[0].window.isDestroyed.mockReturnValue(true);
      windowService.sendWhenReady(windowId, 'test:destroyed', 'z');

      expect(wc.send).not.toHaveBeenCalled();
    });

    it('drops messages when webContents is destroyed', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;
      (wc.send as ReturnType<typeof vi.fn>).mockClear();

      (wc.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      windowService.sendWhenReady(windowId, 'test:wc-destroyed', 'z');

      expect(wc.send).not.toHaveBeenCalled();
    });

    it('skips flush when webContents is destroyed during markRendererReady', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;

      windowService.sendWhenReady(windowId, 'test:queued', 'data');
      (wc.send as ReturnType<typeof vi.fn>).mockClear();

      (wc.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      windowService.markRendererReady(windowId);

      expect(wc.send).not.toHaveBeenCalled();
    });

    it('broadcastWhenReady sends to all windows respecting readiness', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const first = windowService.createWindow();
      const second = windowService.createWindow();
      const wc1 = createdWindows[0].window.webContents;
      const wc2 = createdWindows[1].window.webContents;

      // Only mark the first window as ready
      windowService.markRendererReady(first.windowId);
      (wc1.send as ReturnType<typeof vi.fn>).mockClear();
      (wc2.send as ReturnType<typeof vi.fn>).mockClear();

      windowService.broadcastWhenReady('test:broadcast', 'payload');

      // First window receives immediately
      expect(wc1.send).toHaveBeenCalledWith('test:broadcast', 'payload');
      // Second window is queued (not ready)
      expect(wc2.send).not.toHaveBeenCalled();

      // Mark second window ready — queued message is flushed
      windowService.markRendererReady(second.windowId);
      expect(wc2.send).toHaveBeenCalledWith('test:broadcast', 'payload');
    });

    it('clears queue on window close', async () => {
      const { windowService } = await import('../../../src/main/services/window.service');
      const { windowId } = windowService.createWindow();
      const wc = createdWindows[0].window.webContents;

      windowService.sendWhenReady(windowId, 'test:queued', 'data');
      createdWindows[0].emitWindow('closed');

      // markRendererReady after close should not flush anything
      (wc.send as ReturnType<typeof vi.fn>).mockClear();
      windowService.markRendererReady(windowId);
      expect(wc.send).not.toHaveBeenCalled();
    });

    it('queues window:list-updated for a newly created (not-yet-ready) window', async () => {
      // Regression: createWindow used to send WINDOW_LIST_UPDATED via raw
      // webContents.send, which was dropped because the new window's renderer
      // listeners weren't mounted yet. The fix routes it through the queue so
      // it lands once the renderer signals ready — before later messages like
      // WORKSPACE_MOVED_HERE trigger UI that reads availableWindows.
      const { windowService } = await import('../../../src/main/services/window.service');

      const first = windowService.createWindow();
      windowService.markRendererReady(first.windowId);

      const second = windowService.createWindow();
      const wc2 = createdWindows[1].window.webContents;

      // While window 2's renderer is not ready, WINDOW_LIST_UPDATED must not
      // have been delivered — it must be queued instead.
      const sentBeforeReady = (wc2.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string
      );
      expect(sentBeforeReady).not.toContain('window:list-updated');

      // Simulate window.handlers.ts queueing WORKSPACE_MOVED_HERE after createWindow.
      windowService.sendWhenReady(second.windowId, 'workspace:moved-here', 'ws-1', null);

      // Flushing on ready must deliver WINDOW_LIST_UPDATED before WORKSPACE_MOVED_HERE.
      windowService.markRendererReady(second.windowId);

      const channels = (wc2.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const listIdx = channels.indexOf('window:list-updated');
      const movedIdx = channels.indexOf('workspace:moved-here');
      expect(listIdx).toBeGreaterThanOrEqual(0);
      expect(movedIdx).toBeGreaterThan(listIdx);
    });
  });
});
