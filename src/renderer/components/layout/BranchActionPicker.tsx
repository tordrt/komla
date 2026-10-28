import {
  GitBranch,
  GitMerge,
  GitFork,
  GitDiff,
  ArrowsClockwise,
  Cloud,
  CaretDown,
  CaretRight,
  ArrowsLeftRight,
  Trash,
  Plus,
} from '@phosphor-icons/react';
import { useState } from 'react';

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import type { BranchInfo } from '@/types';

export interface BranchActionPickerProps {
  branches: BranchInfo[];
  isLoading: boolean;
  currentBranch?: string;
  mainBranch: string;
  /** Repository default branch; protected from deletion like the target branch. */
  defaultBranch?: string;
  behindTargetBranch: number;
  remoteExpanded: boolean;
  onRemoteExpandedChange: (expanded: boolean) => void;
  onLoadBranches: () => void;
  onFetch: (e: React.MouseEvent) => Promise<void>;
  isFetching: boolean;
  hasOriginRemote: boolean;
  onSwitch: (branchName: string) => void;
  onMerge: (branchName: string) => void;
  onRebase: (branchName: string) => void;
  onDelete: (branchName: string, isRemote: boolean) => void;
  onCompare: (branchName: string) => void;
  onCreate: (branchName: string) => void;
  isCreating: boolean;
  isSwitching: boolean;
  isMerging: boolean;
  isRebasing: boolean;
  isDeleting: boolean;
  allowCompare?: boolean;
  allowDelete?: boolean;
}

interface BranchRowProps {
  branch: BranchInfo;
  /** Checked out in this workspace. */
  isCurrent: boolean;
  /** The workspace's target branch. */
  isTarget: boolean;
  isProtected: boolean;
  isActionsOpen: boolean;
  behindCount: number | undefined;
  isAnyActionRunning: boolean;
  isSwitching: boolean;
  isMerging: boolean;
  isRebasing: boolean;
  isDeleting: boolean;
  onActionsOpenChange: (open: boolean) => void;
  onSwitch: (branchName: string) => void;
  onMerge: (branchName: string) => void;
  onRebase: (branchName: string) => void;
  onDelete: (branchName: string, isRemote: boolean) => void;
  onCompare: (branchName: string) => void;
  allowCompare: boolean;
  allowDelete: boolean;
}

function BranchIcon({ isRemoteOnly }: { isRemoteOnly?: boolean }) {
  return isRemoteOnly ? (
    <Cloud className="size-4 shrink-0 text-info" />
  ) : (
    <GitBranch className="size-4 shrink-0" />
  );
}

function BranchLabel({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 text-xs text-muted-foreground">{children}</span>;
}

function BranchRow({
  branch,
  isCurrent,
  isTarget,
  isProtected,
  isActionsOpen,
  behindCount,
  isAnyActionRunning,
  isSwitching,
  isMerging,
  isRebasing,
  isDeleting,
  onActionsOpenChange,
  onSwitch,
  onMerge,
  onRebase,
  onDelete,
  onCompare,
  allowCompare,
  allowDelete,
}: BranchRowProps) {
  if (isCurrent) {
    return (
      <DropdownMenuItem disabled className="opacity-50">
        <BranchIcon isRemoteOnly={branch.isRemoteOnly} />
        <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
          {branch.name}
        </span>
        {isTarget && <BranchLabel>target</BranchLabel>}
        <BranchLabel>checked out</BranchLabel>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuSub
      open={isActionsOpen}
      onOpenChange={(open) => {
        onActionsOpenChange(open);
      }}
    >
      <DropdownMenuSubTrigger
        onPointerMove={(event) => {
          event.preventDefault();
        }}
        onPointerEnter={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          onActionsOpenChange(!isActionsOpen);
        }}
      >
        <BranchIcon isRemoteOnly={branch.isRemoteOnly} />
        <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
          {branch.name}
        </span>
        {isTarget && <BranchLabel>target</BranchLabel>}
        {(behindCount ?? 0) > 0 && (
          <span className="shrink-0 text-xs text-behind">↓{behindCount}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuItem
          onClick={() => onSwitch(branch.name)}
          disabled={isAnyActionRunning}
          className="gap-2"
        >
          {isSwitching ? <Spinner /> : <ArrowsLeftRight />}
          Switch
        </DropdownMenuItem>
        {allowCompare && (
          <DropdownMenuItem onClick={() => onCompare(branch.name)}>
            <GitDiff />
            Compare
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => onMerge(branch.name)}
          disabled={isAnyActionRunning}
          className="gap-2"
        >
          {isMerging ? <Spinner /> : <GitMerge />}
          Merge
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onRebase(branch.name)}
          disabled={isAnyActionRunning}
          className="gap-2"
        >
          {isRebasing ? <Spinner /> : <GitFork />}
          Rebase
        </DropdownMenuItem>
        {allowDelete && !isProtected && (
          <DropdownMenuItem
            onClick={() => onDelete(branch.name, branch.isRemoteOnly ?? false)}
            disabled={isAnyActionRunning}
            variant="destructive"
          >
            {isDeleting ? <Spinner /> : <Trash />}
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

interface RemoteBranchesHeaderProps {
  remoteCount: number;
  remoteExpanded: boolean;
  onRemoteExpandedChange: (expanded: boolean) => void;
  isFetching: boolean;
  onFetch: (e: React.MouseEvent) => void;
}

function RemoteBranchesHeader({
  remoteCount,
  remoteExpanded,
  onRemoteExpandedChange,
  isFetching,
  onFetch,
}: RemoteBranchesHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground">
      <div
        className="flex flex-1 cursor-pointer items-center gap-1.5"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemoteExpandedChange(!remoteExpanded);
        }}
      >
        {remoteExpanded ? <CaretDown className="size-3" /> : <CaretRight className="size-3" />}
        <Cloud className="size-3" />
        Remote ({remoteCount})
      </div>
      <div
        className={cn(
          'flex items-center gap-1 rounded-sm px-1.5 py-0.5',
          isFetching ? 'opacity-50' : 'cursor-pointer hover:bg-accent'
        )}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!isFetching) onFetch(e);
        }}
        title={isFetching ? 'Fetching...' : 'Fetch from remote'}
      >
        <ArrowsClockwise className={cn('size-3.5', isFetching && 'animate-spin')} />
        {isFetching ? 'Fetching' : 'Fetch'}
      </div>
    </div>
  );
}

export function BranchActionPicker({
  branches,
  isLoading,
  currentBranch,
  mainBranch,
  defaultBranch,
  behindTargetBranch,
  remoteExpanded,
  onRemoteExpandedChange,
  onLoadBranches,
  onFetch,
  isFetching,
  hasOriginRemote,
  onSwitch,
  onMerge,
  onRebase,
  onDelete,
  onCompare,
  onCreate,
  isCreating,
  isSwitching,
  isMerging,
  isRebasing,
  isDeleting,
  allowCompare = true,
  allowDelete = true,
}: BranchActionPickerProps) {
  const [filter, setFilter] = useState('');
  const [openBranchActions, setOpenBranchActions] = useState<string | null>(null);

  const isAnyActionRunning = isSwitching || isMerging || isRebasing || isDeleting;

  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase())
  );
  const localBranches = filteredBranches.filter((b) => !b.isRemoteOnly);
  const remoteBranches = filteredBranches.filter((b) => b.isRemoteOnly);

  // Show create option when filter text doesn't exactly match any existing branch
  const trimmedFilter = filter.trim();
  const exactMatch = trimmedFilter && branches.some((b) => b.name === trimmedFilter);
  const showCreateOption = trimmedFilter && !exactMatch && !isLoading;

  // behindTargetBranch is measured against the target branch only.
  const getBehindCount = (branchName: string): number | undefined => {
    if (branchName === mainBranch) {
      return behindTargetBranch > 0 ? behindTargetBranch : undefined;
    }
    return undefined;
  };

  const renderBranch = (branch: BranchInfo) => {
    const branchActionKey = `${branch.isRemoteOnly ? 'remote' : 'local'}:${branch.name}`;

    return (
      <BranchRow
        key={branchActionKey}
        branch={branch}
        isCurrent={branch.name === currentBranch}
        isTarget={branch.name === mainBranch}
        isProtected={branch.name === mainBranch || branch.name === defaultBranch}
        isActionsOpen={openBranchActions === branchActionKey}
        behindCount={getBehindCount(branch.name)}
        isAnyActionRunning={isAnyActionRunning}
        isSwitching={isSwitching}
        isMerging={isMerging}
        isRebasing={isRebasing}
        isDeleting={isDeleting}
        onActionsOpenChange={(open) => setOpenBranchActions(open ? branchActionKey : null)}
        onSwitch={onSwitch}
        onMerge={onMerge}
        onRebase={onRebase}
        onDelete={onDelete}
        onCompare={onCompare}
        allowCompare={allowCompare}
        allowDelete={allowDelete}
      />
    );
  };

  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open) {
          onLoadBranches();
        } else {
          setFilter('');
          setOpenBranchActions(null);
        }
      }}
    >
      <DropdownMenuSubTrigger>
        <GitBranch />
        <span>Branches</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto !pt-0">
        {/* Sticky header with search */}
        <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
          <input
            type="text"
            placeholder="Filter or create branch..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && showCreateOption) {
                e.preventDefault();
                onCreate(trimmedFilter);
              }
            }}
          />
        </div>

        {/* Branch list */}
        <div className="p-1">
          {/* Create new branch option */}
          {showCreateOption && (
            <DropdownMenuItem
              onClick={() => onCreate(trimmedFilter)}
              disabled={isCreating || isAnyActionRunning}
              className="gap-2"
            >
              {isCreating ? <Spinner /> : <Plus />}
              <span className="flex-1 truncate">
                Create <span className="font-medium">{trimmedFilter}</span>
              </span>
            </DropdownMenuItem>
          )}
          {isLoading ? (
            <DropdownMenuItem disabled>
              <Spinner />
              <span>Loading...</span>
            </DropdownMenuItem>
          ) : filteredBranches.length === 0 && !showCreateOption ? (
            <DropdownMenuItem disabled>
              <span className="text-muted-foreground">
                {filter ? 'No matching branches' : 'No branches'}
              </span>
            </DropdownMenuItem>
          ) : (
            <>
              {/* Remote branches (collapsible with fetch) */}
              {hasOriginRemote && (
                <>
                  <RemoteBranchesHeader
                    remoteCount={remoteBranches.length}
                    remoteExpanded={remoteExpanded}
                    onRemoteExpandedChange={onRemoteExpandedChange}
                    isFetching={isFetching}
                    onFetch={(e) => void onFetch(e)}
                  />
                  {remoteExpanded && remoteBranches.map(renderBranch)}
                  {localBranches.length > 0 && <div className="my-1 border-t" />}
                </>
              )}

              {/* Local branches */}
              {localBranches.map(renderBranch)}
            </>
          )}
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
