import { CheckCircle, Info, Warning, WarningCircle } from '@phosphor-icons/react';
import * as React from 'react';

import { cn } from '@/lib/utils';

export type CalloutTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const TONE_CLASSES: Record<CalloutTone, { box: string; icon: string }> = {
  neutral: { box: 'border-border bg-muted/40', icon: 'text-muted-foreground' },
  info: { box: 'border-info/30 bg-info/10', icon: 'text-info' },
  success: { box: 'border-success/30 bg-success/10', icon: 'text-success' },
  warning: { box: 'border-warning/30 bg-warning/10', icon: 'text-warning' },
  error: { box: 'border-error/30 bg-error/10', icon: 'text-error' },
};

const TONE_ICONS: Record<CalloutTone, React.ElementType> = {
  neutral: Info,
  info: Info,
  success: CheckCircle,
  warning: Warning,
  error: WarningCircle,
};

const SIZE_CLASSES = {
  sm: { box: 'gap-1.5 px-2.5 py-1.5 text-ui', icon: 'size-3.5' },
  md: { box: 'gap-2 px-3 py-2.5 text-xs', icon: 'size-4' },
} as const;

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: CalloutTone;
  size?: keyof typeof SIZE_CLASSES;
  title?: React.ReactNode;
  /** Replace the tone's icon, or pass `false` for none. */
  icon?: React.ReactNode | false;
  /** A button (or a few) shown at the end of the callout, e.g. "Sync" or "Retry". */
  action?: React.ReactNode;
}

/** A tinted box for a note, warning or error that sits inline with other content. */
export const Callout = React.forwardRef<HTMLDivElement, CalloutProps>(
  ({ tone = 'info', size = 'md', title, icon, action, className, children, ...props }, ref) => {
    const ToneIcon = TONE_ICONS[tone];
    const sizeClasses = SIZE_CLASSES[size];
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-start rounded-md border text-foreground',
          sizeClasses.box,
          TONE_CLASSES[tone].box,
          className
        )}
        {...props}
      >
        {icon !== false && (
          <span aria-hidden="true" className={cn('mt-px flex shrink-0', TONE_CLASSES[tone].icon)}>
            {icon ?? <ToneIcon className={sizeClasses.icon} weight="fill" />}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          {title && <p className="font-medium">{title}</p>}
          {children && <div className={cn(title && 'text-muted-foreground')}>{children}</div>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1.5 self-center">{action}</div>}
      </div>
    );
  }
);
Callout.displayName = 'Callout';
