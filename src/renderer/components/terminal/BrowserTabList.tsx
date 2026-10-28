import { Globe, Plus, X } from '@phosphor-icons/react';
import { useCallback } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { useBrowserTabsSource } from '@/hooks/useBrowserTabsSource';
import { getBrowserTabLabel, updatePaneBrowserTabs } from '@/lib/browser-tabs';
import { cn } from '@/lib/utils';

import {
  MAX_BROWSER_TABS,
  addBrowserTab,
  getActiveBrowserTab,
  getBrowserTabs,
  selectBrowserTab,
} from '../../../shared/lib/browser-tabs';

import { TabStripScroller } from './TabStripScroller';

interface BrowserTabListProps {
  /** The browser pane's surface id. */
  browserId: string;
  onCloseTab: (tabId: string) => void;
}

/** A browser's tabs, then the button that adds one. */
export function BrowserTabList({ browserId, onCloseTab: closeTab }: BrowserTabListProps) {
  const tabsSource = useBrowserTabsSource(browserId);
  const tabs = getBrowserTabs(tabsSource);
  const activeTabId = getActiveBrowserTab(tabsSource)?.id ?? null;

  const selectTab = useCallback(
    (tabId: string) => {
      updatePaneBrowserTabs(browserId, (current) =>
        getActiveBrowserTab(current)?.id === tabId ? null : selectBrowserTab(current, tabId)
      );
    },
    [browserId]
  );

  const addTab = useCallback(() => {
    updatePaneBrowserTabs(browserId, (current) => addBrowserTab(current));
    // A new tab waits for an address, as in a browser.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLInputElement>(`[data-browser-address="${CSS.escape(browserId)}"]`)
        ?.focus();
    });
  }, [browserId]);

  return (
    <>
      <TabStripScroller
        activeTabId={activeTabId}
        tabsKey={tabs.map((tab) => tab.id).join('\n')}
        className="flex h-full min-w-0 items-stretch"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const label = getBrowserTabLabel(tab);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={cn(
                'group/tab relative flex w-[180px] max-w-[180px] min-w-[72px] items-center border-r border-border pr-1 text-xs transition-colors',
                isActive
                  ? 'flat-tab-active text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <button
                type="button"
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => selectTab(tab.id)}
                // Middle-click closes, as in browsers; preventing the
                // mousedown stops autoscroll/paste on Windows and Linux.
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  closeTab(tab.id);
                }}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-2.5 text-left"
              >
                <Globe className="size-3 shrink-0 opacity-70" />
                <TruncatedText className="min-w-0 flex-1">{label}</TruncatedText>
              </button>
              {/* A sibling of the tab button, not inside it, so each is its own control. */}
              <button
                type="button"
                aria-label={`Close ${label}`}
                onClick={() => closeTab(tab.id)}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded p-0.5 transition-opacity hover:bg-muted/80',
                  isActive
                    ? 'opacity-100'
                    : 'opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100'
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </TabStripScroller>
      <div className="flex shrink-0 items-center pl-0.5">
        <Tooltip delayDuration={600}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={addTab}
              disabled={tabs.length >= MAX_BROWSER_TABS}
              aria-label="New browser tab"
              className="flex h-6 shrink-0 items-center rounded-md px-1.5 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-35"
            >
              <Plus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" avoidCollisions={false}>
            New browser tab
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}
