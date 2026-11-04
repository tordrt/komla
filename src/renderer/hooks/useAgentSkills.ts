import { useEffect, useState } from 'react';

import type { AgentSkill, AgentSkillFamily } from '../../shared/types/agent-skill';

// The last listing of each agent, project and host, shown while the dialog lists them again.
const listings = new Map<string, AgentSkill[]>();
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
  const key = family && enabled ? JSON.stringify([family, projectId, hostId]) : null;
  const [listed, setListed] = useState<{ key: string; skills: AgentSkill[] } | null>(null);

  useEffect(() => {
    if (!key || !family) return;
    let cancelled = false;
    window.api
      .listAgentSkills(family, projectId, hostId)
      .then((skills) => {
        listings.set(key, skills);
        if (!cancelled) setListed({ key, skills });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, family, projectId, hostId]);

  if (!key) return NO_SKILLS;
  return listed?.key === key ? listed.skills : (listings.get(key) ?? NO_SKILLS);
}
