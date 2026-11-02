import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

interface TruncatingLabelProps {
  children: ReactNode;
  /**
   * Shows the label whole or not at all, for a name too short to shorten, such as "Komla". It
   * also lets a control sized to its content, rather than to the row, take the label's width.
   */
  whole?: boolean;
}

/**
 * A label that truncates down to a few characters, as "Jump…", then drops, for a control that
 * keeps working on its icon alone, so a squeezed row shows the icon rather than a stub like "Ju…".
 * It takes the room the control's other parts leave. The label starts from those few characters'
 * width, or its own with `whole`, and grows to fill the line, left-aligned, as a button would
 * center it; with less room than that, it wraps past an empty first item onto a second line the
 * row hides, whatever sits beside it. Hidden that way, it still names the control.
 */
export function TruncatingLabel({ children, whole = false }: TruncatingLabelProps) {
  return (
    <span className="flex h-full min-w-0 flex-1 flex-wrap items-center overflow-hidden">
      <span aria-hidden="true" className="h-full w-0" />
      <span className={cn('min-w-0 grow truncate text-left', whole ? 'basis-auto' : 'basis-[3em]')}>
        {children}
      </span>
    </span>
  );
}
