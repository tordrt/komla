import { CaretDown, Check, Cloud, Desktop } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { AgentLaunchPickerMatrix } from '@/components/terminal/AgentLaunchPickerMatrix';
import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { stopWheelPropagation } from '@/lib/dialog-scroll-lock';
import { getLaunchModeColor, LAUNCH_MODE_PILL_CLASSES } from '@/lib/launch-mode-colors';
import { cn } from '@/lib/utils';

import type { AgentPreset, Project, SshHost } from '@/types';

/** The automation editor's pickers: menus styled as form fields, with the icons used elsewhere. */

const FIELD_TRIGGER_CLASS =
  'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-card px-3 text-left text-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-foreground/30';

export function FieldTrigger({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button id={id} type="button" className={FIELD_TRIGGER_CLASS}>
        {children}
        <CaretDown className="ml-auto size-4 shrink-0 opacity-50" />
      </button>
    </DropdownMenuTrigger>
  );
}

export const FIELD_MENU_CLASS =
  'max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-0 overflow-y-auto';

export function ProjectPicker({
  id,
  projects,
  projectId,
  onChange,
}: {
  id: string;
  projects: Project[];
  projectId: string;
  onChange: (projectId: string) => void;
}) {
  const selected = projects.find((project) => project.id === projectId);
  return (
    <DropdownMenu>
      <FieldTrigger id={id}>
        {selected ? (
          <>
            <ProjectMark project={selected} />
            <span className="truncate">{selected.name}</span>
          </>
        ) : (
          <span className="truncate text-muted-foreground">Choose a project</span>
        )}
      </FieldTrigger>
      <DropdownMenuContent
        align="start"
        className={FIELD_MENU_CLASS}
        onWheel={stopWheelPropagation}
      >
        {projects.length === 0 && (
          <DropdownMenuItem disabled>No projects can run here</DropdownMenuItem>
        )}
        {projects.map((project) => (
          <DropdownMenuItem key={project.id} onSelect={() => onChange(project.id)}>
            <ProjectMark project={project} />
            <span className="min-w-0 truncate">{project.name}</span>
            {project.id === projectId && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const LOCAL_TARGET_VALUE = 'local';

export function TargetPicker({
  id,
  hosts,
  target,
  onChange,
}: {
  id: string;
  hosts: SshHost[];
  /** `local` or `ssh:<host id>`. */
  target: string;
  onChange: (target: string) => void;
}) {
  const isLocal = target === LOCAL_TARGET_VALUE;
  const host = isLocal ? undefined : hosts.find((candidate) => `ssh:${candidate.id}` === target);
  const Icon = isLocal ? Desktop : Cloud;
  return (
    <DropdownMenu>
      <FieldTrigger id={id}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {isLocal ? 'This computer' : (host?.name ?? 'Removed SSH host')}
        </span>
      </FieldTrigger>
      <DropdownMenuContent
        align="start"
        className={FIELD_MENU_CLASS}
        onWheel={stopWheelPropagation}
      >
        <DropdownMenuItem onSelect={() => onChange(LOCAL_TARGET_VALUE)}>
          <Desktop />
          <span className="min-w-0 truncate">This computer</span>
          {isLocal && <Check className="ml-auto" />}
        </DropdownMenuItem>
        {hosts.map((candidate) => (
          <DropdownMenuItem key={candidate.id} onSelect={() => onChange(`ssh:${candidate.id}`)}>
            <Cloud />
            <span className="min-w-0 truncate">{candidate.name}</span>
            {target === `ssh:${candidate.id}` && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The agent and its launch mode in one menu, as the new workspace dialog picks them. */
export function AgentPicker({
  id,
  presets,
  presetId,
  launchModeId,
  getPreferredLaunchModeId,
  onChange,
}: {
  id: string;
  /** The agents offered, most recently used first. */
  presets: AgentPreset[];
  /** Empty for the active preset when the run starts. */
  presetId: string;
  launchModeId: string;
  getPreferredLaunchModeId: (preset: AgentPreset) => string | null;
  onChange: (presetId: string, launchModeId: string) => void;
}) {
  const [inspectedPresetId, setInspectedPresetId] = useState<string | null>(null);
  const selected = presets.find((preset) => preset.id === presetId);
  const modeIndex = selected?.launchModes.findIndex((mode) => mode.id === launchModeId) ?? -1;
  const mode = modeIndex >= 0 ? selected?.launchModes[modeIndex] : undefined;
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setInspectedPresetId(selected?.id ?? presets[0]?.id ?? null);
      }}
    >
      <FieldTrigger id={id}>
        <AgentPresetIcon preset={selected ?? null} className="size-3.5 shrink-0" />
        <span className="truncate">{selected?.name ?? 'Active preset (default)'}</span>
        {mode && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 text-xs leading-4 font-medium whitespace-nowrap',
              LAUNCH_MODE_PILL_CLASSES[getLaunchModeColor(mode.color, modeIndex)]
            )}
          >
            {mode.name}
          </span>
        )}
      </FieldTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-max max-w-[min(22rem,calc(100vw-2rem))] min-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto py-1"
        onWheel={stopWheelPropagation}
      >
        <DropdownMenuItem onSelect={() => onChange('', '')}>
          <AgentPresetIcon preset={null} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">Active preset (default)</span>
          {!presetId && <Check className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {presets.length === 0 ? (
          <DropdownMenuItem disabled>No agents can start with a prompt</DropdownMenuItem>
        ) : (
          <AgentLaunchPickerMatrix
            presets={presets}
            inspectedPresetId={inspectedPresetId}
            onInspectPreset={setInspectedPresetId}
            selectedTarget={
              selected ? { presetId: selected.id, launchModeId: mode?.id ?? null } : null
            }
            onSelectTarget={(target) => onChange(target.presetId, target.launchModeId ?? '')}
            getPreferredLaunchModeId={getPreferredLaunchModeId}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
