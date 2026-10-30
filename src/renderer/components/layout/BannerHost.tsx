import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { BannerPager } from '@/components/ui/banner';

import type { PropsWithChildren, ReactNode } from 'react';

/** Lower numbers win. Only the winning banner shows; the rest wait behind a pager. */
export const BANNER_PRIORITY = {
  update: 0,
  portChanged: 1,
  integrationUpdate: 2,
  usageConsent: 3,
  announcement: 4,
  aiHelpersOff: 5,
} as const;

interface BannerSlot {
  id: string;
  priority: number;
  /** Tie-breaker within one priority, e.g. an announcement's position in its list. */
  order: number;
}

interface BannerHostContextValue {
  register: (slot: BannerSlot) => void;
  unregister: (id: string) => void;
  visibleId: string | null;
  pager: ReactNode;
}

const BannerHostContext = createContext<BannerHostContextValue | null>(null);

// Whether a host shows a banner, for things outside it that shouldn't open on top of one.
let hostsShowingBanners = 0;
const showingListeners = new Set<() => void>();

function subscribeShowing(listener: () => void): () => void {
  showingListeners.add(listener);
  return () => showingListeners.delete(listener);
}

/** Whether any banner is showing, such as the usage analytics question. */
export function useAnyBannerShowing(): boolean {
  return useSyncExternalStore(subscribeShowing, () => hostsShowingBanners > 0);
}

function compareSlots(a: BannerSlot, b: BannerSlot): number {
  return a.priority - b.priority || a.order - b.order || a.id.localeCompare(b.id);
}

/**
 * Shows at most one of its banners at a time: the highest-priority active one, or the
 * one the user paged to. Banners join with `useBannerSlot`.
 */
export function BannerHost({ children }: PropsWithChildren) {
  const [slots, setSlots] = useState<BannerSlot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const register = useCallback((slot: BannerSlot) => {
    setSlots((prev) => [...prev.filter((s) => s.id !== slot.id), slot]);
  }, []);
  const unregister = useCallback((id: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const ordered = useMemo(() => [...slots].sort(compareSlots), [slots]);
  // A dismissed selection falls back to the highest-priority banner.
  const visibleIndex = Math.max(
    0,
    ordered.findIndex((slot) => slot.id === selectedId)
  );
  const visibleId = ordered[visibleIndex]?.id ?? null;
  const count = ordered.length;

  const showing = count > 0;
  useLayoutEffect(() => {
    if (!showing) return;
    hostsShowingBanners += 1;
    for (const listener of showingListeners) listener();
    return () => {
      hostsShowingBanners -= 1;
      for (const listener of showingListeners) listener();
    };
  }, [showing]);

  const pager = useMemo(
    () =>
      count > 1 ? (
        <BannerPager
          index={visibleIndex}
          count={count}
          onPrevious={() => setSelectedId(ordered[(visibleIndex - 1 + count) % count].id)}
          onNext={() => setSelectedId(ordered[(visibleIndex + 1) % count].id)}
        />
      ) : null,
    [ordered, visibleIndex, count]
  );

  const value = useMemo(
    () => ({ register, unregister, visibleId, pager }),
    [register, unregister, visibleId, pager]
  );

  return <BannerHostContext.Provider value={value}>{children}</BannerHostContext.Provider>;
}

/**
 * Joins the nearest `BannerHost` while `active`. Returns whether this banner is the one
 * to show, and the pager to pass to its `Banner`. Outside a host it always shows.
 */
export function useBannerSlot(
  id: string,
  priority: number,
  active: boolean,
  order = 0
): { visible: boolean; pager: ReactNode } {
  const host = useContext(BannerHostContext);
  const register = host?.register;
  const unregister = host?.unregister;

  // Layout effect so a newly active banner shows in the same frame.
  useLayoutEffect(() => {
    if (!active || !register || !unregister) return;
    register({ id, priority, order });
    return () => unregister(id);
  }, [active, id, priority, order, register, unregister]);

  if (!host) return { visible: active, pager: null };
  const visible = active && host.visibleId === id;
  return { visible, pager: visible ? host.pager : null };
}
