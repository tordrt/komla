export function applyTerminalModifiers(data: string, ctrl: boolean, alt: boolean): string {
  let modified = data;
  if (ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) modified = String.fromCharCode(code - 64);
  }
  return alt ? `\x1b${modified}` : modified;
}

export function isTerminalViewportAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY;
}

/**
 * Whether the program in the terminal scrolls its own view, so a drag should reach it as wheel
 * input, as a desktop wheel does: the alternate screen has no scrollback, and a program that asked
 * for mouse reports (any but X10's) receives the wheel.
 */
export function terminalProgramScrolls(
  bufferType: 'normal' | 'alternate',
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
): boolean {
  return (
    bufferType === 'alternate' || (mouseTrackingMode !== 'none' && mouseTrackingMode !== 'x10')
  );
}

/** The scrollback line a dragged scrollbar thumb points at, held `grabOffset` below its top. */
export function scrollThumbLine(
  pointerY: number,
  grabOffset: number,
  trackHeight: number,
  thumbHeight: number,
  maxLine: number
): number {
  const travel = trackHeight - thumbHeight;
  if (travel <= 0) return maxLine;
  const fraction = Math.min(1, Math.max(0, (pointerY - grabOffset) / travel));
  return Math.round(fraction * maxLine);
}

// A pulled rail thumb ignores small wobbles, then speeds up with the distance, to a limit.
const RAIL_DEAD_ZONE_PX = 8;
const RAIL_STEPS_PER_SECOND_PER_PX = 0.4;
const RAIL_MAX_STEPS_PER_SECOND = 40;

/**
 * Wheel steps per second for a fullscreen program's rail thumb pulled `displacementPx` from its
 * resting place; negative pulls (upward) scroll back.
 */
export function railWheelRate(displacementPx: number): number {
  const distance = Math.abs(displacementPx) - RAIL_DEAD_ZONE_PX;
  if (distance <= 0) return 0;
  const rate = Math.min(RAIL_MAX_STEPS_PER_SECOND, distance * RAIL_STEPS_PER_SECOND_PER_PX);
  return displacementPx < 0 ? -rate : rate;
}

// A flick slows like iOS scrolling does, and stops once it barely moves.
const FLING_TIME_CONSTANT_MS = 325;
const FLING_MIN_VELOCITY = 0.05;

/** One frame of a flick: how far it moves (px) and its velocity (px/ms) afterwards, 0 once done. */
export function flingStep(
  velocity: number,
  elapsedMs: number
): { distance: number; velocity: number } {
  const next = velocity * Math.exp(-elapsedMs / FLING_TIME_CONSTANT_MS);
  return {
    distance: velocity * elapsedMs,
    velocity: Math.abs(next) < FLING_MIN_VELOCITY ? 0 : next,
  };
}

export function isTerminalTapGesture(movementPx: number, scrollDeltaPx: number): boolean {
  return movementPx <= 10 && Math.abs(scrollDeltaPx) <= 1;
}

export class TerminalMutationQueue {
  private readonly pending: Array<(done: () => void) => void> = [];
  private running = false;

  enqueue(mutation: (done: () => void) => void): void {
    this.pending.push(mutation);
    this.runNext();
  }

  private runNext(): void {
    if (this.running) return;
    const mutation = this.pending.shift();
    if (!mutation) return;
    this.running = true;
    let completed = false;
    mutation(() => {
      if (completed) return;
      completed = true;
      this.running = false;
      this.runNext();
    });
  }
}
