import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockCustomizationService = {
  getTheme: vi.fn(),
  getTerminal: vi.fn(),
  updateTheme: vi.fn(),
  updateTerminal: vi.fn(),
  resetTheme: vi.fn(),
};

const mockShortcutsService = {
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  resetConfig: vi.fn(),
};

const mockActionService = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  delete: vi.fn(),
  recordUsage: vi.fn(),
};

vi.mock('../../../../src/main/services/customization.service', () => ({
  customizationService: mockCustomizationService,
}));

vi.mock('../../../../src/main/services/shortcuts.service', () => ({
  shortcutsService: mockShortcutsService,
}));

vi.mock('../../../../src/main/services/action.service', () => ({
  actionService: mockActionService,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

describe('customization IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('strips unknown keys from customization:update-theme payload', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('customization:update-theme', {
      mode: 'dark',
      colors: { accent: '#ff0000' },
      injected: 'malicious',
    });

    expect(mockCustomizationService.updateTheme).toHaveBeenCalledWith({
      mode: 'dark',
      colors: { accent: '#ff0000' },
    });
  });

  it('passes a palette choice through but not a custom theme definition', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('customization:update-theme', {
      palette: 'nord',
      customPalette: { mode: 'dark' },
    });

    expect(mockCustomizationService.updateTheme).toHaveBeenCalledWith({ palette: 'nord' });
  });

  it('passes the system appearance choice through and rejects one that is not a switch', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('customization:update-theme', {
      followSystem: true,
      lightPalette: 'github-light',
      colors: { lightAccent: 'oklch(0.5 0.19 257)' },
    });
    expect(mockCustomizationService.updateTheme).toHaveBeenCalledWith({
      followSystem: true,
      lightPalette: 'github-light',
      colors: { lightAccent: 'oklch(0.5 0.19 257)' },
    });

    mockCustomizationService.updateTheme.mockClear();
    await expect(
      ipcMain._invoke('customization:update-theme', { followSystem: 'yes' })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    await expect(
      ipcMain._invoke('customization:update-theme', { lightPalette: '' })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockCustomizationService.updateTheme).not.toHaveBeenCalled();
  });

  it('strips unknown keys from customization:update-terminal payload', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('customization:update-terminal', {
      font: { family: 'Menlo', size: 14 },
      scrollback: 5000,
      injected: 'malicious',
    });

    expect(mockCustomizationService.updateTerminal).toHaveBeenCalledWith({
      font: { family: 'Menlo', size: 14 },
      scrollback: 5000,
    });
  });

  it('strips unknown keys from shortcuts:update payload', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('shortcuts:update', {
      shortcuts: { save: 'Ctrl+S' },
      injected: 'malicious',
    });

    expect(mockShortcutsService.updateConfig).toHaveBeenCalledWith({
      shortcuts: { save: 'Ctrl+S' },
    });
  });

  it('strips unknown keys from action:create payload', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('action:create', {
      title: 'My Action',
      content: 'Hello world',
      injected: 'malicious',
    });

    expect(mockActionService.create).toHaveBeenCalledWith({
      title: 'My Action',
      content: 'Hello world',
    });
  });

  it('rejects action:create with empty title', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await expect(
      ipcMain._invoke('action:create', {
        title: '',
        content: 'Hello world',
      })
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });

    expect(mockActionService.create).not.toHaveBeenCalled();
  });

  it('strips unknown keys from action:update payload', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('action:update', 't1', {
      title: 'Updated',
      injected: 'malicious',
    });

    expect(mockActionService.update).toHaveBeenCalledWith('t1', {
      title: 'Updated',
    });
  });

  it('rejects action:reorder with negative order', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await expect(ipcMain._invoke('action:reorder', 't1', -1)).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });

    expect(mockActionService.reorder).not.toHaveBeenCalled();
  });

  it('rejects action:delete with empty id', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await expect(ipcMain._invoke('action:delete', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });

    expect(mockActionService.delete).not.toHaveBeenCalled();
  });

  it('strips unknown keys from action:record-usage payload', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('action:record-usage', {
      id: 'action-1',
      userInput: 'memo',
      injected: 'malicious',
    });

    expect(mockActionService.recordUsage).toHaveBeenCalledWith('action-1', 'memo', undefined);
  });

  it('passes a pasted usage through action:record-usage', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('action:record-usage', { id: 'action-1', pasted: true });
    expect(mockActionService.recordUsage).toHaveBeenCalledWith('action-1', undefined, true);
    await expect(
      ipcMain._invoke('action:record-usage', { id: 'action-1', pasted: 'yes' })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
  });

  it('passes unfocusedPaneDimOpacity and focusedPaneBorder through terminal update', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('customization:update-terminal', {
      unfocusedPaneDimOpacity: 0.5,
      focusedPaneBorder: true,
    });

    expect(mockCustomizationService.updateTerminal).toHaveBeenCalledWith({
      unfocusedPaneDimOpacity: 0.5,
      focusedPaneBorder: true,
    });
  });

  it('passes showPaneHeaders through terminal update', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('customization:update-terminal', { showPaneHeaders: false });

    expect(mockCustomizationService.updateTerminal).toHaveBeenCalledWith({
      showPaneHeaders: false,
    });
  });

  it('passes sendRightClickToPrograms through terminal update', async () => {
    const { registerCustomizationHandlers } =
      await import('../../../../src/main/ipc/handlers/customization.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerCustomizationHandlers();

    await ipcMain._invoke('customization:update-terminal', { sendRightClickToPrograms: true });

    expect(mockCustomizationService.updateTerminal).toHaveBeenCalledWith({
      sendRightClickToPrograms: true,
    });
  });
});
