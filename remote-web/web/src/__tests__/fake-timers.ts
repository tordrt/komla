import type { WatchdogTimers } from '../connection-watchdog';

/** Timers that only run when a test advances the clock. */
export class FakeTimers implements WatchdogTimers {
  private time = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.pending.delete(id);
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
    }
    this.time = Math.max(this.time, end);
  }

  /** A suspended page: the clock moves on but no timer runs until the next advance. */
  suspend(ms: number): void {
    this.time += ms;
  }
}
