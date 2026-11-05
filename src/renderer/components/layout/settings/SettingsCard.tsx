import { cn } from '@/lib/utils';

import { settingsCardId } from './settings-search';

import type { ReactNode } from 'react';

/** A settings card's frame, for content elsewhere in Settings that brings its own cards. */
export const SETTINGS_CARD_CLASS =
  'overflow-clip rounded-xl border border-border/50 bg-card/70 shadow-xs light:border-border light:bg-popover';

interface SettingsCardProps {
  title?: string;
  /** Shown before the title, e.g. a project's color dot. */
  icon?: ReactNode;
  /** Shown right after the title, e.g. a Recommended badge. */
  badge?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
  /** DOM id, which Settings search scrolls to. Defaults to one derived from `title`. */
  id?: string;
  /** Lays out `children` without the card around them, for content that brings its own cards. */
  plain?: boolean;
}

export function SettingsCard({
  title,
  icon,
  badge,
  description,
  children,
  className,
  action,
  id,
  plain = false,
}: SettingsCardProps) {
  return (
    <section
      id={id ?? (title ? settingsCardId(title) : undefined)}
      className={cn(
        'scroll-mt-6 rounded-xl ring-offset-4 ring-offset-background transition-shadow duration-300 data-[search-target]:ring-2 data-[search-target]:ring-primary/40',
        className
      )}
    >
      {(title || description) && (
        <div className="mb-3">
          {title && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {icon}
                <h3 className="text-base font-semibold text-foreground">{title}</h3>
                {badge}
              </div>
              {action && <div>{action}</div>}
            </div>
          )}
          {description && (
            <p className="mt-1 text-[13px] leading-relaxed text-pretty text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
      {plain ? (
        <div className="space-y-3">{children}</div>
      ) : (
        <div
          className={cn(
            SETTINGS_CARD_CLASS,
            '[&>*]:px-5 [&>*]:py-4 [&>*+*]:border-t [&>*+*]:border-border/30'
          )}
        >
          {children}
        </div>
      )}
    </section>
  );
}
