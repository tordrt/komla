import { forwardRef, type ComponentPropsWithoutRef } from 'react';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { ActivitySpinner } from './activity-spinners';

import type { WorkspaceProgress } from '../../../shared/lib/workspace-progress';

// No store here: the workspaces store imports the hover card that shows this badge.

/** Work under way in its color, led by a spinner, as its pill and the hover card show it. */
export const WorkspaceProgressBadge = forwardRef<
  HTMLSpanElement,
  { progress: WorkspaceProgress } & Omit<ComponentPropsWithoutRef<typeof Badge>, 'tone' | 'variant'>
>(function WorkspaceProgressBadge({ progress, className, ...props }, ref) {
  return (
    <Badge ref={ref} tone={progress.tone} variant="outline" className={className} {...props}>
      <ActivitySpinner className="size-2.5 shrink-0" />
      <span className="truncate">{progress.label}</span>
    </Badge>
  );
});

/** A workspace's progress, in the tag's place while no agent is busy. */
export function WorkspaceProgressPill({
  progress,
  className,
}: {
  progress: WorkspaceProgress;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WorkspaceProgressBadge
          data-workspace-progress
          progress={progress}
          className={cn('max-w-32', className)}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        {progress.label}, under way
        {progress.tooltip && <span className="text-muted-foreground"> · {progress.tooltip}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
