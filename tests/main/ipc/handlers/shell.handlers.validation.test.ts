import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('../../../../src/main/lib/wsl', () => ({
  detectWslDistros: vi.fn(() => []),
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('shell IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('shell:open-external rejects empty string', async () => {
    const { registerShellHandlers } =
      await import('../../../../src/main/ipc/handlers/shell.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerShellHandlers();

    await expect(ipcMain._invoke('shell:open-external', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
  });

  it('shell:show-item-in-folder rejects path with null bytes', async () => {
    const { registerShellHandlers } =
      await import('../../../../src/main/ipc/handlers/shell.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerShellHandlers();

    await expect(
      ipcMain._invoke('shell:show-item-in-folder', '/tmp/file\x00.txt')
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
  });

  it('shell:show-item-in-folder rejects empty path', async () => {
    const { registerShellHandlers } =
      await import('../../../../src/main/ipc/handlers/shell.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerShellHandlers();

    await expect(ipcMain._invoke('shell:show-item-in-folder', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
  });

  it('shell:open-path rejects path with null bytes', async () => {
    const { registerShellHandlers } =
      await import('../../../../src/main/ipc/handlers/shell.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerShellHandlers();

    await expect(ipcMain._invoke('shell:open-path', '/tmp/folder\x00bad')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
  });

  it('shell:open-in-editor rejects empty editor id', async () => {
    const { registerShellHandlers } =
      await import('../../../../src/main/ipc/handlers/shell.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerShellHandlers();

    await expect(ipcMain._invoke('shell:open-in-editor', '', '/tmp/project')).rejects.toMatchObject(
      {
        code: 'IPC_VALIDATION_ERROR',
      }
    );
  });

  it('shell:open-in-editor rejects path with null bytes', async () => {
    const { registerShellHandlers } =
      await import('../../../../src/main/ipc/handlers/shell.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerShellHandlers();

    await expect(
      ipcMain._invoke('shell:open-in-editor', 'vscode', '/tmp/project\x00bad')
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
  });
});
