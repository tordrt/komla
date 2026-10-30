import { FileMinus, FilePlus, FileText, Warning } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DeferredDialog } from '@/components/ui/DeferredDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActionLauncher } from '@/hooks/useActionLauncher';
import { findActionForProject } from '@/lib/action-visibility';
import { getGitTargetStatusScope } from '@/lib/git-target-status-scope';
import { cn } from '@/lib/utils';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';
import { useFileListStore } from '@/stores/file-list.store';
import { useGitProgressStore } from '@/stores/git-progress.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspaceObservationStore } from '@/stores/workspace-observation.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { resolveWorkspaceTargetBranch, type SshWorkspaceBackend } from '@/types';
import { pushWithAutoRecover } from '@/utils/push-with-recover';
import { addRebaseFailureToast } from '@/utils/rebase-abort';

import {
  resolveBehindAction,
  isDefaultBranchTarget,
  resolveAheadAction,
  resolveActionId,
  resolveRemoteWriteAction,
} from '../../../shared/lib/ahead-action';
import { withGitDefaults } from '../../../shared/lib/project-git-defaults';

import { CommitsAheadConfigDialog } from './CommitsAheadConfigDialog';
import {
  buildDiffChangePills,
  hasGitStatusToShow,
  type WorkspaceChangePill,
} from './git-status-summary';

function getSshCreatePrUrl(
  backend: SshWorkspaceBackend,
  branch = backend.branchName,
  target = backend.baseBranch
): string | null {
  if (!branch || !target) return null;

  let webUrl: string;
  let hostname: string;
  try {
    if (backend.gitUrl.startsWith('git@')) {
      const match = backend.gitUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
      if (!match) return null;
      hostname = match[1];
      webUrl = `https://${hostname}/${match[2].replace(/\.git$/, '')}`;
    } else {
      const remote = new URL(backend.gitUrl);
      hostname = remote.hostname;
      webUrl = `https://${hostname}${remote.pathname.replace(/\.git$/, '')}`;
    }
  } catch {
    return null;
  }

  const encodedBranch = encodeURIComponent(branch);
  const encodedTarget = encodeURIComponent(target);
  const normalizedHostname = hostname.toLowerCase();
  if (normalizedHostname.includes('gitlab')) {
    return `${webUrl}/-/merge_requests/new?merge_request[source_branch]=${encodedBranch}&merge_request[target_branch]=${encodedTarget}`;
  }
  if (normalizedHostname.includes('bitbucket')) {
    return `${webUrl}/pull-requests/new?source=${encodedBranch}&dest=${encodedTarget}`;
  }
  return `${webUrl}/compare/${encodedTarget}...${encodedBranch}?expand=1`;
}

interface GitStatusIndicatorProps {
  workspaceId: string;
  workingDirectory: string;
  projectId?: string | null;
  inactive?: boolean;
  /** Grey the diff stats, as on a stopped workspace's sidebar card. */
  muteDiffStats?: boolean;
}

const INACTIVE_POLL_INTERVAL_MS = 300_000;
const INACTIVE_MAX_AGE_MS = 300_000;

export function GitStatusIndicator({
  workspaceId,
  workingDirectory,
  projectId,
  inactive,
  muteDiffStats,
}: GitStatusIndicatorProps) {
  // Narrow selectors: every sidebar card and Overview row has one of these, so a whole-store
  // subscription would re-render all of them on any workspace's status change.
  const fetchStatus = useGitStatusStore((s) => s.fetchStatus);
  const fetchStatusIfStale = useGitStatusStore((s) => s.fetchStatusIfStale);
  const invalidateStatus = useGitStatusStore((s) => s.invalidateStatus);
  const clearBehindTargetBranch = useGitStatusStore((s) => s.clearBehindTargetBranch);
  const registerTargetStatusScope = useGitStatusStore((s) => s.registerTargetStatusScope);
  const cached = useGitStatusStore((s) => s.getStatus(workspaceId));
  const addToast = useToastStore((s) => s.addToast);
  const startOperation = useGitProgressStore((s) => s.startOperation);
  const endOperation = useGitProgressStore((s) => s.endOperation);
  const isSelected = useWorkspacesStore((s) => s.selectedWorkspaceId === workspaceId);
  const isReconnectingRemoteWorkspace = useWorkspacesStore((s) =>
    s.reconnectingSshWorkspaceIds.has(workspaceId)
  );
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const sshBackend = workspace?.backend?.kind === 'ssh' ? workspace.backend : undefined;
  const observationConfirmation = useWorkspaceObservationStore(
    (state) => state.projections.get(workspaceId)?.confirmation
  );
  const isStale = Boolean(sshBackend && observationConfirmation?.kind !== 'current');
  const diffSummary = useFileListStore(
    (state) =>
      state.getDiff(workingDirectory, undefined, false, sshBackend ? workspaceId : undefined)?.data
  );
  const projects = useProjectsStore((s) => s.projects);
  const gitDefaults = useConfigStore((s) => s.config?.gitDefaults);
  const savedProject = projectId ? projects.find((p) => p.id === projectId) : undefined;
  const project =
    savedProject &&
    withGitDefaults(savedProject, gitDefaults, {
      hasOriginRemote: cached?.status?.hasOriginRemote,
    });
  const targetStatusScope = getGitTargetStatusScope(
    workspace,
    resolveWorkspaceTargetBranch(workspace, project?.baseBranch)
  );
  const autoPushAfterMerge = project?.autoPushAfterMerge !== false;
  const [syncing, setSyncing] = useState(false);
  const [mergingToTargetBranch, setMergingToTargetBranch] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [stashRebaseDialogOpen, setStashRebaseDialogOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  // Resolve behind/ahead-of-target actions
  const hasRemote = cached?.status?.hasRemote ?? false;
  const hasOriginRemote = cached?.status?.hasOriginRemote ?? false;
  const targetBranchHasRemote = cached?.status?.targetBranchHasRemote ?? false;
  const targetBranch = resolveWorkspaceTargetBranch(
    workspace,
    project?.baseBranch,
    cached?.status?.mainBranch
  );
  const remoteDefaultBranch = cached?.status?.remoteDefaultBranch;
  const behindAction = resolveBehindAction({ project, hasRemote });
  const aheadAction = resolveAheadAction({
    project,
    targetBranch,
    remoteDefaultBranch,
    hasOriginRemote,
  });
  const isUnconfigured = project?.aheadTargetAction === 'unconfigured';
  const targetBranchWriteAction = resolveRemoteWriteAction({
    hasOriginRemote,
    hasRemote: targetBranchHasRemote,
  });

  const fetchFileStatusesIfNeeded = useFileListStore((state) => state.fetchFileStatusesIfNeeded);
  const fetchDiffIfNeeded = useFileListStore((state) => state.fetchDiffIfNeeded);

  useEffect(() => {
    if (targetStatusScope) registerTargetStatusScope(workspaceId, targetStatusScope);

    // Restored SSH workspaces can be shown as active from their last-known tmux
    // state. Do not turn that visual hint into a connection attempt on launch;
    // remote metadata is refreshed when the user actually selects the workspace.
    if (sshBackend && (!isSelected || isReconnectingRemoteWorkspace)) return;

    // Fetch branch status and file statuses on mount (workspace activation).
    // File statuses populate diffCache with files and summary counts for the indicator.
    // Subsequent updates come from file watcher events (active) or polling (inactive).
    void fetchStatusIfStale(
      workspaceId,
      workingDirectory,
      projectId,
      inactive ? INACTIVE_MAX_AGE_MS : undefined,
      targetStatusScope
    );
    if (sshBackend) {
      void fetchDiffIfNeeded(workingDirectory, undefined, false, workspaceId);
    } else {
      void fetchFileStatusesIfNeeded(workingDirectory);
    }

    if (inactive) {
      const interval = setInterval(() => {
        void fetchStatusIfStale(
          workspaceId,
          workingDirectory,
          projectId,
          INACTIVE_MAX_AGE_MS,
          targetStatusScope
        );
      }, INACTIVE_POLL_INTERVAL_MS);
      return () => clearInterval(interval);
    }
  }, [
    workspaceId,
    workingDirectory,
    projectId,
    fetchStatusIfStale,
    fetchFileStatusesIfNeeded,
    fetchDiffIfNeeded,
    sshBackend,
    isSelected,
    isReconnectingRemoteWorkspace,
    inactive,
    targetStatusScope,
    registerTargetStatusScope,
  ]);

  const doRebase = async () => {
    // Always pass stash: true — the backend only stashes when there are actual
    // uncommitted changes, so this is a safe default that avoids mismatches
    // between the frontend dirty-detection (additions/deletions) and the
    // backend's more comprehensive `git status --porcelain` check.
    const operationId = `rebase-${workspaceId}-${Date.now()}`;
    setSyncing(true);
    startOperation(operationId, 'rebase', workingDirectory);
    try {
      const response = sshBackend
        ? await window.api.rebaseWorkspaceOnBranch(workspaceId, targetBranch || 'main', {
            stash: true,
          })
        : await window.api.rebaseOnTargetBranch(workingDirectory, { stash: true });
      if (response.success) {
        clearBehindTargetBranch(workspaceId, targetBranch || 'main');
      } else {
        invalidateStatus(workspaceId);
        await fetchStatusIfStale(workspaceId, workingDirectory, projectId);
        addRebaseFailureToast(response.message, { id: workspaceId, workingDirectory, projectId });
      }
    } catch {
      addToast('Sync failed', 'error');
    } finally {
      endOperation(operationId);
      setSyncing(false);
    }
  };

  const doMergeFromMain = async () => {
    const mainBranch = cached?.status?.mainBranch;
    if (!mainBranch) return;
    const operationId = `merge-from-${workspaceId}-${Date.now()}`;
    setSyncing(true);
    startOperation(operationId, 'merge', workingDirectory);
    try {
      const response = sshBackend
        ? await window.api.mergeWorkspaceFrom(workspaceId, mainBranch, { stash: true })
        : await window.api.mergeFrom(workingDirectory, mainBranch, { stash: true });
      if (response.success) {
        clearBehindTargetBranch(workspaceId, mainBranch);
      } else {
        addToast(response.message, 'error');
        invalidateStatus(workspaceId);
        await fetchStatusIfStale(workspaceId, workingDirectory, projectId);
      }
    } catch {
      addToast('Merge failed', 'error');
    } finally {
      endOperation(operationId);
      setSyncing(false);
    }
  };

  const handleSyncWithMain = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncing) return;

    if (behindAction === 'merge') {
      await doMergeFromMain();
      return;
    }

    // If there are uncommitted changes, show confirmation dialog
    if (diffSummary && diffSummary.files.length > 0) {
      setStashRebaseDialogOpen(true);
      return;
    }

    await doRebase();
  };

  const handleStashAndRebase = async () => {
    setStashRebaseDialogOpen(false);
    await doRebase();
  };

  const handleMergeToTargetBranch = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (mergingToTargetBranch) return;

    const operationId = `merge-${workspaceId}-${Date.now()}`;
    setMergingToTargetBranch(true);
    startOperation(operationId, 'fast-forward', workingDirectory);
    try {
      const response = sshBackend
        ? await window.api.mergeWorkspaceToTargetBranch(workspaceId)
        : await window.api.mergeToTargetBranch(workingDirectory);
      if (!response.success) addToast(response.message, 'error');
      // Auto-push main to remote if setting is enabled
      if (response.success && autoPushAfterMerge && targetBranchWriteAction !== 'none') {
        await pushWithAutoRecover({
          workingDir: workingDirectory,
          operationPrefix: 'auto-push-main',
          workspaceKey: workspaceId,
          pushFn: sshBackend
            ? () => window.api.pushWorkspaceTargetBranch(workspaceId)
            : window.api.pushTargetBranch,
          pullFn: sshBackend
            ? () => window.api.pullWorkspaceTargetBranch(workspaceId)
            : window.api.pullTargetBranch,
          recoverySuccessMessage: 'Pulled and pushed to remote',
          startOperation,
          endOperation,
          addToast,
        });
      }

      // Refresh after the complete merge/push sequence so the target-vs-origin
      // snapshot cannot remain stuck at the intermediate pre-push state.
      const affectedWorkspaces = response.success
        ? useWorkspacesStore.getState().workspaces.filter((candidate) => {
            if (candidate.status !== 'active' || !candidate.workingDirectory) return false;
            if (targetStatusScope) {
              const candidateProject = candidate.projectId
                ? projects.find((candidateProject) => candidateProject.id === candidate.projectId)
                : undefined;
              return (
                getGitTargetStatusScope(
                  candidate,
                  resolveWorkspaceTargetBranch(candidate, candidateProject?.baseBranch)
                ) === targetStatusScope
              );
            }
            return projectId ? candidate.projectId === projectId : candidate.id === workspaceId;
          })
        : workspace
          ? [workspace]
          : [];
      await Promise.all(
        affectedWorkspaces.map((candidate) => {
          invalidateStatus(candidate.id);
          return fetchStatus(
            candidate.id,
            candidate.workingDirectory,
            candidate.projectId,
            getGitTargetStatusScope(
              candidate,
              resolveWorkspaceTargetBranch(
                candidate,
                projects.find((candidateProject) => candidateProject.id === candidate.projectId)
                  ?.baseBranch
              )
            )
          );
        })
      );
    } catch {
      addToast(`Fast-forward of ${targetBranch || 'main'} failed`, 'error');
    } finally {
      endOperation(operationId);
      setMergingToTargetBranch(false);
    }
  };

  const handleCreatePr = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      // If the branch isn't published yet, show dialog to publish first
      if (!hasRemote) {
        setPublishDialogOpen(true);
        return;
      }

      const url = sshBackend
        ? getSshCreatePrUrl(sshBackend, workspace?.branchName, targetBranch)
        : await window.api.getCreatePrUrl(workingDirectory);
      if (url) {
        await window.api.openExternal(url);
      } else {
        addToast('Could not determine PR URL', 'error');
      }
    } catch {
      addToast('Failed to open PR page', 'error');
    }
  };

  const handlePublishAndCreatePr = async () => {
    setPublishing(true);
    try {
      const pushResult = sshBackend
        ? await window.api.pushWorkspace(workspaceId)
        : await window.api.push(workingDirectory);
      if (!pushResult.success) {
        addToast(pushResult.message, 'error');
        return;
      }
      invalidateStatus(workspaceId);
      void fetchStatusIfStale(workspaceId, workingDirectory, projectId);
      const url = sshBackend
        ? getSshCreatePrUrl(sshBackend, workspace?.branchName, targetBranch)
        : await window.api.getCreatePrUrl(workingDirectory);
      if (url) {
        await window.api.openExternal(url);
      } else {
        addToast('Could not determine PR URL', 'error');
      }
      setPublishDialogOpen(false);
    } catch {
      addToast('Failed to publish branch', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const { runAction, actionInputDialog } = useActionLauncher(workspaceId);
  const runQuickCommand = (actionId: string | undefined) => {
    if (!actionId) {
      addToast(
        "Pick the quick command ↑N runs in Settings → Git or the project's settings",
        'error'
      );
      return;
    }
    const template = findActionForProject(useActionsStore.getState().actions, actionId, projectId);
    if (!template) {
      addToast('Quick command not available for this project', 'error');
      return;
    }
    // ↑N runs its Action in front, without making it the run button's.
    runAction(template, { kind: 'tab', setsDefault: false, front: true });
  };
  const handleRunAgentPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!project) return;
    runQuickCommand(resolveActionId({ project, targetBranch, remoteDefaultBranch }));
  };
  // The first click asked what ↑N should do; saving the answer does it.
  const handleAheadChoiceSaved = (action: AheadAction, actionId: string | undefined) => {
    if (action === 'pr') void handleCreatePr();
    else if (action === 'merge') void handleMergeToTargetBranch();
    else if (action === 'agent-prompt') runQuickCommand(actionId);
  };

  const changePills = buildDiffChangePills(diffSummary);

  // Don't render if no status yet or if clean and up-to-date
  if (!cached?.status || !hasGitStatusToShow(cached.status, changePills.length > 0)) {
    return null;
  }

  const { behindTargetBranch, aheadTargetBranch, mainBranch, rebaseInProgress } = cached.status;

  return (
    <>
      {actionInputDialog}
      <div
        className={`flex items-center gap-2 text-xs font-mono${isStale ? ' opacity-40 saturate-50' : ''}`}
        title={
          isStale
            ? 'Remote workspace status may be stale; waiting for the companion to reconnect'
            : undefined
        }
      >
        {changePills.length > 0 && <DiffSummaryStats pills={changePills} muted={muteDiffStats} />}
        {/* Shortcuts would act on the half-rebased branch, so the pill replaces them. */}
        {rebaseInProgress && <RebasePausedPill />}
        {!rebaseInProgress && aheadTargetBranch > 0 && (
          <AheadTargetBranchButton
            aheadTargetBranch={aheadTargetBranch}
            behindTargetBranch={behindTargetBranch}
            mainBranch={mainBranch}
            inactive={inactive}
            isUnconfigured={isUnconfigured}
            aheadAction={aheadAction}
            mergingToTargetBranch={mergingToTargetBranch}
            project={project}
            projectId={projectId}
            targetBranch={targetBranch}
            remoteDefaultBranch={remoteDefaultBranch}
            autoPushAfterMerge={autoPushAfterMerge}
            targetBranchWriteAction={targetBranchWriteAction}
            configDialogOpen={configDialogOpen}
            setConfigDialogOpen={setConfigDialogOpen}
            onCreatePr={handleCreatePr}
            onRunAgentPrompt={handleRunAgentPrompt}
            onMergeToTargetBranch={handleMergeToTargetBranch}
            hasOriginRemote={hasOriginRemote}
            onAheadChoiceSaved={handleAheadChoiceSaved}
          />
        )}
        {!rebaseInProgress && behindTargetBranch > 0 && (
          <BehindTargetBranchButton
            behindTargetBranch={behindTargetBranch}
            mainBranch={mainBranch}
            inactive={inactive}
            syncing={syncing}
            behindAction={behindAction}
            onClick={handleSyncWithMain}
          />
        )}
      </div>

      {/* Publish branch & create PR dialog. Deferred, like the one below: every card and row
          has an indicator. */}
      <DeferredDialog open={publishDialogOpen}>
        <Dialog
          open={publishDialogOpen}
          onOpenChange={(open) => !open && setPublishDialogOpen(false)}
        >
          <DialogContent onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle>Branch not published</DialogTitle>
              <DialogDescription>
                This branch hasn't been pushed to the remote yet. Publish it to create a pull
                request.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPublishDialogOpen(false)}
                disabled={publishing}
              >
                Cancel
              </Button>
              <Button onClick={handlePublishAndCreatePr} disabled={publishing}>
                {publishing ? 'Publishing...' : 'Publish & create PR'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DeferredDialog>

      {/* Stash & rebase confirmation dialog */}
      <DeferredDialog open={stashRebaseDialogOpen}>
        <Dialog
          open={stashRebaseDialogOpen}
          onOpenChange={(open) => !open && setStashRebaseDialogOpen(false)}
        >
          <DialogContent onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle>Uncommitted changes</DialogTitle>
              <DialogDescription>
                This branch has uncommitted changes. Stash them, rebase on{' '}
                {cached?.status?.mainBranch}, then re-apply?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStashRebaseDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleStashAndRebase}>Stash, rebase & unstash</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DeferredDialog>
    </>
  );
}

function RebasePausedPill() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex cursor-default items-center gap-0.5 text-warning">
          <Warning className="size-3" aria-hidden="true" />
          rebasing
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>
          Rebase paused
          <br />
          <span className="text-muted-foreground">
            Resolve conflicts and continue it, or abort it from the branch menu
          </span>
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

// Plain colored numbers, so diff stats can't be mistaken for the agent status pills.
function DiffSummaryStats({
  pills,
  muted,
}: {
  pills: WorkspaceChangePill[];
  muted: boolean | undefined;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {pills.map((pill) => (
        <span
          key={pill.kind}
          className={cn(
            'inline-flex items-center gap-0.5',
            muted ? 'text-muted-foreground' : DIFF_STAT_TEXT_CLASS[pill.kind]
          )}
          title={pill.title}
        >
          <DiffSummaryStatIcon kind={pill.kind} />
          {pill.label}
          {FILE_PILL_LABELS[pill.kind] && (
            <span className="sr-only">
              {` ${FILE_PILL_LABELS[pill.kind]} ${pill.count === 1 ? 'file' : 'files'}`}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function DiffSummaryStatIcon({ kind }: { kind: WorkspaceChangePill['kind'] }) {
  if (kind === 'new-files') {
    return <FilePlus className="size-3" aria-hidden="true" />;
  }
  if (kind === 'deleted-files') {
    return <FileMinus className="size-3" aria-hidden="true" />;
  }
  if (kind === 'modified-files') {
    return <FileText className="size-3" aria-hidden="true" />;
  }
  return null;
}

// The file-count stats show only an icon and a number; screen readers get the kind as text.
const FILE_PILL_LABELS: Partial<Record<WorkspaceChangePill['kind'], string>> = {
  'new-files': 'new',
  'deleted-files': 'deleted',
  'modified-files': 'modified',
};

const DIFF_STAT_TEXT_CLASS: Record<WorkspaceChangePill['kind'], string> = {
  additions: 'text-success',
  'new-files': 'text-success',
  deletions: 'text-error',
  'deleted-files': 'text-error',
  'modified-files': 'text-warning',
};

type AheadAction = ReturnType<typeof resolveAheadAction>;
type BehindAction = ReturnType<typeof resolveBehindAction>;
type RemoteWriteAction = ReturnType<typeof resolveRemoteWriteAction>;
type ProjectLike = Parameters<typeof resolveActionId>[0]['project'];

interface AheadTargetBranchButtonProps {
  aheadTargetBranch: number;
  behindTargetBranch: number;
  mainBranch: string;
  inactive: boolean | undefined;
  isUnconfigured: boolean;
  aheadAction: AheadAction;
  mergingToTargetBranch: boolean;
  project: ProjectLike;
  projectId: string | null | undefined;
  targetBranch: string | undefined;
  remoteDefaultBranch: string | undefined;
  autoPushAfterMerge: boolean;
  targetBranchWriteAction: RemoteWriteAction;
  configDialogOpen: boolean;
  setConfigDialogOpen: (open: boolean) => void;
  onCreatePr: (e: React.MouseEvent) => Promise<void>;
  onRunAgentPrompt: (e: React.MouseEvent) => Promise<void>;
  onMergeToTargetBranch: (e: React.MouseEvent) => Promise<void>;
  hasOriginRemote: boolean;
  onAheadChoiceSaved: (action: AheadAction, actionId: string | undefined) => void;
}

function resolveAheadClickHandler(
  props: Pick<
    AheadTargetBranchButtonProps,
    | 'isUnconfigured'
    | 'aheadAction'
    | 'setConfigDialogOpen'
    | 'onCreatePr'
    | 'onRunAgentPrompt'
    | 'onMergeToTargetBranch'
  >
) {
  if (props.isUnconfigured) {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      props.setConfigDialogOpen(true);
    };
  }
  if (props.aheadAction === 'pr') return props.onCreatePr;
  if (props.aheadAction === 'agent-prompt') return props.onRunAgentPrompt;
  return props.onMergeToTargetBranch;
}

function buildAheadTooltip(
  props: Pick<
    AheadTargetBranchButtonProps,
    | 'aheadTargetBranch'
    | 'behindTargetBranch'
    | 'mainBranch'
    | 'inactive'
    | 'isUnconfigured'
    | 'aheadAction'
    | 'project'
    | 'projectId'
    | 'targetBranch'
    | 'remoteDefaultBranch'
    | 'autoPushAfterMerge'
    | 'targetBranchWriteAction'
  > & { canClickAhead: boolean }
) {
  const base = `${props.aheadTargetBranch} commit${props.aheadTargetBranch > 1 ? 's' : ''} ahead of ${props.mainBranch}`;
  if (props.isUnconfigured) return `${base}\nClick to choose what ↑N does`;
  // Merging waits until the branch has the target's new commits.
  if (!props.inactive && props.aheadAction === 'merge' && props.behindTargetBranch > 0) {
    return `${base}\nUpdate from ${props.mainBranch} first (↓${props.behindTargetBranch})`;
  }
  if (!props.canClickAhead) return base;
  if (props.aheadAction === 'pr') return `${base}\nClick to create pull request`;
  if (props.aheadAction === 'agent-prompt') {
    const templateId = resolveActionId({
      project: props.project,
      targetBranch: props.targetBranch,
      remoteDefaultBranch: props.remoteDefaultBranch,
    });
    const template = findActionForProject(
      useActionsStore.getState().actions,
      templateId,
      props.projectId
    );
    return `${base}\nClick to run: ${template?.title || 'quick command'}`;
  }
  const pushSuffix =
    props.autoPushAfterMerge && props.targetBranchWriteAction !== 'none'
      ? ` and ${props.targetBranchWriteAction}`
      : '';
  return `${base}\nClick to fast-forward ${props.mainBranch}${pushSuffix}`;
}

function AheadTargetBranchButton(props: AheadTargetBranchButtonProps) {
  const {
    aheadTargetBranch,
    behindTargetBranch,
    inactive,
    isUnconfigured,
    aheadAction,
    mergingToTargetBranch,
    projectId,
    configDialogOpen,
    setConfigDialogOpen,
  } = props;

  const canClickAhead =
    !inactive &&
    (isUnconfigured ||
      (aheadAction !== 'disabled' && (aheadAction !== 'merge' || behindTargetBranch === 0)));
  const onClick = resolveAheadClickHandler(props);
  const disabled = aheadAction === 'merge' && mergingToTargetBranch;
  const tooltip = buildAheadTooltip({ ...props, canClickAhead });
  const label = mergingToTargetBranch && aheadAction === 'merge' ? '...' : `↑${aheadTargetBranch}`;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {canClickAhead ? (
            <button
              type="button"
              data-own-tooltip
              onClick={onClick}
              disabled={disabled}
              className="cursor-pointer text-ahead hover:text-ahead/80 hover:underline disabled:cursor-wait disabled:opacity-50"
            >
              {label}
            </button>
          ) : (
            <span data-own-tooltip className="cursor-default text-ahead">
              ↑{aheadTargetBranch}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="right">
          <p className="whitespace-pre-line">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
      {/* Mounted only while open, so each open starts from the quick commands loaded by then. */}
      {isUnconfigured && projectId && configDialogOpen && (
        <CommitsAheadConfigDialog
          projectId={projectId}
          targetBranch={props.targetBranch || props.mainBranch}
          targetIsDefault={isDefaultBranchTarget(props.targetBranch, props.remoteDefaultBranch)}
          remoteDefaultBranch={props.remoteDefaultBranch}
          hasOriginRemote={props.hasOriginRemote}
          pushAfterFastForward={
            props.autoPushAfterMerge && props.targetBranchWriteAction !== 'none'
          }
          targetBranchOnOrigin={props.targetBranchWriteAction === 'push'}
          canFastForward={behindTargetBranch === 0}
          onClose={() => setConfigDialogOpen(false)}
          onSaved={props.onAheadChoiceSaved}
        />
      )}
    </>
  );
}

interface BehindTargetBranchButtonProps {
  behindTargetBranch: number;
  mainBranch: string;
  inactive: boolean | undefined;
  syncing: boolean;
  behindAction: BehindAction;
  onClick: (e: React.MouseEvent) => Promise<void>;
}

function BehindTargetBranchButton({
  behindTargetBranch,
  mainBranch,
  inactive,
  syncing,
  behindAction,
  onClick,
}: BehindTargetBranchButtonProps) {
  const clickHint =
    behindAction === 'merge'
      ? `merge ${mainBranch} into current branch`
      : `rebase on ${mainBranch}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {!inactive ? (
          <button
            type="button"
            data-own-tooltip
            onClick={onClick}
            disabled={syncing}
            className="cursor-pointer text-behind hover:text-behind/80 hover:underline disabled:cursor-wait disabled:opacity-50"
          >
            {syncing ? '...' : `↓${behindTargetBranch}`}
          </button>
        ) : (
          <span data-own-tooltip className="cursor-default text-behind">
            ↓{behindTargetBranch}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>
          {behindTargetBranch} commit{behindTargetBranch > 1 ? 's' : ''} behind {mainBranch}
          {!inactive && (
            <>
              <br />
              <span className="text-muted-foreground">Click to {clickHint}</span>
            </>
          )}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
