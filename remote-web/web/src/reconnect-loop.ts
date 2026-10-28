// Reconnects an open page after its connection drops, without reloading it. Attempts back off,
// but the page coming back on screen or the network returning tries again at once. An attempt
// still dialing when that happens is abandoned and redialed: a phone that slept mid-dial can leave
// it hanging (Orca Mobile issue 12344). A hidden page waits until it is looked at.

import type { WatchdogTimers } from './connection-watchdog';

export type ReconnectOutcome = 'connected' | 'retry' | 'reload';

export interface ReconnectLoopOptions {
  /** One attempt; it must settle soon after `signal` aborts. */
  attempt(signal: AbortSignal): Promise<ReconnectOutcome>;
  /** Only a page reload can reconnect, e.g. because the passkey is needed again. */
  reload(): void;
  delayMs(attempt: number): number;
  isVisible(): boolean;
  /** The next attempt starts in `delayMs`. */
  onWaiting?(delayMs: number): void;
  /** How old an attempt must be before a wake-up abandons it for a fresh one. */
  staleAfterMs?: number;
  /**
   * Failed attempts before a reload, which shows the page's own offline screen
   * and the SSH hosts it can open instead.
   */
  reloadAfterAttempts?: number;
  timers?: WatchdogTimers;
}

const browserTimers: WatchdogTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export class ReconnectLoop {
  private readonly timers: WatchdogTimers;
  private readonly staleAfterMs: number;
  private running = false;
  private attempts = 0;
  private timer: number | null = null;
  private inFlight: { controller: AbortController; startedAt: number } | null = null;

  constructor(private readonly options: ReconnectLoopOptions) {
    this.timers = options.timers ?? browserTimers;
    this.staleAfterMs = options.staleAfterMs ?? 2_000;
  }

  get active(): boolean {
    return this.running;
  }

  /** The connection dropped: start trying. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    this.schedule();
  }

  /** The page came on screen or the network changed: try now. */
  wake(): void {
    if (!this.running) return;
    if (this.inFlight) {
      if (this.timers.now() - this.inFlight.startedAt < this.staleAfterMs) return;
      this.inFlight.controller.abort();
      this.inFlight = null;
    }
    this.clearTimer();
    void this.run();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.inFlight?.controller.abort();
    this.inFlight = null;
  }

  private schedule(): void {
    const delay = this.options.delayMs(this.attempts);
    this.options.onWaiting?.(delay);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    if (!this.running || this.inFlight) return;
    // A hidden page tries again when it is looked at; wake() starts that.
    if (!this.options.isVisible()) return;
    const attempt = { controller: new AbortController(), startedAt: this.timers.now() };
    this.inFlight = attempt;
    let outcome: ReconnectOutcome;
    try {
      outcome = await this.options.attempt(attempt.controller.signal);
    } catch {
      outcome = 'retry';
    }
    // Abandoned for a newer attempt, or stopped.
    if (this.inFlight !== attempt) return;
    this.inFlight = null;
    if (outcome === 'connected') {
      this.running = false;
      return;
    }
    if (outcome === 'reload') {
      this.running = false;
      this.options.reload();
      return;
    }
    this.attempts += 1;
    if (this.attempts >= (this.options.reloadAfterAttempts ?? Infinity)) {
      this.running = false;
      this.options.reload();
      return;
    }
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
