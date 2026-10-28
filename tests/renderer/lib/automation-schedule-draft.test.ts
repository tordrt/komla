import { describe, expect, it } from 'vitest';

import {
  cronToDraft,
  describeSchedule,
  draftToCron,
  formatRunTime,
  type ScheduleDraft,
} from '../../../src/renderer/lib/automation-schedule-draft';

const draft = (overrides: Partial<ScheduleDraft>): ScheduleDraft => ({
  frequency: 'daily',
  time: '09:00',
  minute: 0,
  days: [1],
  cron: '',
  ...overrides,
});

describe('automation schedule drafts', () => {
  it.each([
    [draft({ frequency: 'hourly', minute: 15 }), '15 * * * *'],
    [draft({ frequency: 'daily', time: '07:05' }), '5 7 * * *'],
    [draft({ frequency: 'weekdays', time: '09:30' }), '30 9 * * 1-5'],
    [draft({ frequency: 'weekly', time: '18:00', days: [4, 1] }), '0 18 * * 1,4'],
    [draft({ frequency: 'custom', cron: ' 0 */6 * * * ' }), '0 */6 * * *'],
  ])('turns %j into %s and back', (input, cron) => {
    expect(draftToCron(input)).toBe(cron);
    const back = cronToDraft(cron);
    expect(back.frequency).toBe(input.frequency);
    expect(draftToCron(back)).toBe(cron);
  });

  it('shows expressions the picker has no choice for as custom', () => {
    expect(cronToDraft('0 9 1 * *').frequency).toBe('custom');
    expect(cronToDraft('0 9 * * MON').frequency).toBe('custom');
    expect(cronToDraft('0 9-17 * * *').frequency).toBe('custom');
  });

  it.each([
    ['0 * * * *', 'Every hour'],
    ['15 * * * *', 'Every hour at :15'],
    ['0 9 * * *', 'Every day at 09:00'],
    ['30 8 * * 1-5', 'Weekdays at 08:30'],
    ['0 18 * * 5', 'Fridays at 18:00'],
    ['0 9 * * 1,4', 'Mondays and Thursdays at 09:00'],
    ['0 9 * * 0,1,3', 'Mon, Wed, Sun at 09:00'],
    ['0 9 1 * *', 'Cron 0 9 1 * *'],
  ])('describes %s as %s', (cron, description) => {
    expect(describeSchedule(cron)).toBe(description);
  });

  it('names today and tomorrow in the schedule’s time zone', () => {
    const now = Date.parse('2026-10-15T20:00:00Z');
    expect(formatRunTime(Date.parse('2026-10-15T21:00:00Z'), 'UTC', now)).toBe('Today 21:00');
    // Half past midnight on the 16th in Oslo, still the 15th in UTC.
    const lateNight = Date.parse('2026-10-15T22:30:00Z');
    expect(formatRunTime(Date.parse('2026-10-16T07:00:00Z'), 'Europe/Oslo', lateNight)).toBe(
      'Today 09:00'
    );
    expect(formatRunTime(Date.parse('2026-10-16T07:00:00Z'), 'UTC', lateNight)).toBe(
      'Tomorrow 07:00'
    );
    expect(formatRunTime(Date.parse('2026-10-16T09:00:00Z'), 'UTC', now)).toBe('Tomorrow 09:00');
    expect(formatRunTime(Date.parse('2026-10-20T09:00:00Z'), 'UTC', now)).toBe(
      'Tue, Oct 20, 09:00'
    );
  });
});
