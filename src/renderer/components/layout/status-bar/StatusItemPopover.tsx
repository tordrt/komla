import { ArrowClockwise } from '@phosphor-icons/react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  CommandHtmlFrame,
  CommandMarkdown,
  CommandPageButtons,
  CommandPagePlaceholder,
  commandSource,
  linkHost,
  readPopoverTheme,
  useCommandPage,
} from '@/components/command-page/command-page';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import {
  keepStatusPopover,
  setStatusPopover,
  statusCommandKey,
  statusItemKey,
  useStatusItemsStore,
} from '@/stores/status-items.store';

import type {
  StatusCommand,
  StatusPopoverContent,
  StatusPopoverTheme,
  WindowStatusItem,
} from '../../../../shared/types/status-items';

/** How long an HTML popover's last page shows again on opening; Komla serves it for an hour. */
const REUSE_HTML_PAGE_MS = 30 * 60_000;

function PopoverFrame({
  title,
  onRefresh,
  refreshing,
  flush = false,
  children,
}: {
  title: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** For a page that sets its own padding and scrolls itself. */
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-foreground/10 px-3 py-1.5 font-status">
        <h2 className="truncate text-[13px] font-semibold">{title}</h2>
        {onRefresh && (
          <IconButton
            label="Refresh"
            size="xs"
            variant="ghost"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <ArrowClockwise className={refreshing ? 'animate-spin' : undefined} />
          </IconButton>
        )}
      </div>
      <div
        className={
          flush ? undefined : 'thin-scrollbar max-h-[min(60vh,28rem)] overflow-y-auto px-3 py-2.5'
        }
      >
        {children}
      </div>
    </>
  );
}

/**
 * The popover of an item an agent set: its Markdown, or its HTML page in the sandbox, which
 * KeptAgentHtmlPopover keeps loaded in `htmlContainer`, with its link as a button.
 */
export function AgentItemPopover({
  item,
  htmlContainer,
}: {
  item: WindowStatusItem;
  htmlContainer?: HTMLElement;
}) {
  const { text: title, link } = item;
  return (
    <>
      {item.popoverPageId && htmlContainer ? (
        <KeptPopoverSlot container={htmlContainer} />
      ) : (
        <PopoverFrame title={title}>
          <CommandMarkdown markdown={item.popoverMarkdown ?? ''} />
        </PopoverFrame>
      )}
      <CommandPageButtons
        buttons={link ? [{ label: `Open ${linkHost(link)}`, link }] : []}
        onPress={() => link && void window.api.openExternal(link)}
        busy={null}
      />
    </>
  );
}

/** A status item's popover's width, which a kept page also lays out at while it waits. */
export const STATUS_POPOVER_WIDTH = '22rem';

/** Where a kept popover waits while it's closed: loaded, out of sight and out of reach. */
function popoverParking(): HTMLElement {
  let parking = document.getElementById('komla-popover-parking');
  if (!parking) {
    parking = document.createElement('div');
    parking.id = 'komla-popover-parking';
    parking.setAttribute('aria-hidden', 'true');
    parking.inert = true;
    // As wide as the popover's content, inside its border, so its page lays out the same.
    parking.style.cssText = `position: fixed; top: 0; left: -10000px; width: calc(${STATUS_POPOVER_WIDTH} - 2px); visibility: hidden; pointer-events: none;`;
    document.body.append(parking);
  }
  return parking;
}

/**
 * Moves an element in, last or before `before`, keeping the frames in it loaded and its focus,
 * which a plain move would reload and drop.
 */
export function moveInto(parent: Element, node: Element, before: Node | null = null): void {
  const { moveBefore } = parent as Element & {
    moveBefore?: (node: Node, child: Node | null) => void;
  };
  if (moveBefore && node.isConnected && parent.isConnected) moveBefore.call(parent, node, before);
  else parent.insertBefore(node, before);
}

/** Where a kept popover shows while its popover is open. */
function KeptPopoverSlot({ container }: { container: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    moveInto(slot.current!, container);
    // Gone already when its item is.
    return () => {
      if (container.isConnected) moveInto(popoverParking(), container);
    };
  }, [container]);
  return <div ref={slot} />;
}

/**
 * An agent item's HTML popover, rendered into `container` and kept loaded while the popover is
 * closed, so it shows at once on opening. It waits out of sight and moves into the popover while
 * it's open; AgentHtmlItem says which page it follows.
 */
export function KeptAgentHtmlPopover({
  item,
  open,
  onClose,
  container,
}: {
  item: WindowStatusItem;
  open: boolean;
  onClose: () => void;
  container: HTMLElement;
}) {
  useLayoutEffect(() => {
    // An open popover's slot may have taken it in first.
    if (!container.isConnected) moveInto(popoverParking(), container);
    return () => container.remove();
  }, [container]);
  return createPortal(<AgentHtmlPopover item={item} open={open} onClose={onClose} />, container);
}

// Apart from status-items.json items' popovers, which may share an id.
const agentPopoverKey = (workspaceId: string, id: string) =>
  `agent\0${statusItemKey(workspaceId, id)}`;

/** The page Komla served last for the item's HTML, while it still serves it in this theme. */
function cachedAgentPage(key: string, pageId: string, theme: string): string | null {
  const page = useStatusItemsStore.getState().popovers[key]?.agentPage;
  if (!page || page.pageId !== pageId || page.theme !== theme) return null;
  return Date.now() - page.servedAt > REUSE_HTML_PAGE_MS ? null : page.url;
}

const servingAgentPages = new Map<string, Promise<string | null>>();

/**
 * The URL of an agent item's HTML page: the one Komla served last while the page is the same, or
 * a new one.
 */
function serveAgentPopoverPage(
  {
    workspaceId,
    id,
    popoverPageId,
  }: Pick<WindowStatusItem, 'workspaceId' | 'id' | 'popoverPageId'>,
  theme: StatusPopoverTheme = readPopoverTheme()
): Promise<string | null> {
  if (!popoverPageId) return Promise.resolve(null);
  const key = agentPopoverKey(workspaceId, id);
  const themeKey = JSON.stringify(theme);
  const cached = cachedAgentPage(key, popoverPageId, themeKey);
  if (cached) return Promise.resolve(cached);
  const serving = `${key}\0${popoverPageId}\0${themeKey}`;
  let request = servingAgentPages.get(serving);
  if (!request) {
    const servedAt = Date.now();
    request = window.api
      .statusItemPopoverPage(workspaceId, id, theme)
      .then((url) => {
        if (url) {
          const agentPage = { url, pageId: popoverPageId, theme: themeKey, servedAt };
          setStatusPopover(key, { agentPage });
        }
        return url;
      })
      .finally(() => servingAgentPages.delete(serving));
    servingAgentPages.set(serving, request);
  }
  return request;
}

/**
 * An agent item's HTML page, served again whenever the item it's given has a new one. A page that
 * fails to load keeps the one on screen, with the error under it.
 */
function AgentHtmlPopover({
  item,
  open,
  onClose,
}: {
  item: WindowStatusItem;
  open: boolean;
  onClose: () => void;
}) {
  const [theme, setTheme] = useState(readPopoverTheme);
  // Kept loaded while closed, it takes on a theme chosen since as it opens.
  const onOpen = useEffectEvent(() => {
    const current = readPopoverTheme();
    if (JSON.stringify(current) !== JSON.stringify(theme)) setTheme(current);
  });
  useEffect(() => {
    if (open) onOpen();
  }, [open]);
  const { workspaceId, id, text: title, popoverPageId, updatedAt } = item;
  const key = agentPopoverKey(workspaceId, id);
  const [initialHeight] = useState(() => useStatusItemsStore.getState().popovers[key]?.htmlHeight);
  // The page served last shows at once while it's the same.
  const [page, setPage] = useState<{ url: string | null; error?: string } | null>(() => {
    const url = popoverPageId && cachedAgentPage(key, popoverPageId, JSON.stringify(theme));
    return url ? { url } : null;
  });
  // After a failure, the item set again tries again, even with the same page.
  const [attempt, setAttempt] = useState(0);
  const onItemSet = useEffectEvent(() => {
    if (page?.error) setAttempt((previous) => previous + 1);
  });
  useEffect(() => onItemSet(), [updatedAt]);

  useEffect(() => {
    let current = true;
    void serveAgentPopoverPage({ workspaceId, id, popoverPageId }, theme)
      .then(
        (url) =>
          current &&
          setPage((previous) => (previous?.url === url && !previous.error ? previous : { url }))
      )
      .catch(
        (error: Error) =>
          current && setPage((previous) => ({ url: previous?.url ?? null, error: error.message }))
      );
    return () => {
      current = false;
    };
  }, [workspaceId, id, popoverPageId, attempt, theme]);

  return (
    <PopoverFrame title={title} flush={Boolean(page?.url)}>
      {page?.url ? (
        <>
          <CommandHtmlFrame
            url={page.url}
            title={title}
            initialHeight={initialHeight}
            onHeight={(htmlHeight) => setStatusPopover(key, { htmlHeight })}
            onClose={onClose}
          />
          {page.error && (
            <p className="px-3 pt-2 pb-2.5 text-xs break-words text-muted-foreground">
              Couldn't show the latest page: {page.error}
            </p>
          )}
        </>
      ) : page ? (
        <p className="py-1 text-xs break-words text-muted-foreground">
          {page.error ? `The popover couldn't open: ${page.error}` : 'Nothing to show.'}
        </p>
      ) : (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Spinner size="xs" />
          Loading…
        </div>
      )}
    </PopoverFrame>
  );
}

/**
 * What an item's popover showed last time, if it can show again: an HTML page while Komla serves
 * it, in the window's theme.
 */
function cachedPopover(key: string, theme: string): StatusPopoverContent | null {
  const cached = useStatusItemsStore.getState().popovers[key];
  if (!cached?.content) return null;
  if (
    cached.content.htmlUrl &&
    (Date.now() - cached.ranAt > REUSE_HTML_PAGE_MS || cached.theme !== theme)
  ) {
    return null;
  }
  return cached.content;
}

/**
 * The popover of a status-items.json or plugin item: its popover command runs each time it opens, showing
 * what it showed last time until then, and its buttons open links, run Actions or run the
 * commands the item names.
 */
export function CommandItemPopover({
  workspaceId,
  command,
  title,
  onClose,
  onRunAction,
  onCommandDone,
}: {
  workspaceId: string;
  command: StatusCommand;
  title: string;
  onClose: () => void;
  onRunAction: (action: string) => void;
  /** After a button's command ran, so the item can show what changed. */
  onCommandDone: () => void;
}) {
  const { id } = command;
  const key = statusCommandKey(workspaceId, command);
  const [initialHeight] = useState(() => useStatusItemsStore.getState().popovers[key]?.htmlHeight);
  const { content, error, loading, load, press, busy, buttonError } = useCommandPage({
    pageKey: key,
    run: (theme) => window.api.runStatusPopover(workspaceId, id, theme),
    runButton: (name) => window.api.runStatusButton(workspaceId, id, name),
    cached: (theme) => cachedPopover(key, theme),
    onResult: (result, startedAt, theme) => keepStatusPopover(key, result, startedAt, theme),
    onRunAction,
    onCommandDone,
  });

  return (
    <>
      <PopoverFrame
        title={title}
        onRefresh={load}
        refreshing={loading}
        flush={Boolean(content?.htmlUrl) && !buttonError && !error}
      >
        {content?.htmlUrl ? (
          <CommandHtmlFrame
            url={content.htmlUrl}
            title={title}
            initialHeight={initialHeight}
            onHeight={(htmlHeight) => setStatusPopover(key, { htmlHeight })}
            onClose={onClose}
          />
        ) : content ? (
          content.markdown && <CommandMarkdown markdown={content.markdown} />
        ) : (
          <CommandPagePlaceholder
            loading={loading}
            error={error}
            failure="The popover command failed"
          />
        )}
        {content && error && (
          <p className="mt-2 text-xs break-words text-muted-foreground">
            The popover command failed: {error}
          </p>
        )}
        {buttonError && (
          <p role="alert" className="mt-2 text-xs break-words text-destructive">
            {buttonError}
          </p>
        )}
      </PopoverFrame>
      {content && (
        <CommandPageButtons
          buttons={content.buttons}
          onPress={press}
          busy={busy}
          waiting={loading}
          source={commandSource('status-items.json', command.plugin)}
        />
      )}
    </>
  );
}
