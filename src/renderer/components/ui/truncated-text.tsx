import { useRef, useState, type ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface TruncatedTextProps {
  children: string;
  className?: string;
  contentClassName?: string;
  /** Extra tooltip lines; they make the tooltip worth opening even when the text fits. */
  details?: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Single-line text that shows its full value in a tooltip, but only when the
 * ellipsis hides part of it, so short names don't get a tooltip that repeats them.
 */
export function TruncatedText({
  children,
  className,
  contentClassName,
  details,
  side = 'bottom',
}: TruncatedTextProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [hasTooltip, setHasTooltip] = useState(false);
  const [open, setOpen] = useState(false);

  const measure = () => {
    const el = textRef.current;
    const next = !!details || (!!el && el.scrollWidth > el.clientWidth);
    setHasTooltip(next);
    return next;
  };

  return (
    <Tooltip open={open} onOpenChange={(next) => setOpen(next && measure())} delayDuration={500}>
      <TooltipTrigger asChild>
        <span
          ref={textRef}
          // An empty title keeps ancestor hints, like the pane header's drag
          // hint, from stacking on this tooltip.
          title={hasTooltip ? '' : undefined}
          onPointerEnter={measure}
          className={cn('truncate', className)}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className={cn('max-w-xs text-xs', contentClassName)}>
        <p className="break-words">{children}</p>
        {details}
      </TooltipContent>
    </Tooltip>
  );
}
