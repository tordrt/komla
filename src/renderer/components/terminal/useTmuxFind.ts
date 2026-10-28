import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MANAGED_TMUX_FIND_INPUTS,
  type ManagedTmuxFindResult,
} from '../../../shared/lib/ssh-tmux-attach';

// Each search is a round trip to the host, so it waits for typing to pause.
const TMUX_FIND_DELAY_MS = 150;

/** A tmux search's result, for the query it searched. */
export type TmuxFindResult = ManagedTmuxFindResult & { query: string };

// Ends the tmux search of each terminal searching tmux, ahead of a key typed into it.
const endForTyping = new Map<string, () => boolean>();

/**
 * Called before a key typed into a terminal reaches it. tmux's search holds the pane in copy
 * mode, which would take the key, so the key ends the search and closes the bar first.
 * Returns whether there was a search to end.
 */
export function endTmuxFindForTyping(terminalId: string): boolean {
  return endForTyping.get(terminalId)?.() ?? false;
}

/**
 * Searches a Managed Remote Terminal Session's tmux history, which Komla's renderer never
 * receives, while `active`. Ending the search puts the terminal back at its live screen, and
 * a key typed into the terminal ends it and calls `close`.
 * A full-screen program keeps no history, so its search moves `onScreen`: `searchScreen`
 * gets the query, and the rest of the search stays there until it ends.
 */
export function useTmuxFind(
  terminalId: string,
  active: boolean,
  searchScreen: (query: string) => void,
  close: () => void
) {
  const [result, setResult] = useState<TmuxFindResult | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The host takes searches, steps and the end of a search one at a time, in order.
  const queue = useRef<Promise<void>>(Promise.resolve());
  // The search tmux has, or will have once the queue reaches it.
  const latest = useRef<{ query: string } | null>(null);
  // Whether tmux may be holding the pane in a search, which only the close input ends.
  const searching = useRef(false);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const enqueue = (run: () => void | Promise<void>) => {
    queue.current = queue.current.then(run);
  };

  const find = useCallback(
    (query: string) => {
      clearTimer();
      const search = { query };
      latest.current = search;
      searching.current = true;
      enqueue(async () => {
        // A newer search, or the end of this one, replaced it while it waited.
        if (latest.current !== search) return;
        try {
          const found = await window.api.findInSshTerminal(terminalId, query);
          if (latest.current !== search) return;
          if (found.alternateScreen) {
            setOnScreen(true);
            searchScreen(query);
          } else {
            setResult({ ...found, query });
          }
        } catch {
          // The next step searches again, rather than stepping through tmux's last search.
          if (latest.current === search) {
            latest.current = null;
            setResult(null);
          }
        }
      });
    },
    [terminalId, searchScreen]
  );

  const end = useCallback(() => {
    clearTimer();
    latest.current = null;
    setResult(null);
    setOnScreen(false);
    if (!searching.current) return;
    searching.current = false;
    enqueue(() => window.api.sendInput(terminalId, MANAGED_TMUX_FIND_INPUTS.close));
  }, [terminalId]);

  useEffect(() => {
    if (!active) return;
    return end;
  }, [active, end]);

  useEffect(() => {
    if (!active || onScreen) return;
    const endBeforeKey = () => {
      if (!searching.current) return false;
      // Ahead of the key, not behind the queue. Closing the bar ends the search again once
      // a search still on its way has landed.
      window.api.sendInput(terminalId, MANAGED_TMUX_FIND_INPUTS.close);
      close();
      return true;
    };
    endForTyping.set(terminalId, endBeforeKey);
    return () => {
      if (endForTyping.get(terminalId) === endBeforeKey) endForTyping.delete(terminalId);
    };
  }, [active, onScreen, terminalId, close]);

  /** Searches once typing pauses; an empty query ends the search. */
  const search = useCallback(
    (query: string) => {
      clearTimer();
      if (!query) {
        end();
        return;
      }
      // Typing back to tmux's query keeps its place in the search.
      if (query === latest.current?.query) return;
      timer.current = setTimeout(() => find(query), TMUX_FIND_DELAY_MS);
    },
    [find, end]
  );

  /** Moves to an older or newer match; the first step for a query shows its newest one. */
  const step = useCallback(
    (direction: 'older' | 'newer', query: string) => {
      if (!query) return;
      const search = latest.current;
      if (search?.query !== query) {
        find(query);
        return;
      }
      clearTimer();
      enqueue(() => {
        if (latest.current === search) {
          window.api.sendInput(terminalId, MANAGED_TMUX_FIND_INPUTS[direction]);
        }
      });
    },
    [terminalId, find]
  );

  return { result, onScreen, search, step };
}
