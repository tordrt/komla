import { ArrowsClockwise, CaretDown } from '@phosphor-icons/react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { FormError } from './FormError';
import { NotificationUpdateReview } from './NotificationUpdateReview';

import type { NotificationIntegrationUpdate } from '../../../../shared/types/notification-integration';
import type { ReactNode } from 'react';

// Building blocks shared by every place in the Agent Integrations menu, so local,
// SSH integrations look and report status the same way.

interface SectionShellProps {
  title: string;
  description: string;
  /** The agent's command, for its logo; without one, a generic agent mark. */
  command?: string;
  expanded: boolean;
  onToggle: () => void;
  statusDot: ReactNode;
  statusLabel: ReactNode;
  /** Shown in place of the status when Komla's notification hooks are out of date. */
  needsUpdate?: boolean;
  children?: ReactNode;
}

/**
 * An agent in a list of them, edge to edge in its card: its logo, name and status, and its
 * integrations below once expanded, lined up under its name.
 */
export function SectionShell({
  title,
  description,
  command,
  expanded,
  onToggle,
  statusDot,
  statusLabel,
  needsUpdate = false,
  children,
}: SectionShellProps) {
  return (
    <div role="group" aria-label={title}>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/[0.04]">
          <AgentPresetIcon
            preset={command ? { name: title, openCommand: command } : null}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{title}</div>
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {needsUpdate ? (
            <UpdateBadge />
          ) : (
            <span className="flex items-center gap-1.5 rounded-full border border-foreground/10 px-2 py-0.5 text-ui text-muted-foreground">
              {statusDot}
              {statusLabel}
            </span>
          )}
          <CaretDown
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              expanded && 'rotate-180'
            )}
          />
        </div>
      </button>
      {/* Indented to the name: the padding, logo and gap above, less each item's own padding. */}
      {expanded && children && (
        <div className="divide-y divide-foreground/8 border-t border-foreground/8 bg-foreground/[0.02] pr-2 pl-[3.25rem]">
          {children}
        </div>
      )}
    </div>
  );
}

export function ConfiguredDot({ isConfigured }: { isConfigured: boolean }) {
  return (
    <span
      className={`size-2 rounded-full ${isConfigured ? 'bg-success' : 'bg-muted-foreground'}`}
    />
  );
}

export function StatusDot({
  isConfigured,
  outdated,
}: {
  isConfigured: boolean;
  outdated?: boolean;
}) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        outdated ? 'bg-warning' : isConfigured ? 'bg-success' : 'bg-muted-foreground/60'
      )}
    />
  );
}

/** Marks an integration whose Komla notification setup differs from what Komla installs now. */
function UpdateBadge({ label = 'Update available' }: { label?: string }) {
  return (
    <Badge tone="warning" size="md">
      <ArrowsClockwise className="size-3" />
      {label}
    </Badge>
  );
}

export function ConfiguredBadge() {
  return <span className="text-xs font-medium text-success">Configured &#10003;</span>;
}

export function RemoveButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-muted-foreground"
      onClick={onClick}
      disabled={loading}
    >
      {loading ? <Spinner size="xs" /> : 'Remove'}
    </Button>
  );
}

export function NotificationUpdateAction({
  update,
  preview,
  loading,
  onApply,
  onRemove,
}: {
  update: NotificationIntegrationUpdate;
  preview: string;
  loading: boolean;
  onApply: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <NotificationUpdateReview
        update={update}
        preview={preview}
        loading={loading}
        onApply={onApply}
      />
      <RemoveButton loading={loading} onClick={onRemove} />
    </>
  );
}

export function EnableButton({
  loading,
  onClick,
  disabled,
}: {
  loading: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button size="sm" onClick={onClick} disabled={disabled ?? loading}>
      {loading && <Spinner size="xs" className="mr-1" />}
      Enable
    </Button>
  );
}

export function ConfiguredAction({
  loading,
  onRemove,
}: {
  loading: boolean;
  onRemove: () => void;
}) {
  return (
    <>
      <ConfiguredBadge />
      <RemoveButton loading={loading} onClick={onRemove} />
    </>
  );
}

interface IntegrationItemProps {
  isConfigured?: boolean;
  outdated?: boolean;
  showStatusDot?: boolean;
  label: string;
  /** What the integration does, behind an info icon beside the label. */
  help?: ReactNode;
  description?: string;
  /** `warning` shows the description in amber, for notes the user shouldn't miss. */
  descriptionTone?: 'muted' | 'warning';
  detailToggle?: ReactNode;
  action: ReactNode;
  warning?: ReactNode;
  errorMessage?: string | null;
  detailContent?: ReactNode;
}

export function IntegrationItem({
  isConfigured,
  outdated = false,
  showStatusDot = true,
  label,
  help,
  description,
  descriptionTone = 'muted',
  detailToggle,
  action,
  warning,
  errorMessage,
  detailContent,
}: IntegrationItemProps) {
  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {showStatusDot && (
              <StatusDot isConfigured={isConfigured ?? false} outdated={outdated} />
            )}
            <span className="text-[13px] font-medium">{label}</span>
            {help}
            {description && (
              <span
                className={cn(
                  'hidden text-ui sm:inline',
                  descriptionTone === 'warning' ? 'text-warning' : 'text-muted-foreground'
                )}
              >
                {description}
              </span>
            )}
          </div>
          {detailToggle}
        </div>
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      </div>
      {warning}
      {errorMessage !== undefined && <FormError message={errorMessage ?? null} />}
      {detailContent}
    </div>
  );
}
