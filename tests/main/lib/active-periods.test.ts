import { describe, expect, it } from 'vitest';

import { activePeriodFlags } from '../../../src/main/lib/active-periods';

describe('activePeriodFlags', () => {
  it('flags both periods when no heartbeat was sent before', () => {
    expect(activePeriodFlags(undefined, '2026-10-25')).toEqual({
      firstThisWeek: true,
      firstThisMonth: true,
    });
  });

  it('flags neither when the last heartbeat was earlier in the same week and month', () => {
    // Monday 2026-10-19 and Sunday 2026-10-25 share ISO week 2026-W43.
    expect(activePeriodFlags('2026-10-19', '2026-10-25')).toEqual({
      firstThisWeek: false,
      firstThisMonth: false,
    });
  });

  it('starts a new week on Monday', () => {
    expect(activePeriodFlags('2026-10-25', '2026-10-26')).toEqual({
      firstThisWeek: true,
      firstThisMonth: false,
    });
  });

  it('starts a new month on the 1st even inside the same ISO week', () => {
    // Thursday 2026-12-31 and Friday 2027-01-01 are both in ISO week 2026-W53.
    expect(activePeriodFlags('2026-12-31', '2027-01-01')).toEqual({
      firstThisWeek: false,
      firstThisMonth: true,
    });
  });

  it('flags both after a gap of more than a month', () => {
    expect(activePeriodFlags('2026-08-03', '2026-10-25')).toEqual({
      firstThisWeek: true,
      firstThisMonth: true,
    });
  });

  it('treats an unreadable last date as no heartbeat', () => {
    expect(activePeriodFlags('not-a-date', '2026-10-25')).toEqual({
      firstThisWeek: true,
      firstThisMonth: true,
    });
  });
});
