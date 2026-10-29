import {
  FolderOpen,
  CaretDown,
  Check,
  Plus,
  Folder,
  NotePencil,
  Sparkle,
  Robot,
  Keyboard,
} from '@phosphor-icons/react';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { ProjectCreationForm } from '@/components/projects/ProjectCreationForm';
import { AgentLaunchPickerMatrix } from '@/components/terminal/AgentLaunchPickerMatrix';
import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { ActionInputDialog } from '@/components/workspaces/ActionInputDialog';
import {
  NewWorkspaceContextBar,
  NewWorkspaceProjectPicker,
} from '@/components/workspaces/NewWorkspaceContextBar';
import {
  addPromptAttachments,
  DropToAttachOverlay,
  getTransferFiles,
  hasClipboardImage,
  PromptAttachmentList,
  readableFilePaths,
  type TransferFile,
  useWindowFileDrop,
} from '@/components/workspaces/NewWorkspacePromptAttachments';
import { VoiceRecordingIndicator } from '@/components/workspaces/VoiceRecordingIndicator';
import { NEW_WORKSPACE_SHORTCUTS_GROUP } from '@/constants/shortcut-entries';
import { useDetectedMainBranch } from '@/hooks/useDetectedMainBranch';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import {
  injectActionContext,
  ACTION_TARGET_BRANCH_TOKEN,
  actionNeedsInjection,
} from '@/lib/action-injection';
import {
  getNewWorkspaceDialogAction,
  getProjectShortcutIndex,
  movesFocus,
  type NewWorkspaceMenu,
  useNewWorkspaceShortcutLabel,
} from '@/lib/agent-dialog-shortcuts';
import {
  resolveLaunchablePresets,
  toggleLaunchTarget,
  type LaunchTarget,
  type WorkspaceEnvironmentTarget,
} from '@/lib/agent-launch';
import { focusPromptOnMenuClose } from '@/lib/dialog-menus';
import { stopWheelPropagation } from '@/lib/dialog-scroll-lock';
import { getLaunchModeColor, LAUNCH_MODE_PILL_CLASSES } from '@/lib/launch-mode-colors';
import { LEVEL_PICKER_ICON_COMPONENTS } from '@/lib/level-picker-icons';
import { pickFolder } from '@/lib/open-folder';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { cn } from '@/lib/utils';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import {
  openNewWorkspaceDialog,
  useDialogsStore,
  type NewWorkspaceDialogDraft,
} from '@/stores/dialogs.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { offerLaunchUndo } from '@/stores/launch-undo.store';
import { useProjectSyncStatusStore } from '@/stores/project-sync-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useVoiceStore } from '@/stores/voice.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';
import { handleCreateError, isRunningLimitError, showUpgradeDialog } from '@/utils/workspace-error';

import { resolveWorkspaceCreationEnvironment } from '../../../shared/lib/agent-environment';
import { canStartWithPrompt } from '../../../shared/lib/agent-preset-prompt';
import { levelPickerOf } from '../../../shared/lib/level-picker';
import { resolveBranchPrefix } from '../../../shared/lib/project-git-defaults';
import { projectRepoPath } from '../../../shared/lib/project-repo-path';
import { generateBranchSuffix, branchSuffixToName } from '../../../shared/lib/random-names';

import type { NewWorkspaceDialogAction } from '../../../shared/constants/shortcut-scopes';
import type { BranchPickerMeta } from '@/components/workspaces/WorkspaceBranchPicker';
import type { LevelHistory } from '@/lib/level-history';
import type {
  Action,
  ActivePresetEntry,
  AgentPreset,
  CreateWorkspaceParams,
  DesiredWorkspaceEnvironment,
  Project,
  ReasoningLevel,
  Workspace,
} from '@/types';

const DIALOG_BACKGROUND_LOAD_DELAY_MS = 250;
type Mode = 'worktree' | 'directory';
type BranchMode = 'new' | 'existing';
// The levels the dialog offers: none while the preset hides its picker, so
// launches use the agent default.
function shownReasoningLevels(preset: AgentPreset | null | undefined): ReasoningLevel[] {
  return preset && !levelPickerOf(preset).hidden ? (preset.reasoningLevels ?? []) : [];
}

// Effort for a preset: the level picked in this dialog, else the level
// remembered from its last launch, else the agent default (null), which a
// hidden picker always uses.
function resolveReasoningLevelId(
  presets: AgentPreset[],
  activePresets: ActivePresetEntry[],
  overrides: Record<string, string | null>,
  presetId: string | undefined
): string | null {
  if (!presetId) return null;
  const levels = shownReasoningLevels(presets.find((preset) => preset.id === presetId));
  const isAvailable = (levelId: string | null | undefined): levelId is string | null =>
    levelId === null || levels.some((level) => level.id === levelId);
  const override = overrides[presetId];
  if (presetId in overrides && isAvailable(override)) return override;
  const remembered =
    activePresets.find((entry) => entry.presetId === presetId)?.lastReasoningLevelId ?? null;
  return isAvailable(remembered) ? remembered : null;
}

// Workspaces that have a branch open for this project and location, flattened as
// [branch, id, name, ...] so that a shallow compare sees only changes to these.
function branchWorkspaceEntries(
  workspaces: Workspace[],
  projectId: string,
  sshHostId: string | null
): string[] {
  return workspaces.flatMap((candidate) =>
    candidate.projectId === projectId &&
    candidate.branchName &&
    (sshHostId
      ? candidate.backend?.kind === 'ssh' && candidate.backend.hostId === sshHostId
      : candidate.backend?.kind !== 'ssh')
      ? [candidate.branchName, candidate.id, candidate.customName || candidate.name]
      : []
  );
}

function qualifyRemoteOnlyBranch(branch: string, isRemoteOnly: boolean): string {
  return isRemoteOnly && branch ? `origin/${branch}` : branch;
}

/** A workspace launched with an Action starts with it as its default. */
function withDefaultAction(
  params: CreateWorkspaceParams,
  actionUsage: { id: string } | undefined
): CreateWorkspaceParams {
  return actionUsage ? { ...params, defaultActionId: actionUsage.id } : params;
}

function environmentKey(environment: DesiredWorkspaceEnvironment): string {
  if (environment.kind === 'ssh') return `ssh:${environment.hostId}`;
  return 'local';
}

/** What undoing a launch needs: the dialog's choices and the workspace selected before it. */
interface LaunchUndo {
  draft: NewWorkspaceDialogDraft;
  previousWorkspaceId: string | null;
}

// Pressing the New workspace shortcut again inside the dialog searches projects.
function isNewWorkspaceShortcut(event: KeyboardEvent): boolean {
  return useShortcutsStore.getState().matchesEvent('workspace.new', event);
}

interface NewWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewWorkspaceDialog({ open, onOpenChange }: NewWorkspaceDialogProps) {
  // Agents update the workspaces and their git state while the dialog is open, so it reads
  // only what it shows: a whole store would redraw the dialog on each update, between keystrokes.
  const createWorkspace = useWorkspacesStore((state) => state.createWorkspace);
  const createWorkspaces = useWorkspacesStore((state) => state.createWorkspaces);
  const deleteWorkspace = useWorkspacesStore((state) => state.deleteWorkspace);
  const selectWorkspace = useWorkspacesStore((state) => state.selectWorkspace);
  const selectedWorkspaceId = useWorkspacesStore((state) => state.selectedWorkspaceId);
  const retainedPrompt = useDialogsStore((state) => state.newWorkspaceDialogPrompt);
  const stagedPrefill = useDialogsStore((state) => state.newWorkspaceDialogPrefill);
  const { activePreset, activePresets, presets, setActivePreset } = useAgentPresetsStore(
    useShallow((state) => ({
      activePreset: state.activePreset,
      activePresets: state.activePresets,
      presets: state.presets,
      setActivePreset: state.setActivePreset,
    }))
  );
  const { actions, loadActions, recordActionUsage } = useActionsStore(
    useShallow((state) => ({
      actions: state.actions,
      loadActions: state.loadActions,
      recordActionUsage: state.recordActionUsage,
    }))
  );
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const projects = useProjectsStore((state) => state.projects);
  const loadSyncStatuses = useProjectSyncStatusStore((state) => state.loadAllStatuses);

  const [mode, setMode] = useState<Mode>('worktree');
  const [branchMode, setBranchMode] = useState<BranchMode>('new');
  const [branchName, setBranchName] = useState('');
  const [isBranchNameAutoGenerated, setIsBranchNameAutoGenerated] = useState(true);
  const [existingBranch, setExistingBranch] = useState('');
  const [existingBranchIsRemote, setExistingBranchIsRemote] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [launchTarget, setLaunchTarget] = useState<WorkspaceEnvironmentTarget | undefined>(
    undefined
  );
  const [sshHostId, setSshHostId] = useState('');
  const [actionId, setActionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Synchronous guard so a second submit in the same tick can't start a duplicate batch.
  const isSubmittingRef = useRef(false);
  const [initialPromptText, setInitialPromptText] = useState('');
  // Files pasted or dropped into the prompt, which creation copies into the workspace
  const [attachments, setAttachments] = useState<string[]>([]);
  const [launchModeId, setLaunchModeId] = useState<string | null>(null);
  // Effort picked in this dialog, per preset (null = agent default). Presets
  // without an entry use the level remembered from their last launch.
  const [reasoningLevelOverrides, setReasoningLevelOverrides] = useState<
    Record<string, string | null>
  >({});
  const [selectedLaunchTargets, setSelectedLaunchTargets] = useState<LaunchTarget[]>([]);
  // AI branch naming picked in this dialog (null = the saved setting)
  const [aiBranchNameOverride, setAiBranchNameOverride] = useState<boolean | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const loadModels = useVoiceStore((state) => state.loadModels);
  const voiceAutoRecord = config?.voice?.autoRecord === true;
  // True while the recording in progress is the one auto-record started.
  const autoStartedRecordingRef = useRef(false);

  // Set to true when Enter is pressed while transcription is in flight, so the
  // queued submission fires from onTranscription with the freshly-inserted text
  // (rather than racing against an empty initialPromptText).
  const submitAfterTranscriptionRef = useRef(false);

  // Lets onTranscription (a stable useCallback) invoke createWorkspaceWithPrompt
  // with the latest action selection, sidestepping closure-staleness issues.
  const submitWithPromptRef = useRef<(prompt: string) => void>(() => {});

  // The sparkle also sets the default for later workspaces.
  const toggleAiBranchName = useCallback(
    (v: boolean) => {
      setAiBranchNameOverride(v);
      void updateConfig({ autoNameBranches: v });
    },
    [updateConfig]
  );

  const {
    isRecording: isVoiceRecording,
    isStarting: isVoiceStarting,
    isTranscribing,
    levels: audioLevels,
    duration: recordingDuration,
    remainingSeconds: recordingRemainingSeconds,
    startRecording: startVoiceRecording,
    stopAndTranscribe: rawStopVoiceAndTranscribe,
    cancelRecording: cancelVoiceRecording,
    cancelTranscription: rawCancelVoiceTranscription,
  } = useVoiceInput({
    onTranscription: useCallback((text: string, _target: undefined, { morePending }) => {
      const ta = promptTextareaRef.current;
      let nextPrompt: string;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const before = ta.value.slice(0, start);
        const after = ta.value.slice(end);
        // Keep the dictation apart from the words on either side.
        const inserted =
          (/\S$/.test(before) && !/^\s/.test(text) ? ' ' : '') +
          text +
          (/^\S/.test(after) && !/\s$/.test(text) ? ' ' : '');
        nextPrompt = before + inserted + after;
        setInitialPromptText(nextPrompt);
        // Place cursor right after inserted text
        const cursorPos = start + inserted.length;
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(cursorPos, cursorPos);
        }, 0);
      } else {
        nextPrompt = text;
        setInitialPromptText(nextPrompt);
      }
      // If the user pressed Enter to submit while transcription was in flight,
      // run the deferred submission once the last one is in, with the
      // freshly-inserted text rather than a stale (empty) initialPromptText.
      if (submitAfterTranscriptionRef.current && !morePending) {
        submitAfterTranscriptionRef.current = false;
        submitWithPromptRef.current(nextPrompt);
      }
    }, []),
  });

  // Wrap stopAndTranscribe so a submit queued behind an earlier transcription
  // is cleared at the moment a new one is initiated.
  const stopVoiceAndTranscribe = useCallback(() => {
    submitAfterTranscriptionRef.current = false;
    return rawStopVoiceAndTranscribe();
  }, [rawStopVoiceAndTranscribe]);

  // A cancelled transcription also drops a submit queued behind it.
  const cancelVoiceTranscription = useCallback(() => {
    submitAfterTranscriptionRef.current = false;
    rawCancelVoiceTranscription();
  }, [rawCancelVoiceTranscription]);

  const setVoiceAutoRecord = useCallback(
    (autoRecord: boolean) => {
      void updateConfig({
        voice: {
          ...config?.voice,
          modelId: config?.voice?.modelId ?? 'parakeet-tdt-0.6b-v3-int8',
          modelPath: config?.voice?.modelPath ?? null,
          enabled: config?.voice?.enabled ?? false,
          autoRecord,
          transcribeAction: 'fill',
        },
      });
      // Turning it off also stops the recording it just started.
      if (!autoRecord && autoStartedRecordingRef.current) cancelVoiceRecording();
    },
    [config?.voice, updateConfig, cancelVoiceRecording]
  );

  // Fallback: if a submit was queued through transcription but neither
  // recording nor transcription is active anymore, useVoiceInput skipped
  // onTranscription (mic permission still pending, empty audio buffer,
  // empty transcript, or a transcribe error). Submit with whatever the
  // textarea currently holds so the Launch click isn't a silent no-op.
  useEffect(() => {
    if (submitAfterTranscriptionRef.current && !isVoiceRecording && !isTranscribing) {
      submitAfterTranscriptionRef.current = false;
      const ta = promptTextareaRef.current;
      submitWithPromptRef.current(ta?.value ?? initialPromptText);
    }
  }, [isVoiceRecording, isTranscribing]); // oxlint-disable-line react/exhaustive-deps

  // Resolve active presets sorted by most recently used
  const resolvedActivePresets = useMemo(() => {
    return [...activePresets]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((entry) => presets.find((p) => p.id === entry.presetId))
      .filter(Boolean) as AgentPreset[];
  }, [activePresets, presets]);
  const multiLaunchPresets = useMemo(
    () => resolveLaunchablePresets(resolvedActivePresets, activePresets),
    [activePresets, resolvedActivePresets]
  );

  const showPresetPicker = resolvedActivePresets.length >= 2;

  useEffect(() => {
    if (!open) {
      presetCycleOrderRef.current = [];
      return;
    }

    const presetIds = resolvedActivePresets.map((preset) => preset.id);
    const hasSamePresets =
      presetCycleOrderRef.current.length === presetIds.length &&
      presetCycleOrderRef.current.every((presetId) => presetIds.includes(presetId));

    if (!hasSamePresets) {
      presetCycleOrderRef.current = presetIds;
    }
  }, [open, resolvedActivePresets]);

  const resolvePreferredLaunchModeId = useCallback(
    (presetId: string): string | null => {
      const preset = presets.find((p) => p.id === presetId);
      const entry = activePresets.find((active) => active.presetId === presetId);
      if (entry && 'lastLaunchModeId' in entry && entry.lastLaunchModeId !== undefined) {
        if (entry.lastLaunchModeId === null) return null;
        if (preset?.launchModes.some((mode) => mode.id === entry.lastLaunchModeId)) {
          return entry.lastLaunchModeId;
        }
      }

      const globalDefault = config?.defaultLaunchModeId;
      return globalDefault && preset?.launchModes.some((mode) => mode.id === globalDefault)
        ? globalDefault
        : null;
    },
    [activePresets, config?.defaultLaunchModeId, presets]
  );

  // Base branch override for worktree creation (only for new branch mode)
  const [baseBranch, setBaseBranch] = useState('');
  const [branchHostId, setBranchHostId] = useState('');

  // Branches already checked out in worktrees (to exclude from existing branch selection)
  const [worktreeBranches, setWorktreeBranches] = useState<string[]>([]);

  // Inline project creation state
  const [showInlineProjectForm, setShowInlineProjectForm] = useState(false);
  // The folder the inline form starts on, when Open Folder picked a Git repository.
  const [inlineProjectPath, setInlineProjectPath] = useState('');
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<NewWorkspaceMenu | null>(null);

  // Action input dialog state (for actions with {{user_input}})
  const [actionInputDialogOpen, setActionInputDialogOpen] = useState(false);
  const [pendingActionForInput, setPendingActionForInput] = useState<
    (typeof actions)[number] | null
  >(null);

  const branchInputRef = useRef<HTMLInputElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const shouldRefocusPrompt = useRef(false);
  const presetCycleOrderRef = useRef<string[]>([]);
  const previousProjectIdRef = useRef<string>('');
  const previousProjectPrefixRef = useRef<string>('');
  const generatedBranchNameRef = useRef('');
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState('');
  const [isPushingSourceBranch, setIsPushingSourceBranch] = useState(false);
  // Branches origin has, as a local source's repository last saw them (null = not looked up).
  const [localOriginBranches, setLocalOriginBranches] = useState<string[] | null>(null);
  // Tracks whether the dialog's project was set from a prefill on this open
  // (e.g. fork-from-card). Lets the project-default effect bail out so it
  // doesn't overwrite the prefilled project in the same effect-flush cycle.
  const prefillProjectConsumedRef = useRef(false);
  // Set while this open shows an undone launch's choices, so the agent defaults don't replace them.
  const restoredDraftRef = useRef(false);
  // The branch name sync's next run still sees the state from before a restore, so it skips it.
  const skipBranchSyncRef = useRef(false);
  // Holds a prefill actionId until the actions list is loaded, then a separate
  // effect resolves the action's content into the prompt textarea.
  const pendingPrefillActionIdRef = useRef<string | null>(null);
  // Holds a prefill's agents for the default-agent effect below, until the dialog closes.
  const pendingPrefillPresetIdsRef = useRef<string[] | null>(null);
  // Holds a prefill's onLaunch until the dialog closes; a launch reads it before closing.
  const prefillOnLaunchRef = useRef<((presetIds: string[]) => void) | null>(null);
  const observedRetainedPromptRef = useRef('');

  // Slash command menu state
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [slashMenuNavigated, setSlashMenuNavigated] = useState(false);

  // Select just the suffix portion of a generated branch name so the user can quickly type over it
  const selectBranchSuffix = (fullBranchName: string, prefix: string) => {
    setTimeout(() => {
      const input = branchInputRef.current;
      if (input) {
        input.focus();
        input.setSelectionRange(prefix.length, fullBranchName.length);
      }
    }, 0);
  };

  // Slash-filtered prompt actions
  const slashFilteredActions = React.useMemo(() => {
    const promptActions = actions.filter((a) => a.type !== 'command');
    if (!slashFilter) return promptActions;
    const lower = slashFilter.toLowerCase();
    return promptActions.filter((a) => a.title.toLowerCase().includes(lower));
  }, [actions, slashFilter]);

  const selectedWorkspaceProjectId = useWorkspacesStore(
    (state) =>
      state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)?.projectId
  );
  const activeWorkspaceProject = selectedWorkspaceProjectId
    ? projects.find((p) => p.id === selectedWorkspaceProjectId)
    : null;
  const pendingPrefill = open ? useDialogsStore.getState().newWorkspaceDialogPrefill : null;
  const initialProjectId = useMemo(() => {
    if (!open || projects.length === 0) return '';
    if (pendingPrefill?.projectId && projects.some((p) => p.id === pendingPrefill.projectId)) {
      return pendingPrefill.projectId;
    }
    const lastUsedProject = config?.lastUsedProjectId
      ? projects.find((p) => p.id === config.lastUsedProjectId)
      : null;
    const defaultProject = config?.defaultProjectId
      ? projects.find((p) => p.id === config.defaultProjectId)
      : null;
    // Not the selected workspace's project: the default would change with every
    // click in the sidebar, so it couldn't be predicted.
    return (lastUsedProject || defaultProject || projects[0])?.id ?? '';
  }, [
    open,
    pendingPrefill?.projectId,
    projects,
    config?.lastUsedProjectId,
    config?.defaultProjectId,
  ]);

  // Derive selected preset (from picker, open-time default, or the active preset)
  const initialPresetId =
    open && resolvedActivePresets.length > 0 ? resolvedActivePresets[0].id : null;
  const effectiveSelectedPresetId = selectedPresetId || initialPresetId;
  const selectedPreset = effectiveSelectedPresetId
    ? presets.find((p) => p.id === effectiveSelectedPresetId) || activePreset
    : activePreset;
  const hasExplicitLaunchTarget = selectedLaunchTargets.some(
    (target) =>
      target.presetId === effectiveSelectedPresetId && target.launchModeId === launchModeId
  );
  const preferredLaunchModeId = effectiveSelectedPresetId
    ? resolvePreferredLaunchModeId(effectiveSelectedPresetId)
    : null;
  const sshHosts = useSshHostsStore((state) => state.hosts);
  const effectiveLaunchModeId =
    selectedLaunchTargets.length === 0 || hasExplicitLaunchTarget
      ? (launchModeId ?? preferredLaunchModeId)
      : preferredLaunchModeId;
  // Where the last workspace was started; picks in this dialog update it.
  const computedEnvironment = config
    ? resolveWorkspaceCreationEnvironment({ ...config, sshHosts }).environment
    : ({ kind: 'local' } as const);
  const effectiveLaunchTarget =
    launchTarget ?? (computedEnvironment.kind === 'ssh' ? 'ssh' : 'local');

  const effectiveProjectId = projectId || initialProjectId;
  const selectedProject = projects.find((p) => p.id === effectiveProjectId);
  const selectedProjectIsDirectory = selectedProject?.kind === 'directory';
  const selectedProjectPrefix = resolveBranchPrefix(selectedProject, config?.gitDefaults);
  const canLaunchMultiple =
    mode === 'worktree' && branchMode === 'new' && !selectedProjectIsDirectory;
  const effectiveBaseBranch = baseBranch || pendingPrefill?.baseBranch || '';
  const computedSshHostId = computedEnvironment.kind === 'ssh' ? computedEnvironment.hostId : '';
  const effectiveSshHostId = sshHostId || computedSshHostId || sshHosts[0]?.id || '';
  const selectedSshHost = sshHosts.find((host) => host.id === effectiveSshHostId);
  const isSshLaunch = effectiveLaunchTarget === 'ssh';
  const branchWorkspaces = useWorkspacesStore(
    useShallow((state) =>
      branchWorkspaceEntries(
        state.workspaces,
        effectiveProjectId,
        isSshLaunch ? effectiveSshHostId : null
      )
    )
  );
  const sshHostBranches = useMemo(
    () => branchWorkspaces.filter((_, index) => index % 3 === 0),
    [branchWorkspaces]
  );
  const effectiveWorktreeBranches = isSshLaunch ? sshHostBranches : worktreeBranches;

  const effectiveBranchName = useMemo(() => {
    if (
      branchName ||
      !isBranchNameAutoGenerated ||
      !open ||
      mode !== 'worktree' ||
      branchMode !== 'new' ||
      selectedProjectIsDirectory ||
      (!selectedProject && !isSshLaunch)
    ) {
      return branchName;
    }

    const projectPrefix = selectedProjectPrefix;
    if (!generatedBranchNameRef.current) {
      generatedBranchNameRef.current = `${projectPrefix}${generateBranchSuffix()}`;
      previousProjectIdRef.current = selectedProject?.id ?? '';
      previousProjectPrefixRef.current = projectPrefix;
    }
    return generatedBranchNameRef.current;
  }, [
    branchName,
    isBranchNameAutoGenerated,
    open,
    mode,
    branchMode,
    selectedProject,
    selectedProjectPrefix,
    selectedProjectIsDirectory,
    isSshLaunch,
  ]);

  // Check if selected preset has a valid agent command
  const hasAgent = Boolean(selectedPreset?.openCommand?.trim());
  const useAiBranchName =
    aiBranchNameOverride ??
    (config?.autoNameBranches === true &&
      hasAgent &&
      isBranchNameAutoGenerated &&
      mode === 'worktree' &&
      branchMode === 'new' &&
      !selectedProjectIsDirectory);

  // Compute available launch modes from selected preset
  const availableModes = React.useMemo(() => selectedPreset?.launchModes ?? [], [selectedPreset]);
  const availableReasoningLevels = shownReasoningLevels(selectedPreset);
  const getReasoningLevelId = (presetId: string | undefined): string | null =>
    resolveReasoningLevelId(presets, activePresets, reasoningLevelOverrides, presetId);
  const effectiveReasoningLevelId = getReasoningLevelId(selectedPreset?.id);

  const effectiveEnvironment: DesiredWorkspaceEnvironment = isSshLaunch
    ? { kind: 'ssh', hostId: effectiveSshHostId }
    : { kind: 'local' };
  // A pick sticks for later workspaces; a fork's prefill applies only to this one.
  const handleEnvironmentChange = (environment: DesiredWorkspaceEnvironment) => {
    // A folder project is on this computer, so an SSH host takes a Git project instead.
    if (environment.kind === 'ssh' && selectedProjectIsDirectory) {
      setProjectId(projects.find((project) => project.kind !== 'directory')?.id ?? '');
    }
    setLaunchTarget(environment.kind === 'ssh' ? 'ssh' : 'local');
    setSshHostId(environment.kind === 'ssh' ? environment.hostId : '');
    // A branch picked from a host's clone isn't anywhere else.
    if (branchHostId && (environment.kind !== 'ssh' || environment.hostId !== branchHostId)) {
      if (branchMode === 'existing') switchToNewBranch();
      else setBaseBranch('');
      setBranchHostId('');
    }
    void updateConfig({ lastWorkspaceEnvironment: environment });
  };

  useEffect(() => {
    if (canLaunchMultiple || selectedLaunchTargets.length === 0) return;
    setSelectedLaunchTargets([]);
  }, [canLaunchMultiple, selectedLaunchTargets.length]);

  // Reset launch mode if active preset changes and no longer supports it
  React.useEffect(() => {
    if (launchModeId && !availableModes.some((m) => m.id === launchModeId)) {
      setLaunchModeId(null);
    }
  }, [availableModes, launchModeId]);

  // Refocus prompt textarea after launch mode or preset cycle (deferred to run after re-render)
  React.useEffect(() => {
    if (shouldRefocusPrompt.current) {
      shouldRefocusPrompt.current = false;
      promptTextareaRef.current?.focus();
    }
  }, [launchModeId, selectedPresetId]);

  useEffect(() => {
    if (!isSshLaunch) return;
    setMode('worktree');
  }, [isSshLaunch]);

  // A folder project picked while an SSH host was last used opens here, on this computer. It
  // isn't saved as the location for later workspaces, as a pick of one is.
  useEffect(() => {
    if (!isSshLaunch || !selectedProjectIsDirectory) return;
    setLaunchTarget('local');
    setSshHostId('');
  }, [isSshLaunch, selectedProjectIsDirectory]);

  useEffect(() => {
    if (sshHosts.length === 0) {
      if (launchTarget === 'ssh') setLaunchTarget('local');
      setSshHostId('');
      return;
    }
    if (sshHostId && !sshHosts.some((host) => host.id === sshHostId)) setSshHostId('');
  }, [sshHosts, sshHostId, launchTarget]);

  // Another machine starts from origin's copy of the source workspace's branch, which the
  // source may not have pushed yet. The source's own host clones from its repository.
  const sourceWorkspace = useWorkspacesStore(
    useShallow((state) => {
      const workspace = sourceWorkspaceId
        ? state.workspaces.find((candidate) => candidate.id === sourceWorkspaceId)
        : undefined;
      return workspace
        ? {
            projectId: workspace.projectId,
            branchName: workspace.branchName,
            workingDirectory: workspace.workingDirectory,
            hostId: isSshWorkspace(workspace) ? workspace.backend.hostId : null,
          }
        : undefined;
    })
  );
  const sourceHostId = sourceWorkspace?.hostId ?? null;
  const sourceBranch = sourceWorkspace?.branchName;
  const sourceBranchFromOrigin =
    !!sourceWorkspace &&
    !!sourceBranch &&
    mode === 'worktree' &&
    branchMode === 'new' &&
    sourceWorkspace.projectId === effectiveProjectId &&
    effectiveBaseBranch === sourceBranch &&
    sourceHostId !== (isSshLaunch ? effectiveSshHostId : null);
  const sourceBranchStatus = useGitStatusStore((state) =>
    sourceBranchFromOrigin ? state.statusMap.get(sourceWorkspaceId)?.status : undefined
  );
  // A local branch can track another one, such as origin/main, so origin's copy is also
  // looked up by name. An SSH host's branches track their own name.
  const originLacksSourceBranch =
    !sourceBranchStatus?.hasRemote ||
    (!sourceHostId &&
      localOriginBranches !== null &&
      !!sourceBranch &&
      !localOriginBranches.includes(sourceBranch));
  const unpublishedSourceBranch =
    sourceBranchFromOrigin &&
    sourceBranchStatus?.hasOriginRemote &&
    sourceBranchStatus.currentBranch === sourceBranch &&
    (originLacksSourceBranch || sourceBranchStatus.unpushedCommits > 0)
      ? {
          branch: sourceBranch,
          missing: originLacksSourceBranch,
          unpushed: sourceBranchStatus.unpushedCommits,
          source: sourceHostId
            ? (sshHosts.find((host) => host.id === sourceHostId)?.name ?? 'its SSH host')
            : 'this computer',
          target: isSshLaunch ? (selectedSshHost?.name ?? 'the SSH host') : 'this computer',
        }
      : undefined;

  const sourceWorkingDirectory = sourceWorkspace?.workingDirectory;
  const sourceProjectId = sourceWorkspace?.projectId;
  const refreshSourceBranchStatus = useCallback(
    async (afterPush: boolean) => {
      if (!sourceWorkingDirectory) return;
      const store = useGitStatusStore.getState();
      // An SSH host pushes its status here, so only a push from here asks it again.
      const status = afterPush
        ? store.fetchStatus(sourceWorkspaceId, sourceWorkingDirectory, sourceProjectId)
        : store.fetchStatusIfStale(sourceWorkspaceId, sourceWorkingDirectory, sourceProjectId);
      const originBranches = sourceHostId
        ? undefined
        : window.api.listBranches(sourceWorkingDirectory, true).then(
            (branches) =>
              setLocalOriginBranches(
                branches.flatMap((branch) =>
                  branch.remoteRef?.startsWith('origin/') ? [branch.name] : []
                )
              ),
            () => setLocalOriginBranches(null)
          );
      await Promise.all([status, originBranches]);
    },
    [sourceWorkspaceId, sourceWorkingDirectory, sourceProjectId, sourceHostId]
  );

  useEffect(() => {
    if (!open || !sourceBranchFromOrigin) return;
    void refreshSourceBranchStatus(false);
  }, [open, sourceBranchFromOrigin, refreshSourceBranchStatus]);

  const handlePushSourceBranch = async () => {
    if (!sourceWorkspace) return;
    setError(null);
    setIsPushingSourceBranch(true);
    try {
      const result = await window.api.pushWorkspace(sourceWorkspaceId);
      if (!result.success) {
        setError(result.message);
        return;
      }
      await refreshSourceBranchStatus(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setIsPushingSourceBranch(false);
    }
  };

  // Get sync status for selected project
  const {
    behindRemote: projectBehindRemote = 0,
    aheadRemote: projectAheadRemote = 0,
    mainBranch: projectMainBranch,
  } = useProjectSyncStatusStore(
    useShallow((state) => {
      const status = state.statuses.get(effectiveProjectId);
      return {
        behindRemote: status?.behindRemote,
        aheadRemote: status?.aheadRemote,
        mainBranch: status?.mainBranch,
      };
    })
  );

  // Load sync statuses and actions shortly after open so first paint is not competing with IPC.
  useEffect(() => {
    if (!open) return;

    const timer = window.setTimeout(() => {
      void loadSyncStatuses();
      void loadActions();
    }, DIALOG_BACKGROUND_LOAD_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [open, loadSyncStatuses, loadActions]);

  useEffect(() => {
    if (!selectedProject) return;
    setMode(selectedProject.kind === 'directory' ? 'directory' : 'worktree');
  }, [selectedProject]);

  // Consume any prefill that was set before the dialog was opened (e.g. from a
  // workspace card "Fork" action), or while it is open (e.g. from the SSH host
  // dialog over it). Runs synchronously after the reset effect so the prefill
  // wins, and sets a ref to suppress the project-default effect.
  useEffect(() => {
    if (!open) {
      prefillProjectConsumedRef.current = false;
      restoredDraftRef.current = false;
      skipBranchSyncRef.current = false;
      pendingPrefillActionIdRef.current = null;
      pendingPrefillPresetIdsRef.current = null;
      prefillOnLaunchRef.current = null;
      return;
    }
    const { newWorkspaceDialogPrefill, setNewWorkspaceDialogPrefill } = useDialogsStore.getState();
    if (!newWorkspaceDialogPrefill) return;
    if (newWorkspaceDialogPrefill.draft) {
      // Undo clicked while a newer prompt is being written here keeps that one.
      if (!initialPromptText.trim()) restoreDraft(newWorkspaceDialogPrefill.draft);
      setNewWorkspaceDialogPrefill(null);
      return;
    }
    if (newWorkspaceDialogPrefill.projectId) {
      setProjectId(newWorkspaceDialogPrefill.projectId);
      prefillProjectConsumedRef.current = true;
      // The project asked for replaces one being added.
      setShowInlineProjectForm(false);
    }
    if (newWorkspaceDialogPrefill.baseBranch) {
      setBaseBranch(newWorkspaceDialogPrefill.baseBranch);
      setBranchHostId('');
    }
    if (newWorkspaceDialogPrefill.addProjectPath) {
      setInlineProjectPath(newWorkspaceDialogPrefill.addProjectPath);
      setShowInlineProjectForm(true);
    }
    if (newWorkspaceDialogPrefill.sourceWorkspaceId) {
      setSourceWorkspaceId(newWorkspaceDialogPrefill.sourceWorkspaceId);
      // A workspace from here starts on its source's machine, which has the branch.
      const source = useWorkspacesStore
        .getState()
        .workspaces.find(
          (workspace) => workspace.id === newWorkspaceDialogPrefill.sourceWorkspaceId
        );
      if (source && !isSshWorkspace(source)) setLaunchTarget('local');
    }
    if (newWorkspaceDialogPrefill.actionId) {
      pendingPrefillActionIdRef.current = newWorkspaceDialogPrefill.actionId;
    }
    if (newWorkspaceDialogPrefill.presetIds?.length) {
      pendingPrefillPresetIdsRef.current = newWorkspaceDialogPrefill.presetIds;
    }
    if (newWorkspaceDialogPrefill.onLaunch) {
      prefillOnLaunchRef.current = newWorkspaceDialogPrefill.onLaunch;
    }
    if (
      newWorkspaceDialogPrefill.sshHostId &&
      sshHosts.some((host) => host.id === newWorkspaceDialogPrefill.sshHostId)
    ) {
      setLaunchTarget('ssh');
      setSshHostId(newWorkspaceDialogPrefill.sshHostId);
    }
    setNewWorkspaceDialogPrefill(null);
  }, [open, stagedPrefill]); // oxlint-disable-line react/exhaustive-deps

  // Default selected preset to the most recently used active preset when dialog opens,
  // unless a prefill asked for agents; several of those launch one workspace each.
  // The requested agents stay until the dialog closes, so running this again on mount
  // (StrictMode in dev builds) picks them again instead of the default.
  useEffect(() => {
    const requestedPresetIds = pendingPrefillPresetIdsRef.current ?? [];
    if (open && resolvedActivePresets.length > 0 && !restoredDraftRef.current) {
      const prefilledPresetIds = requestedPresetIds.filter((id) =>
        resolvedActivePresets.some((preset) => preset.id === id)
      );
      const presetId = prefilledPresetIds[0] ?? resolvedActivePresets[0].id;
      const preferredLaunchModeId = resolvePreferredLaunchModeId(presetId);
      setSelectedPresetId(presetId);
      setLaunchModeId(preferredLaunchModeId);
      setSelectedLaunchTargets(
        prefilledPresetIds.length > 1
          ? prefilledPresetIds.map((id) => ({
              presetId: id,
              launchModeId: resolvePreferredLaunchModeId(id),
            }))
          : []
      );
    }
  }, [open]); // oxlint-disable-line react/exhaustive-deps

  // Load persisted prompt when dialog opens and auto-select it
  useEffect(() => {
    if (open) {
      // Abort any in-flight terminal dictation so the dialog's own voice
      // instance can own the mic — the app-wide recording mutex would
      // otherwise block auto-record (and keep typing into the terminal).
      executeShortcutAction('voice.cancel');

      let focusTimer: number | null = null;
      let voiceTimer: number | null = null;
      let cancelled = false;
      const { newWorkspaceDialogPrompt, newWorkspaceDialogAttachments } =
        useDialogsStore.getState();
      // A restored launch brings its own prompt.
      if (!restoredDraftRef.current) setAttachments(newWorkspaceDialogAttachments);
      useDialogsStore.getState().setNewWorkspaceDialogAttachments([]);
      if (newWorkspaceDialogPrompt && !restoredDraftRef.current) {
        setInitialPromptText(newWorkspaceDialogPrompt);
        // Delay to run after Radix Dialog's focus trap and autoFocus settle
        focusTimer = window.setTimeout(() => {
          promptTextareaRef.current?.focus();
          promptTextareaRef.current?.select();
        }, 0);
      }

      // Auto-start voice recording if auto-record is on, model is ready, and there's an agent.
      const isAutoRecord = useConfigStore.getState().config?.voice?.autoRecord ?? false;
      if (isAutoRecord && hasAgent) {
        // Defer recording startup until after the dialog has mounted and painted.
        // getUserMedia + audioWorklet.addModule (especially first-time in dev mode)
        // compete with Radix's mount animation and React's first reconciliation,
        // making the dialog feel sluggish to open.
        voiceTimer = window.setTimeout(() => {
          if (cancelled) return;
          const cachedStatus = useVoiceStore.getState().modelStatus;

          if (cachedStatus === 'ready') {
            autoStartedRecordingRef.current = true;
            startVoiceRecording();
          } else if (cachedStatus !== 'not-downloaded' && cachedStatus !== 'error') {
            void loadModels()
              .then(() => {
                if (cancelled) return;
                if (useVoiceStore.getState().modelStatus === 'ready') {
                  autoStartedRecordingRef.current = true;
                  startVoiceRecording();
                }
              })
              .catch(() => {});
          }
        }, 150);
      }

      return () => {
        cancelled = true;
        if (focusTimer) window.clearTimeout(focusTimer);
        if (voiceTimer) window.clearTimeout(voiceTimer);
      };
    } else {
      // Drop any in-flight transcription on programmatic close — handleOpenChange
      // only fires on user-initiated close, so we mirror it here.
      cancelVoiceTranscription();
      cancelVoiceRecording();
    }
  }, [open]); // oxlint-disable-line react/exhaustive-deps

  // Provisioning can fail after this dialog has already been reopened. Surface
  // the retained prompt unless the user has started a newer draft here.
  useEffect(() => {
    if (!retainedPrompt) {
      observedRetainedPromptRef.current = '';
      return;
    }
    if (!open || observedRetainedPromptRef.current === retainedPrompt) return;

    observedRetainedPromptRef.current = retainedPrompt;
    if (!initialPromptText && !restoredDraftRef.current) {
      setInitialPromptText(retainedPrompt);
    }
  }, [open, retainedPrompt, initialPromptText]);

  // Intercept the global voice shortcut while this dialog is open so the
  // double-tap operates on the dialog's own useVoiceInput instance.
  const voiceToggleHandler = useCallback(
    (e: Event) => {
      e.preventDefault(); // tells ShortcutProvider to skip global handling
      if (isVoiceStarting) {
        cancelVoiceRecording();
      } else if (isVoiceRecording) {
        stopVoiceAndTranscribe();
      } else {
        autoStartedRecordingRef.current = false;
        // Silently ignore when no model is downloaded, matching global behavior
        const { modelStatus, loadModelStatus } = useVoiceStore.getState();
        if (modelStatus === 'unknown') {
          void loadModelStatus().then(() => {
            if (useVoiceStore.getState().modelStatus === 'ready') {
              startVoiceRecording();
            }
          });
        } else if (modelStatus === 'ready') {
          startVoiceRecording();
        }
      }
    },
    [
      isVoiceStarting,
      isVoiceRecording,
      stopVoiceAndTranscribe,
      startVoiceRecording,
      cancelVoiceRecording,
    ]
  );

  useEffect(() => {
    if (!open || !hasAgent) return;
    window.addEventListener('komla:voice-toggle', voiceToggleHandler);
    return () => window.removeEventListener('komla:voice-toggle', voiceToggleHandler);
  }, [open, hasAgent, voiceToggleHandler]);

  // Scroll selected slash menu item into view
  useEffect(() => {
    if (slashMenuOpen && slashMenuRef.current) {
      const selected = slashMenuRef.current.children[slashMenuIndex] as HTMLElement | undefined;
      selected?.scrollIntoView({ block: 'nearest' });
    }
  }, [slashMenuOpen, slashMenuIndex]);

  // Focus branch input when dialog opens without an agent (prompt textarea gets autoFocus otherwise)
  useEffect(() => {
    if (open && !hasAgent) {
      const timer = window.setTimeout(() => branchInputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [open, hasAgent]);

  // Set default project and generate random branch name when dialog opens
  useEffect(() => {
    if (open) {
      // Skip when a prefill (e.g. fork-from-card) already set the project on
      // this open — its setProjectId hasn't flushed yet, so checking !projectId
      // alone would incorrectly fall through to the default-project resolution.
      if (prefillProjectConsumedRef.current) return;

      // Set default project first (we need the prefix for branch name generation)
      // Priority: lastUsedProjectId > defaultProjectId > first project
      if (initialProjectId && !projectId) {
        setProjectId(initialProjectId);
      }
    }
  }, [open, initialProjectId, projectId]);

  // Keep auto-generated branch names aligned with the selected project's prefix.
  useEffect(() => {
    if (skipBranchSyncRef.current) {
      skipBranchSyncRef.current = false;
      return;
    }
    if (
      !open ||
      mode !== 'worktree' ||
      branchMode !== 'new' ||
      selectedProjectIsDirectory ||
      !isBranchNameAutoGenerated
    ) {
      return;
    }

    const projectPrefix = selectedProjectPrefix;
    const projectChanged = !!selectedProject && previousProjectIdRef.current !== selectedProject.id;

    if (!selectedProject && !isSshLaunch) {
      previousProjectIdRef.current = '';
      previousProjectPrefixRef.current = '';
      return;
    }

    if (!branchName) {
      const nextBranchName =
        generatedBranchNameRef.current || `${projectPrefix}${generateBranchSuffix()}`;
      setBranchName(nextBranchName);
      generatedBranchNameRef.current = '';
    } else if (projectChanged) {
      const previousPrefix = previousProjectPrefixRef.current;
      const branchSuffix =
        previousPrefix && branchName.toLowerCase().startsWith(previousPrefix.toLowerCase())
          ? branchName.slice(previousPrefix.length)
          : branchName;
      setBranchName(`${projectPrefix}${branchSuffix}`);
    }

    previousProjectIdRef.current = selectedProject?.id ?? '';
    previousProjectPrefixRef.current = projectPrefix;
  }, [
    open,
    mode,
    branchMode,
    branchName,
    selectedProjectIsDirectory,
    isBranchNameAutoGenerated,
    selectedProject,
    selectedProjectPrefix,
    isSshLaunch,
  ]);

  // Fetch worktree branches when project changes (to exclude from existing branch selection)
  useEffect(() => {
    if (!open || !selectedProject || selectedProject.kind === 'directory') {
      setWorktreeBranches([]);
      return;
    }
    const repoPath = projectRepoPath(selectedProject);
    // A slow answer for a project the user already switched away from is dropped.
    let cancelled = false;
    window.api
      .getWorktreeBranches(repoPath)
      .then((branches: string[]) => {
        if (!cancelled) setWorktreeBranches(branches);
      })
      .catch(() => {
        if (!cancelled) setWorktreeBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedProject]);

  const getCreationLaunchTargets = (): LaunchTarget[] => {
    if (canLaunchMultiple && selectedLaunchTargets.length > 0) return selectedLaunchTargets;
    const presetId = effectiveSelectedPresetId ?? selectedPreset?.id;
    if (!presetId) return [];
    return [{ presetId, launchModeId: effectiveLaunchModeId }];
  };

  const buildCreateParamsForLaunchTargets = (
    baseParams: CreateWorkspaceParams,
    launchTargets: LaunchTarget[]
  ): CreateWorkspaceParams[] => {
    const params: CreateWorkspaceParams = {
      ...baseParams,
      ...(sourceWorkspaceId && { sourceWorkspaceId }),
      ...(attachments.length > 0 && { attachments }),
    };
    if (launchTargets.length === 0) {
      return [{ ...params, environment: effectiveEnvironment }];
    }
    // Reasoning levels are per preset, so they only apply to a single-agent launch.
    const isSingleAgentLaunch = !canLaunchMultiple || selectedLaunchTargets.length === 0;
    const reasoningLevelId =
      isSingleAgentLaunch && availableReasoningLevels.length > 0
        ? effectiveReasoningLevelId
        : undefined;
    return launchTargets.map((target) => ({
      ...params,
      presetId: target.presetId,
      launchModeId: target.launchModeId ?? undefined,
      reasoningLevelId,
      environment: effectiveEnvironment,
    }));
  };

  const finalizeCreate = async (
    paramsWithoutAction: CreateWorkspaceParams,
    actionUsage: { id: string; userInput?: string } | undefined,
    lastUsedProjectId?: string,
    undo?: LaunchUndo
  ) => {
    const createParams = withDefaultAction(paramsWithoutAction, actionUsage);
    const submittedPrompt = createParams.initialPrompt?.trim() ?? '';
    const onLaunch = prefillOnLaunchRef.current;
    useDialogsStore.getState().setNewWorkspaceDialogPrompt(submittedPrompt);
    // Kept, like the prompt, for the next open if the launch fails.
    useDialogsStore.getState().setNewWorkspaceDialogAttachments(createParams.attachments ?? []);
    try {
      const workspace = await createWorkspace(createParams);
      if (!workspace.provisionError) {
        useDialogsStore.getState().setNewWorkspaceDialogAttachments([]);
        onLaunch?.(createParams.presetId ? [createParams.presetId] : []);
        if (undo) offerUndo([workspace], undo);
        if (workspace.provisioning && submittedPrompt) {
          useDialogsStore
            .getState()
            .retainProvisioningWorkspacePrompt(workspace.id, submittedPrompt);
        } else {
          useDialogsStore.getState().clearNewWorkspaceDialogPrompt(submittedPrompt);
        }
      }
    } catch (err) {
      handleCreateError(
        err,
        () => void finalizeCreate(createParams, undefined, lastUsedProjectId, undo)
      );
    }
    if (actionUsage) {
      try {
        await recordActionUsage(actionUsage.id, actionUsage.userInput);
      } catch (error) {
        console.error('Failed to record action usage:', error);
      }
    }
    if (lastUsedProjectId) {
      void updateConfig({ lastUsedProjectId });
    }
  };

  const finalizeCreates = async (
    createParams: CreateWorkspaceParams[],
    actionUsage: { id: string; userInput?: string } | undefined,
    lastUsedProjectId?: string,
    undo?: LaunchUndo
  ): Promise<boolean> => {
    if (createParams.length === 1) {
      await finalizeCreate(createParams[0], actionUsage, lastUsedProjectId, undo);
      return true;
    }

    const submittedPrompt = createParams[0]?.initialPrompt?.trim() ?? '';
    const onLaunch = prefillOnLaunchRef.current;
    useDialogsStore.getState().setNewWorkspaceDialogPrompt(submittedPrompt);
    try {
      const workspaces = await createWorkspaces(
        createParams.map((params) => withDefaultAction(params, actionUsage))
      );
      onLaunch?.(
        createParams.flatMap((params, index) =>
          params.presetId && !workspaces[index]?.provisionError ? [params.presetId] : []
        )
      );
      const hasProvisionError = workspaces.some((workspace) => workspace.provisionError);
      if (!hasProvisionError) {
        workspaces.forEach((workspace) => {
          if (workspace.provisioning && submittedPrompt) {
            useDialogsStore
              .getState()
              .retainProvisioningWorkspacePrompt(workspace.id, submittedPrompt);
          }
        });
        useDialogsStore.getState().clearNewWorkspaceDialogPrompt(submittedPrompt);
        if (undo) offerUndo(workspaces, undo);
      }
    } catch (error) {
      // Retry like a fresh Launch, so the dialog blocks a second Launch while it runs.
      const retry = () => void submitCreates(createParams, actionUsage, lastUsedProjectId, undo);
      if (isRunningLimitError(error)) {
        showUpgradeDialog(retry, createParams.length);
      } else {
        handleCreateError(error, retry);
      }
      return false;
    }

    if (actionUsage) {
      try {
        await recordActionUsage(actionUsage.id, actionUsage.userInput);
      } catch (error) {
        console.error('Failed to record action usage:', error);
      }
    }
    if (lastUsedProjectId) {
      void updateConfig({ lastUsedProjectId });
    }
    return true;
  };

  // A single workspace closes the dialog right away; a batch keeps it open (with
  // Launch disabled) until creation settles so failures can be retried in place.
  const submitCreates = async (
    createParams: CreateWorkspaceParams[],
    actionUsage: { id: string; userInput?: string } | undefined,
    lastUsedProjectId?: string,
    undo?: LaunchUndo
  ) => {
    if (createParams.length === 1) {
      onOpenChange(false);
      resetForm();
      await finalizeCreates(createParams, actionUsage, lastUsedProjectId, undo);
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const created = await finalizeCreates(createParams, actionUsage, lastUsedProjectId, undo);
      if (created) {
        onOpenChange(false);
        resetForm();
      }
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const createWorkspaceWithPrompt = async (
    initialPromptContent?: string,
    actionUsage?: { id: string; userInput?: string }
  ) => {
    // The push would land after the new workspace fetched origin.
    if (isSubmittingRef.current || isPushingSourceBranch) return;
    setError(null);
    if (unpublishedSourceBranch?.missing) {
      setError(
        `Push ${unpublishedSourceBranch.branch} first, or pick another branch to start from.`
      );
      return;
    }
    const creationLaunchTargets = getCreationLaunchTargets();
    const undo = captureLaunchUndo();

    if (isSshLaunch) {
      const capturedHostId = effectiveSshHostId;
      const capturedProjectId = effectiveProjectId;
      const openingExistingBranch = branchMode === 'existing';
      const resolvedBranch = (openingExistingBranch ? existingBranch : effectiveBranchName).trim();
      const shouldGenerateBranchName =
        !openingExistingBranch && useAiBranchName && Boolean(initialPromptContent?.trim());
      const capturedBaseBranch = openingExistingBranch
        ? undefined
        : effectiveBaseBranch.trim() || undefined;

      if (!capturedHostId) {
        setError('Please select an SSH host');
        return;
      }
      if (!capturedProjectId || !selectedProject || selectedProject.kind === 'directory') {
        setError('Please select a git project');
        return;
      }
      if (!resolvedBranch && !shouldGenerateBranchName) {
        setError('Branch name is required');
        return;
      }
      const lastSlashIndex = resolvedBranch.lastIndexOf('/');
      const suffix =
        lastSlashIndex >= 0 ? resolvedBranch.slice(lastSlashIndex + 1) : resolvedBranch;
      const workspaceName = branchSuffixToName(suffix || generateBranchSuffix());
      const createParams = buildCreateParamsForLaunchTargets(
        {
          name: workspaceName,
          mode: 'worktree',
          projectId: capturedProjectId,
          branchName: shouldGenerateBranchName ? undefined : resolvedBranch,
          useExactBranchName: shouldGenerateBranchName ? undefined : true,
          autoResolveBranchConflicts: openingExistingBranch
            ? undefined
            : isBranchNameAutoGenerated || shouldGenerateBranchName,
          baseBranch: capturedBaseBranch,
          baseBranchOnHost:
            capturedBaseBranch && branchHostId === capturedHostId ? true : undefined,
          fetchRemote: openingExistingBranch && existingBranchIsRemote ? true : undefined,
          checkoutExistingBranch: openingExistingBranch || undefined,
          initialPrompt: initialPromptContent,
          deferBranchNaming: true,
          autoNameBranches: shouldGenerateBranchName || undefined,
          environment: { kind: 'ssh', hostId: capturedHostId },
        },
        creationLaunchTargets
      );
      await submitCreates(createParams, actionUsage, capturedProjectId, undo);
      return;
    }

    if (selectedProjectIsDirectory) {
      if (!effectiveProjectId) {
        setError('Please select a project');
        return;
      }
      const capturedProjectId = effectiveProjectId;
      onOpenChange(false);
      resetForm();
      await finalizeCreates(
        buildCreateParamsForLaunchTargets(
          {
            mode: 'directory',
            projectId: capturedProjectId,
            initialPrompt: initialPromptContent,
          },
          creationLaunchTargets
        ),
        actionUsage,
        capturedProjectId,
        undo
      );
      return;
    }

    // mode === 'worktree' from here on
    if (!effectiveProjectId) {
      setError('Please select a project');
      return;
    }

    if (branchMode === 'existing') {
      if (!existingBranch) {
        setError('Please select a branch');
        return;
      }
      const capturedProjectId = effectiveProjectId;
      const capturedExistingBranch = existingBranch;
      const capturedFetchRemote = existingBranchIsRemote || undefined;
      onOpenChange(false);
      resetForm();
      // Derive workspace name from the last part of the branch name (after the last slash)
      const lastSlashIndex = capturedExistingBranch.lastIndexOf('/');
      const suffix =
        lastSlashIndex >= 0
          ? capturedExistingBranch.slice(lastSlashIndex + 1)
          : capturedExistingBranch;
      const workspaceName = branchSuffixToName(suffix);
      await finalizeCreates(
        buildCreateParamsForLaunchTargets(
          {
            name: workspaceName,
            mode: 'worktree',
            branchName: capturedExistingBranch,
            projectId: capturedProjectId,
            useExactBranchName: true,
            initialPrompt: initialPromptContent,
            deferBranchNaming: true,
            fetchRemote: capturedFetchRemote,
            checkoutExistingBranch: true,
          },
          creationLaunchTargets
        ),
        actionUsage,
        capturedProjectId,
        undo
      );
      return;
    }

    // branchMode === 'new'
    const resolvedBranch = effectiveBranchName.trim();
    // Defer AI branch naming: close dialog immediately, generate in background
    if (useAiBranchName && initialPromptContent?.trim()) {
      const capturedProjectId = effectiveProjectId;
      const capturedBaseBranch = effectiveBaseBranch.trim() || undefined;
      const workspaceName = branchSuffixToName(resolvedBranch || generateBranchSuffix());
      const createParams = buildCreateParamsForLaunchTargets(
        {
          name: workspaceName,
          mode: 'worktree',
          projectId: capturedProjectId,
          autoResolveBranchConflicts: true,
          baseBranch: capturedBaseBranch,
          startFromOrigin: true,
          initialPrompt: initialPromptContent,
          deferBranchNaming: true,
          autoNameBranches: true,
        },
        creationLaunchTargets
      );
      await submitCreates(createParams, actionUsage, capturedProjectId, undo);
      return;
    }

    if (!resolvedBranch) {
      setError('Branch name is required');
      return;
    }
    if (worktreeBranches.includes(resolvedBranch) && !isBranchNameAutoGenerated) {
      setError(`Branch "${resolvedBranch}" is already checked out in another worktree`);
      return;
    }

    const capturedProjectId = effectiveProjectId;
    const capturedBaseBranch = effectiveBaseBranch.trim() || undefined;
    const capturedAutoResolve = isBranchNameAutoGenerated;
    // Derive workspace name from the last part of the branch name (after the last slash)
    const lastSlashIndex = resolvedBranch.lastIndexOf('/');
    const suffix = lastSlashIndex >= 0 ? resolvedBranch.slice(lastSlashIndex + 1) : resolvedBranch;
    const workspaceName = branchSuffixToName(suffix);
    const createParams = buildCreateParamsForLaunchTargets(
      {
        name: workspaceName,
        mode: 'worktree',
        branchName: resolvedBranch,
        projectId: capturedProjectId,
        useExactBranchName: true,
        autoResolveBranchConflicts: capturedAutoResolve || creationLaunchTargets.length > 1,
        baseBranch: capturedBaseBranch,
        startFromOrigin: true,
        initialPrompt: initialPromptContent,
        deferBranchNaming: true,
      },
      creationLaunchTargets
    );
    await submitCreates(createParams, actionUsage, capturedProjectId, undo);
  };

  const toggleInlineProjectForm = (show: boolean, path = '') => {
    setInlineProjectPath(path);
    setShowInlineProjectForm(show);
  };

  const handleOpenFolderWorkspace = async () => {
    setError(null);
    await pickFolder({
      onProject: (project) => selectProject(project.id),
      onAddProject: (path) => toggleInlineProjectForm(true, path),
      onFolder: openFolderWorkspace,
    });
  };

  const openFolderWorkspace = async (directoryPath: string) => {
    const prompt = initialPromptText.trim() || undefined;
    const selectedAction = actions.find((a) => a.id === actionId);
    onOpenChange(false);
    resetForm();
    await finalizeCreate(
      {
        mode: 'directory',
        directoryPath,
        initialPrompt: prompt,
        attachments: attachments.length > 0 ? attachments : undefined,
        launchModeId: effectiveLaunchModeId ?? undefined,
        reasoningLevelId:
          availableReasoningLevels.length > 0 ? effectiveReasoningLevelId : undefined,
        presetId: effectiveSelectedPresetId ?? undefined,
        // The folder is on this computer, even when an SSH host was picked.
        environment: isSshLaunch ? { kind: 'local' } : effectiveEnvironment,
      },
      selectedAction ? { id: selectedAction.id } : undefined
    );
  };

  // Keep ref in sync so stopVoiceAndTranscribe can call it without ordering issues
  submitWithPromptRef.current = (prompt: string) => {
    const trimmed = prompt.trim() || undefined;
    const selectedAction = actions.find((a) => a.id === actionId);
    void createWorkspaceWithPrompt(trimmed, selectedAction ? { id: selectedAction.id } : undefined);
  };

  const getProjectRepoPath = (): string | null => {
    if (!selectedProject) return null;
    return projectRepoPath(selectedProject);
  };

  const resolveTargetBranchForAction = async (): Promise<string | undefined> => {
    if (mode !== 'worktree' || !selectedProject || selectedProject.kind === 'directory') {
      return undefined;
    }

    if (branchMode === 'new') {
      if (effectiveBaseBranch.trim()) return effectiveBaseBranch.trim();
      if (selectedProject.baseBranch) return selectedProject.baseBranch;
    } else {
      if (selectedProject.baseBranch) return selectedProject.baseBranch;
    }

    const repoPath = getProjectRepoPath();
    if (!repoPath) return undefined;
    return await window.api.getMainBranch(repoPath);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Mic still opening — discard the pending start so a late-resolving
    // getUserMedia can't flip the dialog into "recording" after submission.
    // No audio yet, so we just submit normally with the current prompt.
    if (isVoiceStarting) {
      cancelVoiceRecording();
    }

    // Voice recording active: stop the mic, kick off transcription of whatever
    // was captured so far, and queue the submission so it fires from
    // onTranscription once the text arrives. Order matters — the wrapper
    // clears the queued-submit flag, so set it after the wrapper call.
    if (isVoiceRecording) {
      stopVoiceAndTranscribe();
      submitAfterTranscriptionRef.current = true;
      return;
    }

    // Transcription in flight (e.g. user clicks Launch after the mic stopped):
    // queue the submission so it fires from onTranscription with the
    // freshly-inserted text rather than racing against an empty prompt.
    if (isTranscribing) {
      submitAfterTranscriptionRef.current = true;
      return;
    }

    const prompt = initialPromptText.trim() || undefined;
    const selectedAction = actions.find((a) => a.id === actionId);

    await createWorkspaceWithPrompt(prompt, selectedAction ? { id: selectedAction.id } : undefined);
  };

  const captureLaunchUndo = (): LaunchUndo => ({
    draft: {
      prompt: initialPromptText,
      attachments,
      projectId: effectiveProjectId,
      branchMode,
      branchName: effectiveBranchName,
      isBranchNameAutoGenerated,
      existingBranch,
      existingBranchIsRemote,
      baseBranch: effectiveBaseBranch,
      branchHostId,
      launchTarget: effectiveLaunchTarget,
      sshHostId: effectiveSshHostId,
      actionId,
      presetId: effectiveSelectedPresetId ?? null,
      launchModeId: effectiveLaunchModeId,
      reasoningLevelOverrides,
      launchTargets: selectedLaunchTargets,
      aiBranchNameOverride,
      sourceWorkspaceId,
    },
    previousWorkspaceId: selectedWorkspaceId,
  });

  // Offers to take the launch back, on the new workspaces' sidebar rows, which also show
  // where it went. Without a row in sight, a toast names the project instead. Undo deletes
  // the new workspaces and reopens this dialog with the choices that made them.
  const offerUndo = (created: Workspace[], { draft, previousWorkspaceId }: LaunchUndo) => {
    const createdIds = new Set(created.map((workspace) => workspace.id));
    const undo = () => {
      // An existing branch can't be opened again until its worktree is gone, so that
      // draft comes back once every delete has settled; a new branch comes back at once.
      const waitForDeletes = draft.branchMode === 'existing';
      let unsettled = created.length;
      const reopen = () => openNewWorkspaceDialog({ prefill: { draft } });
      for (const workspace of created) {
        void deleteWorkspace(workspace.id, true, draft.branchMode === 'new', () => {
          unsettled -= 1;
          if (waitForDeletes && unsettled === 0) reopen();
        });
      }
      // Back to where the user was, unless they have moved on since.
      const { selectedWorkspaceId: current, workspaces: remaining } = useWorkspacesStore.getState();
      if (
        previousWorkspaceId &&
        (!current || createdIds.has(current)) &&
        remaining.some((workspace) => workspace.id === previousWorkspaceId)
      ) {
        void selectWorkspace(previousWorkspaceId);
      }
      if (!waitForDeletes) reopen();
    };
    const showToast = () => {
      const project = projects.find((p) => p.id === created[0]?.projectId);
      const place = project?.name ?? created[0]?.name ?? 'a new workspace';
      const message =
        created.length > 1
          ? `${created.length} workspaces created in ${place}`
          : `Workspace created in ${place}`;
      useToastStore.getState().addToast(message, 'success', {
        quiet: true,
        action: { label: 'Undo', onClick: undo },
      });
    };
    offerLaunchUndo([...createdIds], undo, showToast);
  };

  const restoreDraft = (draft: NewWorkspaceDialogDraft) => {
    prefillProjectConsumedRef.current = true;
    restoredDraftRef.current = true;
    skipBranchSyncRef.current = true;
    // The branch name already carries this project's prefix.
    previousProjectIdRef.current = draft.projectId;
    previousProjectPrefixRef.current = resolveBranchPrefix(
      projects.find((p) => p.id === draft.projectId),
      config?.gitDefaults
    );
    setProjectId(draft.projectId);
    setShowInlineProjectForm(false);
    setInitialPromptText(draft.prompt);
    setAttachments(draft.attachments);
    setBranchMode(draft.branchMode);
    setBranchName(draft.branchName);
    setIsBranchNameAutoGenerated(draft.isBranchNameAutoGenerated);
    setExistingBranch(draft.existingBranch);
    setExistingBranchIsRemote(draft.existingBranchIsRemote);
    setBaseBranch(draft.baseBranch);
    setBranchHostId(draft.branchHostId);
    setLaunchTarget(draft.launchTarget);
    setSshHostId(draft.sshHostId);
    setActionId(draft.actionId);
    setSelectedPresetId(draft.presetId);
    setLaunchModeId(draft.launchModeId);
    setReasoningLevelOverrides(draft.reasoningLevelOverrides);
    setSelectedLaunchTargets(draft.launchTargets);
    setAiBranchNameOverride(draft.aiBranchNameOverride);
    setSourceWorkspaceId(draft.sourceWorkspaceId);
  };

  const resetForm = () => {
    setMode('worktree');
    setBranchMode('new');
    setBranchName('');
    setIsBranchNameAutoGenerated(true);
    setExistingBranch('');
    setExistingBranchIsRemote(false);
    setBaseBranch('');
    setBranchHostId('');
    generatedBranchNameRef.current = '';
    setWorktreeBranches([]);
    setProjectId('');
    setLaunchTarget(undefined);
    setSshHostId('');
    setSourceWorkspaceId('');
    setIsPushingSourceBranch(false);
    setLocalOriginBranches(null);
    setActionId('');
    setError(null);
    setShowInlineProjectForm(false);
    setInlineProjectPath('');
    setProjectPickerOpen(false);
    setOpenMenu(null);
    setInitialPromptText('');
    setAttachments([]);
    setLaunchModeId(null);
    setReasoningLevelOverrides({});
    setSelectedLaunchTargets([]);
    setActionInputDialogOpen(false);
    setPendingActionForInput(null);
    setSlashMenuOpen(false);
    setSlashFilter('');
    setSlashMenuIndex(0);
    setSlashMenuNavigated(false);
    setAiBranchNameOverride(null);
    setSelectedPresetId(null);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Drop any in-flight transcription — it would otherwise resolve later
      // and write into the closed dialog's state.
      cancelVoiceTranscription();
      // When closing: save the prompt if it's not empty
      const {
        setNewWorkspaceDialogPrompt,
        setNewWorkspaceDialogAttachments,
        setNewWorkspaceDialogPrefill,
      } = useDialogsStore.getState();
      if (initialPromptText.trim()) {
        setNewWorkspaceDialogPrompt(initialPromptText);
      } else {
        setNewWorkspaceDialogPrompt('');
      }
      setNewWorkspaceDialogAttachments(attachments);
      // Drop any unconsumed prefill so a manual reopen starts clean.
      setNewWorkspaceDialogPrefill(null);
      resetForm();
    }
    onOpenChange(newOpen);
  };

  // An SSH host is added over this dialog and then picked for the workspace.
  const handleSetUpSshHost = () => {
    useSshHostDialogStore.getState().openAdd('new_workspace', {
      onAdded: (hostId) => handleEnvironmentChange({ kind: 'ssh', hostId }),
    });
  };

  const handleManageAgents = () => {
    handleOpenChange(false);
    useSettingsDialogStore.getState().openSettings({ tab: 'agent' });
  };

  const handleSelectBaseBranch = (branch: string, meta: BranchPickerMeta) => {
    setBaseBranch(qualifyRemoteOnlyBranch(branch, meta.isRemoteOnly));
    setBranchHostId(meta.onHost ? effectiveSshHostId : '');
  };

  const handleOpenExistingBranch = (branch: string, meta: BranchPickerMeta) => {
    setBranchMode('existing');
    setExistingBranch(branch);
    setExistingBranchIsRemote(meta.isRemoteOnly);
    setBaseBranch('');
    setBranchHostId(meta.onHost ? effectiveSshHostId : '');
    setSelectedLaunchTargets([]);
  };

  const switchToNewBranch = () => {
    setBranchMode('new');
    setExistingBranch('');
    setExistingBranchIsRemote(false);
  };

  // Branches belong to one repository, so another project starts a new branch
  // from its own default base, checked against its own worktrees once loaded.
  const selectProject = (id: string) => {
    setProjectId(id);
    if (id === effectiveProjectId) return;
    switchToNewBranch();
    setBaseBranch('');
    setWorktreeBranches([]);
  };

  const handleClearExistingBranch = () => {
    switchToNewBranch();
    if (!effectiveBranchName && selectedProject) {
      const newBranch = `${selectedProjectPrefix}${generateBranchSuffix()}`;
      setBranchName(newBranch);
      setIsBranchNameAutoGenerated(true);
      selectBranchSuffix(newBranch, selectedProjectPrefix);
    }
  };

  const findWorkspaceForBranch = (branch: string) => {
    for (let index = 0; index < branchWorkspaces.length; index += 3) {
      if (branchWorkspaces[index] === branch) {
        return { id: branchWorkspaces[index + 1], name: branchWorkspaces[index + 2] };
      }
    }
    return undefined;
  };

  const handleGoToWorkspace = (workspaceId: string) => {
    handleOpenChange(false);
    void selectWorkspace(workspaceId);
  };

  const handleReasoningLevelChange = (presetId: string, levelId: string | null) => {
    setReasoningLevelOverrides((current) => ({ ...current, [presetId]: levelId }));
  };

  // Auto-resize prompt textarea whenever content changes (typed or programmatic)
  useEffect(() => {
    const el = promptTextareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [initialPromptText]);

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInitialPromptText(value);

    // Slash command detection: open menu when text starts with "/"
    if (value.startsWith('/') && !value.includes('\n')) {
      setSlashFilter(value.slice(1));
      setSlashMenuIndex(0);
      setSlashMenuNavigated(false);
      setSlashMenuOpen(true);
    } else {
      setSlashMenuOpen(false);
    }
  };

  const attachFiles = (paths: string[]) => {
    setAttachments((current) => addPromptAttachments(current, paths));
  };

  const attachTransferFiles = (files: TransferFile[]) => {
    void readableFilePaths(files).then(attachFiles);
  };

  const handlePromptPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = getTransferFiles(e.clipboardData, window.api.getPathForFile);
    if (files.length > 0) {
      e.preventDefault();
      attachTransferFiles(files);
      return;
    }
    // Text wins, as in terminals: apps that copy both, like spreadsheets, mean the text.
    if (e.clipboardData.types.includes('text/plain') || !hasClipboardImage(e.clipboardData)) {
      return;
    }
    e.preventDefault();
    void window.api
      .stageClipboardImage()
      .then((path) => {
        if (path) attachFiles([path]);
      })
      .catch((err) => {
        console.warn('Failed to paste clipboard image:', err);
        useToastStore.getState().addToast('Couldn’t paste the image', 'error');
      });
  };

  const isDraggingFiles = useWindowFileDrop(open && hasAgent, (dataTransfer) => {
    attachTransferFiles(getTransferFiles(dataTransfer, window.api.getPathForFile));
    promptTextareaRef.current?.focus();
  });

  const handleLaunchModeChange = (modeId: string | null) => {
    setLaunchModeId(modeId);
    setSelectedLaunchTargets([]);
    void updateConfig({ defaultLaunchModeId: modeId ?? undefined });
    if (selectedPreset?.id) {
      void setActivePreset(selectedPreset.id, modeId);
    }
  };

  const handlePresetChange = (presetId: string) => {
    const preferredLaunchModeId = resolvePreferredLaunchModeId(presetId);
    setSelectedPresetId(presetId);
    void setActivePreset(presetId);
    setLaunchModeId(preferredLaunchModeId);
    setSelectedLaunchTargets([]);
  };

  const handleAgentLaunchChange = (presetId: string, modeId: string | null) => {
    setSelectedPresetId(presetId);
    setLaunchModeId(modeId);
    setSelectedLaunchTargets([]);
    void updateConfig({ defaultLaunchModeId: modeId ?? undefined });
    void setActivePreset(presetId, modeId);
  };

  const cycleLaunchMode = () => {
    const modeIds: (string | null)[] = [null, ...availableModes.map((m) => m.id)];
    const currentIndex = modeIds.indexOf(effectiveLaunchModeId);
    const nextIndex = (currentIndex + 1) % modeIds.length;
    handleLaunchModeChange(modeIds[nextIndex]);
  };

  const cyclePreset = () => {
    if (resolvedActivePresets.length < 2) return;
    const presetIds =
      presetCycleOrderRef.current.length === resolvedActivePresets.length
        ? presetCycleOrderRef.current
        : resolvedActivePresets.map((preset) => preset.id);
    const currentIndex = presetIds.indexOf(selectedPresetId ?? selectedPreset?.id ?? '');
    const nextIndex = (currentIndex + 1) % presetIds.length;
    handlePresetChange(presetIds[nextIndex]);
  };

  const handleSlashSelect = (action: (typeof actions)[number]) => {
    setSlashMenuOpen(false);
    setSlashFilter('');
    // Use the same flow as action selection from the dropdown
    setInitialPromptText('');
    void handleActionSelect(action.id);
  };

  // Returns true when the key was consumed by the slash menu (caller should stop).
  const handleSlashMenuKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slashMenuOpen || slashFilteredActions.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!slashMenuNavigated) {
        setSlashMenuNavigated(true);
        setSlashMenuIndex(0);
      } else {
        setSlashMenuIndex((i) => Math.min(i + 1, slashFilteredActions.length - 1));
      }
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!slashMenuNavigated) {
        setSlashMenuNavigated(true);
        setSlashMenuIndex(slashFilteredActions.length - 1);
      } else {
        setSlashMenuIndex((i) => Math.max(i - 1, 0));
      }
      return true;
    }
    if (e.key === 'Enter' && slashMenuNavigated) {
      e.preventDefault();
      handleSlashSelect(slashFilteredActions[slashMenuIndex]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setSlashMenuOpen(false);
      return true;
    }
    return false;
  };

  const handlePromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Voice mic still opening: no audio yet — discard the pending start and
    // submit normally so the keystroke isn't swallowed (matches handleSubmit's
    // click-path behavior).
    if (e.key === 'Enter' && !e.shiftKey && isVoiceStarting) {
      e.preventDefault();
      cancelVoiceRecording();
      e.currentTarget.form?.requestSubmit();
      return;
    }

    // Voice recording: Enter stops recording and transcribes
    if (e.key === 'Enter' && !e.shiftKey && isVoiceRecording) {
      e.preventDefault();
      stopVoiceAndTranscribe();
      return;
    }

    // Transcription in flight: queue the submit so it fires from
    // onTranscription with the freshly-inserted text rather than racing
    // against an empty initialPromptText.
    if (e.key === 'Enter' && !e.shiftKey && isTranscribing) {
      e.preventDefault();
      submitAfterTranscriptionRef.current = true;
      return;
    }

    // Voice recording: Escape stops recording (or pending mic open) on first press
    if (e.key === 'Escape' && (isVoiceStarting || isVoiceRecording)) {
      e.preventDefault();
      cancelVoiceRecording();
      return;
    }

    // Voice recording: typing cancels recording silently, so the user can
    // switch from speaking to typing. Keys that only move the cursor don't.
    // Excludes the dialog's own and project shortcuts so the user can adjust
    // those mid-recording without aborting the mic.
    const isCommand = e.ctrlKey || e.metaKey;
    const editsText =
      (e.key.length === 1 && !isCommand) ||
      e.key === 'Backspace' ||
      e.key === 'Delete' ||
      (isCommand && ['v', 'x', 'z'].includes(e.key.toLowerCase()));
    if (
      (isVoiceStarting || isVoiceRecording) &&
      editsText &&
      getNewWorkspaceDialogAction(e) === null &&
      getProjectShortcutIndex(e) === null &&
      !isNewWorkspaceShortcut(e.nativeEvent)
    ) {
      cancelVoiceRecording();
      // Don't return — let the keystroke go through to the textarea
    }

    if (handleSlashMenuKey(e)) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };

  const showContextBar = projects.length > 0 && !showInlineProjectForm;
  const showAgentLaunchPicker = showPresetPicker || (hasAgent && availableModes.length > 0);
  const showReasoningLevelPill =
    hasAgent && selectedLaunchTargets.length === 0 && availableReasoningLevels.length > 0;
  const showBranchPicker =
    showContextBar && Boolean(selectedProject) && !selectedProjectIsDirectory && !existingBranch;
  const environmentOptions: DesiredWorkspaceEnvironment[] = [
    { kind: 'local' },
    ...sshHosts.map((host) => ({ kind: 'ssh' as const, hostId: host.id })),
  ];
  const menuShown: Record<NewWorkspaceMenu, boolean> = {
    agent: showAgentLaunchPicker,
    effort: showReasoningLevelPill,
    environment: showContextBar,
    branch: showBranchPicker,
  };
  // A menu whose control goes away while open would reopen when it comes back.
  if (openMenu && !menuShown[openMenu]) setOpenMenu(null);

  // Focus leaving an open menu also closes it, such as a branch picker that
  // still lists the previous project's branches.
  const pickProject = (project: Project) => {
    selectProject(project.id);
    setProjectPickerOpen(false);
    (promptTextareaRef.current ?? branchInputRef.current ?? projectTriggerRef.current)?.focus();
  };

  const cycleReasoningLevel = () => {
    if (!selectedPreset) return;
    const levelIds = [null, ...availableReasoningLevels.map((level) => level.id)];
    const nextIndex = (levelIds.indexOf(effectiveReasoningLevelId) + 1) % levelIds.length;
    handleReasoningLevelChange(selectedPreset.id, levelIds[nextIndex]);
  };

  const cycleEnvironment = () => {
    const keys = environmentOptions.map(environmentKey);
    const nextIndex = (keys.indexOf(environmentKey(effectiveEnvironment)) + 1) % keys.length;
    handleEnvironmentChange(environmentOptions[nextIndex]);
  };

  // Clicking one menu while another is open may open it before the other closes.
  const handleMenuOpenChange = (menu: NewWorkspaceMenu, isOpen: boolean) =>
    setOpenMenu((current) => (isOpen ? menu : current === menu ? null : current));

  // Closing the agent menu this way skips its own close handling, so a single
  // ticked agent is picked here, as closing it by hand would.
  const closeAgentMenu = () => {
    if (openMenu !== 'agent' || selectedLaunchTargets.length !== 1) return;
    const [target] = selectedLaunchTargets;
    handleAgentLaunchChange(target.presetId, target.launchModeId);
  };

  const openDialogMenu = (menu: NewWorkspaceMenu) => {
    if (menu !== 'agent') closeAgentMenu();
    setProjectPickerOpen(false);
    setOpenMenu(menu);
  };

  // Runs a dialog shortcut, returning false where its control isn't shown.
  const runDialogAction = (action: NewWorkspaceDialogAction): boolean => {
    switch (action) {
      case 'cycleAgent':
        if (!showPresetPicker) return false;
        shouldRefocusPrompt.current = true;
        cyclePreset();
        return true;
      case 'cycleLaunchMode':
        if (availableModes.length === 0) return false;
        shouldRefocusPrompt.current = true;
        cycleLaunchMode();
        return true;
      case 'cycleEffort':
        if (!showReasoningLevelPill) return false;
        cycleReasoningLevel();
        return true;
      case 'cycleProject': {
        if (!showContextBar || projects.length < 2) return false;
        const index = projects.findIndex((project) => project.id === effectiveProjectId);
        pickProject(projects[(index + 1) % projects.length]);
        return true;
      }
      case 'cycleEnvironment':
        if (!showContextBar || environmentOptions.length < 2) return false;
        cycleEnvironment();
        return true;
      case 'agentMenu':
        if (!showAgentLaunchPicker) return false;
        openDialogMenu('agent');
        return true;
      case 'effortMenu':
        if (!showReasoningLevelPill) return false;
        openDialogMenu('effort');
        return true;
      case 'environmentMenu':
        if (!showContextBar) return false;
        // With a single alternative to Local, the segment switches instead of opening a menu.
        if (environmentOptions.length === 2) cycleEnvironment();
        else openDialogMenu('environment');
        return true;
      case 'branchMenu':
        if (!showBranchPicker) return false;
        openDialogMenu('branch');
        return true;
      case 'projectSearch':
        if (!showContextBar) return false;
        closeAgentMenu();
        setOpenMenu(null);
        setProjectPickerOpen(true);
        return true;
    }
  };

  const handleCustomizeShortcuts = () => {
    handleOpenChange(false);
    useSettingsDialogStore
      .getState()
      .openSettings({ tab: 'shortcuts', card: NEW_WORKSPACE_SHORTCUTS_GROUP });
  };

  // Cmd/Ctrl+1…9 picks a project in the order the project dropdown lists them,
  // and the New workspace shortcut, pressed again, opens the project search.
  // Handled on the dialog content so focused buttons and portalled menus are
  // covered too, and claimed so app-wide workspace shortcuts never act behind
  // the open dialog.
  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dialogAction = getNewWorkspaceDialogAction(e);
    if (dialogAction && (!movesFocus(e) || e.target === promptTextareaRef.current)) {
      // Claimed even where the control is hidden, so the keys never act behind the dialog.
      claimShortcutEvent(e.nativeEvent);
      if (runDialogAction(dialogAction)) {
        e.preventDefault();
        return;
      }
    }

    if (isNewWorkspaceShortcut(e.nativeEvent)) {
      e.preventDefault();
      claimShortcutEvent(e.nativeEvent);
      if (showContextBar) setProjectPickerOpen(true);
      return;
    }

    const projectIndex = getProjectShortcutIndex(e);
    if (projectIndex === null) return;
    e.preventDefault();
    claimShortcutEvent(e.nativeEvent);
    const project = showContextBar ? projects[projectIndex] : undefined;
    if (project) pickProject(project);
  };

  const handleActionSelect = async (selectedId: string) => {
    setActionId(selectedId);
    if (!selectedId) return;

    const action = actions.find((a) => a.id === selectedId);
    if (!action) return;

    if (actionNeedsInjection(action.content)) {
      // Show input dialog for actions with {{user_input}}
      setPendingActionForInput(action);
      setActionInputDialogOpen(true);
      return;
    }

    // Resolve action and fill the textarea
    const targetBranch = action.content.includes(ACTION_TARGET_BRANCH_TOKEN)
      ? await resolveTargetBranchForAction()
      : undefined;
    const resolved = injectActionContext(action.content, { targetBranch });
    setInitialPromptText(resolved);

    // Re-focus the textarea so the user can edit or hit Enter
    setTimeout(() => promptTextareaRef.current?.focus(), 0);
  };

  const handleActionInputConfirm = async (input: string) => {
    if (!pendingActionForInput) return;

    const action = pendingActionForInput;
    setPendingActionForInput(null);
    setActionInputDialogOpen(false);

    const targetBranch = action.content.includes(ACTION_TARGET_BRANCH_TOKEN)
      ? await resolveTargetBranchForAction()
      : undefined;
    const resolved = injectActionContext(action.content, { userInput: input, targetBranch });
    setInitialPromptText(resolved);

    setTimeout(() => promptTextareaRef.current?.focus(), 0);
  };

  const handleActionInputCancel = () => {
    setActionInputDialogOpen(false);
    setPendingActionForInput(null);
    setActionId('');
  };

  // Resolve a prefill actionId once the actions list has loaded — runs the same
  // path as a manual action pick so token injection (e.g. {{user_input}}) is
  // honored.
  useEffect(() => {
    if (!open) return;
    const pendingId = pendingPrefillActionIdRef.current;
    if (!pendingId) return;
    if (actions.length === 0) return;
    if (!actions.some((a) => a.id === pendingId)) {
      pendingPrefillActionIdRef.current = null;
      return;
    }
    pendingPrefillActionIdRef.current = null;
    void handleActionSelect(pendingId);
  }, [open, actions]); // oxlint-disable-line react/exhaustive-deps

  const contextProject = isSshLaunch && selectedProjectIsDirectory ? undefined : selectedProject;
  // A new branch from the target starts from freshly fetched origin, unless the
  // local target has unpushed commits; only then does it start behind origin.
  const targetBranch = projectMainBranch;
  const staleTarget =
    targetBranch &&
    branchMode === 'new' &&
    (!effectiveBaseBranch || effectiveBaseBranch === targetBranch) &&
    projectAheadRemote > 0 &&
    projectBehindRemote > 0
      ? { branch: targetBranch, unpushed: projectAheadRemote, behind: projectBehindRemote }
      : undefined;
  const detectedMainBranch = useDetectedMainBranch(selectedProject, open);
  const baseBranchLabel =
    effectiveBaseBranch || selectedProject?.baseBranch || detectedMainBranch || 'default branch';

  return (
    <>
      <ActionInputDialog
        open={actionInputDialogOpen}
        actionTitle={pendingActionForInput?.title || 'Quick command'}
        actionContent={pendingActionForInput?.content || ''}
        lastInput={pendingActionForInput?.lastUserInput}
        onCancel={handleActionInputCancel}
        onConfirm={handleActionInputConfirm}
        confirmLabel="Insert"
      />
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="!top-[max(3rem,calc(50vh-12rem))] !max-w-xl !translate-y-0 !gap-0 !overflow-visible !border-0 !bg-transparent !p-0 !shadow-none !ring-0"
          showCloseButton={false}
          floating={false}
          onKeyDown={handleDialogKeyDown}
        >
          <HeaderToolbar
            hasAgent={hasAgent}
            isVoiceRecording={isVoiceRecording}
            isVoiceStarting={isVoiceStarting}
            isTranscribing={isTranscribing}
            audioLevels={audioLevels}
            recordingDuration={recordingDuration}
            recordingRemainingSeconds={recordingRemainingSeconds}
            voiceAutoRecord={voiceAutoRecord}
            onVoiceAutoRecordChange={setVoiceAutoRecord}
            onStartRecording={() => {
              autoStartedRecordingRef.current = false;
              startVoiceRecording();
              // Enter, Esc and typing control dictation from the prompt.
              promptTextareaRef.current?.focus();
            }}
            onStopRecording={stopVoiceAndTranscribe}
            onCancelRecording={cancelVoiceRecording}
            onCancelTranscription={cancelVoiceTranscription}
            onCloseDialog={() => handleOpenChange(false)}
            promptTextareaRef={promptTextareaRef}
          />
          <DialogTitle className="sr-only">Create Workspace</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new workspace with an optional initial prompt
          </DialogDescription>

          <form className="min-w-0" onSubmit={handleSubmit}>
            <div className="floating-surface relative rounded-lg border shadow-xl">
              {isDraggingFiles && <DropToAttachOverlay />}
              {showContextBar && (
                <div className="flex min-w-0 px-4 pt-2.5">
                  <NewWorkspaceProjectPicker
                    projects={projects}
                    projectId={effectiveProjectId}
                    setProjectId={selectProject}
                    selectedProject={contextProject}
                    projectPickerOpen={projectPickerOpen}
                    onProjectPickerOpenChange={setProjectPickerOpen}
                    onAddProject={() => toggleInlineProjectForm(true)}
                    onOpenFolderWorkspace={handleOpenFolderWorkspace}
                    flash={
                      !!contextProject &&
                      !!activeWorkspaceProject &&
                      activeWorkspaceProject.id !== contextProject.id
                    }
                    projectTriggerRef={projectTriggerRef}
                    promptTextareaRef={promptTextareaRef}
                    branchInputRef={branchInputRef}
                  />
                </div>
              )}
              {hasAgent && (
                <PromptArea
                  showLabel={!showContextBar}
                  promptlessAgentName={
                    selectedPreset && !canStartWithPrompt(selectedPreset)
                      ? selectedPreset.name
                      : undefined
                  }
                  initialPromptText={initialPromptText}
                  onPromptChange={handlePromptChange}
                  onPromptKeyDown={handlePromptKeyDown}
                  onPromptPaste={handlePromptPaste}
                  attachments={attachments}
                  onRemoveAttachment={(path) =>
                    setAttachments((current) => current.filter((p) => p !== path))
                  }
                  onCloseSlashMenu={() => setSlashMenuOpen(false)}
                  promptTextareaRef={promptTextareaRef}
                  actions={actions}
                  actionId={actionId}
                  onActionSelect={handleActionSelect}
                  onOpenActionsSettings={() => {
                    onOpenChange(false);
                    window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }));
                  }}
                  slashMenuOpen={slashMenuOpen}
                  slashFilteredActions={slashFilteredActions}
                  slashMenuRef={slashMenuRef}
                  slashMenuIndex={slashMenuIndex}
                  slashMenuNavigated={slashMenuNavigated}
                  setSlashMenuIndex={setSlashMenuIndex}
                  setSlashMenuNavigated={setSlashMenuNavigated}
                  onSlashSelect={handleSlashSelect}
                />
              )}
              {!hasAgent && !showPresetPicker && (
                <NoAgentNotice
                  onSetUpAgent={() => {
                    onOpenChange(false);
                    useSettingsDialogStore.getState().openSettings({ tab: 'agent' });
                  }}
                />
              )}

              <ConfigSection
                projects={projects}
                setProjectId={selectProject}
                selectedProject={contextProject}
                showInlineProjectForm={showInlineProjectForm}
                inlineProjectPath={inlineProjectPath}
                setShowInlineProjectForm={toggleInlineProjectForm}
                staleTarget={staleTarget}
                unpublishedSourceBranch={unpublishedSourceBranch}
                isPushingSourceBranch={isPushingSourceBranch}
                onPushSourceBranch={handlePushSourceBranch}
                onOpenFolderWorkspace={handleOpenFolderWorkspace}
                isSshLaunch={isSshLaunch}
                error={error}
              />

              <FooterSection
                hasAgent={hasAgent}
                launchModeId={effectiveLaunchModeId}
                selectedPreset={selectedPreset ?? undefined}
                getReasoningLevelId={getReasoningLevelId}
                onReasoningLevelChange={handleReasoningLevelChange}
                promptTextareaRef={promptTextareaRef}
                resolvedActivePresets={resolvedActivePresets}
                multiLaunchPresets={multiLaunchPresets}
                selectedPresetId={effectiveSelectedPresetId}
                getPreferredLaunchModeId={resolvePreferredLaunchModeId}
                onAgentLaunchChange={handleAgentLaunchChange}
                selectedLaunchTargets={selectedLaunchTargets}
                onLaunchTargetsChange={setSelectedLaunchTargets}
                canLaunchMultiple={canLaunchMultiple}
                onManageAgents={handleManageAgents}
                onCustomizeShortcuts={handleCustomizeShortcuts}
                isSubmitting={isSubmitting}
                launchBlocked={isPushingSourceBranch}
                showAgentLaunchPicker={showAgentLaunchPicker}
                openMenu={openMenu}
                onMenuOpenChange={handleMenuOpenChange}
              />
            </div>

            {showContextBar && (
              <NewWorkspaceContextBar
                selectedProject={contextProject}
                openMenu={openMenu}
                onMenuOpenChange={handleMenuOpenChange}
                environment={{
                  launchTarget: effectiveLaunchTarget,
                  onEnvironmentChange: handleEnvironmentChange,
                  sshHosts,
                  selectedSshHost,
                  onSetUpSshHost: handleSetUpSshHost,
                }}
                repoPath={getProjectRepoPath() ?? ''}
                baseBranch={effectiveBaseBranch}
                baseBranchLabel={baseBranchLabel}
                setBaseBranch={handleSelectBaseBranch}
                existingBranch={existingBranch}
                openExistingBranch={handleOpenExistingBranch}
                clearExistingBranch={handleClearExistingBranch}
                usedBranches={effectiveWorktreeBranches}
                findWorkspaceForBranch={findWorkspaceForBranch}
                onGoToWorkspace={handleGoToWorkspace}
                branchName={effectiveBranchName}
                setBranchName={setBranchName}
                setIsBranchNameAutoGenerated={setIsBranchNameAutoGenerated}
                useAiBranchName={useAiBranchName}
                setUseAiBranchName={setAiBranchNameOverride}
                toggleAiBranchName={toggleAiBranchName}
                showAiToggle={hasAgent}
                initialPromptText={initialPromptText}
                branchInputRef={branchInputRef}
                projectTriggerRef={projectTriggerRef}
                promptTextareaRef={promptTextareaRef}
              />
            )}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface HeaderToolbarProps {
  hasAgent: boolean;
  isVoiceRecording: boolean;
  isVoiceStarting: boolean;
  isTranscribing: boolean;
  audioLevels: LevelHistory;
  recordingDuration: number;
  recordingRemainingSeconds: number | null;
  voiceAutoRecord: boolean;
  onVoiceAutoRecordChange: (autoRecord: boolean) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onCancelTranscription: () => void;
  onCloseDialog: () => void;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

function HeaderToolbar({
  hasAgent,
  isVoiceRecording,
  isVoiceStarting,
  isTranscribing,
  audioLevels,
  recordingDuration,
  recordingRemainingSeconds,
  voiceAutoRecord,
  onVoiceAutoRecordChange,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onCancelTranscription,
  onCloseDialog,
  promptTextareaRef,
}: HeaderToolbarProps) {
  if (!hasAgent) return null;
  const openVoiceSettings = () => {
    onCloseDialog();
    window.dispatchEvent(new CustomEvent('open-settings', { detail: 'voice' }));
  };
  return (
    <div className="floating-controls absolute -top-8 right-0 z-10 flex items-center gap-1.5 rounded-lg border px-1 py-0.5 light:shadow-soft">
      <VoiceRecordingIndicator
        isRecording={isVoiceRecording}
        isStarting={isVoiceStarting}
        isTranscribing={isTranscribing}
        levels={audioLevels}
        onStartRecording={onStartRecording}
        onStopRecording={onStopRecording}
        onCancelRecording={onCancelRecording}
        onCancelTranscription={onCancelTranscription}
        onNavigateToSettings={openVoiceSettings}
        duration={recordingDuration}
        remainingSeconds={recordingRemainingSeconds}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label="Voice options"
            className="-ml-1 size-auto p-0.5 text-muted-foreground/60 hover:bg-border/50 hover:text-muted-foreground"
          >
            <CaretDown className="size-3" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => focusPromptOnMenuClose(e, promptTextareaRef.current)}
        >
          <DropdownMenuCheckboxItem
            checked={voiceAutoRecord}
            onCheckedChange={onVoiceAutoRecordChange}
          >
            Auto-record on open
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openVoiceSettings}>Voice settings…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Shown in place of the prompt when there is no agent to prompt.
function NoAgentNotice({ onSetUpAgent }: { onSetUpAgent: () => void }) {
  return (
    <p className="px-4 pt-3 text-xs text-muted-foreground">
      No agent configured — workspaces open a plain shell.{' '}
      <button
        type="button"
        onClick={onSetUpAgent}
        className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        Set up an agent →
      </button>
    </p>
  );
}

interface PromptAreaProps {
  initialPromptText: string;
  onPromptChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onPromptKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPromptPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  attachments: string[];
  onRemoveAttachment: (path: string) => void;
  onCloseSlashMenu: () => void;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  actions: Action[];
  actionId: string;
  onActionSelect: (id: string) => void | Promise<void>;
  onOpenActionsSettings: () => void;
  slashMenuOpen: boolean;
  slashFilteredActions: Action[];
  slashMenuRef: React.RefObject<HTMLDivElement | null>;
  slashMenuIndex: number;
  slashMenuNavigated: boolean;
  setSlashMenuIndex: (i: number) => void;
  setSlashMenuNavigated: (v: boolean) => void;
  onSlashSelect: (action: Action) => void;
  /** Off while the project picker heads the composer */
  showLabel: boolean;
  /** The selected agent, when it can't start with a prompt */
  promptlessAgentName?: string;
}

function PromptArea({
  showLabel,
  promptlessAgentName,
  initialPromptText,
  onPromptChange,
  onPromptKeyDown,
  onPromptPaste,
  attachments,
  onRemoveAttachment,
  onCloseSlashMenu,
  promptTextareaRef,
  actions,
  actionId,
  onActionSelect,
  onOpenActionsSettings,
  slashMenuOpen,
  slashFilteredActions,
  slashMenuRef,
  slashMenuIndex,
  slashMenuNavigated,
  setSlashMenuIndex,
  setSlashMenuNavigated,
  onSlashSelect,
}: PromptAreaProps) {
  const promptActions = actions.filter((a) => a.type !== 'command');
  const closeSlashMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeSlashMenuTimerRef.current) {
        clearTimeout(closeSlashMenuTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      {showLabel && (
        <div className="flex items-center justify-between px-4 pt-3">
          <label htmlFor="new-workspace-prompt" className="text-xs text-muted-foreground">
            Prompt
          </label>
        </div>
      )}
      <div className="relative px-4 pt-1 pb-3">
        <div className="flex items-start gap-2">
          <textarea
            id="new-workspace-prompt"
            aria-label="Prompt"
            ref={promptTextareaRef}
            value={initialPromptText}
            onChange={onPromptChange}
            onKeyDown={onPromptKeyDown}
            onPaste={onPromptPaste}
            onBlur={() => {
              // Delay to allow mouseDown on slash menu items to fire first
              if (closeSlashMenuTimerRef.current) {
                clearTimeout(closeSlashMenuTimerRef.current);
              }
              closeSlashMenuTimerRef.current = setTimeout(() => {
                closeSlashMenuTimerRef.current = null;
                onCloseSlashMenu();
              }, 150);
            }}
            placeholder={
              promptlessAgentName
                ? `${promptlessAgentName} can't start with a prompt, so it opens without one`
                : 'What should the agent work on? (optional)'
            }
            className="max-h-[200px] min-h-[40px] flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-relaxed outline-hidden placeholder:text-muted-foreground/60 disabled:opacity-50"
            rows={1}
            autoFocus
          />
          {promptActions.length > 0 && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label="Quick Commands"
                  size="xs"
                  tooltipSide="bottom"
                  className={cn(
                    'mt-1.5 rounded-md',
                    actionId
                      ? 'bg-muted/50 text-foreground'
                      : 'text-muted-foreground/60 hover:bg-muted/30 hover:text-muted-foreground'
                  )}
                >
                  <NotePencil className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(e) => focusPromptOnMenuClose(e, promptTextareaRef.current)}
              >
                {actionId && (
                  <>
                    <DropdownMenuItem onSelect={() => onActionSelect('')}>None</DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <Sparkle className="size-3" />
                  Saved Prompts
                </DropdownMenuLabel>
                {promptActions.map((a) => (
                  <DropdownMenuItem key={a.id} onSelect={() => onActionSelect(a.id)}>
                    <Sparkle />
                    {a.title}
                    {a.id === actionId && <Check className="ml-auto" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onOpenActionsSettings}
                  className="text-muted-foreground"
                >
                  Manage Quick Commands…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <PromptAttachmentList attachments={attachments} onRemove={onRemoveAttachment} />

        {slashMenuOpen && slashFilteredActions.length > 0 && (
          <div
            ref={slashMenuRef}
            className="floating-surface absolute top-full right-2 left-2 z-50 mt-1 max-h-[200px] overflow-y-auto rounded-md border py-1 shadow-xl"
          >
            {slashFilteredActions.map((a, i) => (
              <button
                key={a.id}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  i === slashMenuIndex && slashMenuNavigated
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-muted/50'
                }`}
                onMouseEnter={() => {
                  setSlashMenuIndex(i);
                  setSlashMenuNavigated(true);
                }}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focused
                  onSlashSelect(a);
                }}
              >
                <Sparkle className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{a.title}</span>
                <span className="ml-auto max-w-[180px] truncate text-2xs text-muted-foreground/60">
                  {a.content.slice(0, 60)}
                  {a.content.length > 60 ? '…' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

interface ConfigSectionProps {
  projects: Project[];
  setProjectId: (id: string) => void;
  selectedProject: Project | undefined;
  showInlineProjectForm: boolean;
  inlineProjectPath: string;
  setShowInlineProjectForm: (v: boolean) => void;
  /** Set when a new branch starts from a local target that is behind origin */
  staleTarget: { branch: string; unpushed: number; behind: number } | undefined;
  /** Set when the branch to start from must come from origin, which lacks it or some commits */
  unpublishedSourceBranch: UnpublishedSourceBranch | undefined;
  isPushingSourceBranch: boolean;
  onPushSourceBranch: () => void;
  onOpenFolderWorkspace: () => void;
  isSshLaunch: boolean;
  error: string | null;
}

/** Where a source workspace's branch is, and how much of it origin has for another machine. */
interface UnpublishedSourceBranch {
  branch: string;
  /** Origin doesn't have the branch at all. */
  missing: boolean;
  unpushed: number;
  /** Where the branch is, and where the new workspace starts. */
  source: string;
  target: string;
}

const countCommits = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// Project setup, sync and error notices shown inside the composer when needed.
// Project, environment and branch choices live in NewWorkspaceContextBar.
function ConfigSection({
  projects,
  setProjectId,
  selectedProject,
  showInlineProjectForm,
  inlineProjectPath,
  setShowInlineProjectForm,
  staleTarget,
  unpublishedSourceBranch,
  isPushingSourceBranch,
  onPushSourceBranch,
  onOpenFolderWorkspace,
  isSshLaunch,
  error,
}: ConfigSectionProps) {
  const showEmptyState = projects.length === 0 && !showInlineProjectForm;
  const showSyncWarning =
    !showInlineProjectForm &&
    !isSshLaunch &&
    selectedProject?.kind !== 'directory' &&
    Boolean(selectedProject?.managed) &&
    staleTarget !== undefined;
  if (
    !showEmptyState &&
    !showInlineProjectForm &&
    !showSyncWarning &&
    !unpublishedSourceBranch &&
    !error
  ) {
    return null;
  }

  return (
    <div className="space-y-3 px-4 py-3">
      {showEmptyState && (
        <EmptyState
          icon={<Folder weight="duotone" />}
          title="No projects yet"
          className="rounded-md bg-muted/30 p-4"
          action={
            <>
              <Button type="button" size="sm" onClick={() => setShowInlineProjectForm(true)}>
                <Plus className="mr-1.5 size-3.5" />
                Add Project
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onOpenFolderWorkspace}>
                <FolderOpen className="mr-1.5 size-3.5" />
                Open Folder
              </Button>
            </>
          }
        />
      )}

      {showInlineProjectForm && (
        <ProjectCreationForm
          key={inlineProjectPath}
          compact
          initialPath={inlineProjectPath || undefined}
          onSuccess={(project) => {
            setProjectId(project.id);
            setShowInlineProjectForm(false);
          }}
          onCancel={() => setShowInlineProjectForm(false)}
        />
      )}

      {showSyncWarning && (
        <Callout tone="warning" className="items-center">
          {staleTarget.branch} has {countCommits(staleTarget.unpushed, 'unpushed commit')}, so this
          workspace starts from local {staleTarget.branch},{' '}
          {countCommits(staleTarget.behind, 'commit')} behind origin
        </Callout>
      )}

      {unpublishedSourceBranch && (
        <Callout
          tone="warning"
          className="items-center"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onPushSourceBranch}
              disabled={isPushingSourceBranch}
            >
              {isPushingSourceBranch && <Spinner size="sm" />}
              Push
            </Button>
          }
        >
          {unpublishedSourceBranch.missing
            ? `${unpublishedSourceBranch.branch} is only on ${unpublishedSourceBranch.source}. Push it to origin so ${unpublishedSourceBranch.target} can start from it.`
            : `${unpublishedSourceBranch.branch} has ${countCommits(unpublishedSourceBranch.unpushed, 'unpushed commit')} on ${unpublishedSourceBranch.source}, so ${unpublishedSourceBranch.target} starts without them.`}
        </Callout>
      )}

      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
    </div>
  );
}

interface FooterSectionProps {
  hasAgent: boolean;
  launchModeId: string | null;
  selectedPreset: AgentPreset | undefined;
  getReasoningLevelId: (presetId: string) => string | null;
  onReasoningLevelChange: (presetId: string, levelId: string | null) => void;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  resolvedActivePresets: AgentPreset[];
  multiLaunchPresets: AgentPreset[];
  selectedPresetId: string | null;
  getPreferredLaunchModeId: (presetId: string) => string | null;
  onAgentLaunchChange: (presetId: string, launchModeId: string | null) => void;
  selectedLaunchTargets: LaunchTarget[];
  onLaunchTargetsChange: (targets: LaunchTarget[]) => void;
  canLaunchMultiple: boolean;
  onManageAgents: () => void;
  onCustomizeShortcuts: () => void;
  isSubmitting: boolean;
  /** Launch waits, e.g. while the branch it starts from is being pushed. */
  launchBlocked: boolean;
  showAgentLaunchPicker: boolean;
  openMenu: NewWorkspaceMenu | null;
  onMenuOpenChange: (menu: NewWorkspaceMenu, open: boolean) => void;
}

function FooterSection({
  hasAgent,
  launchModeId,
  selectedPreset,
  getReasoningLevelId,
  onReasoningLevelChange,
  promptTextareaRef,
  resolvedActivePresets,
  multiLaunchPresets,
  selectedPresetId,
  getPreferredLaunchModeId,
  onAgentLaunchChange,
  selectedLaunchTargets,
  onLaunchTargetsChange,
  canLaunchMultiple,
  onManageAgents,
  onCustomizeShortcuts,
  isSubmitting,
  launchBlocked,
  showAgentLaunchPicker,
  openMenu,
  onMenuOpenChange,
}: FooterSectionProps) {
  const menuOpenChange = (menu: NewWorkspaceMenu) => (open: boolean) =>
    onMenuOpenChange(menu, open);

  return (
    <div className="flex items-center justify-end gap-2 px-2.5 pt-1 pb-2.5">
      <span className="mr-auto flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
        {showAgentLaunchPicker && (
          <AgentLaunchPickerPill
            resolvedActivePresets={resolvedActivePresets}
            multiLaunchPresets={multiLaunchPresets}
            selectedPresetId={selectedPresetId}
            launchModeId={launchModeId}
            getPreferredLaunchModeId={getPreferredLaunchModeId}
            onAgentLaunchChange={onAgentLaunchChange}
            selectedLaunchTargets={selectedLaunchTargets}
            onLaunchTargetsChange={onLaunchTargetsChange}
            canLaunchMultiple={canLaunchMultiple}
            onManageAgents={onManageAgents}
            onCustomizeShortcuts={onCustomizeShortcuts}
            promptTextareaRef={promptTextareaRef}
            open={openMenu === 'agent'}
            onOpenChange={menuOpenChange('agent')}
          />
        )}
        {hasAgent && selectedLaunchTargets.length === 0 && (
          <ReasoningLevelPill
            preset={selectedPreset}
            getReasoningLevelId={getReasoningLevelId}
            onReasoningLevelChange={onReasoningLevelChange}
            promptTextareaRef={promptTextareaRef}
            open={openMenu === 'effort'}
            onOpenChange={menuOpenChange('effort')}
          />
        )}
      </span>
      <Button
        type="submit"
        size="sm"
        disabled={isSubmitting || launchBlocked}
        className="h-7 gap-1.5 rounded-md px-2.5 text-xs"
      >
        {isSubmitting && <Spinner size="sm" />}
        {canLaunchMultiple && selectedLaunchTargets.length > 1
          ? `Launch ${selectedLaunchTargets.length}`
          : hasAgent
            ? 'Launch'
            : 'Create'}{' '}
        <span className="text-ui opacity-60">↵</span>
      </Button>
    </div>
  );
}

interface ReasoningLevelPillProps {
  preset: AgentPreset | undefined;
  getReasoningLevelId: (presetId: string) => string | null;
  onReasoningLevelChange: (presetId: string, levelId: string | null) => void;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_REASONING_VALUE = '__default__';

// Effort pill next to the agent pill. Agents define their own number of
// levels, and can give the pill another title and icon, such as for a model.
// The gauge's bar meter only appears once a non-default level is chosen.
function ReasoningLevelPill({
  preset,
  getReasoningLevelId,
  onReasoningLevelChange,
  promptTextareaRef,
  open,
  onOpenChange,
}: ReasoningLevelPillProps) {
  const cycleShortcut = useNewWorkspaceShortcutLabel('cycleEffort');
  const levels = shownReasoningLevels(preset);
  if (!preset || levels.length === 0) return null;
  const reasoningLevelId = getReasoningLevelId(preset.id);
  const levelIndex = levels.findIndex((level) => level.id === reasoningLevelId);
  const level = levelIndex >= 0 ? levels[levelIndex] : undefined;
  const picker = levelPickerOf(preset);
  const PickerIcon = LEVEL_PICKER_ICON_COMPONENTS[picker.icon];

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${preset.name} ${picker.title}: ${level?.name ?? 'Default'}`}
          title={cycleShortcut ? `${picker.title}, ${cycleShortcut} cycles` : picker.title}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md px-2 text-ui transition-colors',
            level
              ? 'bg-muted font-medium text-foreground hover:bg-muted/80'
              : 'text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground'
          )}
        >
          {level && picker.icon === 'gauge' ? (
            <span className="inline-flex items-end gap-px" data-reasoning-meter>
              {levels.map((item, index) => (
                <span
                  key={item.id}
                  aria-hidden
                  className={cn(
                    'h-2 w-[3px] rounded-[1px] bg-current',
                    index > levelIndex && 'opacity-30'
                  )}
                />
              ))}
            </span>
          ) : (
            <PickerIcon className="size-3" />
          )}
          {level ? level.name : picker.title}
          <CaretDown className="size-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="min-w-36"
        onCloseAutoFocus={(e) => focusPromptOnMenuClose(e, promptTextareaRef.current)}
      >
        <DropdownMenuLabel>
          {preset.name} {picker.title}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={reasoningLevelId ?? DEFAULT_REASONING_VALUE}
          onValueChange={(value) =>
            onReasoningLevelChange(preset.id, value === DEFAULT_REASONING_VALUE ? null : value)
          }
        >
          <DropdownMenuRadioItem value={DEFAULT_REASONING_VALUE} className="text-xs">
            Default
          </DropdownMenuRadioItem>
          {levels.map((item) => (
            <DropdownMenuRadioItem
              key={item.id}
              value={item.id}
              className="text-xs"
              title={item.arguments}
            >
              {item.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AgentLaunchPickerPillProps {
  resolvedActivePresets: AgentPreset[];
  multiLaunchPresets: AgentPreset[];
  selectedPresetId: string | null;
  launchModeId: string | null;
  getPreferredLaunchModeId: (presetId: string) => string | null;
  onAgentLaunchChange: (presetId: string, launchModeId: string | null) => void;
  selectedLaunchTargets: LaunchTarget[];
  onLaunchTargetsChange: (targets: LaunchTarget[]) => void;
  canLaunchMultiple: boolean;
  onManageAgents: () => void;
  onCustomizeShortcuts: () => void;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function AgentLaunchPickerPill({
  resolvedActivePresets,
  multiLaunchPresets,
  selectedPresetId,
  launchModeId,
  getPreferredLaunchModeId,
  onAgentLaunchChange,
  selectedLaunchTargets,
  onLaunchTargetsChange,
  canLaunchMultiple,
  onManageAgents,
  onCustomizeShortcuts,
  promptTextareaRef,
  open: isPickerOpen,
  onOpenChange: setIsPickerOpen,
}: AgentLaunchPickerPillProps) {
  const cycleAgentShortcut = useNewWorkspaceShortcutLabel('cycleAgent');
  const cycleLaunchModeShortcut = useNewWorkspaceShortcutLabel('cycleLaunchMode');
  const selectedPreset =
    resolvedActivePresets.find((preset) => preset.id === selectedPresetId) ??
    resolvedActivePresets[0];
  const modeIndex = launchModeId
    ? (selectedPreset?.launchModes.findIndex((mode) => mode.id === launchModeId) ?? -1)
    : -1;
  const mode = modeIndex >= 0 ? selectedPreset?.launchModes[modeIndex] : null;
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [draftLaunchTargets, setDraftLaunchTargets] = useState<LaunchTarget[]>([]);
  const [inspectedPresetId, setInspectedPresetId] = useState<string | null>(null);
  const [selectionBeforeEdit, setSelectionBeforeEdit] = useState<LaunchTarget[]>([]);
  const pickerPresets = isMultiSelectMode ? multiLaunchPresets : resolvedActivePresets;

  const applyDraftSelection = () => {
    if (draftLaunchTargets.length === 0) return;
    if (draftLaunchTargets.length === 1) {
      const [target] = draftLaunchTargets;
      onAgentLaunchChange(target.presetId, target.launchModeId);
      setDraftLaunchTargets([]);
      setIsMultiSelectMode(false);
      return;
    }

    onLaunchTargetsChange(draftLaunchTargets);
  };

  // Each opening, by click or by shortcut, starts from the current selection.
  const [wasOpen, setWasOpen] = useState(isPickerOpen);
  if (isPickerOpen !== wasOpen) {
    setWasOpen(isPickerOpen);
    if (isPickerOpen) {
      const openInMultiSelectMode = selectedLaunchTargets.length > 0;
      const availablePresets = openInMultiSelectMode ? multiLaunchPresets : resolvedActivePresets;
      const initialPreset =
        availablePresets.find((preset) => preset.id === selectedPreset?.id) ?? availablePresets[0];

      setIsMultiSelectMode(openInMultiSelectMode);
      setDraftLaunchTargets(selectedLaunchTargets);
      setSelectionBeforeEdit(selectedLaunchTargets);
      setInspectedPresetId(initialPreset?.id ?? null);
    }
  }

  const handleMenuOpenChange = (open: boolean) => {
    if (!open && isMultiSelectMode && draftLaunchTargets.length === 1) {
      applyDraftSelection();
    }
    setIsPickerOpen(open);
  };

  const enterMultiSelectMode = () => {
    const initialPreset =
      multiLaunchPresets.find((preset) => preset.id === selectedPreset?.id) ??
      multiLaunchPresets[0];
    setSelectionBeforeEdit(selectedLaunchTargets);
    setDraftLaunchTargets([]);
    setInspectedPresetId(initialPreset?.id ?? null);
    setIsMultiSelectMode(true);
  };

  const closeWithoutSaving = () => {
    const previousTargets = selectionBeforeEdit;
    onLaunchTargetsChange(previousTargets);
    setDraftLaunchTargets(previousTargets);
    setIsPickerOpen(false);
  };

  const handleUseSingleAgent = () => {
    onLaunchTargetsChange([]);
    setDraftLaunchTargets([]);
    setIsMultiSelectMode(false);
    setIsPickerOpen(false);
  };

  const handleToggleTarget = (target: LaunchTarget) => {
    const nextTargets = toggleLaunchTarget(draftLaunchTargets, target);
    setDraftLaunchTargets(nextTargets);
    onLaunchTargetsChange(nextTargets);
  };

  const saveMultiSelection = () => {
    if (draftLaunchTargets.length === 0) return;
    applyDraftSelection();
    setIsPickerOpen(false);
  };

  const isParallelSelection = selectedLaunchTargets.length > 0;
  const hasMultiplePresets = resolvedActivePresets.length > 1;

  return (
    <DropdownMenu modal={false} open={isPickerOpen} onOpenChange={handleMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'group inline-flex h-6 items-center rounded-md px-2 text-ui transition-colors',
            isParallelSelection
              ? 'gap-1 bg-primary/10 font-medium text-primary hover:bg-primary/15'
              : 'text-muted-foreground/70 hover:text-muted-foreground'
          )}
          title={
            isParallelSelection
              ? 'Edit parallel workspace selection'
              : [
                  hasMultiplePresets
                    ? 'Click to select agent and launch mode'
                    : 'Click to select launch mode',
                  hasMultiplePresets && cycleAgentShortcut && `${cycleAgentShortcut} cycles agents`,
                  cycleLaunchModeShortcut && `${cycleLaunchModeShortcut} cycles launch modes`,
                ]
                  .filter(Boolean)
                  .join(', ')
          }
        >
          {isParallelSelection ? (
            <>
              <Robot className="size-3" />
              {selectedLaunchTargets.length} parallel{' '}
              {selectedLaunchTargets.length === 1 ? 'workspace' : 'workspaces'}
            </>
          ) : (
            <>
              <AgentPresetIcon preset={selectedPreset ?? null} className="mr-1 size-3 shrink-0" />
              {selectedPreset?.name}{' '}
              {mode && (
                <span
                  className={cn(
                    'ml-1.5 whitespace-nowrap rounded px-1.5 font-medium leading-4 transition-opacity group-hover:opacity-80',
                    LAUNCH_MODE_PILL_CLASSES[getLaunchModeColor(mode.color, modeIndex)]
                  )}
                >
                  {mode.name}
                </span>
              )}
            </>
          )}
          <CaretDown className="ml-1 size-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-max max-w-[min(22rem,calc(100vw-2rem))] min-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto py-1"
        onWheel={stopWheelPropagation}
        onCloseAutoFocus={(e) => focusPromptOnMenuClose(e, promptTextareaRef.current)}
      >
        <AgentLaunchPickerMatrix
          presets={pickerPresets}
          inspectedPresetId={inspectedPresetId}
          onInspectPreset={setInspectedPresetId}
          selectedTarget={
            isMultiSelectMode
              ? undefined
              : {
                  presetId: selectedPreset?.id ?? '',
                  launchModeId,
                }
          }
          selectedTargets={isMultiSelectMode ? draftLaunchTargets : undefined}
          onSelectTarget={(target) => onAgentLaunchChange(target.presetId, target.launchModeId)}
          onToggleTarget={handleToggleTarget}
          getPreferredLaunchModeId={(preset) => getPreferredLaunchModeId(preset.id)}
          heightPresets={resolvedActivePresets}
          onManageAgents={isMultiSelectMode ? undefined : onManageAgents}
        />
        {isMultiSelectMode ? (
          <MultiSelectFooter
            selectedCount={draftLaunchTargets.length}
            canUseSingleAgent={selectionBeforeEdit.length > 0}
            onCancel={closeWithoutSaving}
            onUseSingleAgent={handleUseSingleAgent}
            onDone={saveMultiSelection}
          />
        ) : (
          <div className="mt-1 flex items-center gap-2 border-t border-border/60 px-2 py-1">
            <span className="min-w-0 truncate text-2xs text-muted-foreground/70">
              {hasMultiplePresets && cycleAgentShortcut && (
                <>
                  <Kbd>{cycleAgentShortcut}</Kbd> cycle agent
                  {cycleLaunchModeShortcut && ' · '}
                </>
              )}
              {cycleLaunchModeShortcut && (
                <>
                  <Kbd>{cycleLaunchModeShortcut}</Kbd> cycle launch mode
                </>
              )}
            </span>
            <IconButton
              label="Customize shortcuts"
              size="xs"
              className="ml-auto shrink-0 text-muted-foreground"
              onClick={onCustomizeShortcuts}
            >
              <Keyboard className="size-3.5" />
            </IconButton>
            <button
              type="button"
              disabled={!canLaunchMultiple}
              className="shrink-0 rounded px-1.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              onClick={enterMultiSelectMode}
            >
              Select multiple
            </button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface MultiSelectFooterProps {
  selectedCount: number;
  canUseSingleAgent: boolean;
  onCancel: () => void;
  onUseSingleAgent: () => void;
  onDone: () => void;
}

function MultiSelectFooter({
  selectedCount,
  canUseSingleAgent,
  onCancel,
  onUseSingleAgent,
  onDone,
}: MultiSelectFooterProps) {
  const confirmationLabel =
    selectedCount === 0 ? 'Select at least 1' : `Done · ${selectedCount} selected`;

  return (
    <>
      <DropdownMenuSeparator />
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          className="rounded px-2 py-1 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
        {canUseSingleAgent && (
          <button
            type="button"
            className="rounded px-2 py-1 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onUseSingleAgent}
          >
            Use one agent
          </button>
        )}
        <button
          type="button"
          disabled={selectedCount === 0}
          className="ml-auto rounded bg-primary px-2 py-1 text-ui font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          onClick={onDone}
        >
          {confirmationLabel}
        </button>
      </div>
    </>
  );
}
