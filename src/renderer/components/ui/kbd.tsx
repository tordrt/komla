import * as React from 'react';

import { cn } from '@/lib/utils';
import { type ShortcutKeys, useShortcutsStore } from '@/stores/shortcuts.store';

/** A keyboard shortcut chip. Pass a display string such as `getDisplayShortcut(action)`. */
export const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-border/70 bg-muted/60 px-1 font-sans text-2xs font-medium text-muted-foreground',
        className
      )}
      {...props}
    />
  )
);
Kbd.displayName = 'Kbd';

/**
 * A shortcut with Shift as its symbol, for tight spots: "Ctrl+Shift+P" becomes "Ctrl⇧P". Mac
 * chords and double taps already read compactly, so they stay as they are.
 */
export function compactShortcut({ keys, separator }: ShortcutKeys): string {
  if (separator !== '+') return keys.join(separator);
  const parts = keys.map((key) => (key === 'Shift' ? '⇧' : key));
  // ⇧ reads as part of the key beside it, so no "+" joins it.
  return parts.reduce((out, key, i) =>
    i === 0 ? key : out + (key === '⇧' || parts[i - 1] === '⇧' ? '' : '+') + key
  );
}

/**
 * The configured shortcut for `action` as a `<Kbd>`, or nothing when it has none. `compact` shows
 * Shift as its symbol.
 */
export function ShortcutHint({
  action,
  compact,
  className,
}: {
  action: string;
  compact?: boolean;
  className?: string;
}) {
  const { getDisplayShortcut, getDisplayKeys } = useShortcutsStore();
  const shortcut = getDisplayShortcut(action);
  if (!shortcut) return null;
  const keys = compact ? getDisplayKeys(action) : null;
  return <Kbd className={className}>{keys ? compactShortcut(keys) : shortcut}</Kbd>;
}
