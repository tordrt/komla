import { ArrowSquareOut, CaretDown, Copy, Devices, QrCode, Warning } from '@phosphor-icons/react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';

import {
  normalizeRemotePasskeyWindow,
  REMOTE_PASSKEY_WINDOW_MINUTES,
  type RemotePasskeyWindowMinutes,
} from '../../../../shared/lib/remote-passkey-window';

import { RemoteHostAccessCard, useHostAccess } from './RemoteHostAccessCard';
import { RemotePairDialog } from './RemotePairDialog';
import { NetworkOptions, PairedDeviceRow, RemoteStatusDot } from './RemoteTabParts';
import { SettingsCard } from './SettingsCard';

import type {
  PairedDeviceRecord,
  RemoteControlDirectState,
  RemoteControlDirectTailscaleStatus,
} from '@/types';

const INITIAL_DIRECT_STATE: RemoteControlDirectState = {
  server: null,
  pairingOffer: null,
  portChange: null,
};

function normalizePublicOrigin(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;
  const origin = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Tailscale URL must be a valid HTTPS origin');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Tailscale URL must start with https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Tailscale URL must not include credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Tailscale URL must not include a path, query, or fragment');
  }
  return parsed.origin;
}

/**
 * What the system may ask the first time remote control reads its key from safe storage, so the
 * prompt doesn't come as a surprise. Windows' DPAPI never asks.
 */
export function secureStoragePromptNote(platform = window.api?.platform): string | null {
  if (platform === 'win32') return null;
  if (platform === 'darwin') {
    return 'When you turn it on, macOS may ask for your password to use "Komla Safe Storage", where Komla keeps its keys. Choose Always Allow so it doesn\'t ask again.';
  }
  return 'When you turn it on, your desktop may ask you to unlock its keyring, where Komla keeps its keys.';
}

export function RemoteTab() {
  const { config, updateConfig } = useConfigStore();
  const addToast = useToastStore((s) => s.addToast);
  const [directState, setDirectState] = useState<RemoteControlDirectState>(INITIAL_DIRECT_STATE);
  const [directBusy, setDirectBusy] = useState(false);
  const [tailscaleBusy, setTailscaleBusy] = useState(false);
  const [directPublicOrigin, setDirectPublicOrigin] = useState(
    config?.directRemotePublicOrigin ?? ''
  );
  const [directPairQrUrl, setDirectPairQrUrl] = useState<string | null>(null);
  const [showBrowserOriginQr, setShowBrowserOriginQr] = useState(false);
  const [browserOriginQrUrl, setBrowserOriginQrUrl] = useState<string | null>(null);
  const [tailscaleStatus, setTailscaleStatus] = useState<RemoteControlDirectTailscaleStatus | null>(
    null
  );
  const [tailscaleUsePort, setTailscaleUsePort] = useState(false);
  const [devices, setDevices] = useState<PairedDeviceRecord[]>([]);
  const [networkOptionsOpen, setNetworkOptionsOpen] = useState(false);
  // When the pair dialog opened; a device paired after that is the one it paired.
  const [pairingSince, setPairingSince] = useState<number | null>(null);
  const hostAccess = useHostAccess();

  useEffect(() => {
    let cancelled = false;
    void window.api.remoteControlDirectGetState().then((s) => {
      if (!cancelled) setDirectState(s);
    });
    void window.api.pairedDevicesList().then((d) => {
      if (!cancelled) setDevices(d);
    });
    void window.api.remoteControlDirectGetTailscaleStatus().then((status) => {
      if (cancelled) return;
      setTailscaleStatus(status);
      setTailscaleUsePort(status.rootAvailable === false);
      setDirectPublicOrigin((current) => {
        if (current || !status.suggestedOrigin) return current;
        return status.suggestedOrigin;
      });
      // Nothing detected to publish: open the options so the origin can be typed in.
      if (status.installed && !status.suggestedOrigin) setNetworkOptionsOpen(true);
    });
    const offDirectState = window.api.onRemoteControlDirectStateChanged((s) => setDirectState(s));
    const offDevices = window.api.onPairedDevicesChanged((d) => setDevices(d));
    return () => {
      cancelled = true;
      offDirectState();
      offDevices();
    };
  }, []);

  useEffect(() => {
    setDirectPublicOrigin(config?.directRemotePublicOrigin ?? '');
  }, [config?.directRemotePublicOrigin]);

  const hasPairingOffer = Boolean(directState.pairingOffer);
  useEffect(() => {
    if (hasPairingOffer) setPairingSince((since) => since ?? Date.now());
  }, [hasPairingOffer]);

  const refreshDirectState = async () => {
    const state = await window.api.remoteControlDirectGetState();
    setDirectState(state);
    const status = await window.api.remoteControlDirectGetTailscaleStatus();
    setTailscaleStatus(status);
  };

  useEffect(() => {
    const pairUrl = directState.pairingOffer?.pairUrl;
    if (!pairUrl) {
      setDirectPairQrUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toString(pairUrl, {
      type: 'svg',
      margin: 1,
      color: { dark: '#111827', light: '#ffffff' },
    }).then((svg) => {
      if (!cancelled) {
        setDirectPairQrUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [directState.pairingOffer?.pairUrl]);

  useEffect(() => {
    const browserOrigin = directState.server?.httpOrigin;
    if (!showBrowserOriginQr || !browserOrigin) {
      setBrowserOriginQrUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toString(browserOrigin, {
      type: 'svg',
      margin: 1,
      color: { dark: '#111827', light: '#ffffff' },
    }).then((svg) => {
      if (!cancelled) {
        setBrowserOriginQrUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [directState.server?.httpOrigin, showBrowserOriginQr]);

  const handleDirectStart = async () => {
    setDirectBusy(true);
    try {
      const publicOrigin = normalizePublicOrigin(directPublicOrigin);
      setDirectPublicOrigin(publicOrigin ?? '');
      const server = await window.api.remoteControlDirectStart(
        publicOrigin ? { publicOrigin } : undefined
      );
      await refreshDirectState();
      setDirectState((s) => ({ ...s, server }));
    } catch (err) {
      addToast(`Could not start direct remote: ${(err as Error).message}`, 'error');
    } finally {
      setDirectBusy(false);
    }
  };

  const handleDirectStop = async () => {
    setDirectBusy(true);
    try {
      await window.api.remoteControlDirectStop();
      setDirectState(INITIAL_DIRECT_STATE);
    } catch (err) {
      addToast(`Could not stop direct remote: ${(err as Error).message}`, 'error');
    } finally {
      setDirectBusy(false);
    }
  };

  const handleDirectStartPairing = async () => {
    setPairingSince(Date.now());
    setDirectBusy(true);
    try {
      const publicOrigin = normalizePublicOrigin(directPublicOrigin);
      setDirectPublicOrigin(publicOrigin ?? '');
      const pairingOffer = await window.api.remoteControlDirectStartPairing(
        publicOrigin ? { publicOrigin } : undefined
      );
      await refreshDirectState();
      setDirectState((s) => ({ ...s, pairingOffer }));
    } catch (err) {
      setPairingSince(null);
      addToast(`Could not start direct pairing: ${(err as Error).message}`, 'error');
    } finally {
      setDirectBusy(false);
    }
  };

  const handleStartTailscaleServe = async () => {
    setTailscaleBusy(true);
    try {
      const publicOrigin = normalizePublicOrigin(directPublicOrigin);
      if (!publicOrigin) {
        throw new Error('Enter your Tailscale HTTPS origin first');
      }
      setDirectPublicOrigin(publicOrigin);
      const result = await window.api.remoteControlDirectStartTailscaleServe({
        publicOrigin,
        tailscaleServeMode: tailscaleUsePort ? 'port' : 'root',
      });
      setDirectState((s) => ({ ...s, server: result.server }));
      void window.api.remoteControlDirectGetTailscaleStatus().then(setTailscaleStatus);
      addToast('Tailscale Serve started', 'success');
    } catch (err) {
      addToast(`Could not start Tailscale Serve: ${(err as Error).message}`, 'error');
    } finally {
      setTailscaleBusy(false);
    }
  };

  const handleDirectEnabledChange = async (checked: boolean) => {
    if (checked) {
      await handleDirectStart();
      return;
    }
    await handleDirectStop();
  };

  const handleKeepAwakeChange = async (checked: boolean) => {
    const { ok, error } = await updateConfig({ directRemoteKeepAwake: checked });
    if (!ok) {
      addToast(`Could not update keep-awake setting: ${error}`, 'error');
    }
  };

  const handleLocalAccessChange = async (checked: boolean) => {
    const { ok, error } = await updateConfig({ directRemoteLocalAccess: checked });
    if (!ok) {
      addToast(`Could not update access to this computer: ${error}`, 'error');
    }
  };

  const handlePasskeyWindowChange = async (minutes: RemotePasskeyWindowMinutes) => {
    const { ok, error } = await updateConfig({ directRemotePasskeyWindowMinutes: minutes });
    if (!ok) {
      addToast(`Could not update the passkey setting: ${error}`, 'error');
    }
  };

  const handleDirectOriginBlur = async () => {
    try {
      const value = normalizePublicOrigin(directPublicOrigin) ?? '';
      setDirectPublicOrigin(value);
      await updateConfig({ directRemotePublicOrigin: value || undefined });
      void window.api.remoteControlDirectGetTailscaleStatus().then(setTailscaleStatus);
    } catch (err) {
      addToast(`Could not save Tailscale origin: ${(err as Error).message}`, 'error');
    }
  };

  const handleDirectCancelPairing = async () => {
    setDirectBusy(true);
    try {
      await window.api.remoteControlDirectCancelPairing();
      setDirectState((s) => ({ ...s, pairingOffer: null }));
    } catch (err) {
      addToast(`Could not cancel direct pairing: ${(err as Error).message}`, 'error');
    } finally {
      setDirectBusy(false);
    }
  };

  const handleCopy = (text: string, descriptor: string) => {
    window.api.copyToClipboard(text);
    addToast(`${descriptor} copied`, 'success');
  };

  const handleRename = async (credentialId: string, label: string): Promise<boolean> => {
    try {
      await window.api.pairedDevicesRename(credentialId, label);
      return true;
    } catch (err) {
      addToast(`Could not rename device: ${(err as Error).message}`, 'error');
      return false;
    }
  };

  const handleRemove = async (record: PairedDeviceRecord) => {
    const ok = window.confirm(`Remove "${record.label}"? It will need to pair again to reconnect.`);
    if (!ok) return;
    try {
      await window.api.pairedDevicesRemove(record.credentialId);
      addToast(`Removed ${record.label}`, 'success');
    } catch (err) {
      addToast(`Could not remove device: ${(err as Error).message}`, 'error');
    }
  };

  const handleDisconnectActive = async () => {
    try {
      await window.api.remoteControlDisconnectActive();
      setDirectState(await window.api.remoteControlDirectGetState());
      addToast('Remote device disconnected', 'success');
    } catch (err) {
      addToast(`Could not disconnect device: ${(err as Error).message}`, 'error');
    }
  };

  const handlePairDialogOpenChange = (open: boolean) => {
    if (open) return;
    if (directState.pairingOffer) void handleDirectCancelPairing();
    setPairingSince(null);
  };

  const handleEnableHosts = async (hostIds: string[]) => {
    for (const hostId of hostIds) await hostAccess.setEnabled(hostId, true);
  };

  const directPairingOffer = directState.pairingOffer;
  const server = directState.server;
  const localAccess = config?.directRemoteLocalAccess !== false;
  const storagePromptNote = secureStoragePromptNote();
  const tailscaleInstalled = tailscaleStatus?.installed === true;
  const tailscaleServeConfigured = tailscaleStatus?.serveConfigured === true;
  const published = tailscaleServeConfigured && Boolean(server);
  const connectedDevice = directState.connectedDevice;
  const networkLocked = directBusy || tailscaleBusy || Boolean(server);
  const publishedOrigin = directPublicOrigin || server?.httpOrigin;
  const pairedDevice =
    pairingSince === null
      ? null
      : (devices.find((device) => Date.parse(device.createdAt) >= pairingSince - 1000) ?? null);
  const hostsWithoutAccess = server ? hostAccess.statuses.filter((status) => !status.enabled) : [];

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Remote control"
        description="Runs over Tailscale, end-to-end encrypted between your own devices, with no Komla server in between. Sign in to the same Tailscale account on each device."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
              <RemoteStatusDot tone={!server ? 'off' : published ? 'ok' : 'warn'} />
              {!server ? (
                <span>Off</span>
              ) : published ? (
                <>
                  <span className="shrink-0">On</span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    Devices pair at{' '}
                    <span className="font-mono">{publishedOrigin?.replace(/^https:\/\//, '')}</span>
                  </span>
                  {server.httpOrigin !== server.localOrigin && (
                    <span className="flex shrink-0 items-center">
                      <IconButton
                        label="Copy browser address"
                        size="sm"
                        onClick={() => handleCopy(server.httpOrigin, 'Address')}
                      >
                        <Copy className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label="Show browser origin QR code"
                        size="sm"
                        aria-expanded={showBrowserOriginQr}
                        onClick={() => setShowBrowserOriginQr((show) => !show)}
                      >
                        <QrCode className="size-3.5" />
                      </IconButton>
                    </span>
                  )}
                </>
              ) : (
                <span>On, but only this computer can reach it</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {directBusy ? <Spinner size="sm" /> : null}
              <Switch
                checked={Boolean(server)}
                onCheckedChange={(checked) => void handleDirectEnabledChange(checked)}
                disabled={directBusy}
                aria-label="Remote control"
              />
            </div>
          </div>

          {!server && storagePromptNote && (
            <p className="text-xs text-muted-foreground">{storagePromptNote}</p>
          )}

          {!server && tailscaleStatus?.installed === false && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              <p className="max-w-md text-xs text-muted-foreground">
                Tailscale isn't installed on this computer. Install it here and on each device;
                until then, only this computer can connect.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void window.api.openExternal('https://tailscale.com/download')}
              >
                Get Tailscale
                <ArrowSquareOut className="size-3.5" />
              </Button>
            </div>
          )}

          {showBrowserOriginQr && published && (
            <div className="flex size-28 items-center justify-center rounded-md border border-border bg-white p-2">
              {browserOriginQrUrl ? (
                <img src={browserOriginQrUrl} alt="Browser origin QR code" className="size-full" />
              ) : (
                <QrCode className="size-8 text-muted-foreground" />
              )}
            </div>
          )}

          {server && !published && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              {tailscaleStatus === null ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner size="sm" /> Checking Tailscale…
                </p>
              ) : !tailscaleInstalled ? (
                <>
                  <p className="max-w-md text-xs text-muted-foreground">
                    Install Tailscale here and on each device; until then, only this computer can
                    connect.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void window.api.openExternal('https://tailscale.com/download')}
                  >
                    Get Tailscale
                    <ArrowSquareOut className="size-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <p className="max-w-md text-xs text-muted-foreground">
                    Publish Komla on your tailnet so your devices can reach it.
                  </p>
                  <Button
                    size="sm"
                    onClick={handleStartTailscaleServe}
                    disabled={directBusy || tailscaleBusy || !directPublicOrigin.trim()}
                  >
                    {tailscaleBusy ? <Spinner size="sm" /> : null}
                    Publish with Tailscale Serve
                  </Button>
                </>
              )}
            </div>
          )}

          {server &&
            !published &&
            tailscaleStatus?.rootAvailable === false &&
            !tailscaleUsePort && (
              <Callout tone="warning" size="sm">
                Your Tailscale HTTPS address is taken. Pick a port under Network options.
              </Callout>
            )}
          {server && !published && tailscaleStatus?.existingServeSummary && (
            <Callout tone="info" size="sm">
              Tailscale Serve has other routes, so Komla gets its own HTTPS port.
            </Callout>
          )}
          {server && !published && tailscaleStatus?.serveConflict && (
            <Callout tone="warning" size="sm">
              Another Tailscale Serve route may use this port. Check its command under Network
              options before you publish.
            </Callout>
          )}
          {directState.portChange && (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <Warning className="size-3.5 shrink-0" />
              Port {directState.portChange.oldPort} was in use, so Komla uses{' '}
              {directState.portChange.newPort}.
            </p>
          )}
        </div>
        {/* Off only makes sense with an SSH host to open; kept while off, so it can go back on. */}
        {(hostAccess.statuses.length > 0 || !localAccess) && (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">Allow access to this computer</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Off: devices open only SSH workspaces. This computer still pairs them and vouches
                for your hosts.
              </p>
            </div>
            <Switch
              checked={localAccess}
              onCheckedChange={(checked) => void handleLocalAccessChange(checked)}
              aria-label="Allow access to this computer"
            />
          </div>
        )}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Keep computer awake</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Prevents idle sleep while remote control is on. A closed laptop lid can still suspend
              it.
            </p>
          </div>
          <Switch
            checked={config?.directRemoteKeepAwake === true}
            onCheckedChange={(checked) => void handleKeepAwakeChange(checked)}
            aria-label="Keep computer awake while remote access is enabled"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Ask for passkey again after</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              How long a device stays signed in after you leave it, up to 8 hours after its last
              passkey.
            </p>
          </div>
          <Select
            value={String(normalizeRemotePasskeyWindow(config?.directRemotePasskeyWindowMinutes))}
            onChange={(e) =>
              void handlePasskeyWindowChange(normalizeRemotePasskeyWindow(Number(e.target.value)))
            }
            className="w-32"
            aria-label="Ask for passkey again after"
          >
            {REMOTE_PASSKEY_WINDOW_MINUTES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60
                  ? `${minutes} minutes`
                  : `${minutes / 60} hour${minutes > 60 ? 's' : ''}`}
              </option>
            ))}
          </Select>
        </div>
      </SettingsCard>

      {/* The running server, not the config: starting it updates the config without telling Settings. */}
      <RemoteHostAccessCard remoteEnabled={Boolean(server)} />

      <SettingsCard
        title="Devices"
        action={
          <Button size="sm" onClick={handleDirectStartPairing} disabled={directBusy}>
            {directBusy ? <Spinner size="sm" /> : <QrCode className="size-3.5" />}
            Pair a device
          </Button>
        }
        description="Each device signs in with its own passkey. Removing one signs it out."
      >
        {connectedDevice &&
          !devices.some((device) => device.credentialId === connectedDevice.credentialId) && (
            <div className="flex items-center justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                <RemoteStatusDot tone="ok" />
                <span className="truncate">{connectedDevice.label} is connected</span>
              </p>
              <Button size="sm" variant="outline" onClick={() => void handleDisconnectActive()}>
                Disconnect
              </Button>
            </div>
          )}
        {devices.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<Devices weight="duotone" />}
            title="No devices yet"
            description="Pair your phone, tablet or another computer."
          />
        ) : (
          devices.map((d) => (
            <PairedDeviceRow
              key={d.credentialId}
              device={d}
              connected={connectedDevice?.credentialId === d.credentialId}
              onRename={(label) => handleRename(d.credentialId, label)}
              onRemove={() => void handleRemove(d)}
              onDisconnect={() => void handleDisconnectActive()}
            />
          ))
        )}
      </SettingsCard>

      {tailscaleInstalled && (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={networkOptionsOpen}
            onClick={() => setNetworkOptionsOpen((open) => !open)}
          >
            Network options
            <CaretDown
              className={cn('size-3 transition-transform', networkOptionsOpen && 'rotate-180')}
            />
          </button>
          {networkOptionsOpen && (
            <NetworkOptions
              origin={directPublicOrigin}
              onOriginChange={setDirectPublicOrigin}
              onOriginBlur={() => void handleDirectOriginBlur()}
              status={tailscaleStatus}
              usePort={tailscaleUsePort}
              onUsePortChange={(checked) => {
                setTailscaleUsePort(checked);
                const nextOrigin = checked
                  ? tailscaleStatus?.suggestedPortOrigin
                  : tailscaleStatus?.suggestedRootOrigin;
                if (nextOrigin) setDirectPublicOrigin(nextOrigin);
              }}
              locked={networkLocked}
              localOrigin={server?.localOrigin}
            />
          )}
        </div>
      )}

      <RemotePairDialog
        open={pairingSince !== null}
        onOpenChange={handlePairDialogOpenChange}
        offer={directPairingOffer}
        creating={directBusy}
        qrUrl={directPairQrUrl}
        published={published}
        pairedDevice={pairedDevice}
        hostsWithoutAccess={hostsWithoutAccess}
        onCopy={() => directPairingOffer && handleCopy(directPairingOffer.pairUrl, 'Pair URL')}
        onOpenLink={() =>
          directPairingOffer && void window.api.openExternal(directPairingOffer.pairUrl)
        }
        onNewCode={() => void handleDirectStartPairing()}
        onEnableHosts={handleEnableHosts}
      />
    </div>
  );
}
