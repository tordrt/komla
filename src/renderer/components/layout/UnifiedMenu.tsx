import {
  Broom,
  CaretDown,
  GitBranch,
  CloudArrowUp,
  GitMerge,
  GitPullRequest,
  ArrowSquareOut,
  ArrowLineDown,
  GitFork,
  GitCommit,
  ArrowsClockwise,
  ArrowCounterClockwise,
  ClockCounterClockwise,
  Folder,
  Warning,
  Terminal,
  Sparkle,
} from '@phosphor-icons/react';
import React, { useEffect, useRef, useState } from 'react';

import { BranchActionPicker } from '@/components/layout/BranchActionPicker';
import { GitOperationDetails, gitOperationLabel } from '@/components/layout/GitProgressIndicator';
import { PublishRepoDialog } from '@/components/layout/PublishRepoDialog';
import {
  branchTooltipSide,
  branchTriggerClass,
} from '@/components/layout/status-bar/StatusBarButton';
import { UnpushedCount } from '@/components/layout/UnpushedCount';
import { BranchCleanupDialog } from '@/components/projects/BranchCleanupDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CommitComposer } from '@/components/workspaces/file-viewer/CommitComposer';
import { useActionLauncher } from '@/hooks/useActionLauncher';
import { findActionForProject } from '@/lib/action-visibility';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { latestGitOperation, useGitProgressStore } from '@/stores/git-progress.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectSyncStatusStore } from '@/stores/project-sync-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace, resolveWorkspaceTargetBranch } from '@/types';
import { pushWithAutoRecover } from '@/utils/push-with-recover';
import { addRebaseFailureToast, requestRebaseAbort } from '@/utils/rebase-abort';

import { UNCOMMITTED_CHANGES_PREFIX } from '../../../shared/constants/git';
import {
  resolveAheadAction,
  resolveActionId,
  needsRepoPublish,
  resolveRemoteWriteAction,
  resolveUnpushedDisplay,
} from '../../../shared/lib/ahead-action';
import { withGitDefaults } from '../../../shared/lib/project-git-defaults';

import type { GitOperation } from '@/stores/git-progress.store';
import type { BranchInfo, Project } from '@/types';

type AddToastFn = (
  message: string,
  type: 'success' | 'error',
  options?: { action?: { label: string; onClick: () => void } }
) => void;

async function deleteRemoteBranchWithOptionalLocal(
  workingDirectory: string,
  branchName: string,
  alsoDeleteLocal: boolean,
  addToast: AddToastFn
) {
  const result = await window.api.deleteRemoteBranch(workingDirectory, branchName);
  if (!result.success) addToast(result.message, 'error');
  if (!result.success || !alsoDeleteLocal) return;
  const localResult = await window.api.deleteBranch(workingDirectory, branchName, true);
  if (!localResult.success) addToast(localResult.message, 'error');
}

async function forceDeleteLocalBranchWithOptionalRemote(
  workingDirectory: string,
  branchName: string,
  alsoDeleteRemote: boolean,
  addToast: AddToastFn
) {
  const result = await window.api.deleteBranch(workingDirectory, branchName, true);
  if (!result.success) addToast(result.message, 'error');
  if (!result.success || !alsoDeleteRemote) return;
  const remoteResult = await window.api.deleteRemoteBranch(workingDirectory, branchName);
  if (!remoteResult.success) addToast(remoteResult.message, 'error');
}

function getTriggerContent(params: {
  isGitWorkspace: boolean;
  branchName: string | undefined;
  projectName: string | undefined;
  hasRemote: boolean;
  behindRemote: number;
  hasUnpushedDisplay: boolean;
  unpushedDisplayCount: number;
  rebaseInProgress: boolean;
}) {
  if (params.isGitWorkspace) {
    return (
      <>
        <GitBranch className="size-4" />
        <span className="max-w-[120px] truncate font-mono text-ui" title={params.branchName}>
          {params.branchName}
        </span>
        {params.rebaseInProgress && <span className="text-xs text-warning">rebasing</span>}
        {params.hasRemote && params.behindRemote > 0 && (
          <span className="text-xs text-behind">↓{params.behindRemote}</span>
        )}
        {params.hasUnpushedDisplay && <UnpushedCount count={params.unpushedDisplayCount} />}
      </>
    );
  }
  if (params.projectName) {
    return (
      <>
        <Folder className="size-4" />
        <span className="max-w-[120px] truncate text-xs">{params.projectName}</span>
      </>
    );
  }
  return (
    <>
      <Folder className="size-4" />
      <span className="text-xs">Project</span>
    </>
  );
}

/**
 * The trigger's content, or while an operation runs, a spinner and the operation's name laid over
 * it. The content stays in place, invisible, so the button keeps its width and nothing beside it
 * moves.
 */
function TriggerLabel({
  operation,
  children,
}: {
  operation: GitOperation | undefined;
  children: React.ReactNode;
}) {
  return (
    <span className="relative flex min-w-0 items-center gap-[inherit]">
      <span className={cn('flex min-w-0 items-center gap-[inherit]', operation && 'invisible')}>
        {children}
      </span>
      {operation && (
        <span className="absolute inset-0 flex items-center gap-[inherit] overflow-hidden">
          <Spinner size="md" />
          <span className="truncate text-ui">{gitOperationLabel(operation)}…</span>
        </span>
      )}
    </span>
  );
}

// The trigger's cloud count is commits origin doesn't have, unlike ↑N (ahead of target).
function getTriggerTooltip(params: {
  isGitWorkspace: boolean;
  unpushed: number;
  behindRemote: number;
}): string {
  if (!params.isGitWorkspace) return 'Project actions';
  return [
    'Branch actions',
    params.unpushed > 0 &&
      `${params.unpushed} commit${params.unpushed > 1 ? 's' : ''} not pushed to origin`,
    params.behindRemote > 0 && `↓${params.behindRemote} behind origin`,
  ]
    .filter(Boolean)
    .join('\n');
}

interface DeleteBranchDialogState {
  open: boolean;
  branchName: string;
  isRemote: boolean;
  alsoDeleteLocal: boolean;
  alsoDeleteRemote: boolean;
  hasLocalCopy: boolean;
  hasRemoteCopy: boolean;
}

const INITIAL_DELETE_BRANCH_DIALOG: DeleteBranchDialogState = {
  open: false,
  branchName: '',
  isRemote: false,
  alsoDeleteLocal: true,
  alsoDeleteRemote: false,
  hasLocalCopy: false,
  hasRemoteCopy: false,
};

function DeleteBranchDialog({
  state,
  onStateChange,
  onConfirm,
}: {
  state: DeleteBranchDialogState;
  onStateChange: React.Dispatch<React.SetStateAction<DeleteBranchDialogState>>;
  onConfirm: () => void;
}) {
  const close = () => onStateChange(INITIAL_DELETE_BRANCH_DIALOG);
  const showLocalToggle = state.isRemote && state.hasLocalCopy;
  const showRemoteToggle = !state.isRemote && state.hasRemoteCopy;
  return (
    <Dialog open={state.open} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Warning className="size-5 text-destructive" />
            {state.isRemote ? 'Delete Remote Branch' : 'Delete Unmerged Branch'}
          </DialogTitle>
          <DialogDescription>
            {state.isRemote
              ? `This will delete branch "${state.branchName}" from the remote repository. This affects everyone with access to the repo.`
              : `Branch "${state.branchName}" has commits that haven't been merged into another branch. These commits will be lost if you delete this branch.`}
          </DialogDescription>
        </DialogHeader>
        {showLocalToggle && (
          <div className="flex items-center justify-between py-2">
            <label htmlFor="also-delete-local" className="text-sm">
              Also delete local copy
            </label>
            <Switch
              id="also-delete-local"
              checked={state.alsoDeleteLocal}
              onCheckedChange={(checked) =>
                onStateChange((prev) => ({ ...prev, alsoDeleteLocal: checked }))
              }
            />
          </div>
        )}
        {showRemoteToggle && (
          <div className="flex items-center justify-between py-2">
            <label htmlFor="also-delete-remote" className="text-sm">
              Also delete from remote
            </label>
            <Switch
              id="also-delete-remote"
              checked={state.alsoDeleteRemote}
              onCheckedChange={(checked) =>
                onStateChange((prev) => ({ ...prev, alsoDeleteRemote: checked }))
              }
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {state.isRemote ? 'Delete from Remote' : 'Delete Anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AheadAgentPromptItem({
  project,
  targetBranch,
  remoteDefaultBranch,
  aheadTargetBranch,
  onClick,
}: {
  project: Project | undefined;
  targetBranch: string;
  remoteDefaultBranch: string | undefined;
  aheadTargetBranch: number;
  onClick: () => void;
}) {
  const templateId = resolveActionId({ project, targetBranch, remoteDefaultBranch });
  if (!templateId) return null;
  const template = useActionsStore.getState().actions.find((t) => t.id === templateId);
  if (!template) return null;
  return (
    <DropdownMenuItem onClick={onClick}>
      {template.type === 'command' ? <Terminal /> : <Sparkle />}
      <span>{template.title}</span>
      <span className="ml-auto text-xs text-ahead">↑{aheadTargetBranch}</span>
    </DropdownMenuItem>
  );
}

interface UnifiedMenuProps {
  /** In the status bar, the trigger takes the status bar's compact item style. */
  inStatusBar?: boolean;
}

export function UnifiedMenu({ inStatusBar = false }: UnifiedMenuProps = {}) {
  const tooltipSide = branchTooltipSide(inStatusBar);
  const { projects } = useProjectsStore();
  const { selectedWorkspaceId, workspaces, updateWorkspace } = useWorkspacesStore();
  const { getStatus, invalidateStatus, fetchStatus, fetchStatusIfStale } = useGitStatusStore();
  const { addToast } = useToastStore();
  const { config, updateConfig } = useConfigStore();
  const startOperation = useGitProgressStore((s) => s.startOperation);
  const endOperation = useGitProgressStore((s) => s.endOperation);
  const { getStatus: getProjectSyncStatus, refreshStatus: refreshProjectSyncStatus } =
    useProjectSyncStatusStore();
  const { requestFileViewerTransition } = useFileViewerStore();

  // Loading states
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isRebasing, setIsRebasing] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isMergingToTargetBranch, setIsMergingToTargetBranch] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [_isPushingTargetBranch, setIsPushingTargetBranch] = useState(false);
  const [_isPullingTargetBranch, setIsPullingTargetBranch] = useState(false);
  // Single branch list (unified)
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [isBranchesLoading, setIsBranchesLoading] = useState(false);
  const [publishRepoDialogOpen, setPublishRepoDialogOpen] = useState(false);
  const [branchCleanupOpen, setBranchCleanupOpen] = useState(false);
  const [commitComposerOpen, setCommitComposerOpen] = useState(false);

  const [deleteBranchDialog, setDeleteBranchDialog] = useState<DeleteBranchDialogState>(
    INITIAL_DELETE_BRANCH_DIALOG
  );

  // Publish branch & create PR dialog
  const [publishPrDialogOpen, setPublishPrDialogOpen] = useState(false);
  const [publishingForPr, setPublishingForPr] = useState(false);

  // Stash & retry dialog for operations blocked by uncommitted changes
  const [stashDialog, setStashDialog] = useState<{
    open: boolean;
    operation: 'merge' | 'rebase';
    branchName: string;
  }>({ open: false, operation: 'rebase', branchName: '' });

  const remoteExpanded = config?.remoteBranchesExpanded ?? false;

  // Get active workspace info
  const activeWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);
  // Only this workspace's newest operation, so progress elsewhere doesn't re-render the menu.
  const gitOperation = useGitProgressStore((s) =>
    activeWorkspace ? latestGitOperation(s.operations, activeWorkspace.workingDirectory) : undefined
  );
  const isGitWorkspace = !!activeWorkspace?.isWorktree;
  const isRemoteWorkspace = activeWorkspace ? isSshWorkspace(activeWorkspace) : false;

  // Get the project for the active workspace
  const activeProjectCandidate = activeWorkspace?.projectId
    ? projects.find((p) => p.id === activeWorkspace.projectId)
    : undefined;
  // Get git status for active workspace
  const gitStatus = activeWorkspace ? getStatus(activeWorkspace.id)?.status : undefined;
  const activeProject =
    activeProjectCandidate?.kind === 'directory'
      ? undefined
      : activeProjectCandidate &&
        withGitDefaults(activeProjectCandidate, config?.gitDefaults, {
          hasOriginRemote: gitStatus?.hasOriginRemote,
        });
  const isManaged = activeProject?.managed ?? false;
  const behindTargetBranch = gitStatus?.behindTargetBranch ?? 0;
  const aheadTargetBranch = gitStatus?.aheadTargetBranch ?? 0;
  const targetBranch =
    resolveWorkspaceTargetBranch(
      activeWorkspace,
      activeProject?.baseBranch,
      gitStatus?.mainBranch
    ) || 'main';
  const hasRemote = gitStatus?.hasRemote ?? false;
  const hasOriginRemote = gitStatus?.hasOriginRemote ?? false;
  const remoteDefaultBranch = gitStatus?.remoteDefaultBranch;
  const unpushedCommits = gitStatus?.unpushedCommits ?? 0;
  const behindRemote = gitStatus?.behindRemote ?? 0;
  const rebaseInProgress = gitStatus?.rebaseInProgress ?? false;
  const showPublishRepo = needsRepoPublish({
    hasOriginRemote,
    hasRemote,
    targetBranchHasRemote: gitStatus?.targetBranchHasRemote ?? false,
  });

  // Match the backend target-branch rules so the UI only offers rebase when it is allowed.
  const isOnTargetBranch = activeWorkspace?.branchName === targetBranch;
  // A paused rebase leaves HEAD on a partly rebased commit, so hold back actions that would
  // sync it or send it to the target branch.
  const showSyncActions = !rebaseInProgress;
  const showTargetBranchActions = showSyncActions && !isOnTargetBranch;

  // Resolve ahead-of-target action
  const aheadAction = resolveAheadAction({
    project: activeProject,
    targetBranch,
    remoteDefaultBranch,
    hasOriginRemote,
  });

  const { show: hasUnpushedDisplay, count: unpushedDisplayCount } = resolveUnpushedDisplay({
    hasRemote,
    unpushedCommits,
  });

  // Get project sync status (project-level main branch remote status)
  const projectSyncStatus = activeProject ? getProjectSyncStatus(activeProject.id) : undefined;
  const targetBranchAheadRemote = isRemoteWorkspace
    ? (gitStatus?.targetBranchAheadRemote ?? 0)
    : (projectSyncStatus?.aheadRemote ?? 0);
  const _targetBranchBehindRemote = isRemoteWorkspace
    ? (gitStatus?.targetBranchBehindRemote ?? 0)
    : (projectSyncStatus?.behindRemote ?? 0);
  const targetBranchHasRemote =
    (isRemoteWorkspace ? gitStatus?.targetBranchHasRemote : projectSyncStatus?.hasRemote) ??
    gitStatus?.targetBranchHasRemote ??
    false;
  const lastFetched = projectSyncStatus?.lastFetched ?? null;
  const targetBranchWriteAction = resolveRemoteWriteAction({
    hasOriginRemote,
    hasRemote: targetBranchHasRemote,
  });

  // Flash the trigger button when target branch changes
  const triggerRef = useRef<HTMLButtonElement>(null);
  const prevTargetBranch = useRef(targetBranch);
  useEffect(() => {
    if (prevTargetBranch.current !== targetBranch && triggerRef.current) {
      const el = triggerRef.current;
      el.classList.add('animate-highlight-once');
      const onEnd = () => el.classList.remove('animate-highlight-once');
      el.addEventListener('animationend', onEnd, { once: true });
      prevTargetBranch.current = targetBranch;
      // Cleanup in case component unmounts mid-animation
      return () => {
        el.removeEventListener('animationend', onEnd);
        el.classList.remove('animate-highlight-once');
      };
    }
    prevTargetBranch.current = targetBranch;
  }, [targetBranch]);

  // Handlers
  const refreshActiveGitStatus = async (): Promise<void> => {
    if (!activeWorkspace) return;
    invalidateStatus(activeWorkspace.id);
    await fetchStatus(
      activeWorkspace.id,
      activeWorkspace.workingDirectory,
      activeWorkspace.projectId
    );
  };

  const handleFetchProject = async () => {
    if (!activeProject || !activeWorkspace) return;

    const operationId = `fetch-project-${activeWorkspace.id}-${Date.now()}`;
    setIsSyncing(true);
    startOperation(operationId, 'fetch', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.fetchWorkspaceRemote(activeWorkspace.id)
        : await window.api.fetchProject(activeProject.id);
      addToast(result.message, result.success ? 'success' : 'error');
      await refreshActiveGitStatus();
      if (result.success && !isRemoteWorkspace) {
        await refreshProjectSyncStatus(activeProject.id, true);
      }
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsSyncing(false);
    }
  };

  const handlePush = async () => {
    if (!activeWorkspace) return;

    setIsPushing(true);
    try {
      if (isRemoteWorkspace) {
        const operationId = `push-${activeWorkspace.id}-${Date.now()}`;
        startOperation(operationId, 'push', activeWorkspace.workingDirectory);
        try {
          const result = await window.api.pushWorkspace(activeWorkspace.id);
          if (!result.success) addToast(result.message, 'error');
        } finally {
          endOperation(operationId);
        }
      } else {
        await pushWithAutoRecover({
          workingDir: activeWorkspace.workingDirectory,
          operationPrefix: 'push',
          workspaceKey: activeWorkspace.id,
          pushFn: window.api.push,
          pullFn: window.api.pull,
          pullRebaseFn: isOnTargetBranch ? undefined : window.api.pullRebase,
          startOperation,
          endOperation,
          addToast,
        });
      }
      await refreshActiveGitStatus();
    } finally {
      setIsPushing(false);
    }
  };

  const handlePull = async () => {
    if (!activeWorkspace) return;

    const operationId = `pull-${activeWorkspace.id}-${Date.now()}`;
    setIsPulling(true);
    startOperation(operationId, 'pull', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.pullWorkspace(activeWorkspace.id)
        : await window.api.pull(activeWorkspace.workingDirectory);
      if (!result.success) addToast(result.message, 'error');
      await refreshActiveGitStatus();
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsPulling(false);
    }
  };

  const handleRebaseOnTargetBranch = async (options?: { stash?: boolean }) => {
    if (!activeWorkspace) return;

    const operationId = `rebase-${activeWorkspace.id}-${Date.now()}`;
    setIsRebasing(true);
    startOperation(operationId, 'rebase', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.rebaseWorkspaceOnBranch(activeWorkspace.id, targetBranch, options)
        : await window.api.rebaseOnTargetBranch(activeWorkspace.workingDirectory, options);
      if (!result.success && result.message.startsWith(UNCOMMITTED_CHANGES_PREFIX)) {
        setStashDialog({ open: true, operation: 'rebase', branchName: targetBranch });
        return;
      }
      await refreshActiveGitStatus();
      if (!result.success) addRebaseFailureToast(result.message, activeWorkspace);
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsRebasing(false);
    }
  };

  const handleRebaseOnBranch = async (branchName: string, options?: { stash?: boolean }) => {
    if (!activeWorkspace) return;

    const operationId = `rebase-${activeWorkspace.id}-${Date.now()}`;
    setIsRebasing(true);
    startOperation(operationId, 'rebase', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.rebaseWorkspaceOnBranch(activeWorkspace.id, branchName, options)
        : await window.api.rebaseOnBranch(activeWorkspace.workingDirectory, branchName, options);
      if (!result.success && result.message.startsWith(UNCOMMITTED_CHANGES_PREFIX)) {
        setStashDialog({ open: true, operation: 'rebase', branchName });
        return;
      }
      await refreshActiveGitStatus();
      if (!result.success) addRebaseFailureToast(result.message, activeWorkspace);
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsRebasing(false);
    }
  };

  const handleMergeToTargetBranch = async () => {
    if (!activeWorkspace) return;

    const operationId = `merge-${activeWorkspace.id}-${Date.now()}`;
    setIsMergingToTargetBranch(true);
    startOperation(operationId, 'fast-forward', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.mergeWorkspaceToTargetBranch(activeWorkspace.id)
        : await window.api.mergeToTargetBranch(activeWorkspace.workingDirectory);
      await refreshActiveGitStatus();

      if (
        result.success &&
        activeProject?.autoPushAfterMerge !== false &&
        targetBranchWriteAction !== 'none'
      ) {
        void handlePushTargetBranch();
      } else if (
        result.success &&
        isManaged &&
        activeProject &&
        targetBranchAheadRemote === 0 &&
        targetBranchWriteAction !== 'none'
      ) {
        addToast(result.message, 'success', {
          action: {
            label: targetBranchWriteAction === 'publish' ? 'Publish branch' : 'Push to remote',
            onClick: () => {
              void handlePushTargetBranch();
            },
          },
        });
      } else {
        if (!result.success) addToast(result.message, 'error');
      }
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsMergingToTargetBranch(false);
    }
  };

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
        recoverySuccessMessage: `Pulled and pushed ${targetBranch}`,
        startOperation,
        endOperation,
        addToast,
      });
      await refreshActiveGitStatus();
      if (result.success && activeProject) {
        await refreshProjectSyncStatus(activeProject.id, true);
      }
    } finally {
      setIsPushingTargetBranch(false);
    }
  };

  const _handlePullTargetBranch = async () => {
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

  const _handleMergeTargetBranchFromRemote = async () => {
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

  const handleMergeFrom = async (branchName: string, options?: { stash?: boolean }) => {
    if (!activeWorkspace) return;

    const operationId = `merge-${activeWorkspace.id}-${Date.now()}`;
    setIsMerging(true);
    startOperation(operationId, 'merge', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.mergeWorkspaceFrom(activeWorkspace.id, branchName, options)
        : await window.api.mergeFrom(activeWorkspace.workingDirectory, branchName, options);
      if (!result.success && result.message.startsWith(UNCOMMITTED_CHANGES_PREFIX)) {
        setStashDialog({ open: true, operation: 'merge', branchName });
        return;
      }
      if (!result.success) addToast(result.message, 'error');
      await refreshActiveGitStatus();
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsMerging(false);
    }
  };

  const handleStashAndRetry = async () => {
    const { operation, branchName } = stashDialog;
    setStashDialog((prev) => ({ ...prev, open: false }));
    if (operation === 'rebase') {
      if (branchName === targetBranch) {
        await handleRebaseOnTargetBranch({ stash: true });
      } else {
        await handleRebaseOnBranch(branchName, { stash: true });
      }
    } else {
      await handleMergeFrom(branchName, { stash: true });
    }
  };

  const loadBranches = async () => {
    if (!activeWorkspace || isBranchesLoading) return;

    setIsBranchesLoading(true);
    try {
      const branchList = await window.api.listWorkspaceBranches(activeWorkspace.id, true);
      setBranches(branchList);
    } catch (error) {
      console.error('Failed to load branches:', error);
      setBranches([]);
    } finally {
      setIsBranchesLoading(false);
    }
  };

  const handleFetchBranches = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!activeWorkspace || isFetching) return;

    const operationId = `fetch-${activeWorkspace.id}-${Date.now()}`;
    setIsFetching(true);
    startOperation(operationId, 'fetch', activeWorkspace.workingDirectory);
    try {
      if (isRemoteWorkspace) {
        const result = await window.api.fetchWorkspaceRemote(activeWorkspace.id);
        addToast(result.message, result.success ? 'success' : 'error');
      } else if (activeProject) {
        const result = await window.api.fetchProject(activeProject.id);
        addToast(result.message, result.success ? 'success' : 'error');
        if (result.success) {
          await refreshProjectSyncStatus(activeProject.id, true);
        }
      } else {
        const result = await window.api.fetchFromRemote(activeWorkspace.workingDirectory);
        if (!result.success) addToast(result.message, 'error');
      }
      await refreshActiveGitStatus();
      const branchList = await window.api.listWorkspaceBranches(activeWorkspace.id, true);
      setBranches(branchList);
    } catch (error) {
      console.error('Failed to fetch:', error);
      addToast(`Failed to fetch: ${(error as Error).message}`, 'error');
    } finally {
      endOperation(operationId);
      setIsFetching(false);
    }
  };

  const handleSwitchBranch = async (branchName: string) => {
    if (!activeWorkspace) return;

    const operationId = `switch-${activeWorkspace.id}-${Date.now()}`;
    setIsSwitching(true);
    startOperation(operationId, 'switch', activeWorkspace.workingDirectory);
    try {
      const result = isRemoteWorkspace
        ? await window.api.switchWorkspaceBranch(activeWorkspace.id, branchName)
        : await window.api.switchBranch(activeWorkspace.workingDirectory, branchName);
      if (result.success) {
        updateWorkspace(activeWorkspace.id, { branchName });
        if (!isRemoteWorkspace)
          await window.api.updateWorkspace(activeWorkspace.id, { branchName });
      } else {
        addToast(result.message, 'error');
      }
      invalidateStatus(activeWorkspace.id);
      void fetchStatusIfStale(
        activeWorkspace.id,
        activeWorkspace.workingDirectory,
        activeWorkspace.projectId
      );
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsSwitching(false);
    }
  };

  const handleCreateAndSwitchBranch = async (branchName: string) => {
    if (!activeWorkspace) return;

    setIsCreatingBranch(true);
    try {
      await window.api.createWorkspaceBranch(activeWorkspace.id, branchName);
    } catch (error) {
      addToast((error as Error).message, 'error');
      return;
    } finally {
      setIsCreatingBranch(false);
    }
    await handleSwitchBranch(branchName);
    try {
      setBranches(await window.api.listWorkspaceBranches(activeWorkspace.id, true));
    } catch {
      // The list loads again when the Branches menu next opens.
    }
  };

  const handleDeleteBranch = async (branchName: string, isRemote: boolean) => {
    if (!activeWorkspace) return;

    // Check if the branch has a counterpart (local copy for remote, remote copy for local)
    const hasLocalCopy = isRemote && branches.some((b) => b.name === branchName && !b.isRemoteOnly);
    const hasRemoteCopy =
      !isRemote && branches.some((b) => b.name === branchName && b.isRemoteOnly);

    // Remote branches always need confirmation
    if (isRemote) {
      setDeleteBranchDialog({
        open: true,
        branchName,
        isRemote: true,
        alsoDeleteLocal: true, // Default: checked
        alsoDeleteRemote: false,
        hasLocalCopy,
        hasRemoteCopy: false,
      });
      return;
    }

    // For local branches, try to delete first (might need confirmation if unmerged)
    const operationId = `delete-branch-${activeWorkspace.id}-${Date.now()}`;
    setIsDeleting(true);
    startOperation(operationId, 'delete', activeWorkspace.workingDirectory);
    try {
      const result = await window.api.deleteBranch(
        activeWorkspace.workingDirectory,
        branchName,
        false
      );

      // If local branch isn't fully merged, show confirmation dialog
      if (!result.success && result.message.includes('not fully merged')) {
        setDeleteBranchDialog({
          open: true,
          branchName,
          isRemote: false,
          alsoDeleteLocal: true,
          alsoDeleteRemote: false, // Default: unchecked
          hasLocalCopy: false,
          hasRemoteCopy,
        });
        return;
      }

      // Refresh branch list after deletion
      if (result.success) {
        const branchList = await window.api.listWorkspaceBranches(activeWorkspace.id, true);
        setBranches(branchList);
      } else {
        addToast(result.message, 'error');
      }
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsDeleting(false);
    }
  };

  const handleConfirmDeleteBranch = async () => {
    if (!activeWorkspace) return;

    const { branchName, isRemote, alsoDeleteLocal, alsoDeleteRemote } = deleteBranchDialog;
    setDeleteBranchDialog(INITIAL_DELETE_BRANCH_DIALOG);

    const operationId = `delete-branch-${activeWorkspace.id}-${Date.now()}`;
    setIsDeleting(true);
    startOperation(operationId, 'delete', activeWorkspace.workingDirectory);

    try {
      if (isRemote) {
        await deleteRemoteBranchWithOptionalLocal(
          activeWorkspace.workingDirectory,
          branchName,
          alsoDeleteLocal,
          addToast
        );
      } else {
        await forceDeleteLocalBranchWithOptionalRemote(
          activeWorkspace.workingDirectory,
          branchName,
          alsoDeleteRemote,
          addToast
        );
      }

      const branchList = await window.api.listWorkspaceBranches(activeWorkspace.id, true);
      setBranches(branchList);
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      endOperation(operationId);
      setIsDeleting(false);
    }
  };

  const handleOpenInBrowser = async () => {
    if (!activeWorkspace) return;

    try {
      const url = await window.api.getBranchUrl(activeWorkspace.workingDirectory);
      if (url) {
        await window.api.openExternal(url);
      } else {
        addToast('Could not determine repository URL', 'error');
      }
    } catch (error) {
      addToast((error as Error).message, 'error');
    }
  };

  const handleCreatePr = async () => {
    if (!activeWorkspace) return;

    try {
      // If the branch isn't published yet, show dialog to publish first
      if (!hasRemote) {
        setPublishPrDialogOpen(true);
        return;
      }

      const url = await window.api.getCreatePrUrl(activeWorkspace.workingDirectory);
      if (url) {
        await window.api.openExternal(url);
      } else {
        addToast('Could not determine PR URL', 'error');
      }
    } catch (error) {
      addToast((error as Error).message, 'error');
    }
  };

  const handlePublishAndCreatePr = async () => {
    if (!activeWorkspace) return;
    setPublishingForPr(true);
    try {
      const pushResult = await window.api.push(activeWorkspace.workingDirectory);
      if (!pushResult.success) {
        addToast(pushResult.message, 'error');
        return;
      }
      invalidateStatus(activeWorkspace.id);
      void fetchStatusIfStale(
        activeWorkspace.id,
        activeWorkspace.workingDirectory,
        activeWorkspace.projectId
      );
      const url = await window.api.getCreatePrUrl(activeWorkspace.workingDirectory);
      if (url) {
        await window.api.openExternal(url);
      } else {
        addToast('Could not determine PR URL', 'error');
      }
      setPublishPrDialogOpen(false);
    } catch {
      addToast('Failed to publish branch', 'error');
    } finally {
      setPublishingForPr(false);
    }
  };

  const { runAction, actionInputDialog } = useActionLauncher(activeWorkspace?.id);
  const handleRunAgentPrompt = async () => {
    if (!activeWorkspace || !activeProject) return;
    const actionId = resolveActionId({
      project: activeProject,
      targetBranch,
      remoteDefaultBranch,
    });
    if (!actionId) return;
    const template = findActionForProject(
      useActionsStore.getState().actions,
      actionId,
      activeProject.id
    );
    if (!template) {
      addToast('Quick command not available for this project', 'error');
      return;
    }
    // ↑N runs its Action in front, without making it the run button's.
    runAction(template, { kind: 'tab', setsDefault: false, front: true });
  };

  const handleCompareBranch = (branchName: string) => {
    if (!activeWorkspace) return;
    useFileViewerStore.getState().setFileViewerDiffComparisonBranch(activeWorkspace.id, branchName);
    requestFileViewerTransition({
      kind: 'mode',
      workspaceId: activeWorkspace.id,
      mode: 'diff',
    });
  };

  // Don't show if no active workspace or if there's nothing to show (non-git directory workspaces)
  if (!activeWorkspace || (!isGitWorkspace && !activeProject)) {
    return null;
  }

  const triggerContent = getTriggerContent({
    isGitWorkspace,
    branchName: activeWorkspace?.branchName,
    projectName: activeProject?.name,
    hasRemote,
    behindRemote,
    hasUnpushedDisplay,
    unpushedDisplayCount,
    rebaseInProgress,
  });

  return (
    <>
      {actionInputDialog}
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={triggerRef}
                variant="ghost"
                size="sm"
                className={branchTriggerClass(inStatusBar)}
                style={{ WebkitAppRegion: 'no-drag' }}
                aria-busy={gitOperation ? true : undefined}
              >
                <TriggerLabel operation={gitOperation}>{triggerContent}</TriggerLabel>
                <CaretDown className="caret size-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} className="whitespace-pre-line">
            {gitOperation ? (
              <GitOperationDetails operation={gitOperation} />
            ) : (
              getTriggerTooltip({
                isGitWorkspace,
                unpushed: hasUnpushedDisplay ? unpushedDisplayCount : 0,
                behindRemote: hasRemote ? behindRemote : 0,
              })
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-56 max-w-[calc(100vw-1rem)]"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {/* Branch-specific section */}
          {isGitWorkspace && (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <GitBranch className="size-3 shrink-0" />
                <span
                  className="min-w-0 flex-1 truncate font-mono leading-4"
                  title={activeWorkspace?.branchName}
                >
                  {activeWorkspace?.branchName}
                </span>
              </DropdownMenuLabel>

              {rebaseInProgress && (
                <>
                  <DropdownMenuItem
                    onClick={() => requestRebaseAbort(activeWorkspace)}
                    className="gap-2"
                  >
                    <ArrowCounterClockwise />
                    <span className="flex min-w-0 flex-col">
                      <span>Abort rebase</span>
                      <span className="text-xs text-muted-foreground">
                        Restore the branch from before the rebase
                      </span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}

              <DropdownMenuItem onSelect={() => setCommitComposerOpen(true)}>
                <GitCommit />
                <span>Commit changes…</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />

              {/* Get changes from target branch */}
              {showTargetBranchActions && behindTargetBranch > 0 && (
                <DropdownMenuItem
                  onClick={() => handleMergeFrom(targetBranch)}
                  disabled={isMerging}
                  className="gap-2"
                >
                  {isMerging ? <Spinner /> : <GitMerge />}
                  <span>Merge {targetBranch}</span>
                  <span className="ml-auto text-xs text-behind">↓{behindTargetBranch}</span>
                </DropdownMenuItem>
              )}
              {showTargetBranchActions && behindTargetBranch > 0 && (
                <DropdownMenuItem
                  onClick={() => handleRebaseOnTargetBranch()}
                  disabled={isRebasing}
                  className="gap-2"
                >
                  {isRebasing ? <Spinner /> : <GitFork />}
                  <span>Rebase on {targetBranch}</span>
                  <span className="ml-auto text-xs text-behind">↓{behindTargetBranch}</span>
                </DropdownMenuItem>
              )}

              {/* Separator between get/send groups when both have items */}
              {showTargetBranchActions && behindTargetBranch > 0 && aheadTargetBranch > 0 && (
                <DropdownMenuSeparator />
              )}

              {/* Send changes to target branch */}
              {showTargetBranchActions &&
                aheadTargetBranch > 0 &&
                (aheadAction === 'merge' || isRemoteWorkspace) && (
                  <DropdownMenuItem
                    onClick={handleMergeToTargetBranch}
                    disabled={isMergingToTargetBranch || behindTargetBranch > 0}
                    className="gap-2"
                  >
                    {isMergingToTargetBranch ? <Spinner /> : <GitMerge />}
                    <span className="flex min-w-0 flex-col">
                      <span>Fast-forward {targetBranch}</span>
                      {behindTargetBranch > 0 && (
                        <span className="text-xs text-muted-foreground">
                          Update from {targetBranch} first (↓{behindTargetBranch})
                        </span>
                      )}
                    </span>
                    <span className="ml-auto text-xs text-ahead">↑{aheadTargetBranch}</span>
                  </DropdownMenuItem>
                )}

              {!isRemoteWorkspace &&
                showTargetBranchActions &&
                aheadTargetBranch > 0 &&
                aheadAction === 'pr' && (
                  <DropdownMenuItem onClick={handleCreatePr}>
                    <GitPullRequest />
                    <span>Create PR</span>
                    <span className="ml-auto text-xs text-ahead">↑{aheadTargetBranch}</span>
                  </DropdownMenuItem>
                )}

              {showTargetBranchActions &&
                aheadTargetBranch > 0 &&
                (aheadAction === 'agent-prompt' || isRemoteWorkspace) && (
                  <AheadAgentPromptItem
                    project={activeProject}
                    targetBranch={targetBranch}
                    remoteDefaultBranch={remoteDefaultBranch}
                    aheadTargetBranch={aheadTargetBranch}
                    onClick={handleRunAgentPrompt}
                  />
                )}

              {/* Separator before sync group */}
              {showTargetBranchActions && (behindTargetBranch > 0 || aheadTargetBranch > 0) && (
                <DropdownMenuSeparator />
              )}

              {/* Sync: Pull (only when behind remote) and Push */}
              {showSyncActions && hasRemote && behindRemote > 0 && (
                <DropdownMenuItem onClick={handlePull} disabled={isPulling}>
                  {isPulling ? <Spinner /> : <ArrowLineDown />}
                  <span>Pull</span>
                  <span className="ml-auto text-xs text-behind">↓{behindRemote}</span>
                </DropdownMenuItem>
              )}

              {showSyncActions && hasOriginRemote && (
                <DropdownMenuItem onClick={handlePush} disabled={isPushing}>
                  {isPushing ? <Spinner /> : <CloudArrowUp />}
                  <span>
                    {resolveRemoteWriteAction({ hasOriginRemote, hasRemote }) === 'publish'
                      ? 'Publish branch'
                      : 'Push'}
                  </span>
                  {hasUnpushedDisplay && (
                    <span className="ml-auto text-xs text-ahead">{unpushedDisplayCount}</span>
                  )}
                </DropdownMenuItem>
              )}

              {showSyncActions && hasOriginRemote && <DropdownMenuSeparator />}

              <DropdownMenuItem
                onClick={() => {
                  if (!activeWorkspace) return;
                  requestFileViewerTransition({
                    kind: 'mode',
                    workspaceId: activeWorkspace.id,
                    mode: 'diff',
                    diffSubMode: 'history',
                  });
                }}
                className="gap-2"
              >
                <ClockCounterClockwise />
                <span>History</span>
              </DropdownMenuItem>

              {/* Remote actions: Create PR and Open in browser */}
              {showSyncActions &&
                !isRemoteWorkspace &&
                aheadTargetBranch > 0 &&
                aheadAction !== 'pr' && (
                  <DropdownMenuItem onClick={handleCreatePr}>
                    <GitPullRequest />
                    <span>{hasRemote ? 'Create PR' : 'Publish & create PR'}</span>
                  </DropdownMenuItem>
                )}

              {!isRemoteWorkspace && hasRemote && (
                <DropdownMenuItem onClick={handleOpenInBrowser}>
                  <ArrowSquareOut />
                  <span>Open in browser</span>
                </DropdownMenuItem>
              )}

              {activeProject && <DropdownMenuSeparator />}
            </>
          )}

          {/* Project section */}
          {activeProject && (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <Folder className="size-3" />
                {activeProject.name}
              </DropdownMenuLabel>

              {/* Publish repo (no origin remote, or one with none of the branches) */}
              {!isRemoteWorkspace && showPublishRepo && (
                <DropdownMenuItem onClick={() => setPublishRepoDialogOpen(true)}>
                  <CloudArrowUp />
                  <span>Publish repo</span>
                </DropdownMenuItem>
              )}

              {/* Fetch from remote (managed only) with inline timestamp */}
              {((!isRemoteWorkspace && isManaged) || isRemoteWorkspace) && hasOriginRemote && (
                <DropdownMenuItem
                  onClick={handleFetchProject}
                  disabled={isSyncing}
                  className={cn('gap-2', lastFetched && 'justify-between')}
                >
                  <span className="flex items-center gap-2">
                    {isSyncing ? <Spinner /> : <ArrowsClockwise />}
                    <span>Fetch</span>
                  </span>
                  {lastFetched && (
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(lastFetched)}
                    </span>
                  )}
                </DropdownMenuItem>
              )}

              {/* Leftover branches, in the clone on this workspace's host for an SSH workspace */}
              <DropdownMenuItem onClick={() => setBranchCleanupOpen(true)}>
                <Broom />
                <span>Clean up branches…</span>
              </DropdownMenuItem>
            </>
          )}

          {/* Branch picker */}
          {isGitWorkspace && (
            <>
              <BranchActionPicker
                branches={branches}
                isLoading={isBranchesLoading}
                currentBranch={activeWorkspace?.branchName}
                mainBranch={targetBranch}
                defaultBranch={gitStatus?.defaultBranch}
                behindTargetBranch={behindTargetBranch}
                remoteExpanded={remoteExpanded}
                onRemoteExpandedChange={(expanded) =>
                  updateConfig({ remoteBranchesExpanded: expanded })
                }
                onLoadBranches={loadBranches}
                onFetch={handleFetchBranches}
                isFetching={isFetching}
                hasOriginRemote={hasOriginRemote}
                onSwitch={handleSwitchBranch}
                onMerge={handleMergeFrom}
                onRebase={handleRebaseOnBranch}
                onDelete={handleDeleteBranch}
                onCompare={handleCompareBranch}
                onCreate={handleCreateAndSwitchBranch}
                isCreating={isCreatingBranch}
                isSwitching={isSwitching}
                isMerging={isMerging}
                isRebasing={isRebasing}
                isDeleting={isDeleting}
                allowCompare={!isRemoteWorkspace}
                allowDelete={!isRemoteWorkspace}
              />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {isGitWorkspace && (
        <CommitComposer
          key={activeWorkspace.id}
          workspaceId={activeWorkspace.id}
          workingDirectory={activeWorkspace.workingDirectory}
          isRemoteWorkspace={isRemoteWorkspace}
          onCommitted={async () => {
            invalidateStatus(activeWorkspace.id);
            await fetchStatusIfStale(
              activeWorkspace.id,
              activeWorkspace.workingDirectory,
              activeWorkspace.projectId,
              0
            );
          }}
          open={commitComposerOpen}
          onOpenChange={setCommitComposerOpen}
          showTrigger={false}
        />
      )}

      <DeleteBranchDialog
        state={deleteBranchDialog}
        onStateChange={setDeleteBranchDialog}
        onConfirm={handleConfirmDeleteBranch}
      />

      {/* Publish branch & create PR dialog */}
      <Dialog
        open={publishPrDialogOpen}
        onOpenChange={(open) => !open && setPublishPrDialogOpen(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Branch not published</DialogTitle>
            <DialogDescription>
              This branch hasn't been pushed to the remote yet. Publish it to create a pull request.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPublishPrDialogOpen(false)}
              disabled={publishingForPr}
            >
              Cancel
            </Button>
            <Button onClick={handlePublishAndCreatePr} disabled={publishingForPr}>
              {publishingForPr ? 'Publishing...' : 'Publish & create PR'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stash & retry confirmation dialog */}
      <Dialog
        open={stashDialog.open}
        onOpenChange={(open) => !open && setStashDialog((prev) => ({ ...prev, open: false }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uncommitted changes</DialogTitle>
            <DialogDescription>
              This branch has uncommitted changes. Stash them,{' '}
              {stashDialog.operation === 'rebase' ? 'rebase on' : 'merge from'}{' '}
              {stashDialog.branchName}, then re-apply?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setStashDialog((prev) => ({ ...prev, open: false }))}
            >
              Cancel
            </Button>
            <Button onClick={handleStashAndRetry}>
              Stash, {stashDialog.operation === 'rebase' ? 'rebase' : 'merge'} & unstash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeProject && (
        <BranchCleanupDialog
          projectId={activeProject.id}
          hostId={
            activeWorkspace && isSshWorkspace(activeWorkspace)
              ? activeWorkspace.backend.hostId
              : null
          }
          open={branchCleanupOpen}
          onOpenChange={setBranchCleanupOpen}
        />
      )}

      {/* Publish repo dialog */}
      {activeWorkspace && !isRemoteWorkspace && (
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
