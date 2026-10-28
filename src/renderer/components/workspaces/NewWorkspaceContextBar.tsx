import {
  CaretDown,
  Check,
  Cloud,
  Desktop,
  Folder,
  FolderOpen,
  GitBranch,
  MagnifyingGlass,
  Plus,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import React, { useEffect, useId, useRef, useState } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import {
  type NewWorkspaceMenu,
  useProjectSearchShortcutLabel,
  useProjectShortcutLabel,
} from '@/lib/agent-dialog-shortcuts';
import { focusPromptOnMenuClose } from '@/lib/dialog-menus';
import { stopWheelPropagation } from '@/lib/dialog-scroll-lock';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import { resolveBranchPrefix } from '../../../shared/lib/project-git-defaults';

import { WorkspaceBranchPicker, type BranchPickerMeta } from './WorkspaceBranchPicker';

import type { WorkspaceEnvironmentTarget } from '@/lib/agent-launch';
import type { DesiredWorkspaceEnvironment, Project, SshHost } from '@/types';

type EnvironmentValue = 'local' | `ssh:${string}`;

const SEGMENT_CLASS =
  'inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-ui text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus:outline-hidden focus-visible:ring-1 focus-visible:ring-ring';

function Separator() {
  return (
    <span aria-hidden className="text-muted-foreground/40 select-none">
      /
    </span>
  );
}

// Closing a menu returns focus to the prompt; without an agent there is no
// prompt, so to the branch name or the project.
function refocusComposer(
  event: Event,
  refs: {
    promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
    branchInputRef: React.RefObject<HTMLInputElement | null>;
    projectTriggerRef: React.RefObject<HTMLButtonElement | null>;
  }
) {
  focusPromptOnMenuClose(
    event,
    refs.promptTextareaRef.current ?? refs.branchInputRef.current ?? refs.projectTriggerRef.current
  );
}

function SegmentCaret() {
  return <CaretDown className="size-2.5 shrink-0 opacity-50" />;
}

/** Check mark for the selected project, then its Go to workspace 1–9 shortcut. */
function ProjectRowEnd({ index, isSelected }: { index: number; isSelected: boolean }) {
  const shortcut = useProjectShortcutLabel(index);
  return (
    <span className="ml-3 flex shrink-0 items-center gap-1.5">
      {isSelected && <Check className="size-4 shrink-0" />}
      {shortcut && <span className="text-2xs text-muted-foreground/70">{shortcut}</span>}
    </span>
  );
}

interface ProjectSearchProps {
  projects: Project[];
  projectId: string;
  onSelect: (id: string) => void;
}

/**
 * Type-to-filter project list. Arrow keys move the selection and Enter picks
 * it; shortcut numbers keep the dropdown's order while filtering.
 */
function ProjectSearch({ projects, projectId, onSelect }: ProjectSearchProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      projects.findIndex((project) => project.id === projectId),
      0
    )
  );
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const lowerQuery = query.trim().toLowerCase();
  const matches = projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => project.name.toLowerCase().includes(lowerQuery));
  const activeMatch = matches[activeIndex];
  const optionId = (id: string) => `${listId}-${id}`;

  // Keep the selection in view, starting with the current project on open.
  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, query]);

  const moveSelection = (offset: number) => {
    setActiveIndex(Math.min(Math.max(activeIndex + offset, 0), matches.length - 1));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an input method's text must not pick a project.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length > 0) moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeMatch) onSelect(activeMatch.project.id);
    }
  };

  return (
    <>
      <div className="border-b border-foreground/10 p-1">
        <input
          type="text"
          role="combobox"
          aria-label="Search projects"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeMatch ? optionId(activeMatch.project.id) : undefined}
          placeholder="Search projects…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent px-2 py-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground"
        />
      </div>
      {matches.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">No matching projects</p>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Projects"
        className="max-h-64 overflow-y-auto p-1 empty:hidden"
      >
        {matches.map(({ project, index }, matchIndex) => (
          <div
            key={project.id}
            id={optionId(project.id)}
            role="option"
            aria-selected={matchIndex === activeIndex}
            // Pointer moves only: rows scrolling under a resting pointer by
            // keyboard also fire mouseenter, which would steal the selection.
            onPointerMove={() => setActiveIndex(matchIndex)}
            // Keep focus in the search field, which owns keyboard selection.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(project.id)}
            className={cn(
              'flex cursor-default items-center justify-between rounded-md px-2 py-1 text-[13px] leading-[18px]',
              matchIndex === activeIndex && 'bg-foreground/8'
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ProjectMark project={project} />
              <span className="truncate font-mono text-ui">{project.name}</span>
            </span>
            <ProjectRowEnd index={index} isSelected={project.id === projectId} />
          </div>
        ))}
      </div>
    </>
  );
}

export interface EnvironmentSegmentProps {
  launchTarget: WorkspaceEnvironmentTarget;
  onEnvironmentChange: (environment: DesiredWorkspaceEnvironment) => void;
  sshHosts: SshHost[];
  selectedSshHost: SshHost | undefined;
  /** Opens the add-host dialog, offered while no other environment is configured */
  onSetUpSshHost: () => void;
  onCloseAutoFocus: (event: Event) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface EnvironmentDescription {
  value: EnvironmentValue;
  label: string;
  Icon: typeof Desktop;
  toneClass?: string;
}

function describeEnvironment({
  launchTarget,
  selectedSshHost,
}: Pick<EnvironmentSegmentProps, 'launchTarget' | 'selectedSshHost'>): EnvironmentDescription {
  if (launchTarget === 'ssh') {
    return {
      value: `ssh:${selectedSshHost?.id ?? ''}`,
      label: selectedSshHost?.name ?? 'SSH',
      Icon: Cloud,
      toneClass: 'text-cyan-700 dark:text-cyan-400',
    };
  }
  return { value: 'local', label: 'Local', Icon: Desktop };
}

function EnvironmentSegment(props: EnvironmentSegmentProps) {
  const { onEnvironmentChange, sshHosts, onSetUpSshHost, onCloseAutoFocus, open, onOpenChange } =
    props;
  const { value, label, Icon, toneClass } = describeEnvironment(props);
  const selectLocal = () => onEnvironmentChange({ kind: 'local' });
  const selectSsh = (hostId: string) => onEnvironmentChange({ kind: 'ssh', hostId });
  // With a single alternative to Local, clicking switches directly.
  const onlyEnvironment =
    sshHosts.length === 1
      ? { select: () => selectSsh(sshHosts[0].id), name: sshHosts[0].name ?? 'SSH' }
      : null;
  const toggleOnlyEnvironment = () => {
    if (value === 'local') onlyEnvironment?.select();
    else selectLocal();
  };
  const switchTarget = value === 'local' ? onlyEnvironment?.name : 'Local';
  const trigger = (
    <button
      type="button"
      className={cn(SEGMENT_CLASS, toneClass)}
      title={onlyEnvironment ? `Switch to ${switchTarget}` : 'Choose where the agent runs'}
      onClick={onlyEnvironment ? toggleOnlyEnvironment : undefined}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {!onlyEnvironment && <SegmentCaret />}
    </button>
  );

  if (onlyEnvironment) return trigger;

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuLabel>This machine</DropdownMenuLabel>
        <DropdownMenuItem onSelect={selectLocal}>
          <Desktop />
          <span className="min-w-0 truncate">Local</span>
          {value === 'local' && <Check className="ml-auto" />}
        </DropdownMenuItem>
        {sshHosts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Remote hosts</DropdownMenuLabel>
            {sshHosts.map((host) => (
              <DropdownMenuItem key={host.id} onSelect={() => selectSsh(host.id)}>
                <Cloud />
                <span className="min-w-0 truncate">{host.name}</span>
                {value === `ssh:${host.id}` && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {sshHosts.length === 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSetUpSshHost} className="text-muted-foreground">
              <Cloud className="mr-1 size-3.5 shrink-0" />
              <span className="min-w-0 truncate">Connect a machine over SSH…</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface BranchNameFieldProps {
  branchName: string;
  setBranchName: (v: string) => void;
  setIsBranchNameAutoGenerated: (v: boolean) => void;
  useAiBranchName: boolean;
  setUseAiBranchName: (v: boolean) => void;
  toggleAiBranchName: (v: boolean) => void;
  showAiToggle: boolean;
  hasPrompt: boolean;
  branchInputRef: React.RefObject<HTMLInputElement | null>;
  defaultBranchPrefix: string;
}

function BranchNameField({
  branchName,
  setBranchName,
  setIsBranchNameAutoGenerated,
  useAiBranchName,
  setUseAiBranchName,
  toggleAiBranchName,
  showAiToggle,
  hasPrompt,
  branchInputRef,
  defaultBranchPrefix,
}: BranchNameFieldProps) {
  const aiLabel = useAiBranchName ? 'Use random branch name' : 'Generate branch name with AI';
  const placeholder = `${defaultBranchPrefix}swift-fox`;
  // Size the field to its text so the segments before it are not squeezed.
  const inputWidth = `calc(${(branchName || placeholder).length + 1}ch + 0.5rem)`;
  return (
    <span className="flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
      <span aria-hidden className="shrink-0">
        →
      </span>
      {useAiBranchName && hasPrompt ? (
        <button
          type="button"
          title="Type a branch name for this workspace"
          onClick={() => {
            setUseAiBranchName(false);
            // Select the suffix so typing replaces it
            setTimeout(() => {
              branchInputRef.current?.focus();
              branchInputRef.current?.setSelectionRange(
                defaultBranchPrefix.length,
                branchName.length
              );
            }, 0);
          }}
          className="truncate rounded px-1 text-muted-foreground/70 italic hover:text-muted-foreground"
        >
          AI generated
        </button>
      ) : (
        <input
          ref={branchInputRef}
          aria-label="Branch name"
          value={branchName}
          onChange={(e) => {
            setBranchName(e.target.value);
            setIsBranchNameAutoGenerated(false);
            setUseAiBranchName(false);
          }}
          placeholder={placeholder}
          style={{ width: inputWidth }}
          className="max-w-[16rem] min-w-0 rounded bg-transparent px-1 py-0.5 font-mono text-ui text-foreground outline-hidden placeholder:text-muted-foreground/60 focus:bg-muted/40"
        />
      )}
      {showAiToggle && (
        <IconButton
          label={aiLabel}
          tooltipSide="top"
          className={cn(
            'size-4 hover:bg-transparent',
            useAiBranchName
              ? 'text-foreground hover:text-foreground'
              : 'text-muted-foreground/70 hover:text-muted-foreground'
          )}
          onClick={() => toggleAiBranchName(!useAiBranchName)}
        >
          <Sparkle className="size-3" />
        </IconButton>
      )}
    </span>
  );
}

export interface NewWorkspaceProjectPickerProps {
  /** In the order the 1–9 project shortcuts count */
  projects: Project[];
  projectId: string;
  setProjectId: (id: string) => void;
  selectedProject: Project | undefined;
  /** The project search, opened by pressing the New workspace shortcut again */
  projectPickerOpen: boolean;
  onProjectPickerOpenChange: (open: boolean) => void;
  onAddProject: () => void;
  onOpenFolderWorkspace: () => void;
  /** Draws the eye to a project other than the selected workspace's */
  flash: boolean;
  projectTriggerRef: React.RefObject<HTMLButtonElement | null>;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  branchInputRef: React.RefObject<HTMLInputElement | null>;
}

/** The composer's heading: the project the workspace starts in, and the menu to change it. */
export function NewWorkspaceProjectPicker({
  projects,
  projectId,
  setProjectId,
  selectedProject,
  projectPickerOpen,
  onProjectPickerOpenChange,
  onAddProject,
  onOpenFolderWorkspace,
  flash,
  projectTriggerRef,
  promptTextareaRef,
  branchInputRef,
}: NewWorkspaceProjectPickerProps) {
  const searchShortcut = useProjectSearchShortcutLabel();
  // The search opens once the project menu has closed, so returning focus doesn't dismiss it.
  const openSearchAfterMenuRef = useRef(false);
  const refocusPrompt = (event: Event) =>
    refocusComposer(event, { promptTextareaRef, branchInputRef, projectTriggerRef });

  return (
    <Popover open={projectPickerOpen} onOpenChange={onProjectPickerOpenChange}>
      <PopoverAnchor className="flex min-w-0">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              ref={projectTriggerRef}
              type="button"
              className={cn(SEGMENT_CLASS, '-ml-1.5 max-w-[16rem] font-medium text-foreground')}
              title={searchShortcut ? `Choose project, ${searchShortcut} searches` : undefined}
            >
              <span
                // Keyed so picking another project that isn't the selected workspace's flashes again.
                key={selectedProject?.id}
                className={cn(
                  '-mx-1 flex min-w-0 items-center gap-1.5 rounded px-1',
                  flash && 'animate-project-attention'
                )}
                style={
                  {
                    '--project-color': selectedProject?.color || 'oklch(var(--muted-foreground))',
                  } as React.CSSProperties
                }
              >
                <ProjectMark project={selectedProject} iconClassName="size-3" />
                <span className="truncate">{selectedProject?.name || 'Select project'}</span>
              </span>
              <SegmentCaret />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            onCloseAutoFocus={(event) => {
              if (!openSearchAfterMenuRef.current) return refocusPrompt(event);
              openSearchAfterMenuRef.current = false;
              event.preventDefault();
              onProjectPickerOpenChange(true);
            }}
          >
            <DropdownMenuItem
              onClick={() => (openSearchAfterMenuRef.current = true)}
              className="text-muted-foreground"
            >
              <MagnifyingGlass />
              Search projects…
              {searchShortcut && <DropdownMenuShortcut>{searchShortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {projects.map((project, index) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => setProjectId(project.id)}
                className="flex items-center justify-between"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <ProjectMark project={project} />
                  <span className="truncate font-mono text-ui">{project.name}</span>
                </span>
                <ProjectRowEnd index={index} isSelected={project.id === projectId} />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onAddProject} className="text-muted-foreground">
              <Plus />
              Add new project…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenFolderWorkspace} className="text-muted-foreground">
              <FolderOpen />
              Open folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-[min(18rem,calc(100vw-2rem))] p-0"
        onWheel={stopWheelPropagation}
        onCloseAutoFocus={refocusPrompt}
      >
        <ProjectSearch
          projects={projects}
          projectId={projectId}
          onSelect={(id) => {
            setProjectId(id);
            onProjectPickerOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface NewWorkspaceContextBarProps {
  selectedProject: Project | undefined;
  environment: Omit<EnvironmentSegmentProps, 'onCloseAutoFocus' | 'open' | 'onOpenChange'>;
  /** The menu a dialog shortcut opened, or the one open now */
  openMenu: NewWorkspaceMenu | null;
  onMenuOpenChange: (menu: NewWorkspaceMenu, open: boolean) => void;
  // Branch source
  repoPath: string;
  baseBranch: string;
  baseBranchLabel: string;
  setBaseBranch: (branch: string, meta: BranchPickerMeta) => void;
  existingBranch: string;
  openExistingBranch: (branch: string, meta: BranchPickerMeta) => void;
  clearExistingBranch: () => void;
  usedBranches: string[];
  findWorkspaceForBranch: (branch: string) => { id: string; name: string } | undefined;
  onGoToWorkspace: (workspaceId: string) => void;
  // New branch name
  branchName: string;
  setBranchName: (v: string) => void;
  setIsBranchNameAutoGenerated: (v: boolean) => void;
  useAiBranchName: boolean;
  setUseAiBranchName: (v: boolean) => void;
  /** Also sets AI branch naming for later workspaces */
  toggleAiBranchName: (v: boolean) => void;
  /** The agent can name the branch from the prompt */
  showAiToggle: boolean;
  initialPromptText: string;
  branchInputRef: React.RefObject<HTMLInputElement | null>;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  projectTriggerRef: React.RefObject<HTMLButtonElement | null>;
}

/**
 * One line under the composer that reads like a path:
 * environment / start point → new branch.
 */
export function NewWorkspaceContextBar({
  selectedProject,
  environment,
  openMenu,
  onMenuOpenChange,
  repoPath,
  baseBranch,
  baseBranchLabel,
  setBaseBranch,
  existingBranch,
  openExistingBranch,
  clearExistingBranch,
  usedBranches,
  findWorkspaceForBranch,
  onGoToWorkspace,
  branchName,
  setBranchName,
  setIsBranchNameAutoGenerated,
  useAiBranchName,
  setUseAiBranchName,
  toggleAiBranchName,
  showAiToggle,
  initialPromptText,
  branchInputRef,
  promptTextareaRef,
  projectTriggerRef,
}: NewWorkspaceContextBarProps) {
  const gitDefaults = useConfigStore((s) => s.config?.gitDefaults);
  const menuOpenChange = (menu: NewWorkspaceMenu) => (open: boolean) =>
    onMenuOpenChange(menu, open);
  const selectedProjectIsDirectory = selectedProject?.kind === 'directory';
  const refocusPrompt = (event: Event) =>
    refocusComposer(event, { promptTextareaRef, branchInputRef, projectTriggerRef });

  return (
    <div
      className="floating-controls mt-1.5 flex w-fit max-w-full min-w-0 items-center gap-0.5 rounded-lg px-1 py-0.5 light:border light:shadow-soft"
      data-new-workspace-context-bar
    >
      <EnvironmentSegment
        {...environment}
        onCloseAutoFocus={refocusPrompt}
        open={openMenu === 'environment'}
        onOpenChange={menuOpenChange('environment')}
      />

      {selectedProjectIsDirectory ? (
        <>
          <Separator />
          <span
            className="flex min-w-0 items-center gap-1 px-1.5 text-ui text-muted-foreground"
            title={selectedProject.repositoryPath}
          >
            <Folder className="size-3 shrink-0" />
            <span className="truncate font-mono">{selectedProject.repositoryPath}</span>
          </span>
        </>
      ) : (
        selectedProject && (
          <>
            <Separator />
            {existingBranch ? (
              <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-warning/10 py-0.5 pr-0.5 pl-1.5 text-ui text-warning">
                <GitBranch className="size-3 shrink-0" />
                open
                <span className="truncate font-mono">{existingBranch}</span>
                <button
                  type="button"
                  aria-label="Create a new branch instead"
                  title="Create a new branch instead"
                  onClick={clearExistingBranch}
                  className="rounded p-0.5 hover:bg-warning/20"
                >
                  <X className="size-3" />
                </button>
              </span>
            ) : (
              <WorkspaceBranchPicker
                trigger={
                  <>
                    <GitBranch className="size-3 shrink-0" />
                    <span className="shrink-0">from</span>
                    <span className="truncate font-mono text-foreground">{baseBranchLabel}</span>
                    <SegmentCaret />
                  </>
                }
                triggerClassName={SEGMENT_CLASS}
                projectId={selectedProject.id}
                repoPath={repoPath}
                sshHost={
                  environment.launchTarget === 'ssh' ? environment.selectedSshHost : undefined
                }
                baseBranch={baseBranch}
                usedBranches={usedBranches}
                findWorkspaceForBranch={findWorkspaceForBranch}
                onSelectBase={setBaseBranch}
                onOpenBranch={openExistingBranch}
                onGoToWorkspace={onGoToWorkspace}
                onCloseAutoFocus={refocusPrompt}
                open={openMenu === 'branch'}
                onOpenChange={menuOpenChange('branch')}
              />
            )}
            {!existingBranch && (
              <BranchNameField
                branchName={branchName}
                setBranchName={setBranchName}
                setIsBranchNameAutoGenerated={setIsBranchNameAutoGenerated}
                useAiBranchName={useAiBranchName}
                setUseAiBranchName={setUseAiBranchName}
                toggleAiBranchName={toggleAiBranchName}
                showAiToggle={showAiToggle}
                hasPrompt={Boolean(initialPromptText.trim())}
                branchInputRef={branchInputRef}
                defaultBranchPrefix={resolveBranchPrefix(selectedProject, gitDefaults)}
              />
            )}
          </>
        )
      )}
    </div>
  );
}
