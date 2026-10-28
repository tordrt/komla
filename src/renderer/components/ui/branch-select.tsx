import { CaretDown, CaretRight, GitBranch, X, ArrowsClockwise, Cloud } from '@phosphor-icons/react';
import React, { useState, useCallback, useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { useConfigStore } from '@/stores/config.store';

import type { BranchInfo } from '@/types';

interface BranchSelectProps {
  /** Currently selected branch name */
  value: string;
  /** Called when a branch is selected */
  onChange: (branch: string, meta?: { isRemoteOnly?: boolean }) => void;
  /** Repository path to load branches from */
  repoPath: string;
  /** Project ID — when provided, uses project-aware fetch (fetches into bare clone) */
  projectId?: string;
  /** Placeholder text when no branch is selected */
  placeholder?: string;
  /** Help text shown below the select */
  description?: string;
  /** Label shown above the select */
  label?: string;
  /** Branches that are in use (shown as disabled with indicator) */
  usedBranches?: string[];
  /** Whether to include remote branches (default: true) */
  includeRemote?: boolean;
}

const EMPTY_USED_BRANCHES: string[] = [];

export function BranchSelect({
  value,
  onChange,
  repoPath,
  projectId,
  placeholder = 'main (default)',
  description,
  label,
  usedBranches = EMPTY_USED_BRANCHES,
  includeRemote = true,
}: BranchSelectProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [hasOriginRemote, setHasOriginRemote] = useState(false);
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const { config, updateConfig } = useConfigStore();
  const remoteExpanded = config?.remoteBranchesExpanded ?? false;

  const loadBranches = useCallback(async () => {
    if (!repoPath) return;
    setIsLoading(true);
    try {
      const [branchList, hasRemote] = await Promise.all([
        window.api.listBranches(repoPath, includeRemote),
        window.api.hasOriginRemote(repoPath),
      ]);
      setBranches(branchList);
      setHasOriginRemote(hasRemote);
    } catch {
      setBranches([]);
    } finally {
      setIsLoading(false);
    }
  }, [repoPath, includeRemote]);

  const handleFetch = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!projectId || isFetching) return;
      setIsFetching(true);
      try {
        await window.api.fetchProject(projectId);
        // Reload branches after fetch
        const branchList = await window.api.listBranches(repoPath, includeRemote);
        setBranches(branchList);
      } catch {
        // Silently fail - user can try again
      } finally {
        setIsFetching(false);
      }
    },
    [repoPath, projectId, includeRemote, isFetching]
  );

  const usedSet = new Set(usedBranches);
  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase())
  );

  // Separate local and remote branches for display
  const localBranches = filteredBranches.filter((b) => !b.isRemoteOnly);
  const remoteBranches = filteredBranches.filter((b) => b.isRemoteOnly);

  return (
    <div className="grid gap-2">
      {label && <label className="text-sm font-medium">{label}</label>}
      <div className="flex gap-2">
        <DropdownMenu
          modal={false}
          onOpenChange={(open) => {
            if (open) void loadBranches();
            else {
              setFilter('');
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="w-full justify-between font-normal">
              <span
                className={value ? 'truncate' : 'truncate text-muted-foreground'}
                title={value || placeholder}
              >
                {value || placeholder}
              </span>
              <CaretDown className="ml-2 size-4 shrink-0 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="max-h-72 w-80 max-w-[calc(100vw-1rem)] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto !pt-0"
            align="start"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              filterInputRef.current?.focus();
              filterInputRef.current?.select();
            }}
          >
            <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
              <input
                ref={filterInputRef}
                type="text"
                placeholder="Filter branches..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
            {(() => {
              if (isLoading) {
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

              const renderBranch = (branch: BranchInfo) => {
                const isUsed = usedSet.has(branch.name);
                return (
                  <DropdownMenuItem
                    key={`${branch.name}-${branch.isRemoteOnly ? 'remote' : 'local'}`}
                    onClick={() =>
                      !isUsed && onChange(branch.name, { isRemoteOnly: branch.isRemoteOnly })
                    }
                    disabled={isUsed}
                    className="gap-2"
                  >
                    {branch.isRemoteOnly ? <Cloud className="text-info" /> : <GitBranch />}
                    <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
                      {branch.name}
                    </span>
                    {isUsed && (
                      <span className="shrink-0 text-xs text-muted-foreground">in use</span>
                    )}
                  </DropdownMenuItem>
                );
              };

              return (
                <>
                  {includeRemote && hasOriginRemote && (
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
                        {projectId && (
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
                      {localBranches.length > 0 && <DropdownMenuSeparator />}
                    </>
                  )}
                  {localBranches.map(renderBranch)}
                </>
              );
            })()}
          </DropdownMenuContent>
        </DropdownMenu>
        {value && (
          <IconButton
            label="Clear branch"
            size="md"
            className="size-9"
            onClick={() => onChange('')}
          >
            <X className="size-4" />
          </IconButton>
        )}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}
