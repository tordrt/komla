import type { Terminal } from '@xterm/xterm';

interface RenderServiceInternals {
  _core?: {
    _renderService?: {
      _handleIntersectionChange?: (entry: IntersectionObserverEntry) => void;
    };
  };
}

/**
 * Resumes drawing a terminal that was just shown. xterm stops drawing an off-screen terminal and
 * resumes only in its IntersectionObserver callback, which runs after the next frame paints, so
 * that frame would show the output from when the terminal was hidden. Uses xterm's private render
 * service; if an upgrade removes it, the terminal resumes a frame late as before.
 */
export function resumeTerminalRendering(terminal: Terminal): void {
  (
    terminal as unknown as RenderServiceInternals
  )._core?._renderService?._handleIntersectionChange?.({
    isIntersecting: true,
    intersectionRatio: 1,
  } as IntersectionObserverEntry);
}
