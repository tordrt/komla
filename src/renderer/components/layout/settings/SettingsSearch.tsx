import { MagnifyingGlass, type Icon } from '@phosphor-icons/react';
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { cn } from '@/lib/utils';

import {
  highlightMatches,
  searchSettings,
  type SettingsSearchPage,
  type SettingsSearchProject,
  type SettingsSearchResult,
} from './settings-search';

interface SettingsSearchProps {
  pages: readonly (SettingsSearchPage & { icon: Icon })[];
  projects: readonly SettingsSearchProject[];
  onOpenResult: (result: SettingsSearchResult) => void;
  inputRef?: Ref<HTMLInputElement>;
  /** The page navigation, shown while the search box is empty. */
  children: ReactNode;
}

/**
 * Search box for the Settings sidebar. While it has a query, the results replace
 * the page navigation: arrow keys move through them, Enter opens one, and Escape
 * clears the query.
 */
export function SettingsSearch({
  pages,
  projects,
  onOpenResult,
  inputRef,
  children,
}: SettingsSearchProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const hasQuery = query.trim() !== '';
  const results = hasQuery ? searchSettings(query, pages, window.api.platform, projects) : [];
  const active = Math.min(activeIndex, results.length - 1);
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const iconFor = (page: string) => pages.find((candidate) => candidate.value === page)?.icon;

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${listboxId}-option-${active}`)?.scrollIntoView?.({
      block: 'nearest',
    });
  }, [active, listboxId]);

  const openResult = (index: number) => {
    const result = results[index];
    if (!result) return;
    setActiveIndex(index);
    onOpenResult(result);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (results.length === 0) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((active + step + results.length) % results.length);
        break;
      }
      case 'Enter':
        event.preventDefault();
        openResult(active);
        break;
      case 'Escape':
        // Settings stays open while this box has text (see SettingsDialog).
        if (query) {
          setQuery('');
          setActiveIndex(0);
        }
        break;
    }
  };

  return (
    <>
      <div className="px-2 pt-3">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4.5 -translate-y-1/2 text-muted-foreground/70" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search settings"
            aria-expanded={hasQuery}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            data-clears-on-escape=""
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search settings"
            spellCheck={false}
            className="h-9 w-full rounded-lg bg-accent/60 pr-3 pl-9 text-sm text-foreground transition-colors placeholder:text-muted-foreground/70 hover:bg-accent focus:bg-accent focus:ring-1 focus:ring-ring/40 focus:outline-hidden"
          />
        </div>
      </div>
      {hasQuery ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <p className="sr-only" aria-live="polite">
            {results.length === 1 ? '1 result' : `${results.length} results`}
          </p>
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Settings search results"
            className="flex flex-col gap-0.5"
          >
            {results.map((result, index) => {
              const PageIcon = iconFor(result.page);
              return (
                <li
                  key={result.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => openResult(index)}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors duration-150',
                    index === active
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {PageIcon && <PageIcon className="mt-px size-4.5 shrink-0" />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm">
                      {highlightMatches(result.label, query).map((run, runIndex) =>
                        run.match ? (
                          <mark key={runIndex} className="rounded-sm bg-primary/20 text-inherit">
                            {run.text}
                          </mark>
                        ) : (
                          run.text
                        )
                      )}
                    </span>
                    {result.kind !== 'page' && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {result.card ? `${result.pageLabel} › ${result.card}` : result.pageLabel}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {results.length === 0 && (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">No matching settings</p>
          )}
        </div>
      ) : (
        children
      )}
    </>
  );
}
