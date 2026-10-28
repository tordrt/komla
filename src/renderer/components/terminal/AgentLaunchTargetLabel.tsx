import { getLaunchModeColor, LAUNCH_MODE_PILL_CLASSES } from '@/lib/launch-mode-colors';
import { cn } from '@/lib/utils';

import { AgentPresetIcon } from './AgentPresetIcon';

import type { AgentPreset } from '@/types';

function getLaunchModeAccentClass(mode: AgentPreset['launchModes'][number], index: number) {
  return LAUNCH_MODE_PILL_CLASSES[getLaunchModeColor(mode.color, index)];
}

interface AgentLaunchTargetLabelProps {
  presets: AgentPreset[];
  target: { presetId: string; launchModeId: string | null } | null;
}

function resolveAgentLaunchTarget({ presets, target }: AgentLaunchTargetLabelProps) {
  const preset = target
    ? (presets.find((candidate) => candidate.id === target.presetId) ?? null)
    : null;
  const modeIndex = target?.launchModeId
    ? (preset?.launchModes.findIndex((mode) => mode.id === target.launchModeId) ?? -1)
    : -1;
  const mode = preset && modeIndex >= 0 ? preset.launchModes[modeIndex] : null;

  return { preset, mode, modeIndex };
}

export function AgentLaunchTargetIcon({ presets, target }: AgentLaunchTargetLabelProps) {
  const { preset, mode, modeIndex } = resolveAgentLaunchTarget({ presets, target });

  return (
    <span
      role={mode ? 'img' : undefined}
      aria-label={mode ? `${mode.name} launch mode` : undefined}
      aria-hidden={mode ? undefined : true}
      title={mode?.name}
      // The negative margin takes it to a menu icon's 14px width, so its label lines up.
      className={cn(
        '-mx-[3px] flex size-5 shrink-0 items-center justify-center rounded-md shadow-xs ring-1 ring-inset',
        mode
          ? getLaunchModeAccentClass(mode, modeIndex)
          : 'bg-muted/60 text-foreground ring-border/60'
      )}
    >
      <AgentPresetIcon preset={preset} className="size-3.5" />
    </span>
  );
}

export function AgentLaunchTargetLabel(props: AgentLaunchTargetLabelProps) {
  const { preset } = resolveAgentLaunchTarget(props);
  if (!preset) return <>AI Agent</>;

  return <span className="truncate">{preset.name}</span>;
}
