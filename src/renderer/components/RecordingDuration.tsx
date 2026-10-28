import { cn } from '@/lib/utils';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Elapsed recording time, or the time left once the recording limit is near. */
export function RecordingDuration({
  duration,
  remainingSeconds,
  className,
}: {
  duration: number;
  remainingSeconds: number | null;
  className?: string;
}) {
  if (remainingSeconds !== null) {
    return (
      <span className={cn('font-mono tabular-nums', className, 'text-warning')}>
        {formatDuration(remainingSeconds)} left
      </span>
    );
  }
  return (
    <span className={cn('font-mono tabular-nums', className)}>{formatDuration(duration)}</span>
  );
}
