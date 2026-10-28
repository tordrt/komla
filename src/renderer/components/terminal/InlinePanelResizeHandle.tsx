import React from 'react';

import { cn } from '@/lib/utils';

const KEYBOARD_STEP_PX = 16;

interface InlinePanelResizeHandleProps {
  label: string;
  title: string;
  /** The panel's current width; the handle sits on its left edge. */
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  isResizing: boolean;
  onResizeStart: (event: React.MouseEvent) => void;
  /** Keyboard resizing, with the width already clamped. */
  onResize: (widthPx: number) => void;
  onReset: () => void;
  className?: string;
}

/**
 * The divider on an inline panel's left edge: drag, arrow keys, or double-click/Home
 * (resets to the default width). A thin line with a wider invisible grab area.
 */
export function InlinePanelResizeHandle({
  label,
  title,
  widthPx,
  minWidthPx,
  maxWidthPx,
  isResizing,
  onResizeStart,
  onResize,
  onReset,
  className,
}: InlinePanelResizeHandleProps) {
  const handleKeyDown = (event: React.KeyboardEvent) => {
    // The panel is to the right of the handle, so moving the handle left widens it.
    const step =
      event.key === 'ArrowLeft'
        ? KEYBOARD_STEP_PX
        : event.key === 'ArrowRight'
          ? -KEYBOARD_STEP_PX
          : 0;
    if (step !== 0) {
      event.preventDefault();
      onResize(Math.min(maxWidthPx, Math.max(minWidthPx, widthPx + step)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onReset();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(widthPx)}
      aria-valuemin={minWidthPx}
      aria-valuemax={maxWidthPx}
      tabIndex={0}
      title={title}
      data-inline-resize-handle="true"
      className={cn(
        // The ::before extends the 3px line to a 9px hit area over the neighbouring panels.
        'relative z-20 w-[3px] shrink-0 cursor-col-resize bg-border/40 transition-colors before:absolute before:inset-y-0 before:-inset-x-[3px] hover:bg-primary/40 focus-visible:bg-primary/50 focus-visible:outline-hidden',
        className,
        isResizing && 'bg-primary/50'
      )}
      onMouseDown={onResizeStart}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
