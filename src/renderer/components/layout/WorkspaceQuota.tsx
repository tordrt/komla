import { Cloud } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLicenseStore } from '@/stores/license.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

interface WorkspaceQuotaProps {
  /** In a narrow sidebar, the count alone, leaving the footer room for Komla. */
  compact?: boolean;
  onUpgradeClick: () => void;
}

export function WorkspaceQuota({ compact = false, onUpgradeClick }: WorkspaceQuotaProps) {
  // Quota is loaded at startup and refreshed on terminal status changes
  // by useAppLifecycle, so this component only needs to read the store.
  const quota = useLicenseStore((s) => s.quota);
  // The free limit counts SSH workspaces only, so there's nothing to count until there's one.
  const hasActiveSshWorkspaces = useWorkspacesStore((s) =>
    s.workspaces.some((w) => w.status === 'active' && isSshWorkspace(w))
  );

  if (!quota || !hasActiveSshWorkspaces) return null;
  if (quota.isLicensed) return null;

  const { count, limit } = quota;
  const atLimit = count >= limit;
  const tooltipText = `Free runs ${limit} SSH workspaces at once; local workspaces are unlimited. Stop a running SSH workspace to start another.`;

  // A count in the sidebar's footer row, beside its filter and settings, so the footer stays one
  // quiet row. At the limit it turns a warning, not an error: red is for a blocked attempt.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          // Holds the visible count, so voice control can name it by what it shows.
          aria-label={`${count}/${limit} SSH workspaces running`}
          className={cn(
            'h-6 shrink-0 gap-1 px-1.5 text-2xs tabular-nums hover:text-foreground',
            atLimit ? 'text-warning' : 'text-muted-foreground'
          )}
          onClick={onUpgradeClick}
        >
          {!compact && <Cloud aria-hidden="true" className="size-3.5 shrink-0" />}
          {count}/{limit}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-xs leading-snug">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}
