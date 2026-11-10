import { describe, expect, it, vi } from 'vitest';

import { createQuitSequence } from '../../../src/main/lib/quit-sequence';
import { createDeferred } from '../../setup';

import type { QuitPhase, QuitStepFailure } from '../../../src/main/lib/quit-sequence';

/** A turn of the event loop, by which every promise that could continue has. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A sequence over `phases` whose steps, failures and quit are written to `log` as they happen. */
function setUp(phases: (log: string[]) => QuitPhase[], options: { confirm?: () => boolean } = {}) {
  const log: string[] = [];
  const failures: QuitStepFailure[] = [];
  const sequence = createQuitSequence({
    confirm: options.confirm ?? (() => true),
    phases: phases(log),
    quit: () => log.push('quit'),
    onStepFailed: (failure) => failures.push(failure),
  });
  return { sequence, log, failures };
}

describe('createQuitSequence', () => {
  it('runs the phases in order, each once the one before has settled, then quits', async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const { sequence, log } = setUp((log) => [
      { name: 'first', steps: { a: () => (log.push('a'), first.promise) } },
      { name: 'second', steps: { b: () => (log.push('b'), second.promise) } },
      { name: 'third', steps: { c: () => log.push('c') } },
    ]);
    expect(sequence.state()).toEqual({ kind: 'running' });

    sequence.request();
    await turn();
    expect(log).toEqual(['a']);
    expect(sequence.state()).toEqual({ kind: 'cleaning-up', phase: 'first' });

    first.resolve();
    await turn();
    expect(log).toEqual(['a', 'b']);
    expect(sequence.state()).toEqual({ kind: 'cleaning-up', phase: 'second' });

    second.resolve();
    await turn();
    expect(log).toEqual(['a', 'b', 'c', 'quit']);
    expect(sequence.state()).toEqual({ kind: 'done' });
  });

  it("starts a phase's steps together, in the order written, and waits for them all", async () => {
    const slow = createDeferred<void>();
    const slower = createDeferred<void>();
    const { sequence, log } = setUp((log) => [
      {
        name: 'together',
        steps: {
          slow: () => (log.push('slow'), slow.promise),
          sync: () => log.push('sync'),
          slower: () => (log.push('slower'), slower.promise),
        },
      },
      { name: 'after', steps: { next: () => log.push('next') } },
    ]);

    sequence.request();
    expect(log).toEqual(['slow', 'sync', 'slower']);

    slower.resolve();
    await turn();
    expect(log).toEqual(['slow', 'sync', 'slower']);

    slow.resolve();
    await turn();
    expect(log).toEqual(['slow', 'sync', 'slower', 'next', 'quit']);
  });

  it('runs phases of synchronous steps, and one with no steps, without giving anything else a turn', () => {
    const pending = createDeferred<void>();
    const { sequence, log } = setUp((log) => [
      { name: 'first', steps: { a: () => log.push('a') } },
      { name: 'empty', steps: {} },
      { name: 'second', steps: { b: () => log.push('b') } },
      { name: 'third', steps: { c: () => (log.push('c'), pending.promise) } },
    ]);
    void Promise.resolve().then(() => log.push('something else'));

    sequence.request();

    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('reports a step that fails by name and carries on with the rest', async () => {
    const rejected = new Error('rejected');
    const thrown = new Error('thrown');
    const slow = createDeferred<void>();
    const { sequence, log, failures } = setUp((log) => [
      {
        name: 'failing',
        steps: {
          rejects: () => Promise.reject(rejected),
          throws: () => {
            throw thrown;
          },
          slow: () => (log.push('slow'), slow.promise),
        },
      },
      { name: 'after', steps: { next: () => log.push('next') } },
    ]);

    sequence.request();
    await turn();
    // A failure doesn't cut short the steps started with it.
    expect(log).toEqual(['slow']);

    slow.resolve();
    await turn();
    expect(log).toEqual(['slow', 'next', 'quit']);
    expect(failures).toEqual([
      { phase: 'failing', step: 'throws', error: thrown },
      { phase: 'failing', step: 'rejects', error: rejected },
    ]);
  });

  it('quits even when reporting a failure fails', async () => {
    const quit = vi.fn();
    const sequence = createQuitSequence({
      confirm: () => true,
      phases: [
        {
          name: 'failing',
          steps: {
            rejects: () => Promise.reject(new Error('rejected')),
            throws: () => {
              throw new Error('thrown');
            },
          },
        },
      ],
      quit,
      onStepFailed: () => {
        throw new Error('the log is gone');
      },
    });

    sequence.request();
    await turn();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('ignores a request made while it cleans up, and after it is done', async () => {
    const pending = createDeferred<void>();
    const confirm = vi.fn(() => true);
    const { sequence, log } = setUp(
      (log) => [{ name: 'only', steps: { a: () => (log.push('a'), pending.promise) } }],
      { confirm }
    );

    sequence.request();
    sequence.request();
    await turn();
    sequence.request();
    expect(sequence.state()).toEqual({ kind: 'cleaning-up', phase: 'only' });

    pending.resolve();
    await turn();
    sequence.request();
    await turn();

    expect(log).toEqual(['a', 'quit']);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('keeps running when the user declines, and asks again on the next request', () => {
    let answer = false;
    const { sequence, log } = setUp(
      (log) => [{ name: 'only', steps: { a: () => log.push('a') } }],
      {
        confirm: () => answer,
      }
    );

    sequence.request();
    expect(log).toEqual([]);
    expect(sequence.state()).toEqual({ kind: 'running' });

    answer = true;
    sequence.request();
    expect(log).toEqual(['a', 'quit']);
  });

  it('ignores a request made while the user is still being asked', () => {
    const states: string[] = [];
    let asked = 0;
    const { sequence, log } = setUp(
      (log) => [{ name: 'only', steps: { a: () => log.push('a') } }],
      {
        // A dialog runs the event loop while it is up, so another request can arrive under it.
        confirm: () => {
          asked += 1;
          states.push(sequence.state().kind);
          sequence.request();
          return true;
        },
      }
    );

    sequence.request();

    expect(asked).toBe(1);
    expect(states).toEqual(['confirming']);
    expect(log).toEqual(['a', 'quit']);
  });

  it('is running again when asking the user fails', () => {
    const { sequence } = setUp(() => [], {
      confirm: () => {
        throw new Error('no dialog');
      },
    });

    expect(() => sequence.request()).toThrow('no dialog');
    expect(sequence.state()).toEqual({ kind: 'running' });
  });
});
