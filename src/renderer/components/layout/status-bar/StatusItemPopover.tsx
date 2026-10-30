import { ArrowClockwise } from '@phosphor-icons/react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { openLinkInBrowser } from '@/components/workspaces/file-viewer/MarkdownPreview';
import { cn } from '@/lib/utils';
import {
  keepStatusPopover,
  setStatusPopover,
  statusCommandKey,
  statusItemKey,
  useStatusItemsStore,
} from '@/stores/status-items.store';

import { isBrowserUrl } from '../../../../shared/lib/browser-tabs';
import {
  STATUS_POPOVER_THEME_COLORS,
  type StatusCommand,
  type StatusPopoverButton,
  type StatusPopoverContent,
  type StatusPopoverTheme,
  type WindowStatusItem,
} from '../../../../shared/types/status-items';

/** The tallest an HTML popover's page grows before it scrolls. */
const MAX_HTML_HEIGHT = 420;
/** An HTML popover's height before its page reports one. */
const DEFAULT_HTML_HEIGHT = 80;
/** How long an HTML popover's last page shows again on opening; Komla serves it for an hour. */
const REUSE_HTML_PAGE_MS = 30 * 60_000;

/** The window's theme colors, as the themes set them on the root, for an HTML popover. */
function readPopoverTheme(): StatusPopoverTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const colors: StatusPopoverTheme['colors'] = {};
  for (const name of STATUS_POPOVER_THEME_COLORS) {
    const channels = style.getPropertyValue(`--${name}`).trim();
    if (channels) colors[name] = channels;
  }
  return { scheme: root.classList.contains('dark') ? 'dark' : 'light', colors };
}

/**
 * An HTML popover's page, in Komla's preview sandbox: its own opaque origin, so it can't reach
 * Komla or the workspace's files, with loads from the web blocked. It grows to its height. A new
 * page loads out of sight behind the one on screen, and takes its place once it reports its
 * height, which Komla's pages do as they load; one that doesn't, such as an error page, never
 * does. Only the page on screen can close the popover.
 */
function StatusHtmlFrame({
  url,
  title,
  initialHeight = DEFAULT_HTML_HEIGHT,
  onHeight,
  onClose,
}: {
  url: string;
  title: string;
  initialHeight?: number;
  /** The height a page reports, to open at next time. */
  onHeight: (height: number) => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(url);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  // The token each page's own script sent first, which its link clicks carry.
  const tokens = useRef(new Map<string, string>());
  const height = heights[shown] ?? initialHeight;

  const onMessage = useEffectEvent((event: MessageEvent) => {
    const source = [...frames.current].find(
      ([, frame]) => frame.contentWindow === event.source
    )?.[0];
    if (!source) return;
    const data = event.data as {
      komlaPopoverHeight?: unknown;
      komlaPopoverClose?: unknown;
      komlaPopoverToken?: unknown;
      komlaPopoverOpenLink?: unknown;
      token?: unknown;
    } | null;
    if (typeof data?.komlaPopoverToken === 'string') {
      if (!tokens.current.has(source)) tokens.current.set(source, data.komlaPopoverToken);
      return;
    }
    if (typeof data?.komlaPopoverOpenLink === 'string') {
      const token = tokens.current.get(source);
      if (
        source === shown &&
        token &&
        data.token === token &&
        isBrowserUrl(data.komlaPopoverOpenLink)
      ) {
        void window.api.openExternal(data.komlaPopoverOpenLink);
      }
      return;
    }
    if (data?.komlaPopoverClose === true) {
      if (source === shown) onClose();
      return;
    }
    const reported = data?.komlaPopoverHeight;
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      const fitted = Math.min(Math.max(Math.ceil(reported), 24), MAX_HTML_HEIGHT);
      // A page that loaded behind takes the place of the one on screen.
      setHeights((previous) => ({ ...(source === shown ? previous : {}), [source]: fitted }));
      setShown(source);
      onHeight(fitted);
    }
  });

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Keyed by URL in one list, so the page that loaded behind stays the same frame on screen.
  return (
    <div className="relative">
      {(url === shown ? [shown] : [shown, url]).map((src) => {
        const loading = src !== shown;
        return (
          <iframe
            key={src}
            ref={(frame) => {
              if (frame) frames.current.set(src, frame);
              else {
                frames.current.delete(src);
                tokens.current.delete(src);
              }
            }}
            title={title}
            src={src}
            // No allow-same-origin, so scripts in the page can't reach Komla; no popups or navigation.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            aria-hidden={loading || undefined}
            tabIndex={loading ? -1 : undefined}
            className={cn(
              'block w-full border-0 bg-transparent',
              loading && 'pointer-events-none invisible absolute inset-x-0 top-0'
            )}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}

/**
 * Markdown from a status item, sanitized. Output can carry text from elsewhere, such as a pull
 * request title, so classes and styles go too: they could lay the popover over Komla's own UI.
 * Images go as well, since Komla's page can't load them from the web.
 */
function StatusMarkdown({ markdown }: { markdown: string }) {
  const articleRef = useRef<HTMLElement>(null);
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }), {
        FORBID_TAGS: ['form', 'style', 'img'],
        FORBID_ATTR: ['class', 'style'],
      }),
    [markdown]
  );

  useEffect(() => {
    const article = articleRef.current;
    article?.addEventListener('click', openLinkInBrowser);
    return () => article?.removeEventListener('click', openLinkInBrowser);
  }, []);

  return (
    <article
      ref={articleRef}
      className="markdown-preview status-markdown font-status text-xs select-text"
      // Sanitized above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function linkHost(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

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
 * What a button does, as the popover's output can label it as anything. `plugin` names the plugin
 * the item comes from, when it isn't status-items.json's.
 */
function buttonHint(button: StatusPopoverButton, plugin?: string): string {
  if ('link' in button) return `Opens ${linkHost(button.link)}`;
  if ('action' in button) return `Runs the quick command “${button.action}”`;
  return `Runs “${button.run}” from ${plugin ? `the plugin ${plugin}` : 'status-items.json'}`;
}

/**
 * The buttons below a popover, which Komla draws, so nothing in the Markdown can press them. They
 * wait while the popover runs again, as what they do may no longer fit what it shows.
 */
function PopoverButtons({
  buttons,
  onPress,
  busy,
  waiting = false,
  plugin,
}: {
  buttons: StatusPopoverButton[];
  onPress: (button: StatusPopoverButton) => void;
  busy: string | null;
  waiting?: boolean;
  plugin?: string;
}) {
  if (buttons.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-foreground/10 px-3 py-2">
      {buttons.map((button) => (
        <Button
          key={`${button.label}:${'link' in button ? button.link : 'action' in button ? button.action : button.run}`}
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={busy !== null || waiting}
          title={buttonHint(button, plugin)}
          onClick={() => onPress(button)}
        >
          {busy === button.label && <Spinner size="xs" />}
          {button.label}
        </Button>
      ))}
    </div>
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
          <StatusMarkdown markdown={item.popoverMarkdown ?? ''} />
        </PopoverFrame>
      )}
      <PopoverButtons
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

/** Moves an element in, keeping the frames in it loaded, which a plain move would reload. */
function moveInto(parent: Element, node: Element): void {
  const { moveBefore } = parent as Element & { moveBefore?: (node: Node, child: null) => void };
  if (moveBefore && node.isConnected && parent.isConnected) moveBefore.call(parent, node, null);
  else parent.append(node);
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
          <StatusHtmlFrame
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
  const [theme] = useState(readPopoverTheme);
  const themeKey = useMemo(() => JSON.stringify(theme), [theme]);
  const { id } = command;
  const key = statusCommandKey(workspaceId, command);
  const [state, setState] = useState<{
    content: StatusPopoverContent | null;
    error?: string;
    loading: boolean;
  }>(() => ({ content: cachedPopover(key, themeKey), loading: true }));
  const [initialHeight] = useState(() => useStatusItemsStore.getState().popovers[key]?.htmlHeight);
  const [busy, setBusy] = useState<string | null>(null);
  const [buttonError, setButtonError] = useState<string | null>(null);
  const latest = useRef(0);
  const open = useRef(true);

  const load = useCallback(() => {
    const request = ++latest.current;
    const startedAt = Date.now();
    setState((previous) => ({ ...previous, loading: true }));
    void window.api
      .runStatusPopover(workspaceId, id, theme)
      .then((result) => {
        // Kept even once the popover closed, as Komla then serves this page in place of the last.
        if (result.error === undefined) keepStatusPopover(key, result.content, startedAt, themeKey);
        if (request !== latest.current) return;
        // A failed run keeps what the popover showed, with the error under it.
        if (result.error !== undefined) {
          setState((previous) => ({ ...previous, error: result.error, loading: false }));
          return;
        }
        setState({ content: result.content, loading: false });
      })
      .catch((error: Error) => {
        if (request === latest.current) {
          setState((previous) => ({ ...previous, error: error.message, loading: false }));
        }
      });
  }, [workspaceId, id, theme, themeKey, key]);

  useEffect(() => {
    load();
    // Results that arrive after the popover closes aren't shown.
    const requests = latest;
    const isOpen = open;
    isOpen.current = true;
    return () => {
      requests.current++;
      isOpen.current = false;
    };
  }, [load]);

  const press = (button: StatusPopoverButton) => {
    setButtonError(null);
    if ('link' in button) {
      void window.api.openExternal(button.link);
    } else if ('action' in button) {
      onRunAction(button.action);
    } else {
      setBusy(button.label);
      void window.api
        .runStatusButton(workspaceId, id, button.run)
        .then((result) => {
          if (result.error) setButtonError(`${button.label} failed: ${result.error}`);
          else onCommandDone();
          if (open.current) load();
        })
        .catch((error: Error) => setButtonError(`${button.label} failed: ${error.message}`))
        .finally(() => setBusy(null));
    }
  };

  const { content, error, loading } = state;
  return (
    <>
      <PopoverFrame
        title={title}
        onRefresh={load}
        refreshing={loading}
        flush={Boolean(content?.htmlUrl) && !buttonError && !error}
      >
        {content?.htmlUrl ? (
          <StatusHtmlFrame
            url={content.htmlUrl}
            title={title}
            initialHeight={initialHeight}
            onHeight={(htmlHeight) => setStatusPopover(key, { htmlHeight })}
            onClose={onClose}
          />
        ) : content ? (
          content.markdown && <StatusMarkdown markdown={content.markdown} />
        ) : loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Spinner size="xs" />
            Loading…
          </div>
        ) : (
          <p className="py-1 text-xs break-words whitespace-pre-wrap text-muted-foreground">
            {error ? `The popover command failed: ${error}` : 'Nothing to show.'}
          </p>
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
        <PopoverButtons
          buttons={content.buttons}
          onPress={press}
          busy={busy}
          waiting={loading}
          plugin={command.plugin}
        />
      )}
    </>
  );
}
