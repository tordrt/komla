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

const mockDetectWslDistros = vi.fn(() => []);

vi.mock('../../../../src/main/lib/wsl', () => ({
  detectWslDistros: mockDetectWslDistros,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

type IpcMainWithInvoke = { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };

async function setup() {
  const { registerShellHandlers } =
    await import('../../../../src/main/ipc/handlers/shell.handlers');
  const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMainWithInvoke };
  registerShellHandlers();
  return ipcMain;
}

describe('shell IPC behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('shell:open-external', () => {
    it('calls shell.openExternal with url', async () => {
      const ipcMain = await setup();
      const { shell } = await import('electron');

      await ipcMain._invoke('shell:open-external', 'https://example.com');

      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
    });
  });

  describe('shell:show-item-in-folder', () => {
    it('calls shell.showItemInFolder with path', async () => {
      const ipcMain = await setup();
      const { shell } = await import('electron');

      await ipcMain._invoke('shell:show-item-in-folder', '/tmp/file.txt');

      expect(shell.showItemInFolder).toHaveBeenCalledWith('/tmp/file.txt');
    });
  });

  describe('shell:open-path', () => {
    it('calls shell.openPath with path', async () => {
      const ipcMain = await setup();
      const { shell } = await import('electron');

      await ipcMain._invoke('shell:open-path', '/tmp/folder');

      expect(shell.openPath).toHaveBeenCalledWith('/tmp/folder');
    });

    it('throws when shell.openPath returns an error message', async () => {
      const ipcMain = await setup();
      const { shell } = await import('electron');
      vi.mocked(shell.openPath).mockResolvedValueOnce('No application found');

      await expect(ipcMain._invoke('shell:open-path', '/tmp/file.xyz')).rejects.toThrow(
        'No application found'
      );
    });
  });

  describe('shell:open-in-editor', () => {
    it('throws for unknown editor id', async () => {
      const ipcMain = await setup();

      await expect(
        ipcMain._invoke('shell:open-in-editor', 'unknown-editor', '/tmp/project')
      ).rejects.toThrow('Unknown editor: unknown-editor');
    });
  });

  describe('shell:get-wsl-distros', () => {
    it('delegates to detectWslDistros', async () => {
      const ipcMain = await setup();
      mockDetectWslDistros.mockReturnValue(['Ubuntu', 'Debian']);

      const result = await ipcMain._invoke('shell:get-wsl-distros');

      expect(mockDetectWslDistros).toHaveBeenCalled();
      expect(result).toEqual(['Ubuntu', 'Debian']);
    });
  });
});
