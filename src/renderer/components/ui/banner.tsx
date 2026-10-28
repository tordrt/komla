import {
  CaretLeft,
  CaretRight,
  CheckCircle,
  Info,
  Warning,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import { IconButton } from './icon-button';

export type BannerTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const TONE_CLASSES: Record<BannerTone, { bar: string; icon: string }> = {
  // Solid: a half-transparent wash came out the chrome's color.
  neutral: { bar: 'border-foreground/12 bg-muted', icon: 'text-muted-foreground' },
  info: { bar: 'border-info/30 bg-info/10', icon: 'text-info' },
  success: { bar: 'border-success/30 bg-success/10', icon: 'text-success' },
  warning: { bar: 'border-warning/30 bg-warning/10', icon: 'text-warning' },
  error: { bar: 'border-error/30 bg-error/10', icon: 'text-error' },
};

const TONE_ICONS: Record<BannerTone, React.ElementType> = {
  neutral: Info,
  info: Info,
  success: CheckCircle,
  warning: Warning,
  error: WarningCircle,
};

export interface BannerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: BannerTone;
  /** Replace the tone's icon, or pass `false` for none. */
  icon?: React.ReactNode | false;
  /** What happened, in medium weight. `children` follow it in muted text. */
  title?: React.ReactNode;
  /** `BannerAction` buttons shown before the pager and dismiss button. */
  actions?: React.ReactNode;
  /** Shown when other banners are waiting, e.g. a `BannerPager`. */
  pager?: React.ReactNode;
  onDismiss?: () => void;
  /** Accessible name for the dismiss button. */
  dismissLabel?: string;
}

/** A full-width notice above the status bar: update ready, port changed, announcements. */
export const Banner = React.forwardRef<HTMLDivElement, BannerProps>(
  (
    {
      tone = 'info',
      icon,
      title,
      actions,
      pager,
      onDismiss,
      dismissLabel = 'Dismiss',
      className,
      children,
      ...props
    },
    ref
  ) => {
    const ToneIcon = TONE_ICONS[tone];
    return (
      <div
        ref={ref}
        className={cn(
          'flex min-h-9 items-center gap-2 border-t px-4 py-1 text-sm text-foreground',
          TONE_CLASSES[tone].bar,
          className
        )}
        {...props}
      >
        {icon !== false && (
          <span aria-hidden="true" className={cn('flex shrink-0', TONE_CLASSES[tone].icon)}>
            {icon ?? <ToneIcon className="size-4" />}
          </span>
        )}
        <p className="min-w-0 flex-1">
          {title && <span className="font-medium">{title}</span>}
          {title && children ? ' ' : null}
          {children && <span className={cn(title && 'text-muted-foreground')}>{children}</span>}
        </p>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        {pager}
        {onDismiss && (
          <IconButton label={dismissLabel} size="xs" onClick={onDismiss}>
            <X className="size-3.5" />
          </IconButton>
        )}
      </div>
    );
  }
);
Banner.displayName = 'Banner';

/** A compact button for a banner's actions, so every banner's buttons match. */
export const BannerAction = React.forwardRef<HTMLButtonElement, Omit<ButtonProps, 'size'>>(
  ({ className, ...props }, ref) => (
    <Button
      ref={ref}
      size="sm"
      className={cn('h-7 gap-1.5 px-2.5 text-xs', className)}
      {...props}
    />
  )
);
BannerAction.displayName = 'BannerAction';

export interface BannerPagerProps {
  /** Zero-based index of the banner being shown. */
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}

/** "1 of 3" with previous/next buttons, for when several banners are waiting. */
export function BannerPager({ index, count, onPrevious, onNext }: BannerPagerProps) {
  return (
    <div className="flex shrink-0 items-center text-2xs text-muted-foreground tabular-nums">
      <IconButton label="Previous notice" size="xs" onClick={onPrevious}>
        <CaretLeft className="size-3" />
      </IconButton>
      <span aria-live="polite">
        {index + 1} of {count}
      </span>
      <IconButton label="Next notice" size="xs" onClick={onNext}>
        <CaretRight className="size-3" />
      </IconButton>
    </div>
  );
}
