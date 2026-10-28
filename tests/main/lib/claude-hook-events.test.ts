import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_VERSION_CACHE_MS,
  ClaudeVersionCache,
  claudeHookPlan,
  claudeHooksOutdated,
  claudeHooksToWrite,
  parseClaudeVersion,
  type ClaudeHookEvent,
} from '../../../src/main/lib/claude-hook-events';

const BASE = ['Notification', 'Stop', 'UserPromptSubmit', 'PreToolUse'];
const VERSIONED = [
  'StopFailure',
  'PostCompact',
  'SessionEnd',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
];

describe('claude-hook-events', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finds the version in claude --version output', () => {
    expect(parseClaudeVersion('2.1.296 (Claude Code)\n')).toBe('2.1.296');
    expect(parseClaudeVersion('motd\n1.0.85 (Claude Code)')).toBe('1.0.85');
    expect(parseClaudeVersion('zsh: command not found: claude')).toBeUndefined();
    expect(parseClaudeVersion('node v22.1.0')).toBeUndefined();
  });

  it.each([
    ['1.0.85', false],
    ['2.1.77', false],
    ['2.1.78', true],
    ['2.1.296', true],
    ['2.2.0', true],
    ['3.0.0', true],
  ])('Claude %s gets the turn-end and tool hooks: %s', (version, accepted) => {
    expect(claudeHookPlan(version)).toEqual({
      install: accepted ? [...BASE, ...VERSIONED] : BASE,
      keep: [],
      remove: accepted ? [] : VERSIONED,
    });
  });

  it('keeps the turn-end and tool hooks already installed when the version is unknown', () => {
    const plan = claudeHookPlan(undefined);
    expect(plan).toEqual({ install: BASE, keep: VERSIONED, remove: [] });
    const installed: Partial<Record<ClaudeHookEvent, string[]>> = { PostCompact: ['old'] };
    expect(claudeHooksToWrite(plan, (event) => installed[event] ?? [])).toEqual([
      ...BASE,
      'PostCompact',
    ]);
  });

  describe('claudeHooksOutdated', () => {
    const expected = (event: ClaudeHookEvent) => `komla ${event}`;
    const managing =
      (events: readonly string[], command = (event: string) => `komla ${event}`) =>
      (event: ClaudeHookEvent) =>
        events.includes(event) ? [command(event)] : [];

    it('is current when every event to write has the current command', () => {
      expect(
        claudeHooksOutdated(claudeHookPlan('2.1.296'), managing([...BASE, ...VERSIONED]), expected)
      ).toBe(false);
      expect(claudeHooksOutdated(claudeHookPlan('2.1.50'), managing(BASE), expected)).toBe(false);
      expect(claudeHooksOutdated(claudeHookPlan(undefined), managing(BASE), expected)).toBe(false);
    });

    it('flags missing events and stale commands', () => {
      expect(claudeHooksOutdated(claudeHookPlan('2.1.296'), managing(BASE), expected)).toBe(true);
      expect(
        claudeHooksOutdated(
          claudeHookPlan(undefined),
          managing([...BASE, 'SessionEnd'], (event) =>
            event === 'SessionEnd' ? 'old' : `komla ${event}`
          ),
          expected
        )
      ).toBe(true);
    });

    it('flags turn-end hooks a Claude known to be older would reject', () => {
      expect(
        claudeHooksOutdated(claudeHookPlan('2.1.50'), managing([...BASE, 'StopFailure']), expected)
      ).toBe(true);
    });
  });

  describe('ClaudeVersionCache', () => {
    it('reuses a probed version for a while, per target, unless asked to probe afresh', async () => {
      vi.useFakeTimers();
      const cache = new ClaudeVersionCache();
      const probe = vi.fn().mockResolvedValue('2.1.296');

      await expect(cache.get('local', probe)).resolves.toBe('2.1.296');
      await cache.get('local', probe);
      expect(probe).toHaveBeenCalledTimes(1);

      await cache.get('host-1', probe);
      expect(probe).toHaveBeenCalledTimes(2);

      await cache.get('local', probe, true);
      expect(probe).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(CLAUDE_VERSION_CACHE_MS);
      await cache.get('local', probe);
      expect(probe).toHaveBeenCalledTimes(4);
    });
  });
});
