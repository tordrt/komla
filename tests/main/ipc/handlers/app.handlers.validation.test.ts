import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

vi.mock('../../../../src/main/services/announcement.service', () => ({
  announcementService: { getActive: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('../../../../src/main/services/background-process.service', () => ({
  backgroundProcessService: { killAll: vi.fn() },
}));
vi.mock('../../../../src/main/services/error-reporting.service', () => ({
  errorReportingService: { report: vi.fn() },
}));
const mockFeedbackService = {
  selectScreenshots: vi.fn(),
  sendFeedback: vi.fn(),
};
vi.mock('../../../../src/main/services/feedback.service', () => ({
  feedbackService: mockFeedbackService,
}));
vi.mock('../../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/tmp/.komla'),
}));
vi.mock('../../../../src/main/services/pty.service', () => ({ ptyService: { killAll: vi.fn() } }));
vi.mock('../../../../src/main/services/resource-usage/resource-usage.service', () => ({
  resourceUsageService: { get: vi.fn(() => Promise.resolve({})) },
}));
vi.mock('../../../../src/main/services/update.service', () => ({
  updateService: { installUpdate: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn() },
}));
vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: { deleteAll: vi.fn() },
}));
vi.mock('../../../../src/main/services/workspace-file.service', () => ({
  workspaceFileService: { importExternalFile: vi.fn() },
}));
vi.mock('../../../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: { stopAll: vi.fn(async () => undefined) },
}));
vi.mock('../../../../src/main/services/notes.service', () => ({
  notesService: { stopWatching: vi.fn(async () => undefined) },
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

describe('app IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('feedback:send strips unknown keys from payload', async () => {
    mockFeedbackService.sendFeedback.mockResolvedValue({ success: true });

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('feedback:send', {
      type: 'bug',
      description: 'Something broke',
      injected: 'malicious',
    });

    expect(mockFeedbackService.sendFeedback).toHaveBeenCalledWith({
      type: 'bug',
      description: 'Something broke',
    });
  });

  it('feedback:send rejects missing required fields', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const error = await ipcMain
      ._invoke('feedback:send', {})
      .catch((e: Error & { code?: string }) => e);

    expect((error as Error & { code: string }).code).toBe('IPC_VALIDATION_ERROR');
  });

  it('error:report strips unknown keys from error payload', async () => {
    const { errorReportingService } =
      (await import('../../../../src/main/services/error-reporting.service')) as unknown as {
        errorReportingService: { report: ReturnType<typeof vi.fn> };
      };

    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await ipcMain._invoke('error:report', {
      message: 'Test error',
      type: 'uncaughtException',
      injected: 'malicious',
    });

    const [err, type, context] = errorReportingService.report.mock.calls[0];
    expect(err.message).toBe('Test error');
    expect(type).toBe('uncaughtException');
    expect(context).toBeUndefined();
  });

  it('error:report rejects invalid type enum value', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const error = await ipcMain
      ._invoke('error:report', {
        message: 'Test error',
        type: 'invalidType',
      })
      .catch((e: Error & { code?: string }) => e);

    expect((error as Error & { code: string }).code).toBe('IPC_VALIDATION_ERROR');
  });

  it('clipboard:import-image rejects an invalid workspace id', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    const error = await ipcMain
      ._invoke('clipboard:import-image', '   ')
      .catch((e: Error & { code?: string }) => e);

    expect((error as Error & { code: string }).code).toBe('IPC_VALIDATION_ERROR');
  });

  it('resource-usage:get takes an SSH host id, or null for this computer', async () => {
    const { registerAppHandlers } = await import('../../../../src/main/ipc/handlers/app.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAppHandlers();

    await expect(ipcMain._invoke('resource-usage:get', null)).resolves.toEqual({});
    await expect(ipcMain._invoke('resource-usage:get', 'devbox')).resolves.toEqual({});
    await expect(
      ipcMain._invoke('resource-usage:get', 'devbox', { prompt: false, maxAgeMs: 4500 })
    ).resolves.toEqual({});
    for (const args of [
      [['devbox']],
      ['devbox', { maxAgeMs: -1 }],
      ['devbox', { prompt: 'no' }],
      ['devbox', { force: true }],
    ]) {
      const error = await ipcMain
        ._invoke('resource-usage:get', ...args)
        .catch((e: Error & { code?: string }) => e);
      expect((error as Error & { code: string }).code).toBe('IPC_VALIDATION_ERROR');
    }
  });
});
