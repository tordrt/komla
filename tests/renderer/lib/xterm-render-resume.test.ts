/**
 * @vitest-environment jsdom
 */
import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  holdHiddenTerminalDrawing,
  resizeTerminalRenderer,
  resumeTerminalRendering,
} from '../../../src/renderer/lib/xterm-render-resume';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

interface TerminalInternals {
  _core: {
    _createRenderer(): unknown;
    _renderService: {
      setRenderer(renderer: unknown): void;
      handleResize(cols: number, rows: number): void;
      _renderer: { value: { handleResize(cols: number, rows: number): void } };
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

  it('is drawn by resizeTerminalRenderer once shown', async () => {
    const { terminal } = openTerminal();
    const draw = replaceRendererHeld(terminal);

    resumeTerminalRendering(terminal);
    expect(draw).not.toHaveBeenCalled();
    resizeTerminalRenderer(terminal);

    expect(draw).toHaveBeenCalledExactlyOnceWith(terminal.cols, terminal.rows);
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
