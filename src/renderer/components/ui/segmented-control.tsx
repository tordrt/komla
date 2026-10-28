import * as React from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` isn't plain text (e.g. icon only). */
  ariaLabel?: string;
  title?: string;
  /** Display shortcut shown in an icon-only option's tooltip. */
  shortcut?: string;
}

const SIZE_CLASSES = {
  xs: 'h-5 px-1.5 text-ui',
  sm: 'h-6 px-2 text-ui',
  md: 'h-7 px-2.5 text-xs',
} as const;

const ICON_ONLY_SIZE_CLASSES = {
  xs: 'size-5',
  sm: 'size-6',
  md: 'size-7',
} as const;

interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedControlOption<T>[];
  size?: keyof typeof SIZE_CLASSES;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  /** Stretch the segments to fill the container. */
  fill?: boolean;
  /** Show each option's icon alone, with its label in a tooltip. */
  iconOnly?: boolean;
}

/**
 * A single-choice toggle between a few options, as a radio group: arrow keys move
 * between options and select them, and only the selected option is a tab stop.
 * A click always calls `onValueChange`, even on the selected option.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = 'sm',
  disabled = false,
  className,
  fill = false,
  iconOnly = false,
  ...ariaProps
}: SegmentedControlProps<T>) {
  const buttonRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const firstEnabledIndex = options.findIndex((option) => !option.disabled);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : firstEnabledIndex;

  const moveTo = (from: number, step: 1 | -1 | 'first' | 'last') => {
    const enabled = options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled);
    if (enabled.length === 0) return;
    let target: number;
    if (step === 'first') target = enabled[0].index;
    else if (step === 'last') target = enabled[enabled.length - 1].index;
    else {
      const position = enabled.findIndex(({ index }) => index === from);
      const next = (position + step + enabled.length) % enabled.length;
      target = enabled[next].index;
    }
    buttonRefs.current[target]?.focus();
    if (options[target].value !== value) onValueChange(options[target].value);
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    const steps: Record<string, 1 | -1 | 'first' | 'last'> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last',
    };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    moveTo(index, step);
  };

  return (
    <div
      role="radiogroup"
      aria-disabled={disabled || undefined}
      className={cn(
        'items-center gap-0.5 rounded-md bg-muted p-0.5',
        fill ? 'flex' : 'inline-flex',
        className
      )}
      {...ariaProps}
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        const optionDisabled = disabled || option.disabled;
        const button = (
          <button
            key={option.value}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={
              option.ariaLabel ??
              (iconOnly && typeof option.label === 'string' ? option.label : undefined)
            }
            // A disabled button gets no pointer events, so it keeps the native tooltip.
            title={iconOnly && !optionDisabled ? undefined : option.title}
            disabled={optionDisabled}
            tabIndex={index === tabStopIndex ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              iconOnly ? ICON_ONLY_SIZE_CLASSES[size] : SIZE_CLASSES[size],
              fill && 'flex-1',
              selected
                ? 'bg-card text-foreground shadow-xs dark:bg-accent'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.icon}
            {!iconOnly && option.label}
          </button>
        );
        if (!iconOnly) return button;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>
              <span className="flex items-center gap-2">
                {option.title ?? option.label}
                {option.shortcut && <Kbd>{option.shortcut}</Kbd>}
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
