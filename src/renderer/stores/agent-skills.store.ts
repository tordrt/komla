import { create } from 'zustand';

import type { AgentSkill, AgentSkillFamily, AgentSkillPlace } from '../../shared/types/agent-skill';

/** Names one listing: an agent's skills where it will run (see AgentSkillPlace). */
export function skillListingKey(family: AgentSkillFamily, place: AgentSkillPlace): string {
  return JSON.stringify(
    place.kind === 'workspace'
      ? [family, place.kind, place.workspaceId]
      : [family, place.kind, place.projectId, place.hostId]
  );
}

interface AgentSkillsState {
  /** The last listing of each key, kept while it's listed again. */
  listings: Record<string, AgentSkill[]>;
  /** Lists the skills again; a listing already on its way is shared. */
  loadSkills: (family: AgentSkillFamily, place: AgentSkillPlace) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

function sameSkills(a: AgentSkill[] | undefined, b: AgentSkill[]): boolean {
  return (
    a !== undefined &&
    a.length === b.length &&
    a.every(
      (skill, i) =>
        skill.name === b[i].name &&
        skill.description === b[i].description &&
        skill.source === b[i].source &&
        skill.folder === b[i].folder
    )
  );
}

export const useAgentSkillsStore = create<AgentSkillsState>((set) => ({
  listings: {},

  loadSkills: (family, place) => {
    const key = skillListingKey(family, place);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const load = window.api
      .listAgentSkills(family, place)
      .then((skills) =>
        set((state) =>
          // The same listing again keeps the menus that show it from drawing it again
          sameSkills(state.listings[key], skills)
            ? state
            : { listings: { ...state.listings, [key]: skills } }
        )
      )
      .catch(() => {})
      .finally(() => inFlight.delete(key));
    inFlight.set(key, load);
    return load;
  },
}));
