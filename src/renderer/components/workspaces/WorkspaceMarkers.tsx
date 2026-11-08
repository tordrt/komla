import { forwardRef, type ComponentPropsWithoutRef } from 'react';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { shownWorkspaceMarkers, type WorkspaceMarker } from '../../../shared/lib/workspace-markers';

import { ActivitySpinner } from './activity-spinners';

// No store here: the workspaces store imports the hover card that lists these.

/** A marker in its color, led by a spinner while it shows work under way. */
export const WorkspaceMarkerBadge = forwardRef<
  HTMLSpanElement,
  { marker: WorkspaceMarker } & Omit<ComponentPropsWithoutRef<typeof Badge>, 'tone' | 'variant'>
>(function WorkspaceMarkerBadge({ marker, className, ...props }, ref) {
  return (
    <Badge ref={ref} tone={marker.tone} variant="outline" className={className} {...props}>
      {marker.spinner && <ActivitySpinner className="size-2.5 shrink-0" />}
      <span className="truncate">{marker.label}</span>
    </Badge>
  );
});

/** One of a workspace's markers, as the card and the dashboard's row show it. */
export function WorkspaceMarkerPill({
  marker,
  className,
}: {
  marker: WorkspaceMarker;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WorkspaceMarkerBadge
          data-workspace-marker={marker.key}
          {...(marker.spinner && { 'data-workspace-progress': '' })}
          marker={marker}
          className={cn('max-w-32', className)}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        {marker.spinner ? `${marker.label}, under way` : marker.label}
        {marker.tooltip && <span className="text-muted-foreground"> · {marker.tooltip}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** A count of what the pill in the tag's place hides, naming each on hover. */
export function HiddenMarks({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-workspace-more-markers
          className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
        >
          +{labels.length}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        {labels.join(' · ')}
      </TooltipContent>
    </Tooltip>
  );
}

/** Every marker, with what its script says, as the hover card lists them. */
export function WorkspaceMarkerList({ markers }: { markers: WorkspaceMarker[] | undefined }) {
  return shownWorkspaceMarkers(markers).map((marker) => (
    <div key={marker.key} className="mt-2 flex min-w-0 items-baseline gap-1.5 text-xs">
      <WorkspaceMarkerBadge
        data-workspace-info-marker={marker.key}
        {...(marker.spinner && { 'data-workspace-info-progress': '' })}
        marker={marker}
        className="max-w-full shrink-0"
      />
      {marker.tooltip && (
        <span className="min-w-0 break-words text-muted-foreground">{marker.tooltip}</span>
      )}
    </div>
  ));
}
