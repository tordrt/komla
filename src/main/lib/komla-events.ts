import { onHookEvent } from './hook-events';

import type { KomlaEvent } from '../../shared/types/komla-events';

const listeners = new Set<(event: KomlaEvent) => void>();

/**
 * Follows what happens in workspaces, for `refreshOn`, panel pages and plugin code: the events
 * hooks run on, and changes to a workspace's files and branch.
 */
export function onKomlaEvent(listener: (event: KomlaEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishKomlaEvent(event: KomlaEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // One listener's failure doesn't keep the event from the others.
    }
  }
}

/** Publishes a change the workspace's watcher saw, as `working-tree.changed` and `branch.changed`. */
export function publishWorkingTreeEvents(
  workspaceId: string,
  changeTypes: readonly string[]
): void {
  if (changeTypes.includes('file'))
    publishKomlaEvent({ type: 'working-tree.changed', workspaceId });
  if (changeTypes.includes('git-head') || changeTypes.includes('git-branch')) {
    publishKomlaEvent({ type: 'branch.changed', workspaceId });
  }
}

let stopFollowingHooks: (() => void) | undefined;

/** Publishes the events hooks run on as Komla events too. */
export function followHookEventsAsKomlaEvents(): () => void {
  stopFollowingHooks ??= onHookEvent(({ event, ...details }) =>
    publishKomlaEvent({ type: event, ...details })
  );
  return () => {
    stopFollowingHooks?.();
    stopFollowingHooks = undefined;
  };
}
