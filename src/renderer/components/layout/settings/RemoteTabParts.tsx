import { ArrowSquareOut, Copy, Devices, Pencil, Trash } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import type { PairedDeviceRecord, RemoteControlDirectTailscaleStatus } from '@/types';

export type RemoteStatusTone = 'off' | 'ok' | 'warn';

const STATUS_DOT_CLASSES: Record<RemoteStatusTone, string> = {
  off: 'bg-muted-foreground/50',
  ok: 'bg-success',
  warn: 'bg-warning',
};

export function RemoteStatusDot({ tone }: { tone: RemoteStatusTone }) {
  return (
    <span aria-hidden="true" className="relative flex size-2 shrink-0">
      {tone === 'ok' && (
        <span className="absolute inset-0 animate-ping rounded-full bg-success/50 [animation-duration:2.4s]" />
      )}
      <span className={cn('relative size-2 rounded-full', STATUS_DOT_CLASSES[tone])} />
    </span>
  );
}

/** The Tailscale origin and port choice, folded away unless Komla could not detect them. */
export function NetworkOptions({
  origin,
  onOriginChange,
  onOriginBlur,
  status,
  usePort,
  onUsePortChange,
  locked,
  localOrigin,
}: {
  origin: string;
  onOriginChange: (origin: string) => void;
  onOriginBlur: () => void;
  status: RemoteControlDirectTailscaleStatus | null;
  usePort: boolean;
  onUsePortChange: (usePort: boolean) => void;
  locked: boolean;
  /** Where Komla listens while remote control is on; the options are locked then. */
  localOrigin: string | undefined;
}) {
  const command =
    (usePort ? status?.portCommand : status?.rootCommand) ??
    status?.command ??
    'tailscale serve --bg localhost:52864';
  const suggestedOrigin = usePort ? status?.suggestedPortOrigin : status?.suggestedRootOrigin;
  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border/50 bg-card/70 p-4">
      <div className="space-y-1.5">
        <label
          htmlFor="direct-tailscale-origin"
          className="block text-xs font-medium text-foreground"
        >
          Tailscale HTTPS origin
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="direct-tailscale-origin"
            value={origin}
            onChange={(e) => onOriginChange(e.target.value)}
            onBlur={onOriginBlur}
            placeholder="https://your-mac.your-tailnet.ts.net"
            disabled={locked}
            className="h-8 font-mono text-xs"
          />
          {suggestedOrigin && origin !== suggestedOrigin && (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => onOriginChange(suggestedOrigin)}
              disabled={locked}
            >
              Use detected
            </Button>
          )}
        </div>
        {status?.hostname && (
          <p className="text-ui text-muted-foreground">
            This computer is {status.hostname} on your tailnet.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">Use a separate port</p>
          <p className="mt-0.5 text-ui text-muted-foreground">
            For when your tailnet address already serves something else.
          </p>
        </div>
        <Switch
          checked={usePort}
          onCheckedChange={onUsePortChange}
          disabled={locked}
          aria-label="Use explicit Tailscale HTTPS port"
        />
      </div>
      <p className="text-ui text-muted-foreground">
        Publishing runs <code className="font-mono">{command}</code>
      </p>
      {localOrigin && (
        <p className="text-ui text-muted-foreground">
          Turn remote control off to change these. Komla listens on{' '}
          <span className="font-mono">{localOrigin}</span>.
        </p>
      )}
    </div>
  );
}

/** The one-time pairing QR, centered in a white tile with its link underneath. */
export function PairingQr({
  qrUrl,
  pairUrl,
  onCopy,
  onOpen,
}: {
  qrUrl: string | null;
  pairUrl: string;
  onCopy: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-3 rounded-lg border border-border/60 px-4 py-5">
      <div className="flex size-44 items-center justify-center rounded-lg border border-border/40 bg-white p-2.5">
        {qrUrl ? (
          <img
            src={qrUrl}
            alt="Pair URL QR code"
            className="size-full [image-rendering:pixelated]"
          />
        ) : (
          <span className="size-full animate-pulse rounded bg-neutral-200" />
        )}
      </div>
      <div className="flex w-full min-w-0 items-center gap-1 rounded-md bg-muted/40 py-1 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 truncate font-mono text-ui text-muted-foreground select-all">
          {pairUrl}
        </code>
        <IconButton label="Copy pair URL" size="sm" onClick={onCopy}>
          <Copy className="size-3.5" />
        </IconButton>
        <IconButton label="Open pair URL" size="sm" onClick={onOpen}>
          <ArrowSquareOut className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

export function PairedDeviceRow({
  device,
  connected,
  onRename,
  onRemove,
  onDisconnect,
}: {
  device: PairedDeviceRecord;
  connected: boolean;
  onRename: (label: string) => Promise<boolean>;
  onRemove: () => void;
  onDisconnect: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const save = async () => {
    if (draft === null || draft.trim().length === 0) return;
    if (await onRename(draft.trim())) setDraft(null);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <Devices className="size-4" />
      </span>
      {draft !== null ? (
        <>
          <Input
            autoFocus
            aria-label="Device name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') setDraft(null);
            }}
            className="h-8 text-sm"
            maxLength={120}
          />
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{device.label}</p>
            <p className="flex items-center gap-1.5 text-ui text-muted-foreground">
              {connected ? (
                <>
                  <RemoteStatusDot tone="ok" />
                  <span className="text-foreground">Connected now</span>
                </>
              ) : (
                <span>
                  {device.lastUsedAt ? `Last used ${formatDate(device.lastUsedAt)}` : 'Never used'}
                  {` · Paired ${formatDate(device.createdAt)}`}
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {connected && (
              <Button size="sm" variant="outline" onClick={onDisconnect}>
                Disconnect
              </Button>
            )}
            <IconButton label="Rename device" size="md" onClick={() => setDraft(device.label)}>
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton
              label="Remove device"
              size="md"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={onRemove}
            >
              <Trash className="size-3.5" />
            </IconButton>
          </div>
        </>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
