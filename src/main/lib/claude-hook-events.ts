/** The Claude Code hooks Komla's notifications install for every Claude version. */
export const CLAUDE_NOTIFICATION_HOOK_EVENTS = [
  'Notification',
  'Stop',
  'UserPromptSubmit',
  'PreToolUse',
] as const;

/**
 * Hooks for turns that end without a Stop: an API error (StopFailure), a manual /compact
 * (PostCompact) and leaving Claude (SessionEnd).
 */
const CLAUDE_TURN_END_HOOK_EVENTS = ['StopFailure', 'PostCompact', 'SessionEnd'] as const;

/**
 * Hooks for a permission prompt or question as Claude shows it (PermissionRequest; its
 * Notification follows 6 s later, and not at all once answered), and for the tool it asked about
 * ending (PostToolUse, PostToolUseFailure), which tells the prompt was answered.
 */
const CLAUDE_TOOL_HOOK_EVENTS = ['PermissionRequest', 'PostToolUse', 'PostToolUseFailure'] as const;

/**
 * StopFailure, the newest of the turn-end and tool events, arrived in 2.1.78. Claude 2.1.100 and
 * older discard the whole settings.json, the user's own settings included, over an event they
 * don't know, so these are only written for a Claude known to be at least this version.
 */
export const CLAUDE_TURN_END_HOOKS_MIN_VERSION = '2.1.78';

const CLAUDE_VERSIONED_HOOK_EVENTS = [...CLAUDE_TURN_END_HOOK_EVENTS, ...CLAUDE_TOOL_HOOK_EVENTS];

export type ClaudeHookEvent =
  | (typeof CLAUDE_NOTIFICATION_HOOK_EVENTS)[number]
  | (typeof CLAUDE_VERSIONED_HOOK_EVENTS)[number];

/** Every event Komla may have installed, so disabling removes them all. */
export const ALL_CLAUDE_HOOK_EVENTS: readonly ClaudeHookEvent[] = [
  ...CLAUDE_NOTIFICATION_HOOK_EVENTS,
  ...CLAUDE_VERSIONED_HOOK_EVENTS,
];

/** The version in `claude --version` output ("2.1.296 (Claude Code)"), among shell noise. */
export function parseClaudeVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)\s+\(Claude Code\)/.exec(output)?.[1];
}

function versionAtLeast(version: string, minimum: string): boolean {
  const actual = version.split('.').map(Number);
  const wanted = minimum.split('.').map(Number);
  for (let index = 0; index < wanted.length; index++) {
    if (actual[index] !== wanted[index]) return actual[index] > wanted[index];
  }
  return true;
}

/** What enabling Komla's notifications does with each hook event for one Claude. */
export interface ClaudeHookPlan {
  /** Written, and kept current. */
  install: ClaudeHookEvent[];
  /** Kept current where Komla already installed them, but neither added nor removed. */
  keep: ClaudeHookEvent[];
  /** Removed: this Claude is too old for them. */
  remove: ClaudeHookEvent[];
}

/**
 * The plan for a Claude of this version. When the version can't be read, turn-end and tool hooks
 * Komla already installed were written for a Claude that took them, so they stay.
 */
export function claudeHookPlan(version: string | undefined): ClaudeHookPlan {
  const base = [...CLAUDE_NOTIFICATION_HOOK_EVENTS];
  const versioned = [...CLAUDE_VERSIONED_HOOK_EVENTS];
  if (!version) return { install: base, keep: versioned, remove: [] };
  if (!versionAtLeast(version, CLAUDE_TURN_END_HOOKS_MIN_VERSION)) {
    return { install: base, keep: [], remove: versioned };
  }
  return { install: [...base, ...versioned], keep: [], remove: [] };
}

/** The events enabling writes, given Komla's commands installed for each event. */
export function claudeHooksToWrite(
  plan: ClaudeHookPlan,
  managed: (event: ClaudeHookEvent) => readonly string[]
): ClaudeHookEvent[] {
  return [...plan.install, ...plan.keep.filter((event) => managed(event).length > 0)];
}

/**
 * Whether Komla's installed hooks differ from what enabling writes: an event lacks the current
 * command, or one this Claude is too old for is still there.
 */
export function claudeHooksOutdated(
  plan: ClaudeHookPlan,
  managed: (event: ClaudeHookEvent) => readonly string[],
  expected: (event: ClaudeHookEvent) => string
): boolean {
  return (
    claudeHooksToWrite(plan, managed).some((event) => !managed(event).includes(expected(event))) ||
    plan.remove.some((event) => managed(event).length > 0)
  );
}

/** How long a probed Claude version is trusted before the next check probes again. */
export const CLAUDE_VERSION_CACHE_MS = 5 * 60_000;

/**
 * Remembers each target's Claude version for a while: probing starts a login shell and Claude
 * itself, and settings ask on every open. Enabling probes afresh.
 */
export class ClaudeVersionCache {
  private entries = new Map<string, { at: number; version: Promise<string | undefined> }>();

  get(
    key: string,
    probe: () => Promise<string | undefined>,
    fresh = false
  ): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (!fresh && entry && Date.now() - entry.at < CLAUDE_VERSION_CACHE_MS) return entry.version;
    const version = probe();
    this.entries.set(key, { at: Date.now(), version });
    return version;
  }
}
