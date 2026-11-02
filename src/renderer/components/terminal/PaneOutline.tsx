import type { CSSProperties } from 'react';

interface PaneOutlineProps {
  /** Draw it in the accent, as the focused pane. */
  focused: boolean;
  /** A notification's color, which takes the outline's place until the pane is focused. */
  attention?: { color: string };
}

/**
 * The line around a pane: the accent around the focused pane (with the focused pane border on),
 * and a notification's color while one waits; none otherwise. The stylesheet softens the accent
 * and the notification colors alike. It sits over the pane's content, so the terminal canvas
 * can't paint over it.
 */
export function PaneOutline({ focused, attention }: PaneOutlineProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="pane-outline"
      data-focused={String(focused && !attention)}
      data-attention={attention ? 'true' : undefined}
      className="pane-outline pointer-events-none absolute inset-0 z-10 rounded-[inherit] border transition-colors duration-150"
      style={attention ? ({ '--pane-attention': attention.color } as CSSProperties) : undefined}
    />
  );
}
