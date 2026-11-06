import { useConfigStore } from '@/stores/config.store';

/** Whether the user disconnected from the SSH host, which Komla then leaves alone. */
export function isSshHostDisconnected(hostId: string | undefined): boolean {
  if (!hostId) return false;
  return useConfigStore.getState().config?.disconnectedSshHostIds?.includes(hostId) ?? false;
}

/** Whether the user disconnected from the SSH host, kept current while mounted. */
export function useSshHostDisconnected(hostId: string | undefined): boolean {
  return useConfigStore(
    (state) => !!hostId && (state.config?.disconnectedSshHostIds?.includes(hostId) ?? false)
  );
}
