/**
 * @vitest-environment jsdom
 */
import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resumeTerminalRendering } from '../../../src/renderer/lib/xterm-render-resume';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

describe('resumeTerminalRendering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('draws a shown terminal before its IntersectionObserver reports it visible', async () => {
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
