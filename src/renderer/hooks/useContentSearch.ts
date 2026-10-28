import { useState, useEffect, useCallback, useRef } from 'react';

import type { ContentSearchResult, ContentSearchOptions } from '@/types';

export interface ContentSearchState {
  results: ContentSearchResult[];
  query: string;
  setQuery: (query: string) => void;
  loading: boolean;
  error: string | null;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
}

const DEBOUNCE_MS = 300;

export function useContentSearch(
  workspaceId: string,
  enabled: boolean,
  options?: ContentSearchOptions,
  externalQuery?: { query: string; setQuery: (q: string) => void }
): ContentSearchState {
  // Use external query if provided, otherwise manage internally
  const [internalQuery, setInternalQuery] = useState('');
  const query = externalQuery?.query ?? internalQuery;
  const setQuery = externalQuery?.setQuery ?? setInternalQuery;
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Track if using external query (ref to avoid effect dependencies on object)
  const usingExternalQuery = useRef(!!externalQuery);
  usingExternalQuery.current = !!externalQuery;
  const [results, setResults] = useState<ContentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced query setter
  const setQueryDebounced = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setDebouncedQuery(value), DEBOUNCE_MS);
    },
    [setQuery]
  );

  // Cleanup on unmount
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    },
    []
  );

  // Sync debounced query when query changes (handles both internal and external query)
  useEffect(() => {
    if (!enabled) return;

    // Debounce query changes
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, enabled]);

  // Perform search when debounced query changes
  useEffect(() => {
    // Cancel any pending search, so its results never replace newer ones
    abortRef.current?.abort();
    abortRef.current = null;

    if (!enabled) {
      setResults([]);
      setError(null);
      return;
    }

    if (!debouncedQuery.trim()) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    // SSH searches can answer out of order, so each checks its own controller.
    const controller = new AbortController();
    abortRef.current = controller;

    const performSearch = async () => {
      setLoading(true);
      setError(null);

      try {
        const searchResults = await window.api.searchWorkspaceContent(
          workspaceId,
          debouncedQuery,
          options
        );

        // Check if this search was aborted
        if (controller.signal.aborted) return;

        setResults(searchResults);
        setSelectedIndex(0);
      } catch (err) {
        if (controller.signal.aborted) return;

        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void performSearch();
  }, [debouncedQuery, workspaceId, enabled, options]);

  // Reset results when disabled or the workspace changes (don't clear query if external)
  useEffect(() => {
    if (!enabled) {
      // Only reset internal query if not using external query
      if (!usingExternalQuery.current) {
        setInternalQuery('');
      }
      setDebouncedQuery('');
      setResults([]);
      setError(null);
      setSelectedIndex(0);
    }
  }, [enabled, workspaceId]);

  return {
    results,
    query,
    setQuery: setQueryDebounced,
    loading,
    error,
    selectedIndex,
    setSelectedIndex,
  };
}
