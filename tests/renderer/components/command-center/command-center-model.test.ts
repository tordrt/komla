import { describe, expect, it } from 'vitest';

import {
  buildCommandCenterResults,
  RECENT_WORKSPACE_LIMIT,
} from '../../../../src/renderer/components/command-center/command-center-model';
import {
  createProject,
  createSshWorkspace,
  createTerminal,
  createWorkspace,
} from '../../../factories';

import type { Workspace } from '../../../../src/renderer/types';

const commands = [
  { id: 'workspace.new', label: 'New workspace', featured: true },
  { id: 'terminal.new', label: 'New terminal tab' },
  { id: 'settings', label: 'Settings', featured: true },
];

type Sections = ReturnType<typeof buildCommandCenterResults>;

function workspaceIds(sections: Sections): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) => (item.kind === 'workspace' ? [item.result.workspace.id] : []))
  );
}

function commandIds(sections: Sections): string[] {
  return sections.flatMap((section) =>
    section.items.flatMap((item) => (item.kind === 'command' ? [item.command.id] : []))
  );
}

function sectionKeys(sections: Sections): string[] {
  return sections.map((section) => section.key);
}

function groupOf(sections: Sections, id: string): string | undefined {
  for (const section of sections) {
    for (const item of section.items) {
      if (item.kind === 'workspace' && item.result.workspace.id === id) return item.result.group;
    }
  }
  return undefined;
}

describe('buildCommandCenterResults', () => {
  it('opens on workspaces needing attention, then the featured actions, then recent ones', () => {
    const workspaces = [
      createWorkspace({ id: 'recent', lastActivityAt: 500 }),
      createWorkspace({
        id: 'waiting',
        attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
        lastActivityAt: 100,
      }),
    ];

    const results = buildCommandCenterResults({ query: '', workspaces, projects: [], commands });

    expect(sectionKeys(results)).toEqual(['attention', 'actions', 'recent']);
    expect(workspaceIds(results)).toEqual(['waiting', 'recent']);
    expect(commandIds(results)).toEqual(['workspace.new', 'settings']);
  });

  it('lists recent workspaces by last touch, running or not, leaving out trashed ones', () => {
    const workspaces = [
      createWorkspace({ id: 'trashed-recent', status: 'trashed', lastActivityAt: 900 }),
      createWorkspace({ id: 'stopped-old', lastActivityAt: 100 }),
      createWorkspace({
        id: 'running-old',
        terminals: [createTerminal({ status: 'running' })],
        lastActivityAt: 200,
      }),
      createWorkspace({
        id: 'prompted-recently',
        lastActivityAt: 50,
        promptSubmits: [{ submittedAt: 800 }] as Workspace['promptSubmits'],
      }),
      createWorkspace({ id: 'stopped-recent', lastActivityAt: 700 }),
    ];

    const results = buildCommandCenterResults({ query: '', workspaces, projects: [], commands });

    expect(workspaceIds(results)).toEqual([
      'prompted-recently',
      'stopped-recent',
      'running-old',
      'stopped-old',
    ]);
  });

  it('leaves the open workspace out of recent, and lists only the most recent ones', () => {
    const workspaces = Array.from({ length: RECENT_WORKSPACE_LIMIT + 2 }, (_, index) =>
      createWorkspace({ id: `ws-${index}`, lastActivityAt: 1000 - index })
    );

    const results = buildCommandCenterResults({
      query: '',
      workspaces,
      projects: [],
      commands,
      currentWorkspaceId: 'ws-0',
    });

    const ids = workspaceIds(results);
    expect(ids).toHaveLength(RECENT_WORKSPACE_LIMIT);
    expect(ids[0]).toBe('ws-1');
    expect(ids).not.toContain('ws-0');
  });

  it('groups searched workspaces: running first, then stopped and trashed, each by last activity', () => {
    const workspaces = [
      createWorkspace({
        customName: 'Task',
        id: 'trashed-recent',
        status: 'trashed',
        lastActivityAt: 900,
      }),
      createWorkspace({ customName: 'Task', id: 'stopped-old', lastActivityAt: 100 }),
      createWorkspace({
        customName: 'Task',
        id: 'running-old',
        terminals: [createTerminal({ status: 'running' })],
        lastActivityAt: 200,
      }),
      createWorkspace({ customName: 'Task', id: 'stopped-recent', lastActivityAt: 700 }),
      createWorkspace({
        customName: 'Task',
        id: 'running-recent',
        terminals: [createTerminal({ status: 'running' })],
        lastActivityAt: 600,
      }),
    ];

    const results = buildCommandCenterResults({
      query: 'task',
      workspaces,
      projects: [],
      commands,
    });

    expect(workspaceIds(results)).toEqual([
      'running-recent',
      'running-old',
      'stopped-recent',
      'stopped-old',
      'trashed-recent',
    ]);
    expect(sectionKeys(results)).toEqual(['running', 'stopped', 'trash']);
  });

  it('puts workspaces whose agent needs input, hit an error, or finished on top', () => {
    const attention = (
      kind: 'input-required' | 'error' | 'turn-complete' | 'idle' | 'generic'
    ) => ({
      kind,
      source: 'claude-code',
      updatedAt: 1,
    });
    const running = [createTerminal({ status: 'running' })];
    const workspaces = [
      createWorkspace({ id: 'running', terminals: running, lastActivityAt: 900 }),
      createWorkspace({
        id: 'idle',
        terminals: running,
        attention: attention('idle'),
        lastActivityAt: 800,
      }),
      createWorkspace({
        id: 'notice',
        terminals: running,
        attention: attention('generic'),
        lastActivityAt: 700,
      }),
      createWorkspace({
        id: 'done',
        terminals: running,
        attention: attention('turn-complete'),
        lastActivityAt: 600,
      }),
      createWorkspace({
        id: 'input',
        terminals: running,
        attention: attention('input-required'),
        lastActivityAt: 500,
      }),
      createWorkspace({ id: 'error', attention: attention('error'), lastActivityAt: 400 }),
      createWorkspace({
        id: 'trashed-input',
        status: 'trashed',
        attention: attention('input-required'),
        lastActivityAt: 300,
      }),
    ];

    const results = buildCommandCenterResults({ query: '', workspaces, projects: [], commands });

    expect(workspaceIds(results)).toEqual(['done', 'input', 'error', 'running', 'idle', 'notice']);
    expect(results.map((section) => [section.key, section.items.length])).toEqual([
      ['attention', 3],
      ['actions', 2],
      ['recent', 3],
    ]);
    expect(groupOf(results, 'idle')).toBe('running');
  });

  it('counts a tmux session still running on the SSH host as running', () => {
    const detached = createSshWorkspace({
      id: 'detached',
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
      lastActivityAt: 100,
    });
    const stopped = createWorkspace({ id: 'stopped', lastActivityAt: 500 });

    const results = buildCommandCenterResults({
      query: '',
      workspaces: [stopped, detached],
      projects: [],
      commands,
    });

    expect(groupOf(results, 'detached')).toBe('running');
  });

  it('keeps a trashed workspace last even while a terminal still runs', () => {
    const trashed = createWorkspace({
      id: 'trashed',
      customName: 'Task',
      status: 'trashed',
      terminals: [createTerminal({ status: 'running' })],
      lastActivityAt: 900,
    });
    const stopped = createWorkspace({ id: 'stopped', customName: 'Task', lastActivityAt: 100 });

    const results = buildCommandCenterResults({
      query: 'task',
      workspaces: [trashed, stopped],
      projects: [],
      commands,
    });

    expect(workspaceIds(results)).toEqual(['stopped', 'trashed']);
  });

  it('keeps a trashed workspace under trash while a terminal still counts as running', () => {
    const trashed = createWorkspace({
      id: 'trashed',
      customName: 'Task',
      status: 'trashed',
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
    });

    const results = buildCommandCenterResults({
      query: 'task',
      workspaces: [trashed],
      projects: [],
      commands,
    });

    expect(groupOf(results, 'trashed')).toBe('trash');
  });

  it('names a plain folder workspace after its last folder on Windows too', () => {
    const folder = createWorkspace({
      id: 'folder',
      isWorktree: false,
      workingDirectory: 'C:\\Users\\me\\proj',
    });

    const results = buildCommandCenterResults({
      query: '',
      workspaces: [folder],
      projects: [],
      commands,
    });

    const recent = results.find((section) => section.key === 'recent');
    const item = recent?.items[0];
    expect(item?.kind === 'workspace' && item.result.projectInfo?.name).toBe('proj');
  });

  it('shows only the featured commands until something is typed', () => {
    const results = buildCommandCenterResults({
      query: '  ',
      workspaces: [],
      projects: [],
      commands,
    });

    expect(commandIds(results)).toEqual(['workspace.new', 'settings']);
  });

  it('matches the title, description, branch, and project name', () => {
    const project = createProject({ id: 'proj-api', name: 'payments-api' });
    const workspaces = [
      createWorkspace({ id: 'by-title', customName: 'Refresh token rotation' }),
      createWorkspace({ id: 'by-description', customDescription: 'Rotate the signing token' }),
      createWorkspace({ id: 'by-branch', branchName: 'feat/token-cache' }),
      createWorkspace({ id: 'by-project', projectId: 'proj-api' }),
      createWorkspace({ id: 'unrelated', customName: 'Sidebar polish' }),
    ];

    expect(
      workspaceIds(
        buildCommandCenterResults({ query: 'token', workspaces, projects: [project], commands })
      ).sort()
    ).toEqual(['by-branch', 'by-description', 'by-title']);
    expect(
      workspaceIds(
        buildCommandCenterResults({ query: 'payments', workspaces, projects: [project], commands })
      )
    ).toEqual(['by-project']);
  });

  it('within a group, puts title matches before matches elsewhere, then recent activity', () => {
    const workspaces = [
      createWorkspace({
        id: 'description-recent',
        customName: 'Fix login',
        customDescription: 'Retry the auth request',
        lastActivityAt: 900,
      }),
      createWorkspace({ id: 'title-old', customName: 'Auth middleware', lastActivityAt: 100 }),
      createWorkspace({
        id: 'running-description',
        customName: 'Billing',
        customDescription: 'auth headers',
        terminals: [createTerminal({ status: 'running' })],
        lastActivityAt: 50,
      }),
    ];

    const results = buildCommandCenterResults({
      query: 'auth',
      workspaces,
      projects: [],
      commands,
    });

    expect(workspaceIds(results)).toEqual([
      'running-description',
      'title-old',
      'description-recent',
    ]);
  });

  it('matches commands by label alongside workspaces', () => {
    const workspaces = [createWorkspace({ id: 'terminal-ws', customName: 'Terminal colors' })];

    const results = buildCommandCenterResults({
      query: 'terminal',
      workspaces,
      projects: [],
      commands,
    });

    expect(workspaceIds(results)).toEqual(['terminal-ws']);
    expect(commandIds(results)).toEqual(['terminal.new']);
  });

  it('shows only commands, all of them, after a ">" prefix', () => {
    const workspaces = [createWorkspace({ id: 'new-ws', customName: 'New onboarding' })];

    const all = buildCommandCenterResults({ query: '>', workspaces, projects: [], commands });
    expect(workspaceIds(all)).toEqual([]);
    expect(commandIds(all)).toEqual(['workspace.new', 'terminal.new', 'settings']);

    const filtered = buildCommandCenterResults({
      query: '> new',
      workspaces,
      projects: [],
      commands,
    });
    expect(workspaceIds(filtered)).toEqual([]);
    expect(commandIds(filtered)).toEqual(['workspace.new', 'terminal.new']);
  });
});
