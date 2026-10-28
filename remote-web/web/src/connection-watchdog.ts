// Notices a dead connection while the page is open. A phone that sleeps, or roams between Wi-Fi
// and cellular, can leave a WebSocket half-open: no close event, no data, for minutes. Orca Mobile
// probes after 20 s of silence with an 8 s deadline (issue 5049); the desktop answers
// `relay:ping` with `relay:pong`, and any inbound frame counts as proof of life.
//
// Also after Orca: an idle link is declared dead only after two unanswered probes in a row, since
// one late pong on a slow radio isn't a dead link (#12790), and a probe window the page was
// suspended through says nothing about the link, so it is tried again rather than counted.

export interface WatchdogTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export type WatchdogDeath = 'silent' | 'probe-unanswered';

export interface ConnectionWatchdogOptions {
  sendPing(): void;
  onDead(reason: WatchdogDeath): void;
  /** Silence before an idle probe. */
  idleProbeMs?: number;
  /** How long an idle probe may go unanswered. */
  idleProbeTimeoutMs?: number;
  /** How long a wake-up probe may go unanswered; short, because the user is looking. */
  wakeProbeTimeoutMs?: number;
  /** Unanswered idle probes in a row before the link counts as dead. */
  idleProbeMisses?: number;
  timers?: WatchdogTimers;
}

const browserTimers: WatchdogTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export class ConnectionWatchdog {
  private readonly timers: WatchdogTimers;
  private readonly idleProbeMs: number;
  private readonly idleProbeTimeoutMs: number;
  private readonly wakeProbeTimeoutMs: number;
  private readonly idleProbeMisses: number;
  private misses = 0;
  private idleTimer: number | null = null;
  private deadlineTimer: number | null = null;
  private stopped = false;

  constructor(private readonly options: ConnectionWatchdogOptions) {
    this.timers = options.timers ?? browserTimers;
    this.idleProbeMs = options.idleProbeMs ?? 20_000;
    this.idleProbeTimeoutMs = options.idleProbeTimeoutMs ?? 8_000;
    this.wakeProbeTimeoutMs = options.wakeProbeTimeoutMs ?? 5_000;
    this.idleProbeMisses = options.idleProbeMisses ?? 2;
    this.armIdle();
  }

  /** Any frame arrived: the link is alive. */
  noteInbound(): void {
    if (this.stopped) return;
    this.misses = 0;
    this.clearDeadline();
    this.armIdle();
  }

  /** The page became visible or the network changed: check now, with a short deadline. */
  probe(timeoutMs = this.wakeProbeTimeoutMs): void {
    if (this.stopped) return;
    this.clearIdle();
    this.startProbe(timeoutMs, 'probe-unanswered');
  }

  stop(): void {
    this.stopped = true;
    this.clearIdle();
    this.clearDeadline();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      this.startProbe(this.idleProbeTimeoutMs, 'silent');
    }, this.idleProbeMs);
  }

  private startProbe(timeoutMs: number, reason: WatchdogDeath): void {
    // A probe already in flight keeps its earlier deadline unless this one is sooner.
    if (this.deadlineTimer === null || timeoutMs < this.idleProbeTimeoutMs) {
      this.clearDeadline();
      const sentAt = this.timers.now();
      this.deadlineTimer = this.timers.setTimeout(() => {
        this.deadlineTimer = null;
        if (this.stopped) return;
        this.unanswered(timeoutMs, reason, this.timers.now() - sentAt);
      }, timeoutMs);
    }
    this.options.sendPing();
  }

  private unanswered(timeoutMs: number, reason: WatchdogDeath, elapsedMs: number): void {
    // The page was suspended past the deadline: try again instead of counting it.
    if (elapsedMs > timeoutMs * 1.5) {
      this.startProbe(timeoutMs, reason);
      return;
    }
    this.misses += 1;
    if (reason === 'silent' && this.misses < this.idleProbeMisses) {
      this.startProbe(timeoutMs, reason);
      return;
    }
    this.stop();
    this.options.onDead(reason);
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearDeadline(): void {
    if (this.deadlineTimer === null) return;
    this.timers.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}

/**
 * Delay before reconnect attempt `attempt` (0-based): quick at first, then capped, with jitter so
 * a desktop that comes back isn't hit by every tab at once. After many failures it slows to a
 * steady retry, like Orca Mobile's 90 s tail.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const steps = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const base =
    safeAttempt < 12 ? (steps[Math.min(safeAttempt, steps.length - 1)] ?? 30_000) : 60_000;
  const jitter = 0.8 + random() * 0.4;
  return Math.round(base * jitter);
}
