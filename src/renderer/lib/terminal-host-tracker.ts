import { useSyncExternalStore } from 'react';

import type { TerminalHostInfo } from '../../shared/types/terminal';

const hosts = new Map<string, TerminalHostInfo>();
const listeners = new Map<string, Set<() => void>>();
let subscribed = false;

function notify(terminalId: string): void {
  const set = listeners.get(terminalId);
  if (set) for (const fn of set) fn();
}

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  window.api.onTerminalHostChanged((terminalId, hostname, isLocal) => {
    hosts.set(terminalId, { hostname, isLocal });
    notify(terminalId);
  });
}

export function clearTerminalHost(terminalId: string): void {
  if (hosts.delete(terminalId)) notify(terminalId);
}

/** Restore host state when a terminal view attaches after the live event fired. */
export function hydrateTerminalHost(terminalId: string, hostInfo: TerminalHostInfo): void {
  // A live event received after the snapshot was requested is newer and wins.
  if (hosts.has(terminalId)) return;
  hosts.set(terminalId, hostInfo);
  notify(terminalId);
}

export function useTerminalHost(terminalId: string): TerminalHostInfo | null {
  ensureSubscription();
  return useSyncExternalStore(
    (fn) => {
      let set = listeners.get(terminalId);
      if (!set) {
        set = new Set();
        listeners.set(terminalId, set);
      }
      const listenerSet = set;
      listenerSet.add(fn);
      return () => {
        listenerSet.delete(fn);
        if (listenerSet.size === 0) listeners.delete(terminalId);
      };
    },
    () => hosts.get(terminalId) ?? null,
    () => null
  );
}
