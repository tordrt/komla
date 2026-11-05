import { describe, expect, it } from 'vitest';

import {
  filterSkills,
  findSkillQuery,
  insertSkill,
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

  it('knows GitHub Copilot CLI and Cursor CLI', () => {
    expect(skillFamilyForPreset({ openCommand: 'copilot', promptCommand: '' })).toBe('copilot');
    expect(skillFamilyForPreset({ openCommand: 'cursor-agent --force', promptCommand: '' })).toBe(
      'cursor'
    );
  });

  it('is null for other agents and for no preset', () => {
    expect(skillFamilyForPreset({ openCommand: 'grok', promptCommand: 'grok -- {{prompt}}' })).toBe(
      null
    );
    expect(skillFamilyForPreset({ openCommand: 'claudette', promptCommand: '' })).toBe(null);
    // OpenCode reads skills, but only its model starts one
    expect(skillFamilyForPreset({ openCommand: 'opencode', promptCommand: '' })).toBe(null);
    expect(skillFamilyForPreset({ openCommand: 'constructor', promptCommand: '' })).toBe(null);
    expect(skillFamilyForPreset(null)).toBe(null);
  });
});

describe('findSkillQuery', () => {
  it('takes a Claude Code skill only at the start of the prompt', () => {
    expect(findSkillQuery('/rev', 4, 'claude')).toEqual({ start: 0, query: 'rev' });
    expect(findSkillQuery('/', 1, 'claude')).toEqual({ start: 0, query: '' });
    expect(findSkillQuery('fix /rev', 8, 'claude')).toBeNull();
  });

  it('takes a Codex skill where any word starts', () => {
    expect(findSkillQuery('$rev', 4, 'codex')).toEqual({ start: 0, query: 'rev' });
    expect(findSkillQuery('please $rev', 11, 'codex')).toEqual({ start: 7, query: 'rev' });
    expect(findSkillQuery('cost a$rev', 10, 'codex')).toBeNull();
  });

  it('takes a GitHub Copilot CLI or Cursor CLI skill where any word starts', () => {
    expect(findSkillQuery('use /rev', 8, 'copilot')).toEqual({ start: 4, query: 'rev' });
    expect(findSkillQuery('use /rev', 8, 'cursor')).toEqual({ start: 4, query: 'rev' });
    expect(findSkillQuery('src/rev', 7, 'copilot')).toBeNull();
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
