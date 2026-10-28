import { CaretDown } from '@phosphor-icons/react';
import * as React from 'react';

import { cn } from '@/lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  compact?: boolean;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, compact = false, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          className={cn(
            'flex h-10 w-full appearance-none rounded-md border border-input bg-card px-3 py-2 pr-8 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
            compact && 'h-8 py-1 text-xs',
            className
          )}
          ref={ref}
          {...props}
        >
          {children}
        </select>
        <CaretDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 opacity-50" />
      </div>
    );
  }
);
Select.displayName = 'Select';

export { Select };
