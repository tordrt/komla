import * as React from 'react';

import { cn } from '@/lib/utils';

import { Spinner } from './spinner';

/** Long enough that a load which ends at once never flashes a spinner. */
const DEFAULT_DELAY_MS = 150;

interface LoadingStateProps {
  /** What is loading, such as "Loading diff": shown beside the spinner and announced. */
  label: string;
  /** How long a load runs before this shows. */
  delayMs?: number;
  className?: string;
  style?: React.CSSProperties;
}

/** A spinner and what is loading, centered in the space it fills, once a load takes a while. */
export function LoadingState({
  label,
  delayMs = DEFAULT_DELAY_MS,
  className,
  style,
}: LoadingStateProps) {
  const [shown, setShown] = React.useState(delayMs <= 0);

  React.useEffect(() => {
    if (shown) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [shown, delayMs]);

  if (!shown) return null;
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center gap-2 text-muted-foreground',
        className
      )}
      style={style}
    >
      <Spinner size="lg" className="size-5" />
      <span className="text-sm">{label}&hellip;</span>
    </div>
  );
}
