import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TERMINAL_WAIT_SETTLE_MS,
  terminalAgentState,
  waitForTerminal,
  type TerminalWaitAttention,
  type TerminalWaitResult,
  type TerminalWaitSnapshot,
} from '../../../src/main/services/komla-operation/terminal-wait';

function fakeTerminal(initial: TerminalWaitSnapshot) {
  let snapshot = initial;
  const changes = new Set<() => void>();
  const outputs = new Set<(data: string) => void>();
  const exits = new Set<() => void>();
  const raised = new Set<(attention: TerminalWaitAttention) => void>();
  const prompts = new Set<() => void>();
  return {
    events: {
      snapshot: () => snapshot,
      onChange: (listener: () => void) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      onOutput: (listener: (data: string) => void) => {
        outputs.add(listener);
        return () => outputs.delete(listener);
      },
      onExit: (listener: () => void) => {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      onAttention: (listener: (attention: TerminalWaitAttention) => void) => {
        raised.add(listener);
        return () => raised.delete(listener);
      },
      onPromptSubmitted: (listener: () => void) => {
        prompts.add(listener);
        return () => prompts.delete(listener);
      },
    },
    submitPrompt() {
      for (const listener of prompts) listener();
    },
    /** Raises attention the user dismisses at once, as when they look at the terminal. */
    raiseSeen(attention: TerminalWaitAttention) {
      for (const listener of raised) listener(attention);
      snapshot = { ...snapshot, attention: undefined };
      for (const listener of changes) listener();
    },
    set(next: Partial<TerminalWaitSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of changes) listener();
    },
    print(data: string) {
      for (const listener of outputs) listener(data);
    },
    exit() {
      snapshot = { ...snapshot, running: false };
      for (const listener of exits) listener();
    },
    listeners: () => changes.size + outputs.size + exits.size + raised.size + prompts.size,
  };
}

/** The reason, or undefined while the wait goes on. */
function track(promise: Promise<TerminalWaitResult>) {
  let reason: string | undefined;
  void promise.then((value) => (reason = value.reason));
  return () => reason;
}

describe('terminalAgentState', () => {
  it('ranks a question over work, and work over the last turn’s end', () => {
    const at = { updatedAt: 1 };
    expect(terminalAgentState({ running: false, working: true })).toBe('exited');
    expect(
      terminalAgentState({
        running: true,
        working: true,
        attention: { kind: 'input-required', ...at },
      })
    ).toBe('blocked');
    expect(
      terminalAgentState({
        running: true,
        working: true,
        attention: { kind: 'turn-complete', ...at },
      })
    ).toBe('working');
    expect(
      terminalAgentState({
        running: true,
        working: false,
        attention: { kind: 'turn-complete', ...at },
      })
    ).toBe('done');
    expect(
      terminalAgentState({
        running: true,
        working: false,
        attention: { kind: 'error', ...at },
      })
    ).toBe('error');
    expect(terminalAgentState({ running: true, working: false })).toBe('idle');
  });
});

describe('waitForTerminal', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1000 }));
  afterEach(() => vi.useRealTimers());

  it('returns done when the working agent raises a done, and stops listening', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(waitForTerminal(terminal.events, { timeoutMs: 60_000 }));

    terminal.set({
      working: false,
      attention: { kind: 'turn-complete', updatedAt: Date.now() },
    });
    await Promise.resolve();

    expect(reason()).toBe('done');
    expect(terminal.listeners()).toBe(0);
  });

  it('returns done with its text when the user saw the done and it was dismissed', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const result = waitForTerminal(terminal.events, { timeoutMs: 60_000 });

    terminal.set({ working: false });
    terminal.raiseSeen({ kind: 'turn-complete', updatedAt: Date.now(), message: 'Two bugs' });

    await expect(result).resolves.toEqual({
      reason: 'done',
      attention: expect.objectContaining({ message: 'Two bugs' }),
    });
  });

  it('returns blocked as soon as the agent needs the user', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(waitForTerminal(terminal.events, { timeoutMs: 60_000 }));

    terminal.set({
      attention: { kind: 'input-required', updatedAt: Date.now() },
    });
    await Promise.resolve();

    expect(reason()).toBe('blocked');
  });

  it('gives a done time to follow the spinner, then ends the turn as idle', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(waitForTerminal(terminal.events, { timeoutMs: 60_000 }));

    terminal.set({ working: false });
    await vi.advanceTimersByTimeAsync(TERMINAL_WAIT_SETTLE_MS - 1);
    expect(reason()).toBeUndefined();
    terminal.set({ working: true });
    terminal.set({ working: false });
    await vi.advanceTimersByTimeAsync(TERMINAL_WAIT_SETTLE_MS - 1);
    expect(reason()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(reason()).toBe('idle');
  });

  it('answers at once for an agent that isn’t working, with how its last turn ended', async () => {
    const at = { updatedAt: 1 };
    await expect(
      waitForTerminal(fakeTerminal({ running: true, working: false }).events, {
        timeoutMs: 1,
      })
    ).resolves.toMatchObject({ reason: 'idle' });
    await expect(
      waitForTerminal(
        fakeTerminal({
          running: true,
          working: false,
          attention: { kind: 'turn-complete', ...at },
        }).events,
        { timeoutMs: 1 }
      )
    ).resolves.toMatchObject({ reason: 'done' });
    await expect(
      waitForTerminal(fakeTerminal({ running: false, working: false }).events, {
        timeoutMs: 1,
      })
    ).resolves.toMatchObject({ reason: 'exited' });
  });

  it('with a start timeout, waits for the next turn instead of the last turn’s done', async () => {
    const terminal = fakeTerminal({
      running: true,
      working: false,
      attention: { kind: 'turn-complete', updatedAt: 1 },
    });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
      })
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(reason()).toBeUndefined();
    terminal.set({ working: true, attention: undefined });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reason()).toBeUndefined();
    terminal.set({
      working: false,
      attention: { kind: 'turn-complete', updatedAt: Date.now() },
    });
    await Promise.resolve();

    expect(reason()).toBe('done');
  });

  it('for the next turn, ignores a question from before, as one the message answers', async () => {
    const terminal = fakeTerminal({
      running: true,
      working: false,
      attention: { kind: 'input-required', updatedAt: 1 },
    });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
        nextTurn: true,
      })
    );

    await Promise.resolve();
    expect(reason()).toBeUndefined();
    terminal.set({ working: true, attention: undefined });
    terminal.set({ working: false, attention: { kind: 'turn-complete', updatedAt: Date.now() } });
    await Promise.resolve();

    expect(reason()).toBe('done');
  });

  it('for the next turn, waits past the turn under way for the message’s own', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
        nextTurn: true,
      })
    );

    await vi.advanceTimersByTimeAsync(1);
    terminal.raiseSeen({ kind: 'turn-complete', updatedAt: Date.now(), message: 'earlier' });
    terminal.set({ working: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reason()).toBeUndefined();
    terminal.set({ working: true });
    await vi.advanceTimersByTimeAsync(20_000);
    terminal.set({ working: false, attention: { kind: 'turn-complete', updatedAt: Date.now() } });
    await Promise.resolve();

    expect(reason()).toBe('done');
  });

  it('for the next turn, is not_started when no turn follows the one under way', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
        nextTurn: true,
      })
    );

    // The turn under way runs past the start deadline without ending the wait.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reason()).toBeUndefined();
    terminal.set({ working: false, attention: { kind: 'turn-complete', updatedAt: Date.now() } });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reason()).toBe('not_started');
  });

  it('for the next turn, starts at the message’s prompt even with the spinner still on', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
        nextTurn: true,
      })
    );

    // The turn under way ends with its spinner off first, then its done, as a Stop hook does.
    await vi.advanceTimersByTimeAsync(1);
    terminal.set({ working: false });
    terminal.raiseSeen({ kind: 'turn-complete', updatedAt: Date.now(), message: 'earlier' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reason()).toBeUndefined();
    terminal.set({ working: true });
    terminal.submitPrompt();
    await vi.advanceTimersByTimeAsync(20_000);
    terminal.set({
      working: false,
      attention: { kind: 'turn-complete', updatedAt: Date.now(), message: 'mine' },
    });
    await Promise.resolve();

    expect(reason()).toBe('done');
  });

  it('for the next turn, takes the turn a forced answer lets go on as the message’s', async () => {
    const terminal = fakeTerminal({
      running: true,
      working: true,
      attention: { kind: 'input-required', updatedAt: 1 },
    });
    const result = waitForTerminal(terminal.events, {
      timeoutMs: 60_000,
      startTimeoutMs: 10_000,
      nextTurn: true,
      answering: true,
    });

    await vi.advanceTimersByTimeAsync(1);
    terminal.set({ attention: undefined });
    terminal.set({ working: false, attention: { kind: 'turn-complete', updatedAt: Date.now() } });

    await expect(result).resolves.toMatchObject({ reason: 'done' });
  });

  it('for the next turn, takes no pause between tools in the turn under way as its start', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
        nextTurn: true,
      })
    );

    await vi.advanceTimersByTimeAsync(1);
    terminal.set({ working: false });
    await vi.advanceTimersByTimeAsync(200);
    terminal.set({ working: true });
    terminal.set({
      working: false,
      attention: { kind: 'turn-complete', updatedAt: Date.now(), message: 'earlier' },
    });
    await Promise.resolve();

    expect(reason()).toBeUndefined();
  });

  it('for the next turn, takes a quick turn seen only by its done', async () => {
    const terminal = fakeTerminal({ running: true, working: false });
    const result = waitForTerminal(terminal.events, {
      timeoutMs: 60_000,
      startTimeoutMs: 10_000,
      nextTurn: true,
    });

    await vi.advanceTimersByTimeAsync(500);
    terminal.raiseSeen({ kind: 'turn-complete', updatedAt: Date.now(), message: 'quick' });

    await expect(result).resolves.toMatchObject({
      reason: 'done',
      attention: { message: 'quick' },
    });
  });

  it('for a forced answer that starts no work, is not_started', async () => {
    const terminal = fakeTerminal({
      running: true,
      working: false,
      attention: { kind: 'input-required', updatedAt: 1 },
    });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
        nextTurn: true,
        answering: true,
      })
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(reason()).toBe('not_started');
  });

  it('returns not_started when no turn begins in time', async () => {
    const terminal = fakeTerminal({ running: true, working: false });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        startTimeoutMs: 10_000,
      })
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(reason()).toBe('not_started');
  });

  it('times out as a check-in and stops listening', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(waitForTerminal(terminal.events, { timeoutMs: 180_000 }));

    await vi.advanceTimersByTimeAsync(180_000);

    expect(reason()).toBe('timeout');
    expect(terminal.listeners()).toBe(0);
  });

  it('stops listening once its caller goes', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const caller = new AbortController();
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 180_000,
        signal: caller.signal,
      })
    );

    caller.abort();
    await Promise.resolve();

    expect(reason()).toBe('timeout');
    expect(terminal.listeners()).toBe(0);
  });

  it('returns exited when the program ends', async () => {
    const terminal = fakeTerminal({ running: true, working: true });
    const reason = track(waitForTerminal(terminal.events, { timeoutMs: 60_000 }));

    terminal.exit();
    await Promise.resolve();

    expect(reason()).toBe('exited');
  });

  it('matches output printed after it starts, across chunks and colors', async () => {
    const terminal = fakeTerminal({ running: true, working: false });
    const reason = track(
      waitForTerminal(terminal.events, {
        timeoutMs: 60_000,
        output: 'ready on 5173',
      })
    );

    terminal.print('server \x1b[32mrea');
    terminal.print('dy\x1b[0m on 51');
    await Promise.resolve();
    expect(reason()).toBeUndefined();
    terminal.print('73\r\n');
    await Promise.resolve();

    expect(reason()).toBe('output');
  });
});
