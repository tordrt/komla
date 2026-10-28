import {
  COMMAND_ATTENTION_SOURCE,
  type WorkspaceAttentionEvent,
  type WorkspaceAttentionKind,
} from '../../shared/types/workspace';

import type { HookEventDetails } from '../../shared/types/hooks';

const listeners = new Set<(details: HookEventDetails) => void>();

/** Follows the events hooks run on; workspace services publish them without knowing of hooks. */
export function onHookEvent(listener: (details: HookEventDetails) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishHookEvent(details: HookEventDetails): void {
  for (const listener of listeners) listener(details);
}

const ATTENTION_HOOK_EVENTS: Partial<Record<WorkspaceAttentionKind, HookEventDetails['event']>> = {
  'turn-complete': 'agent.done',
  'input-required': 'agent.needs-input',
  error: 'agent.error',
};

/** Publishes an agent finishing or asking for input, once Terminal Attention has settled it. */
export function publishAttentionHookEvent({
  workspaceId,
  attention,
}: WorkspaceAttentionEvent): void {
  const event = ATTENTION_HOOK_EVENTS[attention.kind];
  // A command run with `komla notify --` finishing is no agent's, and a hook's own notification
  // would set the hook off again.
  if (!event || attention.source === COMMAND_ATTENTION_SOURCE || attention.source === 'hook') {
    return;
  }
  publishHookEvent({
    event,
    workspaceId,
    ...(attention.terminalId && { terminalId: attention.terminalId }),
    ...(attention.source !== 'generic' && { agent: attention.source }),
    ...(attention.message && { message: attention.message }),
  });
}
