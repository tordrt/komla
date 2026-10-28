import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockLicenseService = {
  getStatus: vi.fn(() => ({ isLicensed: false, key: null, activatedAt: null })),
  activateLicense: vi.fn(),
  deactivateLicense: vi.fn(),
  getWorkspaceQuota: vi.fn(() => ({ used: 2, limit: 4, isLicensed: false })),
  getActivations: vi.fn(),
  revokeActivation: vi.fn(),
};

const mockWorkspaceService = {
  list: vi.fn(() => [{ id: 'ws-1' }, { id: 'ws-2' }]),
  getRunningRemoteWorkspaceCount: vi.fn(() => 1),
};

vi.mock('../../../../src/main/services/license.service', () => ({
  licenseService: mockLicenseService,
}));

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));

describe('license IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('rejects empty activation key for license:activate', async () => {
    const { registerLicenseHandlers } =
      await import('../../../../src/main/ipc/handlers/license.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerLicenseHandlers();

    await expect(ipcMain._invoke('license:activate', '   ')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockLicenseService.activateLicense).not.toHaveBeenCalled();
  });

  it('passes workspace count through for license:get-workspace-quota', async () => {
    const { registerLicenseHandlers } =
      await import('../../../../src/main/ipc/handlers/license.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerLicenseHandlers();
    await expect(ipcMain._invoke('license:get-workspace-quota')).resolves.toEqual({
      used: 2,
      limit: 4,
      isLicensed: false,
    });

    expect(mockLicenseService.getWorkspaceQuota).toHaveBeenCalledWith(1);
  });

  it('rejects invalid license key for license:get-activations', async () => {
    const { registerLicenseHandlers } =
      await import('../../../../src/main/ipc/handlers/license.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerLicenseHandlers();

    await expect(ipcMain._invoke('license:get-activations', '   ')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockLicenseService.getActivations).not.toHaveBeenCalled();
  });

  it('calls service for valid license:get-activations', async () => {
    const activationResult = {
      activations: [{ id: 'act-1' }],
      activationsUsed: 1,
      maxActivations: 3,
    };
    mockLicenseService.getActivations.mockResolvedValueOnce(activationResult);

    const { registerLicenseHandlers } =
      await import('../../../../src/main/ipc/handlers/license.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerLicenseHandlers();
    await expect(ipcMain._invoke('license:get-activations', 'license-key')).resolves.toEqual(
      activationResult
    );
    expect(mockLicenseService.getActivations).toHaveBeenCalledWith('license-key');
  });

  it('rejects invalid payload for license:revoke-activation', async () => {
    const { registerLicenseHandlers } =
      await import('../../../../src/main/ipc/handlers/license.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerLicenseHandlers();

    await expect(
      ipcMain._invoke('license:revoke-activation', '   ', 'license-key')
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockLicenseService.revokeActivation).not.toHaveBeenCalled();
  });

  it('calls service for valid license:revoke-activation', async () => {
    const revokeResult = {
      success: true,
      activations: [{ id: 'act-2' }],
    };
    mockLicenseService.revokeActivation.mockResolvedValueOnce(revokeResult);

    const { registerLicenseHandlers } =
      await import('../../../../src/main/ipc/handlers/license.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerLicenseHandlers();
    await expect(
      ipcMain._invoke('license:revoke-activation', 'act-2', 'license-key')
    ).resolves.toEqual(revokeResult);
    expect(mockLicenseService.revokeActivation).toHaveBeenCalledWith('act-2', 'license-key');
  });
});
