import { Check, Cloud, Robot, Warning, type Icon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Callout } from '@/components/ui/callout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { InfoTip } from '@/components/ui/info-tip';
import { stopWheelPropagation } from '@/lib/dialog-scroll-lock';
import { getLaunchModeColor, LAUNCH_MODE_TEXT_CLASSES } from '@/lib/launch-mode-colors';
import { cn } from '@/lib/utils';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';

import { skipsPermissionPrompts } from '../../../../shared/lib/launch-mode-permissions';

import { FIELD_MENU_CLASS, FieldTrigger } from './AutomationPickers';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

import type { AgentPreset, LaunchMode, SshHost } from '@/types';

// Defaults Komla Operations apply when an agent launches a workspace or tab
// through either adapter (the typed `komla` CLI or MCP).
export function AgentLaunchDefaultsCard() {
  return (
    <SettingsCard
      title="Komla CLI launch defaults"
      description="What agents start with komla agent launch or Komla's MCP tools."
    >
      <AgentLaunchDefaultsFields />
    </SettingsCard>
  );
}

/** The launch defaults' rows, for a SettingsCard in Settings or the dialog that introduces them. */
export function AgentLaunchDefaultsFields() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const presets = useAgentPresetsStore((s) => s.presets);
  const activePresets = useAgentPresetsStore((s) => s.activePresets);
  const activePresetIds = new Set(activePresets.map((ap) => ap.presetId));
  const activePresetOptions = presets.filter((p) => activePresetIds.has(p.id));
  const sshHosts = useSshHostsStore((state) => state.hosts);
  const readySshHosts = useMemo(() => sshHosts.filter((host) => !host.setupPending), [sshHosts]);
  const selectedAgentLaunchPreset = activePresetOptions.find(
    (p) => p.id === config?.agentLaunchDefaultPresetId
  );
  const pinnedLaunchMode = selectedAgentLaunchPreset?.launchModes.find(
    (m) => m.id === config?.agentLaunchDefaultLaunchModeId
  );

  return (
    <>
      <SettingsRow label="Default agent" description="Unless an agent names one">
        {({ controlId }) => (
          <div className="w-56">
            <PresetPicker
              id={controlId}
              presets={activePresetOptions}
              selected={selectedAgentLaunchPreset}
              onChange={(presetId) => {
                void updateConfig({
                  agentLaunchDefaultPresetId: presetId,
                  // Clear launch mode if preset changed
                  agentLaunchDefaultLaunchModeId: undefined,
                });
              }}
            />
          </div>
        )}
      </SettingsRow>
      <SettingsRow
        label="Default launch mode"
        description={
          <>
            Always allowed{' '}
            <InfoTip ariaLabel="About launch modes agents start" className="align-[-1px]">
              Agents may always start this mode, so pin one like --yolo here to let them use it
              everywhere. Other modes that skip permission prompts start only on an SSH host marked
              isolated, unless their robot button in Settings → Agents allows them anywhere.
            </InfoTip>
          </>
        }
      >
        {({ controlId }) => (
          <div className="w-56">
            <LaunchModePicker
              id={controlId}
              preset={selectedAgentLaunchPreset}
              selected={pinnedLaunchMode}
              onChange={(launchModeId) => {
                void updateConfig({ agentLaunchDefaultLaunchModeId: launchModeId });
              }}
            />
          </div>
        )}
      </SettingsRow>
      {/* A pin to a host that isn't set up refuses launches, so it stays here to change. */}
      {(readySshHosts.length > 0 || config?.agentLaunchDefaultSshHostId) && (
        <SettingsRow
          label="Where agents start"
          description={
            <>
              New tabs and workspaces{' '}
              <InfoTip ariaLabel="About where agents start" className="align-[-1px]">
                By default, a tab runs where its workspace does, and a new workspace starts where
                the calling agent runs, or, from this computer, where New Workspace last started
                one. A command run outside every workspace starts it on the computer or SSH host it
                ran on. An SSH host applies to new workspaces only.
              </InfoTip>
            </>
          }
        >
          {({ controlId }) => (
            <div className="w-56">
              <PlacementPicker
                id={controlId}
                hosts={readySshHosts}
                value={
                  config?.agentLaunchDefaultSshHostId
                    ? `ssh:${config.agentLaunchDefaultSshHostId}`
                    : ''
                }
                onChange={(value) => {
                  void updateConfig({
                    agentLaunchDefaultSshHostId: value.startsWith('ssh:')
                      ? value.slice('ssh:'.length)
                      : undefined,
                  });
                }}
              />
            </div>
          )}
        </SettingsRow>
      )}
      {pinnedLaunchMode && skipsPermissionPrompts(pinnedLaunchMode) && (
        <div>
          <Callout tone="warning">
            Agents can start {pinnedLaunchMode.name} anywhere, even on this computer.
          </Callout>
        </div>
      )}
    </>
  );
}

function PresetPicker({
  id,
  presets,
  selected,
  onChange,
}: {
  id: string;
  presets: AgentPreset[];
  selected: AgentPreset | undefined;
  onChange: (presetId: string | undefined) => void;
}) {
  return (
    <DropdownMenu>
      <FieldTrigger id={id}>
        <AgentPresetIcon preset={selected ?? null} className="size-3.5 shrink-0" />
        <span className="truncate">{selected?.name ?? 'Most recent'}</span>
      </FieldTrigger>
      <DropdownMenuContent
        align="start"
        className={FIELD_MENU_CLASS}
        onWheel={stopWheelPropagation}
      >
        <DropdownMenuItem onSelect={() => onChange(undefined)}>
          <AgentPresetIcon preset={null} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">Most recent</span>
          {!selected && <Check className="ml-auto" />}
        </DropdownMenuItem>
        {presets.map((preset) => (
          <DropdownMenuItem key={preset.id} onSelect={() => onChange(preset.id)}>
            <AgentPresetIcon preset={preset} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{preset.name}</span>
            {preset.id === selected?.id && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The mode's name beside a bar in its color, as the agent launch menus show it. */
function LaunchModeLabel({ mode, index }: { mode?: LaunchMode; index: number }) {
  const color = mode ? getLaunchModeColor(mode.color, index) : null;
  return (
    <span
      className={cn('flex min-w-0 items-center gap-2', color && LAUNCH_MODE_TEXT_CLASSES[color])}
    >
      <span
        className={cn(
          'h-3.5 w-[3px] shrink-0 rounded-full',
          color ? 'bg-current' : 'bg-muted-foreground/35'
        )}
      />
      <span className="truncate">{mode?.name ?? 'Default'}</span>
    </span>
  );
}

/** Agents start Default unless an agent and mode are pinned, so a mode needs an agent first. */
function LaunchModePicker({
  id,
  preset,
  selected,
  onChange,
}: {
  id: string;
  preset: AgentPreset | undefined;
  selected: LaunchMode | undefined;
  onChange: (launchModeId: string | undefined) => void;
}) {
  const modes = preset?.launchModes ?? [];
  return (
    <DropdownMenu>
      <FieldTrigger id={id} disabled={!preset}>
        <LaunchModeLabel mode={selected} index={selected ? modes.indexOf(selected) : -1} />
      </FieldTrigger>
      <DropdownMenuContent
        align="start"
        className={FIELD_MENU_CLASS}
        onWheel={stopWheelPropagation}
      >
        <DropdownMenuItem onSelect={() => onChange(undefined)}>
          <LaunchModeLabel index={-1} />
          {!selected && <Check className="ml-auto" />}
        </DropdownMenuItem>
        {modes.map((mode, index) => (
          <DropdownMenuItem key={mode.id} onSelect={() => onChange(mode.id)}>
            <LaunchModeLabel mode={mode} index={index} />
            {mode.id === selected?.id && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Where agent launches start: `''` for where the calling agent runs, or `ssh:<host id>`. */
function PlacementPicker({
  id,
  hosts,
  value,
  onChange,
}: {
  id: string;
  hosts: SshHost[];
  value: string;
  onChange: (value: string) => void;
}) {
  const options: Array<{ value: string; label: string; Icon: Icon; note?: string }> = [
    { value: '', label: 'Same as calling agent', Icon: Robot },
    ...hosts.map((host) => ({
      value: `ssh:${host.id}`,
      label: host.name,
      Icon: Cloud,
      note: host.isolated ? 'isolated' : undefined,
    })),
  ];
  // A deleted host, or one still being set up, isn't where agents start.
  const selected = options.find((option) => option.value === value) ?? {
    value,
    label: 'Unavailable',
    Icon: Warning,
  };
  return (
    <DropdownMenu>
      <FieldTrigger id={id}>
        <selected.Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{selected.label}</span>
      </FieldTrigger>
      <DropdownMenuContent
        align="start"
        className={FIELD_MENU_CLASS}
        onWheel={stopWheelPropagation}
      >
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
            <option.Icon />
            <span className="min-w-0 truncate">{option.label}</span>
            {option.note && <span className="text-xs text-muted-foreground">{option.note}</span>}
            {option.value === selected.value && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
