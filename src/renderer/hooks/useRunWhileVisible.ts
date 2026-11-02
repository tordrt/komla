import { useEffect, useEffectEvent } from 'react';

import type { KomlaEvent, KomlaEventType } from '../../shared/types/komla-events';

/** How long a burst of events, such as a file save's, runs an entry once after it ends. */
export const REFRESH_ON_SETTLE_MS = 750;

/** Whether an event is one an entry refreshes on: its type, in its workspace, or in any for one that runs on this computer. */
export function refreshesOn(
  event: KomlaEvent,
  entry: { refreshOn?: KomlaEventType[]; runOn?: 'local' },
  workspaceId: string
): boolean {
  return (
    Boolean(entry.refreshOn?.includes(event.type)) &&
    (entry.runOn === 'local' || event.workspaceId === workspaceId)
  );
}

/**
 * Calls `run` again every `intervalSeconds` while the window can be seen, and once it shows again
 * after it was due, unless `busy`. Counts from when `key` last changed or `run` was last called.
 * The events `refreshOn` names in the workspace run it again too, once they settle, and at once
 * the window shows again if it was hidden then.
 */
export function useRunWhileVisible({
  key,
  intervalSeconds,
  busy,
  run,
  enabled = true,
  refreshOn,
  workspaceId,
  runOn,
}: {
  key: string;
  intervalSeconds: number;
  busy: boolean;
  run: () => void;
  enabled?: boolean;
  refreshOn?: KomlaEventType[];
  workspaceId?: string;
  runOn?: 'local';
}) {
  const runIfDue = useEffectEvent((lastRun: { at: number; wanted: boolean }) => {
    if (document.visibilityState === 'hidden' || busy) return;
    if (!lastRun.wanted && Date.now() - lastRun.at < intervalSeconds * 1000) return;
    lastRun.at = Date.now();
    lastRun.wanted = false;
    run();
  });
  const matches = useEffectEvent(
    (event: KomlaEvent) =>
      workspaceId !== undefined && refreshesOn(event, { refreshOn, runOn }, workspaceId)
  );
  const events = refreshOn?.join(',') ?? '';
  useEffect(() => {
    if (!enabled) return;
    const lastRun = { at: Date.now(), wanted: false };
    const check = () => runIfDue(lastRun);
    const timer = setInterval(check, 1000);
    document.addEventListener('visibilitychange', check);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const stopFollowing = events
      ? window.api.onKomlaEvent((event) => {
          if (!matches(event)) return;
          clearTimeout(settle);
          settle = setTimeout(() => {
            lastRun.wanted = true;
            check();
          }, REFRESH_ON_SETTLE_MS);
        })
      : undefined;
    return () => {
      clearInterval(timer);
      clearTimeout(settle);
      stopFollowing?.();
      document.removeEventListener('visibilitychange', check);
    };
  }, [key, enabled, events]);
}
