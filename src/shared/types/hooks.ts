/** What a hook in hooks.json runs on; `interval` runs it on a timer instead. */
export const HOOK_EVENTS = [
  'agent.done',
  'agent.needs-input',
  'agent.error',
  'agent.prompt',
  'workspace.created',
  'workspace.trashed',
  'interval',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Something that happened in a workspace, which the hooks for its event run on. */
export interface HookEventDetails {
  event: Exclude<HookEvent, 'interval'>;
  workspaceId: string;
  terminalId?: string;
  /** The agent the event came from, such as `claude-code`. */
  agent?: string;
  /** What the agent said, such as which permission it asks for, or the user's prompt. */
  message?: string;
}
