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
import { handleIpc } from '../validation/ipc-validators';

export function registerLicenseHandlers(): void {
  handleIpc(IPC.LICENSE_GET_STATUS, async (): Promise<LicenseStatus> => {
    return licenseService.getStatus();
  });

  handleIpc(IPC.LICENSE_REFRESH_STATUS, async (): Promise<LicenseStatus> => {
    return licenseService.refreshLicenseStatus();
  });

  handleIpc(
    IPC.LICENSE_ACTIVATE,
    async (_, [key]): Promise<LicenseStatus | ActivationLimitError> => {
      return licenseService.activateLicense(key);
    }
  );

  handleIpc(IPC.LICENSE_DEACTIVATE, async (): Promise<LicenseStatus> => {
    return licenseService.deactivateLicense();
  });

  handleIpc(IPC.LICENSE_GET_WORKSPACE_QUOTA, async (): Promise<WorkspaceQuota> => {
    return licenseService.getWorkspaceQuota(workspaceService.getRunningRemoteWorkspaceCount());
  });

  handleIpc(
    IPC.LICENSE_GET_ACTIVATIONS,
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
  );

  handleIpc(
    IPC.LICENSE_REVOKE_ACTIVATION,
    async (
      _,
      [activationId, licenseKey]
    ): Promise<{
      success: boolean;
      activations: LicenseActivation[];
    }> => {
      return licenseService.revokeActivation(activationId, licenseKey);
    }
  );

  handleIpc(
    IPC.LICENSE_OPEN_BILLING_PORTAL,
    async (): Promise<{ url: string } | { error: string }> => {
      return licenseService.getBillingPortalUrl();
    }
  );

  handleIpc(IPC.LICENSE_GET_PRICES, async (): Promise<PlanPrices | null> => {
    return licenseService.getPlanPrices();
  });
}
