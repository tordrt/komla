import { describe, expect, it } from 'vitest';

import type { RemoteWorkspaceSummary } from '@komla/remote-protocol';

import {
  buildWorkspaceSections,
  parseCollapsedSections,
  searchWorkspaces,
  workspaceProject,
  workspaceSectionCounts,
  workspaceSectionId,
  workspaceSectionLabel,
} from '../workspace-sections';

function workspace(
  id: string,
  overrides: Partial<RemoteWorkspaceSummary> = {}
): RemoteWorkspaceSummary {
  return {
    id,
    name: `Workspace ${id}`,
    workingDirectory: `/repos/komla/${id}`,
    status: 'active',
    provisioning: false,
    lastActivityAt: 0,
    terminals: [{ id: `${id}-t`, name: 'claude', status: 'running' }],
    ...overrides,
  };
}

const attention = (updatedAt: number) => ({
  kind: 'input-required' as const,
  source: 'claude',
  updatedAt,
});

describe('parseCollapsedSections', () => {
  it('starts with Stopped and the Trash collapsed, the Trash too for a list saved before it', () => {
    expect([...parseCollapsedSections(null, null)]).toEqual(['stopped', 'trash']);
    expect([...parseCollapsedSections(null, '["idle"]')]).toEqual(['idle', 'trash']);
    expect([...parseCollapsedSections('["idle"]', '["stopped"]')]).toEqual(['idle']);
    expect([...parseCollapsedSections('not json', null)]).toEqual(['stopped', 'trash']);
  });
});

describe('workspaceSectionLabel', () => {
  it('names where a workspace stands as its section does', () => {
    expect(workspaceSectionLabel(workspace('a', { attention: attention(1) }))).toBe('Needs you');
    expect(workspaceSectionLabel(workspace('b', { agentActive: true }))).toBe('Working');
    expect(workspaceSectionLabel(workspace('c', { terminals: [] }))).toBe('Stopped');
    expect(workspaceSectionLabel(workspace('d', { status: 'trashed' }))).toBe('Trash');
  });
});

describe('workspaceProject', () => {
  const projects = [
    { id: 'p1', name: 'komla', repositoryPath: '/r/komla' },
    { id: 'p2', name: 'landing', repositoryPath: '/r/landing' },
  ];

  it("finds a workspace's project by id, or by name in an SSH host's list, which has no ids", () => {
    expect(
      workspaceProject(workspace('a', { projectId: 'p2', projectName: 'komla' }), projects)?.id
    ).toBe('p2');
    expect(workspaceProject(workspace('b', { projectName: 'landing' }), projects)?.id).toBe('p2');
    expect(
      workspaceProject(workspace('c', { projectId: 'gone', projectName: 'komla' }), projects)
    ).toBeUndefined();
    expect(workspaceProject(workspace('d'), projects)).toBeUndefined();
  });

  it('finds no project by a name two projects share', () => {
    const shared = [...projects, { id: 'p3', name: 'landing', repositoryPath: '/r/landing-2' }];

    expect(workspaceProject(workspace('a', { projectName: 'landing' }), shared)).toBeUndefined();
  });
});

describe('workspace sections', () => {
  it('puts attention first, then agent work, then idle terminals, then stopped workspaces', () => {
    expect(workspaceSectionId(workspace('a', { attention: attention(1), agentActive: true }))).toBe(
      'needs-you'
    );
    expect(workspaceSectionId(workspace('b', { agentActive: true }))).toBe('working');
    expect(workspaceSectionId(workspace('c', { provisioning: true, terminals: [] }))).toBe(
      'working'
    );
    expect(workspaceSectionId(workspace('d'))).toBe('idle');
    expect(
      workspaceSectionId(
        workspace('e', { terminals: [{ id: 'e-t', name: 'shell', status: 'stopped' }] })
      )
    ).toBe('stopped');
  });

  it('lists trashed workspaces in the Trash, whatever their terminals and attention show', () => {
    const trashed = workspace('t', {
      status: 'trashed',
      attention: attention(1),
      terminals: [{ id: 't-t', name: 'claude', status: 'stopped' }],
    });

    expect(workspaceSectionId(trashed)).toBe('trash');
    expect(
      buildWorkspaceSections([trashed, workspace('s', { terminals: [] })]).map((section) => [
        section.id,
        section.label,
      ])
    ).toEqual([
      ['stopped', 'Stopped'],
      ['trash', 'Trash'],
    ]);
  });

  it('orders sections by fixed priority and drops empty ones', () => {
    const sections = buildWorkspaceSections([
      workspace('stopped', { terminals: [] }),
      workspace('working', { agentActive: true }),
      workspace('attention', { attention: attention(5) }),
    ]);

    expect(sections.map((section) => [section.id, section.label])).toEqual([
      ['needs-you', 'Needs you'],
      ['working', 'Working'],
      ['stopped', 'Stopped'],
    ]);
  });

  it('sorts attention by when it was raised and the rest by last activity', () => {
    const sections = buildWorkspaceSections([
      workspace('old-attention', { attention: attention(10), lastActivityAt: 900 }),
      workspace('new-attention', { attention: attention(20), lastActivityAt: 100 }),
      workspace('quiet', { lastActivityAt: 50 }),
      workspace('recent', { lastActivityAt: 70 }),
    ]);

    expect(sections[0]?.workspaces.map((w) => w.id)).toEqual(['new-attention', 'old-attention']);
    expect(sections[1]?.workspaces.map((w) => w.id)).toEqual(['recent', 'quiet']);
  });

  it('filters to one section and counts every section before filtering', () => {
    const all = [
      workspace('a', { attention: attention(1) }),
      workspace('b', { agentActive: true }),
      workspace('c', { agentActive: true }),
    ];

    expect(buildWorkspaceSections(all, { filter: 'working' }).map((s) => s.id)).toEqual([
      'working',
    ]);
    expect(workspaceSectionCounts(all)).toEqual({
      'needs-you': 1,
      working: 2,
      idle: 0,
      stopped: 0,
      trash: 0,
    });
  });

  it('matches every search word, in any order and with one typo, against what the desktop searches', () => {
    const target = workspace('ws-1', {
      name: 'Fix passphrase prompt',
      description: 'Remember it per host',
      lastPrompt: 'make the askpass dialog keep the key',
      projectName: 'Komla',
      branchName: 'ssh-passphrase-memory',
      terminals: [
        {
          id: 't',
          name: 'codex',
          status: 'running',
          environment: { kind: 'ssh', name: 'devbox' },
        },
      ],
    });
    const found = (query: string) => [...(searchWorkspaces([target], query)?.keys() ?? [])];

    expect(searchWorkspaces([target], '  ')).toBeNull();
    expect(found('komla SSH')).toEqual(['ws-1']);
    expect(found('ws-1 codex')).toEqual(['ws-1']);
    expect(found('prompt fix')).toEqual(['ws-1']);
    expect(found('pasphrase')).toEqual(['ws-1']);
    expect(found('per host')).toEqual(['ws-1']);
    expect(found('askpass dialog')).toEqual(['ws-1']);
    expect(found('devbox')).toEqual(['ws-1']);
    expect(found('komla landing')).toEqual([]);
    expect(buildWorkspaceSections([target, workspace('other')], { query: 'prompt' })).toHaveLength(
      1
    );
  });

  it('lists title matches before newer workspaces found only elsewhere', () => {
    const titled = workspace('titled', { name: 'Landing page', lastActivityAt: 1 });
    const prompted = workspace('prompted', {
      lastPrompt: 'fix the landing page',
      lastActivityAt: 2,
    });

    const [idle] = buildWorkspaceSections([prompted, titled], { query: 'landing' });
    expect(idle!.workspaces.map((item) => item.id)).toEqual(['titled', 'prompted']);
    expect(searchWorkspaces([prompted, titled], 'landing')).toEqual(
      new Map([
        ['prompted', false],
        ['titled', true],
      ])
    );
  });
});
