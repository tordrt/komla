import { Info } from '@phosphor-icons/react';
import * as React from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface InfoTipProps {
  /** Popover body — accepts arbitrary nodes so callers can include `<code>`,
   *  `<strong>`, lists, etc. without escaping. */
  children: React.ReactNode;
  /** Override classes on the trigger button (e.g. align with row baselines or
   *  tint amber inside warning banners). */
  className?: string;
  /** Defaults to a generic label; pass something topic-specific for a11y when
   *  the icon sits next to text whose meaning matters. */
  ariaLabel?: string;
  /** Popover side preference. Defaults to top to keep it off-screen edges in
   *  narrow columns. */
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Click-to-open info popover used to pack verbose explanations behind a small
 * Info icon. Built on Popover (not Tooltip) so:
 *  - Click works as users expect (Tooltip is hover/focus-only).
 *  - The content stays open for reading and lets users select/copy text.
 *  - `modal={false}` keeps the parent Dialog focused; closing the popover
 *    doesn't dismiss the dialog underneath it.
 *
 * `z-[60]` on the content beats the Dialog overlay/content (both `z-50`) so
 * the popover renders above fullscreen dialogs.
 */
function InfoTipRoot({ children, className, ariaLabel = 'More info', side = 'top' }: InfoTipProps) {
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-hidden focus-visible:text-foreground',
            className
          )}
        >
          <Info className="size-3" weight="fill" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        sideOffset={6}
        className="z-[60] w-auto max-w-sm space-y-2.5 p-3 text-xs leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-ui"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

interface InfoTipSectionProps {
  /** Short, scannable label rendered in muted small-caps above the body. Keep
   *  to one or two words ("Scope", "Trade-off", "How to use"). */
  label: string;
  children: React.ReactNode;
}

/**
 * Labeled section inside an `InfoTip`. Use to break up multi-idea explanations
 * so each idea (the rule, its trade-offs, the escape hatch) gets its own
 * scannable heading instead of disappearing into a paragraph blob.
 */
function InfoTipSection({ label, children }: InfoTipSectionProps) {
  return (
    <div className="space-y-1">
      <p className="text-2xs font-medium tracking-wide text-muted-foreground/80 uppercase">
        {label}
      </p>
      <div>{children}</div>
    </div>
  );
}

export const InfoTip = Object.assign(InfoTipRoot, { Section: InfoTipSection });
