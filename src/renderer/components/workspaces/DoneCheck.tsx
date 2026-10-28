import { Check, type IconProps } from '@phosphor-icons/react';
import { forwardRef } from 'react';

import { cn } from '@/lib/utils';

/**
 * The done check, drawn in from the left as it appears. The wrapper is the window that
 * reveals it; the check keeps its own classes, so callers size and color it as any icon.
 */
export const DoneCheck = forwardRef<SVGSVGElement, IconProps>(({ className, ...props }, ref) => (
  <span className="inline-flex shrink-0 overflow-hidden motion-safe:animate-check-reveal">
    <Check
      ref={ref}
      className={cn('motion-safe:animate-check-reveal-content', className)}
      {...props}
    />
  </span>
));
DoneCheck.displayName = 'DoneCheck';
