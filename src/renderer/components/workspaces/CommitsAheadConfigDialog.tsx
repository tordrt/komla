import { Sparkle, Terminal } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
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
import {
  findActionForProject,
  findPrDraftAction,
  isActionAvailableForProject,
} from '@/lib/action-visibility';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';

import { aheadPreset } from '../../../shared/lib/project-git-defaults';

import type { Action, GitDefaults, Project, SimpleAheadAction } from '@/types';

interface AheadChoices {
  main: SimpleAheadAction;
  mainActionId?: string;
  other: SimpleAheadAction;
  otherActionId?: string;
}

interface CommitsAheadConfigDialogProps {
  projectId: string;
  /** The branch this workspace's ↑N acts on, and whether it gets the default-branch choice. */
  targetBranch: string;
  targetIsDefault: boolean;
  /** The branch origin calls its default, when known. */
  remoteDefaultBranch?: string;
  hasOriginRemote: boolean;
  /** Fast-forwarding pushes the target branch afterwards. */
  pushAfterFastForward: boolean;
  /** Origin has this workspace's target branch, so it's pushed rather than published. */
  targetBranchOnOrigin: boolean;
  /** Fast-forwarding waits until the branch has the target's new commits. */
  canFastForward: boolean;
  onClose: () => void;
  /** Does what was chosen for this workspace, right after saving. */
  onSaved: (action: SimpleAheadAction, actionId: string | undefined) => void;
}

// The two choices a project-only save stores, as the preset they match where there is one.
function projectUpdates(choices: AheadChoices): Partial<Project> {
  const preset = aheadPreset(choices.main, choices.other);
  if (preset) {
    return {
      aheadTargetAction: preset,
      autoMainBranchAction: undefined,
      autoOtherBranchAction: undefined,
      autoMainActionId: undefined,
      autoOtherActionId: undefined,
    };
  }
  return {
    aheadTargetAction: 'auto',
    autoMainBranchAction: choices.main,
    autoMainActionId: choices.mainActionId,
    autoOtherBranchAction: choices.other,
    autoOtherActionId: choices.otherActionId,
  };
}

function picksEveryQuickCommand(choices: AheadChoices): boolean {
  return (
    (choices.main !== 'agent-prompt' || !!choices.mainActionId) &&
    (choices.other !== 'agent-prompt' || !!choices.otherActionId)
  );
}

function allProjectsHint(params: {
  projectOnlyTitle: string | undefined;
  hasOriginRemote: boolean;
  savesForAll: boolean;
}): string {
  if (params.projectOnlyTitle) {
    return `${params.projectOnlyTitle} is only in this project. Change it later in project settings.`;
  }
  if (!params.hasOriginRemote) {
    return "This repository has no origin, so its choice stays in this project's settings.";
  }
  return params.savesForAll
    ? "Projects that haven't chosen stop asking and do this too. Change it in Settings → Git."
    : "Saved in this project's settings. Tick to stop projects that haven't chosen from asking too.";
}

// What saving runs in this workspace, if anything: fast-forwarding waits for the target's commits.
function choiceToRun(
  choices: AheadChoices,
  targetIsDefault: boolean,
  canFastForward: boolean
): { action: SimpleAheadAction; actionId: string | undefined } | undefined {
  const action = targetIsDefault ? choices.main : choices.other;
  if (action === 'disabled' || (action === 'merge' && !canFastForward)) return undefined;
  return { action, actionId: targetIsDefault ? choices.mainActionId : choices.otherActionId };
}

// Starts the default branch on an agent drafting the PR when Komla's quick command for it is
// there and origin is there to take the PR. Without origin, a PR choice would fast-forward instead.
function initialMainChoice(
  prDraftActionId: string | undefined,
  hasOriginRemote: boolean
): { action: SimpleAheadAction; actionId: string } {
  if (prDraftActionId && hasOriginRemote)
    return { action: 'agent-prompt', actionId: prDraftActionId };
  return { action: hasOriginRemote ? 'pr' : 'merge', actionId: '' };
}

// The choices as the lists show them. A PR page picked before origin went away fast-forwards,
// as its saved choice would, and only quick command choices keep their command.
function shownChoices(
  picks: {
    main: SimpleAheadAction;
    mainActionId: string;
    other: SimpleAheadAction;
    otherActionId: string;
  },
  hasOriginRemote: boolean
): AheadChoices {
  const shown = (action: SimpleAheadAction) =>
    !hasOriginRemote && action === 'pr' ? 'merge' : action;
  const idFor = (action: SimpleAheadAction, id: string) =>
    action === 'agent-prompt' ? id || undefined : undefined;
  const main = shown(picks.main);
  const other = shown(picks.other);
  return {
    main,
    mainActionId: idFor(main, picks.mainActionId),
    other,
    otherActionId: idFor(other, picks.otherActionId),
  };
}

// What fast-forwarding a target does on origin afterwards. Only this workspace's target is
// known to be missing from origin; it's published instead of pushed.
function remoteWriteAfterFastForward(params: {
  pushAfterFastForward: boolean;
  hasOriginRemote: boolean;
  targetBranchOnOrigin: boolean;
}): 'push' | 'publish' | undefined {
  if (!params.pushAfterFastForward || !params.hasOriginRemote) return undefined;
  return params.targetBranchOnOrigin ? 'push' : 'publish';
}

// App-wide for every project still asking, or for this project alone.
async function saveChoices(params: {
  forAll: boolean;
  projectId: string;
  choices: AheadChoices;
  gitDefaults: GitDefaults | undefined;
  updateConfig: (updates: {
    gitDefaults: GitDefaults;
  }) => Promise<{ ok: boolean; error: string | null }>;
}) {
  const { choices } = params;
  if (!params.forAll) {
    await window.api.updateProject(params.projectId, projectUpdates(choices));
    return;
  }
  const result = await params.updateConfig({
    gitDefaults: {
      ...params.gitDefaults,
      aheadMainAction: choices.main,
      aheadOtherAction: choices.other,
      aheadMainActionId: choices.mainActionId,
      aheadOtherActionId: choices.otherActionId,
    },
  });
  if (!result.ok) throw new Error(result.error ?? 'Failed to update config');
}

function saveLabel(action: SimpleAheadAction | undefined, targetBranch: string): string {
  if (action === 'agent-prompt') return 'Save & run';
  if (action === 'pr') return 'Save & open PR';
  if (action === 'merge') return `Save & fast-forward ${targetBranch}`;
  return 'Save';
}

function QuickCommandPicker({
  actions,
  selected,
  onSelect,
  onManage,
}: {
  actions: Action[];
  selected: Action | undefined;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const commandActions = actions.filter((a) => a.type === 'command');
  const promptActions = actions.filter((a) => a.type !== 'command');
  const hasCommands = commandActions.length > 0;
  const hasPrompts = promptActions.length > 0;
  if (actions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No quick commands configured.{' '}
        <button type="button" className="text-primary hover:underline" onClick={onManage}>
          Manage Quick Commands
        </button>{' '}
        to create one.
      </p>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start gap-2 font-normal">
          {selected ? (
            <>
              {selected.type === 'command' ? (
                <Terminal className="size-3.5 text-muted-foreground" />
              ) : (
                <Sparkle className="size-3.5 text-muted-foreground" />
              )}
              <span className="truncate">{selected.title}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Select a quick command...</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-0"
      >
        {hasCommands && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Terminal className="size-3" />
              Terminal Commands
            </DropdownMenuLabel>
            {commandActions.map((a) => (
              <DropdownMenuItem key={a.id} onSelect={() => onSelect(a.id)}>
                <Terminal />
                {a.title}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {hasCommands && hasPrompts && <DropdownMenuSeparator />}
        {hasPrompts && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Sparkle className="size-3" />
              Saved Prompts
            </DropdownMenuLabel>
            {promptActions.map((a) => (
              <DropdownMenuItem key={a.id} onSelect={() => onSelect(a.id)}>
                <Sparkle />
                {a.title}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManage} className="text-muted-foreground">
          Manage Quick Commands...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function optionText(
  action: SimpleAheadAction,
  fastForwardTarget: string,
  remoteWrite: 'push' | 'publish' | undefined
): { title: string; description?: string } {
  if (action === 'agent-prompt') return { title: 'Run a quick command' };
  if (action === 'pr') {
    return {
      title: 'Open the PR page',
      description: "Publishes the branch first if origin doesn't have it.",
    };
  }
  if (action === 'merge') {
    return {
      title: `Fast-forward ${fastForwardTarget}`,
      description: remoteWrite
        ? `Then ${remoteWrite === 'publish' ? 'publishes' : 'pushes'} it to origin.`
        : undefined,
    };
  }
  return { title: 'Do nothing' };
}

function AheadOption({
  name,
  action,
  checked,
  onChange,
  text,
  picker,
}: {
  name: string;
  action: SimpleAheadAction;
  checked: boolean;
  onChange: (action: SimpleAheadAction) => void;
  text: { title: string; description?: string };
  picker?: React.ComponentProps<typeof QuickCommandPicker>;
}) {
  return (
    <div
      className={`px-3 py-2 transition-colors ${checked ? 'bg-primary/5' : 'hover:bg-accent/40'}`}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="radio"
          name={name}
          value={action}
          checked={checked}
          onChange={() => onChange(action)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${
            checked ? 'border-primary' : 'border-muted-foreground/40'
          }`}
        >
          {checked && <span className="size-2 rounded-full bg-primary" />}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium wrap-anywhere">{text.title}</span>
          {text.description && (
            <span className="block text-xs text-muted-foreground">{text.description}</span>
          )}
        </span>
      </label>
      {picker && checked && (
        <div className="mt-2 pl-7">
          <QuickCommandPicker {...picker} />
        </div>
      )}
    </div>
  );
}

// Opens on the chosen option rather than the first one, as tabbing into a radio group does.
function focusCheckedRadio(event: Event) {
  const checked = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>(
    'input[type="radio"]:checked'
  );
  if (!checked) return;
  event.preventDefault();
  checked.focus();
}

const OPTION_ORDER: SimpleAheadAction[] = ['agent-prompt', 'pr', 'merge', 'disabled'];

// The radio list of what ↑N does for one kind of target branch.
function AheadChoiceList({
  label,
  fastForwardTarget,
  value,
  onChange,
  hasOriginRemote,
  remoteWrite,
  picker,
}: {
  label: string;
  fastForwardTarget: string;
  value: SimpleAheadAction;
  onChange: (action: SimpleAheadAction) => void;
  hasOriginRemote: boolean;
  /** What fast-forwarding does on origin afterwards, if anything. */
  remoteWrite: 'push' | 'publish' | undefined;
  picker: React.ComponentProps<typeof QuickCommandPicker>;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium wrap-anywhere text-muted-foreground">
        {label}
      </legend>
      <div className="divide-y overflow-hidden rounded-md border">
        {OPTION_ORDER.filter((action) => action !== 'pr' || hasOriginRemote).map((action) => (
          <AheadOption
            key={action}
            name={name}
            action={action}
            checked={value === action}
            onChange={onChange}
            text={optionText(action, fastForwardTarget, remoteWrite)}
            picker={action === 'agent-prompt' ? picker : undefined}
          />
        ))}
      </div>
    </fieldset>
  );
}

export function CommitsAheadConfigDialog({
  projectId,
  targetBranch,
  targetIsDefault,
  remoteDefaultBranch,
  hasOriginRemote,
  pushAfterFastForward,
  targetBranchOnOrigin,
  canFastForward,
  onClose,
  onSaved,
}: CommitsAheadConfigDialogProps) {
  const actions = useActionsStore((s) => s.actions);
  const gitDefaults = useConfigStore((s) => s.config?.gitDefaults);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const addToast = useToastStore((s) => s.addToast);
  const [initialMain] = useState(() =>
    initialMainChoice(findPrDraftAction(actions, projectId)?.id, hasOriginRemote)
  );
  const [mainAction, setMainAction] = useState<SimpleAheadAction>(initialMain.action);
  const [mainActionId, setMainActionId] = useState(initialMain.actionId);
  const [otherAction, setOtherAction] = useState<SimpleAheadAction>('merge');
  const [otherActionId, setOtherActionId] = useState('');
  // Saving for all projects stops every project that hasn't chosen from asking, so it's opt-in.
  // Without origin it isn't offered: this repo's fast-forward would replace other projects' PRs.
  const [allProjects, setAllProjects] = useState(false);
  const [saving, setSaving] = useState(false);

  const availableActions = actions.filter((action) =>
    isActionAvailableForProject(action, projectId)
  );
  const choices = shownChoices(
    { main: mainAction, mainActionId, other: otherAction, otherActionId },
    hasOriginRemote
  );
  const chosenIds = [choices.mainActionId, choices.otherActionId].filter(Boolean);
  // Other projects can't run a quick command that belongs to this one.
  const projectOnlyAction = chosenIds
    .map((id) => availableActions.find((a) => a.id === id))
    .find((action) => !!action?.projectIds?.length);
  const canSaveForAll = hasOriginRemote && !projectOnlyAction;
  const savesForAll = allProjects && canSaveForAll;
  const toRun = choiceToRun(choices, targetIsDefault, canFastForward);
  const remoteWriteFor = (thisWorkspace: boolean) =>
    remoteWriteAfterFastForward({
      pushAfterFastForward,
      hasOriginRemote,
      targetBranchOnOrigin: !thisWorkspace || targetBranchOnOrigin,
    });

  const canSave = picksEveryQuickCommand(choices);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveChoices({
        forAll: savesForAll,
        projectId,
        choices,
        gitDefaults,
        updateConfig,
      });
      onClose();
      if (toRun) onSaved(toRun.action, toRun.actionId);
    } catch {
      addToast('Failed to save what commits ahead (↑N) does', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleManageActions = () => {
    onClose();
    window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }));
  };

  const pickerFor = (selectedId: string, setSelectedId: (id: string) => void) => ({
    actions: availableActions,
    selected: findActionForProject(availableActions, selectedId, projectId),
    onSelect: setSelectedId,
    onManage: handleManageActions,
  });

  const mainList = {
    label: `Default branch (${targetIsDefault ? targetBranch : remoteDefaultBranch || 'main or master'})`,
    value: choices.main,
    onChange: setMainAction,
    hasOriginRemote,
    remoteWrite: remoteWriteFor(targetIsDefault),
    picker: pickerFor(mainActionId, setMainActionId),
  };
  const otherList = {
    label: targetIsDefault ? 'Other branches' : `Other branches (${targetBranch})`,
    value: choices.other,
    onChange: setOtherAction,
    hasOriginRemote,
    remoteWrite: remoteWriteFor(!targetIsDefault),
    picker: pickerFor(otherActionId, setOtherActionId),
  };
  // This workspace's kind of target comes first.
  const primary = targetIsDefault ? mainList : otherList;
  const secondary = targetIsDefault ? otherList : mainList;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-md"
        onClick={(e) => e.stopPropagation()}
        onOpenAutoFocus={focusCheckedRadio}
      >
        <DialogHeader>
          <DialogTitle>What should ↑N do?</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            ↑N counts the commits {targetBranch} doesn't have yet.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <AheadChoiceList {...primary} fastForwardTarget={targetBranch} />
          <AheadChoiceList
            {...secondary}
            fastForwardTarget={targetIsDefault ? 'the target branch' : 'the default branch'}
          />
        </DialogBody>

        <div className="border-t pt-4">
          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <Checkbox
              checked={savesForAll}
              disabled={!canSaveForAll}
              onChange={(e) => setAllProjects(e.target.checked)}
              className="mt-0.5"
            />
            <span className="space-y-0.5">
              <span className="block font-medium text-foreground">Use for all projects</span>
              <span className="block text-muted-foreground">
                {allProjectsHint({
                  projectOnlyTitle: projectOnlyAction?.title,
                  hasOriginRemote,
                  savesForAll,
                })}
              </span>
            </span>
          </label>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button className="min-w-0" disabled={!canSave || saving} onClick={handleSave}>
            <span className="truncate">
              {saving ? 'Saving...' : saveLabel(toRun?.action, targetBranch)}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
