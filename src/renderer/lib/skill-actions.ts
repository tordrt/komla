import { useCallback, useMemo } from 'react';

import { resolveLaunchablePresets } from '@/lib/agent-launch';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { skillListingKey, useAgentSkillsStore } from '@/stores/agent-skills.store';
import { isSshWorkspace } from '@/types';

import { promptSkillFamily, skillInvocation } from '../../shared/lib/agent-skills';

import type { AgentSkill, AgentSkillFamily } from '../../shared/types/agent-skill';
import type { ActionMenuGroup, SkillAction } from '@/lib/action-menu-order';
import type { ActivePresetEntry, AgentPreset, Workspace } from '@/types';

/** The agent each skill family starts with: its most recently used preset, in its last mode. */
export interface SkillAgentPreset {
  family: AgentSkillFamily;
  preset: AgentPreset;
  launchModeId: string | undefined;
}

export function skillAgentPresets(
  presets: AgentPreset[],
  activePresets: ActivePresetEntry[]
): SkillAgentPreset[] {
  const launchable = resolveLaunchablePresets(presets, activePresets);
  const byRecentUse = [...activePresets].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const found = new Map<AgentSkillFamily, SkillAgentPreset>();
  for (const entry of byRecentUse) {
    const preset = launchable.find((candidate) => candidate.id === entry.presetId);
    const family = promptSkillFamily(preset);
    if (!preset || !family || found.has(family)) continue;
    found.set(family, {
      family,
      preset,
      launchModeId: entry.lastLaunchModeId ?? undefined,
    });
  }
  return [...found.values()];
}

/** Where a workspace's agents run: its SSH host, or null for this computer. */
export function workspaceSkillHostId(
  workspace: Pick<Workspace, 'backend'> | undefined
): string | null {
  return workspace && isSshWorkspace(workspace) ? workspace.backend.hostId : null;
}

/**
 * The Skills group of a workspace's Quick Commands, from the last listings: each agent's skills,
 * by name, starting that agent. Empty until a listing has skills.
 */
export function getSkillMenuGroups(
  listings: Record<string, AgentSkill[]>,
  projectId: string | null,
  hostId: string | null,
  agents: SkillAgentPreset[]
): ActionMenuGroup[] {
  const actions: SkillAction[] = agents.flatMap(({ family, preset, launchModeId }) => {
    const skills = listings[skillListingKey(family, projectId, hostId)] ?? [];
    return [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => {
        const invocation = skillInvocation(family, skill.name);
        return {
          id: `skill:${family}:${skill.name}`,
          title: invocation,
          content: invocation,
          type: 'prompt' as const,
          presetId: preset.id,
          launchModeId,
          skill: { family, description: skill.description, source: skill.source },
        };
      });
  });
  return actions.length > 0 ? [{ type: 'skill', label: 'Skills', actions }] : [];
}

/**
 * The Skills group a workspace's Quick Commands list shows, and `loadSkills` for the menu holding
 * the list to call as it opens, so the skills are listed again only when someone looks. Takes
 * the workspace's project and SSH host (see workspaceSkillHostId) rather than the workspace, so
 * the menus don't redraw on its every change.
 */
export function useSkillMenuGroups(
  projectId: string | null | undefined,
  hostId: string | null
): { skillGroups: ActionMenuGroup[]; loadSkills: () => void } {
  const presets = useAgentPresetsStore((state) => state.presets);
  const activePresets = useAgentPresetsStore((state) => state.activePresets);
  const listings = useAgentSkillsStore((state) => state.listings);
  const agents = useMemo(() => skillAgentPresets(presets, activePresets), [presets, activePresets]);
  const skillGroups = useMemo(
    () => getSkillMenuGroups(listings, projectId ?? null, hostId, agents),
    [listings, projectId, hostId, agents]
  );
  const loadSkills = useCallback(() => {
    const { loadSkills: load } = useAgentSkillsStore.getState();
    for (const { family } of agents) void load(family, projectId ?? null, hostId);
  }, [agents, projectId, hostId]);
  return { skillGroups, loadSkills };
}
