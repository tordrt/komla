import { useEffect } from 'react';

import { skillListingKey, useAgentSkillsStore } from '@/stores/agent-skills.store';

import type { AgentSkill, AgentSkillFamily } from '../../shared/types/agent-skill';

// One empty list, so a dialog with no skills doesn't rebuild what it derives from them.
const NO_SKILLS: AgentSkill[] = [];

/**
 * The skills the agent can invoke in a new workspace of the project, listed again each time
 * `enabled` turns on, on the SSH host when hostId is set. Empty while off or without an agent.
 */
export function useAgentSkills(
  family: AgentSkillFamily | null,
  projectId: string | null,
  hostId: string | null,
  enabled: boolean
): AgentSkill[] {
  const key = family && enabled ? skillListingKey(family, projectId, hostId) : null;
  const skills = useAgentSkillsStore((state) => (key ? state.listings[key] : undefined));

  useEffect(() => {
    if (!family || !enabled) return;
    void useAgentSkillsStore.getState().loadSkills(family, projectId, hostId);
  }, [family, projectId, hostId, enabled]);

  return skills ?? NO_SKILLS;
}
