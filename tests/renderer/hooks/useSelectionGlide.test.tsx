// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SELECTION_GLIDE_MS,
  useSelectionGlide,
} from '../../../src/renderer/hooks/useSelectionGlide';

const TOPS: Record<string, number> = { a: 0, b: 60, far: 900 };

function Item({ id, selected }: { id: string; selected: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const highlightRef = useSelectionGlide(ref, selected);
  return (
    <div ref={ref} data-id={id}>
      {selected && <span ref={highlightRef} data-highlight={id} />}
    </div>
  );
}

function List({ selected }: { selected: string | null }) {
  return (
    <>
      {Object.keys(TOPS).map((id) => (
        <Item key={id} id={id} selected={id === selected} />
      ))}
    </>
  );
}

let now = 1000;
const animate = vi.fn();

beforeEach(() => {
  now = 1000;
  animate.mockClear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const top = TOPS[this.dataset.id ?? ''] ?? 0;
    return { top, height: 48, left: 0, width: 200 } as DOMRect;
  });
  HTMLElement.prototype.animate = animate;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  delete (window as Partial<Window>).matchMedia;
});

/** Selects `first`, then `second` once `gap` ms have passed. */
function switchSelection(first: string, second: string, gap: number) {
  const view = render(<List selected={first} />);
  animate.mockClear();
  now += gap;
  view.rerender(<List selected={second} />);
  return view;
}

describe('useSelectionGlide', () => {
  it('slides the new highlight from where the previous selection was', () => {
    const view = switchSelection('a', 'b', 1000);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(view.container.querySelector('[data-highlight="b"]'));
    expect(animate.mock.calls[0][0]).toEqual([
      { transform: 'translateY(-60px) scaleY(1)' },
      { transform: 'none' },
    ]);
  });

  it('jumps when moves come faster than the glide, as with a held arrow key', () => {
    switchSelection('a', 'b', SELECTION_GLIDE_MS - 1);
    expect(animate).not.toHaveBeenCalled();
  });

  it('jumps across long distances', () => {
    switchSelection('a', 'far', 1000);
    expect(animate).not.toHaveBeenCalled();
  });

  it('appears in place when nothing was highlighted just before, as after the overview', async () => {
    const view = render(<List selected="a" />);
    now += 1000;
    view.rerender(<List selected={null} />);
    await Promise.resolve();
    now += 1000;
    view.rerender(<List selected="b" />);
    expect(animate).not.toHaveBeenCalled();
  });

  it('jumps under reduced motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    switchSelection('a', 'b', 1000);
    expect(animate).not.toHaveBeenCalled();
  });
});
