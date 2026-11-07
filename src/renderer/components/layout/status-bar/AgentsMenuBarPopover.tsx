import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useConfigStore } from '@/stores/config.store';

import { AgentsPanel, listAgents } from './AgentsPanel';

import type { AgentsMenuBarState } from '../../../../shared/types';

/** Where the cards and menus Radix has placed beside the panel are. */
function placedCards(): DOMRect[] {
  return (
    [...document.querySelectorAll('[data-radix-popper-content-wrapper]')]
      .map((card) => card.getBoundingClientRect())
      // Radix parks a card above the window until it has placed it.
      .filter((card) => card.bottom > 0)
  );
}

/**
 * The status bar's agents popover, under the macOS menu bar's item: every window's agents, in
 * Komla's theme. Main fits the window to it, shows it once it has drawn, and opens what's clicked.
 */
export function AgentsMenuBarPopover() {
  const [state, setState] = useState<AgentsMenuBarState | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const loaded = state !== null;
  const theme = state?.theme;
  const doneClearedAt = useConfigStore((s) => s.config?.agentsDoneClearedAt);

  useEffect(() => {
    const unsubscribe = window.api.onAgentsMenuBarState(setState);
    // Main sends it as the page loads, which can be before this listens.
    window.api.requestAgentsMenuBarState();
    return unsubscribe;
  }, []);

  // The working spinner's style, and which finished agents the overview cleared.
  useEffect(() => {
    const config = useConfigStore.getState();
    void config.loadConfig();
    return config.subscribeToChanges();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.api.closeAgentsMenuBar();
    };
    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, []);

  useLayoutEffect(() => {
    if (!theme) return;
    document.documentElement.className = theme.className;
    document.documentElement.style.cssText = theme.style;
  }, [theme]);

  // The window fits the panel, and a hovered row's card beside it on the left, in room main keeps
  // for it so the window only lengthens. Radix's wrapper is measured, not the card, which scales
  // as it opens. Clicks in that room go through to what's under the window while the pointer is
  // off the panel and its cards, as main checks with the page. Where the pointer is tells, not
  // what it's over: an open menu turns off the page's pointer events.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!loaded || !element) return;
    let reported = '';
    let pointer: { x: number; y: number } | null = null;
    // A drag, as a selection in a card, keeps the window until it's let go.
    let dragging = false;
    // Main opens the window taking clicks.
    let passingThrough = false;
    const passThrough = (cards: DOMRect[]) => {
      if (!pointer || dragging) return;
      const { x, y } = pointer;
      const onPage = [element.getBoundingClientRect(), ...cards].some(
        (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
      if (onPage !== passingThrough) return;
      passingThrough = !onPage;
      window.api.setAgentsMenuBarPassThrough(passingThrough);
    };
    const report = () => {
      const rect = element.getBoundingClientRect();
      const cards = placedCards();
      // As the page changes under the pointer at rest.
      passThrough(cards);
      const left = Math.min(rect.left, ...cards.map((card) => card.left));
      const bottom = Math.max(rect.bottom, ...cards.map((card) => card.bottom));
      const [width, height] = [rect.right - left, bottom - rect.top];
      // Most changes in the page, as a card moving, leave its size alone.
      if (`${width}x${height}` === reported) return;
      reported = `${width}x${height}`;
      window.api.resizeAgentsMenuBar(width, height);
    };
    const onMouseMove = ({ clientX: x, clientY: y, buttons }: MouseEvent) => {
      pointer = { x, y };
      dragging = buttons !== 0;
      passThrough(placedCards());
    };
    const onMouseUp = () => {
      dragging = false;
      passThrough(placedCards());
    };
    report();
    addEventListener('mousemove', onMouseMove);
    addEventListener('mouseup', onMouseUp);
    const resizes = new ResizeObserver(report);
    resizes.observe(element);
    // A card mounts, is placed and unmounts in the body, outside the panel.
    const cards = new MutationObserver(report);
    cards.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    return () => {
      removeEventListener('mousemove', onMouseMove);
      removeEventListener('mouseup', onMouseUp);
      resizes.disconnect();
      cards.disconnect();
      // What opens the page again starts out taking clicks.
      if (passingThrough) window.api.setAgentsMenuBarPassThrough(false);
    };
  }, [loaded]);

  if (!state) return null;

  return (
    <TooltipProvider delayDuration={400}>
      {/* Room for the popover's shadow, which the window would otherwise cut off. */}
      <div className="flex justify-end p-3">
        <div
          ref={panel}
          className="floating-surface w-100 overflow-hidden rounded-[calc(var(--radius)+2px)] border text-xs text-popover-foreground shadow-xl"
        >
          <AgentsPanel
            agents={listAgents(state.workspaces, doneClearedAt)}
            listClassName="max-h-[560px]"
            projects={state.projects}
            // A card or menu would flip over the panel before the window has grown to fit it.
            avoidCollisions={false}
            onOpenAgent={({ workspace, terminal }) =>
              window.api.openFromAgentsMenuBar(workspace.id, terminal?.id)
            }
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
