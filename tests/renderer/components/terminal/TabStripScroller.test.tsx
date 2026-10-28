/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TabStripScroller,
  type TabRoom,
} from '../../../../src/renderer/components/terminal/TabStripScroller';

const TAB_WIDTH = 100;

// jsdom has no layout: give the strip a fixed viewport over a row of 100px tabs.
function layOut(scroller: HTMLElement, clientWidth: number) {
  let scrollLeft = 0;
  const tabs = () => Array.from(scroller.querySelectorAll<HTMLElement>('[data-tab-id]'));
  const contentWidth = () => tabs().length * TAB_WIDTH;
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollWidth: { configurable: true, get: () => Math.max(clientWidth, contentWidth()) },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.min(Math.max(0, contentWidth() - clientWidth), Math.max(0, value));
      },
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this === scroller) return new DOMRect(0, 0, clientWidth, 28);
    const index = tabs().indexOf(this);
    return new DOMRect(index * TAB_WIDTH - scrollLeft, 0, TAB_WIDTH, 28);
  });
}

function Strip({
  tabs,
  activeTabId,
  room,
}: {
  tabs: string[];
  activeTabId: string | null;
  room?: TabRoom;
}) {
  return (
    <TabStripScroller
      activeTabId={activeTabId}
      tabsKey={tabs.join(',')}
      room={room}
      className="flex"
    >
      {tabs.map((id) => (
        <div key={id} data-tab-id={id} style={{ minWidth: '60px' }}>
          {id}
        </div>
      ))}
    </TabStripScroller>
  );
}

const TABS = ['t1', 't2', 't3', 't4', 't5', 't6'];

function getScroller() {
  return screen.getByText('t1').parentElement as HTMLElement;
}

describe('TabStripScroller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrolls sideways on a vertical wheel when the tabs overflow', () => {
    render(<Strip tabs={TABS} activeTabId={null} />);
    const scroller = getScroller();
    layOut(scroller, 300);

    fireEvent.wheel(scroller, { deltaY: 120, deltaX: 0 });
    expect(scroller.scrollLeft).toBe(120);

    // Line-based wheels are converted to pixels.
    fireEvent.wheel(scroller, { deltaY: -3, deltaMode: 1 });
    expect(scroller.scrollLeft).toBe(72);
  });

  it('leaves horizontal and Shift+wheel gestures to the browser', () => {
    render(<Strip tabs={TABS} activeTabId={null} />);
    const scroller = getScroller();
    layOut(scroller, 300);

    fireEvent.wheel(scroller, { deltaY: 10, deltaX: 40 });
    fireEvent.wheel(scroller, { deltaY: 120, shiftKey: true });
    expect(scroller.scrollLeft).toBe(0);
  });

  it('ignores the wheel when every tab fits', () => {
    render(<Strip tabs={['t1', 't2']} activeTabId={null} />);
    const scroller = getScroller();
    layOut(scroller, 300);

    fireEvent.wheel(scroller, { deltaY: 120 });
    expect(scroller.scrollLeft).toBe(0);
  });

  it('fades the edges that have hidden tabs', () => {
    render(<Strip tabs={TABS} activeTabId={null} />);
    const scroller = getScroller();
    layOut(scroller, 300);

    fireEvent.scroll(scroller);
    expect(scroller).not.toHaveAttribute('data-overflow-start');
    expect(scroller).toHaveAttribute('data-overflow-end', 'true');

    scroller.scrollLeft = 150;
    fireEvent.scroll(scroller);
    expect(scroller).toHaveAttribute('data-overflow-start', 'true');
    expect(scroller).toHaveAttribute('data-overflow-end', 'true');

    scroller.scrollLeft = 300;
    fireEvent.scroll(scroller);
    expect(scroller).toHaveAttribute('data-overflow-start', 'true');
    expect(scroller).not.toHaveAttribute('data-overflow-end');
  });

  it('scrolls the newly active tab into view past the edge fade', () => {
    const { rerender } = render(<Strip tabs={TABS} activeTabId="t1" />);
    const scroller = getScroller();
    layOut(scroller, 300);

    // t5 spans 400–500: scroll so its right edge sits 24px inside the strip.
    rerender(<Strip tabs={TABS} activeTabId="t5" />);
    expect(scroller.scrollLeft).toBe(224);

    // Back to t2 (100–200, now at -124 on screen): its left edge clears the fade.
    rerender(<Strip tabs={TABS} activeTabId="t2" />);
    expect(scroller.scrollLeft).toBe(76);

    // A tab that is already comfortably visible doesn't move the strip.
    rerender(<Strip tabs={TABS} activeTabId="t3" />);
    expect(scroller.scrollLeft).toBe(76);
  });

  it('scrolls a newly added active tab into view', () => {
    const { rerender } = render(<Strip tabs={TABS} activeTabId="t1" />);
    const scroller = getScroller();
    layOut(scroller, 300);

    // t7 spans 600–700 once added; the strip scrolls to its end, where there is no fade.
    rerender(<Strip tabs={[...TABS, 't7']} activeTabId="t7" />);
    expect(scroller.scrollLeft).toBe(400);
    expect(scroller).not.toHaveAttribute('data-overflow-end');
  });

  it('tells how far its tabs can still shrink, and none once they scroll', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(TAB_WIDTH);
    const room: TabRoom = { px: Infinity, onChange: vi.fn() };
    const { rerender } = render(<Strip tabs={['t1', 't2']} activeTabId="t1" room={room} />);
    layOut(getScroller(), 300);

    rerender(<Strip tabs={['t1', 't2', 't3']} activeTabId="t1" room={room} />);
    expect(room.px).toBe(3 * (TAB_WIDTH - 60));
    expect(room.onChange).toHaveBeenCalled();

    rerender(<Strip tabs={['t1', 't2', 't3', 't4']} activeTabId="t1" room={room} />);
    expect(room.px).toBe(0);
  });
});
