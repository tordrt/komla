import {
  ArrowSquareOut,
  Laptop,
  Monitor as MonitorIcon,
  Terminal,
  ArrowClockwise,
} from '@phosphor-icons/react';
import { useState, useEffect } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useLicenseStore } from '@/stores/license.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { takesFreeSshSlot } from '@/types';

import { FormError } from './FormError';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

import type { UpgradeDialogRequest } from '@/utils/workspace-error';

/** Opens the Komla Unlimited offer, the same dialog the sidebar's quota opens. */
function openUpgradeOffer() {
  window.dispatchEvent(
    new CustomEvent<UpgradeDialogRequest>('show-upgrade-dialog', {
      detail: { trigger: 'settings' },
    })
  );
}

interface LicenseTabProps {
  onClose: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function LicenseTab({ onClose: _onClose, onDirtyChange: _onDirtyChange }: LicenseTabProps) {
  // Until the quota loads, count what it counts: SSH workspaces on their hosts or being created.
  const runningCount = useWorkspacesStore((s) => s.workspaces.filter(takesFreeSshSlot).length);
  const {
    quota,
    status: licenseStatus,
    isLoading: licenseLoading,
    error: licenseError,
    loadStatus: loadLicenseStatus,
    refreshStatus: refreshLicenseStatus,
    activateLicense,
    deactivateLicense,
    activations,
    activationsLoading,
    loadActivations,
    revokeActivation,
    revokeAndActivate,
    pendingActivation,
    clearPendingActivation,
    clearError,
  } = useLicenseStore();
  const addToast = useToastStore((s) => s.addToast);

  const [licenseKey, setLicenseKey] = useState('');
  const [selectedRevocationId, setSelectedRevocationId] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // A stored monthly/yearly license counts as a subscription even when
  // validUntil has lapsed — we keep the row cached so the user can still
  // reach the Stripe Portal to update payment / reactivate.
  const hasStoredSubscription =
    !!licenseStatus?.licenseKey &&
    (licenseStatus.licenseType === 'monthly' || licenseStatus.licenseType === 'yearly');
  const subscriptionExpired = hasStoredSubscription && !licenseStatus?.isLicensed;
  const showLicensedActions = !!licenseStatus?.isLicensed || hasStoredSubscription;

  // Load license status and activations on mount
  useEffect(() => {
    void loadLicenseStatus();
  }, [loadLicenseStatus]);

  // Load activations when licensed
  useEffect(() => {
    if (licenseStatus?.isLicensed) {
      void loadActivations();
    }
  }, [licenseStatus?.isLicensed, loadActivations]);

  // Auto-select oldest activation when pending activation dialog shows
  useEffect(() => {
    if (pendingActivation?.activations && pendingActivation.activations.length > 0) {
      const sorted = [...pendingActivation.activations].sort(
        (a, b) => new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime()
      );
      setSelectedRevocationId(sorted[0].id);
    }
  }, [pendingActivation]);

  const handleActivate = async () => {
    clearError();
    const success = await activateLicense(licenseKey);
    if (success) {
      addToast('License activated', 'success');
      setLicenseKey('');
    }
  };

  const handleDeactivate = async () => {
    await deactivateLicense();
    addToast('License deactivated', 'success');
    setLicenseKey('');
  };

  const handleOpenBillingPortal = async () => {
    setOpeningPortal(true);
    try {
      const result = await window.api.openBillingPortal();
      if ('url' in result) {
        await window.api.openExternal(result.url);
      } else {
        addToast(`Couldn't open billing portal (${result.error})`, 'error');
      }
    } catch (err) {
      addToast(`Couldn't open billing portal: ${(err as Error).message}`, 'error');
    } finally {
      setOpeningPortal(false);
    }
  };

  const handleRevokeAndActivate = async () => {
    if (selectedRevocationId) {
      const success = await revokeAndActivate(selectedRevocationId, licenseKey);
      if (success) {
        addToast('License activated', 'success');
        setSelectedRevocationId(null);
        setLicenseKey('');
      }
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshLicenseStatus();
      addToast('License status updated', 'success');
    } catch (err) {
      addToast(`Refresh failed: ${(err as Error).message}`, 'error');
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* License Status */}
      <SettingsCard
        title="Plan"
        action={
          <IconButton
            label="Refresh license status from server"
            size="md"
            onClick={handleRefresh}
            disabled={isRefreshing || licenseLoading}
          >
            <ArrowClockwise
              className={cn('size-4', isRefreshing && 'animate-spin')}
              weight="bold"
            />
          </IconButton>
        }
      >
        {/* Current status */}
        <dl className="space-y-2 text-[13px]">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Status</dt>
            <dd
              className={cn(
                'font-medium',
                licenseStatus?.isLicensed
                  ? 'text-success'
                  : subscriptionExpired
                    ? 'text-warning'
                    : 'text-foreground'
              )}
            >
              {licenseStatus?.isLicensed
                ? 'Licensed'
                : subscriptionExpired
                  ? 'Subscription expired'
                  : 'Free'}
            </dd>
          </div>
          {licenseStatus?.licenseType && (
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Plan</dt>
              <dd className="font-medium">
                {licenseStatus.licenseType === 'lifetime'
                  ? 'Lifetime'
                  : licenseStatus.licenseType === 'yearly'
                    ? 'Yearly'
                    : 'Monthly'}
              </dd>
            </div>
          )}
          {licenseStatus?.validUntil &&
            (licenseStatus.licenseType === 'monthly' || licenseStatus.licenseType === 'yearly') && (
              <div className="flex items-center justify-between">
                <dt
                  className={
                    licenseStatus.isLicensed && licenseStatus.cancelAtPeriodEnd
                      ? 'text-error'
                      : 'text-muted-foreground'
                  }
                >
                  {!licenseStatus.isLicensed
                    ? 'Expired'
                    : licenseStatus.cancelAtPeriodEnd
                      ? 'Ends'
                      : 'Next charge'}
                </dt>
                <dd
                  className={cn(
                    'font-medium',
                    licenseStatus.isLicensed && licenseStatus.cancelAtPeriodEnd && 'text-error'
                  )}
                >
                  {new Date(licenseStatus.validUntil).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </dd>
              </div>
            )}
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Running SSH workspaces</dt>
            <dd className="font-medium tabular-nums">
              {licenseStatus?.isLicensed
                ? 'Unlimited'
                : `${quota?.count ?? runningCount} of ${quota?.limit ?? 4}`}
            </dd>
          </div>
          {showLicensedActions && licenseStatus?.licenseKey && (
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">License key</dt>
              <dd className="font-mono font-medium">
                {'····' + licenseStatus.licenseKey.slice(-4)}
              </dd>
            </div>
          )}
        </dl>

        {showLicensedActions ? (
          <div className="space-y-3">
            {subscriptionExpired && (
              <p className="text-[13px] text-muted-foreground">
                Your subscription has lapsed. Open the billing portal to update your payment method
                and restore access.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {hasStoredSubscription && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenBillingPortal}
                  disabled={openingPortal}
                >
                  {openingPortal ? (
                    <>
                      <Spinner size="md" className="mr-2" />
                      Opening...
                    </>
                  ) : (
                    <>
                      Manage subscription
                      <ArrowSquareOut weight="bold" className="ml-1.5 size-3.5" />
                    </>
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDeactivate}
                disabled={licenseLoading}
              >
                {licenseLoading ? (
                  <>
                    <Spinner size="md" className="mr-2" />
                    Deactivating...
                  </>
                ) : (
                  'Deactivate license'
                )}
              </Button>
            </div>
            <FormError message={licenseError} />
          </div>
        ) : (
          <SettingsRow
            label="Komla Unlimited"
            description="Run unlimited SSH workspaces in parallel, and fund Komla’s development."
          >
            <Button size="sm" onClick={openUpgradeOffer}>
              Go unlimited
            </Button>
          </SettingsRow>
        )}

        {!showLicensedActions && (
          <div className="grid gap-1.5">
            <label htmlFor="license-key" className="text-[13px] font-medium">
              License key
            </label>
            <div className="flex gap-2">
              <Input
                id="license-key"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.nativeEvent.isComposing &&
                    licenseKey.trim() &&
                    !licenseLoading
                  ) {
                    void handleActivate();
                  }
                }}
                placeholder="Enter your license key"
                className="font-mono"
              />
              <Button
                variant="outline"
                className="shrink-0"
                onClick={handleActivate}
                disabled={licenseLoading || !licenseKey.trim()}
              >
                {licenseLoading ? (
                  <>
                    <Spinner size="md" className="mr-2" />
                    Activating...
                  </>
                ) : (
                  'Activate'
                )}
              </Button>
            </div>
            <FormError message={licenseError} />
          </div>
        )}
      </SettingsCard>

      {/* Active Machines — always visible when licensed */}
      {licenseStatus?.isLicensed && (
        <SettingsCard
          title="Active machines"
          description={`This license is active on ${activations.length} of 3 machines.`}
        >
          {activationsLoading ? (
            <p className="text-[13px] text-muted-foreground">Loading...</p>
          ) : activations.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No active machines</p>
          ) : (
            activations.map((activation) => (
              <div key={activation.id} className="flex items-center justify-between gap-3 !py-3">
                <div className="flex min-w-0 items-center gap-3">
                  {activation.platform === 'darwin' ? (
                    <Laptop className="size-4 shrink-0 text-muted-foreground" />
                  ) : activation.platform === 'win32' ? (
                    <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Terminal className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {activation.machineName || 'Unknown'}
                      {activation.isCurrent && (
                        <Badge tone="primary" size="md" shape="square">
                          This machine
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last seen {new Date(activation.lastSeen).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    if (activation.isCurrent) {
                      await deactivateLicense();
                      addToast('License deactivated', 'success');
                      setLicenseKey('');
                    } else {
                      await revokeActivation(activation.id);
                      addToast('Machine revoked', 'success');
                    }
                  }}
                  disabled={activationsLoading}
                >
                  Revoke
                </Button>
              </div>
            ))
          )}
        </SettingsCard>
      )}

      {/* Activation Limit Dialog */}
      {pendingActivation && (
        <div className="space-y-2.5 rounded-md border border-warning/40 bg-warning/10 px-3.5 py-3">
          <div className="flex items-center gap-1.5">
            <Laptop className="size-3.5 text-warning" />
            <h4 className="text-[13px] font-medium text-warning">Activation Limit Reached</h4>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Your license is active on {pendingActivation.activationsUsed} machines. Revoke one to
            activate on this machine.
          </p>
          <div className="space-y-1.5">
            {pendingActivation.activations.map((activation) => (
              <label
                key={activation.id}
                className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
                  selectedRevocationId === activation.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="revocation"
                  checked={selectedRevocationId === activation.id}
                  onChange={() => setSelectedRevocationId(activation.id)}
                  className="sr-only"
                />
                <div
                  className={`flex size-4 items-center justify-center rounded-full border-2 ${
                    selectedRevocationId === activation.id
                      ? 'border-primary'
                      : 'border-muted-foreground'
                  }`}
                >
                  {selectedRevocationId === activation.id && (
                    <div className="size-2 rounded-full bg-primary" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{activation.machineName || 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground">
                    {activation.platform === 'darwin'
                      ? 'macOS'
                      : activation.platform === 'win32'
                        ? 'Windows'
                        : activation.platform === 'linux'
                          ? 'Linux'
                          : activation.platform}{' '}
                    &middot; Last seen: {new Date(activation.lastSeen).toLocaleDateString()}
                  </p>
                </div>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                clearPendingActivation();
                setSelectedRevocationId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={handleRevokeAndActivate}
              disabled={!selectedRevocationId || licenseLoading}
            >
              {licenseLoading ? (
                <>
                  <Spinner size="md" className="mr-2" />
                  Activating...
                </>
              ) : (
                'Revoke & Activate'
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
