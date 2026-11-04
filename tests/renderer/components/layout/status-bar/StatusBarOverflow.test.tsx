/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StatusBarSides,
  type StatusBarEntry,
} from '../../../../../src/renderer/components/layout/status-bar/StatusBarOverflow';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

// jsdom has no layout: an element is as wide as its `data-width`, or as what's in it.
function widthOf(element: Element): number {
  if (element instanceof HTMLElement && element.dataset.width) return Number(element.dataset.width);
  return [...element.children].reduce((sum, child) => sum + widthOf(child), 0);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const width = widthOf(this);
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** An item that counts its clicks, to show it keeps its state as it moves. */
function Counter({ name }: { name: string }) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-width="100" onClick={() => setCount(count + 1)}>
      {name} {count}
    </button>
  );
}

const counter = (name: string): StatusBarEntry => ({ key: name, node: <Counter name={name} /> });

function Bar({
  width,
  left = [],
  right = [],
}: {
  width: number;
  left?: StatusBarEntry[];
  right?: StatusBarEntry[];
}) {
  return (
    <TooltipProvider>
      <footer data-testid="bar" data-width={width} style={{ columnGap: '8px' }}>
        <StatusBarSides left={left} right={right} />
      </footer>
    </TooltipProvider>
  );
}

const items = ['one', 'two', 'three', 'four'].map(counter);

describe('StatusBarSides', () => {
  it('shows every item in the bar when they fit, with no more button', () => {
    render(<Bar width={500} right={items} />);

    const [, right] = screen.getByTestId('bar').children;
    for (const name of ['one', 'two', 'three', 'four'])
      expect(right).toContainElement(screen.getByRole('button', { name: `${name} 0` }));
    expect(screen.queryByRole('button', { name: /more item/ })).not.toBeInTheDocument();
  });

  it('puts the items that do not fit behind a button nearest the middle', async () => {
    const user = userEvent.setup();
    render(<Bar width={300} right={items} />);

    // The right side keeps the items at the bar's edge, with its button before them.
    const [, right] = screen.getByTestId('bar').children;
    expect(
      within(right as HTMLElement)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toEqual(['2 more items', 'three 0', 'four 0']);
    expect(screen.queryByRole('button', { name: 'one 0' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '2 more items' }));
    const menu = await screen.findByRole('dialog', { name: 'More status bar items' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['one 0', 'two 0']);
  });

  it('keeps the menu open and the item running as an item in it is used', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Bar width={300} right={items} />);
    await user.click(screen.getByRole('button', { name: '2 more items' }));
    const menu = await screen.findByRole('dialog', { name: 'More status bar items' });

    await user.click(within(menu).getByRole('button', { name: 'one 0' }));
    expect(within(menu).getByRole('button', { name: 'one 1' })).toBeInTheDocument();

    // Back in the bar once there's room, still counting from where it was.
    rerender(<Bar width={1000} right={items} />);
    const [, right] = screen.getByTestId('bar').children;
    expect(right).toContainElement(screen.getByRole('button', { name: 'one 1' }));
    expect(screen.queryByRole('button', { name: /more item/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('counts only the items that show something', () => {
    const empty: StatusBarEntry = { key: 'empty', node: null };
    render(<Bar width={300} right={[empty, ...items.slice(1)]} />);

    expect(screen.getByRole('button', { name: '1 more item' })).toBeInTheDocument();
  });

  it('shows no more button when only items that show nothing are left over', () => {
    const empty = (key: string): StatusBarEntry => ({ key, node: null });
    render(<Bar width={150} right={[empty('a'), empty('b'), items[0]]} />);

    expect(screen.getByRole('button', { name: 'one 0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more item/ })).not.toBeInTheDocument();
  });

  it('counts an item in the open menu once it shows something', async () => {
    const user = userEvent.setup();
    const late = (shows: boolean): StatusBarEntry => ({
      key: 'late',
      node: shows && (
        <button type="button" data-width="100">
          late
        </button>
      ),
    });
    const { rerender } = render(<Bar width={300} right={[late(false), ...items]} />);
    await user.click(screen.getByRole('button', { name: '2 more items' }));

    rerender(<Bar width={300} right={[late(true), ...items]} />);
    expect(screen.getByRole('button', { name: '3 more items' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'More status bar items' })).toBeInTheDocument();
  });

  it('stops counting an item in the open menu once it shows nothing', async () => {
    const user = userEvent.setup();
    const late = (shows: boolean): StatusBarEntry => ({
      key: 'late',
      node: shows && (
        <button type="button" data-width="100">
          late
        </button>
      ),
    });
    const { rerender } = render(<Bar width={300} right={[late(true), ...items]} />);
    await user.click(screen.getByRole('button', { name: '3 more items' }));

    rerender(<Bar width={300} right={[late(false), ...items]} />);
    expect(screen.getByRole('button', { name: '2 more items' })).toBeInTheDocument();
  });

  it('stops watching the size of an item that goes away', () => {
    const watched = new Set<Element>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = (element: Element) => watched.add(element);
        unobserve = (element: Element) => watched.delete(element);
        disconnect = () => watched.clear();
      }
    );
    const { rerender } = render(<Bar width={500} right={items} />);
    const box = screen.getByRole('button', { name: 'four 0' }).parentElement!;
    expect(watched).toContain(box);

    rerender(<Bar width={500} right={items.slice(0, 3)} />);
    expect(watched).not.toContain(box);
  });

  it('keeps watching its items through a StrictMode remount', () => {
    const watched = new Set<Element>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = (element: Element) => watched.add(element);
        unobserve = (element: Element) => watched.delete(element);
        disconnect = () => watched.clear();
      }
    );
    render(
      <StrictMode>
        <Bar width={500} right={items} />
      </StrictMode>
    );

    expect(watched).toContain(screen.getByRole('button', { name: 'four 0' }).parentElement);
    expect(watched).toContain(screen.getByTestId('bar'));
  });

  it("puts both sides' items in one menu, behind one button between them", async () => {
    const user = userEvent.setup();
    // The left may keep 40% of 500: two items, in jsdom, which lays out no gaps and gives the
    // button no width. The right keeps two of its own.
    const right = ['five', 'six', 'seven', 'eight'].map(counter);
    render(<Bar width={500} left={items.slice(0, 3)} right={right} />);

    const [, rightSide] = screen.getByTestId('bar').children;
    const more = screen.getByRole('button', { name: /more item/ });
    expect(more).toHaveAccessibleName('3 more items');
    expect(rightSide.firstElementChild).toBe(more);

    await user.click(more);
    const menu = await screen.findByRole('dialog', { name: 'More status bar items' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['three 0', 'five 0', 'six 0']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
  });
});
