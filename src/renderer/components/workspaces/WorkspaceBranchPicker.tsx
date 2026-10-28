import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Cloud,
  GitBranch,
  HardDrives,
} from '@phosphor-icons/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { stopWheelPropagation } from '@/lib/dialog-scroll-lock';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import type { BranchInfo } from '@/types';

export interface BranchPickerMeta {
  isRemoteOnly: boolean;
  /** Only the SSH host's clone has the branch; origin doesn't. */
  onHost?: true;
}

/** `unpushed`: only this computer has the branch, so an SSH host can't start from it. */
type BranchSource = 'local' | 'remote' | 'host' | 'unpushed';

const BRANCH_SOURCE_ICON = {
  local: GitBranch,
  remote: Cloud,
  host: HardDrives,
  unpushed: GitBranch,
};
const BRANCH_SOURCE_ICON_CLASS = {
  local: '',
  remote: 'text-info',
  host: 'text-cyan-700 dark:text-cyan-400',
  unpushed: '',
};
const BRANCH_SOURCE_BADGE: Partial<Record<BranchSource, string>> = {
  remote: 'origin only',
  unpushed: 'not pushed',
};

function branchPickerMeta(branch: BranchInfo, source: BranchSource): BranchPickerMeta {
  return source === 'host'
    ? { isRemoteOnly: false, onHost: true }
    : { isRemoteOnly: branch.isRemoteOnly };
}

interface WorkspaceBranchPickerProps {
  /** Trigger content, e.g. "from main" */
  trigger: React.ReactNode;
  triggerClassName?: string;
  projectId: string;
  repoPath: string;
  /** The SSH host the workspace launches on, whose clone's branches are listed too */
  sshHost?: { id: string; name: string };
  /** Selected base branch ('' = project default) */
  baseBranch: string;
  /** Branches already checked out by a workspace */
  usedBranches: string[];
  /** Workspace that has a branch open, so the picker can jump to it */
  findWorkspaceForBranch: (branch: string) => { id: string; name: string } | undefined;
  onSelectBase: (branch: string, meta: BranchPickerMeta) => void;
  onOpenBranch: (branch: string, meta: BranchPickerMeta) => void;
  onGoToWorkspace: (workspaceId: string) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** Controls the menu, such as for a shortcut that opens it */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Searchable branch list for the new workspace dialog. Selecting a row picks
 * the base for a new branch; the row's "Open" item opens a workspace on that
 * exact branch instead.
 */
export function WorkspaceBranchPicker({
  trigger,
  triggerClassName,
  projectId,
  repoPath,
  sshHost,
  baseBranch,
  usedBranches,
  findWorkspaceForBranch,
  onSelectBase,
  onOpenBranch,
  onGoToWorkspace,
  onCloseAutoFocus,
  open,
  onOpenChange,
}: WorkspaceBranchPickerProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [hasOriginRemote, setHasOriginRemote] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const { config, updateConfig } = useConfigStore();
  const remoteExpanded = config?.remoteBranchesExpanded ?? false;

  const loadBranches = useCallback(async () => {
    if (!repoPath) return;
    setIsLoading(true);
    try {
      const [branchList, hasRemote] = await Promise.all([
        window.api.listBranches(repoPath, true),
        window.api.hasOriginRemote(repoPath),
      ]);
      setBranches(branchList);
      setHasOriginRemote(hasRemote);
    } catch {
      setBranches([]);
    } finally {
      setIsLoading(false);
    }
  }, [repoPath]);

  // Opening by click or by shortcut lists the branches afresh.
  useEffect(() => {
    if (open) void loadBranches();
  }, [open, loadBranches]);

  const host = useHostBranches(open, projectId, sshHost?.id);

  const handleFetch = async () => {
    if (isFetching) return;
    setIsFetching(true);
    try {
      await window.api.fetchProject(projectId);
      setBranches(await window.api.listBranches(repoPath, true));
    } catch {
      // Keep the current list; the user can fetch again.
    } finally {
      setIsFetching(false);
    }
  };

  const usedSet = new Set(usedBranches);
  const lowerFilter = filter.toLowerCase();
  const filteredBranches = branches.filter((branch) =>
    branch.name.toLowerCase().includes(lowerFilter)
  );
  const selectedBase = baseBranch.replace(/^origin\//, '');

  const renderBranch = (branch: BranchInfo, source: BranchSource) => {
    const meta = branchPickerMeta(branch, source);
    const BranchIcon = BRANCH_SOURCE_ICON[source];
    const badge = BRANCH_SOURCE_BADGE[source];
    const isUsed = usedSet.has(branch.name);

    return (
      <div key={`${branch.name}-${source}`} className="group flex items-center gap-1">
        <DropdownMenuItem
          onSelect={() => onSelectBase(branch.name, meta)}
          disabled={source === 'unpushed'}
          className="min-w-0 flex-1 gap-2"
          aria-label={`Start from ${branch.name}`}
        >
          <BranchIcon className={cn('size-3.5 shrink-0', BRANCH_SOURCE_ICON_CLASS[source])} />
          <span className="min-w-0 flex-1 truncate font-mono text-ui">{branch.name}</span>
          {badge && (
            <span className="shrink-0 rounded bg-muted px-1 text-2xs text-muted-foreground">
              {badge}
            </span>
          )}
          {branch.name === selectedBase && (
            <span className="shrink-0 text-2xs text-muted-foreground">base</span>
          )}
        </DropdownMenuItem>
        <BranchRowAction
          branch={branch.name}
          workspace={isUsed ? findWorkspaceForBranch(branch.name) : undefined}
          isUsed={isUsed}
          canOpen={source !== 'unpushed'}
          onOpen={() => onOpenBranch(branch.name, meta)}
          onGoToWorkspace={onGoToWorkspace}
        />
      </div>
    );
  };

  // Without origin, launching offers to publish the branch; an unreachable host leaves it unknown.
  const { hostOnlyNames, unpushedNames } = sortForHost(
    branches,
    host.names,
    hasOriginRemote && host.loaded
  );
  const hostOnlyBranches = [...hostOnlyNames]
    .filter((name) => name.toLowerCase().includes(lowerFilter))
    .map((name) => ({ name, isRemoteOnly: false }));
  const remoteBranches = filteredBranches.filter((branch) => branch.isRemoteOnly);
  const localBranches = filteredBranches.filter(
    (branch) => !branch.isRemoteOnly && !hostOnlyNames.has(branch.name)
  );
  // Searching shows remote matches even while the section is collapsed.
  const showRemoteBranches = remoteExpanded || Boolean(filter);

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName} title="Choose what to start from">
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="max-h-80 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto !pt-0"
        onWheel={stopWheelPropagation}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          filterInputRef.current?.focus();
        }}
        // Runs however the menu closed, including when a shortcut opened another one.
        onCloseAutoFocus={(event) => {
          setFilter('');
          onCloseAutoFocus?.(event);
        }}
      >
        <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
          <input
            ref={filterInputRef}
            type="text"
            aria-label="Search branches"
            placeholder="Search branches…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
          />
        </div>
        <DropdownMenuLabel>Start a new branch from</DropdownMenuLabel>
        {hasOriginRemote && (
          <>
            <div className="flex items-center gap-1.5 px-2 py-1 text-ui font-medium text-muted-foreground">
              <button
                type="button"
                aria-expanded={remoteExpanded}
                className="flex flex-1 items-center gap-1.5"
                onClick={() => void updateConfig({ remoteBranchesExpanded: !remoteExpanded })}
              >
                {remoteExpanded ? (
                  <CaretDown className="size-3" />
                ) : (
                  <CaretRight className="size-3" />
                )}
                <Cloud className="size-3" />
                Remote ({remoteBranches.length})
              </button>
              <button
                type="button"
                disabled={isFetching}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 enabled:hover:bg-accent disabled:opacity-50"
                onClick={() => void handleFetch()}
                title="Fetch from remote"
              >
                <ArrowsClockwise className={cn('size-3.5', isFetching && 'animate-spin')} />
                {isFetching ? 'Fetching' : 'Fetch'}
              </button>
            </div>
            {showRemoteBranches && remoteBranches.map((branch) => renderBranch(branch, 'remote'))}
            <DropdownMenuSeparator />
          </>
        )}
        <HostBranchesSection hostName={sshHost?.name} isLoading={host.isLoading}>
          {hostOnlyBranches.map((branch) => renderBranch(branch, 'host'))}
        </HostBranchesSection>
        {isLoading ? (
          <DropdownMenuItem disabled className="text-xs">
            <Spinner size="sm" />
            Loading…
          </DropdownMenuItem>
        ) : filteredBranches.length + hostOnlyBranches.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            {filter ? 'No matching branches' : 'No branches found'}
          </DropdownMenuItem>
        ) : (
          localBranches.map((branch) =>
            renderBranch(branch, localBranchSource(branch.name, unpushedNames))
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A branch checked out elsewhere can still be a start point, but cannot be opened again;
 * the row offers to jump to its workspace instead.
 */
function BranchRowAction({
  branch,
  workspace,
  isUsed,
  canOpen,
  onOpen,
  onGoToWorkspace,
}: {
  branch: string;
  workspace: { id: string; name: string } | undefined;
  isUsed: boolean;
  canOpen: boolean;
  onOpen: () => void;
  onGoToWorkspace: (workspaceId: string) => void;
}) {
  if (workspace) {
    return (
      <DropdownMenuItem
        onSelect={() => onGoToWorkspace(workspace.id)}
        className="max-w-32 shrink-0 px-2 text-ui text-muted-foreground"
        aria-label={`Go to ${workspace.name}`}
      >
        <span className="truncate">Go to {workspace.name}</span>
      </DropdownMenuItem>
    );
  }
  if (isUsed) return <span className="shrink-0 px-2 text-2xs text-muted-foreground">in use</span>;
  if (!canOpen) return null;
  return (
    <DropdownMenuItem
      onSelect={onOpen}
      className="shrink-0 px-2 text-ui font-medium opacity-0 group-hover:opacity-100 focus:opacity-100"
      aria-label={`Open ${branch}`}
      title={`Open a workspace on ${branch}`}
    >
      Open
    </DropdownMenuItem>
  );
}

function localBranchSource(name: string, unpushedNames: Set<string>): BranchSource {
  return unpushedNames.has(name) ? 'unpushed' : 'local';
}

/** The SSH host's branches, shown while they load and when the host has any. */
function HostBranchesSection({
  hostName,
  isLoading,
  children,
}: {
  hostName: string | undefined;
  isLoading: boolean;
  children: React.ReactNode[];
}) {
  if (!hostName || (!isLoading && children.length === 0)) return null;
  return (
    <>
      <div className="flex items-center gap-1.5 px-2 py-1 text-ui font-medium text-muted-foreground">
        <HardDrives className="size-3" />
        <span className="min-w-0 truncate">On {hostName}</span>
        {isLoading && <Spinner size="sm" />}
      </div>
      {children}
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * The SSH host's local branches, loaded over SSH while the menu is open. `loaded` is false
 * until the host answers, and stays false when it can't be reached.
 */
function useHostBranches(open: boolean, projectId: string, sshHostId: string | undefined) {
  const [names, setNames] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || !sshHostId) return;
    let cancelled = false;
    setIsLoading(true);
    window.api
      .listProjectHostBranches(projectId, sshHostId)
      .then(
        (hostBranches) => {
          if (cancelled) return;
          setNames(hostBranches);
          setLoaded(true);
        },
        () => undefined
      )
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      setNames([]);
      setIsLoading(false);
      setLoaded(false);
    };
  }, [open, projectId, sshHostId]);

  return { names, isLoading, loaded };
}

/**
 * Where an SSH host starts each branch from. Origin's branches start from origin's copy, so
 * `hostOnlyNames` are the host's other branches and `unpushedNames`, when `flagUnpushed`, the
 * ones neither has.
 */
function sortForHost(branches: BranchInfo[], hostBranches: string[], flagUnpushed: boolean) {
  // The host fetches only origin, so another remote's branches don't count.
  const originNames = new Set(
    branches
      .filter((branch) => branch.remoteRef?.startsWith('origin/'))
      .map((branch) => branch.name)
  );
  const hostOnlyNames = new Set(hostBranches.filter((name) => !originNames.has(name)));
  if (!flagUnpushed) return { hostOnlyNames, unpushedNames: new Set<string>() };
  const unpushedNames = new Set(
    branches
      .filter(
        (branch) =>
          !branch.isRemoteOnly && !originNames.has(branch.name) && !hostOnlyNames.has(branch.name)
      )
      .map((branch) => branch.name)
  );
  return { hostOnlyNames, unpushedNames };
}
