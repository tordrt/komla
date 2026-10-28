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

type IpcMainWithInvoke = { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };

async function setup() {
  const { registerCustomizationHandlers } =
    await import('../../../../src/main/ipc/handlers/customization.handlers');
  const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMainWithInvoke };
  registerCustomizationHandlers();
  return ipcMain;
}

describe('customization IPC behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('customization:get-theme delegates to customizationService.getTheme', async () => {
    const ipcMain = await setup();
    const theme = { mode: 'dark', colors: { accent: '#ff0000' } };
    mockCustomizationService.getTheme.mockResolvedValue(theme);

    const result = await ipcMain._invoke('customization:get-theme');

    expect(mockCustomizationService.getTheme).toHaveBeenCalledOnce();
    expect(result).toEqual(theme);
  });

  it('customization:get-terminal delegates to customizationService.getTerminal', async () => {
    const ipcMain = await setup();
    const terminal = { font: { family: 'Menlo', size: 14 } };
    mockCustomizationService.getTerminal.mockResolvedValue(terminal);

    const result = await ipcMain._invoke('customization:get-terminal');

    expect(mockCustomizationService.getTerminal).toHaveBeenCalledOnce();
    expect(result).toEqual(terminal);
  });

  it('customization:update-theme passes validated updates to customizationService.updateTheme', async () => {
    const ipcMain = await setup();
    const updates = { mode: 'dark' as const, colors: { accent: '#00ff00' } };
    mockCustomizationService.updateTheme.mockResolvedValue(updates);

    const result = await ipcMain._invoke('customization:update-theme', updates);

    expect(mockCustomizationService.updateTheme).toHaveBeenCalledWith(updates);
    expect(result).toEqual(updates);
  });

  it('customization:update-terminal passes validated updates to customizationService.updateTerminal', async () => {
    const ipcMain = await setup();
    const updates = { font: { family: 'Monaco', size: 12 }, scrollback: 5000 };
    mockCustomizationService.updateTerminal.mockResolvedValue(updates);

    const result = await ipcMain._invoke('customization:update-terminal', updates);

    expect(mockCustomizationService.updateTerminal).toHaveBeenCalledWith(updates);
    expect(result).toEqual(updates);
  });

  it('customization:reset-theme delegates to customizationService.resetTheme', async () => {
    const ipcMain = await setup();
    mockCustomizationService.resetTheme.mockResolvedValue(undefined);

    await ipcMain._invoke('customization:reset-theme');

    expect(mockCustomizationService.resetTheme).toHaveBeenCalledOnce();
  });

  it('shortcuts:get delegates to shortcutsService.getConfig', async () => {
    const ipcMain = await setup();
    const config = { shortcuts: { save: 'Ctrl+S' } };
    mockShortcutsService.getConfig.mockResolvedValue(config);

    const result = await ipcMain._invoke('shortcuts:get');

    expect(mockShortcutsService.getConfig).toHaveBeenCalledOnce();
    expect(result).toEqual(config);
  });

  it('shortcuts:update passes validated updates to shortcutsService.updateConfig', async () => {
    const ipcMain = await setup();
    const updates = { shortcuts: { save: 'Ctrl+Shift+S' } };
    mockShortcutsService.updateConfig.mockResolvedValue(updates);

    const result = await ipcMain._invoke('shortcuts:update', updates);

    expect(mockShortcutsService.updateConfig).toHaveBeenCalledWith(updates);
    expect(result).toEqual(updates);
  });

  it('shortcuts:reset delegates to shortcutsService.resetConfig', async () => {
    const ipcMain = await setup();
    mockShortcutsService.resetConfig.mockResolvedValue(undefined);

    await ipcMain._invoke('shortcuts:reset');

    expect(mockShortcutsService.resetConfig).toHaveBeenCalledOnce();
  });

  it('action:list delegates to actionService.list', async () => {
    const ipcMain = await setup();
    const actions = [{ id: 't1', title: 'Action 1' }];
    mockActionService.list.mockResolvedValue(actions);

    const result = await ipcMain._invoke('action:list');

    expect(mockActionService.list).toHaveBeenCalledOnce();
    expect(result).toEqual(actions);
  });

  it('action:create passes validated params to actionService.create', async () => {
    const ipcMain = await setup();
    const params = { title: 'New Action', content: 'Hello {{name}}' };
    const created = { id: 't1', ...params };
    mockActionService.create.mockResolvedValue(created);

    const result = await ipcMain._invoke('action:create', params);

    expect(mockActionService.create).toHaveBeenCalledWith(params);
    expect(result).toEqual(created);
  });

  it('action:update passes id and updates to actionService.update', async () => {
    const ipcMain = await setup();
    const updates = { title: 'Updated Title' };
    const updated = { id: 't1', title: 'Updated Title', content: 'Hello' };
    mockActionService.update.mockResolvedValue(updated);

    const result = await ipcMain._invoke('action:update', 't1', updates);

    expect(mockActionService.update).toHaveBeenCalledWith('t1', updates);
    expect(result).toEqual(updated);
  });

  it('action:reorder passes id and new order to actionService.reorder', async () => {
    const ipcMain = await setup();
    mockActionService.reorder.mockResolvedValue(undefined);

    await ipcMain._invoke('action:reorder', 't1', 2);

    expect(mockActionService.reorder).toHaveBeenCalledWith('t1', 2);
  });

  it('action:delete passes id to actionService.delete', async () => {
    const ipcMain = await setup();
    mockActionService.delete.mockResolvedValue(undefined);

    await ipcMain._invoke('action:delete', 't1');

    expect(mockActionService.delete).toHaveBeenCalledWith('t1');
  });

  it('action:record-usage extracts id and userInput from params object', async () => {
    const ipcMain = await setup();
    mockActionService.recordUsage.mockResolvedValue({ id: 't1', lastUsedAt: 123 });

    const result = await ipcMain._invoke('action:record-usage', {
      id: 'action-1',
      userInput: 'saved',
    });

    expect(mockActionService.recordUsage).toHaveBeenCalledWith('action-1', 'saved', undefined);
    expect(result).toEqual({ id: 't1', lastUsedAt: 123 });
  });
});
