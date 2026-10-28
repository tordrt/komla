import { describe, expect, it } from 'vitest';

import { ReconnectLoop, type ReconnectOutcome } from '../reconnect-loop';

import { FakeTimers } from './fake-timers';

function setup(outcomes: ReconnectOutcome[], reloadAfterAttempts?: number) {
  const timers = new FakeTimers();
  const events: string[] = [];
  let visible = true;
  const pending: Array<{ signal: AbortSignal; settle: (outcome: ReconnectOutcome) => void }> = [];
  const loop = new ReconnectLoop({
    timers,
    delayMs: (attempt) => 1_000 * 2 ** attempt,
    isVisible: () => visible,
    reload: () => events.push(`reload@${timers.now()}`),
    onWaiting: (delay) => events.push(`wait ${delay}`),
    reloadAfterAttempts,
    attempt: (signal) => {
      events.push(`attempt@${timers.now()}`);
      const next = outcomes.shift();
      if (next) return Promise.resolve(next);
      return new Promise((settle) => {
        pending.push({ signal, settle });
        signal.addEventListener('abort', () => settle('retry'));
      });
    },
  });
  return {
    timers,
    events,
    loop,
    pending,
    hide: () => (visible = false),
    show: () => (visible = true),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ReconnectLoop', () => {
  it('backs off between failed attempts and stops once connected', async () => {
    const { timers, events, loop } = setup(['retry', 'retry', 'connected']);

    loop.start();
    for (const ms of [1_000, 2_000, 4_000, 60_000]) {
      timers.advance(ms);
      await settle();
    }

    expect(events).toEqual([
      'wait 1000',
      'attempt@1000',
      'wait 2000',
      'attempt@3000',
      'wait 4000',
      'attempt@7000',
    ]);
    expect(loop.active).toBe(false);
  });

  it('tries at once when the page wakes instead of waiting out the delay', async () => {
    const { timers, events, loop } = setup(['connected']);

    loop.start();
    timers.advance(200);
    loop.wake();
    await settle();

    expect(events).toEqual(['wait 1000', 'attempt@200']);
    expect(loop.active).toBe(false);
  });

  it('abandons an attempt that hung across a sleep and dials again', async () => {
    const { timers, events, loop, pending } = setup([]);

    loop.start();
    timers.advance(1_000);
    await settle();
    loop.wake(); // Too soon to call the first attempt stale.
    timers.advance(5_000);
    loop.wake();
    await settle();

    expect(events).toEqual(['wait 1000', 'attempt@1000', 'attempt@6000']);
    expect(pending.map(({ signal }) => signal.aborted)).toEqual([true, false]);
    pending[1]!.settle('connected');
    await settle();
    expect(loop.active).toBe(false);
  });

  it('waits while the page is hidden', async () => {
    const { timers, events, loop, hide, show } = setup(['connected']);
    hide();

    loop.start();
    timers.advance(30_000);
    await settle();
    show();
    loop.wake();
    await settle();

    expect(events).toEqual(['wait 1000', 'attempt@30000']);
  });

  it('reloads to the offline screen after the desktop stays unreachable', async () => {
    const { timers, events, loop } = setup(['retry', 'retry'], 2);

    loop.start();
    for (const ms of [1_000, 2_000]) {
      timers.advance(ms);
      await settle();
    }

    expect(events).toEqual([
      'wait 1000',
      'attempt@1000',
      'wait 2000',
      'attempt@3000',
      'reload@3000',
    ]);
    expect(loop.active).toBe(false);
  });

  it('reloads the page when only a passkey can reconnect', async () => {
    const { timers, events, loop } = setup(['reload']);

    loop.start();
    timers.advance(1_000);
    await settle();

    expect(events).toEqual(['wait 1000', 'attempt@1000', 'reload@1000']);
    expect(loop.active).toBe(false);
  });
});
