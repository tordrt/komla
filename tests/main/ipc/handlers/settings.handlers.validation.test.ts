import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const mockResolveSettingsApproval = vi.fn();
const mockRequestPendingSettingsApproval = vi.fn();
vi.mock('../../../../src/main/services/http-server.service', () => ({
  httpServerService: {
    resolveSettingsApproval: mockResolveSettingsApproval,
    requestPendingSettingsApproval: mockRequestPendingSettingsApproval,
  },
}));

const mockRevertSettingsChange = vi.fn();
vi.mock('../../../../src/main/services/settings-history.service', () => ({
  settingsHistoryService: {
    onChange: vi.fn(),
    list: vi.fn(() => []),
    revert: mockRevertSettingsChange,
  },
}));
vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: { broadcastToAll: vi.fn() },
}));

describe('settings approval IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('passes a validated approval decision and renderer identity to the settings module', async () => {
    mockResolveSettingsApproval.mockReturnValue(true);
    const { registerSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/settings.handlers');
    registerSettingsHandlers();
    const handler = electronMock.ipcMain._getHandler('settings:approval-resolve');

    await expect(
      handler?.({ sender: { id: 42 } }, 'approval-1', 'apply')
    ).resolves.toBe(true);
    expect(mockResolveSettingsApproval).toHaveBeenCalledWith('approval-1', 'apply', 42);
  });

  it('requests the pending approval for the calling renderer', async () => {
    mockRequestPendingSettingsApproval.mockReturnValue(true);
    const { registerSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/settings.handlers');
    registerSettingsHandlers();
    const handler = electronMock.ipcMain._getHandler('settings:approval-request-pending');

    await expect(handler?.({ sender: { id: 42 } })).resolves.toBe(true);
    expect(mockRequestPendingSettingsApproval).toHaveBeenCalledWith(42);
  });

  it('rejects arguments on a pending approval request', async () => {
    const { registerSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/settings.handlers');
    registerSettingsHandlers();
    const handler = electronMock.ipcMain._getHandler('settings:approval-request-pending');

    await expect(
      Promise.resolve().then(() => handler?.({ sender: { id: 42 } }, 'unexpected'))
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockRequestPendingSettingsApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['   ', 'apply'],
    ['approval-1', 'yes'],
  ])('rejects invalid decision payloads', async (id, decision) => {
    const { registerSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/settings.handlers');
    registerSettingsHandlers();
    const handler = electronMock.ipcMain._getHandler('settings:approval-resolve');

    await expect(
      Promise.resolve().then(() => handler?.({ sender: { id: 42 } }, id, decision))
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockResolveSettingsApproval).not.toHaveBeenCalled();
  });

  it('reverts the settings change named by a validated id', async () => {
    mockRevertSettingsChange.mockReturnValue({ id: 'revert-1' });
    const { registerSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/settings.handlers');
    registerSettingsHandlers();
    const handler = electronMock.ipcMain._getHandler('settings:history-revert');

    expect(handler?.({ sender: { id: 42 } }, 'change-1')).toEqual({ id: 'revert-1' });
    expect(mockRevertSettingsChange).toHaveBeenCalledWith('change-1');
  });

  it.each([[[]], [['  ']], [[42]]])('rejects an invalid settings change id', async (args) => {
    const { registerSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/settings.handlers');
    registerSettingsHandlers();
    const handler = electronMock.ipcMain._getHandler('settings:history-revert');

    await expect(
      Promise.resolve().then(() => handler?.({ sender: { id: 42 } }, ...args))
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockRevertSettingsChange).not.toHaveBeenCalled();
  });
});
