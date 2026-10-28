/**
 * Electron module mocks for main process testing.
 *
 * Usage:
 * ```ts
 * import { mockElectron, mockApp, mockBrowserWindow, mockIpcMain } from '../../mocks/electron'
 *
 * vi.mock('electron', () => mockElectron())
 * ```
 */

import { vi } from 'vitest';

/**
 * Create a mock BrowserWindow instance.
 */
export function createMockBrowserWindow(
  overrides: Partial<MockBrowserWindow> = {}
): MockBrowserWindow {
  const window: MockBrowserWindow = {
    id: Math.floor(Math.random() * 10000),
    webContents: {
      id: Math.floor(Math.random() * 10000),
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      isDestroyed: vi.fn(() => false),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
    },
    on: vi.fn(),
    once: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    setBounds: vi.fn(),
    setTitle: vi.fn(),
    getTitle: vi.fn(() => 'Test Window'),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    flashFrame: vi.fn(),
    ...overrides,
  };
  return window;
}

export interface MockWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
}

export interface MockBrowserWindow {
  id: number;
  webContents: MockWebContents;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isFocused: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  getTitle: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  flashFrame: ReturnType<typeof vi.fn>;
}

/**
 * Mock Electron app module.
 */
export function mockApp(overrides: Partial<MockApp> = {}): MockApp {
  return {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => {
      const paths: Record<string, string> = {
        home: '/mock/home',
        appData: '/mock/appData',
        userData: '/mock/userData',
        temp: '/mock/temp',
        desktop: '/mock/desktop',
        documents: '/mock/documents',
      };
      return paths[name] || `/mock/${name}`;
    }),
    getVersion: vi.fn(() => '1.0.0'),
    getApplicationNameForProtocol: vi.fn(() => ''),
    getName: vi.fn(() => 'komla'),
    name: 'komla',
    setPath: vi.fn(),
    isPackaged: false,
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    focus: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    getAppMetrics: vi.fn(() => []),
    setBadgeCount: vi.fn(() => true),
    setJumpList: vi.fn(),
    dock: {
      setBadge: vi.fn(),
      getBadge: vi.fn(() => ''),
      bounce: vi.fn(() => 0),
      cancelBounce: vi.fn(),
      hide: vi.fn(),
      show: vi.fn(),
      isVisible: vi.fn(() => true),
      setIcon: vi.fn(),
      setMenu: vi.fn(),
    },
    ...overrides,
  };
}

export interface MockDock {
  setBadge: ReturnType<typeof vi.fn>;
  getBadge: ReturnType<typeof vi.fn>;
  bounce: ReturnType<typeof vi.fn>;
  cancelBounce: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  setIcon: ReturnType<typeof vi.fn>;
  setMenu: ReturnType<typeof vi.fn>;
}

export interface MockApp {
  getAppPath: ReturnType<typeof vi.fn>;
  getPath: ReturnType<typeof vi.fn>;
  getVersion: ReturnType<typeof vi.fn>;
  getApplicationNameForProtocol: ReturnType<typeof vi.fn>;
  getName: ReturnType<typeof vi.fn>;
  name: string;
  setPath: ReturnType<typeof vi.fn>;
  isPackaged: boolean;
  isReady: ReturnType<typeof vi.fn>;
  whenReady: ReturnType<typeof vi.fn>;
  requestSingleInstanceLock: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  getAppMetrics: ReturnType<typeof vi.fn>;
  setBadgeCount: ReturnType<typeof vi.fn>;
  setJumpList: ReturnType<typeof vi.fn>;
  dock: MockDock;
}

/**
 * Mock Electron ipcMain module.
 */
export function mockIpcMain(): MockIpcMain {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    handleOnce: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    // Test utility: invoke a registered handler
    _invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for channel: ${channel}`);
      return handler({}, ...args);
    },
    _getHandler: (channel: string) => handlers.get(channel),
  };
}

export interface MockIpcMain {
  handle: ReturnType<typeof vi.fn>;
  handleOnce: ReturnType<typeof vi.fn>;
  removeHandler: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  _invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  _getHandler: (channel: string) => ((...args: unknown[]) => unknown) | undefined;
}

/**
 * Mock Electron shell module.
 */
export function mockShell(): MockShell {
  return {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve('')),
    showItemInFolder: vi.fn(),
    beep: vi.fn(),
  };
}

export interface MockShell {
  openExternal: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
  showItemInFolder: ReturnType<typeof vi.fn>;
  beep: ReturnType<typeof vi.fn>;
}

export function mockProtocol(): MockProtocol {
  return {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  };
}

export interface MockProtocol {
  registerSchemesAsPrivileged: ReturnType<typeof vi.fn>;
  handle: ReturnType<typeof vi.fn>;
}

export function mockPowerSaveBlocker(): MockPowerSaveBlocker {
  const active = new Set<number>();
  let nextId = 1;
  return {
    start: vi.fn(() => {
      const id = nextId++;
      active.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      active.delete(id);
    }),
    isStarted: vi.fn((id: number) => active.has(id)),
  };
}

export interface MockPowerSaveBlocker {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isStarted: ReturnType<typeof vi.fn>;
}

export function mockClipboard(): MockClipboard {
  return {
    writeText: vi.fn(() => Promise.resolve()),
    readText: vi.fn(() => Promise.resolve('')),
    read: vi.fn(() => Promise.resolve([])),
  };
}

export interface MockClipboard {
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}

/**
 * Mock Electron nativeImage module. Decoded images echo their input bytes.
 */
export function mockNativeImage(): MockNativeImage {
  return {
    createFromBuffer: vi.fn((buffer: Buffer) => ({
      isEmpty: () => buffer.length === 0,
      toPNG: () => buffer,
    })),
  };
}

export interface MockNativeImage {
  createFromBuffer: ReturnType<typeof vi.fn>;
}

/**
 * Mock Electron dialog module.
 */
export function mockDialog(): MockDialog {
  return {
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true })),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    showErrorBox: vi.fn(),
  };
}

export interface MockDialog {
  showOpenDialog: ReturnType<typeof vi.fn>;
  showSaveDialog: ReturnType<typeof vi.fn>;
  showMessageBox: ReturnType<typeof vi.fn>;
  showErrorBox: ReturnType<typeof vi.fn>;
}

/**
 * Mock Electron Notification class.
 */
export function mockNotification(): MockNotificationClass {
  const NotificationMock = vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  }));
  // Static method
  (NotificationMock as unknown as { isSupported: () => boolean }).isSupported = () => true;
  return NotificationMock as MockNotificationClass;
}

export type MockNotificationClass = ReturnType<typeof vi.fn> & { isSupported: () => boolean };

/**
 * Create complete Electron mock object.
 * Use with vi.mock('electron', () => mockElectron())
 */
export function mockElectron(overrides: Partial<MockElectronModule> = {}): MockElectronModule {
  const BrowserWindowMock = vi.fn().mockImplementation(() => createMockBrowserWindow());
  (BrowserWindowMock as unknown as { getAllWindows: () => MockBrowserWindow[] }).getAllWindows =
    vi.fn(() => []);
  (
    BrowserWindowMock as unknown as { getFocusedWindow: () => MockBrowserWindow | null }
  ).getFocusedWindow = vi.fn(() => null);
  (BrowserWindowMock as unknown as { fromId: (id: number) => MockBrowserWindow | null }).fromId =
    vi.fn(() => null);
  (
    BrowserWindowMock as unknown as {
      fromWebContents: (wc: MockWebContents) => MockBrowserWindow | null;
    }
  ).fromWebContents = vi.fn(() => null);

  return {
    app: mockApp(),
    ipcMain: mockIpcMain(),
    ipcRenderer: {
      send: vi.fn(),
      invoke: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    },
    BrowserWindow: BrowserWindowMock,
    shell: mockShell(),
    clipboard: mockClipboard(),
    nativeImage: mockNativeImage(),
    protocol: mockProtocol(),
    dialog: mockDialog(),
    powerSaveBlocker: mockPowerSaveBlocker(),
    Notification: mockNotification(),
    nativeTheme: {
      shouldUseDarkColors: false,
      themeSource: 'system' as const,
      on: vi.fn(),
    },
    Menu: {
      buildFromTemplate: vi.fn(() => ({})),
      setApplicationMenu: vi.fn(),
    },
    ...overrides,
  };
}

export interface MockElectronModule {
  app: MockApp;
  ipcMain: MockIpcMain;
  ipcRenderer: {
    send: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  BrowserWindow: ReturnType<typeof vi.fn>;
  shell: MockShell;
  clipboard: MockClipboard;
  nativeImage: MockNativeImage;
  protocol: MockProtocol;
  dialog: MockDialog;
  powerSaveBlocker: MockPowerSaveBlocker;
  Notification: MockNotificationClass;
  nativeTheme: {
    shouldUseDarkColors: boolean;
    themeSource: 'system' | 'light' | 'dark';
    on: ReturnType<typeof vi.fn>;
  };
  Menu: {
    buildFromTemplate: ReturnType<typeof vi.fn>;
    setApplicationMenu: ReturnType<typeof vi.fn>;
  };
}
