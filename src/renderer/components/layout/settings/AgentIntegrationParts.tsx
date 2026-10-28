import { CaretDown } from '@phosphor-icons/react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { FormError } from './FormError';
import { NotificationUpdateReview } from './NotificationUpdateReview';
import { SETTINGS_CARD_CLASS } from './SettingsCard';

import type { NotificationIntegrationUpdate } from '../../../../shared/types/notification-integration';
import type { SshAgent } from '@/types';
import type { ReactNode } from 'react';

// Building blocks shared by every place in the Agent Integrations menu, so local,
// SSH integrations look and report status the same way. The menu ranks them: hooks first, then
// the Komla CLI, then the MCP server, which no longer gets new features.

/** Each agent with a one-click integration, by its key, as its rows in the menu name it. */
export const AGENT_NAMES: Record<SshAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
  opencode: 'OpenCode',
};

/** The Hooks tier's badge: they're what most of Komla's agent features rely on. */
export function RecommendedBadge() {
  return <Badge tone="primary">Recommended</Badge>;
}

// A tier's rows under its band, their content lined up with its heading.
const TIER_ROWS_CLASS = 'divide-y divide-border/30 px-1 py-1';

/**
 * A tier's band: its icon, name and what it adds. `trailing` sits at its right edge. With
 * `toggle`, its name is the button that shows and hides the rows, and the whole band clicks it.
 */
function TierHeading({
  icon,
  title,
  badge,
  description,
  trailing,
  toggle,
  open = true,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  description: ReactNode;
  trailing?: ReactNode;
  toggle?: { expanded: boolean; onToggle: () => void };
  /** Whether rows follow, so the band gets a line below it. */
  open?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 bg-foreground/[0.06] px-4 py-3',
        open && 'border-b border-border/70',
        toggle && 'relative transition-colors hover:bg-foreground/[0.09]'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.08] text-foreground/80 [&>svg]:size-3.5">
            {icon}
          </span>
          <h4 className="text-sm font-semibold">
            {toggle ? (
              <button
                type="button"
                aria-expanded={toggle.expanded}
                onClick={toggle.onToggle}
                className="text-left after:absolute after:inset-0 focus-visible:outline-hidden focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
              >
                {title}
              </button>
            ) : (
              title
            )}
          </h4>
          {badge}
        </div>
        <p className="mt-1 pl-8.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {trailing}
    </div>
  );
}

/** One tier of integrations, as a card of its own: its band, then one row per agent. */
export function IntegrationGroup({
  icon,
  title,
  badge,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={title} className={SETTINGS_CARD_CLASS}>
      <TierHeading icon={icon} title={title} badge={badge} description={description} />
      <div className={TIER_ROWS_CLASS}>{children}</div>
    </div>
  );
}

/** A tier whose rows start hidden, with `summary` saying what's on at its band's right. */
export function CollapsibleIntegrationGroup({
  icon,
  title,
  description,
  summary,
  expanded,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  summary: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={title} className={SETTINGS_CARD_CLASS}>
      <TierHeading
        icon={icon}
        title={title}
        description={description}
        toggle={{ expanded, onToggle }}
        open={expanded}
        trailing={
          <span className="flex shrink-0 items-center gap-2 text-ui text-muted-foreground">
            {summary}
            <Caret expanded={expanded} />
          </span>
        }
      />
      {expanded && <div className={TIER_ROWS_CLASS}>{children}</div>}
    </div>
  );
}

/** Says how many of a tier's integrations are on. */
export function enabledSummary(enabled: boolean[]): string {
  const count = enabled.filter(Boolean).length;
  return count === 0 ? 'Off' : `${count} on`;
}

/** An agent's logo for its row, in its brand colors; without a command, a muted generic mark. */
export function AgentIcon({ name, command }: { name: string; command?: string }) {
  return (
    <AgentPresetIcon
      preset={command ? { name, openCommand: command } : null}
      className={cn('size-4', !command && 'text-muted-foreground')}
    />
  );
}

/**
 * A row for agents without a one-click integration, which expands to how they set themselves
 * up. Its content lines up under its label.
 */
export function OtherAgentsRow({
  description,
  expanded,
  onToggle,
  children,
}: {
  description: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label="Other agents">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.03]"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <AgentIcon name="Other agents" />
        </span>
        <span className="text-[13px] font-medium">Other agents</span>
        <span className="hidden min-w-0 truncate text-ui text-muted-foreground sm:inline">
          {description}
        </span>
        <span className="ml-auto">
          <Caret expanded={expanded} />
        </span>
      </button>
      {/* Indented to the label: the padding, icon and gap above. */}
      {expanded && <div className="space-y-2 pr-3 pb-3 pl-9">{children}</div>}
    </div>
  );
}

function Caret({ expanded }: { expanded: boolean }) {
  return (
    <CaretDown
      className={cn(
        'size-3.5 shrink-0 text-muted-foreground transition-transform',
        expanded && 'rotate-180'
      )}
    />
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
  /** Shown before the label, such as the agent's logo. */
  icon: ReactNode;
  label: string;
  /** What the integration does, behind an info icon beside the label. */
  help?: ReactNode;
  description?: string;
  /** A line under the label. */
  note?: ReactNode;
  detailToggle?: ReactNode;
  action: ReactNode;
  warning?: ReactNode;
  errorMessage?: string | null;
  detailContent?: ReactNode;
}

/** One integration in a tier. Notes and details below line up under its label. */
export function IntegrationItem({
  icon,
  label,
  help,
  description,
  note,
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
            <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
            <span className="text-[13px] font-medium">{label}</span>
            {help}
            {description && (
              <span className="hidden text-ui text-muted-foreground sm:inline">{description}</span>
            )}
          </div>
          {note && <p className="mt-0.5 ml-6 text-xs text-muted-foreground">{note}</p>}
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
