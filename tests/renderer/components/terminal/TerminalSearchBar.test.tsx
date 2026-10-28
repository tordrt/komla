/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalSearchBar } from '../../../../src/renderer/components/terminal/TerminalSearchBar';
import { endTmuxFindForTyping } from '../../../../src/renderer/components/terminal/useTmuxFind';
import {
  MANAGED_TMUX_FIND_INPUTS,
  type ManagedTmuxFindResult,
} from '../../../../src/shared/lib/ssh-tmux-attach';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useTerminalSearchStore } from '../../../../src/renderer/stores/terminal-search.store';

type SearchResults = { resultIndex: number; resultCount: number };

const runtime = vi.hoisted(() => ({
  search: vi.fn(() => true),
  clear: vi.fn(),
  listeners: new Map<string, (results: SearchResults) => void>(),
  unsubscribe: vi.fn(),
}));

vi.mock('../../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  searchTerminalRenderer: runtime.search,
  clearTerminalRendererSearch: runtime.clear,
  focusTerminalRenderer: vi.fn(),
  subscribeTerminalRendererSearchResults: (
    terminalId: string,
    listener: (results: SearchResults) => void
  ) => {
    runtime.listeners.set(terminalId, listener);
    return () => {
      runtime.listeners.delete(terminalId);
      runtime.unsubscribe(terminalId);
    };
  },
}));

function renderSearchBar() {
  return render(
    <TooltipProvider>
      <TerminalSearchBar terminalId="term-1" />
    </TooltipProvider>
  );
}

function report(results: SearchResults) {
  act(() => runtime.listeners.get('term-1')?.(results));
}

function getInput() {
  return screen.getByPlaceholderText('Find...');
}

describe('TerminalSearchBar', () => {
  beforeEach(() => {
    runtime.search.mockClear();
    runtime.clear.mockClear();
    runtime.unsubscribe.mockClear();
    runtime.listeners.clear();
    useTerminalSearchStore.setState(useTerminalSearchStore.getInitialState(), true);
    useTerminalSearchStore.getState().openSearch('term-1');
  });

  it('shows the active match and the total', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });
    report({ resultIndex: 2, resultCount: 12 });

    expect(screen.getByRole('status')).toHaveTextContent('3/12');
    expect(screen.getByRole('status')).toHaveTextContent('Match 3 of 12');
  });

  it('says when nothing matches', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'missing' } });
    report({ resultIndex: -1, resultCount: 0 });

    expect(screen.getByRole('status')).toHaveTextContent('No results');
  });

  it('marks counts that hit the highlight limit as a lower bound', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'a' } });
    report({ resultIndex: 4, resultCount: 1000 });

    expect(screen.getByRole('status')).toHaveTextContent('5/1000+');
  });

  it('drops the count when the query is cleared', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });
    report({ resultIndex: 0, resultCount: 1 });
    fireEvent.change(getInput(), { target: { value: '' } });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('searches case-insensitively by default', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'Error' } });

    expect(runtime.search).toHaveBeenLastCalledWith('term-1', 'Error', 'next', {
      caseSensitive: false,
    });
  });

  it('re-runs the search when match case is toggled', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'Error' } });

    const toggle = screen.getByRole('button', { name: 'Match case' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(runtime.clear).toHaveBeenLastCalledWith('term-1');
    expect(runtime.search).toHaveBeenLastCalledWith('term-1', 'Error', 'next', {
      caseSensitive: true,
    });

    fireEvent.keyDown(getInput(), { key: 'Enter', shiftKey: true });
    expect(runtime.search).toHaveBeenLastCalledWith('term-1', 'Error', 'previous', {
      caseSensitive: true,
    });
  });

  it('focuses and selects the query again when search opens while already open', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    act(() => useTerminalSearchStore.getState().openSearch('term-1'));

    const input = getInput() as HTMLInputElement;
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'error'.length]);
    elsewhere.remove();
  });

  it('stops listening for results once the search closes', () => {
    renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });
    report({ resultIndex: 0, resultCount: 3 });

    fireEvent.keyDown(getInput(), { key: 'Escape' });

    expect(runtime.unsubscribe).toHaveBeenCalledWith('term-1');
    act(() => useTerminalSearchStore.getState().openSearch('term-1'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('TerminalSearchBar in tmux', () => {
  const findInSshTerminal = vi.fn();
  const sendInput = vi.fn();

  function renderTmuxSearchBar() {
    return render(
      <TooltipProvider>
        <TerminalSearchBar terminalId="term-1" inTmux />
      </TooltipProvider>
    );
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    findInSshTerminal
      .mockReset()
      .mockResolvedValue({ found: true, count: 4, alternateScreen: false });
    sendInput.mockReset();
    (window as any).api = { findInSshTerminal, sendInput };
    runtime.search.mockClear();
    runtime.clear.mockClear();
    useTerminalSearchStore.setState(useTerminalSearchStore.getInitialState(), true);
    useTerminalSearchStore.getState().openSearch('term-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('searches the tmux history once typing pauses and shows the count', async () => {
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'e' } });
    fireEvent.change(getInput(), { target: { value: 'error' } });
    expect(findInSshTerminal).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(findInSshTerminal).toHaveBeenCalledTimes(1);
    expect(findInSshTerminal).toHaveBeenCalledWith('term-1', 'error');
    expect(runtime.search).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('4 results');
  });

  it('says when tmux finds nothing', async () => {
    findInSshTerminal.mockResolvedValue({ found: false, count: 0, alternateScreen: false });
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'missing' } });
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(screen.getByRole('status')).toHaveTextContent('No results');
  });

  it('steps to older matches with Enter and newer ones with Shift+Enter', async () => {
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });
    await act(() => vi.advanceTimersByTimeAsync(200));

    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.keyDown(getInput(), { key: 'Enter', shiftKey: true });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(sendInput.mock.calls).toEqual([
      ['term-1', MANAGED_TMUX_FIND_INPUTS.older],
      ['term-1', MANAGED_TMUX_FIND_INPUTS.newer],
    ]);
  });

  it('searches before stepping when Enter comes before the pause', async () => {
    const search = deferred<ManagedTmuxFindResult>();
    findInSshTerminal.mockReturnValue(search.promise);
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });

    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(findInSshTerminal.mock.calls).toEqual([['term-1', 'error']]);
    // The first Enter shows the newest match; stepping before it lands would race the search.
    expect(sendInput).not.toHaveBeenCalled();

    await act(async () => search.resolve({ found: true, count: 2, alternateScreen: false }));
    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sendInput).toHaveBeenCalledWith('term-1', MANAGED_TMUX_FIND_INPUTS.older);
  });

  it('leaves tmux scrollback once the search in flight lands when the bar closes', async () => {
    const search = deferred<ManagedTmuxFindResult>();
    findInSshTerminal.mockReturnValue(search.promise);
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });
    await act(() => vi.advanceTimersByTimeAsync(200));

    fireEvent.keyDown(getInput(), { key: 'Escape' });
    expect(sendInput).not.toHaveBeenCalled();
    await act(async () => search.resolve({ found: true, count: 2, alternateScreen: false }));

    expect(sendInput).toHaveBeenCalledWith('term-1', MANAGED_TMUX_FIND_INPUTS.close);
  });

  it('leaves tmux scrollback when the query is cleared', async () => {
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'error' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(getInput(), { target: { value: '' } });
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(findInSshTerminal).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith('term-1', MANAGED_TMUX_FIND_INPUTS.close);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('leaves tmux alone when the bar closes before searching', async () => {
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'err' } });
    fireEvent.keyDown(getInput(), { key: 'Escape' });
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(findInSshTerminal).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('searches the screen of a full-screen program, which keeps no tmux history', async () => {
    findInSshTerminal.mockResolvedValue({ found: null, count: null, alternateScreen: true });
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'err' } });
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(runtime.search).toHaveBeenLastCalledWith('term-1', 'err', 'next', {
      caseSensitive: false,
    });
    report({ resultIndex: 0, resultCount: 3 });
    expect(screen.getByRole('status')).toHaveTextContent('1/3');
    expect(screen.getByRole('button', { name: 'Match case' })).toBeInTheDocument();

    // The rest of this search stays on screen, without asking the host again.
    fireEvent.change(getInput(), { target: { value: 'error' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(findInSshTerminal).toHaveBeenCalledTimes(1);
    expect(runtime.search).toHaveBeenLastCalledWith('term-1', 'error', 'next', {
      caseSensitive: false,
    });
    expect(sendInput).not.toHaveBeenCalled();

    // Closing clears the on-screen matches; the next search asks the host again.
    fireEvent.keyDown(getInput(), { key: 'Escape' });
    expect(runtime.clear).toHaveBeenCalledWith('term-1', true);
    act(() => useTerminalSearchStore.getState().openSearch('term-1'));
    fireEvent.change(getInput(), { target: { value: 'again' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(findInSshTerminal).toHaveBeenCalledTimes(2);
  });

  it('runs searches on the host one at a time, skipping ones a newer search replaced', async () => {
    const first = deferred<ManagedTmuxFindResult>();
    findInSshTerminal.mockReturnValueOnce(first.promise);
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'hel' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(getInput(), { target: { value: 'hell' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(getInput(), { target: { value: 'hello' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(findInSshTerminal).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve({ found: true, count: 9, alternateScreen: false }));

    expect(findInSshTerminal.mock.calls).toEqual([
      ['term-1', 'hel'],
      ['term-1', 'hello'],
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('4 results');
  });

  it('leaves the old search before a new one starts after the query is cleared', async () => {
    const first = deferred<ManagedTmuxFindResult>();
    const calls: string[] = [];
    findInSshTerminal.mockImplementation((_id: string, query: string) => {
      calls.push(`find ${query}`);
      return calls.length === 1
        ? first.promise
        : Promise.resolve({ found: true, count: 3, alternateScreen: false });
    });
    sendInput.mockImplementation((_id: string, data: string) => {
      calls.push(data === MANAGED_TMUX_FIND_INPUTS.close ? 'close' : data);
    });
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'foo' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(getInput(), { target: { value: '' } });
    fireEvent.change(getInput(), { target: { value: 'bar' } });
    await act(() => vi.advanceTimersByTimeAsync(200));

    await act(async () => first.resolve({ found: true, count: 2, alternateScreen: false }));

    expect(calls).toEqual(['find foo', 'close', 'find bar']);
    expect(screen.getByRole('status')).toHaveTextContent('3 results');
  });

  it('keeps its place when the query is typed back before the pause', async () => {
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'foo' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.keyDown(getInput(), { key: 'Enter' });
    fireEvent.change(getInput(), { target: { value: 'foox' } });
    fireEvent.change(getInput(), { target: { value: 'foo' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(findInSshTerminal).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls).toEqual([
      ['term-1', MANAGED_TMUX_FIND_INPUTS.older],
      ['term-1', MANAGED_TMUX_FIND_INPUTS.older],
    ]);
  });

  it('searches again on Enter after a search fails, instead of stepping', async () => {
    findInSshTerminal.mockRejectedValueOnce(new Error('ssh hiccup'));
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'timeout' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(findInSshTerminal).toHaveBeenCalledTimes(2);
    expect(findInSshTerminal).toHaveBeenLastCalledWith('term-1', 'timeout');
    expect(sendInput).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('4 results');
  });

  it('drops the count while a new query waits for its search', async () => {
    renderTmuxSearchBar();
    fireEvent.change(getInput(), { target: { value: 'hello' } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.getByRole('status')).toHaveTextContent('4 results');

    fireEvent.change(getInput(), { target: { value: 'hellox' } });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears on-screen matches from before the terminal searched tmux when it closes', () => {
    const { rerender } = renderSearchBar();
    fireEvent.change(getInput(), { target: { value: 'err' } });
    rerender(
      <TooltipProvider>
        <TerminalSearchBar terminalId="term-1" inTmux />
      </TooltipProvider>
    );

    fireEvent.keyDown(getInput(), { key: 'Escape' });

    expect(runtime.clear).toHaveBeenCalledWith('term-1', true);
  });

  it('ends the tmux search and closes the bar before a key typed in the terminal', async () => {
    renderTmuxSearchBar();
    expect(endTmuxFindForTyping('term-1')).toBe(false);
    fireEvent.change(getInput(), { target: { value: 'error' } });
    await act(() => vi.advanceTimersByTimeAsync(200));

    let ended = false;
    act(() => {
      ended = endTmuxFindForTyping('term-1');
      // The close goes out now, ahead of the key, not once the queue gets to it.
      expect(sendInput).toHaveBeenCalledWith('term-1', MANAGED_TMUX_FIND_INPUTS.close);
    });

    expect(ended).toBe(true);
    expect(screen.queryByPlaceholderText('Find...')).not.toBeInTheDocument();
    expect(endTmuxFindForTyping('term-1')).toBe(false);
  });

  it('hides match case, which tmux decides from the search', () => {
    renderTmuxSearchBar();

    expect(screen.queryByRole('button', { name: 'Match case' })).not.toBeInTheDocument();
  });
});
