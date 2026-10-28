import { cn } from '@/lib/utils';

import type { CommitGraphRowRef } from './commit-graph-layout';

/** A branch or tag on a commit, outlined in its lane color when it has one. */
export function CommitRefPill({
  gitRef,
  className,
}: {
  gitRef: CommitGraphRowRef;
  className?: string;
}) {
  const color = gitRef.color ? `var(--git-graph-${gitRef.color})` : undefined;
  return (
    <span
      className={cn(
        'max-w-28 shrink-0 truncate rounded-full border px-1.5 text-[10px] leading-3.5',
        !color && 'border-foreground/15 text-muted-foreground',
        className
      )}
      style={color ? { borderColor: color, color } : undefined}
    >
      {gitRef.name}
    </span>
  );
}
