import { describe, expect, it } from 'vitest';

import {
  buildDashboardOverview,
  type BuildDashboardOverviewParams,
} from '../../../../src/renderer/components/dashboard/dashboard-view-model';
import { createTerminal, createWorkspace } from '../../../factories';

import type { WorkspaceAttention } from '../../../../src/renderer/types';

const NOW = 100 * 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function build(params: Partial<BuildDashboardOverviewParams>) {
  return buildDashboardOverview({
    workspaces: [],
    projects: [],
    currentWindowId: 'window-1',
    now: NOW,
    ...params,
  });
}

function attention(kind: WorkspaceAttention['kind']): WorkspaceAttention {
  return { kind, source: 'claude-code', updatedAt: 1 };
}

function sectionIds(overview: ReturnType<typeof build>) {
  return Object.fromEntries(
    overview.sections.map((section) => [
      section.key,
      section.items.map((item) => item.workspace.id),
    ])
  );
}

describe('dashboard-view-model', () => {
  it('groups workspaces like the command center: notifications, running, stopped, put away', () => {
    const overview = build({
      workspaces: [
        createWorkspace({ id: 'ws-stopped', windowId: 'window-1', lastActivityAt: NOW - MINUTE }),
        createWorkspace({
          id: 'ws-running',
          windowId: 'window-1',
          terminals: [createTerminal({ status: 'running' })],
          lastActivityAt: NOW - MINUTE,
        }),
        createWorkspace({
          id: 'ws-done',
          windowId: 'window-1',
          attention: attention('turn-complete'),
          lastActivityAt: NOW - MINUTE,
        }),
        createWorkspace({
          id: 'ws-idle-notice',
          windowId: 'window-1',
          attention: attention('idle'),
          lastActivityAt: NOW - 2 * MINUTE,
        }),
        createWorkspace({
          id: 'ws-trashed',
          windowId: 'window-1',
          status: 'trashed',
          lastActivityAt: NOW - MINUTE,
        }),
      ],
    });

    expect(overview.sections.map((section) => [section.key, section.title])).toEqual([
      ['attention', 'Needs attention'],
      ['running', 'Running'],
      ['stopped', 'Stopped'],
      ['trash', 'Trash'],
    ]);
    expect(sectionIds(overview)).toEqual({
      attention: ['ws-done'],
      running: ['ws-running'],
      stopped: ['ws-stopped', 'ws-idle-notice'],
      trash: ['ws-trashed'],
    });
  });

  it('does not count an agent whose terminals stopped as running', () => {
    const overview = build({
      workspaces: [
        createWorkspace({
          id: 'ws-stopped',
          windowId: 'window-1',
          agentActive: true,
          terminals: [createTerminal({ status: 'stopped' })],
        }),
      ],
    });

    expect(sectionIds(overview)).toEqual({ stopped: ['ws-stopped'] });
  });

  it('moves stopped workspaces untouched for a week or a month into their own groups', () => {
    const overview = build({
      workspaces: [
        createWorkspace({ id: 'ws-6-days', windowId: 'window-1', lastActivityAt: NOW - 6 * DAY }),
        createWorkspace({ id: 'ws-8-days', windowId: 'window-1', lastActivityAt: NOW - 8 * DAY }),
        createWorkspace({
          id: 'ws-29-days',
          windowId: 'window-1',
          lastActivityAt: NOW - 29 * DAY,
        }),
        createWorkspace({
          id: 'ws-40-days',
          windowId: 'window-1',
          lastActivityAt: NOW - 40 * DAY,
        }),
      ],
    });

    expect(overview.sections.map((section) => [section.key, section.title])).toEqual([
      ['stopped', 'Stopped'],
      ['week', 'Not touched in a week'],
      ['month', 'Not touched in a month'],
    ]);
    expect(sectionIds(overview)).toEqual({
      stopped: ['ws-6-days'],
      week: ['ws-8-days', 'ws-29-days'],
      month: ['ws-40-days'],
    });
  });

  it('leaves out the week and month groups while nothing is that old', () => {
    const overview = build({
      workspaces: [
        createWorkspace({ id: 'ws-today', windowId: 'window-1', lastActivityAt: NOW - MINUTE }),
        createWorkspace({ id: 'ws-6-days', windowId: 'window-1', lastActivityAt: NOW - 6 * DAY }),
      ],
    });

    expect(overview.sections.map((section) => section.key)).toEqual(['stopped']);
  });

  it('keeps old workspaces with a notification or a live terminal in their own groups', () => {
    const overview = build({
      workspaces: [
        createWorkspace({
          id: 'ws-old-error',
          windowId: 'window-1',
          attention: attention('error'),
          lastActivityAt: NOW - 20 * DAY,
        }),
        createWorkspace({
          id: 'ws-old-running',
          windowId: 'window-1',
          terminals: [createTerminal({ status: 'running' })],
          lastActivityAt: NOW - 20 * DAY,
        }),
        createWorkspace({
          id: 'ws-old-trashed',
          windowId: 'window-1',
          status: 'trashed',
          lastActivityAt: NOW - 40 * DAY,
        }),
      ],
    });

    expect(sectionIds(overview)).toEqual({
      attention: ['ws-old-error'],
      running: ['ws-old-running'],
      trash: ['ws-old-trashed'],
    });
  });

  it('counts the latest prompt or notification as activity, not just file changes', () => {
    const overview = build({
      workspaces: [
        createWorkspace({
          id: 'ws-chatted-today',
          windowId: 'window-1',
          lastActivityAt: NOW - 40 * DAY,
          promptSubmits: [{ prompt: 'Explain the session store', submittedAt: NOW - DAY }],
        }),
        createWorkspace({
          id: 'ws-fresh-notice',
          windowId: 'window-1',
          lastActivityAt: NOW - 20 * DAY,
          attention: { kind: 'generic', source: 'custom-hook', updatedAt: NOW - 2 * DAY },
        }),
        createWorkspace({
          id: 'ws-chatted-last-week',
          windowId: 'window-1',
          lastActivityAt: NOW - 40 * DAY,
          promptSubmits: [{ prompt: 'Rename the helper', submittedAt: NOW - 8 * DAY }],
        }),
      ],
    });

    expect(sectionIds(overview)).toEqual({
      stopped: ['ws-chatted-today', 'ws-fresh-notice'],
      week: ['ws-chatted-last-week'],
    });
    expect(overview.sections[0].items[0].lastActivityAt).toBe(NOW - DAY);
  });

  it('puts questions and errors first in Needs attention, then sorts by last activity', () => {
    const make = (id: string, minutesAgo: number, kind?: WorkspaceAttention['kind']) =>
      createWorkspace({
        id,
        windowId: 'window-1',
        lastActivityAt: NOW - minutesAgo * MINUTE,
        attention: kind ? attention(kind) : undefined,
      });

    const overview = build({
      workspaces: [
        make('ws-stopped-old', 9),
        make('ws-stopped-new', 1),
        make('ws-input', 9, 'input-required'),
        make('ws-error', 3, 'error'),
        make('ws-done', 4, 'turn-complete'),
      ],
    });

    expect(sectionIds(overview)).toEqual({
      attention: ['ws-input', 'ws-error', 'ws-done'],
      stopped: ['ws-stopped-new', 'ws-stopped-old'],
    });
  });

  it('shows active workspaces of this window, and trashed ones of any window', () => {
    const overview = build({
      workspaces: [
        createWorkspace({ id: 'ws-active-local', windowId: 'window-1' }),
        createWorkspace({ id: 'ws-active-other', windowId: 'window-2' }),
        createWorkspace({ id: 'ws-trashed-other', windowId: 'window-2', status: 'trashed' }),
      ],
    });

    expect(overview.totalWindowCount).toBe(2);
    expect(overview.visibleCount).toBe(2);
    expect(sectionIds(overview)).toEqual({
      stopped: ['ws-active-local'],
      trash: ['ws-trashed-other'],
    });
  });

  it('filters local and SSH workspaces by host before computing sections and counts', () => {
    const local = createWorkspace({ id: 'ws-local', windowId: 'window-1' });
    const remote = createWorkspace({
      id: 'ws-remote',
      windowId: 'window-1',
      backend: {
        kind: 'ssh',
        hostId: 'host-1',
        remoteDirectory: '/srv/project/worktree',
        remoteRepoPath: '/srv/project/repo.git',
        remoteProjectRoot: '/srv/project',
        gitUrl: 'git@example.com:project/repo.git',
      },
    });

    const overview = build({
      workspaces: [local, remote],
      hiddenWorkspaceHostIds: new Set(['local']),
    });

    expect(overview.totalWindowCount).toBe(2);
    expect(overview.visibleCount).toBe(1);
    expect(sectionIds(overview)).toEqual({ stopped: ['ws-remote'] });
  });

  it('filters by project and counts every project across all groups', () => {
    const projects = [
      {
        id: 'p-api',
        name: 'acme-api',
        repositoryPath: '/repos/api',
        defaultBranchPrefix: 'tt/',
        createdAt: 0,
        order: 0,
        managed: false,
        color: '#00ff00',
      },
      {
        id: 'p-web',
        name: 'acme-web',
        repositoryPath: '/repos/web',
        defaultBranchPrefix: 'tt/',
        createdAt: 0,
        order: 1,
        managed: false,
        color: '#ff0000',
      },
    ];
    const workspaces = [
      createWorkspace({ id: 'ws-api', windowId: 'window-1', projectId: 'p-api' }),
      createWorkspace({ id: 'ws-web-1', windowId: 'window-1', projectId: 'p-web' }),
      createWorkspace({
        id: 'ws-web-2',
        windowId: 'window-1',
        projectId: 'p-web',
        status: 'trashed',
      }),
    ];

    const overview = build({ workspaces, projects, filterProjectName: 'acme-web' });

    expect(overview.projectFilters).toEqual([
      { name: 'acme-web', color: '#ff0000', count: 2 },
      { name: 'acme-api', color: '#00ff00', count: 1 },
    ]);
    expect(sectionIds(overview)).toEqual({ stopped: ['ws-web-1'], trash: ['ws-web-2'] });
  });

  it('offers the tags in use with counts, and filters by one or by none', () => {
    const tags = [
      { name: 'In review', tone: 'info' as const },
      { name: 'Blocked', tone: 'error' as const },
    ];
    const workspaces = [
      createWorkspace({ id: 'ws-blocked', windowId: 'window-1', tag: 'blocked' }),
      createWorkspace({ id: 'ws-review', windowId: 'window-1', tag: 'In review' }),
      createWorkspace({ id: 'ws-plain', windowId: 'window-1' }),
      createWorkspace({ id: 'ws-own', windowId: 'window-1', tag: 'Mine' }),
    ];

    const all = build({ workspaces, tags });
    expect(all.tagFilters).toEqual([
      { key: 'in review', name: 'In review', tone: 'info', count: 1 },
      { key: 'blocked', name: 'Blocked', tone: 'error', count: 1 },
      { key: 'mine', name: 'Mine', tone: 'neutral', count: 1 },
    ]);
    expect(all.untaggedCount).toBe(1);

    const blocked = build({ workspaces, tags, filterTagKey: 'blocked' });
    expect(sectionIds(blocked)).toEqual({ stopped: ['ws-blocked'] });
    // The chips keep counting every workspace.
    expect(blocked.tagFilters).toEqual(all.tagFilters);

    expect(sectionIds(build({ workspaces, tags, filterTagKey: '' }))).toEqual({
      stopped: ['ws-plain'],
    });

    // A tag no workspace has filters nothing, as no chip offers it.
    const gone = build({ workspaces, tags, filterTagKey: 'needs changes' });
    expect(gone.tagFilterKey).toBeNull();
    expect(gone.visibleCount).toBe(4);
  });

  it('shows only pinned workspaces when asked', () => {
    const overview = build({
      workspaces: [
        createWorkspace({ id: 'ws-plain', windowId: 'window-1' }),
        createWorkspace({ id: 'ws-marked', windowId: 'window-1', pinned: true }),
      ],
      pinnedOnly: true,
    });

    expect(sectionIds(overview)).toEqual({ stopped: ['ws-marked'] });
  });

  it('fuzzy search matches partial/misspelled queries', () => {
    const overview = build({
      workspaces: [
        createWorkspace({ id: 'ws-auth', windowId: 'window-1', customName: 'Auth Refactor' }),
        createWorkspace({ id: 'ws-dashboard', windowId: 'window-1', customName: 'Dashboard Fix' }),
      ],
      searchQuery: 'auth',
    });

    expect(sectionIds(overview)).toEqual({ stopped: ['ws-auth'] });
  });

  it('fuzzy search matches the description, words in any order', () => {
    const overview = build({
      workspaces: [
        createWorkspace({
          id: 'ws-with-desc',
          windowId: 'window-1',
          customName: 'Short Title',
          customDescription: 'Fix login page authentication flow',
        }),
        createWorkspace({ id: 'ws-no-match', windowId: 'window-1', customName: 'Unrelated' }),
      ],
      searchQuery: 'flow login',
    });

    expect(sectionIds(overview)).toEqual({ stopped: ['ws-with-desc'] });
  });

  it('fuzzy search matches the last prompt sent to the agent', () => {
    const overview = build({
      workspaces: [
        createWorkspace({
          id: 'ws-prompted',
          windowId: 'window-1',
          customName: 'Short Title',
          promptSubmits: [
            { prompt: 'rename the config loader', submittedAt: 1 },
            { prompt: 'add a stripe webhook handler', submittedAt: 2 },
          ],
        }),
        createWorkspace({ id: 'ws-quiet', windowId: 'window-1', customName: 'Unrelated' }),
      ],
      searchQuery: 'webhook',
    });

    expect(sectionIds(overview)).toEqual({ stopped: ['ws-prompted'] });
  });

  it('empty search query returns all items', () => {
    const overview = build({
      workspaces: [
        createWorkspace({ id: 'ws-one', windowId: 'window-1' }),
        createWorkspace({ id: 'ws-two', windowId: 'window-1' }),
      ],
      searchQuery: '  ',
    });

    expect(overview.visibleCount).toBe(2);
  });
});
