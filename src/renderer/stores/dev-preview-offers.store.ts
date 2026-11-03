import { create } from 'zustand';

import {
  equivalentLoopbackUrlKey,
  normalizeLocalDevServerUrl,
} from '../../shared/lib/loopback-url';

import { useToastStore } from './toast.store';

import type { TerminalExecutionLocation } from '../../shared/types/terminal';

/** The page an agent last offered in a workspace with `komla preview`. */
export interface DevPreviewOffer {
  url: string;
  executionLocation: TerminalExecutionLocation;
}

interface DevPreviewOffersState {
  /** Each workspace's latest offer, which its globe button's list keeps among its servers. */
  offers: Record<string, DevPreviewOffer>;
  /** Workspaces whose latest offer the user hasn't looked at yet, marked by a dot. */
  unseen: Record<string, true>;
  offer: (workspaceId: string, offer: DevPreviewOffer) => void;
  markSeen: (workspaceId: string) => void;
}

export const useDevPreviewOffersStore = create<DevPreviewOffersState>((set) => ({
  offers: {},
  unseen: {},
  offer: (workspaceId, offer) =>
    set((state) => ({
      offers: { ...state.offers, [workspaceId]: offer },
      unseen: state.unseen[workspaceId] ? state.unseen : { ...state.unseen, [workspaceId]: true },
    })),
  markSeen: (workspaceId) =>
    set((state) => {
      if (!state.unseen[workspaceId]) return state;
      const { [workspaceId]: _seen, ...unseen } = state.unseen;
      return { unseen };
    }),
}));

/** The key of the toast that offers the workspace's page, which a later offer replaces. */
export function devPreviewOfferToastKey(workspaceId: string): string {
  return `dev-preview-offer:${workspaceId}`;
}

/** One spelling for a page, whether given as 0.0.0.0, 127.0.0.1 or localhost, slash or not. */
function pageKey(url: string): string {
  try {
    return equivalentLoopbackUrlKey(new URL(normalizeLocalDevServerUrl(url)).toString());
  } catch {
    return url;
  }
}

/**
 * Settles the workspace's offer once its page opens, from the globe button's list, a terminal's
 * link or an agent's `komla preview --open`: the dot and the toast go, as the page shows.
 */
export function settleDevPreviewOffer(workspaceId: string, openedUrl: string): void {
  const { offers, markSeen } = useDevPreviewOffersStore.getState();
  const offer = offers[workspaceId];
  if (!offer || pageKey(offer.url) !== pageKey(openedUrl)) return;
  markSeen(workspaceId);
  useToastStore.getState().removeToastWithKey(devPreviewOfferToastKey(workspaceId));
}
