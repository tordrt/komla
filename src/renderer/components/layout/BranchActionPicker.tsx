import {
  GitBranch,
  GitMerge,
  GitFork,
  GitDiff,
  Cloud,
  ArrowsLeftRight,
  Trash,
  Plus,
} from '@phosphor-icons/react';
import { useRef, useState } from 'react';

import {
  BranchFilterInput,
  branchRowKey,
  handleMenuKeyDownAroundFilter,
  RemoteBranchesHeader,
  showsRemoteBranches,
} from '@/components/layout/BranchMenuParts';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';

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
  onFetch: () => Promise<void>;
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
  const inKeyDownRef = useRef(false);
  // A remote row merges and rebases onto the remote's commits, not a local branch of that name.
  const updateRef = (branch.isRemoteOnly && branch.remoteRef) || branch.name;

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
        // A click (below) or a key opens the actions, not hovering the row. The hover is let
        // through rather than stopped on the row: the menu reads it to tell which way the
        // pointer is heading, and without it, it closes actions shown on the left as the
        // pointer leaves for them.
        if (open && !inKeyDownRef.current) return;
        onActionsOpenChange(open);
      }}
    >
      <DropdownMenuSubTrigger
        onKeyDown={() => {
          // The menu decides which keys open the actions, in its handler after this one.
          inKeyDownRef.current = true;
          queueMicrotask(() => {
            inKeyDownRef.current = false;
          });
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
          onClick={() => onMerge(updateRef)}
          disabled={isAnyActionRunning}
          className="gap-2"
        >
          {isMerging ? <Spinner /> : <GitMerge />}
          Merge
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onRebase(updateRef)}
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
  const filterRef = useRef<HTMLInputElement>(null);
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
  const showRemoteBranches = showsRemoteBranches(remoteExpanded, filter);

  // behindTargetBranch is measured against the target branch only.
  const getBehindCount = (branchName: string): number | undefined => {
    if (branchName === mainBranch) {
      return behindTargetBranch > 0 ? behindTargetBranch : undefined;
    }
    return undefined;
  };

  const renderBranch = (branch: BranchInfo) => {
    const branchActionKey = branchRowKey(branch);

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
      <DropdownMenuSubContent
        className="max-h-80 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto !pt-0"
        onKeyDownCapture={(e) => handleMenuKeyDownAroundFilter(e, filterRef.current)}
      >
        {/* Sticky header with search */}
        <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
          <BranchFilterInput
            ref={filterRef}
            value={filter}
            onValueChange={setFilter}
            onEnter={showCreateOption ? () => onCreate(trimmedFilter) : undefined}
            className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
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
                    expanded={remoteExpanded}
                    filter={filter}
                    onExpandedChange={onRemoteExpandedChange}
                    isFetching={isFetching}
                    onFetch={() => void onFetch()}
                  />
                  {showRemoteBranches && remoteBranches.map(renderBranch)}
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
