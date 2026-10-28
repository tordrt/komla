import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseSnoozeUntil,
  WorkspaceSnoozeAlarm,
} from '../../../src/main/services/workspace-snooze';
import { createWorkspace } from '../../factories';

// Tuesday 2026-10-20 15:30 local time.
const now = new Date(2026, 9, 20, 15, 30);

describe('parseSnoozeUntil', () => {
  it('reads durations', () => {
    expect(parseSnoozeUntil('30m', now)).toBe(now.getTime() + 30 * 60_000);
    expect(parseSnoozeUntil('2h', now)).toBe(now.getTime() + 2 * 3_600_000);
    expect(parseSnoozeUntil('1d', now)).toBe(now.getTime() + 86_400_000);
    expect(parseSnoozeUntil('1h30m', now)).toBe(now.getTime() + 90 * 60_000);
    expect(parseSnoozeUntil(' 2H ', now)).toBe(now.getTime() + 2 * 3_600_000);
  });

  it('reads a time of day as the next time it comes', () => {
    expect(parseSnoozeUntil('17:00', now)).toBe(new Date(2026, 9, 20, 17, 0).getTime());
    expect(parseSnoozeUntil('9:00', now)).toBe(new Date(2026, 9, 21, 9, 0).getTime());
    expect(parseSnoozeUntil('15:30', now)).toBe(new Date(2026, 9, 21, 15, 30).getTime());
  });

  it('reads a date and time', () => {
    expect(parseSnoozeUntil('2026-10-22 09:15', now)).toBe(new Date(2026, 9, 22, 9, 15).getTime());
    expect(parseSnoozeUntil('2026-10-22T09:15', now)).toBe(new Date(2026, 9, 22, 9, 15).getTime());
  });

  it('reads a date and time that has passed, for the caller to refuse', () => {
    expect(parseSnoozeUntil('2026-10-19 09:00', now)).toBe(new Date(2026, 9, 19, 9, 0).getTime());
  });

  it("doesn't read anything else", () => {
    for (const input of [
      '',
      '0m',
      '2',
      'h',
      '2 hours',
      '-1h',
      '24:00',
      '9:60',
      '2026-02-30 09:00',
      '2026-10-22',
      'tomorrow',
    ]) {
      expect(parseSnoozeUntil(input, now), input).toBeUndefined();
    }
  });
});

describe('WorkspaceSnoozeAlarm', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a snooze until notified with no time, unless an agent already needs the user', () => {
    vi.useFakeTimers();
    const waiting = createWorkspace({ id: 'waiting', wakesOnNotification: true });
    const asking = createWorkspace({
      id: 'asking',
      wakesOnNotification: true,
      attention: { kind: 'input-required', source: 'codex', updatedAt: 1 },
    });
    const woke = vi.fn();
    const alarm = new WorkspaceSnoozeAlarm({ workspaces: () => [waiting, asking], woke });

    alarm.check();
    vi.advanceTimersByTime(10 * 60_000);

    expect(woke).toHaveBeenCalledOnce();
    expect(woke).toHaveBeenCalledWith([asking]);
    expect(waiting.wakesOnNotification).toBe(true);
    expect(asking.wakesOnNotification).toBeUndefined();
  });
});
