import { X } from '@phosphor-icons/react';
import { useId, useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { IconButton } from '@/components/ui/icon-button';
import {
  BROWSER_OFFER_PLACES,
  browserOfferTargets,
  chosenBrowserOfferTarget,
  openBrowserOffer,
  type BrowserOfferTarget,
} from '@/lib/dev-preview-offers';
import {
  selectOfferScope,
  useDevPreviewOffersStore,
  useRememberedOfferTargetsStore,
  type BrowserOffer,
} from '@/stores/dev-preview-offers.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { virtualDesktopAppName, virtualDesktopDisplay } from '../../../shared/lib/virtual-desktops';

/** `localhost:5173/pricing` for `http://localhost:5173/pricing`. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function targetLabel(offer: BrowserOffer, target: BrowserOfferTarget): string {
  if (target === 'external') return 'Open in browser';
  if (target === 'vnc-app' && offer.kind === 'desktop' && offer.desktop.vncApp) {
    return `Open in ${offer.desktop.vncApp}`;
  }
  return `Open in ${BROWSER_OFFER_PLACES[target]}`;
}

// Each offer the store hands out is a new object, so a repeat of the same page asks afresh.
const offerIds = new WeakMap<BrowserOffer, number>();
let lastOfferId = 0;

function offerId(offer: BrowserOffer): number {
  let id = offerIds.get(offer);
  if (id === undefined) {
    id = ++lastOfferId;
    offerIds.set(offer, id);
  }
  return id;
}

interface CalloutPosition {
  top: number;
  right: number;
}

/**
 * Where the callout hangs: under the anchor, lined up with its right edge. Read each frame while
 * it shows, as banners, panels and the tab row can move the globe without resizing the window.
 */
function useAnchorPosition(
  anchorRef: RefObject<HTMLElement | null>,
  active: boolean
): CalloutPosition | null {
  const [position, setPosition] = useState<CalloutPosition | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      const next =
        rect && rect.width > 0
          ? { top: rect.bottom + 6, right: document.documentElement.clientWidth - rect.right }
          : null;
      setPosition((current) =>
        current?.top === next?.top && current?.right === next?.right ? current : next
      );
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [active, anchorRef]);
  return active ? position : null;
}

/**
 * Asks where to open what an agent offered in the workspace, a page from `komla preview` or a
 * desktop from `komla desktop run`, hanging from the globe button that lists it afterwards. It
 * shows only in its own workspace, and never takes focus or closes on its own, so typing to the
 * agent goes on undisturbed: only a choice or its close button ends it. Remember opens the
 * project's later offers of the kind there without asking.
 */
export function BrowserOfferCallout({
  workspaceId,
  anchorRef,
  hidden,
}: {
  workspaceId: string;
  anchorRef: RefObject<HTMLElement | null>;
  /** While the globe's list is open, which shows the offer itself. */
  hidden: boolean;
}) {
  const offer = useDevPreviewOffersStore((s) => s.pending[workspaceId]);
  const scope = useWorkspacesStore((s) => selectOfferScope(s, workspaceId));
  const remembered = useRememberedOfferTargetsStore((s) => (scope ? s.byScope[scope] : undefined));
  // An offer whose place its project remembers opens by itself.
  const asks =
    !!offer && !hidden && scope !== undefined && !chosenBrowserOfferTarget(offer, remembered);
  const position = useAnchorPosition(anchorRef, asks);
  if (!offer || !asks || !position || !scope) return null;
  return createPortal(
    <CalloutBody
      key={`${workspaceId}:${offerId(offer)}`}
      workspaceId={workspaceId}
      offer={offer}
      inProject={scope.startsWith('project:')}
      position={position}
    />,
    document.body
  );
}

function CalloutBody({
  workspaceId,
  offer,
  inProject,
  position,
}: {
  workspaceId: string;
  offer: BrowserOffer;
  inProject: boolean;
  position: CalloutPosition;
}) {
  const [remember, setRemember] = useState(false);
  const titleId = useId();
  const title =
    offer.kind === 'page'
      ? 'Preview ready'
      : `${virtualDesktopAppName(offer.desktop) ?? 'An app'} is running`;
  const detail =
    offer.kind === 'page'
      ? shortUrl(offer.page.url)
      : `on virtual desktop ${virtualDesktopDisplay(offer.desktop)}`;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-native-overlay="browser-offer"
      data-browser-offer={offer.kind}
      className="floating-surface fixed z-50 w-72 rounded-[calc(var(--radius)+2px)] border p-3 text-popover-foreground shadow-xl animate-in fade-in-0"
      style={{ top: position.top, right: position.right }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-sm font-medium">
            {title}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={detail}>
            {detail}
          </p>
        </div>
        <IconButton
          label="Dismiss"
          className="-mt-1 -mr-1 size-6 shrink-0 rounded-md"
          onClick={() => useDevPreviewOffersStore.getState().settle(workspaceId)}
        >
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {browserOfferTargets(offer).map((target, index) => (
          <Button
            key={target}
            size="sm"
            variant={index === 0 ? 'default' : 'secondary'}
            onClick={() => openBrowserOffer(workspaceId, target, { remember })}
          >
            {targetLabel(offer, target)}
          </Button>
        ))}
      </div>
      <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        Remember for this {inProject ? 'project' : 'workspace'}
      </label>
    </div>
  );
}
