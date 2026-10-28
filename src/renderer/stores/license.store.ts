import { create } from 'zustand';

import type {
  LicenseStatus,
  LicenseActivation,
  ActivationLimitError,
  WorkspaceQuota,
} from '../types';

interface LicenseState {
  status: LicenseStatus | null;
  isLoading: boolean;
  error: string | null;
  quota: WorkspaceQuota | null;
  activations: LicenseActivation[];
  activationsLoading: boolean;
  // For handling activation limit error
  pendingActivation: ActivationLimitError | null;

  loadStatus: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  activateLicense: (key: string) => Promise<boolean>;
  deactivateLicense: () => Promise<void>;
  loadQuota: () => Promise<void>;
  loadActivations: () => Promise<void>;
  revokeActivation: (activationId: string) => Promise<boolean>;
  revokeAndActivate: (activationId: string, licenseKey: string) => Promise<boolean>;
  clearPendingActivation: () => void;
  clearError: () => void;
}

function isActivationLimitError(
  result: LicenseStatus | ActivationLimitError
): result is ActivationLimitError {
  return 'error' in result && result.error === 'activation_limit_reached';
}

export const useLicenseStore = create<LicenseState>((set, get) => ({
  status: null,
  isLoading: false,
  error: null,
  quota: null,
  activations: [],
  activationsLoading: false,
  pendingActivation: null,

  loadStatus: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await window.api.getLicenseStatus();
      set({ status, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  refreshStatus: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await window.api.refreshLicenseStatus();
      set({ status, isLoading: false });
    } catch (error) {
      // Re-throw so the user-initiated refresh handler can toast the
      // failure. Without this, an offline refresh silently looked
      // successful even though the server was never reached.
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  activateLicense: async (key: string) => {
    set({ isLoading: true, error: null, pendingActivation: null });
    try {
      const result = await window.api.activateLicense(key);

      if (isActivationLimitError(result)) {
        // Store the activation limit error for the UI to handle
        set({ pendingActivation: result, isLoading: false });
        return false;
      }

      set({ status: result, isLoading: false });
      // Reload quota so UI immediately reflects licensed state
      const quota = await window.api.getWorkspaceQuota();
      set({ quota });
      // The service caches an expired monthly/yearly row so the user can
      // still reach the Billing Portal — but that's not a successful
      // activation. Only signal success when the resulting status is
      // actually entitled, so the UI doesn't toast "License activated"
      // over a lapsed subscription.
      if (result.isLicensed === true) {
        window.api.trackMonetizationEvent('license_activated').catch(() => {});
        return true;
      }
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  deactivateLicense: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await window.api.deactivateLicense();
      set({ status, isLoading: false, activations: [] });
      // Reload quota so UI immediately reflects unlicensed state
      const quota = await window.api.getWorkspaceQuota();
      set({ quota });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  loadQuota: async () => {
    try {
      const quota = await window.api.getWorkspaceQuota();
      set({ quota });
    } catch (error) {
      console.error('Failed to load workspace quota:', error);
    }
  },

  loadActivations: async () => {
    const { status } = get();
    if (!status?.licenseKey) {
      set({ activations: [] });
      return;
    }

    set({ activationsLoading: true });
    try {
      const result = await window.api.getActivations(status.licenseKey);
      set({ activations: result.activations, activationsLoading: false });
    } catch (error) {
      console.error('Failed to load activations:', error);
      set({ activationsLoading: false });
    }
  },

  revokeActivation: async (activationId: string) => {
    const { status } = get();
    if (!status?.licenseKey) return false;

    set({ activationsLoading: true });
    try {
      const result = await window.api.revokeActivation(activationId, status.licenseKey);
      if (result.success) {
        set({ activations: result.activations, activationsLoading: false });
        return true;
      }
      set({ activationsLoading: false });
      return false;
    } catch (error) {
      console.error('Failed to revoke activation:', error);
      set({ activationsLoading: false, error: (error as Error).message });
      return false;
    }
  },

  revokeAndActivate: async (activationId: string, licenseKey: string) => {
    set({ isLoading: true, error: null });
    try {
      // First revoke the selected activation
      const revokeResult = await window.api.revokeActivation(activationId, licenseKey);
      if (!revokeResult.success) {
        set({ isLoading: false, error: 'Failed to revoke activation' });
        return false;
      }

      // Then try to activate again
      const activateResult = await window.api.activateLicense(licenseKey);

      if (isActivationLimitError(activateResult)) {
        // Still at limit (shouldn't happen normally)
        set({ pendingActivation: activateResult, isLoading: false });
        return false;
      }

      set({ status: activateResult, isLoading: false, pendingActivation: null });
      // Reload quota
      const quota = await window.api.getWorkspaceQuota();
      set({ quota });
      if (activateResult.isLicensed === true) {
        window.api.trackMonetizationEvent('license_activated').catch(() => {});
        return true;
      }
      return false;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      return false;
    }
  },

  clearPendingActivation: () => {
    set({ pendingActivation: null });
  },

  clearError: () => {
    set({ error: null });
  },
}));
