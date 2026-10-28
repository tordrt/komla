import { describe, expect, it } from 'vitest';

import {
  filterActionMenuGroups,
  getActionMenuGroups,
  getActionPreview,
  getActionSettingsGroups,
  getDefaultAction,
} from '../../../src/renderer/lib/action-menu-order';

import type { Action } from '../../../src/shared/types';

describe('getActionMenuGroups', () => {
  it('shows only global actions when project id is null', () => {
    const actions: Action[] = [
      {
        id: 'project-command',
        title: 'Project Command',
        type: 'command',
        content: 'npm run dev',
        projectIds: ['project-1'],
      },
      {
        id: 'project-prompt',
        title: 'Project Prompt',
        type: 'prompt',
        content: 'Review',
        projectIds: ['project-1'],
      },
      { id: 'global-command', title: 'Global Command', type: 'command', content: 'date' },
      { id: 'global-prompt', title: 'Global Prompt', type: 'prompt', content: 'Summarize' },
    ];

    expect(getActionMenuGroups(actions, null)).toEqual([
      { type: 'command', label: 'Terminal Commands', actions: [actions[2]] },
      { type: 'prompt', label: 'Saved Prompts', actions: [actions[3]] },
    ]);
  });

  it("lists the project's own actions before global ones within each type", () => {
    const actions: Action[] = [
      { id: 'global-command', title: 'Global Command', type: 'command', content: 'date' },
      {
        id: 'project-command',
        title: 'Project Command',
        type: 'command',
        content: 'npm run dev',
        projectIds: ['project-1'],
      },
      { id: 'global-prompt', title: 'Global Prompt', type: 'prompt', content: 'Summarize' },
      {
        id: 'project-prompt',
        title: 'Project Prompt',
        type: 'prompt',
        content: 'Review',
        projectIds: ['project-1'],
      },
    ];

    expect(getActionMenuGroups(actions, 'project-1')).toEqual([
      { type: 'command', label: 'Terminal Commands', actions: [actions[1], actions[0]] },
      { type: 'prompt', label: 'Saved Prompts', actions: [actions[3], actions[2]] },
    ]);
  });
});

describe('filterActionMenuGroups', () => {
  const dev: Action = { id: 'dev', title: 'Dev server', type: 'command', content: 'npm run dev' };
  const tests: Action = { id: 'tests', title: 'Tests', type: 'command', content: 'npm test' };
  const review: Action = { id: 'review', title: 'Review', type: 'prompt', content: 'Review it' };
  const groups = getActionMenuGroups([dev, tests, review], null);

  it('matches every word against the title or content, ignoring case', () => {
    expect(filterActionMenuGroups(groups, 'NPM dev')).toEqual([
      { type: 'command', label: 'Terminal Commands', actions: [dev] },
    ]);
  });

  it('drops groups left empty and keeps everything for a blank query', () => {
    expect(filterActionMenuGroups(groups, 'review')).toEqual([
      { type: 'prompt', label: 'Saved Prompts', actions: [review] },
    ]);
    expect(filterActionMenuGroups(groups, '  ')).toBe(groups);
  });
});

describe('getDefaultAction', () => {
  it('picks the most recently used Action shown', () => {
    const actions: Action[] = [
      { id: 'a', title: 'A', type: 'command', content: 'a', lastUsedAt: 10 },
      { id: 'b', title: 'B', type: 'prompt', content: 'b', lastUsedAt: 30 },
      { id: 'c', title: 'C', type: 'command', content: 'c', lastUsedAt: 20 },
    ];

    expect(getDefaultAction(getActionMenuGroups(actions, null))?.id).toBe('b');
  });

  it('ignores Actions scoped to another project', () => {
    const actions: Action[] = [
      { id: 'a', title: 'A', type: 'command', content: 'a', lastUsedAt: 10 },
      { id: 'b', title: 'B', type: 'command', content: 'b', lastUsedAt: 30, projectIds: ['other'] },
    ];

    expect(getDefaultAction(getActionMenuGroups(actions, 'mine'))?.id).toBe('a');
  });

  it('falls back to the first Action shown, or null without any', () => {
    const actions: Action[] = [
      { id: 'prompt', title: 'P', type: 'prompt', content: 'p' },
      { id: 'command', title: 'C', type: 'command', content: 'c' },
    ];

    expect(getDefaultAction(getActionMenuGroups(actions, null))?.id).toBe('command');
    expect(getDefaultAction([])).toBeNull();
  });

  it("keeps the workspace's default over a more recently used Action", () => {
    const actions: Action[] = [
      { id: 'a', title: 'A', type: 'command', content: 'a', lastUsedAt: 10 },
      { id: 'b', title: 'B', type: 'command', content: 'b', lastUsedAt: 30 },
    ];

    expect(getDefaultAction(getActionMenuGroups(actions, null), 'a')?.id).toBe('a');
  });

  it('falls back to the last used Action once the default is gone from the project', () => {
    const actions: Action[] = [
      { id: 'a', title: 'A', type: 'command', content: 'a', projectIds: ['other'] },
      { id: 'b', title: 'B', type: 'command', content: 'b', lastUsedAt: 30 },
    ];

    expect(getDefaultAction(getActionMenuGroups(actions, 'mine'), 'a')?.id).toBe('b');
    expect(getDefaultAction(getActionMenuGroups(actions, 'mine'), 'deleted')?.id).toBe('b');
  });
});

describe('getActionPreview', () => {
  it('starts a saved prompt after its heading, on one line', () => {
    expect(
      getActionPreview({ type: 'prompt', content: '# Review\n\nYou are a reviewer.\n## Steps' })
    ).toBe('You are a reviewer. Steps');
  });

  it('shows a terminal command as written', () => {
    expect(getActionPreview({ type: 'command', content: '# just a comment' })).toBe(
      '# just a comment'
    );
  });
});

describe('getActionSettingsGroups', () => {
  const projects = [
    { id: 'komla', name: 'komla', order: 0 },
    { id: 'kapture', name: 'kapture', order: 1 },
  ];

  it('groups by project in sidebar order, global first, commands before prompts', () => {
    const actions: Action[] = [
      { id: 'k-dev', title: 'K', type: 'command', content: 'just dev', projectIds: ['kapture'] },
      { id: 'b-review', title: 'R', type: 'prompt', content: 'Review', projectIds: ['komla'] },
      { id: 'b-dev', title: 'B', type: 'command', content: 'npm run dev', projectIds: ['komla'] },
      { id: 'global', title: 'G', type: 'prompt', content: 'Summarize' },
      { id: 'k-db', title: 'D', type: 'command', content: 'just db', projectIds: ['kapture'] },
    ];

    expect(
      getActionSettingsGroups(actions, projects).map((group) => [
        group.title,
        group.actions.map((action) => action.id),
      ])
    ).toEqual([
      ['All projects', ['global']],
      ['komla', ['b-dev', 'b-review']],
      ['kapture', ['k-dev', 'k-db']],
    ]);
  });

  it('puts multi-project actions after their first project and orphans last', () => {
    const actions: Action[] = [
      { id: 'gone', title: 'X', type: 'command', content: 'x', projectIds: ['deleted'] },
      {
        id: 'both',
        title: 'Both',
        type: 'command',
        content: 'both',
        projectIds: ['kapture', 'komla', 'deleted'],
      },
      { id: 'k', title: 'K', type: 'command', content: 'k', projectIds: ['kapture'] },
      { id: 'b', title: 'B', type: 'command', content: 'b', projectIds: ['komla'] },
    ];

    expect(
      getActionSettingsGroups(actions, projects).map((group) => [
        group.title,
        group.actions.map((action) => action.id),
      ])
    ).toEqual([
      ['komla', ['b']],
      ['komla, kapture', ['both']],
      ['kapture', ['k']],
      ['Removed projects', ['gone']],
    ]);
  });

  it('orders sections by project order and ignores repeated project ids', () => {
    const actions: Action[] = [
      { id: 'b', title: 'B', type: 'command', content: 'b', projectIds: ['komla', 'komla'] },
      { id: 'k', title: 'K', type: 'command', content: 'k', projectIds: ['kapture'] },
    ];
    const reordered = [
      { id: 'komla', name: 'komla', order: 1 },
      { id: 'kapture', name: 'kapture', order: 0 },
    ];

    expect(
      getActionSettingsGroups(actions, reordered).map((group) => [
        group.title,
        group.actions.map((action) => action.id),
      ])
    ).toEqual([
      ['kapture', ['k']],
      ['komla', ['b']],
    ]);
  });
});
