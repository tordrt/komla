import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export interface TerminalScrollFollowState {
  followBottom: boolean;
  pendingWrites: number;
}

export function createTerminalScrollFollowState(): TerminalScrollFollowState {
  return { followBottom: true, pendingWrites: 0 };
}

/**
 * Write PTY data without letting hidden-layout viewport drift disable the
 * user's follow-bottom intent. xterm invokes the callback after parsing the
 * write, when its new baseY is available.
 */
export function writeTerminalDataFollowingScroll(
  terminal: Terminal,
  state: TerminalScrollFollowState,
  data: string,
  onParsed?: () => void
): void {
  state.pendingWrites++;
  try {
    terminal.write(data, () => {
      state.pendingWrites = Math.max(0, state.pendingWrites - 1);
      onParsed?.();
      if (!state.followBottom) return;
      try {
        const buffer = terminal.buffer.active;
        if (buffer.viewportY < buffer.baseY) terminal.scrollToBottom();
      } catch {
        // Hidden or detached renderers may reject scrolling. The visibility
        // restore will apply the same follow intent when the terminal returns.
      }
    });
  } catch (error) {
    state.pendingWrites = Math.max(0, state.pendingWrites - 1);
    throw error;
  }
}

/** Update follow intent only for user-visible scrolling, never write-induced drift. */
export function updateTerminalScrollFollow(
  terminal: Terminal,
  state: TerminalScrollFollowState,
  isVisible: boolean,
  isUserScrollInteraction = false
): void {
  if (!isVisible || (state.pendingWrites > 0 && !isUserScrollInteraction)) return;
  const buffer = terminal.buffer.active;
  state.followBottom = buffer.viewportY >= buffer.baseY;
}

/** Record explicit user intent before a pending PTY write can snap the viewport back. */
export function stopTerminalScrollFollowOnWheel(
  state: TerminalScrollFollowState,
  event: Pick<WheelEvent, 'deltaY'>
): void {
  if (event.deltaY < 0) state.followBottom = false;
}

/** Record xterm's keyboard scrollback shortcut before it emits onScroll. */
export function stopTerminalScrollFollowOnKey(
  state: TerminalScrollFollowState,
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'>
): void {
  if (event.shiftKey && event.key === 'PageUp') state.followBottom = false;
}

/** Keep explicit search navigation in view while PTY output is still being parsed. */
export function stopTerminalScrollFollowForSearch(
  state: TerminalScrollFollowState | undefined
): void {
  if (state) state.followBottom = false;
}

/** Record explicit intent to resume following before programmatic scrolling. */
export function startTerminalScrollFollow(state: TerminalScrollFollowState | undefined): void {
  if (state) state.followBottom = true;
}

/** Observe both xterm scroll events and the user gestures that can cause them. */
export function observeTerminalScrollFollow(
  terminal: Terminal,
  state: TerminalScrollFollowState,
  container: HTMLElement,
  isVisible: () => boolean
): () => void {
  let pointerScrollInteraction = false;
  let wheelScrollInteraction = false;
  let keyScrollInteraction = false;
  const scrollDisposable = terminal.onScroll(() => {
    updateTerminalScrollFollow(
      terminal,
      state,
      isVisible(),
      pointerScrollInteraction || wheelScrollInteraction || keyScrollInteraction
    );
  });
  const pointerDownHandler = () => {
    pointerScrollInteraction = true;
  };
  const pointerUpHandler = () => {
    pointerScrollInteraction = false;
  };
  const wheelHandler = (event: WheelEvent) => {
    wheelScrollInteraction = true;
    stopTerminalScrollFollowOnWheel(state, event);
    queueMicrotask(() => {
      wheelScrollInteraction = false;
    });
  };
  const keyHandler = (event: KeyboardEvent) => {
    if (!event.shiftKey || (event.key !== 'PageUp' && event.key !== 'PageDown')) return;
    keyScrollInteraction = true;
    stopTerminalScrollFollowOnKey(state, event);
    queueMicrotask(() => {
      keyScrollInteraction = false;
    });
  };
  const targetWindow = container.ownerDocument.defaultView;

  container.addEventListener('pointerdown', pointerDownHandler, true);
  container.addEventListener('wheel', wheelHandler, { capture: true, passive: true });
  container.addEventListener('keydown', keyHandler, true);
  targetWindow?.addEventListener('pointerup', pointerUpHandler, true);
  targetWindow?.addEventListener('pointercancel', pointerUpHandler, true);

  return () => {
    scrollDisposable.dispose();
    container.removeEventListener('pointerdown', pointerDownHandler, true);
    container.removeEventListener('wheel', wheelHandler, true);
    container.removeEventListener('keydown', keyHandler, true);
    targetWindow?.removeEventListener('pointerup', pointerUpHandler, true);
    targetWindow?.removeEventListener('pointercancel', pointerUpHandler, true);
  };
}

/**
 * Load the WebGL rendering addon with scroll preservation.
 * Swapping renderers replaces the canvas element, which can disrupt the
 * scroll position. We capture scroll state before the load and restore it
 * after so the viewport stays put.
 *
 * Note: xterm 5 had an additional race where a stale _currentRowHeight cache
 * (updated RAF-deferred in _innerRefresh) could cause scroll mis-conversion
 * after a renderer swap. xterm 6's DomScrollableElement reads dimensions
 * synchronously from the active renderer, eliminating that race. A single
 * synchronous restore is sufficient.
 */
export function loadRenderAddon(terminal: Terminal, addon: WebglAddon): void {
  const viewportY = terminal.buffer.active.viewportY;
  const wasAtBottom = viewportY >= terminal.buffer.active.baseY;
  try {
    terminal.loadAddon(addon);
  } finally {
    try {
      if (wasAtBottom) {
        terminal.scrollToBottom();
      } else {
        terminal.scrollToLine(viewportY);
      }
    } catch {
      // Scroll restore is best-effort — don't mask addon-load errors
    }
  }
}
