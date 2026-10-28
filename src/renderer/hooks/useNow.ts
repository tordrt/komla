import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    // React reads the time again after subscribing, so a clock that mounts later isn't stale.
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getNow(): number {
  return now;
}

/** The time, updated once a second while anything reads it, on one tick shared by every reader. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow);
}
