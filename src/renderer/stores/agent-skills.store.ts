import { create } from 'zustand';

import type { AgentSkill, AgentSkillFamily } from '../../shared/types/agent-skill';

/** Names one listing: an agent's skills for a project, on an SSH host or this computer. */
export function skillListingKey(
  family: AgentSkillFamily,
  projectId: string | null,
  hostId: string | null
): string {
  return JSON.stringify([family, projectId, hostId]);
}

interface AgentSkillsState {
  /** The last listing of each key, kept while it's listed again. */
  listings: Record<string, AgentSkill[]>;
  /** Lists the skills again; a listing already on its way is shared. */
  loadSkills: (
    family: AgentSkillFamily,
    projectId: string | null,
    hostId: string | null
  ) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

export const useAgentSkillsStore = create<AgentSkillsState>((set) => ({
  listings: {},

  loadSkills: (family, projectId, hostId) => {
    const key = skillListingKey(family, projectId, hostId);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const load = window.api
      .listAgentSkills(family, projectId, hostId)
      .then((skills) => set((state) => ({ listings: { ...state.listings, [key]: skills } })))
      .catch(() => {})
      .finally(() => inFlight.delete(key));
    inFlight.set(key, load);
    return load;
  },
}));
