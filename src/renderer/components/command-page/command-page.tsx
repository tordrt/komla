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

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { openLinkInBrowser } from '@/components/workspaces/file-viewer/MarkdownPreview';
import { statusItemColorProps } from '@/lib/status-item-color';
import { cn } from '@/lib/utils';

import { isBrowserUrl } from '../../../shared/lib/browser-tabs';
import {
  STATUS_POPOVER_THEME_COLORS,
  type StatusButtonRunResult,
  type StatusPopoverButton,
  type StatusPopoverContent,
  type StatusPopoverTheme,
  type StatusTextSegment,
} from '../../../shared/types/status-items';

/*
 * What a command's page shows, as a status item's popover or a sidebar panel: an HTML page in
 * Komla's sandbox or Markdown, with buttons Komla draws below it.
 */

/** The tallest an HTML popover's page grows before it scrolls. */
const MAX_HTML_HEIGHT = 420;
/** An HTML popover's height before its page reports one. */
const DEFAULT_HTML_HEIGHT = 80;

/** The window's theme colors, as the themes set them on the root, for an HTML page. */
export function readPopoverTheme(): StatusPopoverTheme {
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
 * A command's HTML page, in Komla's preview sandbox: its own opaque origin, so it can't reach
 * Komla or the workspace's files, with loads from the web blocked. In a popover it grows to its
 * height; with `fill`, it fills its container and scrolls itself. A new page loads out of sight
 * behind the one on screen, and takes its place once it reports its height, which Komla's pages do
 * as they load; one that doesn't, such as an error page, never does. Only the page on screen can
 * close the popover.
 */
export function CommandHtmlFrame({
  url,
  title,
  initialHeight = DEFAULT_HTML_HEIGHT,
  fill = false,
  onHeight,
  onClose,
}: {
  url: string;
  title: string;
  initialHeight?: number;
  /** Fills the container, as a sidebar panel does, rather than growing to the page. */
  fill?: boolean;
  /** The height a page reports, to open at next time. */
  onHeight?: (height: number) => void;
  onClose?: () => void;
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
      if (source === shown) onClose?.();
      return;
    }
    const reported = data?.komlaPopoverHeight;
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      const fitted = Math.min(Math.max(Math.ceil(reported), 24), MAX_HTML_HEIGHT);
      // A page that loaded behind takes the place of the one on screen.
      setHeights((previous) => ({ ...(source === shown ? previous : {}), [source]: fitted }));
      setShown(source);
      onHeight?.(fitted);
    }
  });

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Keyed by URL in one list, so the page that loaded behind stays the same frame on screen.
  return (
    <div className={cn('relative', fill && 'h-full')}>
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
            style={{ height: fill ? '100%' : height }}
          />
        );
      })}
    </div>
  );
}

/**
 * Markdown from a command, sanitized. Output can carry text from elsewhere, such as a pull request
 * title, so classes and styles go too: they could lay the page over Komla's own UI. Images go as
 * well, since Komla's page can't load them from the web.
 */
export function CommandMarkdown({ markdown }: { markdown: string }) {
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

/** Text a command printed for a terminal, in Komla's monospace font with its colors as theme colors. */
export function CommandTerminalText({ lines }: { lines: StatusTextSegment[][] }) {
  return (
    <pre
      className="m-0 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap select-text"
      data-terminal-text
    >
      {lines.map((segments, line) => (
        // Lines and their runs only change all at once, with the output.
        <span key={line} className="block min-h-[1lh]">
          {segments.map((segment, index) => {
            const colors = statusItemColorProps(segment.color);
            return (
              <span
                key={index}
                className={cn(colors.className, segment.bold && 'font-semibold')}
                style={colors.style}
              >
                {segment.text}
              </span>
            );
          })}
        </span>
      ))}
    </pre>
  );
}

export function linkHost(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

/**
 * What a button does, as the page's output can label it as anything. `source` names the file or
 * plugin the page's commands come from.
 */
function buttonHint(button: StatusPopoverButton, source: string | undefined): string {
  if ('link' in button) return `Opens ${linkHost(button.link)}`;
  if ('action' in button) return `Runs the quick command “${button.action}”`;
  return source ? `Runs “${button.run}” from ${source}` : `Runs “${button.run}”`;
}

/** Where an item's or panel's commands come from, for what its buttons and errors say. */
export function commandSource(fileName: string, plugin?: string): string {
  return plugin ? `the plugin ${plugin}` : fileName;
}

/**
 * The buttons below a page, which Komla draws, so nothing in the page can press them. They wait
 * while the page runs again, as what they do may no longer fit what it shows.
 */
export function CommandPageButtons({
  buttons,
  onPress,
  busy,
  waiting = false,
  source,
}: {
  buttons: StatusPopoverButton[];
  onPress: (button: StatusPopoverButton) => void;
  busy: string | null;
  waiting?: boolean;
  /** The file or plugin the commands come from, as commandSource names it. */
  source?: string;
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
          title={buttonHint(button, source)}
          onClick={() => onPress(button)}
        >
          {busy === button.label && <Spinner size="xs" />}
          {button.label}
        </Button>
      ))}
    </div>
  );
}

/** A page's last run: what it shows, and why the run after it failed. */
export interface CommandPageState {
  content: StatusPopoverContent | null;
  error?: string;
  loading: boolean;
}

export interface CommandPageOptions {
  /** Names the page; a new one runs it again. */
  pageKey: string;
  /** Runs the page's command in the window's theme. */
  run: (
    theme: StatusPopoverTheme
  ) => Promise<{ content: StatusPopoverContent | null; error?: string }>;
  /** Runs one of the commands the page's entry names, for a button. */
  runButton: (name: string) => Promise<StatusButtonRunResult>;
  /** What the page showed last time, to show until it has run, for the theme as readPopoverTheme reads it. */
  cached?: (theme: string) => StatusPopoverContent | null;
  /** Keeps what a run that worked shows, which started at `startedAt` in `theme`. */
  onResult?: (content: StatusPopoverContent | null, startedAt: number, theme: string) => void;
  /** Runs one of the project's Quick Commands, by title, for a button. */
  onRunAction: (action: string) => void;
  /** After a button's command ran, so what the page sums up can show what changed. */
  onCommandDone?: () => void;
}

/**
 * Runs a command's page when it shows and as `load` asks, showing what it showed last time until
 * then, and presses its buttons: they open links, run Quick Commands, or run the commands its
 * entry names, then run the page again. A failed run keeps what the page showed, with the error.
 */
export function useCommandPage({
  pageKey,
  run,
  runButton,
  cached,
  onResult,
  onRunAction,
  onCommandDone,
}: CommandPageOptions) {
  const [state, setState] = useState<CommandPageState>(() => ({
    content: cached?.(JSON.stringify(readPopoverTheme())) ?? null,
    loading: true,
  }));
  const [busy, setBusy] = useState<string | null>(null);
  const [buttonError, setButtonError] = useState<string | null>(null);
  const latest = useRef(0);
  const shown = useRef(true);
  // The callbacks as last rendered, so a new one doesn't run the page again.
  const options = useRef({ run, runButton, cached, onResult, onRunAction, onCommandDone });
  useLayoutEffect(() => {
    options.current = { run, runButton, cached, onResult, onRunAction, onCommandDone };
  });

  const load = useCallback(() => {
    const request = ++latest.current;
    const startedAt = Date.now();
    const theme = readPopoverTheme();
    const themeKey = JSON.stringify(theme);
    setState((previous) => ({ ...previous, loading: true }));
    void options.current
      .run(theme)
      .then((result) => {
        // Kept even once the page is gone, as Komla then serves this page in place of the last.
        if (result.error === undefined)
          options.current.onResult?.(result.content, startedAt, themeKey);
        if (request !== latest.current) return;
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
  }, []);

  // A new page runs, and shows what it showed last, from the start.
  useEffect(() => {
    setState({
      content: options.current.cached?.(JSON.stringify(readPopoverTheme())) ?? null,
      loading: true,
    });
    setButtonError(null);
    load();
    // Results that arrive after the page is gone aren't shown.
    const requests = latest;
    const isShown = shown;
    isShown.current = true;
    return () => {
      requests.current++;
      isShown.current = false;
    };
  }, [load, pageKey]);

  const press = (button: StatusPopoverButton) => {
    setButtonError(null);
    if ('link' in button) {
      void window.api.openExternal(button.link);
    } else if ('action' in button) {
      options.current.onRunAction(button.action);
    } else {
      setBusy(button.label);
      void options.current
        .runButton(button.run)
        .then((result) => {
          if (result.error) setButtonError(`${button.label} failed: ${result.error}`);
          else options.current.onCommandDone?.();
          if (shown.current) load();
        })
        .catch((error: Error) => setButtonError(`${button.label} failed: ${error.message}`))
        .finally(() => setBusy(null));
    }
  };

  return { ...state, load, press, busy, buttonError };
}

/** What a page shows while it has nothing yet, or nothing at all. */
export function CommandPagePlaceholder({
  loading,
  error,
  failure,
}: {
  loading: boolean;
  error?: string;
  /** How the error starts, such as "The popover command failed". */
  failure: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Spinner size="xs" />
        Loading…
      </div>
    );
  }
  return (
    <p className="py-1 text-xs break-words whitespace-pre-wrap text-muted-foreground">
      {error ? `${failure}: ${error}` : 'Nothing to show.'}
    </p>
  );
}
