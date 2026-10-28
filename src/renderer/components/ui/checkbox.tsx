import { Check } from '@phosphor-icons/react';
import * as React from 'react';

import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

/**
 * A native `<input type="checkbox">` drawn as a consistent box with a check mark, so it
 * looks the same on every platform and keeps native label, form and keyboard behavior.
 * `className` goes on the box (e.g. for margins); the ref and other props go on the input.
 */
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <span className={cn('relative inline-flex size-3.5 shrink-0', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="peer size-full cursor-pointer appearance-none rounded-sm border border-muted-foreground/50 bg-card transition-colors checked:border-primary checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <Check
        aria-hidden="true"
        weight="bold"
        className="pointer-events-none absolute inset-0 m-auto size-2.5 text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  )
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
