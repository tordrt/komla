import { Folder, Download, CaretDown, Plus } from '@phosphor-icons/react';
import React, { useState, useEffect } from 'react';

import { BranchSelect } from '@/components/ui/branch-select';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ColorPicker } from '@/components/ui/color-picker';
import { Input } from '@/components/ui/input';
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useIconColors } from '@/hooks/useIconColors';
import { useProjectIconCandidates } from '@/hooks/useProjectIconCandidates';
import { getNextAvailableColor, PROJECT_COLORS, resolvePickedColor } from '@/lib/project-colors';
import { cn } from '@/lib/utils';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { getDefaultBranchPrefix } from '@/utils/branch-prefix';

import { validateGitIdentity } from '../../../shared/lib/git-identity';

import { cloneUrlFor, switchCloneProtocol, urlProtocol, type CloneProtocol } from './clone-url';
import { ProjectIconPicker } from './ProjectIconPicker';
import { validateProjectCreation, type ProjectCreationMode } from './validate-project-creation';

import type { BehindTargetAction, DirectoryInfo, Project, ProjectIconCandidate } from '@/types';

type CloneProgress = { percent: number; stage: string };

const CLONE_PROTOCOL_LABELS: Record<CloneProtocol, string> = { ssh: 'SSH', https: 'HTTPS' };

const CLONE_PROTOCOL_OPTIONS: SegmentedControlOption<CloneProtocol>[] = (
  ['ssh', 'https'] as const
).map((value) => ({ value, label: CLONE_PROTOCOL_LABELS[value] }));

function basenameFromPath(path: string): string {
  return path.trim().split(/[/\\]/).filter(Boolean).pop() ?? '';
}

function projectNameFromRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const match = trimmed.match(/\/([^/]+?)(\.git)?$/) || trimmed.match(/:([^/]+?)(\.git)?$/);
  return match?.[1] ?? '';
}

interface LocalPathFieldsProps {
  projectPath: string;
  onSwitchToNewRepo: () => void;
  disabled: boolean;
  directoryInfo: DirectoryInfo | null;
  isCheckingDirectory: boolean;
}

function LocalPathFields({
  projectPath,
  onSwitchToNewRepo,
  disabled,
  directoryInfo,
  isCheckingDirectory,
}: LocalPathFieldsProps) {
  const selectedNonGitDirectory =
    Boolean(projectPath) && !isCheckingDirectory && directoryInfo?.isGit === false;

  return (
    <div role="group" aria-label="Local folder" className="grid gap-2">
      {projectPath && (
        <div className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-3 py-2">
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm" title={projectPath}>
            {projectPath}
          </span>
        </div>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={onSwitchToNewRepo}
          disabled={disabled}
        >
          <Plus className="mr-1 size-3.5" />
          Create empty repo
        </Button>
      </div>
      {selectedNonGitDirectory && (
        <Callout tone="warning" role="status" title="This folder is not a Git repository">
          It will be added as a fixed directory project. All workspaces will share this folder
          instead of using isolated worktrees.
        </Callout>
      )}
      {projectPath && !selectedNonGitDirectory && (
        <p className="text-xs text-muted-foreground">
          {isCheckingDirectory
            ? 'Checking folder...'
            : directoryInfo?.isGit
              ? 'Git repository detected. New workspaces will use isolated worktrees.'
              : 'Checking folder...'}
        </p>
      )}
    </div>
  );
}

interface NewRepoFieldsProps {
  newProjectName: string;
  onNewProjectNameChange: (value: string) => void;
  onSwitchToExisting: () => void;
  disabled: boolean;
}

function NewRepoFields({
  newProjectName,
  onNewProjectNameChange,
  onSwitchToExisting,
  disabled,
}: NewRepoFieldsProps) {
  return (
    <div className="grid gap-2">
      <label htmlFor="new-project-name" className="text-sm font-medium">
        Project Name
      </label>
      <Input
        id="new-project-name"
        value={newProjectName}
        onChange={(e) => onNewProjectNameChange(e.target.value)}
        placeholder="my-project"
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">
        A new empty git repository will be created for this project.{' '}
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={onSwitchToExisting}
          disabled={disabled}
        >
          Or use an existing repo
        </button>
      </p>
    </div>
  );
}

interface GitIdentityFieldsProps {
  userName: string;
  onUserNameChange: (value: string) => void;
  userEmail: string;
  onUserEmailChange: (value: string) => void;
  disabled: boolean;
}

function GitIdentityFields({
  userName,
  onUserNameChange,
  userEmail,
  onUserEmailChange,
  disabled,
}: GitIdentityFieldsProps) {
  return (
    <div role="group" aria-labelledby="git-identity-heading" className="grid gap-2">
      <p id="git-identity-heading" className="text-sm font-medium">
        Git identity
      </p>
      <p className="text-xs text-muted-foreground">
        Git needs a name and email for commits, and this computer doesn't have them set yet. They're
        saved to your global git config.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <label htmlFor="git-user-name" className="text-xs text-muted-foreground">
            Your name
          </label>
          <Input
            id="git-user-name"
            value={userName}
            onChange={(e) => onUserNameChange(e.target.value)}
            placeholder="Ada Lovelace"
            autoComplete="name"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="git-user-email" className="text-xs text-muted-foreground">
            Your email
          </label>
          <Input
            id="git-user-email"
            type="email"
            value={userEmail}
            onChange={(e) => onUserEmailChange(e.target.value)}
            placeholder="ada@example.com"
            autoComplete="email"
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}

interface ProjectNameFieldProps {
  projectName: string;
  onProjectNameChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
}

function ProjectNameField({
  projectName,
  onProjectNameChange,
  placeholder,
  disabled,
}: ProjectNameFieldProps) {
  return (
    <div className="grid gap-2">
      <label htmlFor="project-display-name" className="text-sm font-medium">
        Project Name
      </label>
      <Input
        id="project-display-name"
        value={projectName}
        onChange={(e) => onProjectNameChange(e.target.value)}
        placeholder={placeholder || 'Auto-detect'}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">
        Leave blank to use the detected project name. Duplicate detected names are suffixed
        automatically.
      </p>
    </div>
  );
}

/** Says what will be cloned when it isn't exactly what was entered over the chosen protocol. */
function cloneUrlHint(remoteUrl: string, cloneUrl: string, protocol: CloneProtocol): string | null {
  if (cloneUrl !== remoteUrl.trim()) {
    return `Clones over ${CLONE_PROTOCOL_LABELS[protocol]} as ${cloneUrl}`;
  }
  const entered = urlProtocol(cloneUrl);
  if (entered && entered !== protocol) {
    return `Clones over ${CLONE_PROTOCOL_LABELS[entered]}, as entered`;
  }
  return null;
}

interface RemoteUrlFieldsProps {
  remoteUrl: string;
  cloneUrl: string;
  onRemoteUrlChange: (value: string) => void;
  urlError: string | null;
  cloneProtocol: CloneProtocol;
  onCloneProtocolChange: (protocol: CloneProtocol) => void;
  cloneProgress: CloneProgress | null;
  disabled: boolean;
}

function RemoteUrlFields({
  remoteUrl,
  cloneUrl,
  onRemoteUrlChange,
  urlError,
  cloneProtocol,
  onCloneProtocolChange,
  cloneProgress,
  disabled,
}: RemoteUrlFieldsProps) {
  const placeholder =
    cloneProtocol === 'ssh' ? 'git@github.com:user/repo.git' : 'https://github.com/user/repo.git';
  const helperText =
    cloneUrlHint(remoteUrl, cloneUrl, cloneProtocol) ??
    (cloneProtocol === 'ssh'
      ? 'Uses your SSH key. GitHub, GitLab and Bitbucket links work too'
      : 'GitHub, GitLab, Bitbucket, or any Git URL');

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <label htmlFor="remote-url" className="text-sm font-medium">
          Repository URL
        </label>
        <SegmentedControl
          aria-label="Clone protocol"
          value={cloneProtocol}
          onValueChange={onCloneProtocolChange}
          options={CLONE_PROTOCOL_OPTIONS}
          disabled={disabled}
        />
      </div>
      <Input
        id="remote-url"
        value={remoteUrl}
        onChange={(e) => onRemoteUrlChange(e.target.value)}
        placeholder={placeholder}
        className={urlError ? 'border-error' : ''}
        aria-invalid={urlError ? true : undefined}
        aria-describedby="remote-url-hint"
        disabled={disabled}
      />
      <p
        id="remote-url-hint"
        className={cn('text-xs', urlError ? 'text-error' : 'text-muted-foreground')}
      >
        {urlError ?? helperText}
      </p>
      {cloneProgress && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            <span>
              {cloneProgress.stage}: {cloneProgress.percent}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${cloneProgress.percent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function describeBehindAction(action: BehindTargetAction): string {
  if (action === 'auto') {
    return 'Clicking ↓N merges for pushed branches (safe) and rebases for local-only branches (clean history)';
  }
  if (action === 'rebase') {
    return 'Clicking ↓N rebases the current branch on top of the target branch (cleaner history)';
  }
  return 'Clicking ↓N merges the target branch into the current branch (preserves merge commit)';
}

interface AdvancedFieldsProps {
  projectName?: string;
  onProjectNameChange?: (value: string) => void;
  projectNamePlaceholder?: string;
  showGitFields: boolean;
  branchPrefix: string;
  onBranchPrefixChange: (value: string) => void;
  /** 'default' follows the app-wide git settings. */
  behindAction: BehindTargetAction | 'default';
  onBehindActionChange: (action: BehindTargetAction | 'default') => void;
  disabled: boolean;
}

function AdvancedFields({
  projectName,
  onProjectNameChange,
  projectNamePlaceholder,
  showGitFields,
  branchPrefix,
  onBranchPrefixChange,
  behindAction,
  onBehindActionChange,
  disabled,
}: AdvancedFieldsProps) {
  const gitDefaults = useConfigStore((s) => s.config?.gitDefaults);
  const appWideBehind = gitDefaults?.behindTargetAction ?? 'auto';
  return (
    <>
      {onProjectNameChange && projectName !== undefined && projectNamePlaceholder !== undefined && (
        <ProjectNameField
          projectName={projectName}
          onProjectNameChange={onProjectNameChange}
          placeholder={projectNamePlaceholder}
          disabled={disabled}
        />
      )}

      {showGitFields && (
        <>
          <div className="grid gap-2">
            <label htmlFor="project-prefix" className="text-sm font-medium">
              Branch Prefix
            </label>
            <Input
              id="project-prefix"
              value={branchPrefix}
              onChange={(e) => onBranchPrefixChange(e.target.value)}
              placeholder={
                gitDefaults?.branchPrefix ? `${gitDefaults.branchPrefix} (default)` : 'e.g. komla/'
              }
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              Optional prefix for branch names (e.g., "komla/")
            </p>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">Behind shortcut action</label>
            <Select
              value={behindAction}
              onChange={(e) =>
                onBehindActionChange(e.target.value as BehindTargetAction | 'default')
              }
              disabled={disabled}
            >
              <option value="default">Default (from Settings → Git)</option>
              <option value="auto">Auto (merge if pushed, rebase if local)</option>
              <option value="rebase">Always rebase on target branch</option>
              <option value="merge">Always merge target branch into current</option>
            </Select>
            <p className="text-xs text-muted-foreground">
              {describeBehindAction(behindAction === 'default' ? appWideBehind : behindAction)}
            </p>
          </div>
        </>
      )}
    </>
  );
}

function CompactSubmitLabel({
  isCreating,
  cloneProgress,
}: {
  isCreating: boolean;
  cloneProgress: CloneProgress | null;
}) {
  if (cloneProgress) {
    return (
      <>
        <Spinner className="mr-2" />
        Cloning…
      </>
    );
  }
  if (isCreating) {
    return (
      <>
        <Spinner className="mr-2" />
        Adding…
      </>
    );
  }
  return <>Add Project</>;
}

function PrimarySubmitLabel({
  mode,
  isNewRepo,
  isCreating,
  cloneProgress,
}: {
  mode: ProjectCreationMode;
  isNewRepo: boolean;
  isCreating: boolean;
  cloneProgress: CloneProgress | null;
}) {
  if (cloneProgress) {
    return (
      <>
        <Spinner className="mr-2" />
        Cloning…
      </>
    );
  }
  if (isCreating) {
    return (
      <>
        <Spinner className="mr-2" />
        {isNewRepo ? 'Creating…' : 'Adding…'}
      </>
    );
  }
  if (mode === 'remote') return <>Clone &amp; Add Project</>;
  if (isNewRepo) return <>Create &amp; Add Project</>;
  return <>Add Project</>;
}

interface SubmitActionsProps {
  compact?: boolean;
  creationMode: ProjectCreationMode;
  isNewRepo: boolean;
  isCreating: boolean;
  cloneProgress: CloneProgress | null;
  backButton?: React.ReactNode;
  skipLabel?: string;
  onSave: () => void;
  onCancel?: () => void;
  onSkip?: () => void;
  isFormDisabled: boolean;
  isSubmitDisabled: boolean;
}

function SubmitActions({
  compact,
  creationMode,
  isNewRepo,
  isCreating,
  cloneProgress,
  backButton,
  skipLabel,
  onSave,
  onCancel,
  onSkip,
  isFormDisabled,
  isSubmitDisabled,
}: SubmitActionsProps) {
  if (compact) {
    return (
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={isFormDisabled}
          >
            Cancel
          </Button>
        )}
        <Button type="button" size="sm" onClick={onSave} disabled={isSubmitDisabled}>
          <CompactSubmitLabel isCreating={isCreating} cloneProgress={cloneProgress} />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {backButton}
        <Button type="button" onClick={onSave} className="flex-1" disabled={isSubmitDisabled}>
          <PrimarySubmitLabel
            mode={creationMode}
            isNewRepo={isNewRepo}
            isCreating={isCreating}
            cloneProgress={cloneProgress}
          />
        </Button>
      </div>
      {skipLabel && onSkip && (
        <button
          type="button"
          className="w-full text-sm text-muted-foreground transition-colors hover:text-foreground"
          onClick={onSkip}
          disabled={isFormDisabled}
        >
          {skipLabel}
        </button>
      )}
    </div>
  );
}

interface SourceOptionProps {
  onClick: () => void;
  /** This source is the one the form is currently set up for */
  pressed: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  description: string;
}

function SourceOption({ onClick, pressed, disabled, icon, label, description }: SourceOptionProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={pressed}
      className={cn(
        'h-auto min-h-12 flex-1 justify-start px-2.5 py-2 text-left hover:shadow-none',
        pressed && 'border-primary/50 bg-primary/5 ring-1 ring-primary/50 hover:bg-primary/10'
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="mr-2 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs leading-4">{label}</span>
        <span className="block truncate text-2xs font-normal text-muted-foreground">
          {description}
        </span>
      </span>
    </Button>
  );
}

/**
 * Whether git has a name and email for commits and, when it doesn't and the project
 * uses git, the values typed for them.
 */
function useGitIdentity(usesGit: boolean) {
  // null while checking
  const [canCommit, setCanCommit] = useState<boolean | null>(null);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.api.getGitIdentity().then(
      (identity) => {
        if (cancelled) return;
        setCanCommit(identity.canCommit);
        setUserName(identity.userName ?? '');
        setUserEmail(identity.userEmail ?? '');
      },
      () => {
        // Unknown: don't block; git reports a missing identity itself.
        if (!cancelled) setCanCommit(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const needed = usesGit && canCommit === false;

  const saveIfNeeded = async () => {
    if (!needed) return;
    const validationError = validateGitIdentity(userName, userEmail);
    if (validationError) throw new Error(validationError);
    const result = await window.api.setGitIdentity(userName.trim(), userEmail.trim());
    if (!result.success) throw new Error(result.message);
    setCanCommit(true);
  };

  return {
    needed,
    // Wait until it's known whether git needs an identity, then for one to be typed.
    blocksSubmit:
      (usesGit && canCommit === null) || (needed && (!userName.trim() || !userEmail.trim())),
    userName,
    setUserName,
    userEmail,
    setUserEmail,
    saveIfNeeded,
  };
}

interface ProjectCreationFormProps {
  onSuccess: (project: Project) => void;
  onCancel?: () => void;
  compact?: boolean; // For inline use in NewWorkspaceDialog
  defaultBranchPrefix?: string; // Override the default branch prefix
  skipLabel?: string; // If provided, shows a skip button with this label
  onSkip?: () => void; // Called when skip is clicked
  disabled?: boolean; // Disable all form fields (e.g., during external operations)
  backButton?: React.ReactNode; // Optional back button to render in the action area
  hideProjectColor?: boolean; // Hide the project color picker (e.g., in setup wizard)
  hideAdvanced?: boolean; // Hide Target Branch + advanced settings (e.g., in setup wizard)
  onCreatingChange?: (isCreating: boolean) => void;
  initialPath?: string; // Folder to start with, as if picked with Browse for folder
}

/** An icon picked in the form, with the images found when it was picked. */
interface PickedIcon {
  icon: string;
  found: ProjectIconCandidate[];
}

/**
 * The best icon found until another, an upload or the color dot is picked. An image found in
 * a folder no longer chosen stops being picked; an upload or the color dot stays picked.
 */
function resolveSelectedIcon(
  picked: PickedIcon | null,
  candidates: ProjectIconCandidate[]
): string {
  const isFound = (list: ProjectIconCandidate[]) => list.some((c) => c.dataUrl === picked?.icon);
  if (picked && (!isFound(picked.found) || isFound(candidates))) return picked.icon;
  return candidates[0]?.dataUrl ?? '';
}

export function ProjectCreationForm({
  onSuccess,
  onCancel,
  compact,
  defaultBranchPrefix,
  skipLabel,
  onSkip,
  disabled,
  backButton,
  hideProjectColor,
  hideAdvanced,
  onCreatingChange,
  initialPath,
}: ProjectCreationFormProps) {
  const { projects, createProject, createProjectFromRemote, createProjectFromNew } =
    useProjectsStore();
  const { config, updateConfig } = useConfigStore();
  const { activePreset } = useAgentPresetsStore();

  const [creationMode, setCreationMode] = useState<ProjectCreationMode>('local');
  const [projectPath, setProjectPath] = useState(initialPath ?? '');
  const [remoteUrl, setRemoteUrl] = useState('');
  // Until a protocol is picked, a pasted URL keeps its own, so an HTTPS link doesn't need a key.
  const savedCloneProtocol = config?.preferredCloneProtocol;
  const cloneProtocol: CloneProtocol = savedCloneProtocol ?? urlProtocol(remoteUrl.trim()) ?? 'ssh';
  const cloneUrl = cloneUrlFor(remoteUrl, cloneProtocol);
  const handleCloneProtocolChange = (protocol: CloneProtocol) => {
    if (protocol === savedCloneProtocol) return;
    void updateConfig({ preferredCloneProtocol: protocol });
    if (remoteUrl) setRemoteUrl(switchCloneProtocol(remoteUrl, protocol));
  };
  const [urlError, setUrlError] = useState<string | null>(null);
  const [cloneProgress, setCloneProgress] = useState<CloneProgress | null>(null);
  const [projectName, setProjectName] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [isNewRepo, setIsNewRepo] = useState(false);
  const [projectBranchPrefix, setProjectBranchPrefix] = useState(
    () => defaultBranchPrefix ?? getDefaultBranchPrefix(activePreset?.name)
  );
  const [projectBaseBranch, setProjectBaseBranch] = useState('');
  const [projectColor, setProjectColor] = useState('');
  // Only a folder on disk has files to look for icons in before the project is added, but
  // an uploaded icon works for any source.
  const scansIcons = !hideProjectColor && creationMode === 'local' && !isNewRepo;
  const iconCandidates = useProjectIconCandidates(
    scansIcons ? { folder: projectPath.trim() } : null
  );
  const [pickedIcon, setPickedIcon] = useState<PickedIcon | null>(null);
  // The wizard shows no picker and finds no icons, so it adds the project with its dot.
  const selectedIcon = resolveSelectedIcon(pickedIcon, iconCandidates);
  const iconColors = useIconColors(selectedIcon);
  // Follows the icon's main color, or shows the color the project would get anyway, until
  // another is picked. A color picked from an icon no longer chosen stops being picked.
  const selectedColor = resolvePickedColor(
    projectColor,
    [...PROJECT_COLORS, ...iconColors],
    iconColors[0] || getNextAvailableColor(projects.flatMap((p) => (p.color ? [p.color] : [])))
  );
  const [originRemoteStatus, setOriginRemoteStatus] = useState<'checking' | 'yes' | 'no'>('no');
  const [directoryInfo, setDirectoryInfo] = useState<DirectoryInfo | null>(null);
  const [isCheckingDirectory, setIsCheckingDirectory] = useState(false);
  const [behindAction, setBehindAction] = useState<BehindTargetAction | 'default'>('default');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const localFolderIsGit = creationMode === 'local' && !isNewRepo && directoryInfo?.isGit === true;
  const usesGit = isNewRepo || creationMode === 'remote' || localFolderIsGit;
  const gitIdentity = useGitIdentity(usesGit);

  // Clear URL error when URL changes
  useEffect(() => {
    setUrlError(null);
  }, [remoteUrl]);

  useEffect(() => {
    if (creationMode !== 'local' || isNewRepo || !projectPath.trim()) {
      setDirectoryInfo(null);
      setIsCheckingDirectory(false);
      return;
    }

    let cancelled = false;
    setDirectoryInfo(null);
    setIsCheckingDirectory(true);
    void window.api
      .getDirectoryInfo(projectPath.trim())
      .then((info) => {
        if (!cancelled) {
          setDirectoryInfo(info);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDirectoryInfo({ isGit: false, branch: null });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingDirectory(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [creationMode, isNewRepo, projectPath]);

  useEffect(() => {
    if (creationMode === 'remote') {
      setOriginRemoteStatus('yes');
      return;
    }

    if (
      creationMode !== 'local' ||
      isNewRepo ||
      !projectPath.trim() ||
      directoryInfo?.isGit !== true
    ) {
      setOriginRemoteStatus('no');
      return;
    }

    let cancelled = false;
    setOriginRemoteStatus('checking');
    void window.api
      .hasOriginRemote(projectPath.trim())
      .then((hasRemote) => {
        if (!cancelled) {
          setOriginRemoteStatus(hasRemote ? 'yes' : 'no');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOriginRemoteStatus('no');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [creationMode, directoryInfo?.isGit, isNewRepo, projectPath]);

  const isCheckingOriginRemote = originRemoteStatus === 'checking';

  useEffect(() => {
    const unsubscribe = window.api.onGitProgress((data) => {
      if (data.operation === 'clone') {
        setCloneProgress({ percent: data.percent, stage: data.stage });
      }
    });
    return unsubscribe;
  }, []);

  const handleSelectProjectPath = async () => {
    setProjectError(null);
    try {
      const path = await window.api.selectAnyDirectory();
      if (path) {
        setProjectPath(path);
        setProjectBaseBranch('');
      }
    } catch (err) {
      setProjectError((err as Error).message);
    }
  };

  const dispatchCreate = async (): Promise<Project> => {
    const common = {
      defaultBranchPrefix: projectBranchPrefix.trim(),
      ...(behindAction === 'default' ? {} : { behindTargetAction: behindAction }),
      ...(hideProjectColor ? {} : { color: selectedColor }),
      ...(selectedIcon && { icon: selectedIcon }),
    };

    if (creationMode === 'local' && isNewRepo) {
      return createProjectFromNew({ name: newProjectName.trim(), ...common });
    }
    if (creationMode === 'local') {
      return createProject({
        name: projectName.trim() || undefined,
        repositoryPath: projectPath.trim(),
        baseBranch: projectBaseBranch.trim() || undefined,
        // A dot picked over the icons found here stays picked.
        ...(iconCandidates.length > 0 && { iconPromptAsked: true }),
        ...common,
      });
    }
    setCloneProgress({ percent: 0, stage: 'Starting clone...' });
    return createProjectFromRemote({
      name: projectName.trim() || undefined,
      remoteUrl: cloneUrl,
      baseBranch: projectBaseBranch.trim() || undefined,
      ...common,
    });
  };

  const handleSaveProject = async () => {
    setProjectError(null);

    const validationError = validateProjectCreation({
      mode: creationMode,
      isNewRepo,
      newProjectName,
      projectPath,
      remoteUrl,
      isCheckingOriginRemote,
    });
    if (validationError) {
      // URL problems show on the URL field itself.
      if (creationMode === 'remote') setUrlError(validationError);
      else setProjectError(validationError);
      return;
    }

    setIsCreating(true);
    onCreatingChange?.(true);
    try {
      await gitIdentity.saveIfNeeded();
      const project = await dispatchCreate();
      onSuccess(project);
    } catch (err) {
      setProjectError((err as Error).message);
      setCloneProgress(null);
    } finally {
      setIsCreating(false);
      onCreatingChange?.(false);
    }
  };

  const isFormDisabled = disabled || isCreating || cloneProgress !== null;
  const requiredInput =
    creationMode === 'remote' ? remoteUrl : isNewRepo ? newProjectName : projectPath;
  const isSubmitDisabled =
    isFormDisabled ||
    isCheckingOriginRemote ||
    !requiredInput.trim() ||
    // Until the folder check finishes, it isn't known whether git needs an identity.
    isCheckingDirectory ||
    gitIdentity.blocksSubmit;
  const remoteHasUrl = creationMode === 'remote' && remoteUrl.trim().length > 0;
  const showGitAdvancedFields =
    remoteHasUrl || (creationMode === 'local' && (isNewRepo || localFolderIsGit));
  const hasProjectNameSource =
    !isNewRepo && (creationMode === 'remote' ? remoteHasUrl : projectPath.trim().length > 0);
  const showAdvancedControls =
    !hideAdvanced && (isNewRepo || showGitAdvancedFields || hasProjectNameSource);
  const projectNamePlaceholder =
    creationMode === 'remote' ? projectNameFromRemoteUrl(cloneUrl) : basenameFromPath(projectPath);

  const handleSelectLocalMode = () => {
    setCreationMode('local');
    setIsNewRepo(false);
    setProjectBaseBranch('');
  };
  const handleBrowseForFolder = () => {
    handleSelectLocalMode();
    void handleSelectProjectPath();
  };
  const handleSelectRemoteMode = () => {
    setCreationMode('remote');
    setIsNewRepo(false);
    setProjectBaseBranch('');
  };
  // Enter in a text field adds the project. Cancelling the keydown also stops an
  // enclosing <form> (e.g. New Workspace) from implicitly submitting instead.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (!(e.target instanceof HTMLInputElement) || !e.currentTarget.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!isSubmitDisabled) void handleSaveProject();
  };

  return (
    <div
      role="region"
      aria-label="Add project"
      className={`space-y-4 ${compact ? 'rounded-lg border bg-muted/30 p-4' : ''}`}
      onKeyDown={handleKeyDown}
    >
      {compact && (
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium">Add New Project</h4>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <SourceOption
          onClick={handleBrowseForFolder}
          pressed={creationMode === 'local' && !isNewRepo && Boolean(projectPath)}
          disabled={isFormDisabled}
          icon={<Folder className="size-4" />}
          label="Browse for folder"
          description="Folder on disk"
        />
        <SourceOption
          onClick={handleSelectRemoteMode}
          pressed={creationMode === 'remote'}
          disabled={isFormDisabled}
          icon={<Download className="size-4" />}
          label="Clone from remote"
          description="Git URL"
        />
      </div>

      {creationMode === 'local' && !isNewRepo && (
        <LocalPathFields
          projectPath={projectPath}
          onSwitchToNewRepo={() => {
            setIsNewRepo(true);
            setProjectBaseBranch('');
          }}
          disabled={isFormDisabled}
          directoryInfo={directoryInfo}
          isCheckingDirectory={isCheckingDirectory}
        />
      )}

      {creationMode === 'local' && isNewRepo && (
        <NewRepoFields
          newProjectName={newProjectName}
          onNewProjectNameChange={setNewProjectName}
          onSwitchToExisting={() => {
            setIsNewRepo(false);
            setProjectBaseBranch('');
          }}
          disabled={isFormDisabled}
        />
      )}

      {creationMode === 'remote' && (
        <RemoteUrlFields
          remoteUrl={remoteUrl}
          cloneUrl={cloneUrl}
          onRemoteUrlChange={setRemoteUrl}
          urlError={urlError}
          cloneProtocol={cloneProtocol}
          onCloneProtocolChange={handleCloneProtocolChange}
          cloneProgress={cloneProgress}
          disabled={isFormDisabled}
        />
      )}

      {gitIdentity.needed && (
        <GitIdentityFields
          userName={gitIdentity.userName}
          onUserNameChange={gitIdentity.setUserName}
          userEmail={gitIdentity.userEmail}
          onUserEmailChange={gitIdentity.setUserEmail}
          disabled={isFormDisabled}
        />
      )}

      {!hideAdvanced && localFolderIsGit && projectPath && (
        <BranchSelect
          label="Target Branch"
          value={projectBaseBranch}
          onChange={setProjectBaseBranch}
          repoPath={projectPath}
          placeholder="Default branch"
          description="Branch used for diffs, PR targets, git shortcuts, and as the default for new workspaces"
        />
      )}

      {showAdvancedControls && (
        <>
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <CaretDown
              className={`size-3.5 transition-transform ${showAdvanced ? '' : '-rotate-90'}`}
            />
            Advanced settings
          </button>

          {showAdvanced && (
            <AdvancedFields
              projectName={!isNewRepo && hasProjectNameSource ? projectName : undefined}
              onProjectNameChange={!isNewRepo && hasProjectNameSource ? setProjectName : undefined}
              projectNamePlaceholder={
                !isNewRepo && hasProjectNameSource ? projectNamePlaceholder : undefined
              }
              showGitFields={showGitAdvancedFields}
              branchPrefix={projectBranchPrefix}
              onBranchPrefixChange={setProjectBranchPrefix}
              behindAction={behindAction}
              onBehindActionChange={setBehindAction}
              disabled={isFormDisabled}
            />
          )}
        </>
      )}

      {!hideProjectColor && (
        <ColorPicker
          label="Project Color"
          value={selectedColor}
          onChange={setProjectColor}
          colors={PROJECT_COLORS}
          suggestedColors={iconColors}
          suggestedLabel="Icon color"
          disabled={isFormDisabled}
        />
      )}

      {!hideProjectColor && (
        <ProjectIconPicker
          label="Project Icon"
          value={selectedIcon}
          onChange={(icon) => setPickedIcon({ icon, found: iconCandidates })}
          candidates={iconCandidates}
          color={selectedColor}
          disabled={isFormDisabled}
        />
      )}

      {projectError && (
        <Callout tone="error" role="alert">
          {projectError}
        </Callout>
      )}

      <SubmitActions
        compact={compact}
        creationMode={creationMode}
        isNewRepo={isNewRepo}
        isCreating={isCreating}
        cloneProgress={cloneProgress}
        backButton={backButton}
        skipLabel={skipLabel}
        onSave={handleSaveProject}
        onCancel={onCancel}
        onSkip={onSkip}
        isFormDisabled={isFormDisabled}
        isSubmitDisabled={isSubmitDisabled}
      />
    </div>
  );
}
