import { X, CaretUp, CaretDown } from '@phosphor-icons/react';
import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import {
  clearTerminalRendererSearch,
  searchTerminalRenderer,
  subscribeTerminalRendererSearchResults,
} from '@/lib/terminal-renderer-runtime';
import { cn } from '@/lib/utils';
import { useTerminalSearchStore } from '@/stores/terminal-search.store';

import { useTmuxFind, type TmuxFindResult } from './useTmuxFind';

// @xterm/addon-search stops counting (and highlighting) matches at its default highlightLimit.
const SEARCH_RESULT_LIMIT = 1000;

interface SearchResults {
  resultIndex: number;
  resultCount: number;
}

function describeResults({ resultIndex, resultCount }: SearchResults): {
  shown: string;
  spoken: string;
} {
  if (resultCount === 0) return { shown: 'No results', spoken: 'No results' };
  const total = resultCount >= SEARCH_RESULT_LIMIT ? `${SEARCH_RESULT_LIMIT}+` : `${resultCount}`;
  // The addon reports no active index when the selected match is past the limit.
  if (resultIndex < 0) return { shown: `?/${total}`, spoken: `${total} matches` };
  return { shown: `${resultIndex + 1}/${total}`, spoken: `Match ${resultIndex + 1} of ${total}` };
}

function describeTmuxResult({ found, count }: TmuxFindResult): {
  shown: string;
  spoken: string;
} | null {
  if (found === false) return { shown: 'No results', spoken: 'No results' };
  if (count === null) return null;
  const shown = count === 1 ? '1 result' : `${count} results`;
  return { shown, spoken: shown };
}

interface SearchStep {
  label: string;
  shortcut: 'Enter' | 'Shift+Enter';
  run: () => void;
}

function searchStatus(
  query: string,
  results: SearchResults | TmuxFindResult | null
): { shown: string; spoken: string; noResults: boolean } | null {
  if (!query || !results) return null;
  if ('found' in results) {
    // A count for an earlier query would read as this one's.
    if (results.query !== query) return null;
    const label = describeTmuxResult(results);
    return label && { ...label, noResults: results.found === false };
  }
  return { ...describeResults(results), noResults: results.resultCount === 0 };
}

interface TerminalSearchBarProps {
  terminalId: string;
  /** Searches the terminal's tmux history on its host, which the renderer never receives. */
  inTmux?: boolean;
}

export function TerminalSearchBar({ terminalId, inTmux = false }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const activeSearchTerminalId = useTerminalSearchStore((s) => s.activeSearchTerminalId);
  const openCount = useTerminalSearchStore((s) => s.openCount);
  const searchQuery = useTerminalSearchStore((s) => s.searchQueryByTerminal[terminalId] || '');
  const setSearchQuery = useTerminalSearchStore((s) => s.setSearchQuery);
  const closeSearch = useTerminalSearchStore((s) => s.closeSearch);
  const caseSensitive = useTerminalSearchStore((s) => s.caseSensitive);
  const toggleCaseSensitive = useTerminalSearchStore((s) => s.toggleCaseSensitive);
  const [results, setResults] = useState<SearchResults | null>(null);

  const isVisible = activeSearchTerminalId === terminalId;
  const searchScreen = useCallback(
    (query: string) => searchTerminalRenderer(terminalId, query, 'next', { caseSensitive }),
    [terminalId, caseSensitive]
  );
  const {
    result: tmuxResult,
    onScreen,
    search: searchTmux,
    step: stepTmux,
  } = useTmuxFind(terminalId, isVisible && inTmux, searchScreen, closeSearch);
  // A full-screen program's search runs on screen, like a local terminal's.
  const searchesTmux = inTmux && !onScreen;

  // Focus input when search bar opens, or is opened again
  useEffect(() => {
    if (isVisible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isVisible, openCount]);

  useEffect(() => {
    if (!isVisible) return;
    const unsubscribe = subscribeTerminalRendererSearchResults(terminalId, setResults);
    return () => {
      unsubscribe();
      setResults(null);
    };
  }, [isVisible, terminalId]);

  const handleFindNext = useCallback(() => {
    if (searchQuery) searchTerminalRenderer(terminalId, searchQuery, 'next', { caseSensitive });
  }, [terminalId, searchQuery, caseSensitive]);

  const handleFindPrevious = useCallback(() => {
    if (searchQuery) {
      searchTerminalRenderer(terminalId, searchQuery, 'previous', { caseSensitive });
    }
  }, [terminalId, searchQuery, caseSensitive]);

  const handleClose = useCallback(() => {
    // Matches stay on screen from a search before the terminal searched tmux.
    clearTerminalRendererSearch(terminalId, true);
    closeSearch();
  }, [terminalId, closeSearch]);

  const handleToggleCaseSensitive = useCallback(() => {
    toggleCaseSensitive();
    if (searchQuery) {
      // The addon only re-highlights for a new term, so drop the old matches first.
      clearTerminalRendererSearch(terminalId);
      searchTerminalRenderer(terminalId, searchQuery, 'next', { caseSensitive: !caseSensitive });
    }
    inputRef.current?.focus();
  }, [terminalId, searchQuery, caseSensitive, toggleCaseSensitive]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(terminalId, value);

      if (searchesTmux) {
        searchTmux(value);
        return;
      }

      // Trigger search as user types
      if (value) {
        searchTerminalRenderer(terminalId, value, 'next', { caseSensitive });
      } else {
        clearTerminalRendererSearch(terminalId);
        setResults(null);
      }
    },
    [terminalId, setSearchQuery, caseSensitive, searchesTmux, searchTmux]
  );

  // tmux searches up from the live screen, so Enter goes to older matches there.
  const steps: [up: SearchStep, down: SearchStep] = useMemo(
    () =>
      searchesTmux
        ? [
            { label: 'Older match', shortcut: 'Enter', run: () => stepTmux('older', searchQuery) },
            {
              label: 'Newer match',
              shortcut: 'Shift+Enter',
              run: () => stepTmux('newer', searchQuery),
            },
          ]
        : [
            { label: 'Previous match', shortcut: 'Shift+Enter', run: handleFindPrevious },
            { label: 'Next match', shortcut: 'Enter', run: handleFindNext },
          ],
    [searchesTmux, stepTmux, searchQuery, handleFindPrevious, handleFindNext]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const shortcut = e.shiftKey ? 'Shift+Enter' : 'Enter';
        steps.find((step) => step.shortcut === shortcut)?.run();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    },
    [steps, handleClose]
  );

  if (!isVisible) return null;

  const resultsLabel = searchStatus(searchQuery, searchesTmux ? tmuxResult : results);
  const [up, down] = steps;

  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border bg-background p-1 shadow-md">
      <input
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
        className="w-40 rounded bg-muted px-2 py-1 text-sm outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/50"
      />
      {resultsLabel && (
        <span
          role="status"
          className={cn(
            'shrink-0 px-1 text-2xs tabular-nums',
            resultsLabel.noResults ? 'text-error' : 'text-muted-foreground'
          )}
        >
          <span aria-hidden>{resultsLabel.shown}</span>
          <span className="sr-only">{resultsLabel.spoken}</span>
        </span>
      )}
      {/* tmux matches case only when the search has capitals. */}
      {!searchesTmux && (
        <IconButton
          label="Match case"
          size="xs"
          tooltipSide="bottom"
          aria-pressed={caseSensitive}
          onClick={handleToggleCaseSensitive}
          className={cn('text-2xs font-semibold', caseSensitive && 'bg-accent text-foreground')}
        >
          Aa
        </IconButton>
      )}
      <IconButton
        label={up.label}
        shortcut={up.shortcut}
        size="xs"
        tooltipSide="bottom"
        onClick={up.run}
      >
        <CaretUp className="size-4" />
      </IconButton>
      <IconButton
        label={down.label}
        shortcut={down.shortcut}
        size="xs"
        tooltipSide="bottom"
        onClick={down.run}
      >
        <CaretDown className="size-4" />
      </IconButton>
      <IconButton
        label="Close search"
        shortcut="Escape"
        size="xs"
        tooltipSide="bottom"
        onClick={handleClose}
      >
        <X className="size-4" />
      </IconButton>
    </div>
  );
}
