import {
  CaretRight,
  CircleDashed,
  File,
  HardDrives,
  LinkSimple,
  Monitor,
} from '@phosphor-icons/react';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { Spinner } from '@/components/ui/spinner';
import { usePreviewUrlCandidates, type OwnPortsAnswer } from '@/hooks/useDevPreviewServices';
import {
  candidatePreviewTarget,
  linkPreviewKey,
  useLinkPreviews,
  type LinkPreviewTarget,
} from '@/hooks/useLinkPreviews';
import {
  MAX_CHECKED_PORTS,
  rankPopoverServers,
  type PreviewUrlCandidate,
} from '@/lib/dev-preview-candidates';
import { rememberTerminalLinks } from '@/lib/recent-links';
import { parseLoopbackForwardIntent } from '@/lib/scan-terminal-urls';
import { cn } from '@/lib/utils';
import { defaultVirtualDesktopTarget, type VirtualDesktopTarget } from '@/lib/virtual-desktops';
import { terminalFileKey, type TerminalFile } from '@/stores/terminal-files.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { virtualDesktopViewerPort } from '../../../shared/lib/virtual-desktops';
import { isSshWorkspace } from '../../../shared/types';
import { isLocalTerminalExecutionLocation } from '../../../shared/types/terminal';

import { DesktopRow, LinkRow, ServerRow, ShowMoreRow } from './BrowserLinkRows';
import { OpenInPaneMenu, VirtualDesktopMenu, type OpenInTarget } from './OpenInPaneMenu';
import { FileRow } from './TerminalFileRow';

import type {
  LinkPreview,
  WorkspaceRecentLink,
  WorkspaceVirtualDesktop,
} from '../../../shared/types';
import type { PaneSurfacePlacement } from '@/lib/pane-surfaces';

const NO_LINKS: WorkspaceRecentLink[] = [];
const NO_FILES: TerminalFile[] = [];
const NO_DESKTOPS: WorkspaceVirtualDesktop[] = [];
// How long the server list waits for page titles, which decide what it folds away.
const TITLE_WAIT_MS = 1_000;
// Links shown before "Show more".
const LINKS_SHOWN = 8;
// Files shown before "Show more".
const FILES_SHOWN = 8;

/** A row picked from the list: a server, or a link. */
export type BrowserLinkPick =
  | { kind: 'server'; candidate: PreviewUrlCandidate }
  | { kind: 'link'; link: WorkspaceRecentLink };

type Row =
  | { kind: 'server'; key: string; candidate: PreviewUrlCandidate }
  | { kind: 'link'; key: string; link: WorkspaceRecentLink }
  | { kind: 'file'; key: string; file: TerminalFile }
  | { kind: 'desktop'; key: string; desktop: WorkspaceVirtualDesktop }
  | { kind: 'more'; key: string; group: Group; count: number };

type Group = 'servers' | 'desktops' | 'links' | 'files' | 'outside';

/** The rows of each group as shown, in keyboard order. */
function buildRows({
  candidates,
  desktops,
  links,
  files,
  expanded,
  serverPreview,
}: {
  candidates: PreviewUrlCandidate[];
  desktops: WorkspaceVirtualDesktop[];
  links: WorkspaceRecentLink[];
  files: TerminalFile[];
  expanded: Record<Group, boolean>;
  serverPreview: (candidate: PreviewUrlCandidate) => LinkPreview | undefined;
}): { rows: Record<Group, Row[]>; counts: Record<Group, number> } {
  const ranked = rankPopoverServers(candidates, (candidate) => serverPreview(candidate)?.title);
  const serverRow = (candidate: PreviewUrlCandidate): Row => ({
    kind: 'server',
    key: `server:${candidate.executionLocation}:${candidate.url}`,
    candidate,
  });
  const linkRow = (link: WorkspaceRecentLink): Row => ({
    kind: 'link',
    key: `link:${link.url}`,
    link,
  });

  const servers = (expanded.servers ? [...ranked.shown, ...ranked.more] : ranked.shown).map(
    serverRow
  );
  if (!expanded.servers && ranked.more.length > 0) {
    servers.push({
      kind: 'more',
      key: 'more:servers',
      group: 'servers',
      count: ranked.more.length,
    });
  }
  const shownLinks = expanded.links ? links : links.slice(0, LINKS_SHOWN);
  const linkRows = shownLinks.map(linkRow);
  if (shownLinks.length < links.length) {
    linkRows.push({
      kind: 'more',
      key: 'more:links',
      group: 'links',
      count: links.length - shownLinks.length,
    });
  }
  const shownFiles = expanded.files ? files : files.slice(0, FILES_SHOWN);
  const fileRows = shownFiles.map((file): Row => ({
    kind: 'file',
    key: `file:${terminalFileKey(file)}`,
    file,
  }));
  if (shownFiles.length < files.length) {
    fileRows.push({
      kind: 'more',
      key: 'more:files',
      group: 'files',
      count: files.length - shownFiles.length,
    });
  }
  // Servers outside Komla come into view only when none of the workspace's runs in view.
  const outsideInView =
    expanded.outside || ranked.shown.every((candidate) => candidate.live === false);
  const outside = outsideInView ? ranked.outside.map(serverRow) : [];
  if (outside.length < ranked.outside.length) {
    outside.push({
      kind: 'more',
      key: 'more:outside',
      group: 'outside',
      count: ranked.outside.length,
    });
  }
  const desktopRows = desktops.map((desktop): Row => ({
    kind: 'desktop',
    key: `desktop:${desktop.vncPort}`,
    desktop,
  }));
  return {
    rows: { servers, desktops: desktopRows, links: linkRows, files: fileRows, outside },
    counts: {
      servers: ranked.shown.length + ranked.more.length,
      desktops: desktops.length,
      links: links.length,
      files: files.length,
      outside: ranked.outside.length,
    },
  };
}

type DesktopState = 'runs' | 'stopped' | 'unknown';

/**
 * Whether a desktop runs by `own`: it runs when shown since the check began, or when one of
 * this user's processes listens on its VNC port; it stopped when its port was checked and
 * none does. Without an answer, or for a port it didn't check, that's unknown: a desktop
 * that stopped may have left its port to another user's.
 */
function desktopState(desktop: WorkspaceVirtualDesktop, own: OwnPortsAnswer | null): DesktopState {
  if (!own) return 'unknown';
  if (desktop.shownAt >= own.checkedAt || own.openPorts.has(desktop.vncPort)) return 'runs';
  return own.checkedPorts.has(desktop.vncPort) ? 'stopped' : 'unknown';
}

/** The saved desktops that run by `own`. Main forgets the stopped ones, unless shown since. */
function useRunningDesktops(
  workspaceId: string,
  saved: WorkspaceVirtualDesktop[],
  own: OwnPortsAnswer | null
): WorkspaceVirtualDesktop[] {
  const stopped = useMemo(
    () =>
      saved
        .filter((desktop) => desktopState(desktop, own) === 'stopped')
        .map(({ vncPort }) => vncPort),
    [own, saved]
  );
  useEffect(() => {
    if (!own || stopped.length === 0) return;
    void window.api.forgetVirtualDesktops(workspaceId, stopped, own.checkedAt);
  }, [own, stopped, workspaceId]);
  return useMemo(
    () => saved.filter((desktop) => desktopState(desktop, own) === 'runs'),
    [own, saved]
  );
}

/**
 * The servers and links of the workspace, with their pages' details once read. The
 * servers show once their titles arrive, or after TITLE_WAIT_MS, since titles decide
 * which come first; once shown, they stay. Given `listsDesktops`, its running virtual
 * desktops too.
 */
function useBrowserLinks(
  workspaceId: string,
  servers: { candidates: PreviewUrlCandidate[]; ready: boolean } | undefined,
  linksExpanded: boolean,
  listsDesktops: boolean
) {
  const links = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.recentLinks ?? NO_LINKS
  );
  const isSsh = useWorkspacesStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId);
    return !!workspace && isSshWorkspace(workspace);
  });
  // Desktops are checked along with the workspace's own servers, so only without `servers`.
  const savedDesktops = useWorkspacesStore(
    (s) =>
      (listsDesktops && servers === undefined
        ? s.workspaces.find((w) => w.id === workspaceId)?.virtualDesktops
        : undefined) ?? NO_DESKTOPS
  );
  const checkedDesktops = useMemo(() => savedDesktops.slice(0, MAX_CHECKED_PORTS), [savedDesktops]);
  const desktopPorts = useMemo(
    () => checkedDesktops.map((desktop) => desktop.vncPort),
    [checkedDesktops]
  );
  // Servers the caller already looks for aren't looked for again.
  const ownServers = usePreviewUrlCandidates(
    workspaceId,
    isSsh,
    servers === undefined,
    desktopPorts
  );
  const { candidates: found, ready } = servers ?? ownServers;
  // A desktop's noVNC page carries its password in its address, and the desktop's row opens
  // it in Komla, so its server outside Komla and the address `komla desktop status` prints
  // aren't listed, where a click would hand them to the default browser.
  const viewerPorts = useMemo(
    () => new Set(savedDesktops.flatMap((desktop) => virtualDesktopViewerPort(desktop) ?? [])),
    [savedDesktops]
  );
  const candidates = useMemo(
    () =>
      viewerPorts.size === 0
        ? found
        : found.filter((candidate) => {
            const onWorkspaceMachine =
              !isSsh || !isLocalTerminalExecutionLocation(candidate.executionLocation);
            const port = parseLoopbackForwardIntent(candidate.url)?.remotePort;
            return !(onWorkspaceMachine && port !== undefined && viewerPorts.has(port));
          }),
    [found, isSsh, viewerPorts]
  );
  // While a check with other ports is on its way, as for a desktop just added, the last
  // answer for this workspace stands for the ports it checked; once one comes back
  // unknown, so are the desktops.
  const [lastOwn, setLastOwn] = useState<OwnPortsAnswer | null>(null);
  if (ownServers.ready && ownServers.own !== lastOwn) setLastOwn(ownServers.own);
  const own =
    ownServers.own ?? (!ownServers.ready && lastOwn?.workspaceId === workspaceId ? lastOwn : null);
  const desktops = useRunningDesktops(workspaceId, savedDesktops, own);
  const desktopsChecking = checkedDesktops.length > 0 && !own && !ownServers.ready;
  const previewTargets = useMemo(
    () => [
      ...candidates.flatMap((candidate) => candidatePreviewTarget(candidate, isSsh) ?? []),
      // Only the links shown have their pages read.
      ...(linksExpanded ? links : links.slice(0, LINKS_SHOWN)).map((link): LinkPreviewTarget => ({
        url: link.url,
        onSshHost: false,
      })),
    ],
    [candidates, isSsh, links, linksExpanded]
  );
  const { previews, answered } = useLinkPreviews(workspaceId, previewTargets, true);
  const serverKey = (candidate: PreviewUrlCandidate) => {
    const target = candidatePreviewTarget(candidate, isSsh);
    return target ? linkPreviewKey(target) : undefined;
  };

  const [titleWaitOver, setTitleWaitOver] = useState(false);
  const [serversShown, setServersShown] = useState(false);
  const titlesAnswered = candidates.every((candidate) => {
    const key = serverKey(candidate);
    return !key || answered.has(key);
  });
  if (ready && !serversShown && (titlesAnswered || titleWaitOver)) setServersShown(true);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setTitleWaitOver(true), TITLE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  return {
    links,
    isSsh,
    desktops,
    desktopsChecking,
    candidates: serversShown ? candidates : [],
    serversShown,
    serverPreview: (candidate: PreviewUrlCandidate) => {
      const key = serverKey(candidate);
      return key ? previews.get(key) : undefined;
    },
    linkPreview: (link: WorkspaceRecentLink) =>
      previews.get(linkPreviewKey({ url: link.url, onSshHost: false })),
  };
}

const GROUP_LOOKS: Record<Group, { label: string; icon: typeof File; chip: string }> = {
  servers: { label: 'Servers', icon: HardDrives, chip: 'bg-success/15 text-success' },
  desktops: { label: 'Desktops', icon: Monitor, chip: 'bg-attention/15 text-attention' },
  links: { label: 'Links', icon: LinkSimple, chip: 'bg-info/15 text-info' },
  files: { label: 'Files', icon: File, chip: 'bg-warning/15 text-warning' },
  outside: { label: 'Outside Komla', icon: CircleDashed, chip: 'bg-muted text-muted-foreground' },
};

/** A group's icon in its color, which tells the groups apart at a glance. */
function GroupChip({ group }: { group: Group }) {
  const { icon: Icon, chip } = GROUP_LOOKS[group];
  return (
    <span
      aria-hidden
      className={cn('flex size-5 shrink-0 items-center justify-center rounded-md', chip)}
    >
      <Icon weight="bold" className="size-3" />
    </span>
  );
}

function GroupTitle({
  group,
  count,
  children,
}: {
  group: Group;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-semibold text-foreground">
      <GroupChip group={group} />
      {GROUP_LOOKS[group].label}
      {count !== undefined && (
        <span className="text-2xs font-normal text-muted-foreground">{count}</span>
      )}
      {children}
    </div>
  );
}

/** The servers outside Komla while they're folded away: one row that shows them. */
function OutsideRow({
  count,
  active,
  onOpen,
  onHover,
}: {
  count: number;
  active: boolean;
  onOpen: (event: { shiftKey: boolean }) => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      data-active={active || undefined}
      onClick={onOpen}
      onMouseMove={onHover}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground hover:text-foreground',
        active && 'bg-muted text-foreground'
      )}
    >
      <GroupChip group="outside" />
      {GROUP_LOOKS.outside.label}
      <span className="text-2xs font-normal">
        {count} {count === 1 ? 'server' : 'servers'}
      </span>
      <CaretRight className="ml-auto size-3" />
    </button>
  );
}

/**
 * The workspace's servers, then, given `desktops`, its virtual desktops while they run, then
 * the links its terminals printed or you opened, then, given
 * `files`, its terminals' files, then the servers outside Komla, as the globe button and
 * the Komla browser's address field and empty tab list them. Mount it only while shown: it reads the terminals' links and the
 * pages' details when it mounts. Without `servers`, it looks for the workspace's servers
 * itself. The arrow keys and Enter pick a row once the list has focus.
 */
export function BrowserLinksList({
  workspaceId,
  servers,
  onPick,
  opensExternally,
  emptyText,
  files,
  desktops,
  onPickIn,
  listRef,
  className,
}: {
  workspaceId: string;
  servers?: { candidates: PreviewUrlCandidate[]; ready: boolean };
  onPick: (pick: BrowserLinkPick, event: { shiftKey: boolean }) => void;
  /** Whether rows open in the default browser, which their hover icon shows. */
  opensExternally: boolean;
  emptyText: string;
  /** The terminals' files, the opened ones first, and what picking one or opening them all does. */
  files?: {
    files: TerminalFile[];
    onPick: (file: TerminalFile) => void;
    onOpenAll: () => void;
    /** Opens a workspace file in a pane, which its row offers on right-click. */
    onOpenInPane?: (file: TerminalFile, placement: PaneSurfacePlacement) => void;
  };
  /** Opens a virtual desktop where a click or its row's right-click menu says. Needs no `servers`. */
  desktops?: {
    onOpen: (desktop: WorkspaceVirtualDesktop, target: VirtualDesktopTarget) => void;
  };
  /** Opens a server or link where its row's right-click menu says. Without it, rows have no menu. */
  onPickIn?: (pick: BrowserLinkPick, target: OpenInTarget) => void;
  /** Set to the list, which the caller focuses to give the arrow keys to it. */
  listRef?: RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const [expanded, setExpanded] = useState({
    servers: false,
    desktops: false,
    links: false,
    files: false,
    outside: false,
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const ownListRef = useRef<HTMLDivElement>(null);
  const listElementRef = listRef ?? ownListRef;
  const data = useBrowserLinks(workspaceId, servers, expanded.links, desktops !== undefined);

  useEffect(() => {
    rememberTerminalLinks(workspaceId);
  }, [workspaceId]);

  const { rows: groups, counts } = buildRows({
    ...data,
    files: files?.files ?? NO_FILES,
    expanded,
  });
  const rows = [
    ...groups.servers,
    ...groups.desktops,
    ...groups.links,
    ...groups.files,
    ...groups.outside,
  ];
  const active = Math.min(activeIndex, rows.length - 1);

  const pick = (row: Row, event: { shiftKey: boolean }) => {
    if (row.kind === 'more') {
      setExpanded((current) => ({ ...current, [row.group]: true }));
      return;
    }
    if (row.kind === 'file') {
      files?.onPick(row.file);
      return;
    }
    if (row.kind === 'desktop') {
      const { desktop } = row;
      desktops?.onOpen(
        desktop,
        event.shiftKey && desktop.url ? 'preview' : defaultVirtualDesktopTarget(desktop)
      );
      return;
    }
    onPick(
      row.kind === 'server'
        ? { kind: 'server', candidate: row.candidate }
        : { kind: 'link', link: row.link },
      event
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((active + step + rows.length) % rows.length);
      requestAnimationFrame(() =>
        listElementRef.current
          ?.querySelector('[data-active]')
          ?.scrollIntoView?.({ block: 'nearest' })
      );
      // A row reached with Tab opens itself.
    } else if (event.key === 'Enter' && event.target === listElementRef.current && rows[active]) {
      event.preventDefault();
      pick(rows[active], event);
    }
  };

  const renderRow = (row: Row) => {
    const index = rows.indexOf(row);
    const common = {
      active: index === active,
      onHover: () => setActiveIndex(index),
      onOpen: (event: { shiftKey: boolean }) => pick(row, event),
    };
    if (row.kind === 'more' && row.group === 'outside') {
      return <OutsideRow key={row.key} {...common} count={row.count} />;
    }
    if (row.kind === 'more') return <ShowMoreRow key={row.key} {...common} count={row.count} />;
    if (row.kind === 'desktop') {
      const { desktop } = row;
      const element = <DesktopRow key={row.key} {...common} desktop={desktop} />;
      if (!desktops || (!desktop.vncApp && !desktop.url)) return element;
      return (
        <VirtualDesktopMenu
          key={row.key}
          vncApp={desktop.vncApp}
          hasPage={!!desktop.url}
          onOpen={(target) => desktops.onOpen(desktop, target)}
        >
          {element}
        </VirtualDesktopMenu>
      );
    }
    if (row.kind === 'file') {
      const { file } = row;
      const element = <FileRow key={row.key} {...common} file={file} />;
      const openInPane = files?.onOpenInPane;
      // A pane shows only the workspace's own files, and no folders.
      if (!openInPane || file.target.type !== 'workspace' || /[\\/]$/.test(file.path)) {
        return element;
      }
      return (
        <OpenInPaneMenu
          key={row.key}
          isPage={false}
          onOpen={(target) => {
            if (typeof target === 'object') openInPane(file, target);
          }}
        >
          {element}
        </OpenInPaneMenu>
      );
    }
    const picked: BrowserLinkPick =
      row.kind === 'server'
        ? { kind: 'server', candidate: row.candidate }
        : { kind: 'link', link: row.link };
    const element =
      row.kind === 'server' ? (
        <ServerRow
          key={row.key}
          {...common}
          candidate={row.candidate}
          preview={data.serverPreview(row.candidate)}
          isSshWorkspace={data.isSsh}
          opensExternally={opensExternally}
        />
      ) : (
        <LinkRow
          key={row.key}
          {...common}
          link={row.link}
          preview={data.linkPreview(row.link)}
          opensExternally={opensExternally}
        />
      );
    if (!onPickIn) return element;
    return (
      <OpenInPaneMenu key={row.key} isPage onOpen={(target) => onPickIn(picked, target)}>
        {element}
      </OpenInPaneMenu>
    );
  };

  // Folded away, the servers outside Komla are one row, which names the group itself.
  const outsideFolded = groups.outside.length === 1 && groups.outside[0].kind === 'more';
  const sections = [
    (!data.serversShown || groups.servers.length > 0) && {
      key: 'servers',
      content: (
        <>
          <GroupTitle group="servers" count={data.serversShown ? counts.servers : undefined} />
          {!data.serversShown && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
              <Spinner size="xs" />
              Checking running servers…
            </div>
          )}
          {groups.servers.map(renderRow)}
        </>
      ),
    },
    (data.desktopsChecking || groups.desktops.length > 0) && {
      key: 'desktops',
      content: (
        <>
          <GroupTitle
            group="desktops"
            count={data.desktopsChecking ? undefined : counts.desktops}
          />
          {data.desktopsChecking && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
              <Spinner size="xs" />
              Checking virtual desktops…
            </div>
          )}
          {groups.desktops.map(renderRow)}
        </>
      ),
    },
    groups.links.length > 0 && {
      key: 'links',
      content: (
        <>
          <GroupTitle group="links" count={counts.links} />
          {groups.links.map(renderRow)}
        </>
      ),
    },
    files &&
      groups.files.length > 0 && {
        key: 'files',
        content: (
          <>
            <GroupTitle group="files" count={counts.files}>
              <button
                type="button"
                onClick={files.onOpenAll}
                className="ml-auto text-2xs font-normal text-muted-foreground transition-colors hover:text-foreground"
              >
                Open all in viewer
              </button>
            </GroupTitle>
            {groups.files.map(renderRow)}
          </>
        ),
      },
    groups.outside.length > 0 && {
      key: 'outside',
      content: (
        <>
          {!outsideFolded && <GroupTitle group="outside" count={counts.outside} />}
          {groups.outside.map(renderRow)}
        </>
      ),
    },
  ].filter((section) => !!section);

  const nothingYet =
    data.serversShown &&
    data.candidates.length === 0 &&
    data.desktops.length === 0 &&
    !data.desktopsChecking &&
    data.links.length === 0 &&
    !files?.files.length;

  return (
    <div
      ref={listElementRef}
      role="toolbar"
      aria-orientation="vertical"
      tabIndex={-1}
      aria-label="Servers and links"
      onKeyDown={handleKeyDown}
      className={cn('min-h-0 overflow-y-auto p-1 outline-hidden', className)}
    >
      {nothingYet ? (
        <div className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</div>
      ) : (
        sections.map((section, index) => (
          <Fragment key={section.key}>
            {index > 0 && <div aria-hidden className="mx-2 my-1.5 h-px bg-border/60" />}
            {section.content}
          </Fragment>
        ))
      )}
    </div>
  );
}
