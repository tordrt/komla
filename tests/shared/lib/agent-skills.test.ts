import { describe, expect, it } from 'vitest';

import {
  filterSkills,
  findSkillQuery,
  insertSkill,
  startPromptWithSkill,
  skillFamilyForPreset,
} from '../../../src/shared/lib/agent-skills';

import type { AgentSkill } from '../../../src/shared/types/agent-skill';

const skill = (name: string): AgentSkill => ({ name, description: '', source: 'user' });

describe('skillFamilyForPreset', () => {
  it('finds the agent from the executable its command starts', () => {
    expect(
      skillFamilyForPreset({ openCommand: 'claude', promptCommand: 'claude -- {{prompt}}' })
    ).toBe('claude');
    expect(skillFamilyForPreset({ openCommand: '', promptCommand: '/usr/bin/codex -- x' })).toBe(
      'codex'
    );
    expect(skillFamilyForPreset({ openCommand: 'C:\\bin\\codex.exe', promptCommand: '' })).toBe(
      'codex'
    );
  });

  it('reads a quoted path with spaces, and the executable after NAME=value settings', () => {
    expect(
      skillFamilyForPreset({
        openCommand: '',
        promptCommand: '"C:\\Program Files\\nodejs\\claude.cmd" -- {{prompt}}',
      })
    ).toBe('claude');
    expect(
      skillFamilyForPreset({ openCommand: 'FOO=1 BAR= BAZ="a b" codex', promptCommand: '' })
    ).toBe('codex');
    // A quote left open
    expect(skillFamilyForPreset({ openCommand: '', promptCommand: '"claude {{prompt}}' })).toBe(
      'claude'
    );
  });

  it('takes any other agent to read the shared folders', () => {
    for (const openCommand of ['copilot', 'cursor-agent --force', 'pi', 'gemini', 'claudette']) {
      expect(skillFamilyForPreset({ openCommand, promptCommand: '' })).toBe('agents');
    }
    expect(skillFamilyForPreset({ openCommand: 'constructor', promptCommand: '' })).toBe('agents');
  });

  it('is null without a command or a preset', () => {
    expect(skillFamilyForPreset({ openCommand: '', promptCommand: '' })).toBe(null);
    expect(skillFamilyForPreset(null)).toBe(null);
  });
});

describe('findSkillQuery', () => {
  it('takes a Claude Code skill where any word starts', () => {
    expect(findSkillQuery('/rev', 4, 'claude')).toEqual({ start: 0, query: 'rev' });
    expect(findSkillQuery('/', 1, 'claude')).toEqual({ start: 0, query: '' });
    expect(findSkillQuery('fix /rev', 8, 'claude')).toEqual({ start: 4, query: 'rev' });
  });

  it('takes a Codex skill where any word starts', () => {
    expect(findSkillQuery('$rev', 4, 'codex')).toEqual({ start: 0, query: 'rev' });
    expect(findSkillQuery('please $rev', 11, 'codex')).toEqual({ start: 7, query: 'rev' });
    expect(findSkillQuery('cost a$rev', 10, 'codex')).toBeNull();
  });

  it("takes any other agent's skill after / where any word starts", () => {
    expect(findSkillQuery('use /rev', 8, 'agents')).toEqual({ start: 4, query: 'rev' });
    expect(findSkillQuery('src/rev', 7, 'agents')).toBeNull();
  });

  it('stops at a space or a path, and reads only up to the caret', () => {
    expect(findSkillQuery('/review the code', 16, 'claude')).toBeNull();
    expect(findSkillQuery('/src/main', 9, 'claude')).toBeNull();
    expect(findSkillQuery('/review the code', 4, 'claude')).toEqual({ start: 0, query: 'rev' });
    expect(findSkillQuery('no trigger', 10, 'codex')).toBeNull();
  });
});

describe('filterSkills', () => {
  it('lists names holding the query, those starting with it first', () => {
    const skills = [skill('code-review'), skill('deploy'), skill('review-pr'), skill('Reviewer')];
    expect(filterSkills(skills, 'rev').map((s) => s.name)).toEqual([
      'review-pr',
      'Reviewer',
      'code-review',
    ]);
    expect(filterSkills(skills, '')).toHaveLength(4);
  });
});

describe('insertSkill', () => {
  it('replaces the typed query with the invocation and a space', () => {
    expect(insertSkill('/rev', 4, 0, 'claude', 'review-pr')).toEqual({
      text: '/review-pr ',
      caret: 11,
    });
    expect(insertSkill('please $re now', 10, 7, 'codex', 'review')).toEqual({
      text: 'please $review now',
      caret: 15,
    });
    // A trigger typed in front of a word leaves the word
    expect(insertSkill('/fix the bug', 1, 0, 'claude', 'review')).toEqual({
      text: '/review fix the bug',
      caret: 8,
    });
    // A line break after the name stays
    expect(insertSkill('$rev\n\nDetails', 4, 0, 'codex', 'review')).toEqual({
      text: '$review \n\nDetails',
      caret: 8,
    });
    // The caret was moved back into the name before picking
    expect(insertSkill('$revx rest', 2, 0, 'codex', 'review')).toEqual({
      text: '$review rest',
      caret: 8,
    });
  });
});

describe('startPromptWithSkill', () => {
  it('starts the prompt with the invocation, keeping the rest of it', () => {
    expect(startPromptWithSkill('fix the build', 'claude', 'review').text).toBe(
      '/review fix the build'
    );
  });

  it('replaces an invocation the prompt starts with, typed in part or whole', () => {
    expect(startPromptWithSkill('/rev', 'claude', 'review').text).toBe('/review ');
    expect(startPromptWithSkill('/review fix it', 'claude', 'review').text).toBe('/review fix it');
    expect(startPromptWithSkill('$', 'codex', 'deploy').text).toBe('$deploy ');
    // Not a path or a variable the prompt starts with
    expect(startPromptWithSkill('/src/app.ts crashes', 'claude', 'review').text).toBe(
      '/review /src/app.ts crashes'
    );
    expect(startPromptWithSkill('$HOME/.config is wrong', 'codex', 'deploy').text).toBe(
      '$deploy $HOME/.config is wrong'
    );
    expect(startPromptWithSkill('/plan fix it', 'codex', 'deploy').text).toBe(
      '$deploy /plan fix it'
    );
  });
});
