import type { ActivePresetEntry, AgentPreset, Workspace } from '@/types';

/** Where a new workspace runs: this machine or an SSH host. */
export type WorkspaceEnvironmentTarget = 'local' | 'ssh';

export interface LaunchTarget {
  presetId: string;
  launchModeId: string | null;
}

export function isSameLaunchTarget(left: LaunchTarget, right: LaunchTarget): boolean {
  return left.presetId === right.presetId && left.launchModeId === right.launchModeId;
}

/** Toggle a launch target in an independent multi-selection. */
export function toggleLaunchTarget(targets: LaunchTarget[], target: LaunchTarget): LaunchTarget[] {
  const isSelected = targets.some((candidate) => isSameLaunchTarget(candidate, target));
  if (!isSelected) return [...targets, target];
  return targets.filter((candidate) => !isSameLaunchTarget(candidate, target));
}

/**
 * Pick the agent preset to launch when the user invokes "new agent tab" without
 * disambiguating: the workspace's own preset (if it isn't Shell Only), else the
 * most recently used active preset. Launch mode falls back to the per-preset
 * last-used mode, then the global default mode.
 */
export function resolveDefaultLaunchTarget(
  workspace: Workspace | undefined,
  presets: AgentPreset[],
  activePresets: ActivePresetEntry[],
  defaultLaunchModeId: string | null | undefined
): LaunchTarget | null {
  let preset: AgentPreset | undefined;
  if (workspace?.presetId) {
    const workspacePreset = presets.find((p) => p.id === workspace.presetId);
    if (workspacePreset && workspacePreset.name !== 'Shell Only') {
      preset = workspacePreset;
    }
  }
  if (!preset) {
    const sorted = [...activePresets].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const entry of sorted) {
      const candidate = presets.find((p) => p.id === entry.presetId);
      if (candidate && candidate.name !== 'Shell Only') {
        preset = candidate;
        break;
      }
    }
  }
  if (!preset) return null;

  return {
    presetId: preset.id,
    launchModeId: resolveLaunchModeForPreset(preset, activePresets, defaultLaunchModeId),
  };
}

export function resolveLaunchModeForPreset(
  preset: AgentPreset,
  activePresets: ActivePresetEntry[],
  defaultLaunchModeId: string | null | undefined
): string | null {
  const entry = activePresets.find((a) => a.presetId === preset.id);
  // Distinguish "user explicitly picked Default" (null) from "never recorded"
  // (undefined) — the former should win over the global default.
  if (entry && 'lastLaunchModeId' in entry) {
    if (entry.lastLaunchModeId === null) return null;
    if (entry.lastLaunchModeId && preset.launchModes.some((m) => m.id === entry.lastLaunchModeId)) {
      return entry.lastLaunchModeId;
    }
  }
  if (defaultLaunchModeId && preset.launchModes.some((m) => m.id === defaultLaunchModeId)) {
    return defaultLaunchModeId;
  }
  return null;
}

/**
 * Active presets in configured preset order, excluding the special Shell Only
 * entry — adding an "agent tab" with no agent isn't meaningful. The smart
 * default remains recency-aware via resolveDefaultLaunchTarget; the explicit
 * picker stays stable so menu positions do not jump after each launch.
 */
export function resolveLaunchablePresets(
  presets: AgentPreset[],
  activePresets: ActivePresetEntry[]
): AgentPreset[] {
  const activePresetIds = new Set(activePresets.map((entry) => entry.presetId));
  return presets.filter((preset) => activePresetIds.has(preset.id) && preset.name !== 'Shell Only');
}
