import { describe, expect, it } from 'vitest';

import { getSkillMenuGroups, skillAgentPresets } from '../../../src/renderer/lib/skill-actions';
import { skillListingKey } from '../../../src/renderer/stores/agent-skills.store';

import type { ActivePresetEntry, AgentPreset } from '../../../src/renderer/types';

const preset = (id: string, command: string): AgentPreset =>
  ({
    id,
    name: id,
    openCommand: command,
    continueCommand: command,
    promptCommand: `${command} -- {{prompt}}`,
    launchModes: [],
    isBuiltin: true,
  }) as AgentPreset;

describe('skillAgentPresets', () => {
  it("picks each agent's most recently used preset, in the mode it last ran in", () => {
    const presets = [
      preset('claude-old', 'claude'),
      preset('claude-new', 'claude'),
      preset('codex', 'codex'),
      preset('grok', 'grok'),
      { ...preset('promptless', 'copilot'), promptCommand: '' },
    ];
    const active: ActivePresetEntry[] = [
      { presetId: 'claude-old', lastUsedAt: 1 },
      { presetId: 'claude-new', lastUsedAt: 3, lastLaunchModeId: 'plan' },
      { presetId: 'codex', lastUsedAt: 2 },
      { presetId: 'grok', lastUsedAt: 4 },
      { presetId: 'promptless', lastUsedAt: 5 },
    ];

    expect(
      skillAgentPresets(presets, active).map(({ family, preset, launchModeId }) => [
        family,
        preset.id,
        launchModeId,
      ])
    ).toEqual([
      ['claude', 'claude-new', 'plan'],
      ['codex', 'codex', undefined],
    ]);
  });

  it('leaves out an agent nobody turned on', () => {
    expect(skillAgentPresets([preset('codex', 'codex')], [])).toEqual([]);
  });
});

describe('getSkillMenuGroups', () => {
  const agents = [
    { family: 'claude' as const, preset: preset('claude', 'claude'), launchModeId: 'plan' },
    { family: 'codex' as const, preset: preset('codex', 'codex'), launchModeId: undefined },
  ];

  it("lists each agent's skills for the project and host, by name, starting that agent", () => {
    const listings = {
      [skillListingKey('claude', 'p1', 'host')]: [
        { name: 'review', description: 'Reviews', source: 'user' as const },
        { name: 'deploy', description: 'Ships', source: 'project' as const },
      ],
      [skillListingKey('codex', 'p1', 'host')]: [
        { name: 'lint', description: 'Lints', source: 'user' as const },
      ],
      // Another host's listing isn't this workspace's
      [skillListingKey('codex', 'p1', null)]: [
        { name: 'local', description: '', source: 'user' as const },
      ],
    };

    const [group] = getSkillMenuGroups(listings, 'p1', 'host', agents);

    expect(group.type).toBe('skill');
    expect(
      group.actions.map(({ title, presetId, launchModeId }) => [title, presetId, launchModeId])
    ).toEqual([
      ['/deploy', 'claude', 'plan'],
      ['/review', 'claude', 'plan'],
      ['$lint', 'codex', undefined],
    ]);
  });

  it('has no group until a listing has skills', () => {
    expect(getSkillMenuGroups({}, 'p1', null, agents)).toEqual([]);
  });
});
