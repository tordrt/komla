import {
  ArrowsClockwise,
  Broom,
  CaretDown,
  CaretRight,
  Cloud,
  Copy,
  EyeSlash,
  GearSix,
  GitBranch,
  MagnifyingGlass,
  Plus,
  Sparkle,
  Terminal,
  Wrench,
} from '@phosphor-icons/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { BranchCleanupDialog } from '@/components/projects/BranchCleanupDialog';
import { WorkspaceCleanupDialog } from '@/components/projects/WorkspaceCleanupDialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { DeferredDialog } from '@/components/ui/DeferredDialog';
import { Spinner } from '@/components/ui/spinner';
import { ActionInputDialog } from '@/components/workspaces/ActionInputDialog';
import {
  injectActionContext,
  ACTION_TARGET_BRANCH_TOKEN,
  actionNeedsInjection,
} from '@/lib/action-injection';
import { startCommandInCreatedWorkspace } from '@/lib/action-launch';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { qualifyBaseBranch, refreshIfBaseIsRemoteOnly } from '@/lib/remote-base-branch';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { handleCreateError } from '@/utils/workspace-error';

import { projectRepoPath } from '../../../shared/lib/project-repo-path';
import { generateBranchSuffix, branchSuffixToName } from '../../../shared/lib/random-names';

import { MoveToWindowMenuItems } from './MoveToWindowMenu';

import type { BranchInfo, Project, Action } from '@/types';

/** Branch spec for action launches: null = clean new branch, otherwise an exact branch */
type BranchSpec = { name: string; isRemoteOnly: boolean } | null;

interface PendingActionLaunch {
  action: Action;
  branch: BranchSpec;
}

interface ProjectGroupContextMenuProps {
  project: Project;
  children: React.ReactNode;
}

export function ProjectGroupContextMenu({ project, children }: ProjectGroupContextMenuProps) {
  // Narrow selectors: every project group has one, and workspaces change on every agent title.
  const actions = useActionsStore((s) => s.actions);
  const loadActions = useActionsStore((s) => s.loadActions);
  const recordActionUsage = useActionsStore((s) => s.recordActionUsage);
  const createWorkspace = useWorkspacesStore((s) => s.createWorkspace);
  const hideProjectGroup = useWorkspacesStore((s) => s.hideProjectGroup);
  const moveWorkspacesToWindow = useWorkspacesStore((s) => s.moveWorkspacesToWindow);
  const hasActiveWorkspace = useWorkspacesStore((s) =>
    s.workspaces.some((w) => w.projectId === project.id && w.status === 'active')
  );
  const currentWindowId = useWindowStore((s) => s.windowId);
  const availableWindows = useWindowStore((s) => s.availableWindows);
  const remoteExpanded = useConfigStore((s) => s.config?.remoteBranchesExpanded) ?? false;
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const [isCreating, setIsCreating] = useState(false);
  const [actionInputDialogOpen, setActionInputDialogOpen] = useState(false);
  const [branchCleanupOpen, setBranchCleanupOpen] = useState(false);
  const [workspaceCleanupOpen, setWorkspaceCleanupOpen] = useState(false);
  const [pendingActionLaunch, setPendingActionLaunch] = useState<PendingActionLaunch | null>(null);

  // Branch picker state
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchFilter, setBranchFilter] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const branchFilterRef = useRef<HTMLInputElement>(null);
  const isDirectoryProject = project.kind === 'directory';

  const handleOpenChange = (open: boolean) => {
    if (open) {
      void loadActions();
    } else {
      setBranchesLoaded(false);
      setBranches([]);
      setBranchFilter('');
    }
  };

  const handleMoveProjectToWindow = async (targetWindowId: string) => {
    // Only move active workspaces — ones in the Trash are shared across all windows
    const toMove = useWorkspacesStore
      .getState()
      .workspaces.filter(
        (w) => w.projectId === project.id && w.status === 'active' && w.windowId !== targetWindowId
      );
    await moveWorkspacesToWindow(
      toMove.map((w) => w.id),
      targetWindowId
    );
  };

  const handleMoveProjectToNewWindow = async () => {
    const newWindowId = await window.api.createWindow();
    await handleMoveProjectToWindow(newWindowId);
  };

  const getRepoPath = useCallback((): string => projectRepoPath(project), [project]);

  const loadBranches = useCallback(async () => {
    if (branchesLoaded || branchesLoading) return;
    setBranchesLoading(true);
    try {
      const branchList = await window.api.listBranches(getRepoPath(), true);
      setBranches(branchList);
      setBranchesLoaded(true);
    } catch {
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  }, [branchesLoaded, branchesLoading, getRepoPath]);

  const handleFetch = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFetching) return;
      setIsFetching(true);
      try {
        await window.api.fetchFromRemote(getRepoPath());
        const branchList = await window.api.listBranches(getRepoPath(), true);
        setBranches(branchList);
      } catch {
        /* ignore */
      } finally {
        setIsFetching(false);
      }
    },
    [isFetching, getRepoPath]
  );

  const handleNewWorkspace = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      if (isDirectoryProject) {
        await createWorkspace({ mode: 'directory', projectId: project.id });
        return;
      }

      const suffix = generateBranchSuffix();
      const name = branchSuffixToName(suffix);
      await createWorkspace({
        name,
        mode: 'worktree',
        branchName: suffix,
        projectId: project.id,
        autoResolveBranchConflicts: true,
      });
    } catch (err) {
      handleCreateError(err, () => void handleNewWorkspace());
    } finally {
      setIsCreating(false);
    }
  };

  const openOnBranch = async (branchName: string, fetchRemote?: boolean) => {
    const name = `${project.name} (${branchName})`;
    await createWorkspace({
      name,
      mode: 'worktree',
      branchName,
      projectId: project.id,
      useExactBranchName: true,
      fetchRemote,
    });
  };

  const handleBranchClick = async (branchName: string, fetchRemote?: boolean) => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      await openOnBranch(branchName, fetchRemote);
    } catch (err) {
      handleCreateError(err, () => void handleBranchClick(branchName, fetchRemote));
    } finally {
      setIsCreating(false);
    }
  };

  const handleNewFromBranch = async (baseBranchName: string, baseIsRemoteOnly: boolean) => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      await refreshIfBaseIsRemoteOnly(getRepoPath(), baseIsRemoteOnly);
      const suffix = generateBranchSuffix();
      const name = branchSuffixToName(suffix);
      await createWorkspace({
        name,
        mode: 'worktree',
        branchName: suffix,
        projectId: project.id,
        baseBranch: qualifyBaseBranch(baseBranchName, baseIsRemoteOnly),
        autoResolveBranchConflicts: true,
      });
    } catch (err) {
      handleCreateError(err, () => void handleNewFromBranch(baseBranchName, baseIsRemoteOnly));
    } finally {
      setIsCreating(false);
    }
  };

  // Filter actions: global + scoped to this project
  const visibleActions = actions.filter(
    (t) => !t.projectIds?.length || t.projectIds.includes(project.id)
  );
  const commandActions = visibleActions.filter((t) => t.type === 'command');
  const promptActions = visibleActions.filter((t) => t.type !== 'command');

  const createWorkspaceWithCommand = async (
    action: Action,
    branchSpec: BranchSpec
  ): Promise<boolean> => {
    const branch = branchSpec;
    let workspace;
    let name: string;
    if (isDirectoryProject) {
      workspace = await createWorkspace({
        mode: 'directory',
        projectId: project.id,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
      name = workspace.name;
    } else if (branch) {
      name = `${project.name} (${branch.name})`;
      workspace = await createWorkspace({
        name,
        mode: 'worktree',
        branchName: branch.name,
        projectId: project.id,
        useExactBranchName: true,
        fetchRemote: branch.isRemoteOnly || undefined,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
    } else {
      const suffix = generateBranchSuffix();
      name = branchSuffixToName(suffix);
      workspace = await createWorkspace({
        name,
        mode: 'worktree',
        branchName: suffix,
        projectId: project.id,
        autoResolveBranchConflicts: true,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
    }
    if (workspace && !(await startCommandInCreatedWorkspace(workspace, action))) return false;
    useToastStore
      .getState()
      .addToast(`Created workspace "${name}" with "${action.title}"`, 'success');
    return true;
  };

  const handleCommandClick = async (action: Action, branch: BranchSpec) => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const launched = await createWorkspaceWithCommand(action, branch);
      if (!launched) return;
      try {
        await recordActionUsage(action.id);
      } catch {
        /* ignore */
      }
    } catch (err) {
      handleCreateError(err, () => void handleCommandClick(action, branch));
    } finally {
      setIsCreating(false);
    }
  };

  const createWorkspaceWithAction = async (
    action: Action,
    branchSpec: BranchSpec,
    input?: string
  ) => {
    const branch = branchSpec;

    const resolveTargetBranch = async (): Promise<string | undefined> => {
      if (isDirectoryProject) return undefined;
      if (branch) return branch.name;
      return project.baseBranch || (await window.api.getMainBranch(getRepoPath()));
    };

    const targetBranch = action.content.includes(ACTION_TARGET_BRANCH_TOKEN)
      ? await resolveTargetBranch()
      : undefined;

    const initialPrompt = injectActionContext(action.content, {
      userInput: input,
      targetBranch,
    });

    if (isDirectoryProject) {
      const workspace = await createWorkspace({
        mode: 'directory',
        projectId: project.id,
        initialPrompt,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
      useToastStore
        .getState()
        .addToast(`Created workspace "${workspace.name}" with "${action.title}"`, 'success');
    } else if (branch) {
      const name = `${project.name} (${branch.name})`;
      await createWorkspace({
        name,
        mode: 'worktree',
        branchName: branch.name,
        projectId: project.id,
        useExactBranchName: true,
        fetchRemote: branch.isRemoteOnly || undefined,
        initialPrompt,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
      useToastStore
        .getState()
        .addToast(`Created workspace "${name}" with "${action.title}"`, 'success');
    } else {
      const suffix = generateBranchSuffix();
      const name = branchSuffixToName(suffix);
      await createWorkspace({
        name,
        mode: 'worktree',
        branchName: suffix,
        projectId: project.id,
        autoResolveBranchConflicts: true,
        initialPrompt,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
      useToastStore
        .getState()
        .addToast(`Created workspace "${name}" with "${action.title}"`, 'success');
    }
  };

  const handleActionClick = async (action: Action, branch: BranchSpec) => {
    if (isCreating) return;
    if (actionNeedsInjection(action.content)) {
      setPendingActionLaunch({ action, branch });
      return;
    }
    setIsCreating(true);
    try {
      await createWorkspaceWithAction(action, branch);
      try {
        await recordActionUsage(action.id);
      } catch {
        /* ignore */
      }
    } catch (err) {
      handleCreateError(err, () => void handleActionClick(action, branch));
    } finally {
      setIsCreating(false);
    }
  };

  useEffect(() => {
    if (pendingActionLaunch && !actionInputDialogOpen) {
      const timer = setTimeout(() => setActionInputDialogOpen(true), 150);
      return () => clearTimeout(timer);
    }
  }, [pendingActionLaunch, actionInputDialogOpen]);

  const handleActionInputConfirm = async (input: string) => {
    if (!pendingActionLaunch || isCreating) return;
    setActionInputDialogOpen(false);
    setIsCreating(true);
    try {
      await createWorkspaceWithAction(
        pendingActionLaunch.action,
        pendingActionLaunch.branch,
        input
      );
      try {
        await recordActionUsage(pendingActionLaunch.action.id, input);
      } catch {
        /* ignore */
      }
    } catch (err) {
      handleCreateError(
        err,
        () => void handleActionClick(pendingActionLaunch.action, pendingActionLaunch.branch)
      );
    } finally {
      setPendingActionLaunch(null);
      setIsCreating(false);
    }
  };

  const renderActionArrow = (
    branch: BranchSpec,
    label: string,
    options?: { showNewFrom?: boolean }
  ) => {
    const hasCommands = commandActions.length > 0;
    const hasPrompts = promptActions.length > 0;
    const hasAny = hasCommands || hasPrompts;
    const showNewFrom = options?.showNewFrom ? branch : null;
    return (
      <ContextMenuSub>
        <ContextMenuSubTrigger
          disabled={isCreating || (!hasAny && !showNewFrom)}
          className="size-8 justify-center px-0 [&>svg]:ml-0"
        >
          <span className="sr-only">{label}</span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {showNewFrom && (
            <>
              <ContextMenuItem
                onClick={() => void handleNewFromBranch(showNewFrom.name, showNewFrom.isRemoteOnly)}
                disabled={isCreating}
              >
                <Plus />
                New Branch
              </ContextMenuItem>
              {hasAny && <ContextMenuSeparator />}
            </>
          )}
          {!hasAny && !showNewFrom && (
            <ContextMenuItem disabled>No quick commands configured</ContextMenuItem>
          )}
          {hasCommands && (
            <>
              <ContextMenuLabel className="flex items-center gap-1.5">
                <Terminal className="size-3" />
                Terminal Commands
              </ContextMenuLabel>
              {commandActions.map((action) => (
                <ContextMenuItem
                  key={action.id}
                  onClick={() => void handleCommandClick(action, branch)}
                  disabled={isCreating}
                >
                  <Terminal />
                  {action.title}
                </ContextMenuItem>
              ))}
              {hasPrompts && <ContextMenuSeparator />}
            </>
          )}
          {hasPrompts && (
            <>
              <ContextMenuLabel className="flex items-center gap-1.5">
                <Sparkle className="size-3" />
                Saved Prompts
              </ContextMenuLabel>
              {promptActions.map((action) => (
                <ContextMenuItem
                  key={action.id}
                  onClick={() => void handleActionClick(action, branch)}
                  disabled={isCreating}
                >
                  <Sparkle />
                  {action.title}
                </ContextMenuItem>
              ))}
            </>
          )}
          {hasAny && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }))
                }
                className="text-muted-foreground"
              >
                Manage Quick Commands...
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  };

  // Branch picker filtering
  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(branchFilter.toLowerCase())
  );
  const localBranches = filteredBranches.filter((b) => !b.isRemoteOnly);
  const remoteBranches = filteredBranches.filter((b) => b.isRemoteOnly);

  const renderBranchPickerBody = () => {
    if (branchesLoading) {
      return (
        <ContextMenuItem disabled>
          <Spinner size="md" />
          Loading...
        </ContextMenuItem>
      );
    }
    if (filteredBranches.length === 0) {
      return (
        <ContextMenuItem disabled>
          <span className="text-muted-foreground">
            {branchFilter ? 'No matching branches' : 'No branches found'}
          </span>
        </ContextMenuItem>
      );
    }
    const showListSeparator =
      localBranches.length > 0 && remoteBranches.length > 0 && remoteExpanded;
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
            {remoteExpanded ? <CaretDown className="size-3" /> : <CaretRight className="size-3" />}
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
        {remoteExpanded &&
          remoteBranches.map((branch) => (
            <div key={`remote-${branch.name}`} className="my-0.5 flex items-center gap-1">
              <ContextMenuItem
                onClick={() => void handleBranchClick(branch.name, true)}
                disabled={isCreating}
                className="min-w-0 flex-1 gap-2"
              >
                <Cloud className="text-info" />
                <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
                  {branch.name}
                </span>
              </ContextMenuItem>
              {renderActionArrow(
                { name: branch.name, isRemoteOnly: true },
                `Options for ${branch.name}`,
                { showNewFrom: true }
              )}
            </div>
          ))}
        {showListSeparator && <ContextMenuSeparator />}
        {localBranches.map((branch) => (
          <div key={`local-${branch.name}`} className="my-0.5 flex items-center gap-1">
            <ContextMenuItem
              onClick={() => void handleBranchClick(branch.name)}
              disabled={isCreating}
              className="min-w-0 flex-1 gap-2"
            >
              <GitBranch />
              <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
                {branch.name}
              </span>
            </ContextMenuItem>
            {renderActionArrow(
              { name: branch.name, isRemoteOnly: false },
              `Options for ${branch.name}`,
              { showNewFrom: true }
            )}
          </div>
        ))}
      </>
    );
  };

  return (
    <>
      <ContextMenu onOpenChange={handleOpenChange}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {/* Instant workspace on a random branch (the header "+" opens the dialog) + template arrow */}
          <div className="my-0.5 flex items-center gap-1">
            <ContextMenuItem
              onClick={() => void handleNewWorkspace()}
              disabled={isCreating}
              className="min-w-0 flex-1"
            >
              <Plus />
              Quick New Workspace
            </ContextMenuItem>
            {renderActionArrow(null, 'Quick Commands')}
          </div>

          {/* Open on branch... submenu with branch picker */}
          {!isDirectoryProject && (
            <ContextMenuSub
              onOpenChange={(open) => {
                if (open) {
                  void loadBranches();
                  setTimeout(() => branchFilterRef.current?.focus(), 50);
                } else {
                  setBranchFilter('');
                }
              }}
            >
              <ContextMenuSubTrigger disabled={isCreating}>
                <GitBranch />
                New on Branch...
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-80 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto !pt-0">
                <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
                  <input
                    ref={branchFilterRef}
                    type="text"
                    placeholder="Filter branches..."
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                    className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </div>
                {renderBranchPickerBody()}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}

          <ContextMenuSeparator />
          {isDirectoryProject && (
            <>
              <ContextMenuItem
                onClick={() => {
                  window.api.copyToClipboard(project.repositoryPath);
                  useToastStore.getState().addToast(`Copied ${project.repositoryPath}`, 'success');
                }}
              >
                <Copy />
                Copy Path
              </ContextMenuItem>
              <ContextMenuItem onClick={() => window.api.showItemInFolder(project.repositoryPath)}>
                <MagnifyingGlass />
                {getRevealInFileManagerLabel()}
              </ContextMenuItem>
            </>
          )}
          {!isDirectoryProject && (
            <ContextMenuItem
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('open-workspace-setup', { detail: project.id })
                );
              }}
            >
              <Wrench />
              Workspace Setup
            </ContextMenuItem>
          )}
          {hasActiveWorkspace && (
            <ContextMenuItem onClick={() => setWorkspaceCleanupOpen(true)}>
              <Broom />
              Clean Up Workspaces...
            </ContextMenuItem>
          )}
          {!isDirectoryProject && (
            <ContextMenuItem onClick={() => setBranchCleanupOpen(true)}>
              <Broom />
              Clean Up Branches...
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('open-project-settings', { detail: project.id })
              );
            }}
          >
            <GearSix />
            Project Settings
          </ContextMenuItem>
          {hasActiveWorkspace && (
            <>
              <ContextMenuSeparator />
              <MoveToWindowMenuItems
                otherWindows={availableWindows.filter((w) => w.id !== currentWindowId)}
                onMoveToWindow={(windowId) => void handleMoveProjectToWindow(windowId)}
                onMoveToNewWindow={() => void handleMoveProjectToNewWindow()}
              />
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => hideProjectGroup(project.id)}>
            <EyeSlash />
            Hide Project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!isDirectoryProject && (
        <DeferredDialog open={branchCleanupOpen}>
          <BranchCleanupDialog
            projectId={project.id}
            open={branchCleanupOpen}
            onOpenChange={setBranchCleanupOpen}
          />
        </DeferredDialog>
      )}
      <DeferredDialog open={workspaceCleanupOpen}>
        <WorkspaceCleanupDialog
          projectId={project.id}
          isDirectory={isDirectoryProject}
          open={workspaceCleanupOpen}
          onOpenChange={setWorkspaceCleanupOpen}
        />
      </DeferredDialog>
      <DeferredDialog open={actionInputDialogOpen}>
        <ActionInputDialog
          open={actionInputDialogOpen}
          actionTitle={pendingActionLaunch?.action.title || 'Quick command'}
          actionContent={pendingActionLaunch?.action.content || ''}
          lastInput={pendingActionLaunch?.action.lastUserInput}
          onCancel={() => {
            setActionInputDialogOpen(false);
            setPendingActionLaunch(null);
          }}
          onConfirm={handleActionInputConfirm}
        />
      </DeferredDialog>
    </>
  );
}
