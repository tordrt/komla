import { DotsThree } from '@phosphor-icons/react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { menuSeparatorClass } from '@/components/ui/menu-styles';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import {
  fitStatusBar,
  LEFT_SIDE_SHARE,
  OVERFLOW_MENU_ATTRIBUTE,
  type StatusBarFit,
} from './status-bar-overflow';
import { StatusBarButton } from './StatusBarButton';
import { moveInto } from './StatusItemPopover';

import type * as React from 'react';

/** One entry on a side of the bar: an item, with anything that follows it, by a key unique to the bar. */
export interface StatusBarEntry {
  key: string;
  node: React.ReactNode;
}

type Side = 'left' | 'right';

const SIDES: Side[] = ['left', 'right'];

/** Puts `nodes` first in `parent`, in order, moving only those out of place. */
function placeInOrder(parent: Element, nodes: Element[]): void {
  nodes.forEach((node, index) => {
    const at = parent.children[index] ?? null;
    if (at !== node) moveInto(parent, node, at);
  });
}

/**
 * Entries' widths with nothing cutting them short, as they would show in the bar. All of them
 * change style before any is read, so the browser lays the bar out once, not once per entry.
 */
function naturalWidths(boxes: HTMLElement[]): number[] {
  const styles = boxes.map(({ style }) => ({ width: style.width, flexShrink: style.flexShrink }));
  for (const { style } of boxes) {
    style.width = 'max-content';
    style.flexShrink = '0';
  }
  const measured = boxes.map((box) => box.getBoundingClientRect().width);
  boxes.forEach(({ style }, index) => Object.assign(style, styles[index]));
  return measured;
}

/** Whether an entry's box shows nothing, so CSS hides it: none of its children has content. */
function showsNothing(box: HTMLElement): boolean {
  return Array.from(box.children).every((child) => !child.hasChildNodes());
}

function px(value: string): number {
  return parseFloat(value) || 0;
}

/**
 * A side's items split by how many fit from the bar's edge: those that show in the bar, and those
 * nearest the middle that go behind the more button.
 */
function splitAt<T>(side: Side, items: readonly T[], fit: number): { inBar: T[]; overflow: T[] } {
  const at = side === 'left' ? Math.min(fit, items.length) : Math.max(0, items.length - fit);
  const [first, last] = [items.slice(0, at), items.slice(at)];
  return side === 'left' ? { inBar: first, overflow: last } : { inBar: last, overflow: first };
}

interface Layout extends StatusBarFit {
  /** How many items that show something the menu holds from each side. */
  leftMore: number;
  rightMore: number;
}

const ALL_FIT: Layout = {
  left: Infinity,
  right: Infinity,
  leftMore: 0,
  rightMore: 0,
};

/**
 * Both halves of the bar, showing each side's entries in order as far as they fit from the bar's
 * edge, and the rest behind one button between the halves, at the start of the right side. Its
 * menu holds the left side's items, then the right's. Each entry renders once, into a box of its
 * own that moves between the bar, its side's part of the menu, and a hidden spot it waits in while
 * the menu is closed: it keeps its state, stays measurable, and the bar sees as soon as it changes
 * width.
 */
export function StatusBarSides({
  left,
  right,
}: {
  left: StatusBarEntry[];
  right: StatusBarEntry[];
}) {
  const entries = { left, right };
  const [layout, setLayout] = useState<Layout>(ALL_FIT);
  const [open, setOpen] = useState(false);
  const [menus, setMenus] = useState<Record<Side, HTMLElement | null>>({
    left: null,
    right: null,
  });
  const leftSideRef = useRef<HTMLDivElement>(null);
  const sideRefs = { left: leftSideRef, right: useRef<HTMLDivElement>(null) };
  const rowRefs = { left: useRef<HTMLSpanElement>(null), right: useRef<HTMLSpanElement>(null) };
  const parkingRefs = { left: useRef<HTMLSpanElement>(null), right: useRef<HTMLSpanElement>(null) };
  const moreRef = useRef<HTMLButtonElement>(null);
  const hosts = useRef(new Map<string, HTMLElement>());
  const widths = useRef(new Map<string, number>());
  const moreWidth = useRef(0);
  const measureRef = useRef<() => void>(() => {});
  // The bar's width and each entry's size and content, which can change with no render here: a
  // window resize, or an item updating itself. A change to an entry's content makes its width
  // stale wherever it is. Made once, where the browser has them.
  const [observers] = useState(() => {
    if (typeof ResizeObserver === 'undefined') return null;
    const remeasure = () => measureRef.current();
    return {
      resize: new ResizeObserver(remeasure),
      mutation: new MutationObserver((records) => {
        for (const { target } of records) {
          const element = target instanceof Element ? target : target.parentElement;
          const key =
            element?.closest<HTMLElement>('[data-status-bar-entry]')?.dataset.statusBarEntry;
          if (key) widths.current.delete(key);
        }
        remeasure();
      }),
    };
  });
  const boxRefs = useRef(new Map<string, (box: HTMLSpanElement | null) => () => void>());
  // Whether the last pointer down, and the last focus, went to an item in a menu or to something
  // it opened. Each is cleared as the next one starts, since a tap's outside check waits for its
  // click.
  const pointerInMenuItem = useRef(false);
  const focusInMenuItem = useRef(false);
  const menuEls = useRef<Record<Side, HTMLElement | null>>({ left: null, right: null });

  /** Watches an entry's box while it's mounted, one callback per entry so React keeps it. */
  const boxRef = (key: string) => {
    let ref = boxRefs.current.get(key);
    if (!ref) {
      ref = (box) => {
        if (!box || !observers) return () => {};
        observers.resize.observe(box);
        observers.mutation.observe(box, { childList: true, subtree: true, characterData: true });
        return () => observers.resize.unobserve(box);
      };
      boxRefs.current.set(key, ref);
    }
    return ref;
  };

  /** The element an entry renders into, made the first time the entry shows. */
  const hostFor = (key: string): HTMLElement => {
    let host = hosts.current.get(key);
    if (!host) {
      host = document.createElement('span');
      host.className = 'contents';
      hosts.current.set(key, host);
    }
    return host;
  };

  /**
   * Each side's entries' widths: 0 for one that shows nothing, as it lays out in the bar for one
   * there or waiting to go back, and as last seen there for one in an open menu, whose items lay
   * out on their own. One whose content changed since, or never seen there, is measured in the menu.
   */
  const measure = () => {
    const leftSide = sideRefs.left.current;
    const bar = leftSide?.parentElement;
    if (!leftSide || !bar) return;
    // Read before the entries are measured, which lays the bar out again.
    const barStyle = getComputedStyle(bar);
    const barWidth =
      bar.getBoundingClientRect().width - px(barStyle.paddingLeft) - px(barStyle.paddingRight);
    const sideGap = px(barStyle.columnGap);
    const itemGap = px(getComputedStyle(leftSide).columnGap);
    const more = moreRef.current?.getBoundingClientRect().width;
    if (more) moreWidth.current = more;
    const boxOf = (key: string) => {
      const box = hosts.current.get(key)?.firstElementChild;
      return box instanceof HTMLElement && !showsNothing(box) ? box : null;
    };
    const stale = [...left, ...right].flatMap(({ key }) => {
      const box = boxOf(key);
      if (!box) return [];
      const inMenu = box.closest(`[${OVERFLOW_MENU_ATTRIBUTE}]`);
      return inMenu && widths.current.has(key) ? [] : [{ key, box }];
    });
    naturalWidths(stale.map(({ box }) => box)).forEach((width, index) =>
      widths.current.set(stale[index].key, width)
    );
    const widthsOf = (side: Side) =>
      entries[side].map(({ key }) => (boxOf(key) ? (widths.current.get(key) ?? 0) : 0));
    const room = {
      width: barWidth,
      sideGap,
      itemGap,
      moreWidth: moreWidth.current,
      left: widthsOf('left'),
      right: widthsOf('right'),
    };
    const fit = fitStatusBar(room);
    const next: Layout = {
      ...fit,
      leftMore: splitAt('left', room.left, fit.left).overflow.filter((width) => width > 0).length,
      rightMore: splitAt('right', room.right, fit.right).overflow.filter((width) => width > 0)
        .length,
    };
    setLayout((prev) =>
      SIDES.every(
        (side) => prev[side] === next[side] && prev[`${side}More`] === next[`${side}More`]
      )
        ? prev
        : next
    );
  };
  measureRef.current = measure;

  // Puts each entry where it shows, then checks it all still fits. Each render can change an
  // entry's width or add one, so this runs after every render; it moves only what's out of place.
  useLayoutEffect(() => {
    const keys = new Set([...left, ...right].map((entry) => entry.key));
    for (const [key, host] of hosts.current) {
      if (keys.has(key)) continue;
      host.remove();
      hosts.current.delete(key);
      widths.current.delete(key);
      boxRefs.current.delete(key);
    }
    for (const side of SIDES) {
      const row = rowRefs[side].current;
      const rest = menus[side] ?? parkingRefs[side].current;
      if (!row || !rest) continue;
      const shown = entries[side].map(({ key }) => hostFor(key));
      const { inBar, overflow } = splitAt(side, shown, layout[side]);
      placeInOrder(row, inBar);
      placeInOrder(rest, overflow);
    }
    measure();
  });

  useEffect(() => {
    const bar = leftSideRef.current?.parentElement;
    if (!bar || !observers) return;
    observers.resize.observe(bar);
    return () => observers.resize.unobserve(bar);
  }, [observers]);

  // The menu closes once nothing is left in it.
  const { leftMore, rightMore } = layout;
  const more = leftMore + rightMore;
  useEffect(() => {
    if (!more) setOpen(false);
  }, [more]);

  // Document listeners run before React's, which are on the app's root.
  useEffect(() => {
    const pointerDown = () => (pointerInMenuItem.current = false);
    const focusIn = () => (focusInMenuItem.current = false);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('focusin', focusIn, true);
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('focusin', focusIn, true);
    };
  }, []);

  const inMenu = (event: React.SyntheticEvent<HTMLElement>) =>
    !!event.currentTarget.closest(`[${OVERFLOW_MENU_ATTRIBUTE}]`);
  // Using an item in the menu, or something the item opened, keeps the menu open: those are outside it
  // in the DOM's tree or in React's.
  const keepOpenFor = (flag: React.RefObject<boolean>) => (event: Event) => {
    if (flag.current) event.preventDefault();
  };

  // As the menu closes, its items move out while they're still in the document, so frames in them
  // stay loaded; once its content is gone, they'd be moved back from outside it. Parking is inert,
  // so one that had focus loses it.
  const [menuRefs] = useState(() => {
    const setMenu = (side: Side) => (element: HTMLElement | null) => {
      const closing = menuEls.current[side];
      const parking = parkingRefs[side].current;
      // A copy: `children` is live, and shrinks as each host moves out.
      if (!element && closing && parking)
        for (const host of Array.from(closing.children)) moveInto(parking, host);
      menuEls.current[side] = element;
      setMenus((prev) => (prev[side] === element ? prev : { ...prev, [side]: element }));
    };
    return { left: setMenu('left'), right: setMenu('right') };
  });

  return (
    <>
      {[...left, ...right].map(({ key, node }) =>
        createPortal(
          // Hidden while it shows nothing, such as an item with nothing to show, so it takes no gap.
          <span
            ref={boxRef(key)}
            data-status-bar-entry={key}
            className="flex min-w-0 items-center gap-1 [&:not(:has(>:not(:empty)))]:hidden"
            onPointerDownCapture={(event) => {
              if (inMenu(event)) pointerInMenuItem.current = true;
            }}
            onFocusCapture={(event) => {
              if (inMenu(event)) focusInMenuItem.current = true;
            }}
          >
            {node}
          </span>,
          hostFor(key),
          key
        )
      )}
      {SIDES.map((side) => (
        <div
          key={side}
          ref={sideRefs[side]}
          // The left side's width is the floor it keeps: `overflow-clip`, unlike `hidden`, leaves
          // its automatic minimum width at min(width, content).
          className={
            side === 'left'
              ? 'flex flex-1 items-center gap-1 overflow-clip'
              : 'flex items-center gap-1 overflow-hidden'
          }
          style={side === 'left' ? { width: `${LEFT_SIDE_SHARE * 100}%` } : undefined}
        >
          {side === 'right' && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <StatusBarButton
                  ref={moreRef}
                  aria-label={`${more} more ${more === 1 ? 'item' : 'items'}`}
                  tooltip={`${more} more ${more === 1 ? 'item' : 'items'}`}
                  hidden={!more}
                >
                  <DotsThree weight="bold" className="size-3.5" />
                </StatusBarButton>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="center"
                sideOffset={6}
                collisionPadding={8}
                aria-label="More status bar items"
                {...{ [OVERFLOW_MENU_ATTRIBUTE]: '' }}
                className="w-auto max-w-[min(36rem,calc(100vw-1rem))] p-1 text-ui"
                // Focus on the menu, not its first item, whose tooltip would open with it. Tab
                // still goes to the items.
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  (event.currentTarget as HTMLElement | null)?.focus();
                }}
                onPointerDownOutside={keepOpenFor(pointerInMenuItem)}
                onFocusOutside={keepOpenFor(focusInMenuItem)}
              >
                {SIDES.map((menuSide) => (
                  <Fragment key={menuSide}>
                    {menuSide === 'right' && leftMore > 0 && rightMore > 0 && (
                      <div role="separator" className={menuSeparatorClass} />
                    )}
                    <div
                      ref={menuRefs[menuSide]}
                      // Hidden while none of its items shows anything, by CSS so one that starts
                      // to shows up at once, and is measured there.
                      className="flex flex-wrap items-center gap-1 [&:not(:has(>*>*>:not(:empty)))]:hidden"
                    />
                  </Fragment>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <span ref={rowRefs[side]} className="contents" />
          {/* Where the menu's items from this side wait while it's closed, inside the bar so they
              lay out as they would in it. */}
          <span
            ref={parkingRefs[side]}
            data-status-bar-parking=""
            aria-hidden="true"
            inert
            className="pointer-events-none invisible fixed top-0 left-0 flex items-center gap-1"
          />
        </div>
      ))}
    </>
  );
}
