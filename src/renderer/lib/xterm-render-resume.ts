import type { Terminal } from '@xterm/xterm';

type SelectionChange = [
  start: [number, number] | undefined,
  end: [number, number] | undefined,
  columnSelectMode: boolean,
];

interface RenderService {
  _isPaused?: boolean;
  _renderer?: { value?: object };
  _handleIntersectionChange?: (entry: IntersectionObserverEntry) => void;
  _pausedResizeTask?: { _queue?: { clear?: () => void } };
  handleResize?: (cols: number, rows: number) => void;
  handleSelectionChanged?: (...change: SelectionChange) => void;
  handleCursorMove?: () => void;
}

interface RenderServiceInternals {
  _core?: { _renderService?: RenderService };
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
 * `stopHiddenTerminalDrawing` holds the resize until the terminal is shown. Uses xterm's private
 * render service; if an upgrade removes it, the hidden terminal draws as before.
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

/**
 * Keeps a terminal from drawing while it is off screen, for good. xterm stops an off-screen
 * terminal's ordinary redraws, but not all of them: with its DOM renderer, which a terminal
 * without a WebGL renderer draws with, it still drew every row each time the output scrolled and
 * shortly after each resize, and the cursor's row on each write, measuring each new glyph with a
 * layout of the page. With agents printing in a dozen hidden terminals that kept the window busy,
 * and froze it when many of them had just lost their WebGL renderers. What was skipped is drawn
 * when the terminal is shown: xterm redraws every row then, and this hands it the resize and
 * selection it missed. Uses xterm's private render service; if an upgrade changes it, hidden
 * terminals draw as before.
 */
export function stopHiddenTerminalDrawing(terminal: Terminal): void {
  const service = renderService(terminal);
  if (!service || typeof service._isPaused !== 'boolean') return;
  const { handleResize, handleSelectionChanged, handleCursorMove, _handleIntersectionChange } =
    service;
  if (!handleResize || !handleSelectionChanged || !handleCursorMove || !_handleIntersectionChange) {
    return;
  }
  // The WebGL renderer only resizes its canvas, which xterm leaves until the window is idle.
  const drawsInDom = () => !!service._renderer?.value && '_rowContainer' in service._renderer.value;
  let heldResize = false;
  let heldSelection: SelectionChange | undefined;

  service.handleResize = (cols, rows) => {
    if (service._isPaused && drawsInDom()) heldResize = true;
    else handleResize.call(service, cols, rows);
  };
  service.handleSelectionChanged = (...change) => {
    if (service._isPaused) heldSelection = change;
    else handleSelectionChanged.apply(service, change);
  };
  service.handleCursorMove = () => {
    if (!service._isPaused) handleCursorMove.call(service);
  };
  service._handleIntersectionChange = (entry) => {
    _handleIntersectionChange.call(service, entry);
    if (service._isPaused) return;
    // A renderer that took over meanwhile, as a WebGL one does when shown, sized itself.
    if (heldResize && drawsInDom()) handleResize.call(service, terminal.cols, terminal.rows);
    heldResize = false;
    if (heldSelection) handleSelectionChanged.apply(service, heldSelection);
    heldSelection = undefined;
  };
}
