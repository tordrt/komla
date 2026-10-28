import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_HOLD_LIMIT_MS,
  COMPLETION_SETTLE_MS,
  INPUT_REQUIRED_SETTLE_MS,
  NotificationLifecycle,
} from '../../../src/main/services/terminal-attention/notification-lifecycle';

describe('NotificationLifecycle', () => {
  let lifecycle: NotificationLifecycle;
  const event = (kind: string, session = 'root', turn = 'turn-1') => ({
    kind,
    source: 'codex',
    hookInput: { session_id: session, turn_id: turn, hook_event_name: kind },
  });
  beforeEach(() => {
    vi.useFakeTimers();
    lifecycle = new NotificationLifecycle();
  });
  afterEach(() => {
    lifecycle.clear();
    vi.useRealTimers();
  });

  it('accepts completion only after the settle period', async () => {
    const result = vi.fn();
    void lifecycle.accept('terminal-1', event('turn-complete')).then(result);
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS - 1);
    expect(result).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toHaveBeenCalledWith('accept');
  });

  it.each(['activity', 'prompt-submit', 'input-required', 'error'])(
    'cancels completion on %s',
    async (kind) => {
      const pending = lifecycle.accept('terminal-1', event('turn-complete'));
      const next = lifecycle.accept('terminal-1', event(kind));
      expect(await pending).toBe('superseded');
      await vi.runAllTimersAsync();
      expect(await next).toBe('accept');
    }
  );

  describe('input-required', () => {
    const request = (permissionID?: string) => {
      const payload = event('input-required');
      return { ...payload, hookInput: { ...payload.hookInput, permissionID } };
    };
    const activity = (permissionID?: string) => {
      const payload = event('activity');
      return { ...payload, hookInput: { ...payload.hookInput, permissionID } };
    };

    it('accepts a request only after its settle period', async () => {
      const result = vi.fn();
      void lifecycle.accept('terminal-1', request('per_1')).then(result);
      await vi.advanceTimersByTimeAsync(INPUT_REQUIRED_SETTLE_MS - 1);
      expect(result).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toHaveBeenCalledWith('accept');
    });

    it('accepts a request without an id at once, as nothing answers it automatically', async () => {
      expect(await lifecycle.accept('terminal-1', request())).toBe('accept');
    });

    it('cancels a request on the activity that answers it', async () => {
      const pending = lifecycle.accept('terminal-1', request('per_1'));
      expect(await lifecycle.accept('terminal-1', activity('per_1'))).toBe('accept');
      expect(await pending).toBe('superseded');
    });

    it('drops a request whose reply arrived first', async () => {
      expect(await lifecycle.accept('terminal-1', activity('per_1'))).toBe('accept');
      expect(await lifecycle.accept('terminal-1', request('per_1'))).toBe('superseded');
    });

    it('waits on each request separately', async () => {
      const first = lifecycle.accept('terminal-1', request('per_1'));
      const second = lifecycle.accept('terminal-1', request('per_2'));
      await lifecycle.accept('terminal-1', activity('per_2'));
      expect(await second).toBe('superseded');
      await vi.advanceTimersByTimeAsync(INPUT_REQUIRED_SETTLE_MS);
      expect(await first).toBe('accept');
    });

    it.each([undefined, 'per_2'])(
      'keeps a request through other tool activity (%s), as from a parallel tool call',
      async (permissionID) => {
        const pending = lifecycle.accept('terminal-1', request('per_1'));
        expect(await lifecycle.accept('terminal-1', activity(permissionID))).toBe('accept');
        await vi.advanceTimersByTimeAsync(INPUT_REQUIRED_SETTLE_MS);
        expect(await pending).toBe('accept');
      }
    );

    it.each(['prompt-submit', 'turn-complete', 'error', 'interrupted'])(
      'cancels a request on %s',
      async (kind) => {
        const pending = lifecycle.accept('terminal-1', request('per_1'));
        const next = lifecycle.accept('terminal-1', event(kind));
        expect(await pending).toBe('superseded');
        await vi.runAllTimersAsync();
        expect(await next).toBe('accept');
      }
    );

    it('drops an idle reminder while a request settles', async () => {
      const pending = lifecycle.accept('terminal-1', request('per_1'));
      expect(await lifecycle.accept('terminal-1', event('idle'))).toBe('duplicate');
      await vi.advanceTimersByTimeAsync(INPUT_REQUIRED_SETTLE_MS);
      expect(await pending).toBe('accept');
    });
  });

  it.each(['activity', 'turn-complete'])('ignores old %s after a new turn starts', async (kind) => {
    await lifecycle.accept('terminal-1', event('prompt-submit'));
    await lifecycle.accept('terminal-1', event('prompt-submit', 'root', 'turn-2'));
    expect(await lifecycle.accept('terminal-1', event(kind))).toBe('stale');
  });

  it('does not let a nested session replace the root through tool activity', async () => {
    await lifecycle.accept('terminal-1', event('prompt-submit'));
    expect(await lifecycle.accept('terminal-1', event('activity', 'child'))).toBe('stale');
    expect(await lifecycle.accept('terminal-1', event('activity'))).toBe('accept');
  });

  it('uses Claude prompt_id for turn identity', async () => {
    await lifecycle.accept('terminal-1', {
      kind: 'prompt-submit',
      hookInput: { session_id: 's', prompt_id: 'new' },
    });
    expect(
      await lifecycle.accept('terminal-1', {
        kind: 'turn-complete',
        hookInput: { session_id: 's', prompt_id: 'old' },
      })
    ).toBe('stale');
  });

  it.each(['activity', 'turn-complete', 'prompt-submit'])('ignores subagent %s', async (kind) => {
    const payload = event(kind);
    expect(
      await lifecycle.accept('terminal-1', {
        ...payload,
        hookInput: { ...payload.hookInput, agent_id: 'child' },
      })
    ).toBe('subagent');
  });

  it('keeps inferred completion through rejected events and isolates sources and terminals', async () => {
    await lifecycle.accept('terminal-1', event('activity'));
    lifecycle.recordInferredCompletion('terminal-1', 'codex');
    expect(await lifecycle.accept('terminal-1', event('activity', 'old'))).toBe('stale');
    const child = event('activity');
    expect(await lifecycle.accept('terminal-1', {
      ...child, hookInput: { ...child.hookInput, agent_id: 'child' },
    })).toBe('subagent');
    expect(await lifecycle.accept('terminal-1', event('turn-complete'))).toBe('duplicate');
    expect(await lifecycle.accept('terminal-1', {
      kind: 'turn-complete', source: 'codex', hookInput: { hook_event_name: 'Stop' },
    })).toBe('duplicate');
    const otherTerminal = lifecycle.accept('terminal-2', event('turn-complete'));
    const otherSource = lifecycle.accept('terminal-1', {
      ...event('turn-complete'), source: 'claude',
    });
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await otherTerminal).toBe('accept');
    expect(await otherSource).toBe('accept');
  });

  it.each(['close', 'prune', 'clear'] as const)(
    'forgets inferred completion on %s', async (cleanup) => {
      await lifecycle.accept('terminal-1', event('activity'));
      lifecycle.recordInferredCompletion('terminal-1', 'codex');
      if (cleanup === 'close') lifecycle.close('terminal-1');
      else if (cleanup === 'prune') lifecycle.prune(new Set());
      else lifecycle.clear();
      const completion = lifecycle.accept('terminal-1', event('turn-complete', 'new'));
      await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
      expect(await completion).toBe('accept');
    }
  );

  it('isolates terminal activity and cancels pending work on close', async () => {
    const pending = lifecycle.accept('terminal-1', event('turn-complete'));
    await lifecycle.accept('terminal-2', event('activity'));
    const result = vi.fn();
    void pending.then(result);
    await vi.advanceTimersByTimeAsync(1);
    expect(result).not.toHaveBeenCalled();
    lifecycle.prune(new Set(['terminal-2']));
    expect(await pending).toBe('closed');
  });

  it.each(['turn-complete', 'inferred'])('ignores an idle reminder after a %s', async (end) => {
    await lifecycle.accept('terminal-1', event('prompt-submit'));
    if (end === 'inferred') lifecycle.recordInferredCompletion('terminal-1', 'codex');
    else {
      const stop = lifecycle.accept('terminal-1', event('turn-complete'));
      await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
      expect(await stop).toBe('accept');
    }
    expect(await lifecycle.accept('terminal-1', event('idle'))).toBe('duplicate');
    await lifecycle.accept('terminal-1', event('prompt-submit', 'root', 'turn-2'));
    const idle = lifecycle.accept('terminal-1', event('idle', 'root', 'turn-2'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await idle).toBe('accept');
  });

  it('keeps ignoring an idle reminder after the done until the next turn', async () => {
    const stop = lifecycle.accept('terminal-1', event('turn-complete'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await stop).toBe('accept');
    expect(await lifecycle.accept('terminal-1', event('idle'))).toBe('duplicate');
    expect(await lifecycle.accept('terminal-1', event('idle'))).toBe('duplicate');
  });

  it('lets a settling Stop finish when an idle reminder arrives right after it', async () => {
    const stop = lifecycle.accept('terminal-1', event('turn-complete'));
    expect(await lifecycle.accept('terminal-1', event('idle'))).toBe('duplicate');
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await stop).toBe('accept');
  });

  it('accepts repeated idle reminders from an agent that sends no Stop', async () => {
    for (let turn = 0; turn < 2; turn++) {
      expect(await lifecycle.accept('terminal-1', { kind: 'idle', source: 'custom' })).toBe(
        'accept'
      );
    }
  });

  it('holds a Stop while a background subagent is running, but not for a shell without a command', async () => {
    const stop = (status: string, type = 'subagent') => ({
      ...event('turn-complete'),
      hookInput: {
        ...event('turn-complete').hookInput,
        background_tasks: [{ type, status, id: 'task-1' }],
      },
    });
    expect(await lifecycle.accept('terminal-1', stop('running'))).toBe('background');
    expect(await lifecycle.accept('terminal-1', event('idle'))).toBe('duplicate');
    await lifecycle.accept('terminal-1', event('prompt-submit', 'root', 'turn-2'));
    const done = lifecycle.accept('terminal-1', {
      ...stop('running', 'shell'),
      hookInput: { ...stop('running', 'shell').hookInput, turn_id: 'turn-2' },
    });
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await done).toBe('accept');
  });

  const shellStop = (command: string) => ({
    ...event('turn-complete'),
    hookInput: {
      ...event('turn-complete').hookInput,
      background_tasks: [{ type: 'shell', status: 'running', id: 'task-1', command }],
    },
  });

  it.each([
    ['npm test > test.log 2>&1', 'background'],
    ['npm run dev', 'accept'],
  ])('a Stop with running background shell `%s` resolves as %s', async (command, decision) => {
    const done = lifecycle.accept('terminal-1', shellStop(command));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await done).toBe(decision);
  });

  it('completes a held Stop at the hold limit when the turn never resumes', async () => {
    const expired = vi.fn();
    expect(await lifecycle.accept('terminal-1', shellStop('npm test'), undefined, expired)).toBe(
      'background'
    );
    expect(await lifecycle.accept('terminal-1', event('idle'))).toBe('duplicate');
    await vi.advanceTimersByTimeAsync(BACKGROUND_HOLD_LIMIT_MS - 1);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it.each(['resume', 'close', 'interrupt'])('cancels the hold limit on %s', async (step) => {
    const expired = vi.fn();
    await lifecycle.accept('terminal-1', shellStop('npm test'), undefined, expired);
    if (step === 'close') lifecycle.close('terminal-1');
    else if (step === 'interrupt') await lifecycle.accept('terminal-1', event('interrupted'));
    else await lifecycle.accept('terminal-1', event('prompt-submit', 'root', 'turn-2'));
    await vi.advanceTimersByTimeAsync(BACKGROUND_HOLD_LIMIT_MS);
    expect(expired).not.toHaveBeenCalled();
  });

  // Recorded from Claude 2.1.296: /compact and /exit run as commands with their own prompt ids.
  const claude = (kind: string, hookEvent: string, prompt: string, session = 's') => ({
    kind,
    source: 'claude-code',
    hookInput: { session_id: session, prompt_id: prompt, hook_event_name: hookEvent },
  });

  it("accepts a manual compact's completion and leaving Claude, which have their own prompt ids", async () => {
    await lifecycle.accept('terminal-1', claude('prompt-submit', 'UserPromptSubmit', 'p1'));
    const stopped = lifecycle.accept('terminal-1', claude('turn-complete', 'Stop', 'p1'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    await stopped;
    const compacted = lifecycle.accept('terminal-1', claude('turn-complete', 'PostCompact', 'p2'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await compacted).toBe('accept');
    expect(await lifecycle.accept('terminal-1', claude('interrupted', 'SessionEnd', 'p3'))).toBe(
      'accept'
    );
    expect(await lifecycle.accept('terminal-1', claude('turn-complete', 'Stop', 'p0'))).toBe(
      'stale'
    );
  });

  it('keeps holding a Stop for a background subagent through a manual compact', async () => {
    const expired = vi.fn();
    const heldStop = {
      ...claude('turn-complete', 'Stop', 'p1'),
      hookInput: {
        ...claude('turn-complete', 'Stop', 'p1').hookInput,
        background_tasks: [{ type: 'subagent', status: 'running', id: 'task-1' }],
      },
    };
    expect(await lifecycle.accept('terminal-1', heldStop, undefined, expired)).toBe('background');
    const compacted = lifecycle.accept('terminal-1', claude('turn-complete', 'PostCompact', 'p2'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await compacted).toBe('background');
    expect(await lifecycle.accept('terminal-1', claude('idle', 'Notification', 'p1'))).toBe(
      'duplicate'
    );
    // The hold limit still counts from the Stop.
    await vi.advanceTimersByTimeAsync(BACKGROUND_HOLD_LIMIT_MS - COMPLETION_SETTLE_MS - 1);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  // Recorded from Claude 2.1.304: /code-review runs its review as a background subagent and
  // sends no Stop until the review hands back.
  it('does not complete a turn still running its background review on a manual compact', async () => {
    await lifecycle.accept('terminal-1', claude('prompt-submit', 'UserPromptSubmit', 'p1'));
    const compacted = lifecycle.accept('terminal-1', claude('turn-complete', 'PostCompact', 'p2'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await compacted).toBe('background');
    await lifecycle.accept('terminal-1', claude('prompt-submit', 'UserPromptSubmit', 'p3'));
    const stopped = lifecycle.accept('terminal-1', claude('turn-complete', 'Stop', 'p3'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await stopped).toBe('accept');
  });

  it.each([
    ['a Stop', claude('turn-complete', 'Stop', 'p1')],
    ['a failed turn', claude('error', 'StopFailure', 'p1')],
    ['leaving Claude', claude('interrupted', 'SessionEnd', 'p9')],
  ])('completes a manual compact after %s ended the turn', async (_name, turnEnd) => {
    await lifecycle.accept('terminal-1', claude('prompt-submit', 'UserPromptSubmit', 'p1'));
    const ended = lifecycle.accept('terminal-1', turnEnd);
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    await ended;
    const compacted = lifecycle.accept('terminal-1', claude('turn-complete', 'PostCompact', 'p2'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await compacted).toBe('accept');
  });

  it('completes a manual compact after an interrupt the title confirmed', async () => {
    await lifecycle.accept('terminal-1', claude('prompt-submit', 'UserPromptSubmit', 'p1'));
    lifecycle.recordInterrupt('terminal-1');
    const compacted = lifecycle.accept('terminal-1', claude('turn-complete', 'PostCompact', 'p2'));
    await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
    expect(await compacted).toBe('accept');
  });

  it("ignores a nested session's end and error, and a subagent's", async () => {
    await lifecycle.accept('terminal-1', claude('prompt-submit', 'UserPromptSubmit', 'p1'));
    for (const kind of ['interrupted', 'error']) {
      expect(
        await lifecycle.accept('terminal-1', claude(kind, 'SessionEnd', 'p9', 'nested'))
      ).toBe('stale');
      expect(
        await lifecycle.accept('terminal-1', {
          kind,
          source: 'claude-code',
          hookInput: { session_id: 's', agent_id: 'child', hook_event_name: 'StopFailure' },
        })
      ).toBe('subagent');
    }
  });
});
