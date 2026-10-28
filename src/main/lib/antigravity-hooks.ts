import type { RemoteNotificationIntegrationUpdate } from '../../shared/types/notification-integration';

/** Antigravity CLI reads global hooks and MCP servers from this directory under the home directory. */
export const ANTIGRAVITY_CONFIG_DIR = ['.gemini', 'config'] as const;
export const ANTIGRAVITY_HOOKS_FILE = 'hooks.json';
export const ANTIGRAVITY_MCP_FILE = 'mcp_config.json';

/** Antigravity CLI keeps its own settings, such as terminal alerts, in this directory. */
export const ANTIGRAVITY_SETTINGS_DIR = ['.gemini', 'antigravity-cli'] as const;
export const ANTIGRAVITY_SETTINGS_FILE = 'settings.json';

/**
 * Antigravity has no hook for approval prompts or questions, but with this setting on it raises a
 * terminal alert for them, which Komla shows as needing input. Enabling notifications turns it on;
 * disabling leaves it, since the alerts also work outside Komla.
 */
export const ANTIGRAVITY_ALERTS_SETTING = 'notifications';

/** hooks.json is keyed by hook-set name; Komla owns only this set. */
export const ANTIGRAVITY_HOOK_SET = 'komla';

// Every model call and tool result marks the turn working, and a fully idle
// Stop ends it. PreToolUse is skipped because its handlers must decide whether
// the tool may run. Pending approvals come from Antigravity's terminal alerts.
export const ANTIGRAVITY_HOOK_EVENTS = ['PreInvocation', 'PostToolUse', 'Stop'] as const;
export type AntigravityHookEvent = (typeof ANTIGRAVITY_HOOK_EVENTS)[number];

/** Komla's hook set, running `command(event)` for each event. */
export function buildAntigravityHookSet(
  command: (event: AntigravityHookEvent) => string
): Record<AntigravityHookEvent, unknown[]> {
  const handler = (event: AntigravityHookEvent) => ({ type: 'command', command: command(event) });
  return {
    PreInvocation: [handler('PreInvocation')],
    // Tool events wrap their handlers in a matcher group; the others list them directly.
    PostToolUse: [{ matcher: '*', hooks: [handler('PostToolUse')] }],
    Stop: [handler('Stop')],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// These rules decide what counts as configured on this computer and SSH hosts
// alike, so identical files always report the same status.

/** Komla's hook set has handlers and isn't switched off with `"enabled": false`. */
export function isAntigravityHookSetEnabled(installed: unknown): boolean {
  return (
    isRecord(installed) &&
    installed.enabled !== false &&
    ANTIGRAVITY_HOOK_EVENTS.some((event) => {
      const handlers = installed[event];
      return Array.isArray(handlers) && handlers.length > 0;
    })
  );
}

/** Antigravity's terminal alerts are on in its settings. */
export function areAntigravityAlertsOn(settings: unknown): boolean {
  return isRecord(settings) && settings[ANTIGRAVITY_ALERTS_SETTING] === true;
}

/** Komla's hook set is installed but differs from what enabling writes now. */
function antigravityHookSetNeedsUpdate(
  installed: unknown,
  expected: Record<AntigravityHookEvent, unknown[]>
): boolean {
  return (
    isRecord(installed) &&
    ANTIGRAVITY_HOOK_EVENTS.some(
      (event) => JSON.stringify(installed[event]) !== JSON.stringify(expected[event])
    )
  );
}

/** Komla's MCP server entry exists and isn't switched off with `agy mcp disable`. */
export function isAntigravityMcpServerEnabled(server: unknown): boolean {
  return isRecord(server) && server.disabled !== true;
}

type UpdateFile = { path: string; description: string };

/**
 * The files updating an installed Komla hook set would change: the hook set when it is outdated,
 * and Antigravity's settings when the set is enabled but the terminal alerts are off. Undefined
 * when nothing would change.
 */
export function antigravityUpdateFiles(
  hooks: {
    path: string;
    installed: unknown;
    expected: Record<AntigravityHookEvent, unknown[]>;
    /** What the hooks run, ending a sentence. */
    runner?: string;
  },
  settings: { path: string; installed: unknown }
): UpdateFile[] | undefined {
  if (!isRecord(hooks.installed)) return undefined;
  const files: UpdateFile[] = [];
  if (antigravityHookSetNeedsUpdate(hooks.installed, hooks.expected)) {
    files.push({
      path: hooks.path,
      description: `Update the "${ANTIGRAVITY_HOOK_SET}" hook set to the current events. They run ${hooks.runner ?? 'the Komla CLI'}. Other hook sets are preserved.`,
    });
  }
  if (isAntigravityHookSetEnabled(hooks.installed) && !areAntigravityAlertsOn(settings.installed)) {
    files.push({
      path: settings.path,
      description: `Turn on Antigravity's terminal alerts ("${ANTIGRAVITY_ALERTS_SETTING}") so Komla can show when it needs approval. Other settings are preserved.`,
    });
  }
  return files.length > 0 ? files : undefined;
}

/** An update to Komla's Antigravity integration on an SSH host. */
export function remoteAntigravityUpdate(
  files: UpdateFile[],
  hookSet: Record<AntigravityHookEvent, unknown[]>
): RemoteNotificationIntegrationUpdate {
  return {
    files,
    preview: JSON.stringify({ [ANTIGRAVITY_HOOK_SET]: hookSet }, null, 2),
  };
}
