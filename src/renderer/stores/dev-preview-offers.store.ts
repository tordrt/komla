import { create } from 'zustand';

import {
  equivalentLoopbackUrlKey,
  normalizeLocalDevServerUrl,
} from '../../shared/lib/loopback-url';

import type { WorkspaceVirtualDesktop } from '../../shared/types';
import type { TerminalExecutionLocation } from '../../shared/types/terminal';

/** The page an agent last offered in a workspace with `komla preview`. */
export interface DevPreviewOffer {
  url: string;
  executionLocation: TerminalExecutionLocation;
}

/** Where a page an agent offers opens: in the default browser, or in Komla's. */
export type PageOfferTarget = 'external' | 'preview';
/**
 * Where a virtual desktop opens: in the VNC app, or in Komla's browser. Never the default
 * browser, which would keep its page's address, password included, in its history.
 */
export type DesktopOfferTarget = 'vnc-app' | 'preview';

/** What a workspace asks the user where to open: a page from `komla preview`, or a desktop. */
export type BrowserOffer =
  | { kind: 'page'; page: DevPreviewOffer }
  | { kind: 'desktop'; desktop: WorkspaceVirtualDesktop };

/** A desktop an agent chose where to open, as `--app` does, before the workspace showed. */
export interface HeldDesktop {
  desktop: WorkspaceVirtualDesktop;
  opensIn: DesktopOfferTarget;
}

interface DevPreviewOffersState {
  /** Each workspace's latest page offer, which its globe button's list keeps among its servers. */
  offers: Record<string, DevPreviewOffer>;
  /**
   * What each workspace waits to ask where to open, marked by a dot on its globe button and its
   * sidebar card. A later offer replaces an earlier one, as an agent restarting its server does.
   */
  pending: Record<string, BrowserOffer>;
  /**
   * Desktops that open where the agent chose once their workspace shows, kept apart from
   * `pending` so a later offer doesn't drop what the agent was told would happen.
   */
  held: Record<string, HeldDesktop>;
  offer: (workspaceId: string, offer: BrowserOffer) => void;
  hold: (workspaceId: string, held: HeldDesktop) => void;
  /** Stops asking about the workspace's offer: the user answered it, or looked in the list. */
  settle: (workspaceId: string) => void;
  /** Lets go of the workspace's held desktop, once it opens or stops. */
  release: (workspaceId: string) => void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useDevPreviewOffersStore = create<DevPreviewOffersState>((set) => ({
  offers: {},
  pending: {},
  held: {},
  offer: (workspaceId, offer) =>
    set((state) => ({
      offers: offer.kind === 'page' ? { ...state.offers, [workspaceId]: offer.page } : state.offers,
      pending: { ...state.pending, [workspaceId]: offer },
    })),
  hold: (workspaceId, held) => set((state) => ({ held: { ...state.held, [workspaceId]: held } })),
  settle: (workspaceId) =>
    set((state) =>
      state.pending[workspaceId] ? { pending: without(state.pending, workspaceId) } : state
    ),
  release: (workspaceId) =>
    set((state) => (state.held[workspaceId] ? { held: without(state.held, workspaceId) } : state)),
}));

/** What waits in the workspace to be opened, which its globe button and sidebar card mark. */
export function selectWaitingOfferKind(
  state: DevPreviewOffersState,
  workspaceId: string
): BrowserOffer['kind'] | undefined {
  return state.pending[workspaceId]?.kind ?? (state.held[workspaceId] ? 'desktop' : undefined);
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
 * link or an agent's `komla preview --open`, or once its desktop's page does.
 */
export function settleDevPreviewOffer(workspaceId: string, openedUrl: string): void {
  const { pending, settle } = useDevPreviewOffersStore.getState();
  const offer = pending[workspaceId];
  const offeredUrl = offer?.kind === 'page' ? offer.page.url : offer?.desktop.url;
  if (offeredUrl === undefined || pageKey(offeredUrl) !== pageKey(openedUrl)) return;
  settle(workspaceId);
}

/** Settles the workspace's offer, or its held desktop, on `vncPort`, once it opens or stops. */
export function settleVirtualDesktopOffer(workspaceId: string, vncPort: number): void {
  const { pending, held, settle, release } = useDevPreviewOffersStore.getState();
  const offer = pending[workspaceId];
  if (offer?.kind === 'desktop' && offer.desktop.vncPort === vncPort) settle(workspaceId);
  if (held[workspaceId]?.desktop.vncPort === vncPort) release(workspaceId);
}

/** Where a project's offers open without asking, as the user chose with Remember. */
export interface RememberedOfferTargets {
  page?: PageOfferTarget;
  desktop?: DesktopOfferTarget;
}

const REMEMBERED_STORAGE_KEY = 'komla:browser-offer-targets';

function readRemembered(): Record<string, RememberedOfferTargets> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(REMEMBERED_STORAGE_KEY) ?? '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, RememberedOfferTargets>)
      : {};
  } catch {
    return {};
  }
}

function storeRemembered(remembered: Record<string, RememberedOfferTargets>): void {
  try {
    window.localStorage.setItem(REMEMBERED_STORAGE_KEY, JSON.stringify(remembered));
  } catch {
    // Without storage the choice lasts until a restart.
  }
}

interface RememberedOfferTargetsState {
  /** By `offerScopeKey`: the project, or a workspace that has none. */
  byScope: Record<string, RememberedOfferTargets>;
  /** A target the offer kind can't open is ignored when read back, as a hand-edited one is. */
  remember: (
    scope: string,
    kind: keyof RememberedOfferTargets,
    target: PageOfferTarget | DesktopOfferTarget
  ) => void;
  forget: (scope: string, kind: keyof RememberedOfferTargets) => void;
}

export const useRememberedOfferTargetsStore = create<RememberedOfferTargetsState>((set) => ({
  byScope: readRemembered(),
  remember: (scope, kind, target) =>
    set((state) => {
      const byScope = {
        ...state.byScope,
        [scope]: { ...state.byScope[scope], [kind]: target },
      };
      storeRemembered(byScope);
      return { byScope };
    }),
  forget: (scope, kind) =>
    set((state) => {
      const { [kind]: _forgotten, ...rest } = state.byScope[scope] ?? {};
      const { [scope]: _scope, ...others } = state.byScope;
      const byScope = Object.keys(rest).length > 0 ? { ...others, [scope]: rest } : others;
      storeRemembered(byScope);
      return { byScope };
    }),
}));

// Another window's choice applies here too; `storage` fires only in the windows that didn't make it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === REMEMBERED_STORAGE_KEY || event.key === null) {
      useRememberedOfferTargetsStore.setState({ byScope: readRemembered() });
    }
  });
}

/**
 * The scope of the workspace's remembered choices, from the workspaces store's state; undefined
 * until the workspace is known.
 */
export function selectOfferScope(
  state: { workspaces: Array<{ id: string; projectId: string | null }> },
  workspaceId: string
): string | undefined {
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  return workspace ? offerScopeKey(workspace) : undefined;
}

/** What a remembered choice applies to: the workspace's project, or the workspace without one. */
export function offerScopeKey(workspace: { id: string; projectId: string | null }): string {
  return workspace.projectId ? `project:${workspace.projectId}` : `workspace:${workspace.id}`;
}
