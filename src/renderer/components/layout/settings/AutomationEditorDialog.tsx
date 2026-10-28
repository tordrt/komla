import { CaretDown, Sparkle, Trash } from '@phosphor-icons/react';
import { useCallback, useId, useRef, useState } from 'react';

import { BranchSelect } from '@/components/ui/branch-select';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Select } from '@/components/ui/select';
import { resolveLaunchModeForPreset } from '@/lib/agent-launch';
import {
  cronToDraft,
  DEFAULT_SCHEDULE_DRAFT,
  draftToCron,
  localTimeZone,
  type ScheduleDraft,
} from '@/lib/automation-schedule-draft';
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from '@/lib/automation-templates';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import { canStartWithPrompt } from '../../../../shared/lib/agent-preset-prompt';
import { automationScheduleError } from '../../../../shared/lib/automation-schedule';
import { projectRepoPath } from '../../../../shared/lib/project-repo-path';
import {
  AUTOMATION_MISSED_RUN_GRACE_MINUTES,
  DEFAULT_AUTOMATION_MISSED_RUN_GRACE_MINUTES,
  type Automation,
  type AutomationTarget,
  type SaveAutomationParams,
} from '../../../../shared/types/automation';

import { AgentPicker, LOCAL_TARGET_VALUE, ProjectPicker, TargetPicker } from './AutomationPickers';
import { AutomationScheduleSection } from './AutomationScheduleFields';

import type { ActivePresetEntry, AgentPreset, Project, SshHost } from '@/types';

function targetValue(target: AutomationTarget): string {
  return target.kind === 'local' ? LOCAL_TARGET_VALUE : `ssh:${target.hostId}`;
}

function targetFromValue(value: string): AutomationTarget {
  return value.startsWith('ssh:')
    ? { kind: 'ssh', hostId: value.slice('ssh:'.length) }
    : { kind: 'local' };
}

function graceDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function graceLabel(minutes: number): string {
  return minutes === 0 ? 'Skip it' : `Start it if it’s up to ${graceDuration(minutes)} late`;
}

function graceSummary(minutes: number): string {
  return minutes === 0
    ? 'Missed runs are skipped'
    : `Missed runs start up to ${graceDuration(minutes)} late`;
}

interface AutomationEditorDialogProps {
  /** The automation to edit; null creates a new one. */
  automation: Automation | null;
  /** What a new automation starts from. */
  template?: AutomationTemplate;
  projects: Project[];
  presets: AgentPreset[];
  /** The agents the user turned on, which the agent picker offers. */
  activePresets: ActivePresetEntry[];
  /** The launch mode an agent starts in when it has no last-used mode. */
  defaultLaunchModeId?: string | null;
  /** SSH hosts that are set up. */
  hosts: SshHost[];
  defaultTarget: AutomationTarget;
  isSaving: boolean;
  onSave: (params: SaveAutomationParams) => void;
  onClose: () => void;
  onRequestDelete?: () => void;
}

/**
 * Creates or edits one automation. Rendered while open, so every open starts from the
 * automation's saved values. Closing with unsaved edits asks first.
 */
export function AutomationEditorDialog({
  automation,
  template,
  projects,
  presets,
  activePresets,
  defaultLaunchModeId,
  hosts,
  defaultTarget,
  isSaving,
  onSave,
  onClose,
  onRequestDelete,
}: AutomationEditorDialogProps) {
  const isCreateMode = automation === null;
  const fieldId = useId();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const focusBeforePromptRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Seeded once; a change elsewhere while this is open doesn't replace what's being typed.
  const [initial] = useState(() =>
    initialValues({
      automation,
      template,
      projects,
      defaultTarget,
      agent: recentAgent(presets, activePresets, defaultLaunchModeId),
    })
  );
  const [name, setName] = useState(initial.name);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [projectId, setProjectId] = useState(initial.projectId);
  const [target, setTarget] = useState(initial.target);
  const [presetId, setPresetId] = useState(initial.presetId);
  const [launchModeId, setLaunchModeId] = useState(initial.launchModeId);
  const [startBranch, setStartBranch] = useState(initial.startBranch);
  const [draft, setDraft] = useState<ScheduleDraft>(initial.draft);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [grace, setGrace] = useState(initial.grace);
  const [showMissing, setShowMissing] = useState(false);
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);

  const cron = draftToCron(draft);
  const current = {
    name,
    prompt,
    projectId,
    target,
    presetId,
    launchModeId,
    startBranch,
    timeZone,
    grace,
  };
  const isDirty =
    cron !== draftToCron(initial.draft) ||
    Object.entries(current).some(([key, value]) => initial[key as keyof typeof current] !== value);

  const runsOnHost = target !== LOCAL_TARGET_VALUE;
  const eligibleProjects = runsOnHost
    ? projects.filter((project) => project.kind !== 'directory')
    : projects;
  const pickerPresets = agentPickerPresets(presets, activePresets, presetId);
  const project = projects.find((candidate) => candidate.id === projectId);
  const gitProject = project?.kind === 'directory' ? undefined : project;

  const scheduleError = draftScheduleError(draft, { cron, timeZone });
  const missingFields = [
    !name.trim() && 'a name',
    !prompt.trim() && 'a prompt',
    !projectId && 'a project',
  ].filter(Boolean);

  const handleSave = () => {
    if (isSaving) return;
    if (missingFields.length > 0 || scheduleError) {
      setShowMissing(true);
      return;
    }
    onSave(
      toSaveParams(automation, { ...current, startBranch: gitProject ? startBranch : '', cron })
    );
  };

  const requestClose = () => {
    if (isDirty) {
      focusBeforePromptRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDiscardPromptOpen(true);
      return;
    }
    onClose();
  };

  const applyTemplate = (chosen: AutomationTemplate) => {
    setName(chosen.label);
    setPrompt(chosen.prompt);
    setDraft(cronToDraft(chosen.cron));
    setGrace(chosen.missedRunGraceMinutes);
  };

  const updateDraft = useCallback(
    (changes: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...changes })),
    []
  );

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent
          className="max-w-2xl"
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            nameInputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Radix returns focus to a DialogTrigger; go back to whatever opened the editor.
            event.preventDefault();
            openerRef.current?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              handleSave();
            }
          }}
        >
          <DialogHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div className="min-w-0 space-y-1.5">
              <DialogTitle className="text-base">
                {isCreateMode ? 'New automation' : 'Edit automation'}
              </DialogTitle>
              <DialogDescription className="text-xs">
                Each run starts the agent in a new workspace with this prompt.
              </DialogDescription>
            </div>
            {isCreateMode && <TemplateMenu onSelect={applyTemplate} />}
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="grid gap-1.5">
              <label htmlFor={`${fieldId}-name`} className="text-[13px] font-medium">
                Name
              </label>
              <Input
                id={`${fieldId}-name`}
                ref={nameInputRef}
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g., Nightly dependency check"
                className="h-9"
              />
            </div>

            <div className="overflow-hidden rounded-md border border-input transition-colors focus-within:border-foreground/30">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                <label
                  htmlFor={`${fieldId}-prompt`}
                  className="font-medium tracking-wide uppercase"
                >
                  Prompt
                </label>
                <span>Sent to the agent when each run starts</span>
              </div>
              <textarea
                id={`${fieldId}-prompt`}
                value={prompt}
                maxLength={32_000}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="e.g., Check for outdated dependencies, update the safe ones, run the tests, and commit the updates on this branch."
                rows={8}
                className="block max-h-[40vh] min-h-32 w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-hidden placeholder:text-muted-foreground/60"
              />
            </div>

            <ProjectTargetFields
              fieldId={fieldId}
              projects={eligibleProjects}
              projectId={projectId}
              hosts={hosts}
              target={target}
              otherDeviceProjectName={!projectId ? automation?.projectName : undefined}
              onProjectChange={(nextProjectId) => {
                // Another project's branches differ, so it starts from its own target again.
                // Matching the project another device saved keeps the branch it chose.
                if (projectId && nextProjectId !== projectId) setStartBranch('');
                setProjectId(nextProjectId);
              }}
              onTargetChange={setTarget}
            />

            <AgentFields
              fieldId={fieldId}
              presets={pickerPresets}
              presetId={presetId}
              launchModeId={launchModeId}
              getPreferredLaunchModeId={(preset) =>
                resolveLaunchModeForPreset(preset, activePresets, defaultLaunchModeId)
              }
              otherDeviceAgentName={!presetId ? automation?.agentName : undefined}
              onChange={(nextPresetId, nextLaunchModeId) => {
                setPresetId(nextPresetId);
                setLaunchModeId(nextLaunchModeId);
              }}
            />

            <AutomationScheduleSection
              fieldId={fieldId}
              draft={draft}
              cron={cron}
              timeZone={timeZone}
              scheduleError={scheduleError}
              onDraftChange={updateDraft}
              onTimeZoneChange={setTimeZone}
            />

            <AdvancedFields
              fieldId={fieldId}
              project={gitProject}
              startBranch={startBranch}
              grace={grace}
              runsOnHost={runsOnHost}
              onStartBranchChange={setStartBranch}
              onGraceChange={setGrace}
            />

            {showMissing && missingFields.length > 0 && (
              <Callout tone="error" size="sm">
                Add {missingFields.join(', ').replace(/, ([^,]*)$/, ' and $1')} to save this
                automation.
              </Callout>
            )}
          </DialogBody>

          <DialogFooter className="items-center gap-2 sm:justify-between sm:space-x-0">
            {onRequestDelete ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={onRequestDelete}
                disabled={isSaving}
              >
                <Trash className="mr-1.5 size-3.5" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={requestClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                {isCreateMode ? 'Create automation' : 'Save changes'}
                <Kbd className="ml-2 border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
                  {formatShortcutForDisplay('Cmd+Enter')}
                </Kbd>
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DiscardChangesDialog
        open={discardPromptOpen}
        onOpenChange={setDiscardPromptOpen}
        onDiscard={onClose}
        onClosed={() => (focusBeforePromptRef.current ?? nameInputRef.current)?.focus()}
      />
    </>
  );
}

function draftScheduleError(
  draft: ScheduleDraft,
  schedule: { cron: string; timeZone: string }
): string | undefined {
  if (draft.frequency === 'weekly' && draft.days.length === 0) return 'Choose at least one day.';
  return automationScheduleError(schedule);
}

function toSaveParams(
  automation: Automation | null,
  values: Omit<ReturnType<typeof initialValues>, 'draft'> & { cron: string }
): SaveAutomationParams {
  return {
    ...(automation ? { id: automation.id, previousTarget: automation.target } : {}),
    name: values.name.trim(),
    prompt: values.prompt.trim(),
    projectId: values.projectId,
    target: targetFromValue(values.target),
    ...(values.presetId ? { presetId: values.presetId } : {}),
    ...(values.presetId && values.launchModeId ? { launchModeId: values.launchModeId } : {}),
    ...(values.startBranch ? { startBranch: values.startBranch } : {}),
    schedule: { cron: values.cron, timeZone: values.timeZone },
    enabled: automation?.enabled ?? true,
    missedRunGraceMinutes: values.grace,
  };
}

/** The agents the user turned on that can start with a prompt, most recently used first. */
function recentPresets(presets: AgentPreset[], activePresets: ActivePresetEntry[]): AgentPreset[] {
  return [...activePresets]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map((entry) => presets.find((preset) => preset.id === entry.presetId))
    .filter((preset): preset is AgentPreset => !!preset && canStartWithPrompt(preset));
}

/** What the agent picker offers, keeping the chosen agent even after it was turned off. */
function agentPickerPresets(
  presets: AgentPreset[],
  activePresets: ActivePresetEntry[],
  presetId: string
): AgentPreset[] {
  const recent = recentPresets(presets, activePresets);
  const offered = recent.length > 0 ? recent : presets.filter(canStartWithPrompt);
  const chosen = presets.find((preset) => preset.id === presetId);
  return chosen && !offered.includes(chosen) ? [...offered, chosen] : offered;
}

/** The agent a new automation starts with: the one used last, as in the new workspace dialog. */
function recentAgent(
  presets: AgentPreset[],
  activePresets: ActivePresetEntry[],
  defaultLaunchModeId: string | null | undefined
): { presetId: string; launchModeId: string } | undefined {
  const preset = recentPresets(presets, activePresets)[0];
  return preset
    ? {
        presetId: preset.id,
        launchModeId: resolveLaunchModeForPreset(preset, activePresets, defaultLaunchModeId) ?? '',
      }
    : undefined;
}

/** What the editor starts from: the saved automation, else the template, else defaults. */
function initialValues({
  automation,
  template,
  projects,
  defaultTarget,
  agent,
}: {
  automation: Automation | null;
  template: AutomationTemplate | undefined;
  projects: Project[];
  defaultTarget: AutomationTarget;
  /** The agent a new automation starts with. */
  agent: { presetId: string; launchModeId: string } | undefined;
}) {
  const cron = automation?.schedule.cron ?? template?.cron;
  const onlyProjectId = projects.length === 1 ? (projects[0]?.id ?? '') : '';
  return {
    name: automation?.name ?? template?.label ?? '',
    prompt: automation?.prompt ?? template?.prompt ?? '',
    projectId: automation?.projectId ?? onlyProjectId,
    target: targetValue(automation?.target ?? defaultTarget),
    presetId: automation ? (automation.presetId ?? '') : (agent?.presetId ?? ''),
    launchModeId: automation ? (automation.launchModeId ?? '') : (agent?.launchModeId ?? ''),
    startBranch: automation?.startBranch ?? '',
    draft: cron ? cronToDraft(cron) : DEFAULT_SCHEDULE_DRAFT,
    timeZone: automation?.schedule.timeZone ?? localTimeZone(),
    grace:
      automation?.missedRunGraceMinutes ??
      template?.missedRunGraceMinutes ??
      DEFAULT_AUTOMATION_MISSED_RUN_GRACE_MINUTES,
  };
}

function DiscardChangesDialog({
  open,
  onOpenChange,
  onDiscard,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
  /** Where focus goes when the prompt closes and the editor stays. */
  onClosed: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="alertdialog"
        className="max-w-sm !gap-0 !p-0"
        onCloseAutoFocus={(event) => {
          // Radix returns focus to a DialogTrigger, and there is none here.
          event.preventDefault();
          onClosed();
        }}
      >
        <div className="space-y-2 px-5 pt-5 pb-4">
          <DialogTitle className="text-sm font-semibold">Unsaved changes</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
            Discard your changes to this automation?
          </DialogDescription>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/30 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Keep editing
          </Button>
          <Button variant="destructive" size="sm" onClick={onDiscard}>
            Discard changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateMenu({ onSelect }: { onSelect: (template: AutomationTemplate) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0">
          <Sparkle className="mr-1.5 size-3.5" />
          Use a template
          <CaretDown className="ml-1.5 size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Replaces the name, prompt, and schedule</DropdownMenuLabel>
        {AUTOMATION_TEMPLATES.map((template) => (
          <DropdownMenuItem
            key={template.id}
            className="flex-col items-start gap-0.5"
            onSelect={() => onSelect(template)}
          >
            <span>{template.label}</span>
            <span className="text-xs text-muted-foreground">{template.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AgentFieldsProps {
  fieldId: string;
  presets: AgentPreset[];
  presetId: string;
  launchModeId: string;
  getPreferredLaunchModeId: (preset: AgentPreset) => string | null;
  /** The agent another device saved, when it isn't set up here. */
  otherDeviceAgentName: string | undefined;
  onChange: (presetId: string, launchModeId: string) => void;
}

function AgentFields({
  fieldId,
  presets,
  presetId,
  launchModeId,
  getPreferredLaunchModeId,
  otherDeviceAgentName,
  onChange,
}: AgentFieldsProps) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={`${fieldId}-preset`} className="text-[13px] font-medium">
        Agent
      </label>
      <AgentPicker
        id={`${fieldId}-preset`}
        presets={presets}
        presetId={presetId}
        launchModeId={launchModeId}
        getPreferredLaunchModeId={getPreferredLaunchModeId}
        onChange={onChange}
      />
      {otherDeviceAgentName && (
        <p className="text-xs text-muted-foreground">
          Saved on another device with {otherDeviceAgentName}.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Nobody is watching when a run starts. If the agent stops to ask for permission, the run
        waits for you in its workspace. Choose a launch mode that doesn’t ask if it should finish on
        its own.
      </p>
    </div>
  );
}

interface ProjectTargetFieldsProps {
  fieldId: string;
  projects: Project[];
  projectId: string;
  hosts: SshHost[];
  target: string;
  /** The project another device saved, when it isn't set up here. */
  otherDeviceProjectName: string | undefined;
  onProjectChange: (projectId: string) => void;
  onTargetChange: (target: string) => void;
}

function ProjectTargetFields({
  fieldId,
  projects,
  projectId,
  hosts,
  target,
  otherDeviceProjectName,
  onProjectChange,
  onTargetChange,
}: ProjectTargetFieldsProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid content-start gap-1.5">
        <label htmlFor={`${fieldId}-project`} className="text-[13px] font-medium">
          Project
        </label>
        <ProjectPicker
          id={`${fieldId}-project`}
          projects={projects}
          projectId={projectId}
          onChange={onProjectChange}
        />
        {otherDeviceProjectName && (
          <p className="text-xs text-muted-foreground">
            Saved on another device for {otherDeviceProjectName}. Choose the matching project here
            to save changes.
          </p>
        )}
      </div>
      <div className="grid content-start gap-1.5">
        <label htmlFor={`${fieldId}-target`} className="text-[13px] font-medium">
          Run on
        </label>
        <TargetPicker
          id={`${fieldId}-target`}
          hosts={hosts}
          target={target}
          onChange={onTargetChange}
        />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {target === LOCAL_TARGET_VALUE
          ? 'Runs start only while Komla is open on this computer and it’s awake.'
          : 'The host starts each run itself, even while this computer is off. Every device connected to the host sees this automation and its runs.'}
      </p>
    </div>
  );
}

/** The branch runs start from and the missed-run grace period, folded under Advanced. */
function AdvancedFields({
  fieldId,
  project,
  startBranch,
  grace,
  runsOnHost,
  onStartBranchChange,
  onGraceChange,
}: {
  fieldId: string;
  /** The chosen project when it is a Git one, whose branches runs can start from. */
  project: Project | undefined;
  startBranch: string;
  grace: number;
  runsOnHost: boolean;
  onStartBranchChange: (branch: string) => void;
  onGraceChange: (grace: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = [project && startBranch && `Starts from ${startBranch}`, graceSummary(grace)]
    .filter(Boolean)
    .join(' · ');
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="-ml-2 flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
      >
        <span className="shrink-0">Advanced</span>
        {!open && (
          <span className="min-w-0 truncate font-normal text-muted-foreground">· {summary}</span>
        )}
        <CaretDown className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && project && (
        <div className="mt-2 grid gap-1.5">
          <span className="text-[13px] font-medium">Start from</span>
          <BranchSelect
            value={startBranch}
            onChange={(branch) => onStartBranchChange(branch)}
            repoPath={projectRepoPath(project)}
            projectId={project.id}
            placeholder={
              project.baseBranch ? `${project.baseBranch} (target branch)` : 'Default branch'
            }
            description={
              project.baseBranch
                ? 'Empty follows the project’s target branch, also after it changes. Diffs and PRs compare with the target either way.'
                : 'Empty starts from the default branch. The project has no target branch, so diffs and PRs compare with the branch a run starts from.'
            }
          />
        </div>
      )}
      {open && (
        <div className="mt-4 grid gap-1.5">
          <label htmlFor={`${fieldId}-grace`} className="text-[13px] font-medium">
            When a run is missed
          </label>
          <Select
            id={`${fieldId}-grace`}
            value={String(grace)}
            className="h-9"
            onChange={(event) => onGraceChange(Number(event.target.value))}
          >
            {AUTOMATION_MISSED_RUN_GRACE_MINUTES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {graceLabel(minutes)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {runsOnHost
              ? 'For when the host was off or restarting at the scheduled time.'
              : 'For when Komla was closed or the computer was asleep at the scheduled time.'}{' '}
            Only the latest missed run starts.
          </p>
        </div>
      )}
    </div>
  );
}
