import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLicenseStore } from '../../../src/renderer/stores/license.store';

function resetStore(): void {
  useLicenseStore.setState(useLicenseStore.getInitialState(), true);
}

const mockStatus = { isLicensed: true, licenseKey: 'key-123', plan: 'pro' };
const mockQuota = { allowed: true, count: 3, limit: 4, isLicensed: false };

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    getLicenseStatus: vi.fn().mockResolvedValue(mockStatus),
    activateLicense: vi.fn().mockResolvedValue(mockStatus),
    deactivateLicense: vi.fn().mockResolvedValue({ isLicensed: false, licenseKey: null }),
    getWorkspaceQuota: vi.fn().mockResolvedValue(mockQuota),
    getActivations: vi.fn().mockResolvedValue({ activations: [{ id: 'act-1' }, { id: 'act-2' }] }),
    revokeActivation: vi.fn().mockResolvedValue({ success: true, activations: [{ id: 'act-2' }] }),
    trackMonetizationEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    api,
    localStorage: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
    },
  };
  return api;
}

describe('license.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadStatus fetches license status', async () => {
    await useLicenseStore.getState().loadStatus();
    expect(useLicenseStore.getState().status).toEqual(mockStatus);
    expect(useLicenseStore.getState().isLoading).toBe(false);
  });

  it('loadStatus handles errors', async () => {
    mockApi({ getLicenseStatus: vi.fn().mockRejectedValue(new Error('Network')) });
    await useLicenseStore.getState().loadStatus();
    expect(useLicenseStore.getState().error).toBe('Network');
  });

  it('activateLicense succeeds and reloads quota', async () => {
    const api = mockApi();
    const result = await useLicenseStore.getState().activateLicense('key-123');
    expect(result).toBe(true);
    expect(useLicenseStore.getState().status).toEqual(mockStatus);
    expect(useLicenseStore.getState().quota).toEqual(mockQuota);
    expect(api.trackMonetizationEvent).toHaveBeenCalledWith('license_activated');
  });

  it('activateLicense handles activation limit error', async () => {
    const limitError = {
      error: 'activation_limit_reached',
      activations: [{ id: 'act-1' }],
      limit: 2,
    };
    mockApi({ activateLicense: vi.fn().mockResolvedValue(limitError) });
    const result = await useLicenseStore.getState().activateLicense('key-123');
    expect(result).toBe(false);
    expect(useLicenseStore.getState().pendingActivation).toEqual(limitError);
  });

  it('activateLicense handles errors', async () => {
    mockApi({ activateLicense: vi.fn().mockRejectedValue(new Error('Invalid key')) });
    const result = await useLicenseStore.getState().activateLicense('bad-key');
    expect(result).toBe(false);
    expect(useLicenseStore.getState().error).toBe('Invalid key');
  });

  it('refreshStatus rethrows on network failure so the UI can toast Refresh failed', async () => {
    // Without rethrowing, an offline refresh silently looked successful —
    // the LicenseTab's handleRefresh would still toast "License status
    // updated" because no exception bubbled out of the action.
    mockApi({ refreshLicenseStatus: vi.fn().mockRejectedValue(new Error('Network down')) });
    await expect(useLicenseStore.getState().refreshStatus()).rejects.toThrow('Network down');
    expect(useLicenseStore.getState().error).toBe('Network down');
    expect(useLicenseStore.getState().isLoading).toBe(false);
  });

  it('activateLicense returns false when service caches an expired subscription', async () => {
    // The service caches an expired monthly/yearly key so the user can still
    // reach the Stripe Portal, but that's not an entitlement. The store must
    // not signal success — otherwise the UI toasts "License activated" over a
    // lapsed subscription.
    const expiredCached = {
      isLicensed: false,
      licenseKey: 'key-123',
      licenseType: 'monthly',
      validUntil: '2024-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    };
    mockApi({ activateLicense: vi.fn().mockResolvedValue(expiredCached) });
    const result = await useLicenseStore.getState().activateLicense('key-123');
    expect(result).toBe(false);
    // Status still updates so the UI can show the lapsed-with-portal state.
    expect(useLicenseStore.getState().status).toEqual(expiredCached);
  });

  it('deactivateLicense clears status and reloads quota', async () => {
    useLicenseStore.setState({ status: mockStatus as any, activations: [{ id: 'act-1' }] as any });
    await useLicenseStore.getState().deactivateLicense();
    expect(useLicenseStore.getState().status).toEqual({ isLicensed: false, licenseKey: null });
    expect(useLicenseStore.getState().activations).toEqual([]);
    expect(useLicenseStore.getState().quota).toEqual(mockQuota);
  });

  it('deactivateLicense handles errors', async () => {
    mockApi({ deactivateLicense: vi.fn().mockRejectedValue(new Error('Deactivation failed')) });
    await useLicenseStore.getState().deactivateLicense();
    expect(useLicenseStore.getState().error).toBe('Deactivation failed');
  });

  it('loadQuota fetches workspace quota', async () => {
    await useLicenseStore.getState().loadQuota();
    expect(useLicenseStore.getState().quota).toEqual(mockQuota);
  });

  it('loadActivations fetches activations when license key exists', async () => {
    useLicenseStore.setState({ status: mockStatus as any });
    await useLicenseStore.getState().loadActivations();
    expect(useLicenseStore.getState().activations).toEqual([{ id: 'act-1' }, { id: 'act-2' }]);
  });

  it('loadActivations clears when no license key', async () => {
    useLicenseStore.setState({ status: { isLicensed: false, licenseKey: null } as any });
    await useLicenseStore.getState().loadActivations();
    expect(useLicenseStore.getState().activations).toEqual([]);
  });

  it('revokeActivation removes activation from list', async () => {
    useLicenseStore.setState({ status: mockStatus as any });
    const result = await useLicenseStore.getState().revokeActivation('act-1');
    expect(result).toBe(true);
    expect(useLicenseStore.getState().activations).toEqual([{ id: 'act-2' }]);
  });

  it('revokeActivation returns false without license key', async () => {
    const result = await useLicenseStore.getState().revokeActivation('act-1');
    expect(result).toBe(false);
  });

  it('revokeActivation handles unsuccessful result', async () => {
    useLicenseStore.setState({ status: mockStatus as any });
    mockApi({ revokeActivation: vi.fn().mockResolvedValue({ success: false }) });
    const result = await useLicenseStore.getState().revokeActivation('act-1');
    expect(result).toBe(false);
  });

  it('revokeAndActivate revokes then activates', async () => {
    const result = await useLicenseStore.getState().revokeAndActivate('act-1', 'key-123');
    expect(result).toBe(true);
    expect(useLicenseStore.getState().status).toEqual(mockStatus);
    expect(useLicenseStore.getState().pendingActivation).toBeNull();
    expect(useLicenseStore.getState().quota).toEqual(mockQuota);
  });

  it('revokeAndActivate fails when revoke fails', async () => {
    mockApi({ revokeActivation: vi.fn().mockResolvedValue({ success: false }) });
    const result = await useLicenseStore.getState().revokeAndActivate('act-1', 'key-123');
    expect(result).toBe(false);
    expect(useLicenseStore.getState().error).toBe('Failed to revoke activation');
  });

  it('clearPendingActivation clears pending activation', () => {
    useLicenseStore.setState({ pendingActivation: { error: 'activation_limit_reached' } as any });
    useLicenseStore.getState().clearPendingActivation();
    expect(useLicenseStore.getState().pendingActivation).toBeNull();
  });

  it('clearError clears error', () => {
    useLicenseStore.setState({ error: 'some error' });
    useLicenseStore.getState().clearError();
    expect(useLicenseStore.getState().error).toBeNull();
  });
});
