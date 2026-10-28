import { cn } from '@/lib/utils';

interface DiffStatsPillsProps {
  additions: number;
  deletions: number;
  className?: string;
}

export function DiffStatsPills({ additions, deletions, className }: DiffStatsPillsProps) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span
      className={cn('flex shrink-0 items-center gap-0.5 font-mono text-ui tabular-nums', className)}
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      {additions > 0 && (
        <span aria-hidden="true" className="px-0.5 text-success">
          +{additions}
        </span>
      )}
      {deletions > 0 && (
        <span aria-hidden="true" className="px-0.5 text-error">
          -{deletions}
        </span>
      )}
    </span>
  );
}
