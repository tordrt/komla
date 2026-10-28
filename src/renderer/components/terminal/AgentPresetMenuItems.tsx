import { Robot } from '@phosphor-icons/react';

import { MENU_PARTS } from '@/components/ui/menu-parts';
import {
  resolveDefaultLaunchTarget,
  resolveLaunchablePresets,
  resolveLaunchModeForPreset,
} from '@/lib/agent-launch';
import { cn } from '@/lib/utils';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { AgentLaunchPickerMatrix } from './AgentLaunchPickerMatrix';
import { AgentLaunchTargetIcon } from './AgentLaunchTargetLabel';

interface AgentPresetMenuItemsProps {
  workspaceId: string | null | undefined;
  menuType: 'context' | 'dropdown';
  /** Shown on the smart default's row. */
  newAgentShortcut?: string;
  /** Greys out the agent rows, leaving the Settings link that shows when none is set up. */
  disabled?: boolean;
  onLaunch: (presetId: string, launchModeId: string | null) => void;
}

/**
 * One row per active agent preset, the workspace's smart default first. A row launches
 * its preset in the mode it would use; its arrow lists the other modes. With no preset
 * active, a single row opens Settings → Agents.
 */
export function AgentPresetMenuItems({
  workspaceId,
  menuType,
  newAgentShortcut,
  disabled = false,
  onLaunch,
}: AgentPresetMenuItemsProps) {
  const { Item, Shortcut, Sub, SubContent, SubTrigger } = MENU_PARTS[menuType];
  const presets = useAgentPresetsStore((s) => s.presets);
  const activePresets = useAgentPresetsStore((s) => s.activePresets);
  const defaultLaunchModeId = useConfigStore((s) => s.config?.defaultLaunchModeId ?? null);
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));

  const launchablePresets = resolveLaunchablePresets(presets, activePresets);
  if (launchablePresets.length === 0) {
    return (
      <Item
        onSelect={() => {
          window.dispatchEvent(new CustomEvent('open-settings', { detail: 'agent' }));
        }}
      >
        <Robot />
        AI Agent
        <span className="text-2xs text-muted-foreground/60">Configure...</span>
      </Item>
    );
  }

  const defaultTarget = resolveDefaultLaunchTarget(
    workspace,
    launchablePresets,
    activePresets,
    defaultLaunchModeId
  );
  const defaultPreset = defaultTarget
    ? launchablePresets.find((preset) => preset.id === defaultTarget.presetId)
    : undefined;
  const orderedPresets = defaultPreset
    ? [defaultPreset, ...launchablePresets.filter((preset) => preset.id !== defaultPreset.id)]
    : launchablePresets;

  return orderedPresets.map((preset) => {
    const isDefault = preset.id === defaultPreset?.id;
    const target = {
      presetId: preset.id,
      launchModeId: resolveLaunchModeForPreset(preset, activePresets, defaultLaunchModeId),
    };
    const item = (
      <Item
        key={preset.id}
        disabled={disabled}
        className={cn(preset.launchModes.length > 0 && 'flex-1 pr-1')}
        onSelect={() => onLaunch(target.presetId, target.launchModeId)}
      >
        <AgentLaunchTargetIcon presets={launchablePresets} target={target} />
        <span className="truncate">{preset.name}</span>
        {isDefault && newAgentShortcut && <Shortcut>{newAgentShortcut}</Shortcut>}
      </Item>
    );
    if (preset.launchModes.length === 0) return item;
    return (
      <Sub key={preset.id}>
        <div className="flex items-stretch">
          {item}
          <SubTrigger
            aria-label={`${preset.name} launch modes`}
            disabled={disabled}
            className="ml-0.5 flex-none px-1.5"
          />
        </div>
        <SubContent className="group/agent-launch-picker">
          <AgentLaunchPickerMatrix
            menuType={menuType}
            presets={[preset]}
            inspectedPresetId={preset.id}
            onInspectPreset={() => {}}
            selectedTarget={target}
            onSelectTarget={(picked) => onLaunch(picked.presetId, picked.launchModeId)}
          />
        </SubContent>
      </Sub>
    );
  });
}
