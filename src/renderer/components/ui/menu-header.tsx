import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

/**
 * A titled menu's header, as the agents and usage popovers draw theirs: its title, what it's
 * about or an action at its end, over a rule across the menu. Goes first in the menu's content.
 */
export function MenuHeader({
  title,
  icon,
  children,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  /** What sits at the header's end: what the menu is about, its state or an action. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        '-mx-1 -mt-1 mb-1 flex min-h-9 items-center gap-2 border-b border-foreground/10 py-1.5 pr-2 pl-3',
        className
      )}
    >
      {icon && <span className="flex shrink-0 text-muted-foreground [&>svg]:size-3.5">{icon}</span>}
      <span className="shrink-0 text-[13px] font-semibold text-popover-foreground">{title}</span>
      {children && (
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-xs text-muted-foreground">
          {children}
        </span>
      )}
    </div>
  );
}
