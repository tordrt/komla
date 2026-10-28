import { ArrowRight, ArrowSquareOut, Monitor } from '@phosphor-icons/react';

import { formatPreviewUrl, isNonHttpListener } from '@/lib/dev-preview-candidates';
import { parseLoopbackForwardIntent } from '@/lib/scan-terminal-urls';
import { cn } from '@/lib/utils';

import { virtualDesktopDisplay } from '../../../shared/lib/virtual-desktops';
import { isLocalTerminalExecutionLocation } from '../../../shared/types/terminal';

import { LinkPreviewHoverCard, LinkPreviewIcon } from './LinkPreviewCard';

import type {
  LinkPreview,
  WorkspaceRecentLink,
  WorkspaceVirtualDesktop,
} from '../../../shared/types';
import type { PreviewUrlCandidate } from '@/lib/dev-preview-candidates';
import type { MouseEvent, ReactNode } from 'react';

interface RowProps {
  active: boolean;
  onOpen: (event: MouseEvent) => void;
  onHover: () => void;
}

/** The icon a row shows on hover: out to the default browser, or into Komla's. */
function OpenIcon({ opensExternally }: { opensExternally: boolean }) {
  const Icon = opensExternally ? ArrowSquareOut : ArrowRight;
  return <Icon className="size-3 shrink-0" />;
}

function RowButton({
  url,
  preview,
  title,
  active,
  onOpen,
  onHover,
  children,
}: RowProps & {
  url: string;
  preview: LinkPreview | undefined;
  title?: string;
  children: ReactNode;
}) {
  return (
    <LinkPreviewHoverCard url={url} preview={preview}>
      <button
        type="button"
        title={title}
        data-active={active || undefined}
        onClick={onOpen}
        onMouseMove={onHover}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
          active && 'bg-muted'
        )}
      >
        {children}
      </button>
    </LinkPreviewHoverCard>
  );
}

function StatusDot({ live }: { live: boolean | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        live === true && 'bg-success',
        live === false && 'border border-muted-foreground/60',
        live === undefined && 'bg-muted-foreground/40'
      )}
    />
  );
}

/** What runs a server and how it answers, as in ":5173 · Vite" or "uvicorn · JSON". */
function serverDetail(candidate: PreviewUrlCandidate, preview: LinkPreview | undefined): string {
  const processName = candidate.service?.processName ?? candidate.otherServer?.processName;
  return [
    // What serves the page, as in "Vite", says more than the process, as in "node".
    preview?.servedBy ?? processName,
    preview?.isJson && 'JSON',
    isNonHttpListener(candidate) && 'not HTTP',
    candidate.live === false && 'not running',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A server's port and path, as in ":5173" or ":3000/admin". */
function shortAddress(url: string): string {
  return formatPreviewUrl(url).replace(/^(?:https:\/\/)?(?:localhost|127\.0\.0\.1)(?=:)/, '');
}

export function ServerRow({
  candidate,
  preview,
  isSshWorkspace,
  opensExternally,
  ...row
}: RowProps & {
  candidate: PreviewUrlCandidate;
  preview: LinkPreview | undefined;
  isSshWorkspace: boolean;
  opensExternally: boolean;
}) {
  const remotePort =
    isSshWorkspace && !isLocalTerminalExecutionLocation(candidate.executionLocation)
      ? parseLoopbackForwardIntent(candidate.url)?.remotePort
      : undefined;
  const detail = serverDetail(candidate, preview);
  const dim = candidate.live === false || isNonHttpListener(candidate);
  return (
    <RowButton url={candidate.url} preview={preview} {...row}>
      <StatusDot live={candidate.live} />
      <LinkPreviewIcon preview={preview} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          !preview?.title && 'font-mono',
          dim ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {preview?.title ?? formatPreviewUrl(candidate.url)}
      </span>
      <span className="max-w-[50%] shrink-0 truncate text-2xs text-muted-foreground group-hover:hidden">
        {preview?.title && <span className="font-mono">{shortAddress(candidate.url)}</span>}
        {preview?.title && detail && ' · '}
        {detail}
      </span>
      <span className="hidden shrink-0 items-center gap-1 text-2xs text-muted-foreground group-hover:flex">
        {remotePort ? `Forward ${remotePort}` : 'Open'}
        <OpenIcon opensExternally={opensExternally} />
      </span>
    </RowButton>
  );
}

/** A link as the list shows it: the host, then the rest of the address. */
function linkParts(input: string): { host: string; rest: string } {
  try {
    const url = new URL(input);
    const rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
    return { host: url.host, rest };
  } catch {
    return { host: input, rest: '' };
  }
}

function LinkText({ url, preview }: { url: string; preview: LinkPreview | undefined }) {
  const { host, rest } = linkParts(url);
  if (preview?.title) {
    return (
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-foreground">{preview.title}</span>
        <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-2xs text-muted-foreground">
          {host}
        </span>
      </span>
    );
  }
  if (preview?.fromSite && preview.siteName) {
    // Only the site is known, so the path says which of its pages this is.
    return (
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-foreground">{preview.siteName}</span>
        <span className="truncate font-mono text-2xs text-muted-foreground">{rest || host}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-baseline font-mono">
      <span className="shrink-0 text-foreground">{host}</span>
      <span className="truncate text-muted-foreground">{rest}</span>
    </span>
  );
}

export function LinkRow({
  link,
  preview,
  opensExternally,
  ...row
}: RowProps & {
  link: WorkspaceRecentLink;
  preview: LinkPreview | undefined;
  opensExternally: boolean;
}) {
  return (
    <RowButton
      url={link.url}
      preview={preview}
      title={preview?.imageUrl || preview?.description ? undefined : link.url}
      {...row}
    >
      <LinkPreviewIcon preview={preview} />
      <LinkText url={link.url} preview={preview} />
      <span className="hidden text-muted-foreground group-hover:block">
        <OpenIcon opensExternally={opensExternally} />
      </span>
    </RowButton>
  );
}

/**
 * A virtual desktop: the app it's named after and its display, and on hover where a click
 * opens it, this computer's VNC app or Komla's browser.
 */
export function DesktopRow({ desktop, ...row }: RowProps & { desktop: WorkspaceVirtualDesktop }) {
  const display = virtualDesktopDisplay(desktop);
  return (
    <button
      type="button"
      title={desktop.app ? `${desktop.app} on ${display}` : undefined}
      data-active={row.active || undefined}
      onClick={row.onOpen}
      onMouseMove={row.onHover}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
        row.active && 'bg-muted'
      )}
    >
      <StatusDot live />
      <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn('min-w-0 flex-1 truncate text-foreground', desktop.app && 'font-mono')}>
        {desktop.app ?? 'Virtual desktop'}
      </span>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground group-hover:hidden">
        {display}
      </span>
      <span className="hidden shrink-0 items-center gap-1 text-2xs text-muted-foreground group-hover:flex">
        {desktop.vncApp ? `Open in ${desktop.vncApp}` : 'Open'}
        <OpenIcon opensExternally={!!desktop.vncApp} />
      </span>
    </button>
  );
}

/** The row at the end of a group that shows the rest of it. */
export function ShowMoreRow({ count, ...row }: RowProps & { count: number }) {
  return (
    <button
      type="button"
      data-active={row.active || undefined}
      onClick={row.onOpen}
      onMouseMove={row.onHover}
      className={cn(
        'w-full rounded-md px-2 py-1 text-left text-2xs text-muted-foreground hover:text-foreground',
        row.active && 'bg-muted text-foreground'
      )}
    >
      Show {count} more…
    </button>
  );
}
