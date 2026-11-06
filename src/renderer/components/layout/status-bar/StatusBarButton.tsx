import * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The look of a status bar item, for triggers that render their own button. */
export const STATUS_BAR_BUTTON_CLASS = cn(
  'flex h-(--status-bar-item-height) shrink-0 items-center gap-1 rounded-lg px-1.5 whitespace-nowrap text-muted-foreground transition-colors',
  'hover:bg-accent/60 hover:text-foreground data-[state=open]:bg-accent/60 data-[state=open]:text-foreground',
  'focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden'
);

/** A status bar item on a tinted pill, as the agents item and custom items with `style: pill`. */
export const STATUS_BAR_PILL_CLASS =
  'rounded-full bg-foreground/8 px-2 hover:bg-foreground/14 data-[state=open]:bg-foreground/14';

/**
 * A branch trigger's look in the status bar, or the title bar's ghost button. In the status bar it
 * shrinks, cutting the branch name short, when its side has no room left for it whole.
 */
export function branchTriggerClass(inStatusBar: boolean): string {
  return inStatusBar
    ? cn(STATUS_BAR_BUTTON_CLASS, 'min-w-0 shrink [&_svg:not(.caret)]:size-3.5')
    : 'no-drag h-7 min-w-0 gap-1.5 px-2';
}

/** Tooltips open above status bar items, away from the window edge. */
export function branchTooltipSide(inStatusBar: boolean): 'top' | undefined {
  return inStatusBar ? 'top' : undefined;
}

interface StatusBarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: React.ReactNode;
}

/**
 * A status bar item: compact text and icons with a tooltip above. Works as an
 * `asChild` trigger (DropdownMenuTrigger, PopoverTrigger, ...).
 */
export const StatusBarButton = React.forwardRef<HTMLButtonElement, StatusBarButtonProps>(
  ({ tooltip, className, type = 'button', ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type={type}
          className={cn(STATUS_BAR_BUTTON_CLASS, className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
);
StatusBarButton.displayName = 'StatusBarButton';
