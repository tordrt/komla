import { Check, Plus, ShieldCheck, Stop } from '@phosphor-icons/react';
import React, { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLicenseStore } from '@/stores/license.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { takesFreeSshSlot } from '@/types';

import type { PlanPrices } from '@/types';
import type { UpgradeRetryAction } from '@/utils/workspace-error';

export type UpgradeTrigger = 'limit' | 'approaching' | 'settings';

const FOOTER_LINK = 'text-[13px] text-muted-foreground transition-colors hover:text-foreground';

const UNLIMITED_BENEFIT = 'Unlimited SSH workspaces in parallel';
const BENEFITS = ['One license for all your machines', 'No account or signup'];
// The free plan is generous, so say so, and say what a license pays for.
const SUPPORT_NOTE =
  'Komla is free with every feature and unlimited local workspaces. Licenses from people running it on remote machines keep it in development.';

interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: UpgradeTrigger;
  workspaceLimit?: number;
  onRetry?: UpgradeRetryAction;
}

export function UpgradeDialog({
  open,
  onOpenChange,
  trigger = 'limit',
  workspaceLimit = 4,
  onRetry,
}: UpgradeDialogProps) {
  const [licenseKey, setLicenseKey] = useState('');
  const [showActivate, setShowActivate] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [prices, setPrices] = useState<PlanPrices | null>(null);
  const stopHeadingId = useId();
  const descriptionId = useId();
  const noteId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const { activateLicense, isLoading, error } = useLicenseStore();
  const quota = useLicenseStore((s) => s.quota);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const stopWorkspace = useWorkspacesStore((s) => s.stopWorkspace);

  // Prices come from the license server so they follow the buy page; the line
  // stays hidden until they arrive, and offline.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.api
      .getPlanPrices()
      .then((result) => {
        if (!cancelled) setPrices(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // Drop them on close: the dialog stays mounted, and a reopen must not
      // show a lifetime price that has since ended.
      setPrices(null);
    };
  }, [open]);

  // The free limit counts SSH workspaces on their hosts only; local workspaces are unlimited.
  const quotaWorkspaces = workspaces.filter(takesFreeSshSlot);
  const runningWorkspaces = quotaWorkspaces.filter((ws) => !ws.provisioning);

  const requestedCount = Math.max(1, Math.floor(onRetry?.requestedWorkspaceCount ?? 1));

  // Free enough capacity for the complete launch. The service performs the
  // authoritative check again when retrying, including any concurrent creates.
  const slotsToFree = Math.max(0, quotaWorkspaces.length + requestedCount - workspaceLimit);
  const showStopPanel = trigger === 'limit' && slotsToFree > 0 && runningWorkspaces.length > 0;

  const runningCount = quotaWorkspaces.length;
  const totalWanted = runningCount + requestedCount;
  // The sidebar meter that opens this dialog shows quota.count.
  const shownCount = quota?.count ?? runningCount;

  const getCopy = (): { title: string; description: string } => {
    const freeLimit = `Free runs up to ${workspaceLimit} SSH workspaces at once.`;
    const startMore = requestedCount > 1 ? `${requestedCount} more` : 'the next one';
    switch (trigger) {
      case 'limit':
        return showStopPanel
          ? {
              title: `Run all ${totalWanted} SSH workspaces at once`,
              description: `${freeLimit} Go unlimited to keep these running and start ${startMore}.`,
            }
          : {
              title: 'Run more in parallel',
              description: `${freeLimit} Go unlimited to start more.`,
            };
      case 'approaching':
        return {
          title: 'Run more in parallel',
          description: `${freeLimit} You're close to that limit.`,
        };
      case 'settings':
      default:
        return shownCount >= workspaceLimit
          ? {
              title: "You're at the free limit",
              description: `${freeLimit} Go unlimited to start more SSH workspaces without stopping any.`,
            }
          : {
              // Opened by choice, not blocked, so the pitch is support.
              title: "Support Komla's development",
              description: `${freeLimit} Go unlimited to run as many SSH workspaces as your hosts handle.`,
            };
    }
  };

  const handleStopWorkspace = async (workspaceId: string) => {
    setStoppingId(workspaceId);
    try {
      await stopWorkspace(workspaceId);
      // Only close + retry when this stop alone brings the user within the
      // limit. If they're over the cap (e.g. a license lapsed with 7 running),
      // they need multiple stops — keep the dialog open and let the reactive
      // running count drive the next render.
      if (slotsToFree <= 1) {
        onOpenChange(false);
        onRetry?.();
      }
    } catch {
      // If stop fails, keep dialog open so user can try another workspace
    } finally {
      setStoppingId(null);
    }
  };

  const handleActivate = async () => {
    if (!licenseKey.trim()) return;
    await activateLicense(licenseKey.trim());
    const { error: currentError } = useLicenseStore.getState();
    if (!currentError) {
      setLicenseKey('');
      setShowActivate(false);
      onOpenChange(false);
      onRetry?.();
    }
  };

  const handleBuy = async () => {
    const params = new URLSearchParams({ source: 'app', trigger });
    // The buy page guesses the currency from the browser's language, which can
    // differ from the region the app priced in.
    if (prices) params.set('currency', prices.currency);
    let analyticsFragment = '';
    try {
      const analyticsId = await window.api.getTelemetryDistinctId();
      if (analyticsId) analyticsFragment = `#aid=${encodeURIComponent(analyticsId)}`;
      void window.api.trackMonetizationEvent('upgrade_clicked', { source: 'free_limit_wall' });
    } catch {
      // Opening checkout should not depend on telemetry IPC.
    }
    void window.api.openExternal(
      `${window.api.websiteUrl}/buy?${params.toString()}${analyticsFragment}`
    );
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setLicenseKey('');
      setShowActivate(false);
    }
    onOpenChange(newOpen);
  };

  const { title, description } = getCopy();
  // Without the stop panel, CapacityCompare shows the unlimited part.
  const benefits = showStopPanel ? [UNLIMITED_BENEFIT, ...BENEFITS] : BENEFITS;

  const offer = (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col gap-2.5">
        {benefits.map((benefit) => (
          <li key={benefit} className="flex items-center gap-2.5 text-[13px]">
            <Check weight="bold" className="size-3.5 shrink-0 text-primary" />
            {benefit}
          </li>
        ))}
      </ul>

      {!showActivate ? (
        <div className="flex flex-col gap-3">
          <Button onClick={handleBuy} className="h-10 w-full text-sm">
            Go unlimited
          </Button>
          {prices && <PriceLine prices={prices} />}
          <button
            type="button"
            onClick={() => window.api.openExternal(`${window.api.websiteUrl}/refund`)}
            className="mx-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ShieldCheck weight="bold" className="size-3.5 shrink-0" />
            14-day refund on yearly and lifetime
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              aria-label="License key"
              placeholder="KOMLA-XXXX-XXXX-XXXX-XXXX"
              className="h-9 flex-1 font-mono text-[13px]"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleActivate();
                }
              }}
            />
            <Button
              variant="outline"
              onClick={handleActivate}
              disabled={isLoading || !licenseKey.trim()}
            >
              {isLoading ? 'Activating...' : 'Activate'}
            </Button>
          </div>
          {error && (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          )}
        </div>
      )}

      <p id={noteId} className="text-xs leading-relaxed text-muted-foreground">
        {SUPPORT_NOTE}
      </p>

      <div className="flex items-center justify-between border-t border-border/60 pt-4">
        <button
          type="button"
          onClick={() => {
            setShowActivate(!showActivate);
            setLicenseKey('');
          }}
          className={FOOTER_LINK}
        >
          {showActivate ? 'Back' : 'I have a license key'}
        </button>
        <button type="button" onClick={() => handleOpenChange(false)} className={FOOTER_LINK}>
          Maybe later
        </button>
      </div>
    </div>
  );

  const header = (
    <div className="flex flex-col gap-2">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription id={descriptionId} className="text-[13px] leading-relaxed">
        {description}
      </DialogDescription>
    </div>
  );

  // Screen readers announce the support note with the description.
  const describedBy = `${descriptionId} ${noteId}`;

  // Focus the dialog itself so it doesn't open with a ring on its first control.
  const focusContent = (e: Event) => {
    e.preventDefault();
    contentRef.current?.focus();
  };

  // Without workspaces to stop, the offer stands alone.
  if (!showStopPanel) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          ref={contentRef}
          className="welcome-brand max-w-[28rem] gap-5"
          showCloseButton={false}
          onOpenAutoFocus={focusContent}
          aria-describedby={describedBy}
        >
          {header}
          <CapacityCompare
            running={shownCount}
            limit={workspaceLimit}
            atLimit={shownCount >= workspaceLimit}
          />
          {offer}
        </DialogContent>
      </Dialog>
    );
  }

  // At the limit, the offer leads and the running workspaces sit beside it as
  // slots, with the one waiting to start drawn as an empty slot.
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        className="welcome-brand max-w-[44rem] gap-0 p-0"
        showCloseButton={false}
        onOpenAutoFocus={focusContent}
        aria-describedby={describedBy}
      >
        <div className="flex flex-col sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-5 p-6">
            {header}
            {offer}
          </div>

          <section
            aria-labelledby={stopHeadingId}
            className="flex flex-col gap-3 border-t border-border/60 bg-muted/40 p-5 sm:w-[17rem] sm:shrink-0 sm:border-t-0 sm:border-l"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <h3 id={stopHeadingId} className="text-[13px] font-medium">
                  Or free up {slotsToFree > 1 ? `${slotsToFree} slots` : 'a slot'}
                </h3>
                <span className="shrink-0 text-xs text-warning tabular-nums">
                  {runningCount}/{workspaceLimit} running
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {slotsToFree > 1
                  ? `Stop ${slotsToFree} running SSH workspaces to start ${requestedCount} more.`
                  : requestedCount > 1
                    ? `Stop one running SSH workspace to start ${requestedCount} more.`
                    : 'Stop a running SSH workspace to start the next one.'}
              </p>
            </div>

            <ul className="-mx-1 flex max-h-80 flex-col gap-1.5 overflow-y-auto px-1 py-0.5">
              {runningWorkspaces.map((ws) => {
                const primaryTerminal = ws.primaryTerminalId
                  ? ws.terminals.find((t) => t.id === ws.primaryTerminalId)
                  : undefined;
                const dynamicTitle =
                  primaryTerminal?.dynamicTitle ||
                  ws.terminals[0]?.dynamicTitle ||
                  ws.lastDynamicTitle;
                const wsTitle = ws.customName || dynamicTitle || ws.name;
                const detail = ws.branchName || ws.workingDirectory.split(/[\\/]/).pop();
                const isStopping = stoppingId === ws.id;
                const hasTooltip = !!ws.customDescription;
                return (
                  <li key={ws.id}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Stop ${wsTitle}`}
                          className="group flex w-full items-center gap-2.5 rounded-md border border-border/60 bg-card px-2.5 py-2 text-left shadow-soft transition-colors hover:border-border hover:bg-accent disabled:opacity-50"
                          onClick={() => void handleStopWorkspace(ws.id)}
                          disabled={stoppingId !== null}
                        >
                          <span className="size-1.5 shrink-0 rounded-full bg-success" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">{wsTitle}</span>
                            {detail && detail !== wsTitle && (
                              <span className="block truncate text-ui text-muted-foreground">
                                {detail}
                              </span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-ui text-muted-foreground transition-colors group-hover:text-foreground">
                            {isStopping ? (
                              <Spinner size="xs" />
                            ) : (
                              <Stop weight="fill" className="size-3" />
                            )}
                            {isStopping ? 'Stopping…' : 'Stop'}
                          </span>
                        </button>
                      </TooltipTrigger>
                      {hasTooltip && (
                        <TooltipContent side="left" className="max-w-xs text-xs">
                          {ws.customDescription}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </li>
                );
              })}
              <li className="flex items-center gap-2.5 rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                <Plus weight="bold" className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {requestedCount > 1 ? `${requestedCount} more workspaces` : 'Next workspace'}
                </span>
                <span className="shrink-0 text-ui">Waiting</span>
              </li>
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

// Leads with the yearly plan per month, the cheapest-sounding true price, the
// way the buy page does ("<$7/month").
function PriceLine({ prices }: { prices: PlanPrices }) {
  const { currency, monthly, yearly, lifetime } = prices;
  const perMonth =
    yearly % 1200 === 0
      ? `${formatPrice(yearly / 12, currency)}/month`
      : `Under ${formatPrice(Math.ceil(yearly / 1200) * 100, currency)}/month`;
  return (
    <p className="text-center text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">{perMonth}</span> billed yearly ·{' '}
      {formatPrice(monthly, currency)} monthly
      {lifetime !== null && ` · ${formatPrice(lifetime, currency)} once`}
    </p>
  );
}

const UNLIMITED_SLOTS = 14;

// Free and Unlimited side by side: running workspaces fill the slots, and
// Unlimited's row, in Komla blue, runs off the edge.
function CapacityCompare({
  running,
  limit,
  atLimit,
}: {
  running: number;
  limit: number;
  atLimit: boolean;
}) {
  const slot = (className: string, key: number) => (
    <span key={key} className={cn('h-2 w-4 shrink-0 rounded-[3px]', className)} />
  );
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-2.5 rounded-lg border border-border/60 bg-muted/40 px-3.5 py-3 text-xs">
      <span className="text-muted-foreground">Free</span>
      <span className="flex gap-1">
        {Array.from({ length: limit }, (_, i) =>
          slot(i < running ? 'bg-success' : 'bg-muted-foreground/25', i)
        )}
      </span>
      <span
        className={cn(
          'text-right tabular-nums',
          atLimit ? 'text-warning' : 'text-muted-foreground'
        )}
      >
        {running}/{limit}
      </span>

      <span className="font-medium">Unlimited</span>
      <span className="flex gap-1 overflow-hidden [mask-image:linear-gradient(to_right,black_60%,transparent)]">
        {Array.from({ length: UNLIMITED_SLOTS }, (_, i) =>
          slot(i < running ? 'bg-primary' : 'bg-primary/35', i)
        )}
      </span>
      <span className="text-right font-medium text-primary">No cap</span>
    </div>
  );
}
