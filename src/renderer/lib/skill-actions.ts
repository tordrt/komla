import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { resolveLaunchablePresets } from '@/lib/agent-launch';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { skillListingKey, useAgentSkillsStore } from '@/stores/agent-skills.store';

import { promptSkillFamily, skillInvocation } from '../../shared/lib/agent-skills';
import { AGENT_SKILL_FAMILIES } from '../../shared/types/agent-skill';

import type { AgentSkill, AgentSkillFamily, AgentSkillPlace } from '../../shared/types/agent-skill';
import type { ActionMenuGroup, SkillAction, SkillActionSkill } from '@/lib/action-menu-order';
import type { ActivePresetEntry, AgentPreset } from '@/types';

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

/**
 * The Skills group of a workspace's Quick Commands, from the last listings: each agent's skills,
 * by name, starting that agent. Empty until a listing has skills.
 */
export function getSkillMenuGroups(
  listings: Record<string, AgentSkill[]>,
  workspaceId: string,
  agents: SkillAgentPreset[]
): ActionMenuGroup[] {
  const place: AgentSkillPlace = { kind: 'workspace', workspaceId };
  const actions: SkillAction[] = agents.flatMap(({ family, preset, launchModeId }) => {
    const skills = listings[skillListingKey(family, place)] ?? [];
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
          skill: {
            family,
            name: skill.name,
            description: skill.description,
            source: skill.source,
            folder: skill.folder,
            place,
          },
        };
      });
  });
  return actions.length > 0 ? [{ type: 'skill', label: 'Skills', actions }] : [];
}

/** A listed skill's instructions, read again where its agent finds it, or null once it's gone. */
export function readSkillText(
  skill: Pick<SkillActionSkill, 'family' | 'name' | 'place'>
): Promise<string | null> {
  return window.api.readAgentSkill(skill.family, skill.place, skill.name);
}

const NO_PRESETS: AgentPreset[] = [];
const NO_ACTIVE_PRESETS: ActivePresetEntry[] = [];
const NO_LISTINGS: Record<string, AgentSkill[]> = {};

/** The listings of a workspace's own skills, one per agent family. */
function workspaceListings(
  listings: Record<string, AgentSkill[]>,
  workspaceId: string
): Record<string, AgentSkill[]> {
  const place: AgentSkillPlace = { kind: 'workspace', workspaceId };
  const picked: Record<string, AgentSkill[]> = {};
  for (const family of AGENT_SKILL_FAMILIES) {
    const key = skillListingKey(family, place);
    if (listings[key]) picked[key] = listings[key];
  }
  return picked;
}

/**
 * The Skills group a workspace's Quick Commands list shows, its agents' skills in its own folder
 * and in the home folder where it runs, and `loadSkills` for the menu holding the list to call as
 * it opens: the last listing shows at once, and the skills are listed again only when someone
 * looks. Empty without a workspace, and while `listen` is false, for a menu that's closed, which
 * then doesn't re-render as skills and agents change.
 */
export function useSkillMenuGroups(
  workspaceId: string | null | undefined,
  listen = true
): {
  skillGroups: ActionMenuGroup[];
  loadSkills: () => void;
} {
  const active = listen && !!workspaceId;
  const presets = useAgentPresetsStore((state) => (active ? state.presets : NO_PRESETS));
  const activePresets = useAgentPresetsStore((state) =>
    active ? state.activePresets : NO_ACTIVE_PRESETS
  );
  const listings = useAgentSkillsStore(
    useShallow((state) =>
      active && workspaceId ? workspaceListings(state.listings, workspaceId) : NO_LISTINGS
    )
  );
  const skillGroups = useMemo(
    () =>
      active && workspaceId
        ? getSkillMenuGroups(listings, workspaceId, skillAgentPresets(presets, activePresets))
        : [],
    [active, listings, workspaceId, presets, activePresets]
  );
  const loadSkills = useCallback(() => {
    if (!workspaceId) return;
    const { presets: allPresets, activePresets: allActive } = useAgentPresetsStore.getState();
    const { loadSkills: load } = useAgentSkillsStore.getState();
    for (const { family } of skillAgentPresets(allPresets, allActive)) {
      void load(family, { kind: 'workspace', workspaceId });
    }
  }, [workspaceId]);
  return { skillGroups, loadSkills };
}
