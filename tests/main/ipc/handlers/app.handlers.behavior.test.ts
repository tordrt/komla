import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const electronMock = mockElectron();
const mockRelaunch = vi.fn();
const mockQuit = vi.fn();
(electronMock.app as unknown as { relaunch: () => void }).relaunch = mockRelaunch;
(electronMock.app as unknown as { quit: () => void }).quit = mockQuit;
vi.mock('electron', () => electronMock);

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
}));

const mockAnnouncementService = {
  getActive: vi.fn(() => []),
  dismiss: vi.fn(),
};
const mockBackgroundProcessService = {
  killAll: vi.fn(),
};
const mockErrorReportingService = {
  report: vi.fn(),
};
const mockFeedbackService = {
  selectScreenshots: vi.fn(),
  sendFeedback: vi.fn(),
};
const mockWorkspaceFileService = {
  importExternalFile: vi.fn(),
};
const mockUpdateService = {
  installUpdate: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
};
const mockWorkspaceService = {
  deleteAll: vi.fn(async () => undefined),
};
const mockWorktreeWatcherService = {
  stopAll: vi.fn(async () => undefined),
};
const mockPtyService = {
  killAll: vi.fn(),
};

vi.mock('../../../../src/main/services/announcement.service', () => ({
  announcementService: mockAnnouncementService,
}));
vi.mock('../../../../src/main/services/background-process.service', () => ({
  backgroundProcessService: mockBackgroundProcessService,
}));
vi.mock('../../../../src/main/services/error-reporting.service', () => ({
  errorReportingService: mockErrorReportingService,
}));
vi.mock('../../../../src/main/services/feedback.service', () => ({
  feedbackService: mockFeedbackService,
}));
vi.mock('../../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/tmp/.komla'),
}));
vi.mock('../../../../src/main/services/pty.service', () => ({ ptyService: mockPtyService }));
vi.mock('../../../../src/main/services/resource-usage/resource-usage.service', () => ({
  resourceUsageService: { get: vi.fn(() => Promise.resolve([])) },
}));
vi.mock('../../../../src/main/services/update.service', () => ({
  updateService: mockUpdateService,
}));
vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));
vi.mock('../../../../src/main/services/workspace-file.service', () => ({
  workspaceFileService: mockWorkspaceFileService,
}));
vi.mock('../../../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: mockWorktreeWatcherService,
}));
const mockNotesService = vi.hoisted(() => ({ stopWatching: vi.fn(async () => undefined) }));
vi.mock('../../../../src/main/services/notes.service', () => ({
  notesService: mockNotesService,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRmSync = vi.mocked(rmSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);

describe('app IPC behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    electronMock.clipboard.readText.mockResolvedValue('');
    electronMock.clipboard.read.mockResolvedValue([]);
  });

  it('app:get-system-metrics sums CPU and aggregates memory', async () => {
    const mockAppMetrics = [
      { cpu: { percentCPUUsage: 25 }, memory: { workingSetSize: 102400 } },
      { cpu: { percentCPUUsage: 15 }, memory: { workingSetSize: 51200 } },
      { cpu: { percentCPUUsage: 10 }, memory: { workingSetSize: 20480 } },
    ];
    (electronMock.app as unknown as { getAppMetrics: () => unknown }).getAppMetrics = vi.fn(
      () => mockAppMetrics
    );

    const { getSystemMetrics } = await import('../../../../src/main/ipc/handlers/app.handlers');

    const result = getSystemMetrics();

    // Memory: (102400 + 51200 + 20480) / 1024 = 170 MB
    expect(result.memoryMB).toBe(170);
    // CPU: 25 + 15 + 10 = 50%
    expect(result.cpuPercent).toBe(50);
  });

  it('announcements:get returns active announcements', async () => {
    const announcements = [{ id: '1', title: 'Test', body: 'Hello' }];
    mockAnnouncementService.getActive.mockReturnValue(announcements);

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('announcements:get');

    expect(mockAnnouncementService.getActive).toHaveBeenCalledOnce();
    expect(result).toEqual(announcements);
  });

  it('announcements:dismiss calls dismiss with id', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('announcements:dismiss', 'ann-42');

    expect(mockAnnouncementService.dismiss).toHaveBeenCalledWith('ann-42');
  });

  it('app:get-version returns app version', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('app:get-version');

    expect(result).toBe('1.0.0');
  });

  it('app:install-update calls installUpdate', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('app:install-update');

    expect(mockUpdateService.installUpdate).toHaveBeenCalledOnce();
  });

  it('app:check-updates calls checkForUpdates', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('app:check-updates');

    expect(mockUpdateService.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('app:download-update calls downloadUpdate', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('app:download-update');

    expect(mockUpdateService.downloadUpdate).toHaveBeenCalledOnce();
  });

  it('clipboard text handlers wait for the async clipboard API', async () => {
    let resolveWrite!: () => void;
    electronMock.clipboard.writeText.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      })
    );
    electronMock.clipboard.readText.mockResolvedValue('copied text');

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    let written = false;
    const write = ipcMain._invoke('clipboard:write-text', 'hello').then(() => {
      written = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(written).toBe(false);
    resolveWrite();
    await write;

    await expect(ipcMain._invoke('clipboard:read-text')).resolves.toBe('copied text');
  });

  it('clipboard:import-image writes clipboard PNG through external file import', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    electronMock.clipboard.read.mockResolvedValue([
      { types: ['image/png'], getType: vi.fn(async () => new Blob([png])) },
    ]);
    mockWorkspaceFileService.importExternalFile.mockResolvedValue(
      '.komla-files/clipboard-image.png'
    );

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('clipboard:import-image', 'workspace-1', 'workspace');

    expect(result).toBe('.komla-files/clipboard-image.png');
    expect(mockMkdirSync).toHaveBeenCalledWith('/mock/temp/komla-clipboard-images', {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(expect.stringMatching(/\.png$/), png);
    expect(mockWorkspaceFileService.importExternalFile).toHaveBeenCalledWith(
      'workspace-1',
      expect.stringMatching(/\.png$/),
      expect.stringMatching(/^clipboard-image-.*\.png$/),
      'workspace'
    );
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringMatching(/\.png$/), { force: true });
  });

  it('clipboard:import-image re-encodes non-PNG clipboard images as PNG', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const getType = vi.fn(async () => new Blob([jpeg]));
    electronMock.clipboard.read.mockResolvedValue([
      { types: ['text/plain'], getType: vi.fn() },
      { types: ['text/html', 'image/jpeg'], getType },
    ]);
    electronMock.nativeImage.createFromBuffer.mockReturnValueOnce({
      isEmpty: () => false,
      toPNG: () => png,
    });
    mockWorkspaceFileService.importExternalFile.mockResolvedValue(
      '.komla-files/clipboard-image.png'
    );

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('clipboard:import-image', 'workspace-1', 'workspace');

    expect(result).toBe('.komla-files/clipboard-image.png');
    expect(getType).toHaveBeenCalledWith('image/jpeg');
    expect(electronMock.nativeImage.createFromBuffer).toHaveBeenCalledWith(jpeg);
    expect(mockWriteFileSync).toHaveBeenCalledWith(expect.stringMatching(/\.png$/), png);
  });

  it('clipboard:import-image returns null when clipboard has no image', async () => {
    electronMock.clipboard.read.mockResolvedValue([
      { types: ['text/plain'], getType: vi.fn(async () => new Blob(['hello'])) },
    ]);
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('clipboard:import-image', 'workspace-1', undefined);

    expect(result).toBeNull();
    expect(mockWorkspaceFileService.importExternalFile).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('clipboard:stage-image saves the clipboard image under its own name for a later import', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    electronMock.clipboard.read.mockResolvedValue([
      { types: ['image/png'], getType: vi.fn(async () => new Blob([png])) },
    ]);
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('clipboard:stage-image');

    expect(result).toMatch(
      /^\/mock\/temp\/komla-clipboard-images\/staged\/[^/]+\/clipboard-image-.*\.png$/
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(result, png);
    expect(mockWorkspaceFileService.importExternalFile).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('clipboard:stage-image removes images staged more than a week ago', async () => {
    electronMock.clipboard.read.mockResolvedValue([
      { types: ['image/png'], getType: vi.fn(async () => new Blob([Buffer.from([1])])) },
    ]);
    const staged = '/mock/temp/komla-clipboard-images/staged';
    mockReaddirSync.mockReturnValueOnce([{ name: 'old' }, { name: 'recent' }] as never);
    mockStatSync.mockImplementation(
      (path) =>
        ({
          mtimeMs: Date.now() - (path === `${staged}/old` ? 8 : 6) * 24 * 60 * 60 * 1000,
        }) as never
    );
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();
    await ipcMain._invoke('clipboard:stage-image');

    expect(mockRmSync.mock.calls).toEqual([[`${staged}/old`, { recursive: true, force: true }]]);
  });

  it('clipboard:stage-image returns null when clipboard has no image', async () => {
    electronMock.clipboard.read.mockResolvedValue([
      { types: ['text/plain'], getType: vi.fn(async () => new Blob(['hello'])) },
    ]);
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await expect(ipcMain._invoke('clipboard:stage-image')).resolves.toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('feedback:select-screenshots returns screenshot paths', async () => {
    const paths = ['/tmp/screenshot1.png', '/tmp/screenshot2.png'];
    mockFeedbackService.selectScreenshots.mockResolvedValue(paths);

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('feedback:select-screenshots');

    expect(mockFeedbackService.selectScreenshots).toHaveBeenCalledOnce();
    expect(result).toEqual(paths);
  });

  it('feedback:send delegates validated payload to feedbackService', async () => {
    const payload = { type: 'bug', description: 'Something broke' };
    const feedbackResult = { success: true, id: 'fb-1' };
    mockFeedbackService.sendFeedback.mockResolvedValue(feedbackResult);

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const result = await ipcMain._invoke('feedback:send', payload);

    expect(mockFeedbackService.sendFeedback).toHaveBeenCalledWith(payload);
    expect(result).toEqual(feedbackResult);
  });

  it('error:report creates Error from payload and reports it', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('error:report', {
      message: 'Test error',
      stack: 'Error: Test error\n    at test.ts:1',
      type: 'uncaughtException',
      context: { component: 'App' },
    });

    expect(mockErrorReportingService.report).toHaveBeenCalledOnce();
    const [err, type, context] = mockErrorReportingService.report.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Test error');
    expect(err.stack).toBe('Error: Test error\n    at test.ts:1');
    expect(type).toBe('uncaughtException');
    expect(context).toEqual({ component: 'App' });
  });

  it('data:delete-all-workspaces calls workspaceService.deleteAll', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('data:delete-all-workspaces');

    expect(mockWorkspaceService.deleteAll).toHaveBeenCalledOnce();
  });

  it('data:clear-logs calls rmSync on logs directory', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('data:clear-logs');

    expect(mockRmSync).toHaveBeenCalledWith('/tmp/.komla/logs', { recursive: true, force: true });
  });

  it('data:reset-app preserves license, stops services, deletes dir, relaunches', async () => {
    mockExistsSync.mockImplementation((path) => path === '/tmp/.komla/license.json');
    mockReadFileSync.mockReturnValue('{"licenseKey":"abc"}');

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('data:reset-app');

    expect(mockWorktreeWatcherService.stopAll).toHaveBeenCalledOnce();
    // The notes watcher holds the notes folder open.
    expect(mockNotesService.stopWatching).toHaveBeenCalledOnce();
    expect(mockBackgroundProcessService.killAll).toHaveBeenCalledOnce();
    expect(mockPtyService.killAll).toHaveBeenCalledOnce();
    expect(mockWorkspaceService.deleteAll).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/.komla', {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/.komla', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/.komla/license.json',
      '{"licenseKey":"abc"}',
      'utf-8'
    );
    expect(mockRelaunch).toHaveBeenCalledOnce();
    expect(mockQuit).toHaveBeenCalledOnce();
  });

  it('data:reset-app waits for ptyService.killAll to resolve before deleting data and relaunching', async () => {
    // Regression guard: this fix relies on `await ptyService.killAll()` so the
    // node-pty exit ThreadSafeFunctions drain before app.quit() runs. If a
    // future change drops the `await`, this test should fail.
    mockExistsSync.mockImplementation((path) => path === '/tmp/.komla/license.json');
    mockReadFileSync.mockReturnValue('{"licenseKey":"abc"}');

    let resolveKillAll!: () => void;
    mockPtyService.killAll.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveKillAll = resolve;
        })
    );

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const invocation = ipcMain._invoke('data:reset-app');

    // Yield enough microtasks for the handler to walk through stopAll → killAll
    // and suspend at the awaited ptyService.killAll().
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPtyService.killAll).toHaveBeenCalledOnce();
    expect(mockWorkspaceService.deleteAll).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockQuit).not.toHaveBeenCalled();

    resolveKillAll();
    await invocation;

    expect(mockWorkspaceService.deleteAll).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalled();
    expect(mockRelaunch).toHaveBeenCalledOnce();
    expect(mockQuit).toHaveBeenCalledOnce();
  });
});
