import { GitBranch } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { getProjectInfo } from '@/components/dashboard/dashboard-view-model';
import { ProjectMark } from '@/components/projects/ProjectMark';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { WorkspaceDetailsCard } from '@/components/workspaces/WorkspaceCard';
import { getWorkspaceDisplayTitle } from '@/components/workspaces/WorkspaceInfoCard';
import { formatRelativeTime } from '@/lib/format-time';
import { openWorkspace } from '@/lib/open-workspace';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/projects.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { Workspace } from '@/types';

/** How many workspaces the empty work area offers to go back to. */
const RECENT_LIMIT = 4;

/**
 * The workspaces touched most recently, as rows to open, for the work area while none is selected:
 * the likeliest next step is going back to one of them.
 */
export function RecentWorkspacesList({ className }: { className?: string }) {
  const workspaces = useWorkspacesStore(useShallow((s) => s.workspaces));
  const currentWindowId = useWindowStore((s) => s.windowId);
  const projects = useProjectsStore((s) => s.projects);
  const projectMap = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  );
  const recent = useMemo(
    () =>
      workspaces
        .filter((workspace) => workspace.status === 'active')
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .slice(0, RECENT_LIMIT),
    [workspaces]
  );
  if (recent.length === 0) return null;
  // 1.5rem wider than the button above it, so the rows' text lines up with its edges and their
  // hover shapes reach past them; wide enough that a long branch rarely truncates.
  return (
    <div className={cn('w-[23.5rem] text-left', className)}>
      <h3 className="mb-1 px-3 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Recent
      </h3>
      <ul aria-label="Recent workspaces">
        {recent.map((workspace) => (
          <li key={workspace.id}>
            <RecentWorkspaceHover workspace={workspace}>
              <button
                type="button"
                onClick={() => void openWorkspace(workspace, currentWindowId)}
                className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {getWorkspaceDisplayTitle(workspace)}
                  </span>
                  {workspace.lastActivityAt > 0 && (
                    <span className="shrink-0 text-ui text-muted-foreground-60 tabular-nums">
                      {formatRelativeTime(workspace.lastActivityAt)}
                    </span>
                  )}
                </span>
                {/* Under the name, as in the palette, so every row's branch starts at one edge. */}
                <RecentWorkspaceMeta
                  workspace={workspace}
                  project={getProjectInfo(workspace, projects, projectMap)}
                />
              </button>
            </RecentWorkspaceHover>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The row's second line, as in the palette's Recent rows: the project, then the branch. */
function RecentWorkspaceMeta({
  workspace,
  project,
}: {
  workspace: Workspace;
  project: ReturnType<typeof getProjectInfo>;
}) {
  const branch = workspace.isWorktree ? workspace.branchName : undefined;
  if (!project && !branch) return null;
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-ui text-muted-foreground-70">
      {project && (
        <>
          <ProjectMark project={project} iconClassName="size-3" />
          <span className="max-w-[40%] shrink-0 truncate">{project.name}</span>
        </>
      )}
      {project && branch && <span aria-hidden>·</span>}
      {branch && (
        <span className="flex min-w-0 items-center gap-1 font-mono">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
    </span>
  );
}

/** How long the pointer rests on a row before its details open, and leaves before they close. */
const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 100;

/** A row's details on hover, the card the sidebar shows for the workspace, beside the row. */
function RecentWorkspaceHover({
  workspace,
  children,
}: {
  workspace: Workspace;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = (next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(next);
    }, delay);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          onPointerEnter={() => schedule(true, OPEN_DELAY_MS)}
          onPointerLeave={() => schedule(false, CLOSE_DELAY_MS)}
          onPointerDown={() => {
            cancel();
            setOpen(false);
          }}
        >
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(20rem,calc(100vw-2rem))] overflow-x-hidden overflow-y-auto p-0 select-text"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancel}
        onPointerLeave={() => schedule(false, CLOSE_DELAY_MS)}
      >
        <WorkspaceDetailsCard workspace={workspace} />
      </PopoverContent>
    </Popover>
  );
}
