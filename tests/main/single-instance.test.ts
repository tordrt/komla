import { join } from 'path';

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../mocks/electron';

const electronMock = mockElectron();

// Capture the second-instance handler when app.on is called
let secondInstanceHandler: (event: unknown, argv: string[], workingDirectory: string) => void;
electronMock.app.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  if (event === 'second-instance') {
    secondInstanceHandler = handler as typeof secondInstanceHandler;
  }
});

vi.mock('electron', () => electronMock);

// Mock all services that index.ts imports
vi.mock('../../src/main/services/window.service', () => ({
  windowService: {
    createWindow: vi.fn(() => ({ window: createMockBrowserWindow(), windowId: 'mock-id' })),
  },
}));
vi.mock('../../src/main/services/customization.service', () => ({
  customizationService: { syncTitleBarOverlay: vi.fn() },
}));

// Stub out remaining imports that index.ts pulls in
vi.mock('../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../src/main/services/error-reporting.service', () => ({
  errorReportingService: { report: vi.fn() },
}));
vi.mock('../../src/main/services/workspace.service', () => ({
  workspaceService: {},
}));
vi.mock('../../src/main/services/pty.service', () => ({ ptyService: {} }));
vi.mock('../../src/main/services/git.service', () => ({ gitService: {} }));
vi.mock('../../src/main/services/config.service', () => ({
  configService: { get: vi.fn(), getAll: vi.fn(() => ({})), set: vi.fn() },
}));
vi.mock('../../src/main/services/project.service', () => ({ projectService: {} }));
vi.mock('../../src/main/services/managed-repo.service', () => ({ managedRepoService: {} }));
vi.mock('../../src/main/services/license.service', () => ({ licenseService: {} }));
vi.mock('../../src/main/services/http-server.service', () => ({ httpServerService: {} }));
vi.mock('../../src/main/services/search.service', () => ({ searchService: {} }));
vi.mock('../../src/main/services/telemetry.service', () => ({
  telemetryService: { capture: vi.fn() },
}));
vi.mock('../../src/main/services/utility-inference.service', () => ({
  registerUtilityRequestTracker: vi.fn(),
  utilityInferenceService: {},
}));
vi.mock('../../src/main/services/update.service', () => ({ updateService: {} }));
vi.mock('../../src/main/services/diagnostics.service', () => ({ diagnosticsService: {} }));
vi.mock('../../src/main/services/agent-preset.service', () => ({ agentPresetService: {} }));
vi.mock('../../src/main/services/background-process.service', () => ({
  backgroundProcessService: {},
}));
vi.mock('../../src/main/services/shortcuts.service', () => ({ shortcutsService: {} }));
vi.mock('../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: {},
}));
vi.mock('../../src/main/services/remote-control-direct.service', () => ({
  remoteControlDirectService: { getState: () => ({}) },
}));
vi.mock('../../src/main/services/notification-sync.service', () => ({
  notificationSyncService: {},
}));
vi.mock('../../src/main/services/action.service', () => ({
  actionService: {},
  registerActionUsageTracker: vi.fn(),
}));
vi.mock('../../src/main/services/category.service', () => ({ categoryService: {} }));
vi.mock('../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/komla'),
}));
vi.mock('../../src/main/ipc/handlers', () => ({
  registerIpcHandlers: vi.fn(),
}));
vi.mock('../../src/main/lib/atomic-write', () => ({
  cleanupTmpFilesRecursiveAsync: vi.fn(() => Promise.resolve()),
}));
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true },
}));

describe('preview protocol registration', () => {
  it('allows Electron PDF viewer extensions on the preview scheme', async () => {
    vi.resetModules();
    electronMock.protocol.registerSchemesAsPrivileged.mockClear();

    await import('../../src/main/index');

    expect(electronMock.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: 'komla-preview',
        privileges: expect.objectContaining({ allowExtensions: true }),
      }),
    ]);
  });
});

describe('staging app identity', () => {
  it('sets app.name and userData path for staging', async () => {
    vi.resetModules();
    vi.stubGlobal('__KOMLA_ENV__', 'staging');

    await import('../../src/main/index');

    expect(electronMock.app.name).toBe('Komla Staging');
    expect(electronMock.app.setPath).toHaveBeenCalledWith(
      'userData',
      join('/mock/appData', 'Komla Staging')
    );

    // Clean up
    vi.stubGlobal('__KOMLA_ENV__', undefined);
    electronMock.app.name = 'komla';
    vi.resetModules();
  });

  it('does not change app.name or userData in production mode', async () => {
    vi.resetModules();
    vi.stubGlobal('__KOMLA_ENV__', 'production');
    electronMock.app.name = 'komla';
    electronMock.app.setPath.mockClear();

    await import('../../src/main/index');

    expect(electronMock.app.name).toBe('komla');
    expect(electronMock.app.setPath).not.toHaveBeenCalled();

    vi.stubGlobal('__KOMLA_ENV__', undefined);
    vi.resetModules();
  });
});

describe('single-instance guard', () => {
  let getAllWindowsMock: ReturnType<typeof vi.fn>;
  let getFocusedWindowMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getAllWindowsMock = (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows;
    getFocusedWindowMock = (
      electronMock.BrowserWindow as unknown as { getFocusedWindow: ReturnType<typeof vi.fn> }
    ).getFocusedWindow;
  });

  it('focuses the currently focused window when one exists', async () => {
    await import('../../src/main/index');

    const win = createMockBrowserWindow();
    getFocusedWindowMock.mockReturnValue(win);

    secondInstanceHandler({}, ['komla'], '/tmp');

    expect(win.focus).toHaveBeenCalled();
    expect(win.restore).not.toHaveBeenCalled();
  });

  it('restores and focuses a minimized window', async () => {
    await import('../../src/main/index');

    const win = createMockBrowserWindow({ isMinimized: vi.fn(() => true) });
    getFocusedWindowMock.mockReturnValue(null);
    getAllWindowsMock.mockReturnValue([win]);

    secondInstanceHandler({}, ['komla'], '/tmp');

    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('falls back to getAllWindows when no focused window', async () => {
    await import('../../src/main/index');

    const win = createMockBrowserWindow();
    getFocusedWindowMock.mockReturnValue(null);
    getAllWindowsMock.mockReturnValue([win]);

    secondInstanceHandler({}, ['komla'], '/tmp');

    expect(win.focus).toHaveBeenCalled();
  });

  it('creates a new window when no windows exist', async () => {
    await import('../../src/main/index');

    const { windowService } = await import('../../src/main/services/window.service');
    const { customizationService } = await import('../../src/main/services/customization.service');

    getFocusedWindowMock.mockReturnValue(null);
    getAllWindowsMock.mockReturnValue([]);

    secondInstanceHandler({}, ['komla'], '/tmp');

    expect(windowService.createWindow).toHaveBeenCalled();
    expect(customizationService.syncTitleBarOverlay).toHaveBeenCalled();
  });

  it('creates a new window when --new-window is passed, even if a window exists', async () => {
    await import('../../src/main/index');

    const { windowService } = await import('../../src/main/services/window.service');
    const { customizationService } = await import('../../src/main/services/customization.service');

    const existingWin = createMockBrowserWindow();
    getFocusedWindowMock.mockReturnValue(existingWin);
    getAllWindowsMock.mockReturnValue([existingWin]);

    secondInstanceHandler({}, ['komla', '--new-window'], '/tmp');

    expect(windowService.createWindow).toHaveBeenCalled();
    expect(customizationService.syncTitleBarOverlay).toHaveBeenCalled();
    expect(existingWin.focus).not.toHaveBeenCalled();
  });
});
