import { CaretRight, Check, GearSix } from '@phosphor-icons/react';

import { ContextMenuCheckboxItem, ContextMenuItem } from '@/components/ui/context-menu';
import { DropdownMenuCheckboxItem, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { isSameLaunchTarget, type LaunchTarget } from '@/lib/agent-launch';
import { getLaunchModeColor, LAUNCH_MODE_TEXT_CLASSES } from '@/lib/launch-mode-colors';
import { cn } from '@/lib/utils';

import { AgentPresetIcon } from './AgentPresetIcon';

import type { AgentPreset } from '@/types';

interface AgentLaunchPickerMatrixProps {
  presets: AgentPreset[];
  inspectedPresetId: string | null;
  onInspectPreset: (presetId: string) => void;
  selectedTarget?: LaunchTarget | null;
  selectedTargets?: LaunchTarget[];
  onSelectTarget?: (target: LaunchTarget) => void;
  onToggleTarget?: (target: LaunchTarget) => void;
  getPreferredLaunchModeId?: (preset: AgentPreset) => string | null;
  menuType?: 'context' | 'dropdown';
  heightPresets?: AgentPreset[];
  /** Adds a "Manage agents…" item under the agents, e.g. to open Settings → Agents. */
  onManageAgents?: () => void;
  /**
   * With only one agent, shows "Edit <agent>…" in place of "Manage agents…", e.g. to open that
   * agent's editor in Settings → Agents.
   */
  onEditAgent?: (presetId: string) => void;
}

// The tallest column any agent could need, so moving between agents never resizes the menu.
// The agent column ends in "Manage agents…", as the mode column does with only one agent.
function stableRowCount(
  presets: AgentPreset[],
  options: { isSinglePreset: boolean; hasManageRow: boolean }
): number {
  const { isSinglePreset, hasManageRow } = options;
  const modeColumnRows = (preset: AgentPreset) =>
    preset.launchModes.length + 1 + Number(isSinglePreset && hasManageRow);
  return Math.max(
    isSinglePreset ? 0 : presets.length + Number(hasManageRow),
    ...presets.map(modeColumnRows)
  );
}

export function AgentLaunchPickerMatrix({
  presets,
  inspectedPresetId,
  onInspectPreset,
  selectedTarget,
  selectedTargets,
  onSelectTarget,
  onToggleTarget,
  getPreferredLaunchModeId,
  menuType = 'dropdown',
  heightPresets = presets,
  onManageAgents,
  onEditAgent,
}: AgentLaunchPickerMatrixProps) {
  const isMultiSelect = selectedTargets !== undefined;
  const isSinglePreset = presets.length === 1;
  const inspectedPreset =
    presets.find((preset) => preset.id === inspectedPresetId) ??
    presets.find((preset) => preset.id === selectedTarget?.presetId) ??
    presets[0];
  // Sized from heightPresets alone, so switching to multi-select, which may list fewer agents and
  // drops the manage row, keeps the menu's height.
  const isSingleHeightPreset = heightPresets.length === 1;
  const stablePickerRowCount = stableRowCount(heightPresets, {
    isSinglePreset: isSingleHeightPreset,
    hasManageRow: Boolean(onManageAgents || (isSingleHeightPreset && onEditAgent)),
  });
  const stablePickerHeightRem =
    stablePickerRowCount * 1.75 + Math.max(0, stablePickerRowCount - 1) * 0.125;
  const MenuItem = menuType === 'context' ? ContextMenuItem : DropdownMenuItem;
  const CheckboxItem = isMultiSelect
    ? menuType === 'context'
      ? ContextMenuCheckboxItem
      : DropdownMenuCheckboxItem
    : null;
  const indicatedTarget =
    !isMultiSelect && inspectedPreset
      ? selectedTarget?.presetId === inspectedPreset.id
        ? selectedTarget
        : getPreferredLaunchModeId
          ? {
              presetId: inspectedPreset.id,
              launchModeId: getPreferredLaunchModeId(inspectedPreset),
            }
          : null
      : null;
  // With one agent, its own editor is the useful way in; the agent list is a step back from it.
  const editSinglePreset = isSinglePreset && onEditAgent && inspectedPreset;
  const manageAgentsItem = !isMultiSelect && (editSinglePreset || onManageAgents) && (
    <MenuItem
      className="mt-auto min-h-7 w-full justify-start gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground"
      onSelect={() => (editSinglePreset ? onEditAgent(inspectedPreset.id) : onManageAgents?.())}
    >
      <GearSix className="size-3.5 shrink-0" />
      <span className="truncate">
        {editSinglePreset ? `Edit ${inspectedPreset.name}…` : 'Manage agents…'}
      </span>
    </MenuItem>
  );

  return (
    <div
      className={cn(
        'grid min-w-0 px-1',
        isSinglePreset
          ? 'grid-cols-1'
          : 'w-[calc(min(22rem,100vw-2rem)-10px)] grid-cols-[minmax(7.5rem,1fr)_minmax(9rem,1fr)] group-data-[side=left]/agent-launch-picker:grid-cols-[minmax(9rem,1fr)_minmax(7.5rem,1fr)] group-data-[side=left]/agent-launch-picker:[&>[data-agent-launch-modes]]:order-1 group-data-[side=left]/agent-launch-picker:[&>[data-agent-launch-modes]]:pl-0 group-data-[side=left]/agent-launch-picker:[&>[data-agent-launch-modes]]:pr-1 group-data-[side=left]/agent-launch-picker:[&_[data-agent-preset-caret]]:rotate-180 group-data-[side=left]/agent-launch-picker:[&>[data-agent-presets]]:order-2 group-data-[side=left]/agent-launch-picker:[&>[data-agent-presets]]:border-l group-data-[side=left]/agent-launch-picker:[&>[data-agent-presets]]:border-r-0 group-data-[side=left]/agent-launch-picker:[&>[data-agent-presets]]:pl-1 group-data-[side=left]/agent-launch-picker:[&>[data-agent-presets]]:pr-0'
      )}
      data-agent-launch-matrix
      data-agent-launch-layout={isSinglePreset ? 'compact' : 'matrix'}
      style={{ minHeight: `${stablePickerHeightRem}rem` }}
    >
      {!isSinglePreset && (
        <div
          className="flex min-w-0 flex-col gap-0.5 border-r border-border/60 pr-1"
          data-agent-presets
        >
          {presets.map((preset) => {
            const isInspected = inspectedPreset?.id === preset.id;
            const selectedTargetCount =
              selectedTargets?.filter((target) => target.presetId === preset.id).length ?? 0;
            const preferredLaunchModeId = getPreferredLaunchModeId?.(preset) ?? null;
            const preferredModeName = preferredLaunchModeId
              ? preset.launchModes.find((mode) => mode.id === preferredLaunchModeId)?.name
              : 'Default';
            const presetActionLabel = isMultiSelect
              ? `Show ${preset.name} launch modes`
              : `Show ${preset.name} launch modes; select to use ${preferredModeName ?? 'Default'}`;

            return (
              <MenuItem
                key={preset.id}
                aria-label={presetActionLabel}
                className={cn(
                  'min-h-7 w-full justify-start gap-2 rounded-md px-2 py-1 text-xs',
                  !isMultiSelect &&
                    selectedTarget?.presetId === preset.id &&
                    'font-medium text-foreground',
                  isInspected && 'bg-foreground/8 text-foreground'
                )}
                title={presetActionLabel}
                onMouseEnter={() => onInspectPreset(preset.id)}
                onFocus={() => onInspectPreset(preset.id)}
                onSelect={(event) => {
                  if (!isMultiSelect && getPreferredLaunchModeId && onSelectTarget) {
                    onSelectTarget({
                      presetId: preset.id,
                      launchModeId: preferredLaunchModeId,
                    });
                    return;
                  }
                  event.preventDefault();
                  onInspectPreset(preset.id);
                }}
              >
                <AgentPresetIcon preset={preset} className="size-3.5 shrink-0" />
                <span className="truncate">{preset.name}</span>
                {isMultiSelect && selectedTargetCount > 0 && (
                  <span className="ml-auto text-2xs font-medium text-primary">
                    {selectedTargetCount}
                  </span>
                )}
                <CaretRight
                  data-agent-preset-caret
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground-70',
                    selectedTargetCount === 0 && 'ml-auto'
                  )}
                />
              </MenuItem>
            );
          })}
          {manageAgentsItem}
        </div>
      )}
      {inspectedPreset && (
        <div
          className={cn('flex min-w-0 flex-col gap-0.5', !isSinglePreset && 'pl-1')}
          data-agent-launch-modes
        >
          <div className="space-y-0.5">
            {[{ id: null, name: 'Default', color: undefined }, ...inspectedPreset.launchModes].map(
              (candidateMode, candidateModeIndex) => {
                const target = {
                  presetId: inspectedPreset.id,
                  launchModeId: candidateMode.id,
                };
                const isSelected = isMultiSelect
                  ? selectedTargets.some((candidate) => isSameLaunchTarget(candidate, target))
                  : indicatedTarget?.presetId === target.presetId &&
                    indicatedTarget.launchModeId === target.launchModeId;
                const modeColor = candidateMode.id
                  ? getLaunchModeColor(candidateMode.color, candidateModeIndex - 1)
                  : null;
                const label = `${inspectedPreset.name}, ${candidateMode.name}`;
                // A bar and the name in the mode's color; Default keeps the text color.
                const modeName = (
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-2',
                      modeColor && LAUNCH_MODE_TEXT_CLASSES[modeColor]
                    )}
                    data-launch-mode-color={modeColor ?? 'default'}
                  >
                    <span
                      className={cn(
                        'h-3.5 w-[3px] shrink-0 rounded-full',
                        modeColor ? 'bg-current' : 'bg-muted-foreground/35'
                      )}
                    />
                    <span className="truncate">{candidateMode.name}</span>
                  </span>
                );

                if (isMultiSelect) {
                  if (!CheckboxItem) return null;
                  return (
                    <CheckboxItem
                      key={candidateMode.id ?? 'default'}
                      aria-label={label}
                      checked={isSelected}
                      className={cn(
                        'min-h-7 w-full rounded-md py-1 pr-2 text-xs',
                        isSelected && 'bg-foreground/8'
                      )}
                      onCheckedChange={() => onToggleTarget?.(target)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {modeName}
                    </CheckboxItem>
                  );
                }

                return (
                  <MenuItem
                    key={candidateMode.id ?? 'default'}
                    aria-label={label}
                    className={cn(
                      'min-h-7 w-full justify-start gap-2 rounded-md px-2 py-1 text-xs',
                      isSelected && 'bg-foreground/8'
                    )}
                    onSelect={() => onSelectTarget?.(target)}
                  >
                    {modeName}
                    {isSelected && (
                      <Check
                        data-testid="launch-mode-check"
                        weight="bold"
                        className="ml-auto size-3 text-muted-foreground"
                      />
                    )}
                  </MenuItem>
                );
              }
            )}
          </div>
          {isSinglePreset && manageAgentsItem && <div className="mt-auto">{manageAgentsItem}</div>}
        </div>
      )}
    </div>
  );
}
