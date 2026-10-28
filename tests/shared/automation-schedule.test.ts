import { describe, expect, it } from 'vitest';

import cases from '../../src/shared/automation-schedule-cases.json';
import {
  automationScheduleError,
  dueAutomationOccurrence,
  nextAutomationOccurrence,
  parseCron,
} from '../../src/shared/lib/automation-schedule';

const at = (iso: string) => Date.parse(iso);

describe('automation schedules', () => {
  it.each(cases.next)('finds the next time: $name', (testCase) => {
    const next = nextAutomationOccurrence(
      { cron: testCase.cron, timeZone: testCase.timeZone },
      at(testCase.after)
    );
    expect(next && new Date(next).toISOString()).toBe(new Date(testCase.expected).toISOString());
  });

  it.each(cases.due)('decides what a tick does: $name', (testCase) => {
    const due = dueAutomationOccurrence(
      {
        enabled: testCase.enabled,
        schedule: { cron: testCase.cron, timeZone: testCase.timeZone },
        missedRunGraceMinutes: testCase.missedRunGraceMinutes,
        updatedAt: at(testCase.updatedAt),
      },
      'lastScheduledFor' in testCase ? at(testCase.lastScheduledFor) : undefined,
      at(testCase.now)
    );
    const { expected } = testCase;
    expect(due).toEqual(
      'scheduledFor' in expected
        ? { kind: expected.kind, scheduledFor: at(expected.scheduledFor) }
        : { kind: expected.kind }
    );
  });

  it.each(cases.invalidCron)('refuses the cron expression %j', (cron) => {
    expect(automationScheduleError({ cron, timeZone: 'UTC' })).toEqual(expect.any(String));
  });

  it.each(cases.invalidTimeZone)('refuses the time zone %j', (timeZone) => {
    expect(automationScheduleError({ cron: '0 9 * * *', timeZone })).toEqual(expect.any(String));
  });

  it('reads both day fields restricted as either one', () => {
    expect(parseCron('0 9 1 * 1').eitherDay).toBe(true);
    expect(parseCron('0 9 * * 1').eitherDay).toBe(false);
    expect(parseCron('0 9 */2 * 1').eitherDay).toBe(false);
  });
});
