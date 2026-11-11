import type { Terminal } from '@xterm/xterm';

interface RenderServiceInternals {
  _core?: {
    _renderService?: {
      _handleIntersectionChange?: (entry: IntersectionObserverEntry) => void;
      _pausedResizeTask?: { _queue?: { clear?: () => void } };
      handleResize?: (cols: number, rows: number) => void;
    };
  };
}

const renderService = (terminal: Terminal) =>
  (terminal as unknown as RenderServiceInternals)._core?._renderService;

/**
 * Resumes drawing a terminal that was just shown. xterm stops drawing an off-screen terminal and
 * resumes only in its IntersectionObserver callback, which runs after the next frame paints, so
 * that frame would show the output from when the terminal was hidden. Uses xterm's private render
 * service; if an upgrade removes it, the terminal resumes a frame late as before.
 */
export function resumeTerminalRendering(terminal: Terminal): void {
  renderService(terminal)?._handleIntersectionChange?.({
    isIntersecting: true,
    intersectionRatio: 1,
  } as IntersectionObserverEntry);
}

/**
 * Swaps a hidden terminal's renderer without the new one drawing. Handed a new renderer, xterm
 * draws a terminal it takes for shown at once, and it learns one left the screen a frame late.
 * It puts off an off-screen terminal's resize only until the window is idle, and the DOM renderer
 * a terminal falls back to when its WebGL renderer goes then draws every row, measuring each new
 * glyph with a layout of the page: the window froze shortly after another workspace was shown.
 * `resizeTerminalRenderer` draws it once it is shown. Uses xterm's private render service; if an
 * upgrade removes it, the hidden terminal draws as before.
 */
export function holdHiddenTerminalDrawing(terminal: Terminal, swapRenderer: () => void): void {
  const service = renderService(terminal);
  service?._handleIntersectionChange?.({
    isIntersecting: false,
    intersectionRatio: 0,
  } as IntersectionObserverEntry);
  try {
    swapRenderer();
  } finally {
    service?._pausedResizeTask?._queue?.clear?.();
  }
}

/** Sizes and draws a terminal with the renderer it has now, as its held resize would have. */
export function resizeTerminalRenderer(terminal: Terminal): void {
  const service = renderService(terminal);
  if (service?.handleResize) service.handleResize(terminal.cols, terminal.rows);
  else terminal.refresh(0, terminal.rows - 1);
}
