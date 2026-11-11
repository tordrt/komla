/**
 * @vitest-environment jsdom
 */
import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  holdHiddenTerminalDrawing,
  resumeTerminalRendering,
  stopHiddenTerminalDrawing,
} from '../../../src/renderer/lib/xterm-render-resume';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

interface TerminalInternals {
  _core: {
    _createRenderer(): unknown;
    _renderService: {
      dimensions: unknown;
      setRenderer(renderer: unknown): void;
      handleResize(cols: number, rows: number): void;
      _renderer: {
        value: {
          handleResize(cols: number, rows: number): void;
          renderRows(start: number, end: number): void;
        };
      };
    };
  };
}

/** A terminal open in the page, with the IntersectionObserver xterm watches it through. */
function openTerminal() {
  let reportIntersection: (entry: Partial<IntersectionObserverEntry>) => void = () => {};
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        reportIntersection = (entry) =>
          callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  const terminal = new Terminal({ cols: 20, rows: 4 });
  terminal.open(document.body.appendChild(document.createElement('div')));
  return {
    terminal,
    reportIntersection: (entry: Partial<IntersectionObserverEntry>) => reportIntersection(entry),
  };
}

/** Hands a terminal a new DOM renderer, as disposing its WebGL addon does. */
function replaceRenderer(terminal: Terminal) {
  const { _core: core } = terminal as unknown as TerminalInternals;
  core._renderService.setRenderer(core._createRenderer());
  const draw = vi.spyOn(core._renderService._renderer.value, 'handleResize');
  core._renderService.handleResize(terminal.cols, terminal.rows);
  return draw;
}

/** The same, kept from drawing. */
function replaceRendererHeld(terminal: Terminal) {
  let draw: ReturnType<typeof replaceRenderer> | undefined;
  holdHiddenTerminalDrawing(terminal, () => {
    draw = replaceRenderer(terminal);
  });
  return draw!;
}

const idle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('holdHiddenTerminalDrawing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('is needed: xterm draws a hidden terminal with its new renderer once idle', async () => {
    const { terminal, reportIntersection } = openTerminal();
    reportIntersection({ isIntersecting: false, intersectionRatio: 0 });
    const draw = replaceRenderer(terminal);

    await idle();

    expect(draw).toHaveBeenCalledOnce();
    terminal.dispose();
  });

  it('keeps the hidden terminal from drawing', async () => {
    const { terminal, reportIntersection } = openTerminal();
    reportIntersection({ isIntersecting: false, intersectionRatio: 0 });

    const draw = replaceRendererHeld(terminal);
    await idle();

    expect(draw).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it('keeps one from drawing that xterm has not yet seen leave the screen', async () => {
    // Its IntersectionObserver reports a frame late, and a terminal it takes for shown draws
    // with a new renderer at once.
    const { terminal } = openTerminal();

    const draw = replaceRendererHeld(terminal);
    await idle();

    expect(draw).not.toHaveBeenCalled();
    terminal.dispose();
  });
});

const hidden = { isIntersecting: false, intersectionRatio: 0 };
/** Hides a terminal once the frame xterm had already queued for it has drawn. */
const hide = async (reportIntersection: (entry: Partial<IntersectionObserverEntry>) => void) => {
  await nextFrame();
  reportIntersection(hidden);
};
const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));
/** Rows the terminal's renderer drew, however xterm came to draw them. */
const drawnRows = (terminal: Terminal) =>
  vi.spyOn(
    (terminal as unknown as TerminalInternals)._core._renderService._renderer.value,
    'renderRows'
  );
/** A renderer that is not xterm's DOM renderer, as the WebGL addon's is not. */
const otherRenderer = (terminal: Terminal) => ({
  dimensions: (terminal as unknown as TerminalInternals)._core._renderService.dimensions,
  onRequestRedraw: () => ({ dispose() {} }),
  handleResize: vi.fn(),
  handleSelectionChanged() {},
  handleCursorMove() {},
  handleDevicePixelRatioChange() {},
  handleCharSizeChanged() {},
  handleBlur() {},
  handleFocus() {},
  handleColorChange() {},
  handleOptionsChanged() {},
  renderRows() {},
  clear() {},
  clearTextureAtlas() {},
  dispose() {},
});

describe('stopHiddenTerminalDrawing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('is needed: a hidden terminal draws every row each time its output scrolls', async () => {
    const { terminal, reportIntersection } = openTerminal();
    await hide(reportIntersection);
    const drawn = drawnRows(terminal);

    await write(terminal, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n');
    await nextFrame();

    expect(drawn).toHaveBeenCalledWith(0, terminal.rows - 1);
    terminal.dispose();
  });

  it('keeps a hidden terminal from drawing as its output scrolls', async () => {
    const { terminal, reportIntersection } = openTerminal();
    stopHiddenTerminalDrawing(terminal);
    await hide(reportIntersection);
    const drawn = drawnRows(terminal);

    await write(terminal, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n');
    await nextFrame();
    await idle();

    expect(drawn).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it('keeps one from drawing when it is resized', async () => {
    const { terminal, reportIntersection } = openTerminal();
    stopHiddenTerminalDrawing(terminal);
    await hide(reportIntersection);
    const drawn = drawnRows(terminal);

    terminal.resize(30, 6);
    await idle();

    expect(drawn).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it('draws the terminal at its new size, with what it printed, once it is shown', async () => {
    const { terminal, reportIntersection } = openTerminal();
    stopHiddenTerminalDrawing(terminal);
    await hide(reportIntersection);
    terminal.resize(30, 6);
    await write(terminal, 'printed while hidden');
    await idle();

    resumeTerminalRendering(terminal);
    await nextFrame();

    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    expect(rows).toHaveLength(6);
    expect(rows[0].textContent).toContain('printed while hidden');
    terminal.dispose();
  });

  it('draws a selection made while it was hidden once it is shown', async () => {
    const { terminal, reportIntersection } = openTerminal();
    stopHiddenTerminalDrawing(terminal);
    await write(terminal, 'select this');
    reportIntersection(hidden);

    terminal.select(0, 0, 6);
    await nextFrame();
    expect(document.querySelector('.xterm-selection div')).toBeNull();
    resumeTerminalRendering(terminal);

    expect(document.querySelector('.xterm-selection div')).not.toBeNull();
    terminal.dispose();
  });

  it('leaves a shown terminal drawing as before', async () => {
    const { terminal } = openTerminal();
    stopHiddenTerminalDrawing(terminal);
    const drawn = drawnRows(terminal);

    await write(terminal, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n');
    await nextFrame();

    expect(drawn).toHaveBeenCalledWith(0, terminal.rows - 1);
    terminal.dispose();
  });

  it('leaves a resize to a renderer that is not the DOM renderer, and never repeats it', async () => {
    // The WebGL renderer only resizes its canvas, which xterm puts off until the window is idle.
    const { terminal, reportIntersection } = openTerminal();
    stopHiddenTerminalDrawing(terminal);
    const renderer = otherRenderer(terminal);
    (terminal as unknown as TerminalInternals)._core._renderService.setRenderer(renderer);
    renderer.handleResize.mockClear();
    reportIntersection(hidden);

    terminal.resize(30, 6);
    await idle();
    expect(renderer.handleResize).toHaveBeenCalledExactlyOnceWith(30, 6);
    resumeTerminalRendering(terminal);

    expect(renderer.handleResize).toHaveBeenCalledOnce();
    terminal.dispose();
  });

  it('drops a resize it held once another renderer has taken over', async () => {
    // Shown, a terminal gets its WebGL renderer before it resumes, and that one sized itself.
    const { terminal, reportIntersection } = openTerminal();
    stopHiddenTerminalDrawing(terminal);
    await hide(reportIntersection);
    terminal.resize(30, 6);
    const renderer = otherRenderer(terminal);
    (terminal as unknown as TerminalInternals)._core._renderService.setRenderer(renderer);
    renderer.handleResize.mockClear();

    resumeTerminalRendering(terminal);

    expect(renderer.handleResize).not.toHaveBeenCalled();
    terminal.dispose();
  });
});

describe('resumeTerminalRendering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('draws a shown terminal before its IntersectionObserver reports it visible', async () => {
    const { terminal, reportIntersection } = openTerminal();
    // Hidden: xterm stops drawing and keeps parsing.
    reportIntersection({ isIntersecting: false, intersectionRatio: 0 });
    await new Promise<void>((resolve) => terminal.write('written while hidden', resolve));
    const rendered = vi.fn();
    terminal.onRender(rendered);
    terminal.refresh(0, terminal.rows - 1);
    await nextFrame();
    expect(rendered).not.toHaveBeenCalled();

    resumeTerminalRendering(terminal);
    await nextFrame();

    expect(rendered).toHaveBeenCalled();
    terminal.dispose();
  });
});
