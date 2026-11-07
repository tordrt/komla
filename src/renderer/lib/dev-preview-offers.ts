import { openTerminalUrl } from '@/lib/open-terminal-url';
import { notePrintedHyperlink } from '@/lib/recent-links';
import { openVirtualDesktop } from '@/lib/virtual-desktops';
import {
  selectOfferScope,
  useRememberedOfferTargetsStore,
  settleVirtualDesktopOffer,
  useDevPreviewOffersStore,
  type BrowserOffer,
  type DesktopOfferTarget,
  type PageOfferTarget,
  type RememberedOfferTargets,
} from '@/stores/dev-preview-offers.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { Workspace, WorkspaceVirtualDesktop } from '../../shared/types';
import type { TerminalExecutionLocation } from '../../shared/types/terminal';

export type BrowserOfferTarget = PageOfferTarget | DesktopOfferTarget;

/** Where each target opens, as "Previews open in …" names it. */
export const BROWSER_OFFER_PLACES: Record<BrowserOfferTarget, string> = {
  external: 'your browser',
  preview: 'Komla',
  'vnc-app': 'the VNC app',
};

/**
 * Whether the user is looking at the workspace in this window: it's selected, not under the
 * overview, and the window isn't hidden or minimized.
 */
export function isWorkspaceOnScreen(workspaceId: string): boolean {
  const { selectedWorkspaceId, showDashboard } = useWorkspacesStore.getState();
  return (
    !showDashboard && selectedWorkspaceId === workspaceId && document.visibilityState !== 'hidden'
  );
}

/** Where the offer can open, in the order its buttons show. */
export function browserOfferTargets(offer: BrowserOffer): BrowserOfferTarget[] {
  if (offer.kind === 'page') return ['external', 'preview'];
  const targets: DesktopOfferTarget[] = [];
  if (offer.desktop.vncApp) targets.push('vnc-app');
  if (offer.desktop.url) targets.push('preview');
  return targets;
}

/** Where the offer opens without asking, as its project remembers. */
export function chosenBrowserOfferTarget(
  offer: BrowserOffer,
  remembered: RememberedOfferTargets | undefined
): BrowserOfferTarget | undefined {
  const target = offer.kind === 'page' ? remembered?.page : remembered?.desktop;
  // A desktop remembered for the VNC app asks again on a computer without one.
  return target && browserOfferTargets(offer).includes(target) ? target : undefined;
}

/** The workspace's remembered choices; none until its workspace is known. */
function rememberedFor(workspaceId: string): RememberedOfferTargets | undefined {
  const scope = selectOfferScope(useWorkspacesStore.getState(), workspaceId);
  return scope ? useRememberedOfferTargetsStore.getState().byScope[scope] : undefined;
}

function open(workspaceId: string, offer: BrowserOffer, target: BrowserOfferTarget): void {
  const { settle } = useDevPreviewOffersStore.getState();
  if (offer.kind === 'page') {
    settle(workspaceId);
    openTerminalUrl(offer.page.url, target as PageOfferTarget, {
      workspaceId,
      executionLocation: offer.page.executionLocation,
    });
    return;
  }
  // Settled as it opens.
  openVirtualDesktop(workspaceId, offer.desktop, target as DesktopOfferTarget);
}

/**
 * Opens the workspace's offer where the user picked, and with `remember`, opens the project's
 * later offers of its kind there without asking.
 */
export function openBrowserOffer(
  workspaceId: string,
  target: BrowserOfferTarget,
  { remember = false }: { remember?: boolean } = {}
): void {
  const offer = useDevPreviewOffersStore.getState().pending[workspaceId];
  if (!offer) return;
  // Opened, and so settled, before remembering, which would open the offer again where it's chosen.
  open(workspaceId, offer, target);
  const scope = selectOfferScope(useWorkspacesStore.getState(), workspaceId);
  if (remember && scope) {
    useRememberedOfferTargetsStore.getState().remember(scope, offer.kind, target);
  }
}

/**
 * Opens what the workspace holds where the agent chose, and its offer where its project
 * remembers, if the user is looking at the workspace.
 */
function openChosenOffer(workspaceId: string): void {
  if (!isWorkspaceOnScreen(workspaceId)) return;
  const heldDesktop = useDevPreviewOffersStore.getState().held[workspaceId];
  // Released as it opens, with an offer of the same desktop.
  if (heldDesktop) openVirtualDesktop(workspaceId, heldDesktop.desktop, heldDesktop.opensIn);
  const offer = useDevPreviewOffersStore.getState().pending[workspaceId];
  const target = offer && chosenBrowserOfferTarget(offer, rememberedFor(workspaceId));
  if (offer && target) open(workspaceId, offer, target);
}

/**
 * Offers a page an agent previewed with `komla preview`, without opening it: the workspace asks
 * where to open it, in the default browser, through a tunnel from an SSH host, or in Komla's
 * browser, once it's on screen, and its globe button and sidebar card show a dot until then. A
 * project the user said to remember for opens it there instead, once the workspace is on screen.
 */
export function offerDevPreview(
  workspaceId: string,
  url: string,
  executionLocation: TerminalExecutionLocation | undefined
): void {
  // A page on another site lists with the links; the globe button's list keeps one on this
  // computer, or the workspace's machine, among its servers.
  notePrintedHyperlink(workspaceId, url);
  useDevPreviewOffersStore.getState().offer(workspaceId, {
    kind: 'page',
    page: { url, executionLocation: executionLocation ?? 'workspace' },
  });
  openChosenOffer(workspaceId);
}

/**
 * Offers a desktop `komla desktop run` started, as `offerDevPreview` does a page: in the VNC app
 * or Komla's browser. With `opensIn`, as for `--app` while no window showed the workspace, it
 * holds the desktop to open there once the workspace is on screen, whatever it offers meanwhile.
 */
export function offerVirtualDesktop(
  workspaceId: string,
  desktop: WorkspaceVirtualDesktop,
  opensIn?: DesktopOfferTarget
): void {
  if (opensIn) useDevPreviewOffersStore.getState().hold(workspaceId, { desktop, opensIn });
  else useDevPreviewOffersStore.getState().offer(workspaceId, { kind: 'desktop', desktop });
  openChosenOffer(workspaceId);
}

/** Lets go of offers of the desktops that left their workspace's list, as a stopped one does. */
function forgetStoppedDesktops(workspaces: Workspace[], previous: Workspace[]): void {
  const { pending, held } = useDevPreviewOffersStore.getState();
  const waiting = (id: string) => pending[id]?.kind === 'desktop' || held[id] !== undefined;
  for (const before of previous) {
    if (!before.virtualDesktops?.length || !waiting(before.id)) continue;
    const now = workspaces.find((w) => w.id === before.id);
    if (now?.virtualDesktops === before.virtualDesktops) continue;
    const running = new Set(now?.virtualDesktops?.map((desktop) => desktop.vncPort));
    for (const desktop of before.virtualDesktops) {
      if (!running.has(desktop.vncPort)) settleVirtualDesktopOffer(before.id, desktop.vncPort);
    }
  }
}

/**
 * Keeps offers current: opens one whose place was chosen once the user comes to its workspace,
 * on selecting it, coming back to the window or a choice remembered in any window, and forgets
 * those of desktops that stopped. Returns a function that stops.
 */
export function followBrowserOffers(): () => void {
  const openShown = () => {
    const { selectedWorkspaceId } = useWorkspacesStore.getState();
    if (selectedWorkspaceId) openChosenOffer(selectedWorkspaceId);
  };
  const unsubscribeWorkspaces = useWorkspacesStore.subscribe((state, previous) => {
    const workspacesChanged = state.workspaces !== previous.workspaces;
    if (workspacesChanged) forgetStoppedDesktops(state.workspaces, previous.workspaces);
    // The workspaces' arrival too, as an offer can come before them.
    if (
      workspacesChanged ||
      state.selectedWorkspaceId !== previous.selectedWorkspaceId ||
      state.showDashboard !== previous.showDashboard
    ) {
      openShown();
    }
  });
  const unsubscribeRemembered = useRememberedOfferTargetsStore.subscribe(openShown);
  document.addEventListener('visibilitychange', openShown);
  return () => {
    unsubscribeWorkspaces();
    unsubscribeRemembered();
    document.removeEventListener('visibilitychange', openShown);
  };
}
