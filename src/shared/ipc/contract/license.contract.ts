import { IPC } from '../../constants/ipc-channels';
import {
  licenseActivateArgsSchema,
  licenseGetActivationsArgsSchema,
  licenseRevokeActivationArgsSchema,
} from '../schemas/license-ipc.schemas';

import { invoke } from './define';

import type {
  ActivationLimitError,
  LicenseActivation,
  LicenseStatus,
  PlanPrices,
  WorkspaceQuota,
} from '../../../renderer/types';

export const licenseContract = {
  [IPC.LICENSE_GET_STATUS]: invoke().returns<LicenseStatus>(),
  [IPC.LICENSE_REFRESH_STATUS]: invoke().returns<LicenseStatus>(),
  [IPC.LICENSE_ACTIVATE]: invoke(licenseActivateArgsSchema).returns<
    LicenseStatus | ActivationLimitError
  >(),
  [IPC.LICENSE_DEACTIVATE]: invoke().returns<LicenseStatus>(),
  [IPC.LICENSE_GET_WORKSPACE_QUOTA]: invoke().returns<WorkspaceQuota>(),
  [IPC.LICENSE_GET_ACTIVATIONS]: invoke(licenseGetActivationsArgsSchema).returns<{
    activations: LicenseActivation[];
    activationsUsed: number;
    maxActivations: number;
  }>(),
  [IPC.LICENSE_REVOKE_ACTIVATION]: invoke(licenseRevokeActivationArgsSchema).returns<{
    success: boolean;
    activations: LicenseActivation[];
  }>(),
  [IPC.LICENSE_OPEN_BILLING_PORTAL]: invoke().returns<{ url: string } | { error: string }>(),
  [IPC.LICENSE_GET_PRICES]: invoke().returns<PlanPrices | null>(),
} as const;
