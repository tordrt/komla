import {
  CaretDown,
  CaretRight,
  GitBranch,
  ArrowsClockwise,
  Cloud,
  GitDiff,
} from '@phosphor-icons/react';
import React, { useState, useCallback } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfigStore } from '@/stores/config.store';

import type { BranchInfo } from '@/types';

const UNCOMMITTED = 'uncommitted';
const SINCE_TARGET = 'since-target';
const BRANCH_PREFIX = 'branch:';

interface BranchCompareSelectProps {
  /** Branch the working tree is compared with (null = HEAD, i.e. uncommitted changes) */
  value: string | null;
  /** True when `value` is compared from where this branch split off it */
  useMergeBase?: boolean;
  /** The workspace's target branch, offered as "All changes since …" */
  targetBranch?: string;
  /** Available branches to select from */
  branches: BranchInfo[];
  /** Whether branches are loading */
  loading: boolean;
  /** Whether changing the comparison is disabled */
  disabled?: boolean;
  /** Called when "Uncommitted changes" (null) or a branch is selected */
  onBranchChange: (branch: string | null) => void;
  /** Called when "All changes since {targetBranch}" is selected */
  onCompareSinceTarget?: () => void;
  /** Called to load/refresh branches */
  onLoadBranches: () => Promise<void>;
  /** Optional fetch operation before reloading branches */
  onFetchBranches?: () => Promise<void>;
}

function describeComparison(value: string | null, useMergeBase: boolean) {
  if (value === null) {
    return { label: 'Uncommitted', hint: 'Showing changes since the last commit' };
  }
  if (useMergeBase) {
    return {
      label: `Since ${value}`,
      hint: `Showing everything this branch changed since ${value}, committed or not`,
    };
  }
  return { label: value, hint: `Showing how the working tree differs from ${value}` };
}

/**
 * The one "Compare: … ▾" control for the changes view: uncommitted changes,
 * everything since the target branch (merge-base), or any branch tip.
 */
export function BranchCompareSelect({
  value,
  useMergeBase = false,
  targetBranch,
  branches,
  loading,
  disabled = false,
  onBranchChange,
  onCompareSinceTarget,
  onLoadBranches,
  onFetchBranches,
}: BranchCompareSelectProps) {
  const [filter, setFilter] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const { config, updateConfig } = useConfigStore();
  const remoteExpanded = config?.remoteBranchesExpanded ?? false;

  const handleFetch = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onFetchBranches || isFetching) return;
      setIsFetching(true);
      try {
        await onFetchBranches();
        // Reload branches after fetch
        await onLoadBranches();
      } catch {
        // Silently fail - user can try again
      } finally {
        setIsFetching(false);
      }
    },
    [onFetchBranches, isFetching, onLoadBranches]
  );

  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase())
  );

  // Separate local and remote branches for display
  const localBranches = filteredBranches.filter((b) => !b.isRemoteOnly);
  const remoteBranches = filteredBranches.filter((b) => b.isRemoteOnly);

  const { label, hint } = describeComparison(value, useMergeBase);
  const offerSinceTarget = !!targetBranch && !!onCompareSinceTarget;
  const selected =
    value === null
      ? UNCOMMITTED
      : useMergeBase
        ? value === targetBranch
          ? SINCE_TARGET
          : ''
        : `${BRANCH_PREFIX}${value}`;

  const handleSelect = (next: string) => {
    if (next === UNCOMMITTED) onBranchChange(null);
    else if (next === SINCE_TARGET) onCompareSinceTarget?.();
    else if (next.startsWith(BRANCH_PREFIX)) onBranchChange(next.slice(BRANCH_PREFIX.length));
  };

  return (
    <Tooltip>
      <DropdownMenu
        modal={false}
        onOpenChange={(open) => {
          if (open && !disabled) {
            void onLoadBranches();
          } else {
            setFilter('');
          }
        }}
      >
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs font-normal"
              disabled={disabled}
              aria-label={`Compare: ${label}`}
            >
              <GitDiff className="size-3.5" />
              <span className="text-muted-foreground">Compare:</span>
              <span className="max-w-[140px] truncate font-medium">{label}</span>
              <CaretDown className="size-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
        <DropdownMenuContent
          className="max-h-80 w-80 max-w-[calc(100vw-1rem)] overflow-y-auto !pt-0"
          align="end"
        >
          <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
            <input
              type="text"
              placeholder="Filter branches..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          <DropdownMenuRadioGroup value={selected} onValueChange={handleSelect}>
            <DropdownMenuRadioItem value={UNCOMMITTED} disabled={disabled}>
              <span className="flex flex-col">
                <span>Uncommitted changes</span>
                <span className="text-2xs text-muted-foreground">Since the last commit</span>
              </span>
            </DropdownMenuRadioItem>
            {offerSinceTarget && (
              <DropdownMenuRadioItem value={SINCE_TARGET} disabled={disabled}>
                <span className="flex min-w-0 flex-col">
                  <span className="break-all">All changes since {targetBranch}</span>
                  <span className="text-2xs text-muted-foreground">
                    Commits and uncommitted edits on this branch
                  </span>
                </span>
              </DropdownMenuRadioItem>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuLabel>Against a branch</DropdownMenuLabel>

            {(() => {
              if (loading) {
                return (
                  <DropdownMenuItem disabled>
                    <Spinner />
                    <span>Loading...</span>
                  </DropdownMenuItem>
                );
              }
              if (filteredBranches.length === 0) {
                return (
                  <DropdownMenuItem disabled>
                    <span className="text-muted-foreground">
                      {filter ? 'No matching branches' : 'No branches found'}
                    </span>
                  </DropdownMenuItem>
                );
              }

              const renderBranch = (branch: BranchInfo) => (
                <DropdownMenuRadioItem
                  key={`${branch.name}-${branch.isRemoteOnly ? 'remote' : 'local'}`}
                  value={`${BRANCH_PREFIX}${branch.name}`}
                  disabled={disabled}
                >
                  {branch.isRemoteOnly ? <Cloud className="text-info" /> : <GitBranch />}
                  <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
                    {branch.name}
                  </span>
                </DropdownMenuRadioItem>
              );

              return (
                <>
                  <div className="flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    <div
                      className="flex flex-1 cursor-pointer items-center gap-1.5"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void updateConfig({ remoteBranchesExpanded: !remoteExpanded });
                      }}
                    >
                      {remoteExpanded ? (
                        <CaretDown className="size-3" />
                      ) : (
                        <CaretRight className="size-3" />
                      )}
                      <Cloud className="size-3" />
                      Remote ({remoteBranches.length})
                    </div>
                    {onFetchBranches && (
                      <div
                        className={`flex items-center gap-1 rounded-sm px-1.5 py-0.5 ${isFetching ? 'opacity-50' : 'cursor-pointer hover:bg-accent'}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!isFetching) void handleFetch(e);
                        }}
                        title={isFetching ? 'Fetching...' : 'Fetch from remote'}
                      >
                        <ArrowsClockwise
                          className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`}
                        />
                        {isFetching ? 'Fetching' : 'Fetch'}
                      </div>
                    )}
                  </div>
                  {remoteExpanded && remoteBranches.map(renderBranch)}
                  {localBranches.length > 0 && remoteBranches.length > 0 && (
                    <DropdownMenuSeparator />
                  )}
                  {localBranches.map(renderBranch)}
                </>
              );
            })()}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Tooltip>
  );
}
