import { ClockCounterClockwise, Copy, GitCommit } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  layoutCommitGraph,
  type CommitGraphRow,
} from '@/components/commit-graph/commit-graph-layout';
import { splitCommitMessage } from '@/components/commit-graph/commit-message';
import { CommitContextMenu } from '@/components/commit-graph/CommitContextMenu';
import {
  COMMIT_GRAPH_ROW_HEIGHT,
  CommitGraphLanes,
} from '@/components/commit-graph/CommitGraphLanes';
import { CommitRefPill } from '@/components/commit-graph/CommitRefPill';
import { copyCommitHash } from '@/components/commit-graph/copy-commit-hash';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/format-time';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useWorkspaceObservationStore } from '@/stores/workspace-observation.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { resolveWorkspaceTargetBranch, type Workspace } from '@/types';

import { StatusBarButton } from './StatusBarButton';

import type { CommitGraph } from '../../../../shared/types/commit-graph';
import type * as React from 'react';

const PAGE_SIZE = 100;
// The most the main process hands out at once.
const MAX_COMMITS = 500;
const SHOWN_REFS = 2;

/** C, or the key in C's place on a layout without Latin letters. */
function isCopyKey(event: React.KeyboardEvent): boolean {
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === 'c' : event.code === 'KeyC';
}

// How long the pointer stays still on a commit before its details show.
const DETAILS_DELAY = 500;
// The room beside the menu that the details need, and the gap they keep from it.
const DETAILS_ROOM = 300;
const DETAILS_GAP = 6;
// How far around the point the pointer left from its path may start, for a hand that wobbles.
const PATH_SLACK = 5;

interface CommitDetailsPlacement {
  hash: string;
  row: HTMLElement;
  side: 'right' | 'left' | 'top';
  sideOffset: number;
}

// Beside the menu where the window leaves room, so the details cover none of the graph; over the
// rows above otherwise, as beside it they would run off the window's edge.
function placeCommitDetails(hash: string, row: HTMLElement): CommitDetailsPlacement {
  const menu = row.closest('[role="menu"]')?.getBoundingClientRect();
  const { left, right } = row.getBoundingClientRect();
  if (menu && window.innerWidth - menu.right >= DETAILS_ROOM) {
    return { hash, row, side: 'right', sideOffset: menu.right - right + DETAILS_GAP };
  }
  if (menu && menu.left >= DETAILS_ROOM) {
    return { hash, row, side: 'left', sideOffset: left - menu.left + DETAILS_GAP };
  }
  return { hash, row, side: 'top', sideOffset: 4 };
}

interface Point {
  x: number;
  y: number;
}

/** The pointer's way from where it left one element to another: the least convex area holding both. */
function pathToward(from: Point, target: DOMRect): Point[] {
  const points = [
    { x: from.x - PATH_SLACK, y: from.y - PATH_SLACK },
    { x: from.x + PATH_SLACK, y: from.y - PATH_SLACK },
    { x: from.x - PATH_SLACK, y: from.y + PATH_SLACK },
    { x: from.x + PATH_SLACK, y: from.y + PATH_SLACK },
    { x: target.left, y: target.top },
    { x: target.right, y: target.top },
    { x: target.left, y: target.bottom },
    { x: target.right, y: target.bottom },
  ].sort((a, b) => a.x - b.x || a.y - b.y);
  // Andrew's monotone chain: the lower edge left to right, then the upper one back.
  const turnsLeft = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) > 0;
  const chain = (list: Point[]) => {
    const edge: Point[] = [];
    for (const point of list) {
      while (edge.length >= 2 && !turnsLeft(edge[edge.length - 2], edge[edge.length - 1], point)) {
        edge.pop();
      }
      edge.push(point);
    }
    return edge.slice(0, -1);
  };
  return [...chain(points), ...chain([...points].reverse())];
}

function isInside({ x, y }: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Which commit's details show: one the pointer has rested on, so passing over rows on the way to
 * another shows nothing. Beside the menu they stay while the pointer heads from the row onto them,
 * across rows on the way, and back, so their text can be selected and copied; leaving any other
 * way hides them.
 */
function useCommitDetails() {
  const [shown, setShown] = useState<CommitDetailsPlacement | null>(null);
  const pending = useRef<{ hash: string; timer: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  // The way the pointer takes from the row to the details, or back.
  const [way, setWay] = useState<{ hash: string; path: Point[]; target: HTMLElement } | null>(null);
  const cancel = () => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
  };
  useEffect(() => cancel, []);
  // Hides the details once the pointer strays from its way.
  useEffect(() => {
    if (!way) return;
    const onMove = (event: PointerEvent) => {
      if (event.target instanceof Node && way.target.contains(event.target)) {
        setWay(null);
      } else if (!isInside({ x: event.clientX, y: event.clientY }, way.path)) {
        setWay(null);
        setShown((current) => (current?.hash === way.hash ? null : current));
      }
    };
    document.addEventListener('pointermove', onMove);
    return () => document.removeEventListener('pointermove', onMove);
  }, [way]);
  const followPointer = (hash: string, from: Point, target: HTMLElement) =>
    setWay({ hash, path: pathToward(from, target.getBoundingClientRect()), target });
  const hide = () => {
    cancel();
    setWay(null);
    setShown(null);
  };
  return {
    shown,
    card,
    rest: (hash: string, row: HTMLElement) => {
      if (shown?.hash === hash) return;
      cancel();
      const timer = window.setTimeout(() => {
        pending.current = null;
        setWay(null);
        setShown(placeCommitDetails(hash, row));
      }, DETAILS_DELAY);
      pending.current = { hash, timer };
    },
    leave: (hash: string, event: React.PointerEvent) => {
      if (pending.current?.hash === hash) cancel();
      if (shown?.hash !== hash) return;
      // Over the rows above, the details let the pointer through to them instead.
      if (shown.side === 'top' || !card.current) hide();
      else followPointer(hash, { x: event.clientX, y: event.clientY }, card.current);
    },
    leaveCard: (event: React.PointerEvent) => {
      // A selection dragged past their edge keeps them.
      if (shown && event.buttons === 0) {
        followPointer(shown.hash, { x: event.clientX, y: event.clientY }, shown.row);
      }
    },
    hide,
  };
}

function CommitDetails({ row }: { row: CommitGraphRow }) {
  const { commit, refs } = row;
  const { title, body } = splitCommitMessage(commit.message);
  return (
    <>
      <p className="text-[13px] leading-[18px] font-medium">{title || '(no message)'}</p>
      {body && (
        <p className="mt-1.5 line-clamp-10 leading-relaxed whitespace-pre-line text-muted-foreground">
          {body}
        </p>
      )}
      <div className="mt-2 flex items-center gap-3 border-t border-foreground/10 pt-2 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {commit.author} ·{' '}
          {new Date(commit.timestamp * 1000).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </span>
        <button
          type="button"
          aria-label={`Copy commit hash ${commit.hash}`}
          title={`Copy hash (${window.api.platform === 'darwin' ? '⌘C' : 'Ctrl+C'})`}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-sm font-mono hover:text-foreground"
          onClick={() => copyCommitHash(commit.hash)}
        >
          {commit.hash.slice(0, 7)}
          <Copy aria-hidden="true" className="size-3" />
        </button>
      </div>
      {refs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {refs.map((gitRef) => (
            <CommitRefPill
              key={`${gitRef.kind}:${gitRef.name}`}
              gitRef={gitRef}
              className="max-w-full"
            />
          ))}
        </div>
      )}
    </>
  );
}

function CommitRow({
  row,
  isHead,
  details,
  cardRef,
  onRest,
  onLeave,
  onLeaveCard,
  onDismiss,
  onSelect,
}: {
  row: CommitGraphRow;
  isHead: boolean;
  details: CommitDetailsPlacement | null;
  cardRef: React.Ref<HTMLDivElement>;
  onRest: (row: HTMLElement) => void;
  onLeave: (event: React.PointerEvent) => void;
  onLeaveCard: (event: React.PointerEvent) => void;
  onDismiss: () => void;
  onSelect: () => void;
}) {
  const { commit, refs } = row;
  const subject = splitCommitMessage(commit.message).title || '(no message)';
  const hiddenRefs = refs.length - SHOWN_REFS;
  return (
    <Tooltip
      open={details !== null}
      // The details follow the pointer on their own way, not the tooltip's.
      disableHoverableContent
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <CommitContextMenu hash={commit.hash}>
        <DropdownMenuItem
          textValue={subject}
          onSelect={onSelect}
          onPointerMove={(event) => {
            if (event.pointerType !== 'touch') onRest(event.currentTarget);
          }}
          onPointerLeave={onLeave}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && isCopyKey(event)) {
              event.preventDefault();
              claimShortcutEvent(event.nativeEvent);
              copyCommitHash(commit.hash);
            }
          }}
          // Stays highlighted while its right-click menu is open.
          className="gap-1.5 rounded-sm py-0 pr-2 pl-0 data-[state=open]:bg-foreground/8"
          style={{ height: COMMIT_GRAPH_ROW_HEIGHT }}
        >
          {/* Only places the details: the row opens them by resting on it, not the tooltip's own
              hover delay or the focus menu items take on hover. */}
          <TooltipTrigger asChild>
            <span aria-hidden="true" className="pointer-events-none absolute inset-0" />
          </TooltipTrigger>
          <CommitGraphLanes row={row} isHead={isHead} />
          <span className={cn('min-w-0 flex-1 truncate text-xs', isHead && 'font-medium')}>
            {subject}
          </span>
          {refs.slice(0, SHOWN_REFS).map((gitRef) => (
            <CommitRefPill key={`${gitRef.kind}:${gitRef.name}`} gitRef={gitRef} />
          ))}
          {hiddenRefs > 0 && (
            <span className="shrink-0 text-[10px] text-muted-foreground">+{hiddenRefs}</span>
          )}
          <span className="w-6 shrink-0 text-right text-2xs text-muted-foreground tabular-nums">
            {formatRelativeTime(commit.timestamp * 1000)}
          </span>
        </DropdownMenuItem>
      </CommitContextMenu>
      <TooltipContent
        // Only while shown: details still fading out would let go of it on unmounting.
        ref={details ? cardRef : undefined}
        side={details?.side}
        sideOffset={details?.sideOffset}
        align="start"
        collisionPadding={8}
        onPointerLeave={onLeaveCard}
        className={cn(
          'w-max max-w-[min(22rem,var(--radix-tooltip-content-available-width))] px-3 py-2.5 select-text',
          // Over the rows above, lets the pointer through to them.
          details?.side === 'top' && 'pointer-events-none'
        )}
      >
        <CommitDetails row={row} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Reads the workspace's history while the menu is open, again whenever its repository changes. */
function useCommitGraph(workspace: Workspace, open: boolean, limit: number) {
  const repositoryRevision = useWorkspaceObservationStore(
    (s) => s.projections.get(workspace.id)?.repositoryRevision
  );
  const [result, setResult] = useState<{ graph: CommitGraph | null; error: string | null }>();
  const workspaceId = workspace.id;
  useEffect(() => {
    if (!open) return;
    let current = true;
    window.api.getWorkspaceCommitGraph(workspaceId, { limit }).then(
      (graph: CommitGraph) => {
        if (current) setResult({ graph, error: null });
      },
      (error: unknown) => {
        if (current) {
          setResult({ graph: null, error: error instanceof Error ? error.message : String(error) });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [open, workspaceId, limit, repositoryRevision]);
  return result;
}

function CommitGraphMenu({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const openedViewer = useRef(false);
  const details = useCommitDetails();
  const result = useCommitGraph(workspace, open, limit);
  const graph = result?.graph ?? null;
  const historyShortcut = useShortcutsStore((s) => s.getDisplayShortcut('history.toggle'));
  const projectBaseBranch = useProjectsStore(
    (s) => s.projects.find((project) => project.id === workspace.projectId)?.baseBranch
  );
  const statusTargetBranch = useGitStatusStore(
    (s) => s.getStatus(workspace.id)?.status?.mainBranch
  );
  const targetBranch =
    resolveWorkspaceTargetBranch(workspace, projectBaseBranch, statusTargetBranch) || 'main';
  const rows = useMemo(
    () =>
      graph
        ? layoutCommitGraph(graph.commits, {
            currentBranch: graph.currentBranch,
            upstream: graph.upstream,
            targetBranch,
          })
        : [],
    [graph, targetBranch]
  );
  const branch = graph ? graph.currentBranch : workspace.branchName;
  const openHistory = (commitHash?: string) => {
    openedViewer.current = true;
    useFileViewerStore.getState().requestFileViewerTransition({
      kind: 'mode',
      workspaceId: workspace.id,
      mode: 'diff',
      diffSubMode: 'history',
      after: commitHash ? { kind: 'commit', commitHash } : undefined,
    });
  };

  let body: React.ReactNode;
  if (rows.length > 0 && graph) {
    body = (
      <DropdownMenuGroup
        className="thin-scrollbar max-h-[min(30rem,60vh)] overflow-y-auto"
        // Scrolling puts another commit under the pointer.
        onScroll={details.hide}
      >
        {rows.map((row, index) => (
          <CommitRow
            key={row.commit.hash}
            row={row}
            isHead={index === 0}
            details={details.shown?.hash === row.commit.hash ? details.shown : null}
            cardRef={details.card}
            onRest={(element) => details.rest(row.commit.hash, element)}
            onLeave={(event) => details.leave(row.commit.hash, event)}
            onLeaveCard={details.leaveCard}
            onDismiss={details.hide}
            onSelect={() => openHistory(row.commit.hash)}
          />
        ))}
        {graph.hasMore && limit < MAX_COMMITS && (
          <DropdownMenuItem
            className="justify-center text-xs text-muted-foreground"
            onSelect={(event) => {
              // Stays open, with the older commits added below.
              event.preventDefault();
              setLimit((current) => Math.min(current + PAGE_SIZE, MAX_COMMITS));
            }}
          >
            Show older commits
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
    );
  } else {
    let message = 'Loading commits…';
    if (result?.error) message = `Couldn't read the commits: ${result.error}`;
    else if (graph) message = 'No commits yet';
    body = <p className="px-2 py-1 text-2xs text-muted-foreground">{message}</p>;
  }

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setLimit(PAGE_SIZE);
          details.hide();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <StatusBarButton aria-label="Commit graph" tooltip="Commit graph">
          <GitCommit aria-hidden="true" className="size-3.5" />
        </StatusBarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-[28rem] max-w-[calc(100vw-1rem)] min-w-0"
        onCloseAutoFocus={(event) => {
          // Focus stays with the viewer the menu opened, not the button behind it.
          if (openedViewer.current) event.preventDefault();
          openedViewer.current = false;
        }}
      >
        <div className="flex items-center gap-2">
          <DropdownMenuLabel className="min-w-0 flex-1 truncate">
            {branch ? `Commits on ${branch}` : 'Commits'}
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => openHistory()}
            className="shrink-0 gap-1.5 py-0.5 pr-1.5 pl-1.5 text-xs"
          >
            <ClockCounterClockwise />
            Open history
            {historyShortcut && (
              <DropdownMenuShortcut className="pl-1.5">{historyShortcut}</DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
        </div>
        {body}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The open workspace's commit graph, for git workspaces. */
export function CommitGraphStatusSegment() {
  const workspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
  );
  if (!workspace?.isWorktree) return null;
  // Keyed, so one workspace's commits never show under another's.
  return <CommitGraphMenu key={workspace.id} workspace={workspace} />;
}
