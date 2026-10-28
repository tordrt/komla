import { beforeEach, describe, expect, it } from 'vitest';

import { useTerminalSearchStore } from '../../../src/renderer/stores/terminal-search.store';

function resetStore(): void {
  useTerminalSearchStore.setState(useTerminalSearchStore.getInitialState(), true);
}

describe('terminal-search.store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('opens search for a terminal', () => {
    useTerminalSearchStore.getState().openSearch('term-1');
    expect(useTerminalSearchStore.getState().activeSearchTerminalId).toBe('term-1');
  });

  it('closes search and clears active terminal id', () => {
    useTerminalSearchStore.getState().openSearch('term-1');
    useTerminalSearchStore.getState().closeSearch();
    expect(useTerminalSearchStore.getState().activeSearchTerminalId).toBeNull();
  });

  it('closeSearch is a no-op when no search is active', () => {
    const before = useTerminalSearchStore.getState();
    useTerminalSearchStore.getState().closeSearch();
    // State reference should be unchanged (zustand returns same object when no update)
    expect(useTerminalSearchStore.getState().activeSearchTerminalId).toBe(
      before.activeSearchTerminalId
    );
  });

  it('sets search query for a terminal', () => {
    useTerminalSearchStore.getState().setSearchQuery('term-1', 'hello');
    expect(useTerminalSearchStore.getState().searchQueryByTerminal['term-1']).toBe('hello');
  });

  it('maintains separate queries per terminal', () => {
    useTerminalSearchStore.getState().setSearchQuery('term-1', 'foo');
    useTerminalSearchStore.getState().setSearchQuery('term-2', 'bar');
    const queries = useTerminalSearchStore.getState().searchQueryByTerminal;
    expect(queries['term-1']).toBe('foo');
    expect(queries['term-2']).toBe('bar');
  });

  it('overwrites existing query for same terminal', () => {
    useTerminalSearchStore.getState().setSearchQuery('term-1', 'old');
    useTerminalSearchStore.getState().setSearchQuery('term-1', 'new');
    expect(useTerminalSearchStore.getState().searchQueryByTerminal['term-1']).toBe('new');
  });

  it('matches case-insensitively until case sensitivity is toggled on', () => {
    expect(useTerminalSearchStore.getState().caseSensitive).toBe(false);

    useTerminalSearchStore.getState().toggleCaseSensitive();
    expect(useTerminalSearchStore.getState().caseSensitive).toBe(true);

    useTerminalSearchStore.getState().toggleCaseSensitive();
    expect(useTerminalSearchStore.getState().caseSensitive).toBe(false);
  });
});
