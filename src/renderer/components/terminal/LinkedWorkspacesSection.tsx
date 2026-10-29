import {
  ArrowUpRight,
  CaretDown,
  CaretRight,
  Copy,
  FolderOpen,
  LinkBreak,
  LinkSimple,
  MagnifyingGlass,
  Plus,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LinkWorkspacesDialog } from '@/components/workspaces/LinkWorkspacesDialog';
import {
  getWorkspaceDisplayTitle,
  WorkspaceInfoCardContent,
} from '@/components/workspaces/WorkspaceInfoCard';
import { joinAbsPath } from '@/lib/fs-path';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { AT_PATH_MIME, setTreeDragActive } from '@/lib/tree-drag-token';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace, type Workspace } from '@/types';

/**
 * The workspaces linked to this one, below its file tree: each by its title, to open, with the
 * path agents use for it, `linked-workspaces/<name>`, on drag and in its menu. The changes view
 * shows what changed in each, apart from this workspace's own changes.
 */
export function LinkedWorkspacesSection({
  workspace,
  showChanges,
}: {
  workspace: Workspace;
  showChanges: boolean;
}) {
  const linkedIds = workspace.linkedWorkspaceIds;
  // Only the linked workspaces, so another workspace's update doesn't re-render the rows.
  const peers = useWorkspacesStore(
    useShallow((s) =>
      (linkedIds ?? [])
        .map((id) => s.workspaces.find((candidate) => candidate.id === id))
        .filter((peer): peer is Workspace => peer !== undefined)
    )
  );
  const linkPaths = useLinkPaths(workspace.id, linkedIds);
  const [collapsed, setCollapsed] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  if (peers.length === 0) return null;
  return (
    <section
      aria-label="Linked workspaces"
      // A container, so a narrow panel (150px at least) gets the shorter label and counts.
      className="bg-sidebar-muted/40 @container shrink-0 border-t border-border/60 pt-0.5 pb-1"
    >
      <div className="flex h-7 items-center gap-1 pr-1 pl-2">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-label="Linked workspaces"
          className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase hover:text-foreground"
        >
          {collapsed ? (
            <CaretRight className="size-3 shrink-0" />
          ) : (
            <CaretDown className="size-3 shrink-0" />
          )}
          <span className="truncate">
            Linked<span className="@max-[219px]:hidden"> workspaces</span>
          </span>
          <span className="shrink-0 font-medium text-muted-foreground/70">{peers.length}</span>
        </button>
        <IconButton
          label="Link workspaces"
          onClick={() => setLinkDialogOpen(true)}
          className="size-6 rounded-md hover:bg-muted/60"
        >
          <Plus className="size-3.5" />
        </IconButton>
      </div>
      {!collapsed &&
        peers.map((peer) => (
          <LinkedWorkspaceRow
            key={peer.id}
            workspace={workspace}
            peer={peer}
            path={linkPaths.get(peer.id)}
            showChanges={showChanges}
          />
        ))}
      {linkDialogOpen && (
        <LinkWorkspacesDialog
          open={linkDialogOpen}
          onOpenChange={setLinkDialogOpen}
          workspace={workspace}
        />
      )}
    </section>
  );
}

const LINK_PATHS_RETRY_MS = [2_000, 10_000, 30_000];

/**
 * Each linked workspace's symlink path, fetched again when the links change, and a few times
 * more after a failure, as when an SSH host was briefly out of reach.
 */
function useLinkPaths(workspaceId: string, linkedIds: string[] | undefined): Map<string, string> {
  const ids = [...(linkedIds ?? [])].sort().join();
  // Which workspace and links the fetched paths are for.
  const key = `${workspaceId}:${ids}`;
  const [fetched, setFetched] = useState<{ key: string; paths: Map<string, string> }>();
  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      window.api
        .getWorkspaceLinkPaths(workspaceId)
        .then((links) => {
          if (cancelled) return;
          setFetched({
            key: `${workspaceId}:${ids}`,
            paths: new Map(links.map((link) => [link.workspaceId, link.path])),
          });
        })
        .catch(() => {
          const delay = LINK_PATHS_RETRY_MS[attempt];
          if (!cancelled && delay !== undefined) retry = setTimeout(() => load(attempt + 1), delay);
        });
    };
    load(0);
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [workspaceId, ids]);
  // Another workspace's paths, or ones from before the links changed, aren't these.
  return fetched?.key === key ? fetched.paths : NO_PATHS;
}

const NO_PATHS = new Map<string, string>();

function LinkedWorkspaceRow({
  workspace,
  peer,
  path,
  showChanges,
}: {
  workspace: Workspace;
  peer: Workspace;
  path: string | undefined;
  showChanges: boolean;
}) {
  const project = useProjectsStore((s) =>
    peer.projectId ? s.projects.find((candidate) => candidate.id === peer.projectId) : undefined
  );
  const sshHost = useSshHostsStore((s) =>
    isSshWorkspace(peer) ? (s.hosts.find((host) => host.id === peer.backend.hostId) ?? null) : null
  );
  const source = project?.name ?? peer.repoName;
  const subtitle = [source, peer.branchName].filter(Boolean).join(' · ');
  const remote = isSshWorkspace(workspace);
  const absolutePath =
    path &&
    (isSshWorkspace(workspace)
      ? `${workspace.backend.remoteDirectory}/${path}`
      : joinAbsPath(workspace.workingDirectory, path));

  const open = () => void useWorkspacesStore.getState().selectWorkspace(peer.id);
  const browse = () => {
    const fileViewer = useFileViewerStore.getState();
    fileViewer.setInlineFileTreeOpen(peer.id, true);
    fileViewer.setInlineFileTreeMode(peer.id, 'browse');
    open();
  };
  const copy = (text: string) => {
    window.api.copyToClipboard(text);
    useToastStore.getState().addToast(`Copied ${text.trim()}`, 'success');
  };
  const unlink = () => {
    void useWorkspacesStore
      .getState()
      .unlinkWorkspace(workspace.id, peer.id)
      .catch((error: unknown) => {
        useToastStore.getState().addToast(`Couldn't unlink: ${(error as Error).message}`, 'error');
      });
  };

  return (
    <ContextMenu>
      {/* Its card's details on hover, as the dashboard and the agents panel show them. */}
      <Tooltip delayDuration={400}>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={open}
              draggable={!!path}
              onDragStart={(event) => {
                if (!path) return;
                // As a folder dragged from the tree: a terminal pastes `@<path>/ `.
                event.dataTransfer.setData(AT_PATH_MIME, `@${path}/ `);
                event.dataTransfer.setData('text/plain', `${path}/`);
                setTreeDragActive(true);
              }}
              onDragEnd={() => setTreeDragActive(false)}
              className="group mx-1 flex w-[calc(100%-8px)] items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-hidden"
            >
              <LinkSimple className="mt-0.5 size-3.5 shrink-0 text-primary" />
              {/* The title has the row to itself; the project, branch and changes share the line
              below, where the changes stay and the rest truncates. */}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {getWorkspaceDisplayTitle(peer)}
                  </span>
                  {!showChanges && (
                    <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  )}
                </span>
                {(subtitle || showChanges) && (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {subtitle}
                    </span>
                    {showChanges && peer.isWorktree && <PeerChanges peer={peer} />}
                  </span>
                )}
              </span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent
          side="left"
          align="end"
          className="w-[min(20rem,calc(100vw-2rem))] rounded-[calc(var(--radius)+2px)] p-0 shadow-xl select-text"
        >
          <WorkspaceInfoCardContent workspace={peer} sshHost={sshHost}>
            {path && (
              <span className="block truncate font-mono text-2xs text-muted-foreground">
                {path}/
              </span>
            )}
          </WorkspaceInfoCardContent>
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onSelect={open}>
          <ArrowUpRight />
          Open workspace
        </ContextMenuItem>
        <ContextMenuItem onSelect={browse}>
          <FolderOpen />
          Browse its files
        </ContextMenuItem>
        {path && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => copy(`@${path}/ `)}>
              <Copy />
              Copy @path
            </ContextMenuItem>
            {absolutePath && (
              <ContextMenuItem onSelect={() => copy(absolutePath)}>
                <Copy />
                Copy absolute path
              </ContextMenuItem>
            )}
            {!remote && absolutePath && (
              <ContextMenuItem onSelect={() => window.api.showItemInFolder(absolutePath)}>
                <MagnifyingGlass />
                {getRevealInFileManagerLabel()}
              </ContextMenuItem>
            )}
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={unlink} variant="destructive">
          <LinkBreak />
          Unlink
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** What changed in a linked workspace, as its card counts it; words only where there's room. */
function PeerChanges({ peer }: { peer: Workspace }) {
  const remote = isSshWorkspace(peer);
  const cached = useFileListStore((s) =>
    s.getDiff(peer.workingDirectory, undefined, false, remote ? peer.id : undefined)
  );
  // As its card's changes pill loads them: statuses carry the counts without the diff's text. An
  // SSH peer is on the host this workspace is on, which is connected while its panel shows.
  useEffect(() => {
    const fileLists = useFileListStore.getState();
    if (remote) void fileLists.fetchDiffIfNeeded(peer.workingDirectory, undefined, false, peer.id);
    else void fileLists.fetchFileStatusesIfNeeded(peer.workingDirectory);
  }, [peer.workingDirectory, peer.id, remote]);

  // A first load starts out empty, which isn't "No changes" yet.
  if (!cached || (cached.isLoading && cached.data.files.length === 0)) return null;
  const diff = cached.data;
  if (diff.files.length === 0) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground @max-[239px]:hidden">
        No changes
      </span>
    );
  }
  const { additions, deletions } = diff.summary;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <span className="@max-[239px]:hidden">{diff.files.length} changed</span>
      {additions > 0 && <span className="font-mono text-success">+{additions}</span>}
      {deletions > 0 && <span className="font-mono text-error">−{deletions}</span>}
    </span>
  );
}
