import { CloudArrowUp } from '@phosphor-icons/react';

/**
 * Commits origin doesn't have, as a cloud and a count. ↑N is reserved for commits ahead of the
 * target branch, so the two never read as the same number.
 */
export function UnpushedCount({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-0.5 text-xs text-ahead">
      <CloudArrowUp className="size-3.5" aria-hidden />
      {count}
      <span className="sr-only"> not pushed</span>
    </span>
  );
}
