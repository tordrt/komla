import { Globe } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LIVE_REFRESH_MS } from '@/hooks/useDevPreviewServices';
import { BROWSER_OFFER_PLACES } from '@/lib/dev-preview-offers';
import { openTerminalUrl } from '@/lib/open-terminal-url';
import { openFilePane } from '@/lib/pane-surfaces';
import { openVirtualDesktop } from '@/lib/virtual-desktops';
import {
  selectOfferScope,
  selectWaitingOfferKind,
  useDevPreviewOffersStore,
  useRememberedOfferTargetsStore,
  type BrowserOffer,
} from '@/stores/dev-preview-offers.store';
import { useQuickLookStore } from '@/stores/quick-look.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { getViewableFileKind } from '../../../shared/image-utils';

import { BrowserLinksList, prepareBrowserLinks, type BrowserLinkPick } from './BrowserLinksList';
import { BrowserOfferCallout } from './BrowserOfferCallout';
import {
  openTerminalFile,
  rememberTerminalFiles,
  terminalFileViewerItem,
  useTerminalFiles,
} from './terminal-files';

import type { OpenInTarget } from './OpenInPaneMenu';
import type { TerminalFile } from '@/stores/terminal-files.store';

// Pages, then Markdown, then pictures: what an agent most often makes for you to look at.
const FILE_KIND_RANK: Partial<Record<string, number>> = { html: 0, markdown: 1, image: 2, svg: 2 };

function fileKindRank(file: TerminalFile): number {
  return FILE_KIND_RANK[getViewableFileKind(file.path) ?? ''] ?? 3;
}

/** What the globe button's `aria-describedby` names: the hint its icon shows with the dot. */
const BROWSER_LINKS_OFFER_HINT_ID = 'browser-links-offer-hint';

/** What an agent offered in the workspace that waits to be opened, if anything. */
function useWaitingOfferKind(workspaceId: string): BrowserOffer['kind'] | undefined {
  return useDevPreviewOffersStore((s) => selectWaitingOfferKind(s, workspaceId));
}

/** The globe button's icon, with a dot while what an agent offered waits to be opened. */
export function BrowserLinksButtonIcon({ workspaceId }: { workspaceId: string }) {
  const offered = useWaitingOfferKind(workspaceId);
  return (
    <span className="relative flex">
      <Globe className="size-3.5" />
      {offered !== undefined && (
        <>
          <span
            aria-hidden="true"
            data-offer-dot
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
          />
          <span id={BROWSER_LINKS_OFFER_HINT_ID} className="sr-only">
            {offered === 'page' ? 'An agent offered a page' : 'An agent started a desktop'}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * The globe button's list: the workspace's servers, then its virtual desktops from
 * `komla desktop run`, which open in this computer's VNC app where it has one, then the links its terminals
 * printed or you opened, which open in the default browser (Shift: in Komla's browser;
 * right-click: in a new tab or split), then their files, which open as clicking their
 * links would. A server on an SSH host is
 * forwarded to this computer first. The terminals' files and links, the running servers
 * and desktops, and the pages' titles are read once the pointer or focus reaches the
 * button, so the list is ready by the click. The arrow keys and Enter pick a row.
 */
export function BrowserLinksPopover({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const openInViewer = useQuickLookStore((s) => s.open);
  const fileGroups = useTerminalFiles(workspaceId);
  // Each kind keeps the opened files first, then the latest.
  const files = useMemo(
    () =>
      [...fileGroups.opened, ...fileGroups.mentioned].sort(
        (a, b) => fileKindRank(a) - fileKindRank(b)
      ),
    [fileGroups]
  );
  const remember = () => rememberTerminalFiles(workspaceId);
  // An offer shows in the list, so opening it, or an offer that comes while it's open, answers it.
  const asked = useDevPreviewOffersStore((s) => s.pending[workspaceId] !== undefined);
  useEffect(() => {
    if (open && asked) useDevPreviewOffersStore.getState().settle(workspaceId);
  }, [asked, open, workspaceId]);
  // The icon's hint names a held desktop too.
  const offered = useWaitingOfferKind(workspaceId) !== undefined;
  const anchorRef = useRef<HTMLButtonElement>(null);
  // Set while the list hands focus back to the button on closing.
  const closing = useRef(false);
  const preparedAt = useRef(-Infinity);
  const prepare = () => {
    if (open || closing.current) return;
    remember();
    // Once per approach: the hover and the click's focus, or the window's on coming back,
    // read the same. A failed check is tried again on the next.
    if (Date.now() - preparedAt.current < LIVE_REFRESH_MS) return;
    const at = Date.now();
    preparedAt.current = at;
    void prepareBrowserLinks(workspaceId).then((checked) => {
      if (!checked && preparedAt.current === at) preparedAt.current = -Infinity;
    });
  };

  const openPick = (picked: BrowserLinkPick, target: OpenInTarget) => {
    setOpen(false);
    const url = picked.kind === 'server' ? picked.candidate.url : picked.link.url;
    openTerminalUrl(url, target, {
      workspaceId,
      executionLocation: picked.kind === 'server' ? picked.candidate.executionLocation : undefined,
    });
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) remember();
          setOpen(next);
        }}
      >
        <PopoverTrigger
          ref={anchorRef}
          asChild
          onPointerEnter={prepare}
          onFocus={prepare}
          aria-describedby={offered ? BROWSER_LINKS_OFFER_HINT_ID : undefined}
        >
          {children}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-96 flex-col p-0"
          onCloseAutoFocus={() => {
            // The button takes focus right after this, unless the click landed elsewhere.
            closing.current = true;
            queueMicrotask(() => (closing.current = false));
          }}
          onOpenAutoFocus={(event) => {
            // The list takes focus, so the arrow keys move through its rows from the first.
            event.preventDefault();
            listRef.current?.focus();
          }}
        >
          <BrowserLinksList
            workspaceId={workspaceId}
            onPick={(picked, { shiftKey }) => openPick(picked, shiftKey ? 'preview' : 'external')}
            onPickIn={openPick}
            opensExternally
            emptyText="No running servers, links or files yet."
            desktops={{
              onOpen: (desktop, target) => {
                setOpen(false);
                openVirtualDesktop(workspaceId, desktop, target);
              },
            }}
            files={{
              files,
              onPick: (file) => {
                setOpen(false);
                openTerminalFile(file);
              },
              onOpenAll: () => {
                setOpen(false);
                openInViewer(workspaceId, terminalFileViewerItem(files[0]));
              },
              onOpenInPane: (file, placement) => {
                if (file.target.type !== 'workspace') return;
                setOpen(false);
                openFilePane(workspaceId, file.target.filePath, placement, file.lineNumber);
              },
            }}
            listRef={listRef}
            className="flex-1"
          />
          <RememberedOfferTargets workspaceId={workspaceId} />
          <div className="shrink-0 border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">
            {formatShortcutForDisplay('Shift+Click', window.api.platform)} opens in Komla ·
            Right-click for a new tab or split
          </div>
        </PopoverContent>
      </Popover>
      <BrowserOfferCallout workspaceId={workspaceId} anchorRef={anchorRef} hidden={open} />
    </>
  );
}

/**
 * Where the workspace's project opens agents' offers without asking, as the user chose with
 * Remember, each with a way to be asked again.
 */
function RememberedOfferTargets({ workspaceId }: { workspaceId: string }) {
  const scope = useWorkspacesStore((s) => selectOfferScope(s, workspaceId));
  const remembered = useRememberedOfferTargetsStore((s) => (scope ? s.byScope[scope] : undefined));
  if (!scope || !remembered) return null;
  const rows = (['page', 'desktop'] as const).flatMap((kind) => {
    const target = remembered[kind];
    if (!target) return [];
    const things = kind === 'page' ? 'Previews' : 'Desktops';
    return [{ kind, text: `${things} open in ${BROWSER_OFFER_PLACES[target]}` }];
  });
  return (
    <div className="shrink-0 border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
      {rows.map(({ kind, text }) => (
        <div key={kind} className="flex items-center justify-between gap-2 py-0.5">
          <span>{text}</span>
          <button
            type="button"
            className="rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            onClick={() => useRememberedOfferTargetsStore.getState().forget(scope, kind)}
          >
            Ask each time
          </button>
        </div>
      ))}
    </div>
  );
}
