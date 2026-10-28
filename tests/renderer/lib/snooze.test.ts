import { describe, expect, it } from 'vitest';

import {
  formatSnoozeRemaining,
  getSnoozePresets,
  toDateTimeInputValue,
  waitsForNotification,
} from '../../../src/renderer/lib/snooze';
import { createWorkspace } from '../../factories';

import type { SetupActivityRun } from '../../../src/shared/types';

const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();

describe('getSnoozePresets', () => {
  it('offers this evening, tomorrow and next Monday mornings on a weekday afternoon', () => {
    // Tuesday, Oct 20, 2:00 PM
    const presets = getSnoozePresets(new Date(local(20, 14)));

    expect(presets).toEqual([
      { label: 'In 1 Hour', until: local(20, 15) },
      { label: 'In 3 Hours', until: local(20, 17) },
      { label: 'This Evening', until: local(20, 18) },
      { label: 'Tomorrow', until: local(21, 9) },
      { label: 'Next Week', until: local(26, 9) },
    ]);
  });

  it('leaves out this evening within the hour before it', () => {
    const labels = getSnoozePresets(new Date(local(20, 17, 30))).map((p) => p.label);

    expect(labels).not.toContain('This Evening');
  });

  it('leaves out next week on a Sunday, when Monday morning is tomorrow', () => {
    const presets = getSnoozePresets(new Date(local(25, 10)));

    expect(presets.map((p) => p.label)).not.toContain('Next Week');
    expect(presets.find((p) => p.label === 'Tomorrow')?.until).toBe(local(26, 9));
  });
});

describe('waitsForNotification', () => {
  const run = (overrides: Partial<SetupActivityRun>): SetupActivityRun => ({
    id: 'run-1',
    workspaceId: 'ws-1',
    setupRunId: 'setup-1',
    stepId: 'step-1',
    stepName: 'Test',
    retryable: true,
    state: 'running',
    startedAt: 1,
    output: '',
    ...overrides,
  });

  it('waits while the spinner shows', () => {
    expect(waitsForNotification(createWorkspace({ agentActive: true, terminalCount: 1 }))).toBe(
      true
    );
    // Nothing runs, so no spinner shows.
    expect(waitsForNotification(createWorkspace({ agentActive: true }))).toBe(false);
    expect(waitsForNotification(createWorkspace({ terminalCount: 1 }))).toBe(false);
  });

  it('waits while a background Quick Command runs, not a Setup step, which never notifies', () => {
    const withRun = (overrides: Partial<SetupActivityRun>) =>
      waitsForNotification(createWorkspace({ setupActivities: [run(overrides)] }));

    expect(withRun({ actionId: 'action-1' })).toBe(true);
    expect(withRun({ actionId: 'action-1', state: 'preparing' })).toBe(true);
    expect(withRun({ actionId: 'action-1', state: 'succeeded' })).toBe(false);
    expect(withRun({})).toBe(false);
  });
});

describe('formatSnoozeRemaining', () => {
  it('rounds up to the minute below an hour and down above it', () => {
    expect(formatSnoozeRemaining(10_000, 0)).toBe('1m');
    expect(formatSnoozeRemaining(45 * 60_000, 0)).toBe('45m');
    expect(formatSnoozeRemaining(3.5 * 3_600_000, 0)).toBe('3h');
    expect(formatSnoozeRemaining(50 * 3_600_000, 0)).toBe('2d');
  });
});

describe('toDateTimeInputValue', () => {
  it('writes the local time the way a datetime-local input reads it', () => {
    expect(toDateTimeInputValue(local(5, 9, 7))).toBe('2026-10-05T09:07');
  });
});
