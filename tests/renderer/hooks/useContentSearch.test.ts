// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useContentSearch } from '../../../src/renderer/hooks/useContentSearch';

import type { ContentSearchResult } from '../../../src/renderer/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function result(path: string): ContentSearchResult {
  return { path, lineNumber: 1, lineContent: path, matches: [] };
}

describe('useContentSearch', () => {
  const searchWorkspaceContent = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { api: unknown }).api = { searchWorkspaceContent };
  });

  afterEach(() => {
    vi.useRealTimers();
    searchWorkspaceContent.mockReset();
  });

  async function search(setQuery: (query: string) => void, query: string) {
    act(() => setQuery(query));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  }

  it('keeps the newest results when an older search answers last', async () => {
    const older = deferred<ContentSearchResult[]>();
    const newer = deferred<ContentSearchResult[]>();
    searchWorkspaceContent.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result: hook } = renderHook(() => useContentSearch('ws-ssh', true));

    await search(hook.current.setQuery, 'xyzzy');
    await search(hook.current.setQuery, 'xyz');
    await act(async () => newer.resolve([result('newer.ts')]));
    expect(hook.current.loading).toBe(false);
    await act(async () => older.resolve([]));

    expect(searchWorkspaceContent).toHaveBeenNthCalledWith(1, 'ws-ssh', 'xyzzy', undefined);
    expect(searchWorkspaceContent).toHaveBeenNthCalledWith(2, 'ws-ssh', 'xyz', undefined);
    expect(hook.current.results).toEqual([result('newer.ts')]);
    expect(hook.current.error).toBeNull();
  });

  it('keeps loading while a newer search runs after an older one fails', async () => {
    const older = deferred<ContentSearchResult[]>();
    const newer = deferred<ContentSearchResult[]>();
    searchWorkspaceContent.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result: hook } = renderHook(() => useContentSearch('ws-ssh', true));

    await search(hook.current.setQuery, 'first');
    await search(hook.current.setQuery, 'second');
    await act(async () => older.reject(new Error('SSH host went away')));

    expect(hook.current.loading).toBe(true);
    expect(hook.current.error).toBeNull();
    await act(async () => newer.resolve([result('second.ts')]));
    expect(hook.current.loading).toBe(false);
    expect(hook.current.results).toEqual([result('second.ts')]);
  });

  it('drops a pending search once the query is cleared', async () => {
    const pending = deferred<ContentSearchResult[]>();
    searchWorkspaceContent.mockReturnValueOnce(pending.promise);
    const { result: hook } = renderHook(() => useContentSearch('ws-ssh', true));

    await search(hook.current.setQuery, 'needle');
    await search(hook.current.setQuery, '');
    await act(async () => pending.resolve([result('late.ts')]));

    expect(hook.current.results).toEqual([]);
    expect(hook.current.loading).toBe(false);
  });
});
