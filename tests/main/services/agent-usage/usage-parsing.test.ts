import { describe, expect, it } from 'vitest';

import {
  namesForDuration,
  parseClaudeUsage,
  parseCodexUsage,
} from '../../../../src/main/services/agent-usage/usage-parsing';

describe('parseClaudeUsage', () => {
  it('lists every limit, the session and weekly ones in the bar', () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 3, resets_at: '2026-10-23T17:00:00.357954+00:00' },
      limits: [
        { kind: 'session', percent: 3, resets_at: '2026-10-23T17:00:00.357954+00:00' },
        { kind: 'weekly_all', percent: 47, resets_at: '2026-10-27T16:00:00+00:00' },
        {
          kind: 'weekly_scoped',
          percent: 0,
          resets_at: '2026-10-27T16:00:00+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        },
        { kind: 'something_new', percent: 10, resets_at: null },
      ],
    });

    expect(usage?.windows).toEqual([
      {
        name: '5-hour limit',
        short: '5h',
        usedPercent: 3,
        resetsAt: Date.parse('2026-10-23T17:00:00.357Z'),
      },
      {
        name: 'Weekly limit',
        short: '7d',
        usedPercent: 47,
        resetsAt: Date.parse('2026-10-27T16:00:00Z'),
      },
      {
        name: 'Weekly Fable limit',
        short: null,
        usedPercent: 0,
        resetsAt: Date.parse('2026-10-27T16:00:00Z'),
      },
    ]);
  });

  it('reads the named windows of a response without limits', () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 12.5, resets_at: null },
      seven_day: { utilization: 140, resets_at: '2026-10-27T16:00:00Z' },
      seven_day_opus: null,
    });

    expect(usage?.windows).toEqual([
      { name: '5-hour limit', short: '5h', usedPercent: 12.5, resetsAt: null },
      {
        name: 'Weekly limit',
        short: '7d',
        usedPercent: 100,
        resetsAt: Date.parse('2026-10-27T16:00:00Z'),
      },
    ]);
  });

  it('refuses a response of another shape', () => {
    expect(parseClaudeUsage(null)).toBeNull();
    expect(parseClaudeUsage({ five_hour: { utilization: 'high' } })).toBeNull();
  });

  it('drops only a limit it cannot read, and puts the shortest first', () => {
    const usage = parseClaudeUsage({
      limits: [
        { kind: 'weekly_all', percent: 47, resets_at: null },
        { kind: 'weekly_scoped', percent: null, resets_at: null },
        { kind: 'session', percent: 3, resets_at: null },
      ],
    });

    expect(usage?.windows.map((window) => window.short)).toEqual(['5h', '7d']);
  });

  it('numbers limits that share a name', () => {
    const scoped = { kind: 'weekly_scoped', percent: 1, resets_at: null };

    expect(parseClaudeUsage({ limits: [scoped, scoped] })?.windows.map((w) => w.name)).toEqual([
      'Weekly model limit',
      'Weekly model limit 2',
    ]);
  });

  it('reads the named windows when the list has no limit it knows', () => {
    for (const limits of [[], [{ kind: 'five_hour', percent: 3, resets_at: null }]]) {
      const usage = parseClaudeUsage({
        limits,
        five_hour: { utilization: 3, resets_at: null },
        seven_day: { utilization: 47, resets_at: null },
        seven_day_opus: { utilization: null, resets_at: null },
      });

      expect(usage?.windows.map((window) => window.name)).toEqual(['5-hour limit', 'Weekly limit']);
    }
  });
});

describe('parseCodexUsage', () => {
  it('names windows by their length and keeps the plan and email', () => {
    const usage = parseCodexUsage({
      email: 'dev@example.com',
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1795034453 },
        secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: null },
      },
    });

    expect(usage).toEqual({
      plan: 'plus',
      account: 'dev@example.com',
      windows: [
        { name: '5-hour limit', short: '5h', usedPercent: 20, resetsAt: 1795034453000 },
        { name: 'Weekly limit', short: '7d', usedPercent: 61, resetsAt: null },
      ],
    });
  });

  it('puts the shortest window first and drops one it cannot read', () => {
    const usage = parseCodexUsage({
      email: 7,
      rate_limit: {
        primary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: null },
        secondary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: null },
      },
    });
    expect(usage?.windows.map((window) => window.short)).toEqual(['5h', '7d']);
    expect(usage?.account).toBeNull();

    expect(
      parseCodexUsage({
        rate_limit: {
          primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: null },
          secondary_window: { used_percent: 61, limit_window_seconds: 0 },
        },
      })?.windows.map((window) => window.short)
    ).toEqual(['5h']);
  });

  it('reads a plan with one window and none for a plan without limits', () => {
    expect(
      parseCodexUsage({
        rate_limit: {
          primary_window: { used_percent: 100, limit_window_seconds: 2592000, reset_at: 1 },
          secondary_window: null,
        },
      })?.windows
    ).toEqual([{ name: '30-day limit', short: '30d', usedPercent: 100, resetsAt: 1000 }]);
    expect(parseCodexUsage({ plan_type: 'team', rate_limit: null })?.windows).toEqual([]);
  });
});

describe('namesForDuration', () => {
  it('names odd lengths too', () => {
    expect(namesForDuration(90)).toEqual({ name: '90-minute limit', short: '90m' });
    expect(namesForDuration(120)).toEqual({ name: '2-hour limit', short: '2h' });
  });
});
