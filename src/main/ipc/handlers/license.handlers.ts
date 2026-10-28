import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import {
  licenseService,
  LicenseStatus,
  LicenseActivation,
  PlanPrices,
  WorkspaceQuota,
  ActivationLimitError,
} from '../../services/license.service';
import { workspaceService } from '../../services/workspace.service';
import { handleValidated } from '../validation/ipc-validators';
import {
  licenseActivateArgsSchema,
  licenseGetActivationsArgsSchema,
  licenseRevokeActivationArgsSchema,
} from '../validation/license-ipc.schemas';

export function registerLicenseHandlers(): void {
  ipcMain.handle(IPC.LICENSE_GET_STATUS, async (): Promise<LicenseStatus> => {
    return licenseService.getStatus();
  });

  ipcMain.handle(IPC.LICENSE_REFRESH_STATUS, async (): Promise<LicenseStatus> => {
    return licenseService.refreshLicenseStatus();
  });

  ipcMain.handle(
    IPC.LICENSE_ACTIVATE,
    handleValidated(
      IPC.LICENSE_ACTIVATE,
      licenseActivateArgsSchema,
      async (_, [key]): Promise<LicenseStatus | ActivationLimitError> => {
        return licenseService.activateLicense(key);
      }
    )
  );

  ipcMain.handle(IPC.LICENSE_DEACTIVATE, async (): Promise<LicenseStatus> => {
    return licenseService.deactivateLicense();
  });

  ipcMain.handle(IPC.LICENSE_GET_WORKSPACE_QUOTA, async (): Promise<WorkspaceQuota> => {
    return licenseService.getWorkspaceQuota(workspaceService.getRunningRemoteWorkspaceCount());
  });

  ipcMain.handle(
    IPC.LICENSE_GET_ACTIVATIONS,
    handleValidated(
      IPC.LICENSE_GET_ACTIVATIONS,
      licenseGetActivationsArgsSchema,
      async (
        _,
        [licenseKey]
      ): Promise<{
        activations: LicenseActivation[];
        activationsUsed: number;
        maxActivations: number;
      }> => {
        return licenseService.getActivations(licenseKey);
      }
    )
  );

  ipcMain.handle(
    IPC.LICENSE_REVOKE_ACTIVATION,
    handleValidated(
      IPC.LICENSE_REVOKE_ACTIVATION,
      licenseRevokeActivationArgsSchema,
      async (
        _,
        [activationId, licenseKey]
      ): Promise<{
        success: boolean;
        activations: LicenseActivation[];
      }> => {
        return licenseService.revokeActivation(activationId, licenseKey);
      }
    )
  );

  ipcMain.handle(
    IPC.LICENSE_OPEN_BILLING_PORTAL,
    async (): Promise<{ url: string } | { error: string }> => {
      return licenseService.getBillingPortalUrl();
    }
  );

  ipcMain.handle(IPC.LICENSE_GET_PRICES, async (): Promise<PlanPrices | null> => {
    return licenseService.getPlanPrices();
  });
}
