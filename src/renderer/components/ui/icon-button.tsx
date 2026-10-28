import * as React from 'react';

import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import { Kbd } from './kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

const ICON_BUTTON_SIZES = {
  xs: 'size-6',
  sm: 'size-7',
  md: 'size-8',
} as const;

export interface IconButtonProps extends Omit<ButtonProps, 'size' | 'aria-label' | 'title'> {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  /** Display shortcut (e.g. from `getDisplayShortcut`) shown next to the label in the tooltip. */
  shortcut?: string;
  size?: keyof typeof ICON_BUTTON_SIZES;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Extra props for the tooltip content, e.g. `avoidCollisions` or `className`. */
  tooltipProps?: Omit<React.ComponentPropsWithoutRef<typeof TooltipContent>, 'children' | 'side'>;
  /** Overrides the app-wide tooltip delay, for buttons where tooltips would get in the way. */
  tooltipDelay?: number;
  /** Turn the tooltip off when visible text next to the button already says what it does. */
  tooltip?: boolean;
}

// Radix opens a tooltip on any focus, including focus a dialog or menu moves to the
// button after a click. Like :focus-visible, only show it when the last input was a key.
let lastInputWasPointer = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (lastInputWasPointer = true), true);
  document.addEventListener('keydown', () => (lastInputWasPointer = false), true);
}

export function ignoreFocusAfterPointer(event: React.FocusEvent<HTMLElement>) {
  if (lastInputWasPointer) event.preventDefault();
}

/**
 * An icon-only button that always has an accessible name, and a tooltip with the same
 * label. Works as an `asChild` trigger (DropdownMenuTrigger, PopoverTrigger, ...).
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      shortcut,
      size = 'sm',
      variant = 'ghost',
      tooltip = true,
      tooltipSide,
      tooltipProps,
      tooltipDelay,
      className,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const button = (
      <Button
        ref={ref}
        type={type}
        variant={variant}
        aria-label={label}
        className={cn(
          'shrink-0 p-0',
          ICON_BUTTON_SIZES[size],
          variant === 'ghost' && 'text-muted-foreground hover:text-foreground',
          className
        )}
        {...props}
      />
    );
    if (!tooltip) return button;
    return (
      <Tooltip delayDuration={tooltipDelay}>
        <TooltipTrigger asChild onFocus={ignoreFocusAfterPointer}>
          {button}
        </TooltipTrigger>
        <TooltipContent side={tooltipSide} {...tooltipProps}>
          <span className="flex items-center gap-2">
            {label}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }
);
IconButton.displayName = 'IconButton';
