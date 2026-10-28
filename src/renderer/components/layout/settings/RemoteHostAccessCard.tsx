import { CheckCircle, Warning } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useToastStore } from '@/stores/toast.store';

import { SettingsCard } from './SettingsCard';

import type { RemoteControlHostAccessStatus } from '@/types';

/** The address a host's phone server is published at, as `name.tailnet.ts.net[:port]`. */
export function hostAccessAddress(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function StatusLine({ status }: { status: RemoteControlHostAccessStatus }) {
  switch (status.state) {
    case 'off':
      return <span>Off</span>;
    case 'setting-up':
      return (
        <span className="flex items-center gap-1.5">
          <Spinner className="size-3" />
          Setting up…
        </span>
      );
    case 'pending':
      return <span>{status.message ?? 'Finishes the next time Komla connects to this host.'}</span>;
    case 'ready': {
      const address = hostAccessAddress(status.url);
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <CheckCircle weight="fill" className="size-3 shrink-0 text-success" />
          {address ? (
            <span className="truncate">
              Ready at <span className="font-mono">{address}</span>
            </span>
          ) : (
            'Ready'
          )}
        </span>
      );
    }
    case 'needs-attention':
      return (
        <span className="flex items-start gap-1.5">
          <Warning weight="fill" className="mt-0.5 size-3 shrink-0 text-warning" />
          <span>{status.message ?? 'Direct access is not set up on this host.'}</span>
        </span>
      );
  }
}

/** The SSH hosts paired devices may open directly, and a way to turn that on per host. */
export function useHostAccess() {
  const addToast = useToastStore((s) => s.addToast);
  const [statuses, setStatuses] = useState<RemoteControlHostAccessStatus[]>([]);
  const [busyHostId, setBusyHostId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.remoteControlHostAccessList().then((list) => {
      if (!cancelled) setStatuses(list);
    });
    const off = window.api.onRemoteControlHostAccessChanged((list) => setStatuses(list));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const setEnabled = async (hostId: string, enabled: boolean) => {
    setBusyHostId(hostId);
    try {
      await window.api.remoteControlHostAccessSet(hostId, enabled);
    } catch (err) {
      addToast(`Could not change direct access: ${(err as Error).message}`, 'error');
    } finally {
      setBusyHostId(null);
    }
  };

  return { statuses, busyHostId, setEnabled };
}

/** Per-host switches for the Remote Companion's phone server (ADR 0005). */
export function RemoteHostAccessCard({ remoteEnabled }: { remoteEnabled: boolean }) {
  const { statuses, busyHostId, setEnabled } = useHostAccess();

  if (statuses.length === 0) return null;

  return (
    <SettingsCard
      title="SSH hosts"
      action={
        statuses.some((status) => !status.enabled) ? (
          <Badge tone="primary">Recommended</Badge>
        ) : undefined
      }
      description="Your devices open these hosts directly, so their terminals keep working while this computer sleeps or needs a new SSH login. Each host needs Tailscale; Komla publishes it there with Tailscale Serve."
    >
      {!remoteEnabled && (
        <p className="text-xs text-muted-foreground">Turn on remote control above first.</p>
      )}
      {statuses.map((status) => (
        <div key={status.hostId} className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{status.hostName}</p>
            <div className="mt-0.5 text-ui text-muted-foreground">
              <StatusLine status={status} />
            </div>
          </div>
          <Switch
            aria-label={`Direct access to ${status.hostName}`}
            checked={status.enabled}
            disabled={busyHostId === status.hostId || (!remoteEnabled && !status.enabled)}
            onCheckedChange={(checked) => void setEnabled(status.hostId, checked)}
          />
        </div>
      ))}
    </SettingsCard>
  );
}
