import {
  ArrowRight,
  ArrowLineDown,
  CaretDown,
  CaretRight,
  Cloud,
  CloudArrowUp,
  GitBranch,
  GitMerge,
  Plus,
  ArrowsClockwise,
  X,
  Star,
} from '@phosphor-icons/react';
import React, { useState, useCallback, useMemo } from 'react';

import { PublishRepoDialog } from '@/components/layout/PublishRepoDialog';
import {
  branchTooltipSide,
  branchTriggerClass,
} from '@/components/layout/status-bar/StatusBarButton';
import { UnpushedCount } from '@/components/layout/UnpushedCount';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfigStore } from '@/stores/config.store';
import { useGitProgressStore } from '@/stores/git-progress.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectSyncStatusStore } from '@/stores/project-sync-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace, resolveWorkspaceTargetBranch } from '@/types';
import { pushWithAutoRecover } from '@/utils/push-with-recover';

import { needsRepoPublish, resolveRemoteWriteAction } from '../../../shared/lib/ahead-action';
import { projectRepoPath } from '../../../shared/lib/project-repo-path';

import type { BranchInfo } from '@/types';

interface TargetBranchSelectorProps {
  /** In the status bar, the trigger takes the status bar's compact item style. */
  inStatusBar?: boolean;
}

export function TargetBranchSelector({ inStatusBar = false }: TargetBranchSelectorProps = {}) {
  const tooltipSide = branchTooltipSide(inStatusBar);
  // Reads only the active workspace and its status, so updates to other workspaces, as their
  // agents run, don't re-render it.
  const activeWorkspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
  );
  const updateWorkspace = useWorkspacesStore((s) => s.updateWorkspace);
  const projects = useProjectsStore((s) => s.projects);
  const updateProject = useProjectsStore((s) => s.updateProject);
  const invalidateStatus = useGitStatusStore((s) => s.invalidateStatus);
  const fetchStatus = useGitStatusStore((s) => s.fetchStatus);
  const fetchStatusIfStale = useGitStatusStore((s) => s.fetchStatusIfStale);
  const gitStatus = useGitStatusStore((s) =>
    activeWorkspace ? s.statusMap.get(activeWorkspace.id)?.status : undefined
  );
  const refreshProjectSyncStatus = useProjectSyncStatusStore((s) => s.refreshStatus);
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const addToast = useToastStore((s) => s.addToast);
  const startOperation = useGitProgressStore((s) => s.startOperation);
  const endOperation = useGitProgressStore((s) => s.endOperation);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [isPushingTargetBranch, setIsPushingTargetBranch] = useState(false);
  const [isPullingTargetBranch, setIsPullingTargetBranch] = useState(false);
  const [publishRepoDialogOpen, setPublishRepoDialogOpen] = useState(false);

  const remoteExpanded = config?.remoteBranchesExpanded ?? false;

  const activeProject = useMemo(() => {
    if (!activeWorkspace?.projectId) return undefined;
    const project = projects.find((p) => p.id === activeWorkspace.projectId);
    return project?.kind === 'directory' ? undefined : project;
  }, [activeWorkspace?.projectId, projects]);
  const isGitWorkspace = !!activeWorkspace?.isWorktree;
  const sshBackend =
    activeWorkspace && isSshWorkspace(activeWorkspace) ? activeWorkspace.backend : undefined;
  const isRemoteWorkspace = !!sshBackend;
  const projectSyncStatus = useProjectSyncStatusStore((s) =>
    activeProject ? s.statuses.get(activeProject.id) : undefined
  );

  const repoPath = useMemo(() => {
    if (!activeProject) return '';
    return projectRepoPath(activeProject);
  }, [activeProject]);

  const loadBranches = useCallback(async () => {
    if (!activeWorkspace || (!isRemoteWorkspace && !repoPath)) return;
    setIsLoading(true);
    try {
      const branchList = isRemoteWorkspace
        ? await window.api.listWorkspaceBranches(activeWorkspace.id, true)
        : await window.api.listBranches(repoPath, true);
      setBranches(branchList);
    } catch {
      setBranches([]);
    } finally {
      setIsLoading(false);
    }
  }, [activeWorkspace, isRemoteWorkspace, repoPath]);

  const handleFetch = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!activeProject || !activeWorkspace || isFetching) return;
      setIsFetching(true);
      try {
        const result = isRemoteWorkspace
          ? await window.api.fetchWorkspaceRemote(activeWorkspace.id)
          : await window.api.fetchProject(activeProject.id);
        if (!result.success) {
          addToast(result.message, 'error');
        } else if (!isRemoteWorkspace) {
          await refreshProjectSyncStatus(activeProject.id, true);
        }
        // Refresh ahead/behind counts, as UnifiedMenu does after a fetch.
        invalidateStatus(activeWorkspace.id);
        await fetchStatus(
          activeWorkspace.id,
          activeWorkspace.workingDirectory,
          activeWorkspace.projectId
        );
        const branchList = isRemoteWorkspace
          ? await window.api.listWorkspaceBranches(activeWorkspace.id, true)
          : await window.api.listBranches(repoPath, true);
        setBranches(branchList);
      } catch (error) {
        addToast(`Failed to fetch: ${(error as Error).message}`, 'error');
      } finally {
        setIsFetching(false);
      }
    },
    [
      activeProject,
      activeWorkspace,
      isRemoteWorkspace,
      repoPath,
      isFetching,
      addToast,
      refreshProjectSyncStatus,
      invalidateStatus,
      fetchStatus,
    ]
  );

  // Early return after all hooks
  if (!activeWorkspace || !activeProject || !isGitWorkspace) return null;

  const currentTarget =
    resolveWorkspaceTargetBranch(
      activeWorkspace,
      activeProject?.baseBranch,
      gitStatus?.mainBranch
    ) || 'main';
  const targetBranchAheadRemote = isRemoteWorkspace
    ? (gitStatus?.targetBranchAheadRemote ?? 0)
    : (projectSyncStatus?.aheadRemote ?? 0);
  const targetBranchBehindRemote = isRemoteWorkspace
    ? (gitStatus?.targetBranchBehindRemote ?? 0)
    : (projectSyncStatus?.behindRemote ?? 0);
  const targetBranchHasRemote = isRemoteWorkspace
    ? (gitStatus?.targetBranchHasRemote ?? false)
    : (projectSyncStatus?.hasRemote ?? false);
  const displayedTargetBranchAheadRemote = targetBranchAheadRemote;
  const displayedTargetBranchBehindRemote = targetBranchBehindRemote;
  const _isOnTargetBranch = activeWorkspace.branchName === currentTarget;
  const effectiveDefault =
    activeProject?.baseBranch ||
    sshBackend?.defaultBranch ||
    projectSyncStatus?.defaultBranch ||
    gitStatus?.defaultBranch ||
    'main';
  // What this workspace follows without a target of its own: the project's, or for an SSH
  // workspace in a project without one, the branch it was created from.
  const followedTarget =
    resolveWorkspaceTargetBranch(
      { ...activeWorkspace, baseBranch: undefined },
      activeProject.baseBranch
    ) || effectiveDefault;
  // Pull does what Sync does when the target is only behind, so show just one of them.
  const pullReplacesSync = targetBranchBehindRemote > 0 && targetBranchAheadRemote === 0;
  const hasOriginRemote = gitStatus?.hasOriginRemote ?? false;
  const showPublishRepo =
    !isRemoteWorkspace &&
    needsRepoPublish({
      hasOriginRemote,
      hasRemote: gitStatus?.hasRemote ?? false,
      targetBranchHasRemote: gitStatus?.targetBranchHasRemote ?? false,
    });
  const targetBranchWriteAction = resolveRemoteWriteAction({
    hasOriginRemote,
    hasRemote: targetBranchHasRemote,
  });

  async function handleTargetBranchChange(branch: string) {
    if (!activeProject || !activeWorkspace) return;
    const newBaseBranch = !branch || branch === followedTarget ? undefined : branch;

    // Update workspace only (not project — each workspace can have its own target branch)
    await window.api.updateWorkspace(activeWorkspace.id, { baseBranch: newBaseBranch });
    updateWorkspace(activeWorkspace.id, { baseBranch: newBaseBranch });

    // Force-fetch fresh git status (not fetchStatusIfStale, which may skip if loading)
    void fetchStatus(
      activeWorkspace.id,
      activeWorkspace.workingDirectory,
      activeWorkspace.projectId
    );
  }

  async function handleSetProjectTarget(branch: string) {
    if (!activeProject) return;
    try {
      await updateProject(activeProject.id, { baseBranch: branch });
      // Clear this workspace's override once it matches the project target
      if (activeWorkspace?.baseBranch === branch) {
        await window.api.updateWorkspace(activeWorkspace.id, { baseBranch: undefined });
        updateWorkspace(activeWorkspace.id, { baseBranch: undefined });
      }
      // Refresh status for all workspaces in this project
      for (const ws of useWorkspacesStore.getState().workspaces) {
        if (ws.projectId === activeProject.id) {
          invalidateStatus(ws.id);
          void fetchStatusIfStale(ws.id, ws.workingDirectory, ws.projectId);
        }
      }
      void refreshProjectSyncStatus(activeProject.id, true);
      addToast(`Set ${branch} as the project's target branch`, 'success');
    } catch (error) {
      addToast(`Failed to set the project's target branch: ${(error as Error).message}`, 'error');
    }
  }

  async function handleCreateBranch(branchName: string) {
    if (!activeWorkspace || !branchName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      // Start from the current target rather than this workspace's branch.
      await window.api.createWorkspaceBranch(activeWorkspace.id, branchName.trim(), currentTarget);
      // Set the new branch as the target
      await handleTargetBranchChange(branchName.trim());
      setFilter('');
      setOpen(false);
    } catch (err) {
      addToast(`Failed to create branch: ${(err as Error).message}`, 'error');
    } finally {
      setIsCreating(false);
    }
  }

  const handlePushTargetBranch = async () => {
    if (!activeWorkspace) return;
    setIsPushingTargetBranch(true);
    try {
      const result = await pushWithAutoRecover({
        workingDir: activeWorkspace.workingDirectory,
        operationPrefix: 'push-main',
        workspaceKey: activeWorkspace.id,
        pushFn: isRemoteWorkspace
          ? () => window.api.pushWorkspaceTargetBranch(activeWorkspace.id)
          : window.api.pushTargetBranch,
        pullFn: isRemoteWorkspace
          ? () => window.api.pullWorkspaceTargetBranch(activeWorkspace.id)
          : window.api.pullTargetBranch,
        recoverySuccessMessage: 'Pulled and pushed to remote',
        startOperation,
        endOperation,
        addToast,
      });
      invalidateStatus(activeWorkspace.id);
      void fetchStatusIfStale(
        activeWorkspace.id,
        activeWorkspace.workingDirectory,
        activeWorkspace.projectId
      );
      if (result.success && activeProject) {
        await refreshProjectSyncStatus(activeProject.id, true);
      }
    } finally {
      setIsPushingTargetBranch(false);
    }
  };

  const handlePullTargetBranch = async () => {
    if (!activeWorkspace) return;
    const operationId = `pull-main-${activeWorkspace.id}-${Date.now()}`;
    setIsPullingTargetBranch(true);
    startOperation(operationId, 'pull', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.pullWorkspaceTargetBranch(activeWorkspace.id)
        : await window.api.pullTargetBranch(activeWorkspace.workingDirectory);
      if (!result.success) addToast(result.message, 'error');
      invalidateStatus(activeWorkspace.id);
      void fetchStatusIfStale(
        activeWorkspace.id,
        activeWorkspace.workingDirectory,
        activeWorkspace.projectId
      );
      if (result.success && activeProject) {
        await refreshProjectSyncStatus(activeProject.id, true);
      }
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsPullingTargetBranch(false);
    }
  };

  const handleMergeTargetBranchFromRemote = async () => {
    if (!activeWorkspace) return;
    const operationId = `merge-main-remote-${activeWorkspace.id}-${Date.now()}`;
    setIsPullingTargetBranch(true);
    startOperation(operationId, 'merge', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.mergeWorkspaceTargetBranchFromRemote(activeWorkspace.id)
        : await window.api.mergeTargetBranchFromRemote(activeWorkspace.workingDirectory);
      if (!result.success) addToast(result.message, 'error');
      invalidateStatus(activeWorkspace.id);
      void fetchStatusIfStale(
        activeWorkspace.id,
        activeWorkspace.workingDirectory,
        activeWorkspace.projectId
      );
      if (result.success && activeProject) {
        await refreshProjectSyncStatus(activeProject.id, true);
      }
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsPullingTargetBranch(false);
    }
  };

  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase())
  );
  const localBranches = filteredBranches.filter((b) => !b.isRemoteOnly);
  const remoteBranches = filteredBranches.filter((b) => b.isRemoteOnly);

  // Show create option when filter text doesn't exactly match any existing branch
  const trimmedFilter = filter.trim();
  const exactMatch = trimmedFilter && branches.some((b) => b.name === trimmedFilter);
  const showCreateOption = trimmedFilter && !exactMatch && !isLoading;

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  return (
    <>
      <ArrowRight className="-mx-1 size-3 shrink-0 opacity-40" />
      <DropdownMenu
        modal={false}
        open={open}
        onOpenChange={(isOpen) => {
          setOpen(isOpen);
          if (isOpen) void loadBranches();
          else {
            setFilter('');
            setIsCreating(false);
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={branchTriggerClass(inStatusBar)}
                style={noDrag}
              >
                <span className="max-w-[120px] truncate font-mono text-ui" title={currentTarget}>
                  {currentTarget}
                </span>
                {displayedTargetBranchBehindRemote > 0 && (
                  <span className="text-xs text-behind">↓{displayedTargetBranchBehindRemote}</span>
                )}
                {displayedTargetBranchAheadRemote > 0 && (
                  <UnpushedCount count={displayedTargetBranchAheadRemote} />
                )}
                {isPullingTargetBranch || isPushingTargetBranch ? (
                  <Spinner size="xs" />
                ) : (
                  <CaretDown className="size-3 opacity-50" />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>
            Target branch for diffs, PRs, and sync status
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent className="w-80 max-w-[calc(100vw-1rem)]" align="start">
          {/* Publish repo when no origin remote, or one with none of the branches */}
          {showPublishRepo && (
            <>
              <DropdownMenuItem onClick={() => setPublishRepoDialogOpen(true)}>
                <CloudArrowUp />
                <span>Publish repo</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {/* Sync section: Sync unless a specific Pull replaces it, plus Merge/Push when counts are known */}
          {hasOriginRemote && (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <Cloud className="size-3" />
                <span className="min-w-0 font-mono leading-4 break-all whitespace-normal">
                  {currentTarget}
                </span>
              </DropdownMenuLabel>
              {!pullReplacesSync && (
                <DropdownMenuItem onClick={handlePullTargetBranch} disabled={isPullingTargetBranch}>
                  {isPullingTargetBranch ? <Spinner /> : <ArrowsClockwise />}
                  <span>Sync</span>
                </DropdownMenuItem>
              )}
              {targetBranchBehindRemote > 0 && (
                <DropdownMenuItem
                  onClick={
                    targetBranchAheadRemote > 0
                      ? handleMergeTargetBranchFromRemote
                      : handlePullTargetBranch
                  }
                  disabled={isPullingTargetBranch}
                  className="gap-2"
                >
                  {isPullingTargetBranch ? (
                    <Spinner />
                  ) : targetBranchAheadRemote > 0 ? (
                    <GitMerge />
                  ) : (
                    <ArrowLineDown />
                  )}
                  <span>{targetBranchAheadRemote > 0 ? 'Merge remote' : 'Pull'}</span>
                  <span className="ml-auto text-xs text-behind">↓{targetBranchBehindRemote}</span>
                </DropdownMenuItem>
              )}
              {targetBranchAheadRemote > 0 && (
                <DropdownMenuItem onClick={handlePushTargetBranch} disabled={isPushingTargetBranch}>
                  {isPushingTargetBranch ? <Spinner /> : <CloudArrowUp />}
                  <span>{targetBranchWriteAction === 'publish' ? 'Publish' : 'Push'}</span>
                  <span className="ml-auto text-xs text-ahead">{targetBranchAheadRemote}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          )}
          {/* Change target branch section */}
          <DropdownMenuLabel className="flex items-center gap-1.5">
            <GitBranch className="size-3" />
            Target branch for this workspace
          </DropdownMenuLabel>
          <div className="space-y-1 px-2 pb-1.5">
            <input
              type="text"
              placeholder="Filter or create branch..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && showCreateOption) {
                  e.preventDefault();
                  void handleCreateBranch(trimmedFilter);
                }
              }}
              className="w-full rounded-md border border-foreground/10 bg-transparent px-2 py-1 text-[13px] placeholder:text-muted-foreground focus:ring-1 focus:ring-primary focus:outline-hidden"
              onClick={(e) => e.stopPropagation()}
            />
            {activeWorkspace.baseBranch && (
              <div
                className="flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleTargetBranchChange('');
                }}
              >
                <X className="size-3" />
                {followedTarget === effectiveDefault
                  ? `Use project target (${followedTarget})`
                  : `Use default (${followedTarget})`}
              </div>
            )}
          </div>
          <div className="max-h-48 overflow-x-hidden overflow-y-auto">
            {showCreateOption && (
              <>
                <DropdownMenuItem
                  onClick={() => void handleCreateBranch(trimmedFilter)}
                  disabled={isCreating}
                  className="gap-2"
                >
                  {isCreating ? <Spinner /> : <Plus />}
                  <span className="flex-1 truncate">
                    Create <span className="font-medium">{trimmedFilter}</span>
                  </span>
                </DropdownMenuItem>
                {filteredBranches.length > 0 && <DropdownMenuSeparator className="my-0" />}
              </>
            )}
            {(() => {
              if (isLoading) {
                return (
                  <DropdownMenuItem disabled>
                    <Spinner />
                    <span>Loading...</span>
                  </DropdownMenuItem>
                );
              }
              if (filteredBranches.length === 0 && !showCreateOption) {
                return (
                  <DropdownMenuItem disabled>
                    <span className="text-muted-foreground">
                      {filter ? 'No matching branches' : 'No branches found'}
                    </span>
                  </DropdownMenuItem>
                );
              }

              const renderBranch = (branch: BranchInfo) => {
                const isSelected = branch.name === currentTarget;
                const isCheckedOut = branch.name === activeWorkspace.branchName;
                const isProjectTarget = branch.name === effectiveDefault;
                return (
                  <DropdownMenuItem
                    key={`${branch.name}-${branch.isRemoteOnly ? 'remote' : 'local'}`}
                    onClick={() => void handleTargetBranchChange(branch.name)}
                    className="group gap-2"
                  >
                    {branch.isRemoteOnly ? <Cloud className="text-info" /> : <GitBranch />}
                    <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
                      {branch.name}
                    </span>
                    {isSelected && (
                      <span className="shrink-0 text-xs text-muted-foreground">target</span>
                    )}
                    {isProjectTarget && (
                      <span className="shrink-0 text-xs text-muted-foreground">project</span>
                    )}
                    {isCheckedOut && (
                      <span className="shrink-0 text-xs text-muted-foreground">checked out</span>
                    )}
                    {isProjectTarget ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            aria-label={`${branch.name} is the project's target branch`}
                            className="-my-1 -mr-1 shrink-0 p-1"
                          >
                            <Star weight="fill" className="size-3" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-64">
                          The project's target branch. Workspaces without a target of their own
                          follow it, and new workspaces start from it.
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      !isCheckedOut && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={`Make ${branch.name} the project's target branch`}
                              className="-my-1 -mr-1 shrink-0 rounded-sm p-1 opacity-0 group-data-[highlighted]:opacity-100 hover:bg-foreground/10"
                              onClick={(e) => {
                                // Keep the row from also setting this workspace's target.
                                e.preventDefault();
                                e.stopPropagation();
                                void handleSetProjectTarget(branch.name);
                              }}
                            >
                              <Star className="size-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-64">
                            Make <span className="font-mono">{branch.name}</span> the project's
                            target branch. Workspaces without a target of their own follow it, and
                            new workspaces start from it.
                          </TooltipContent>
                        </Tooltip>
                      )
                    )}
                  </DropdownMenuItem>
                );
              };

              return (
                <>
                  {hasOriginRemote && (
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
                          <ArrowsClockwise
                            className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`}
                          />
                          {isFetching ? 'Fetching' : 'Fetch'}
                        </div>
                      </div>
                      {remoteExpanded && remoteBranches.map(renderBranch)}
                      {localBranches.length > 0 && <DropdownMenuSeparator />}
                    </>
                  )}
                  {localBranches.map(renderBranch)}
                </>
              );
            })()}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {showPublishRepo && (
        <PublishRepoDialog
          open={publishRepoDialogOpen}
          onOpenChange={setPublishRepoDialogOpen}
          replacesOrigin={hasOriginRemote}
          repoPath={activeWorkspace.workingDirectory}
          repoName={
            activeProject?.name || activeWorkspace.workingDirectory.split('/').pop() || 'repo'
          }
          onPublished={() => {
            addToast('Repository published', 'success');
            invalidateStatus(activeWorkspace.id);
            void fetchStatusIfStale(
              activeWorkspace.id,
              activeWorkspace.workingDirectory,
              activeWorkspace.projectId
            );
          }}
        />
      )}
    </>
  );
}
