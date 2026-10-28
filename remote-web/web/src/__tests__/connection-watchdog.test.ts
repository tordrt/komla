import { describe, expect, it } from 'vitest';

import { ConnectionWatchdog, reconnectDelayMs } from '../connection-watchdog';

import { FakeTimers } from './fake-timers';

function setup() {
  const timers = new FakeTimers();
  const events: string[] = [];
  const watchdog = new ConnectionWatchdog({
    timers,
    idleProbeMs: 20_000,
    idleProbeTimeoutMs: 8_000,
    wakeProbeTimeoutMs: 3_000,
    sendPing: () => events.push(`ping@${timers.now()}`),
    onDead: (reason) => events.push(`dead:${reason}@${timers.now()}`),
  });
  return { timers, events, watchdog };
}

describe('ConnectionWatchdog', () => {
  it('probes after 20 s of silence and gives up after a second unanswered probe', () => {
    const { timers, events } = setup();

    timers.advance(40_000);

    // One late pong on a slow radio isn't a dead link (Orca Mobile #12790).
    expect(events).toEqual(['ping@20000', 'ping@28000', 'dead:silent@36000']);
  });

  it('starts over when the second probe is answered', () => {
    const { timers, events, watchdog } = setup();

    timers.advance(30_000);
    watchdog.noteInbound();
    timers.advance(28_000);

    // The next silence again gets two probes before it counts as dead.
    expect(events).toEqual(['ping@20000', 'ping@28000', 'ping@50000', 'ping@58000']);
  });

  it('does not count a probe window the page slept through', () => {
    const { timers, events } = setup();

    timers.advance(20_000);
    timers.suspend(60_000);
    timers.advance(20_000);

    expect(events).toEqual(['ping@20000', 'ping@80000', 'ping@88000', 'dead:silent@96000']);
  });

  it('treats any inbound frame as an answer and starts the silence over', () => {
    const { timers, events, watchdog } = setup();

    timers.advance(21_000);
    watchdog.noteInbound();
    timers.advance(19_000);

    expect(events).toEqual(['ping@20000']);
    timers.advance(1_000);
    expect(events).toEqual(['ping@20000', 'ping@41000']);
  });

  it('checks immediately on wake with a short deadline', () => {
    const { timers, events, watchdog } = setup();

    timers.advance(5_000);
    watchdog.probe();
    timers.advance(3_000);

    expect(events).toEqual(['ping@5000', 'dead:probe-unanswered@8000']);
  });

  it('keeps an idle probe in flight sooner when the page wakes during it', () => {
    const { timers, events, watchdog } = setup();

    timers.advance(21_000);
    watchdog.probe();
    timers.advance(3_000);

    expect(events).toEqual(['ping@20000', 'ping@21000', 'dead:probe-unanswered@24000']);
  });

  it('never fires after stop', () => {
    const { timers, events, watchdog } = setup();

    watchdog.stop();
    watchdog.probe();
    timers.advance(60_000);

    expect(events).toEqual([]);
  });
});

describe('reconnectDelayMs', () => {
  it('backs off quickly, caps at 30 s, then retries every minute', () => {
    const exact = () => 0.5;

    expect([0, 1, 2, 3, 4, 5, 6, 7, 11].map((attempt) => reconnectDelayMs(attempt, exact))).toEqual(
      [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]
    );
    expect(reconnectDelayMs(12, exact)).toBe(60_000);
    expect(reconnectDelayMs(-3, exact)).toBe(500);
    expect(reconnectDelayMs(Number.NaN, exact)).toBe(500);
  });

  it('spreads retries by ±20 %', () => {
    expect(reconnectDelayMs(4, () => 0)).toBe(6_400);
    expect(reconnectDelayMs(4, () => 0.999_999)).toBe(9_600);
  });
});
