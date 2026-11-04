import { describe, expect, it, vi } from 'vitest';

const mockListAgentSkills = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: { api: { listAgentSkills: mockListAgentSkills } },
  writable: true,
});

import {
  skillListingKey,
  useAgentSkillsStore,
} from '../../../src/renderer/stores/agent-skills.store';

describe('useAgentSkillsStore', () => {
  it('keeps the listing it has when the same skills are listed again', async () => {
    const key = skillListingKey('claude', 'project', null);
    mockListAgentSkills.mockResolvedValue([
      { name: 'deploy', description: 'Ships', source: 'user' },
    ]);
    await useAgentSkillsStore.getState().loadSkills('claude', 'project', null);
    const first = useAgentSkillsStore.getState().listings;

    mockListAgentSkills.mockResolvedValue([
      { name: 'deploy', description: 'Ships', source: 'user' },
    ]);
    await useAgentSkillsStore.getState().loadSkills('claude', 'project', null);
    expect(useAgentSkillsStore.getState().listings).toBe(first);

    mockListAgentSkills.mockResolvedValue([
      { name: 'deploy', description: 'Ships it', source: 'user' },
    ]);
    await useAgentSkillsStore.getState().loadSkills('claude', 'project', null);
    expect(useAgentSkillsStore.getState().listings[key]).toEqual([
      { name: 'deploy', description: 'Ships it', source: 'user' },
    ]);
  });
});
