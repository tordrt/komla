import { HOOK_EVENT_LABELS } from './hooks';

/**
 * What happens in a workspace that status items and sidebar panels can refresh on (`refreshOn`),
 * and panel pages and plugin code can follow (`komla.on`): the events hooks run on, and changes to
 * the workspace's files and branch.
 */
export const KOMLA_EVENT_TYPES = [
  'agent.done',
  'agent.needs-input',
  'agent.error',
  'agent.prompt',
  'workspace.created',
  'workspace.trashed',
  'working-tree.changed',
  'branch.changed',
] as const;
export type KomlaEventType = (typeof KOMLA_EVENT_TYPES)[number];

export const KOMLA_EVENT_LABELS: Record<KomlaEventType, string> = {
  ...HOOK_EVENT_LABELS,
  'working-tree.changed': "The workspace's uncommitted changes change",
  'branch.changed': "The workspace's branch or its latest commit changes",
};

/** Something that happened in a workspace. */
export interface KomlaEvent {
  type: KomlaEventType;
  workspaceId: string;
  /** The terminal an agent event came from. */
  terminalId?: string;
  /** The agent an event came from, such as `claude-code`. */
  agent?: string;
  /**
   * What the agent said, or the prompt sent to it. Plugin code gets it; panel pages don't, as a
   * prompt can hold what the user wouldn't show a page.
   */
  message?: string;
}

/** An event as a panel's page gets it, without what the agent said. */
export function pageEvent({ message: _message, ...event }: KomlaEvent): KomlaEvent {
  return event;
}
