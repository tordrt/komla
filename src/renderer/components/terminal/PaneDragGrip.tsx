import { DotsSix } from '@phosphor-icons/react';
import { createContext, useContext } from 'react';

import { cn } from '@/lib/utils';

import type React from 'react';

// A pane's drag grip shows once the pointer is this close to the pane's top, a few rows down so
// it appears as the pointer heads for the edge, and stays hidden over the rest of the pane.
export const DRAG_GRIP_REVEAL_PX = 56;

/** Whether a pointer event over a pane is close enough to its top to show the grip. */
function isNearPaneTop(e: React.MouseEvent<HTMLElement>): boolean {
  return e.clientY - e.currentTarget.getBoundingClientRect().top < DRAG_GRIP_REVEAL_PX;
}

/**
 * A pane's mouse handlers that show its grip while the pointer is near the pane's top. A held
 * button leaves the grip as it is: a press on it only becomes a drag once the pointer has moved,
 * maybe out of the band, and the browser drops the drag if the grip is gone by then. A press that
 * leaves the pane without dragging, such as a text selection, hides the grip on release.
 */
export function paneDragGripRevealProps(
  showGrip: boolean,
  setRevealed: React.Dispatch<React.SetStateAction<boolean>>
) {
  // mousemove fires continuously; update state only when the pointer crosses into or out of the band.
  const reveal = (revealed: boolean) =>
    setRevealed((prev) => (prev === revealed ? prev : revealed));
  return {
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      if (e.buttons === 0) reveal(showGrip && isNearPaneTop(e));
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      if (e.buttons === 0) reveal(false);
      else window.addEventListener('mouseup', () => reveal(false), { once: true });
    },
  };
}

interface PaneDragGripProps {
  revealed: boolean;
  /**
   * Show as a thin notch until the pointer is on it, so it fits above a toolbar's buttons. A
   * terminal pane has no toolbar and gets the whole grip, which is easier to hit and reaches below
   * the split divider that covers the top few pixels of a lower pane.
   */
  notch?: boolean;
  /** Opaque, so what's under the grip doesn't show through its tinted fill. */
  backgroundColor?: string;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

/** The grip at a pane's top middle that drags the pane onto another pane or tab. */
export function PaneDragGrip({
  revealed,
  notch = false,
  backgroundColor,
  onDragStart,
  onDragEnd,
}: PaneDragGripProps) {
  return (
    <div
      data-testid="pane-drag-grip"
      className={cn(
        'group/grip absolute top-0 left-1/2 z-20 flex -translate-x-1/2 cursor-grab justify-center overflow-hidden rounded-b-md active:cursor-grabbing',
        notch
          ? 'h-1.5 w-8 transition-[width,height,opacity] hover:h-4 hover:w-9'
          : 'h-5 w-12 transition-opacity',
        !revealed && 'pointer-events-none opacity-0'
      )}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title="Drag to move this pane"
    >
      {notch && (
        <div className="mt-0.5 h-1 w-6 rounded-full bg-muted-foreground/50 group-hover/grip:hidden" />
      )}
      <div
        className={cn(
          'size-full',
          notch && 'hidden group-hover/grip:block',
          !backgroundColor && 'bg-card'
        )}
        style={backgroundColor ? { backgroundColor } : undefined}
      >
        <div className="flex size-full items-center justify-center bg-foreground/7 text-muted-foreground hover:text-foreground">
          <DotsSix className={notch ? 'size-3.5' : 'size-4'} weight="bold" />
        </div>
      </div>
    </div>
  );
}

export interface PaneDragBar {
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

const PaneDragBarContext = createContext<PaneDragBar | null>(null);

/** Lets the toolbars inside a pane drag it, as the pane's header does. */
export const PaneDragBarProvider = PaneDragBarContext.Provider;

// Whether the press a drag grows from began on a control. A browser fires dragstart at the
// draggable bar, not at the button inside it that was pressed, so the press is what tells.
let pressedOnControl = false;

/** Props that make a bar drag its pane from the space between its controls. */
export function paneDragBarProps(bar: PaneDragBar) {
  return {
    draggable: true,
    onPointerDownCapture: (e: React.PointerEvent) => {
      pressedOnControl = e.target instanceof Element && !!e.target.closest('button, input');
    },
    onDragStart: (e: React.DragEvent) => {
      if (pressedOnControl) {
        e.preventDefault();
        return;
      }
      bar.onDragStart(e);
    },
    onDragEnd: bar.onDragEnd,
  };
}

/**
 * Props that make a toolbar drag its pane from the space between its controls. A toolbar outside
 * a movable pane, such as the file panel's, gets none.
 */
export function usePaneDragBar() {
  const bar = useContext(PaneDragBarContext);
  return bar ? paneDragBarProps(bar) : undefined;
}
