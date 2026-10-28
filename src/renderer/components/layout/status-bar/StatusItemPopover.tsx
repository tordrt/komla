import { ArrowClockwise } from '@phosphor-icons/react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { openLinkInBrowser } from '@/components/workspaces/file-viewer/MarkdownPreview';
import { cn } from '@/lib/utils';
import {
  keepStatusPopover,
  setStatusPopover,
  statusCommandKey,
  useStatusItemsStore,
} from '@/stores/status-items.store';

import { isBrowserUrl } from '../../../../shared/lib/browser-tabs';
import {
  STATUS_POPOVER_THEME_COLORS,
  type StatusCommand,
  type StatusPopoverButton,
  type StatusPopoverContent,
  type StatusPopoverTheme,
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

/** What a button does, as the popover's output can label it as anything. */
function buttonHint(button: StatusPopoverButton): string {
  if ('link' in button) return `Opens ${linkHost(button.link)}`;
  if ('action' in button) return `Runs the quick command “${button.action}”`;
  return `Runs “${button.run}” from status-items.json`;
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
}: {
  buttons: StatusPopoverButton[];
  onPress: (button: StatusPopoverButton) => void;
  busy: string | null;
  waiting?: boolean;
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
          title={buttonHint(button)}
          onClick={() => onPress(button)}
        >
          {busy === button.label && <Spinner size="xs" />}
          {button.label}
        </Button>
      ))}
    </div>
  );
}

/** The popover of an item an agent set: its Markdown, with its link as a button. */
export function AgentItemPopover({
  title,
  markdown,
  link,
}: {
  title: string;
  markdown: string;
  link?: string;
}) {
  return (
    <>
      <PopoverFrame title={title}>
        <StatusMarkdown markdown={markdown} />
      </PopoverFrame>
      <PopoverButtons
        buttons={link ? [{ label: `Open ${linkHost(link)}`, link }] : []}
        onPress={() => link && void window.api.openExternal(link)}
        busy={null}
      />
    </>
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
 * The popover of a status-items.json item: its popover command runs each time it opens, showing
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
        <PopoverButtons buttons={content.buttons} onPress={press} busy={busy} waiting={loading} />
      )}
    </>
  );
}
