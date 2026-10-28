import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLicenseStore } from '@/stores/license.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

interface WorkspaceQuotaProps {
  onUpgradeClick: () => void;
}

export function WorkspaceQuota({ onUpgradeClick }: WorkspaceQuotaProps) {
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

  // At the limit is a warning, not an error — red is for a blocked attempt.
  const getTextColor = () => {
    if (atLimit) return 'text-warning';
    return 'text-muted-foreground';
  };

  const getBarColor = () => {
    if (atLimit) return 'bg-warning';
    return 'bg-muted-foreground/40';
  };

  const pct = Math.min((count / limit) * 100, 100);
  const tooltipText = `Free runs ${limit} SSH workspaces at once; local workspaces are unlimited. Stop a running SSH workspace to start another.`;

  return (
    <div className="py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-auto w-full justify-start px-2 py-1.5 text-xs',
              getTextColor(),
              'hover:text-foreground'
            )}
            onClick={onUpgradeClick}
          >
            <div className="flex w-full min-w-0 flex-col gap-1.5">
              <div className="flex w-full items-center justify-between gap-2">
                <span className="truncate">SSH workspaces</span>
                <span className="shrink-0">
                  {count}/{limit}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full transition-all duration-300', getBarColor())}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px] text-xs leading-snug">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
