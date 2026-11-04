import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

type TruncatingLabelProps = { children: ReactNode } & (
  | {
      /**
       * Shows the label whole or not at all, for a name too short to shorten, such as "Komla". It
       * also lets a control sized to its content, rather than to the row, take the label's width.
       */
      whole?: boolean;
      trailing?: never;
    }
  | {
      whole?: never;
      /**
       * Sits at the line's end, such as a shortcut, and outlasts the label: the label shortens and
       * drops first, and the trailing part then moves left, beside whatever precedes the label,
       * such as an icon, rather than leaving a gap before it.
       */
      trailing?: ReactNode;
    }
);

/**
 * A label that truncates down to a few characters, as "Jump…", then drops, for a control that
 * keeps working on its icon alone, so a squeezed row shows the icon rather than a stub like "Ju…".
 * It takes the room the control's other parts leave. The label starts from those few characters'
 * width, or its own with `whole`, and grows to fill the line, left-aligned, as a button would
 * center it; with less room than that, it wraps past an empty first item onto a second line the
 * row hides. Hidden that way, it still names the control.
 *
 * The row runs right to left and packs at its left, so the empty item and any trailing part sit at
 * its right end, ahead of the label in line order. They fill the first line before the label, so
 * the label is what wraps out, and the trailing part, left alone on that line, packs to the left.
 */
export function TruncatingLabel({ children, whole = false, trailing }: TruncatingLabelProps) {
  const hasTrailing = trailing != null && trailing !== false;
  return (
    <span className="flex h-full min-w-0 flex-1 flex-row-reverse flex-wrap items-center justify-end overflow-hidden">
      <span aria-hidden="true" className="h-full w-0" />
      <span
        className={cn(
          'order-last min-w-0 grow truncate text-left',
          // Room for "Jump…" whole, so the shortest form isn't a stub like "Jum…".
          whole ? 'basis-auto' : 'basis-[3.5em]',
          // A margin, not padding, so it doesn't eat into that room yet still counts toward
          // whether the label fits on the line.
          hasTrailing && 'mr-1'
        )}
      >
        {children}
      </span>
      {hasTrailing && <span className="flex h-full shrink-0 items-center">{trailing}</span>}
    </span>
  );
}
