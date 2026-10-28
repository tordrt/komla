import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  formatElapsed,
  formatRelativeTime,
  formatRunDuration,
} from '../../../src/renderer/lib/format-time';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "never" for null', () => {
    expect(formatRelativeTime(null)).toBe('never');
  });

  it('returns "never" for 0', () => {
    expect(formatRelativeTime(0)).toBe('never');
  });

  it('returns "now" for less than 60 seconds ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe('now');
    expect(formatRelativeTime(now - 30_000)).toBe('now');
    expect(formatRelativeTime(now - 59_000)).toBe('now');
  });

  it('returns minutes for 1-59 minutes ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60_000)).toBe('1m');
    expect(formatRelativeTime(now - 5 * 60_000)).toBe('5m');
    expect(formatRelativeTime(now - 59 * 60_000)).toBe('59m');
  });

  it('returns hours for 1-23 hours ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60 * 60_000)).toBe('1h');
    expect(formatRelativeTime(now - 12 * 60 * 60_000)).toBe('12h');
    expect(formatRelativeTime(now - 23 * 60 * 60_000)).toBe('23h');
  });

  it('returns days for 24+ hours ago', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 24 * 60 * 60_000)).toBe('1d');
    expect(formatRelativeTime(now - 7 * 24 * 60 * 60_000)).toBe('7d');
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '<1m'],
    [59_999, '<1m'],
    [60_000, '1m'],
    [59 * 60_000 + 59_000, '59m'],
    [3_600_000 + 2 * 60_000 + 45_000, '1h 2m'],
    // A start time a little ahead of this clock never shows a negative time.
    [-1500, '<1m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe('formatRunDuration', () => {
  it.each([
    [0, '0s'],
    [12_900, '12s'],
    [65_000, '1m 5s'],
    [3_600_000 + 2 * 60_000 + 45_000, '1h 2m'],
    [-1500, '0s'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatRunDuration(ms)).toBe(expected);
  });
});
