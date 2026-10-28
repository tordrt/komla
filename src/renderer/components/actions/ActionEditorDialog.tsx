import { CaretDown, Sparkle, Terminal, Trash } from '@phosphor-icons/react';
import { useId, useMemo, useRef, useState } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
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
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';

import { canStartWithPrompt } from '../../../shared/lib/agent-preset-prompt';
import { ACTION_SSH_EXECUTION_LOCATIONS } from '../../../shared/types/action';

import type { Action, ActionSshExecutionLocation, ActionType, AgentPreset, Project } from '@/types';

export interface ActionEditorValues {
  title: string;
  content: string;
  type: ActionType;
  projectIds: string[];
  presetId: string | undefined;
  launchModeId: string | undefined;
  sshExecutionLocation: ActionSshExecutionLocation | null;
  background: boolean;
}

interface ActionEditorDialogProps {
  /** The Action to edit; null creates a new one. */
  action: Action | null;
  /** Projects a new Action starts scoped to. */
  defaultProjectIds?: string[];
  defaultAdvancedOpen?: boolean;
  presets: AgentPreset[];
  projects: Project[];
  isSaving: boolean;
  onSave: (values: ActionEditorValues) => void;
  onClose: () => void;
  onRequestDelete?: () => void;
  /** Where focus goes on close when what opened the editor is gone, such as a menu item. */
  returnFocus?: () => void;
}

/**
 * Creates or edits one Action. Rendered while open, so every open starts from the
 * Action's saved values. Closing with unsaved edits asks first.
 */
export function ActionEditorDialog({
  action,
  defaultProjectIds = [],
  defaultAdvancedOpen = false,
  presets,
  projects,
  isSaving,
  onSave,
  onClose,
  onRequestDelete,
  returnFocus,
}: ActionEditorDialogProps) {
  const isCreateMode = action === null;
  const initialType: ActionType = action?.type ?? (isCreateMode ? 'command' : 'prompt');
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const focusBeforePromptRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const fieldId = useId();

  // Seeded from `action` once and never re-synced. If actions.json changes externally
  // (second window, hand-edit) while the editor is open, the user's typing wins on save.
  const [title, setTitle] = useState(action?.title ?? '');
  const [content, setContent] = useState(action?.content ?? '');
  const [type, setType] = useState<ActionType>(initialType);
  const [projectIds, setProjectIds] = useState<string[]>(
    action?.projectIds ?? (isCreateMode ? defaultProjectIds : [])
  );
  const [presetId, setPresetId] = useState<string | undefined>(action?.presetId);
  const [launchModeId, setLaunchModeId] = useState<string | undefined>(action?.launchModeId);
  const [sshExecutionLocation, setSshExecutionLocation] = useState<
    ActionSshExecutionLocation | undefined
  >(action?.sshExecutionLocation);
  const [background, setBackground] = useState(action?.background ?? false);
  const hasSshHosts = useSshHostsStore((s) => s.hosts.length > 0);
  const [advancedOpen, setAdvancedOpen] = useState(defaultAdvancedOpen);
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);

  const selectedPreset = useMemo(() => presets.find((p) => p.id === presetId), [presets, presetId]);
  const availableLaunchModes = useMemo(() => selectedPreset?.launchModes ?? [], [selectedPreset]);

  // A launch mode the preset no longer has counts as none, so dropping it isn't an edit.
  // Until the preset resolves (presets still loading, or a deleted preset), the saved
  // mode is kept rather than silently dropped on save.
  const presetResolved = !presetId || selectedPreset !== undefined;
  const resolveLaunchModeId = (id: string | undefined) =>
    presetResolved && id && !availableLaunchModes.some((m) => m.id === id) ? undefined : id;
  const effectiveLaunchModeId = resolveLaunchModeId(launchModeId);

  // Frozen at mount so external updates to `action` don't shift the dirty baseline.
  const [initialValues] = useState(() => ({
    title: action?.title ?? '',
    content: action?.content ?? '',
    type: initialType,
    projectIds: action?.projectIds ?? (isCreateMode ? defaultProjectIds : []),
    presetId: action?.presetId,
    launchModeId: action?.launchModeId,
    sshExecutionLocation: action?.sshExecutionLocation,
    background: action?.background ?? false,
  }));

  const sameProjects =
    projectIds.length === initialValues.projectIds.length &&
    projectIds.every((id) => initialValues.projectIds.includes(id));

  const isDirty =
    title !== initialValues.title ||
    content !== initialValues.content ||
    type !== initialValues.type ||
    !sameProjects ||
    presetId !== initialValues.presetId ||
    effectiveLaunchModeId !== resolveLaunchModeId(initialValues.launchModeId) ||
    sshExecutionLocation !== initialValues.sshExecutionLocation ||
    // Only a Terminal Command saves Run in background.
    (type === 'command' && background) !== initialValues.background;

  const canSave = title.trim() !== '' && content.trim() !== '' && !isSaving;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      title,
      content,
      type,
      projectIds,
      presetId,
      launchModeId: effectiveLaunchModeId,
      sshExecutionLocation: type === 'command' ? (sshExecutionLocation ?? null) : null,
      background: type === 'command' && background,
    });
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

  const selectablePresets = presets.filter(canStartWithPrompt);
  // Kept for an Action that already has a location once its SSH hosts are gone.
  const showSshLocation = type === 'command' && (hasSshHosts || sshExecutionLocation !== undefined);
  const showAdvanced = projects.length > 0 || showSshLocation;
  const advancedSummary = [
    scopeSummary(projectIds, projects),
    showSshLocation && sshExecutionLocation ? SSH_LOCATION_LABELS[sshExecutionLocation] : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
            titleInputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Radix returns focus to a DialogTrigger; go back to whatever opened the editor,
            // or where the opener asked when that is gone (an item of a closed menu).
            event.preventDefault();
            const opener = openerRef.current;
            if (opener?.isConnected && opener !== document.body) opener.focus();
            else returnFocus?.();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              handleSave();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base">
              {isCreateMode ? 'New quick command' : 'Edit quick command'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Run it from the ▶ button in the tab bar or from a terminal's right-click menu.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid min-w-48 flex-1 gap-1.5">
                <label htmlFor={`${fieldId}-title`} className="text-[13px] font-medium">
                  Title
                </label>
                <Input
                  id={`${fieldId}-title`}
                  ref={titleInputRef}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={type === 'command' ? 'e.g., Dev server' : 'e.g., Review my changes'}
                  className="h-9"
                />
              </div>
              <SegmentedControl
                aria-label="Type"
                size="md"
                value={type}
                onValueChange={setType}
                className="h-9"
                options={[
                  {
                    value: 'command',
                    label: 'Terminal Command',
                    icon: <Terminal className="size-3" />,
                  },
                  { value: 'prompt', label: 'Saved Prompt', icon: <Sparkle className="size-3" /> },
                ]}
              />
            </div>

            {type === 'prompt' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label htmlFor={`${fieldId}-preset`} className="text-[13px] font-medium">
                    Agent preset
                  </label>
                  <Select
                    id={`${fieldId}-preset`}
                    value={presetId ?? ''}
                    className="h-9"
                    onChange={(e) => {
                      setPresetId(e.target.value || undefined);
                      setLaunchModeId(undefined);
                    }}
                  >
                    <option value="">Active preset (default)</option>
                    {selectablePresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {presetId && availableLaunchModes.length > 0 && (
                  <div className="grid gap-1.5">
                    <label htmlFor={`${fieldId}-launch-mode`} className="text-[13px] font-medium">
                      Launch mode
                    </label>
                    <Select
                      id={`${fieldId}-launch-mode`}
                      value={effectiveLaunchModeId ?? ''}
                      className="h-9"
                      onChange={(e) => setLaunchModeId(e.target.value || undefined)}
                    >
                      <option value="">Default</option>
                      {availableLaunchModes.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </div>
            )}

            <ActionContentField
              type={type}
              content={content}
              background={background}
              onChange={setContent}
            />

            {type === 'command' && (
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <Checkbox
                  checked={background}
                  onChange={(e) => setBackground(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-[13px] font-medium text-foreground">
                    Run in background
                  </span>
                  <span className="block text-muted-foreground">
                    No terminal tab: Komla notifies you when the command finishes or fails. For
                    commands that end on their own, such as tests or a CI watch, not dev servers.
                  </span>
                </span>
              </label>
            )}

            {showAdvanced && (
              <div>
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((open) => !open)}
                  className="-ml-2 flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                >
                  <span className="shrink-0">Advanced</span>
                  {!advancedOpen && (
                    <span className="min-w-0 truncate font-normal text-muted-foreground">
                      · {advancedSummary}
                    </span>
                  )}
                  <CaretDown
                    className={cn(
                      'size-3 shrink-0 transition-transform',
                      advancedOpen && 'rotate-180'
                    )}
                  />
                </button>
                {advancedOpen && (
                  <div className="mt-2 space-y-4">
                    {projects.length > 0 && (
                      <ProjectScopeField
                        projects={projects}
                        projectIds={projectIds}
                        onChange={setProjectIds}
                      />
                    )}
                    {showSshLocation && (
                      <SshExecutionLocationField
                        fieldId={fieldId}
                        location={sshExecutionLocation}
                        onChange={setSshExecutionLocation}
                      />
                    )}
                  </div>
                )}
              </div>
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
              <Button size="sm" onClick={handleSave} disabled={!canSave}>
                {isCreateMode ? 'Create quick command' : 'Save changes'}
                <Kbd className="ml-2 border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
                  {formatShortcutForDisplay('Cmd+Enter')}
                </Kbd>
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discardPromptOpen} onOpenChange={setDiscardPromptOpen}>
        <DialogContent
          role="alertdialog"
          className="max-w-sm !gap-0 !p-0"
          onCloseAutoFocus={(event) => {
            // Radix returns focus to a DialogTrigger, and there is none here.
            event.preventDefault();
            (focusBeforePromptRef.current ?? titleInputRef.current)?.focus();
          }}
        >
          <div className="space-y-2 px-5 pt-5 pb-4">
            <DialogTitle className="text-sm font-semibold">Unsaved changes</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
              Discard your changes to this quick command?
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-2 border-t border-border/30 px-5 py-3">
            <Button variant="ghost" size="sm" onClick={() => setDiscardPromptOpen(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" size="sm" onClick={onClose}>
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function scopeSummary(projectIds: string[], projects: Project[]): string {
  if (projectIds.length === 0) return 'All projects';
  if (projectIds.length === 1) {
    return projects.find((p) => p.id === projectIds[0])?.name ?? '1 project';
  }
  return `${projectIds.length} projects`;
}

function ActionContentField({
  type,
  content,
  background,
  onChange,
}: {
  type: ActionType;
  content: string;
  background: boolean;
  onChange: (value: string) => void;
}) {
  const label = type === 'command' ? 'Terminal Command' : 'Saved Prompt';
  return (
    <div className="overflow-hidden rounded-md border border-input transition-colors focus-within:border-foreground/30">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium tracking-wide uppercase">{label}</span>
        <span>
          {type !== 'command'
            ? 'Markdown'
            : background
              ? 'Runs in the background'
              : 'Opens in a new terminal tab'}
        </span>
      </div>
      {type === 'command' ? (
        // A textarea, so a command saved with several lines keeps them.
        <textarea
          aria-label={label}
          value={content}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g., npm run dev"
          spellCheck={false}
          rows={1}
          className="block field-sizing-content max-h-48 min-h-10 w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[13px] outline-hidden placeholder:text-muted-foreground/60"
        />
      ) : (
        <>
          <textarea
            aria-label={label}
            value={content}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Write prompt content in markdown..."
            rows={10}
            className="block max-h-[45vh] min-h-40 w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-hidden placeholder:text-muted-foreground/60"
          />
          <p className="border-t border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            <code>{'{{user_input}}'}</code> asks for text when you run it.{' '}
            <code>{'{{target_branch}}'}</code> is the workspace's target branch.
          </p>
        </>
      )}
    </div>
  );
}

function ProjectScopeField({
  projects,
  projectIds,
  onChange,
}: {
  projects: Project[];
  projectIds: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string, checked: boolean) => {
    onChange(checked ? projectIds.filter((existing) => existing !== id) : [...projectIds, id]);
  };

  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-[13px] font-medium">Projects</legend>
      <div className="max-h-40 overflow-y-auto rounded-md border border-input p-1">
        {projects.map((project) => {
          const checked = projectIds.includes(project.id);
          return (
            <label
              key={project.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
            >
              <Checkbox checked={checked} onChange={() => toggle(project.id, checked)} />
              <ProjectMark
                project={{ color: project.color, icon: project.icon }}
                dotClassName="size-2.5"
              />
              <span className="text-xs">{project.name}</span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {projectIds.length === 0
          ? 'Available in all projects. Check projects to show it only there.'
          : `Shown only in ${projectIds.length === 1 ? 'this project' : `these ${projectIds.length} projects`}.`}
      </p>
    </fieldset>
  );
}

const SSH_LOCATION_LABELS: Record<ActionSshExecutionLocation, string> = {
  remote: 'Remote machine',
  'local-mirror': 'This computer',
};

function SshExecutionLocationField({
  fieldId,
  location,
  onChange,
}: {
  fieldId: string;
  location: ActionSshExecutionLocation | undefined;
  onChange: (next: ActionSshExecutionLocation | undefined) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={`${fieldId}-ssh-location`} className="text-[13px] font-medium">
        SSH workspaces
      </label>
      <Select
        id={`${fieldId}-ssh-location`}
        value={location ?? ''}
        className="h-9"
        onChange={(e) =>
          onChange(ACTION_SSH_EXECUTION_LOCATIONS.find((value) => value === e.target.value))
        }
      >
        <option value="">Project setting</option>
        <option value="remote">{SSH_LOCATION_LABELS.remote}</option>
        <option value="local-mirror">{SSH_LOCATION_LABELS['local-mirror']}</option>
      </Select>
      <p className="text-xs text-muted-foreground">{renderSshLocationSummary(location)}</p>
    </div>
  );
}

function renderSshLocationSummary(location: ActionSshExecutionLocation | undefined): string {
  if (location === 'remote') {
    return 'Runs on the SSH host, even when this project runs Terminal Commands in the Local copy.';
  }
  if (location === 'local-mirror') {
    return 'Runs in the Local copy on this computer, even when this project runs Terminal Commands remotely. Runs remotely when the host can’t keep a Local copy.';
  }
  return 'Follows the project’s Run Terminal Commands on setting.';
}
