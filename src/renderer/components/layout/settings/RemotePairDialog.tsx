import { CheckCircle } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';

import { PairingQr } from './RemoteTabParts';

import type {
  PairedDeviceRecord,
  RemoteControlDirectPairingOffer,
  RemoteControlHostAccessStatus,
} from '@/types';

/**
 * Pairs one device: shows the one-time QR code, then, once the device is paired, offers direct
 * access to the SSH hosts that don't have it yet.
 */
export function RemotePairDialog({
  open,
  onOpenChange,
  offer,
  creating,
  qrUrl,
  published,
  pairedDevice,
  hostsWithoutAccess,
  onCopy,
  onOpenLink,
  onNewCode,
  onEnableHosts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offer: RemoteControlDirectPairingOffer | null;
  /** A code is being created. */
  creating: boolean;
  qrUrl: string | null;
  /** Whether Komla is on the tailnet; until then the code only opens on this computer. */
  published: boolean;
  /** The device this dialog paired, once it has. */
  pairedDevice: PairedDeviceRecord | null;
  hostsWithoutAccess: RemoteControlHostAccessStatus[];
  onCopy: () => void;
  onOpenLink: () => void;
  onNewCode: () => void;
  onEnableHosts: (hostIds: string[]) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {pairedDevice ? (
          <PairedStep
            device={pairedDevice}
            hosts={hostsWithoutAccess}
            onClose={() => onOpenChange(false)}
            onEnableHosts={onEnableHosts}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Pair a device</DialogTitle>
              <DialogDescription>
                Connect the device to Tailscale first. Then scan the code with its camera, or open
                the link on it, and save a passkey when asked. The code works once.
              </DialogDescription>
            </DialogHeader>
            {offer ? (
              <PairingQr
                qrUrl={qrUrl}
                pairUrl={offer.pairUrl}
                onCopy={onCopy}
                onOpen={onOpenLink}
              />
            ) : creating ? (
              <p className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                <Spinner size="sm" /> Creating a code…
              </p>
            ) : (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <p className="flex items-center gap-2 text-sm text-foreground">
                  <Spinner size="sm" /> Finish on the device by saving the passkey
                </p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  If the code expired or pairing failed there, show a new one.
                </p>
              </div>
            )}
            {!published && (
              <Callout tone="info" size="sm">
                Until Komla is published on your tailnet, the code only opens on this computer.
              </Callout>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {!offer && !creating && <Button onClick={onNewCode}>Show a new code</Button>}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PairedStep({
  device,
  hosts,
  onClose,
  onEnableHosts,
}: {
  device: PairedDeviceRecord;
  hosts: RemoteControlHostAccessStatus[];
  onClose: () => void;
  onEnableHosts: (hostIds: string[]) => Promise<void>;
}) {
  // Every host starts checked: direct access is what keeps a device working while this computer sleeps.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const checked = hosts.filter((host) => !unchecked.has(host.hostId));

  const enable = async () => {
    setBusy(true);
    try {
      await onEnableHosts(checked.map((host) => host.hostId));
    } finally {
      setBusy(false);
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle weight="fill" className="size-4 text-success" />
          {device.label} is paired
        </DialogTitle>
        <DialogDescription>It reconnects on its own from now on.</DialogDescription>
      </DialogHeader>
      {hosts.length > 0 && (
        <div className="space-y-2.5">
          <div>
            <p className="text-sm font-medium text-foreground">Reach your SSH hosts directly</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Recommended. The device then opens these hosts itself, so their terminals keep working
              while this computer sleeps. Each host needs Tailscale.
            </p>
          </div>
          {hosts.map((host) => (
            <label key={host.hostId} className="flex items-center gap-2.5 text-sm text-foreground">
              <Checkbox
                checked={!unchecked.has(host.hostId)}
                onChange={(event) => {
                  const next = new Set(unchecked);
                  if (event.target.checked) next.delete(host.hostId);
                  else next.add(host.hostId);
                  setUnchecked(next);
                }}
              />
              <span className="truncate">{host.hostName}</span>
            </label>
          ))}
        </div>
      )}
      <DialogFooter>
        {hosts.length > 0 ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Not now
            </Button>
            <Button onClick={() => void enable()} disabled={busy || checked.length === 0}>
              {busy ? <Spinner size="sm" /> : null}
              Turn on
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Done</Button>
        )}
      </DialogFooter>
    </>
  );
}
