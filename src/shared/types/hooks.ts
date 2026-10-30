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

/** What each event is, as a settings change and a plugin's hooks say when they run. */
export const HOOK_EVENT_LABELS: Record<Exclude<HookEvent, 'interval'>, string> = {
  'agent.done': 'An agent finishes',
  'agent.needs-input': 'An agent needs input',
  'agent.error': 'An agent reports an error',
  'agent.prompt': 'A prompt is sent to an agent',
  'workspace.created': 'A workspace is created',
  'workspace.trashed': 'A workspace is moved to the Trash',
};

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
