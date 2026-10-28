/**
 * Recent mic levels that components subscribe to with useSyncExternalStore,
 * so a waveform redraws without re-rendering whoever owns the recording.
 */
export interface LevelHistory {
  subscribe: (onChange: () => void) => () => void;
  /** Recent levels (RMS), oldest first. */
  getSnapshot: () => number[];
}

export function createLevelHistory(length: number) {
  let levels: number[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    subscribe: (onChange: () => void) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    getSnapshot: () => levels,
    push: (level: number) => {
      levels = [...levels.slice(1 - length), level];
      notify();
    },
    clear: () => {
      if (levels.length === 0) return;
      levels = [];
      notify();
    },
  };
}
