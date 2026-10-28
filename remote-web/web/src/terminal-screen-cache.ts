// Screens of the terminals this page showed recently, so switching back paints one at once.
//
// Each screen is paired with the stream position it reflects: the phone paints it, then asks the
// desktop for only the output after that position (a resumed attach), and takes a fresh snapshot
// instead whenever the desktop can no longer replay that far.
//
// Memory only, on purpose: the desktop's replay log doesn't outlive the app either, and
// scrollback is whatever the agent printed, not something to leave on the phone.

import type { Terminal } from '@xterm/xterm';

export interface CachedTerminalScreen {
  /** Serialized screen and scrollback, written verbatim into a reset terminal. */
  data: string;
  generation: number;
  seq: number;
  cols: number;
  rows: number;
}

/** Enough for the handful of terminals someone switches between. */
const CAPACITY = 5;
/** A stale screen costs only a longer catch-up, but its scrollback is held in memory. */
const MAX_AGE_MS = 10 * 60_000;

export class TerminalScreenCache {
  /** Insertion order is recency order. */
  private readonly entries = new Map<string, { screen: CachedTerminalScreen; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = CAPACITY,
    private readonly maxAgeMs = MAX_AGE_MS
  ) {}

  remember(terminalId: string, screen: CachedTerminalScreen): void {
    this.dropExpired();
    this.entries.delete(terminalId);
    this.entries.set(terminalId, { screen, at: this.now() });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * The screen last shown for `terminalId`. It stays cached: an attach that fails still leaves
   * something to paint next time, and a position behind the stream only lengthens the catch-up.
   */
  read(terminalId: string): CachedTerminalScreen | null {
    this.dropExpired();
    const entry = this.entries.get(terminalId);
    if (!entry) return null;
    this.entries.delete(terminalId);
    this.entries.set(terminalId, { screen: entry.screen, at: this.now() });
    return entry.screen;
  }

  delete(terminalId: string): void {
    this.entries.delete(terminalId);
  }

  clear(): void {
    this.entries.clear();
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [terminalId, entry] of this.entries) {
      if (now - entry.at > this.maxAgeMs) this.entries.delete(terminalId);
    }
  }
}

export interface MouseEncodingTracker {
  /** The sequence that turns the tracked encoding back on, or '' when there is none. */
  restoreSequence(): string;
  /** Call alongside `term.reset()`: that API call resets the encoding without the parser. */
  forget(): void;
}

/**
 * Follows the mouse report encoding a program picked (SGR 1006, or 1016), which xterm's serialize
 * addon leaves out, so a restored screen can turn it back on. Without it, a fullscreen program
 * that scrolls by wheel can't read the reports from a restored screen.
 */
export function trackMouseEncoding(term: Terminal): MouseEncodingTracker {
  let encoding: 1006 | 1016 | null = null;
  const track = (params: (number | number[])[], on: boolean) => {
    for (const mode of params) {
      if (mode === 1006 || mode === 1016) encoding = on ? mode : null;
    }
    // xterm applies the sequence too.
    return false;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => track(params, true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => track(params, false));
  term.parser.registerEscHandler({ final: 'c' }, () => {
    encoding = null;
    return false;
  });
  return {
    restoreSequence: () => (encoding === null ? '' : `\x1b[?${encoding}h`),
    forget: () => {
      encoding = null;
    },
  };
}
