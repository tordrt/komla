import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useConfigStore } from '@/stores/config.store';

import { AgentsPanel, listAgents } from './AgentsPanel';

import type { AgentsMenuBarState } from '../../../../shared/types';

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

  // The window fits the panel, and a hovered row's card beside it on the left, where main grows
  // the window while the panel stays put on the right. Radix's wrapper is measured, not the card,
  // which scales as it opens.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!loaded || !element) return;
    let reported = '';
    const report = () => {
      const rect = element.getBoundingClientRect();
      const cards = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')]
        .map((card) => card.getBoundingClientRect())
        // Radix parks a card above the window until it has placed it.
        .filter((card) => card.bottom > 0);
      const left = Math.min(rect.left, ...cards.map((card) => card.left));
      const bottom = Math.max(rect.bottom, ...cards.map((card) => card.bottom));
      const [width, height] = [rect.right - left, bottom - rect.top];
      // Most changes in the page, as a card moving, leave its size alone.
      if (`${width}x${height}` === reported) return;
      reported = `${width}x${height}`;
      window.api.resizeAgentsMenuBar(width, height);
    };
    report();
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
      resizes.disconnect();
      cards.disconnect();
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
