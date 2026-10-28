import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Cloud,
  FolderOpen,
  GitBranch,
  Sparkle,
  Terminal,
} from '@phosphor-icons/react';
import React, { useEffect, useRef, useState } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { ActionInputDialog } from '@/components/workspaces/ActionInputDialog';
import {
  injectActionContext,
  ACTION_TARGET_BRANCH_TOKEN,
  actionNeedsInjection,
} from '@/lib/action-injection';
import { startCommandInCreatedWorkspace } from '@/lib/action-launch';
import { createFolderWorkspace, openFolder } from '@/lib/open-folder';
import { qualifyBaseBranch, refreshIfBaseIsRemoteOnly } from '@/lib/remote-base-branch';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { handleCreateError } from '@/utils/workspace-error';

import { projectRepoPath } from '../../../shared/lib/project-repo-path';
import { generateBranchSuffix, branchSuffixToName } from '../../../shared/lib/random-names';

import type { BranchInfo, Project, Action } from '@/types';

type ActionLaunchMode = 'clean' | 'target' | 'branch' | 'fromBranch';

interface PendingActionLaunch {
  project: Project;
  action: Action;
  mode: ActionLaunchMode;
  specificBranch?: string;
  specificBranchIsRemote?: boolean;
}

/** `className` restyles the caret trigger, e.g. as the end of a split button. */
export function QuickCreateMenu({ className }: { className?: string }) {
  const { projects } = useProjectsStore();
  const { actions, loadActions, recordActionUsage } = useActionsStore();
  const { createWorkspace } = useWorkspacesStore();
  const [isCreating, setIsCreating] = useState(false);
  const [actionInputDialogOpen, setActionInputDialogOpen] = useState(false);
  const [pendingActionLaunch, setPendingActionLaunch] = useState<PendingActionLaunch | null>(null);

  // Branch picker state
  const { config, updateConfig } = useConfigStore();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchFilter, setBranchFilter] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const branchFilterRef = useRef<HTMLInputElement>(null);
  const remoteExpanded = config?.remoteBranchesExpanded ?? false;
  const gitProjects = projects.filter((project) => project.kind !== 'directory');

  const handleOpenChange = (open: boolean) => {
    if (open) {
      void loadActions();
    } else {
      setBranches([]);
      setBranchFilter('');
    }
  };

  // Get actions visible for a given project: global + scoped to that project
  const getActionsForProject = (projectId: string) =>
    actions.filter((t) => !t.projectIds?.length || t.projectIds.includes(projectId));

  const getCommandsForProject = (projectId: string) =>
    getActionsForProject(projectId).filter((t) => t.type === 'command');

  const getPromptsForProject = (projectId: string) =>
    getActionsForProject(projectId).filter((t) => t.type !== 'command');

  const handleProjectClick = async (project: Project) => {
    if (isCreating) return;

    setIsCreating(true);
    try {
      if (project.kind === 'directory') {
        await createFolderWorkspace({ projectId: project.id });
      } else {
        const suffix = generateBranchSuffix();
        const name = branchSuffixToName(suffix);
        await createWorkspace({
          name,
          mode: 'worktree',
          branchName: suffix,
          projectId: project.id,
          autoResolveBranchConflicts: true,
        });
      }
    } catch (err) {
      handleCreateError(err, () => void handleProjectClick(project));
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenFolder = async () => {
    if (isCreating) return;

    setIsCreating(true);
    try {
      await openFolder();
    } finally {
      setIsCreating(false);
    }
  };

  const getRepoPath = (project: Project): string => projectRepoPath(project);

  const resolveTargetBranchForAction = async (
    project: Project,
    mode: ActionLaunchMode,
    specificBranch?: string
  ): Promise<string | undefined> => {
    if (project.kind === 'directory') return undefined;
    if ((mode === 'branch' || mode === 'fromBranch') && specificBranch) return specificBranch;

    return project.baseBranch || (await window.api.getMainBranch(getRepoPath(project)));
  };

  const resolveBranchForMode = async (
    project: Project,
    mode: Exclude<ActionLaunchMode, 'clean' | 'fromBranch'>,
    specificBranch?: string
  ): Promise<string> => {
    if (mode === 'branch' && specificBranch) return specificBranch;

    if (mode === 'target') {
      return project.baseBranch || (await window.api.getMainBranch(getRepoPath(project)));
    }

    return await window.api.getMainBranch(getRepoPath(project));
  };

  const openOnBranch = async (project: Project, branchName: string, fetchRemote?: boolean) => {
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

  const handleBranchClick = async (project: Project, branchName: string, fetchRemote?: boolean) => {
    if (isCreating) return;

    setIsCreating(true);
    try {
      await openOnBranch(project, branchName, fetchRemote);
    } catch (err) {
      handleCreateError(err, () => void handleBranchClick(project, branchName, fetchRemote));
    } finally {
      setIsCreating(false);
    }
  };

  const handleNewFromBranch = async (
    project: Project,
    baseBranchName: string,
    baseIsRemoteOnly: boolean
  ) => {
    if (isCreating) return;

    setIsCreating(true);
    try {
      await refreshIfBaseIsRemoteOnly(getRepoPath(project), baseIsRemoteOnly);
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
      handleCreateError(
        err,
        () => void handleNewFromBranch(project, baseBranchName, baseIsRemoteOnly)
      );
    } finally {
      setIsCreating(false);
    }
  };

  const loadBranchesForProject = async (proj: Project) => {
    setBranchesLoading(true);
    setBranchFilter('');
    try {
      const branchList = await window.api.listBranches(getRepoPath(proj), true);
      setBranches(branchList);
    } catch {
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  };

  const handleFetchBranches = async (proj: Project, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isFetching) return;
    setIsFetching(true);
    try {
      await window.api.fetchFromRemote(getRepoPath(proj));
      const branchList = await window.api.listBranches(getRepoPath(proj), true);
      setBranches(branchList);
    } catch {
      /* ignore */
    } finally {
      setIsFetching(false);
    }
  };

  // Branch picker filtering
  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(branchFilter.toLowerCase())
  );
  const localBranches = filteredBranches.filter((b) => !b.isRemoteOnly);
  const remoteBranches = filteredBranches.filter((b) => b.isRemoteOnly);

  const createWorkspaceWithCommand = async (
    project: Project,
    action: Action,
    branchSpec?: { branch: string; exact: boolean; fetchRemote?: boolean },
    baseBranchForNew?: string,
    baseBranchForNewIsRemote?: boolean
  ): Promise<boolean> => {
    let workspace;
    let name: string;
    if (project.kind === 'directory') {
      workspace = await createWorkspace({
        mode: 'directory',
        projectId: project.id,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
      name = workspace.name;
    } else if (branchSpec) {
      name = `${project.name} (${branchSpec.branch})`;
      workspace = await createWorkspace({
        name,
        mode: 'worktree',
        branchName: branchSpec.branch,
        projectId: project.id,
        useExactBranchName: branchSpec.exact,
        fetchRemote: branchSpec.fetchRemote,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
    } else {
      await refreshIfBaseIsRemoteOnly(getRepoPath(project), baseBranchForNewIsRemote ?? false);
      const suffix = generateBranchSuffix();
      name = branchSuffixToName(suffix);
      workspace = await createWorkspace({
        name,
        mode: 'worktree',
        branchName: suffix,
        projectId: project.id,
        baseBranch: baseBranchForNew
          ? qualifyBaseBranch(baseBranchForNew, baseBranchForNewIsRemote ?? false)
          : undefined,
        autoResolveBranchConflicts: true,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
    }
    if (workspace && !(await startCommandInCreatedWorkspace(workspace, action))) return false;
    const baseSuffix = !branchSpec && baseBranchForNew ? ` from ${baseBranchForNew}` : '';
    useToastStore
      .getState()
      .addToast(`Created workspace "${name}"${baseSuffix} with "${action.title}"`, 'success');
    return true;
  };

  const createWorkspaceWithAction = async (
    project: Project,
    action: Action,
    mode: ActionLaunchMode,
    input?: string,
    specificBranch?: string,
    specificBranchIsRemote?: boolean
  ) => {
    if (project.kind === 'directory') {
      const initialPrompt = injectActionContext(action.content, {
        userInput: input,
        targetBranch: undefined,
      });
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
      return;
    }

    const targetBranch = action.content.includes(ACTION_TARGET_BRANCH_TOKEN)
      ? await resolveTargetBranchForAction(project, mode, specificBranch)
      : undefined;

    const initialPrompt = injectActionContext(action.content, {
      userInput: input,
      targetBranch,
    });

    if (mode === 'clean' || mode === 'fromBranch') {
      if (mode === 'fromBranch') {
        await refreshIfBaseIsRemoteOnly(getRepoPath(project), specificBranchIsRemote ?? false);
      }
      const suffix = generateBranchSuffix();
      const name = branchSuffixToName(suffix);
      const baseBranch =
        mode === 'fromBranch' && specificBranch
          ? qualifyBaseBranch(specificBranch, specificBranchIsRemote ?? false)
          : undefined;
      await createWorkspace({
        name,
        mode: 'worktree',
        branchName: suffix,
        projectId: project.id,
        baseBranch,
        autoResolveBranchConflicts: true,
        initialPrompt,
        presetId: action.presetId,
        launchModeId: action.launchModeId,
        defaultActionId: action.id,
      });
      const baseSuffix = mode === 'fromBranch' && specificBranch ? ` from ${specificBranch}` : '';
      useToastStore
        .getState()
        .addToast(`Created workspace "${name}"${baseSuffix} with "${action.title}"`, 'success');
      return;
    }

    const branch = await resolveBranchForMode(project, mode, specificBranch);
    const name = `${project.name} (${branch})`;
    await createWorkspace({
      name,
      mode: 'worktree',
      branchName: branch,
      projectId: project.id,
      useExactBranchName: true,
      fetchRemote: specificBranchIsRemote || undefined,
      initialPrompt,
      presetId: action.presetId,
      launchModeId: action.launchModeId,
      defaultActionId: action.id,
    });
    useToastStore
      .getState()
      .addToast(`Created workspace "${name}" with "${action.title}"`, 'success');
  };

  const handleCommandClick = async (
    project: Project,
    action: Action,
    branchSpec?: { branch: string; exact: boolean; fetchRemote?: boolean },
    baseBranchForNew?: string,
    baseBranchForNewIsRemote?: boolean
  ) => {
    if (isCreating) return;

    setIsCreating(true);
    try {
      const launched = await createWorkspaceWithCommand(
        project,
        action,
        branchSpec,
        baseBranchForNew,
        baseBranchForNewIsRemote
      );
      if (!launched) return;
      try {
        await recordActionUsage(action.id);
      } catch (error) {
        console.error('Failed to record action usage:', error);
      }
    } catch (err) {
      handleCreateError(
        err,
        () =>
          void handleCommandClick(
            project,
            action,
            branchSpec,
            baseBranchForNew,
            baseBranchForNewIsRemote
          )
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handlePromptActionClick = async (
    project: Project,
    promptAction: Action,
    mode: ActionLaunchMode = 'clean',
    specificBranch?: string,
    specificBranchIsRemote?: boolean
  ) => {
    if (isCreating) return;

    if (actionNeedsInjection(promptAction.content)) {
      setPendingActionLaunch({
        project,
        action: promptAction,
        mode,
        specificBranch,
        specificBranchIsRemote,
      });
      return;
    }

    setIsCreating(true);
    try {
      await createWorkspaceWithAction(
        project,
        promptAction,
        mode,
        undefined,
        specificBranch,
        specificBranchIsRemote
      );
      try {
        await recordActionUsage(promptAction.id);
      } catch (error) {
        console.error('Failed to record action usage:', error);
      }
    } catch (err) {
      handleCreateError(
        err,
        () =>
          void handlePromptActionClick(
            project,
            promptAction,
            mode,
            specificBranch,
            specificBranchIsRemote
          )
      );
    } finally {
      setIsCreating(false);
    }
  };

  const renderActionSubContent = (
    project: Project,
    commands: Action[],
    prompts: Action[],
    mode: ActionLaunchMode,
    branchForCommand?: { branch: string; exact: boolean; fetchRemote?: boolean },
    baseBranchForNew?: string,
    baseBranchForNewIsRemote?: boolean
  ) => {
    const hasCommands = commands.length > 0;
    const hasPrompts = prompts.length > 0;
    const hasAny = hasCommands || hasPrompts;
    const specificBranchForPrompt = baseBranchForNew ?? branchForCommand?.branch;
    const specificBranchIsRemote = baseBranchForNewIsRemote ?? branchForCommand?.fetchRemote;
    return (
      <>
        {!hasAny && <DropdownMenuItem disabled>No quick commands configured</DropdownMenuItem>}
        {hasCommands && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Terminal className="size-3" />
              Terminal Commands
            </DropdownMenuLabel>
            {commands.map((cmd) => (
              <DropdownMenuItem
                key={cmd.id}
                onClick={() =>
                  handleCommandClick(
                    project,
                    cmd,
                    branchForCommand,
                    baseBranchForNew,
                    baseBranchForNewIsRemote
                  )
                }
                disabled={isCreating}
              >
                <Terminal />
                {cmd.title}
              </DropdownMenuItem>
            ))}
            {hasPrompts && <DropdownMenuSeparator />}
          </>
        )}
        {hasPrompts && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Sparkle className="size-3" />
              Saved Prompts
            </DropdownMenuLabel>
            {prompts.map((prompt) => (
              <DropdownMenuItem
                key={prompt.id}
                onClick={() =>
                  handlePromptActionClick(
                    project,
                    prompt,
                    mode,
                    specificBranchForPrompt,
                    specificBranchIsRemote
                  )
                }
                disabled={isCreating}
              >
                <Sparkle />
                {prompt.title}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }))
          }
          className="text-muted-foreground"
        >
          Manage Quick Commands…
        </DropdownMenuItem>
      </>
    );
  };

  const handleActionInputCancel = () => {
    setActionInputDialogOpen(false);
    setPendingActionLaunch(null);
  };

  const handleBranchSubMenuOpenChange = (project: Project) => (open: boolean) => {
    if (open) {
      void loadBranchesForProject(project);
      setTimeout(() => branchFilterRef.current?.focus(), 50);
    } else {
      setBranchFilter('');
    }
  };

  const renderBranchProjectPicker = (label: string, mode: 'open' | 'newFrom') => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isCreating}>
        <GitBranch />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {gitProjects.map((project) => (
          <DropdownMenuSub key={project.id} onOpenChange={handleBranchSubMenuOpenChange(project)}>
            <DropdownMenuSubTrigger disabled={isCreating}>
              <ProjectMark
                project={{ color: project.color, icon: project.icon }}
                dotClassName="size-2.5"
              />
              <span className="truncate font-mono text-ui">{project.name}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto !pt-0">
              <div className="sticky top-0 z-10 -mx-1 mb-1 border-b border-foreground/10 bg-inherit p-1">
                <input
                  ref={branchFilterRef}
                  type="text"
                  placeholder="Filter branches…"
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
              {renderBranchPickerBody(project, mode)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );

  const renderBranchPickerBody = (project: Project, mode: 'open' | 'newFrom') => {
    if (branchesLoading) {
      return (
        <DropdownMenuItem disabled>
          <Spinner size="md" />
          Loading…
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
    const showSeparator = localBranches.length > 0 && remoteBranches.length > 0 && remoteExpanded;
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
              if (!isFetching) void handleFetchBranches(project, e);
            }}
            title={isFetching ? 'Fetching…' : 'Fetch from remote'}
          >
            <ArrowsClockwise className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            {isFetching ? 'Fetching' : 'Fetch'}
          </div>
        </div>
        {remoteExpanded &&
          remoteBranches.map((branch) => renderBranchRow(project, branch, true, mode))}
        {showSeparator && <DropdownMenuSeparator />}
        {localBranches.map((branch) => renderBranchRow(project, branch, false, mode))}
      </>
    );
  };

  const renderBranchRow = (
    project: Project,
    branch: BranchInfo,
    isRemoteOnly: boolean,
    mode: 'open' | 'newFrom'
  ) => {
    const keyPrefix = isRemoteOnly ? 'remote' : 'local';
    const Icon = isRemoteOnly ? Cloud : GitBranch;
    const iconClass = isRemoteOnly ? 'size-4 shrink-0 text-info' : 'size-4 shrink-0';

    const branchSpec = isRemoteOnly
      ? { branch: branch.name, exact: true, fetchRemote: true }
      : { branch: branch.name, exact: true };

    const handleClick =
      mode === 'open'
        ? () => void handleBranchClick(project, branch.name, isRemoteOnly || undefined)
        : () => void handleNewFromBranch(project, branch.name, isRemoteOnly);

    return (
      <div key={`${keyPrefix}-${branch.name}`} className="my-0.5 flex items-center gap-1">
        <DropdownMenuItem onClick={handleClick} disabled={isCreating} className="min-w-0 flex-1">
          <Icon className={iconClass} />
          <span className="min-w-0 flex-1 font-mono text-ui leading-4 break-all whitespace-normal">
            {branch.name}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={isCreating}
            className="size-8 justify-center px-0 [&>svg]:ml-0"
          >
            <span className="sr-only">Options for {branch.name}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {renderActionSubContent(
              project,
              getCommandsForProject(project.id),
              getPromptsForProject(project.id),
              mode === 'open' ? 'branch' : 'fromBranch',
              mode === 'open' ? branchSpec : undefined,
              mode === 'newFrom' ? branch.name : undefined,
              mode === 'newFrom' ? isRemoteOnly : undefined
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </div>
    );
  };

  // Delay opening the injection dialog so the dropdown's close animation finishes
  // and doesn't steal focus from the dialog's textarea
  useEffect(() => {
    if (pendingActionLaunch && !actionInputDialogOpen) {
      const timer = setTimeout(() => setActionInputDialogOpen(true), 150);
      return () => clearTimeout(timer);
    }
  }, [pendingActionLaunch, actionInputDialogOpen]);

  const handleActionInputConfirm = async (input: string) => {
    if (!pendingActionLaunch || isCreating) return;

    // Capture and clear pendingActionLaunch before closing dialog to prevent
    // the useEffect from re-opening it (it watches both states)
    const launch = pendingActionLaunch;
    setPendingActionLaunch(null);
    setActionInputDialogOpen(false);
    setIsCreating(true);
    try {
      await createWorkspaceWithAction(
        launch.project,
        launch.action,
        launch.mode,
        input,
        launch.specificBranch,
        launch.specificBranchIsRemote
      );
      try {
        await recordActionUsage(launch.action.id, input);
      } catch (error) {
        console.error('Failed to record action usage:', error);
      }
    } catch (err) {
      handleCreateError(
        err,
        () =>
          void handlePromptActionClick(
            launch.project,
            launch.action,
            launch.mode,
            launch.specificBranch,
            launch.specificBranchIsRemote
          )
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <IconButton label="Quick create" size="md" className={className} disabled={isCreating}>
            <CaretDown className="size-4" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end">
          <DropdownMenuLabel>Quick Create</DropdownMenuLabel>
          {projects.length === 0 ? (
            <DropdownMenuItem disabled>No projects configured</DropdownMenuItem>
          ) : (
            projects.map((project) => {
              const cmds = getCommandsForProject(project.id);
              const prms = getPromptsForProject(project.id);
              return (
                <div key={project.id} className="my-0.5 flex items-center gap-1">
                  <DropdownMenuItem
                    onClick={() => handleProjectClick(project)}
                    disabled={isCreating}
                    className="min-w-0 flex-1"
                  >
                    <ProjectMark
                      project={{ color: project.color, icon: project.icon }}
                      dotClassName="size-2.5"
                    />
                    <span className="truncate font-mono text-ui">{project.name}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      disabled={isCreating || (cmds.length === 0 && prms.length === 0)}
                      className="size-8 justify-center px-0 [&>svg]:ml-0"
                      aria-label={`Quick commands for ${project.name}`}
                    >
                      <span className="sr-only">Quick commands</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {renderActionSubContent(project, cmds, prms, 'clean')}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </div>
              );
            })
          )}
          {gitProjects.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {renderBranchProjectPicker('New from Branch…', 'newFrom')}
              {renderBranchProjectPicker('New on Branch…', 'open')}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void handleOpenFolder()} disabled={isCreating}>
            <FolderOpen />
            Open Folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ActionInputDialog
        open={actionInputDialogOpen}
        actionTitle={pendingActionLaunch?.action.title || 'Quick command'}
        actionContent={pendingActionLaunch?.action.content || ''}
        lastInput={pendingActionLaunch?.action.lastUserInput}
        onCancel={handleActionInputCancel}
        onConfirm={handleActionInputConfirm}
      />
    </>
  );
}
