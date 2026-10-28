import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  Cloud,
  GitBranch,
  X,
} from '@phosphor-icons/react';
import React, { useMemo, useEffect, useRef, useState, useCallback } from 'react';

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { formatRelativeTime } from '@/lib/format-time';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import { getAncestorPaths } from './file-viewer-utils';
import { SidebarFileTree } from './SidebarFileTree';
import { FILE_VIEW_TAB_ACTIVE_CLASS } from './types';

import type { CommitGraph, CommitGraphCommit } from '../../../../shared/types/commit-graph';
import type { BranchInfo, CommitDiff, FileChange } from '@/types';

export interface CommitHistorySidebarProps {
  workspaceId: string;
  workingDirectory: string;
  isRemoteWorkspace: boolean;
  commits: CommitGraphCommit[];
  /** The checked-out branch and its upstream, colored in the graph with the target branch. */
  branchRoles: Pick<CommitGraph, 'currentBranch' | 'upstream'>;
  targetBranch: string;
  loadingCommits: boolean;
  hasMoreCommits: boolean;
  selectedCommitHash: string | null;
  commitDiff: CommitDiff | null;
  loadingCommitDiff: boolean;
  selectedFilePath: string | null;
  onSelectCommit: (hash: string) => void;
  onSelectFile: (path: string) => void;
  onLoadMore: () => void;
  onToggleHistory: () => void;
  filterPath: string | null;
  onClearFilterPath: () => void;
  onShowFileHistory?: (path: string) => void;
  historyBranch: string | null;
  onBranchChange: (branch: string | null) => void;
  availableBranches: BranchInfo[];
  loadingBranches: boolean;
  onLoadBranches: () => Promise<void>;
}

// How far each key moves through the commits.
const COMMIT_STEPS: Partial<Record<string, number>> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };

function HistoryCommitRow({
  ref,
  row,
  isHead,
  isSelected,
  onSelect,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  row: CommitGraphRow;
  isHead: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { commit, refs } = row;
  return (
    <CommitContextMenu hash={commit.hash}>
      <button
        ref={ref}
        data-commit-hash={commit.hash}
        className={cn(
          // Focus shows as the file tree's does: a bar along the left, as the list clips an outline.
          'flex w-full items-center gap-1.5 pr-2 text-left text-xs transition-colors outline-hidden hover:bg-foreground/5 focus-visible:shadow-[inset_2px_0_0_0_var(--color-primary)] data-[state=open]:bg-foreground/5',
          isSelected && 'bg-accent hover:bg-accent'
        )}
        style={{ height: COMMIT_GRAPH_ROW_HEIGHT }}
        onClick={onSelect}
      >
        <CommitGraphLanes row={row} isHead={isHead} />
        <span className={cn('min-w-0 flex-1 truncate', isHead && 'font-medium')}>
          {splitCommitMessage(commit.message).title || '(no message)'}
        </span>
        {/* A narrow list leaves the room to the commit's title. */}
        {refs[0] && <CommitRefPill gitRef={refs[0]} className="max-w-24 @max-2xs:hidden" />}
        {refs.length > 1 && (
          <span className="shrink-0 text-[10px] text-muted-foreground @max-2xs:hidden">
            +{refs.length - 1}
          </span>
        )}
        <span className="w-6 shrink-0 text-right text-2xs text-muted-foreground tabular-nums">
          {formatRelativeTime(commit.timestamp * 1000)}
        </span>
      </button>
    </CommitContextMenu>
  );
}

/** The files the selected commit changed, as a tree. */
function CommitFilesSection({
  workspaceId,
  workingDirectory,
  isRemoteWorkspace,
  commitDiff,
  loading,
  selectedFilePath,
  onSelectFile,
  onShowFileHistory,
}: {
  workspaceId: string;
  workingDirectory: string;
  isRemoteWorkspace: boolean;
  commitDiff: CommitDiff | null;
  loading: boolean;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  onShowFileHistory?: (path: string) => void;
}) {
  // Convert commitDiff files into the format SidebarFileTree expects
  const commitChangedFiles = useMemo(() => {
    if (!commitDiff?.files) return [];
    return commitDiff.files.map((f) => ({ path: f.path, isDirectory: f.isDirectory }));
  }, [commitDiff?.files]);

  const commitDiffFileStatuses = useMemo(() => {
    if (!commitDiff?.files) return undefined;
    const statuses = new Map<string, FileChange['status']>();
    for (const f of commitDiff.files) {
      statuses.set(f.path, f.status);
      for (const ancestor of getAncestorPaths(f.path)) {
        if (!statuses.has(ancestor)) {
          statuses.set(ancestor, 'modified');
        }
      }
    }
    return statuses;
  }, [commitDiff?.files]);

  return (
    <div className="flex min-h-0 flex-[1_1_50%] flex-col border-t">
      {loading && (
        <div className="flex items-center justify-center py-3">
          <Spinner label="Loading files" className="text-muted-foreground" />
        </div>
      )}
      {!loading && commitDiff?.files.length === 0 && (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          This commit changes no files
        </p>
      )}
      {!loading && !!commitDiff?.files.length && (
        <SidebarFileTree
          workspaceId={workspaceId}
          workingDirectory={workingDirectory}
          isRemoteWorkspace={isRemoteWorkspace}
          currentFile={selectedFilePath}
          onFileSelect={onSelectFile}
          changedFilesOnly
          changedFiles={commitChangedFiles}
          diffFileStatuses={commitDiffFileStatuses}
          diffSummary={commitDiff.summary}
          onShowFileHistory={onShowFileHistory}
          embedded
        />
      )}
    </div>
  );
}

export function CommitHistorySidebar({
  workspaceId,
  workingDirectory,
  isRemoteWorkspace,
  commits,
  branchRoles,
  targetBranch,
  loadingCommits,
  hasMoreCommits,
  selectedCommitHash,
  commitDiff,
  loadingCommitDiff,
  selectedFilePath,
  onSelectCommit,
  onSelectFile,
  onLoadMore,
  onToggleHistory,
  filterPath,
  onClearFilterPath,
  onShowFileHistory,
  historyBranch,
  onBranchChange,
  availableBranches,
  loadingBranches,
  onLoadBranches,
}: CommitHistorySidebarProps) {
  const selectedCommitRef = useRef<HTMLButtonElement>(null);
  const [branchFilter, setBranchFilter] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const { config, updateConfig } = useConfigStore();
  const remoteExpanded = config?.remoteBranchesExpanded ?? false;

  const handleFetch = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFetching) return;
      setIsFetching(true);
      try {
        await window.api.fetchWorkspaceRemote(workspaceId);
        await onLoadBranches();
      } catch {
        // Silently fail - user can try again
      } finally {
        setIsFetching(false);
      }
    },
    [workspaceId, isFetching, onLoadBranches]
  );

  // Scroll to selected commit when it changes
  useEffect(() => {
    if (selectedCommitHash && selectedCommitRef.current) {
      selectedCommitRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedCommitHash]);

  const filteredBranches = availableBranches.filter((b) =>
    b.name.toLowerCase().includes(branchFilter.toLowerCase())
  );

  // A file's commits leave out the ones between them, so they're drawn as one line.
  const rows = useMemo(
    () =>
      layoutCommitGraph(
        filterPath
          ? commits.map((commit, index) => ({
              ...commit,
              parentHashes: index + 1 < commits.length ? [commits[index + 1].hash] : [],
            }))
          : commits,
        { ...branchRoles, targetBranch }
      ),
    [commits, filterPath, branchRoles, targetBranch]
  );
  const showsHead = !historyBranch && !filterPath;

  // While a commit has focus, the arrow keys (and j and k) move to the next or previous one, which
  // they would otherwise take to step through its files.
  const stepCommits = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = COMMIT_STEPS[event.key];
    if (!step || event.metaKey || event.ctrlKey || event.altKey) return;
    const commitRows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-commit-hash]')];
    const index = commitRows.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    claimShortcutEvent(event.nativeEvent);
    const next = commitRows[index + step];
    if (!next?.dataset.commitHash) return;
    // The selected commit scrolls into view on its own.
    next.focus({ preventScroll: true });
    onSelectCommit(next.dataset.commitHash);
  };

  const localBranches = filteredBranches.filter((b) => !b.isRemoteOnly);
  const remoteBranches = filteredBranches.filter((b) => b.isRemoteOnly);

  return (
    <div className="flex h-full flex-col">
      {/* Header — matches SidebarFileTree header style */}
      <div
        className={cn(
          'flex h-9 shrink-0 items-center justify-between gap-0 border-b pl-2.5 pr-1 text-sm font-medium',
          FILE_VIEW_TAB_ACTIVE_CLASS
        )}
      >
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              void onLoadBranches();
            } else {
              setBranchFilter('');
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              className="flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              title={historyBranch ?? 'HEAD'}
            >
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-ui">{historyBranch ?? 'HEAD'}</span>
              <CaretDown className="size-2.5 shrink-0 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="max-h-72 w-80 max-w-[calc(100vw-1rem)] overflow-y-auto !pt-0"
            align="start"
          >
            <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
              <input
                type="text"
                placeholder="Filter branches..."
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>

            {/* HEAD option (default) */}
            <DropdownMenuItem onClick={() => onBranchChange(null)}>
              <GitBranch />
              <span className="flex-1">HEAD</span>
              {historyBranch === null && (
                <span className="text-xs text-muted-foreground">current</span>
              )}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {(() => {
              if (loadingBranches) {
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
                      {branchFilter ? 'No matching branches' : 'No branches found'}
                    </span>
                  </DropdownMenuItem>
                );
              }

              const renderBranch = (branch: BranchInfo) => {
                // Remote branches are listed without their remote's name.
                const ref = branch.remoteRef ?? branch.name;
                const isSelected = historyBranch === ref;
                return (
                  <DropdownMenuItem
                    key={`${ref}-${branch.isRemoteOnly ? 'remote' : 'local'}`}
                    onClick={() => onBranchChange(ref)}
                    className="gap-2"
                  >
                    {branch.isRemoteOnly ? <Cloud className="text-info" /> : <GitBranch />}
                    <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
                      {branch.name}
                    </span>
                    {isSelected && <span className="text-xs text-muted-foreground">selected</span>}
                  </DropdownMenuItem>
                );
              };

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
                    <div
                      className={`flex items-center gap-1 rounded-sm px-1.5 py-0.5 ${isFetching ? 'opacity-50' : 'cursor-pointer hover:bg-accent'}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!isFetching) void handleFetch(e);
                      }}
                      title={isFetching ? 'Fetching...' : 'Fetch from remote'}
                    >
                      <ArrowsClockwise className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                      {isFetching ? 'Fetching' : 'Fetch'}
                    </div>
                  </div>
                  {remoteExpanded && remoteBranches.map(renderBranch)}
                  {localBranches.length > 0 && remoteBranches.length > 0 && (
                    <DropdownMenuSeparator />
                  )}
                  {localBranches.map(renderBranch)}
                </>
              );
            })()}
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton
          label="Back to changes"
          size="xs"
          tooltipSide="left"
          onClick={onToggleHistory}
          className="text-primary hover:text-primary/80"
        >
          <ClockCounterClockwise className="size-3.5" />
        </IconButton>
      </div>
      {filterPath && (
        <div className="flex items-center gap-1.5 border-b bg-muted/30 px-2 py-1.5 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">
            <span className="font-mono text-foreground">{filterPath.split('/').pop()}</span>
          </span>
          <IconButton
            label="Show all commits"
            size="xs"
            onClick={onClearFilterPath}
            className="size-4 rounded-sm"
          >
            <X className="size-3" />
          </IconButton>
        </div>
      )}
      {/* Commit list section */}
      <div
        className={cn(
          '@container min-h-0 flex-1 overflow-y-auto',
          selectedCommitHash && 'flex-[1_1_50%]'
        )}
        onKeyDown={stepCommits}
      >
        {commits.length === 0 && !loadingCommits && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No commits found
          </div>
        )}
        {rows.map((row, index) => (
          <HistoryCommitRow
            key={row.commit.hash}
            ref={selectedCommitHash === row.commit.hash ? selectedCommitRef : undefined}
            row={row}
            isHead={showsHead && index === 0}
            isSelected={selectedCommitHash === row.commit.hash}
            onSelect={() => onSelectCommit(row.commit.hash)}
          />
        ))}
        {loadingCommits && (
          <div className="flex items-center justify-center py-3">
            <Spinner label="Loading commits" className="text-muted-foreground" />
          </div>
        )}
        {hasMoreCommits && !loadingCommits && commits.length > 0 && (
          <button
            className="w-full py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={onLoadMore}
          >
            Show older commits
          </button>
        )}
      </div>

      {selectedCommitHash && (
        <CommitFilesSection
          workspaceId={workspaceId}
          workingDirectory={workingDirectory}
          isRemoteWorkspace={isRemoteWorkspace}
          commitDiff={commitDiff}
          loading={loadingCommitDiff}
          selectedFilePath={selectedFilePath}
          onSelectFile={onSelectFile}
          onShowFileHistory={onShowFileHistory}
        />
      )}
    </div>
  );
}
