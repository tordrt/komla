import * as React from 'react';

import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** A Phosphor icon element, e.g. `<Folder weight="duotone" />`. It is sized for you. */
  icon?: React.ReactNode;
  /** Restyles the icon's tile, e.g. a neutral one for an icon with its own color. */
  iconClassName?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons that get the user out of the empty state. */
  action?: React.ReactNode;
  /** `sm` fits narrow panels such as the sidebar; `md` fills a main pane. */
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({
  icon,
  iconClassName,
  title,
  description,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  const isSmall = size === 'sm';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        isSmall ? 'gap-1.5 px-3 py-6' : 'gap-3 px-6 py-10',
        className
      )}
    >
      {icon && (
        <div
          aria-hidden="true"
          className={cn(
            'flex items-center justify-center rounded-lg bg-primary/10 text-primary',
            isSmall ? 'size-8 [&_svg]:size-4' : 'size-10 [&_svg]:size-5',
            iconClassName
          )}
        >
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className={cn('font-medium text-foreground', isSmall ? 'text-xs' : 'text-sm')}>
          {title}
        </p>
        {description && (
          <p
            className={cn(
              'mx-auto max-w-xs text-muted-foreground',
              isSmall ? 'text-ui' : 'text-xs'
            )}
          >
            {description}
          </p>
        )}
      </div>
      {action && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>
      )}
    </div>
  );
}
