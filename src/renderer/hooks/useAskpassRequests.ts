import { useCallback, useEffect, useState } from 'react';

import { useToastStore } from '@/stores/toast.store';

import type { AskpassRequest } from '../../shared/types';

/**
 * SSH passphrase and host prompts from Komla, shown one at a time in the order they
 * arrived, so a new prompt never hides one that is still waiting.
 */
export function useAskpassRequests(): {
  request: AskpassRequest | null;
  respond: (id: string, passphrase: string | null, remember?: boolean) => void;
} {
  const [queue, setQueue] = useState<AskpassRequest[]>([]);

  useEffect(() => {
    const unsubscribes = [
      window.api.onAskpassRequest((request) => {
        setQueue((current) => [...current, request]);
      }),
      // Komla ended the request: answered, timed out, or every ssh asking for it exited
      window.api.onAskpassEnded((id) => {
        setQueue((current) => current.filter((request) => request.id !== id));
      }),
      window.api.onAskpassNotRemembered((keyPath) => {
        useToastStore
          .getState()
          .addToast(
            `Komla couldn't confirm the passphrase for ${keyPath}, so it won't remember it.`,
            'error'
          );
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);

  const respond = useCallback((id: string, passphrase: string | null, remember?: boolean) => {
    window.api.sendAskpassResponse(id, passphrase, remember);
    setQueue((current) => current.filter((request) => request.id !== id));
  }, []);

  return { request: queue[0] ?? null, respond };
}
