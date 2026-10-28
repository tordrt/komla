import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BrowserPreviewFrame } from '@/components/workspaces/file-viewer/BrowserPreviewFrame';
import { MarkdownPreview } from '@/components/workspaces/file-viewer/MarkdownPreview';
import { cn } from '@/lib/utils';
import { quickLookItemKey, type QuickLookItem } from '@/stores/quick-look.store';

import { getViewableFileKind } from '../../../shared/image-utils';

import { terminalFileViewerItem } from './terminal-files';

import type { TerminalFile } from '@/stores/terminal-files.store';

const CARD_WIDTH_PX = 288;
// Each kind is laid out at this size, as a window would show it, then scaled to the card's width.
const LAYOUTS = {
  page: { width: 1280, height: 800 },
  // The top of a letter-size page at 96 dpi.
  pdf: { width: 816, height: 612 },
  // Narrow, so its text stays readable scaled down.
  markdown: { width: 480, height: 360 },
} as const;
// Enough of a Markdown file to fill the card.
const MARKDOWN_PREVIEW_CHARS = 4000;

type PreviewKind = 'image' | keyof typeof LAYOUTS;

/** What a file's hover card shows: images and SVGs as pictures, pages, PDFs and Markdown rendered. */
export function terminalFilePreviewKind(path: string): PreviewKind | null {
  const kind = getViewableFileKind(path);
  if (kind === 'image' || kind === 'svg') return 'image';
  if (kind === 'html') return 'page';
  if (kind === 'pdf' || kind === 'markdown') return kind;
  return null;
}

type Loaded = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; value: string };

// Recent previews by file, so moving over the rows again doesn't read each file again, over SSH
// too. Brief, so a file an agent rewrites soon shows its new contents, and well inside the hour a
// preview URL lasts. Few, as an image's data URL can be megabytes.
const PREVIEW_CACHE_MS = 60_000;
const MAX_CACHED_PREVIEWS = 8;
const previewCache = new Map<string, { at: number; value: Promise<string> }>();

function cachedPreview(key: string, load: () => Promise<string>): Promise<string> {
  const cached = previewCache.get(key);
  if (cached && Date.now() - cached.at < PREVIEW_CACHE_MS) return cached.value;
  const value = load();
  previewCache.delete(key);
  previewCache.set(key, { at: Date.now(), value });
  if (previewCache.size > MAX_CACHED_PREVIEWS)
    previewCache.delete(previewCache.keys().next().value!);
  // A failed read is tried again next time.
  value.catch(() => {
    if (previewCache.get(key)?.value === value) previewCache.delete(key);
  });
  return value;
}

/** The start of a base64-encoded text file. */
function decodedStart(data: string): string {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes).slice(0, MARKDOWN_PREVIEW_CHARS);
}

/**
 * Reads the file where its link would open it, once the card shows: a preview URL for a page or
 * PDF, a data URL for an image, the text of Markdown.
 */
function usePreviewSource(workspaceId: string, item: QuickLookItem, kind: PreviewKind): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const { terminalId, source } = item;
    const request = cachedPreview(`${workspaceId}:${kind}:${quickLookItemKey(item)}`, () =>
      kind === 'page' || kind === 'pdf'
        ? // Only cards share this file's copy, so a card's new one can replace the last.
          window.api.getViewerPreviewUrl(workspaceId, terminalId, source, {
            replacesPrevious: true,
          })
        : window.api
            .readViewerFile(workspaceId, terminalId, source)
            .then(({ data, mimeType }) =>
              kind === 'image' ? `data:${mimeType};base64,${data}` : decodedStart(data)
            )
    );
    request.then(
      (value) => {
        if (!cancelled) setLoaded({ status: 'loaded', value });
      },
      () => {
        if (!cancelled) setLoaded({ status: 'error' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, item, kind]);
  return loaded;
}

function PreviewBody({
  workspaceId,
  item,
  kind,
}: {
  workspaceId: string;
  item: QuickLookItem;
  kind: PreviewKind;
}) {
  const source = usePreviewSource(workspaceId, item, kind);
  if (source.status !== 'loaded') {
    return (
      <div className="flex aspect-[16/10] w-full items-center justify-center bg-muted/40 text-2xs text-muted-foreground">
        {source.status === 'loading' ? <Spinner size="xs" /> : "Couldn't load a preview"}
      </div>
    );
  }
  if (kind === 'image') {
    return <img src={source.value} alt="" className="max-h-56 w-full bg-muted/40 object-contain" />;
  }
  const { width, height } = LAYOUTS[kind];
  const scale = CARD_WIDTH_PX / width;
  return (
    <div
      className={cn('w-full overflow-hidden', kind === 'markdown' ? 'bg-background' : 'bg-white')}
      style={{ height: height * scale }}
    >
      {/* The card can't be clicked into. */}
      <div
        className="pointer-events-none flex flex-col"
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
      >
        {kind === 'markdown' ? (
          <MarkdownPreview markdown={source.value} />
        ) : (
          <BrowserPreviewFrame
            filePath={item.path}
            // Hovering shows a page, but runs nothing in it: that waits for a click.
            scripts={false}
            // Just the first page, without the PDF viewer's toolbar.
            url={kind === 'pdf' ? `${source.value}#toolbar=0&navpanes=0&view=FitH` : source.value}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Shows an image, page, PDF or Markdown file beside its row on hover, read as opening it would
 * read it. Other files keep just the row.
 */
export function TerminalFilePreviewCard({
  file,
  children,
}: {
  file: TerminalFile;
  children: ReactElement;
}) {
  const kind = terminalFilePreviewKind(file.path);
  const item = useMemo(() => terminalFileViewerItem(file), [file]);
  const { workspaceId } = file.context;
  if (!kind || !workspaceId) return children;
  return (
    // The card can't be clicked into, so it closes as the pointer leaves the row, even toward it;
    // otherwise the next row down, between this row and the card, keeps this row's card.
    <Tooltip delayDuration={400} disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="left"
        align="start"
        sideOffset={12}
        className="flex w-72 flex-col overflow-hidden p-0"
      >
        <PreviewBody workspaceId={workspaceId} item={item} kind={kind} />
        <div className="truncate border-t p-2 font-mono text-2xs text-muted-foreground">
          {file.path}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
