import { describe, expect, it } from 'vitest';

import {
  getProjectIdsWithListedGroups,
  hasWorkspacesHiddenByHost,
} from '../../../../src/renderer/components/workspaces/workspace-list-filtering';
import { createWorkspace } from '../../../factories';

const remoteBackend = {
  kind: 'ssh' as const,
  hostId: 'ssh-devbox',
  remoteDirectory: '/home/dev/worktree',
  remoteRepoPath: '/home/dev/repo.git',
  remoteProjectRoot: '/home/dev',
  gitUrl: 'git@example.com:repo.git',
  projectName: 'Repo',
};

describe('hasWorkspacesHiddenByHost', () => {
  it('ignores stopped workspaces when stopped workspaces are hidden', () => {
    const workspace = createWorkspace({
      windowId: 'window-1',
      backend: remoteBackend,
      terminals: [],
    });

    expect(
      hasWorkspacesHiddenByHost([workspace], new Set(['ssh-devbox']), {
        currentWindowId: 'window-1',
        hideStopped: true,
        hiddenProjectIds: new Set(),
      })
    ).toBe(false);
  });

  it('ignores hidden-project workspaces', () => {
    const workspace = createWorkspace({
      windowId: 'window-1',
      projectId: 'project-1',
      backend: remoteBackend,
      terminalCount: 1,
    });

    expect(
      hasWorkspacesHiddenByHost([workspace], new Set(['ssh-devbox']), {
        currentWindowId: 'window-1',
        hideStopped: false,
        hiddenProjectIds: new Set(['project-1']),
      })
    ).toBe(false);
  });

  it('finds an otherwise visible workspace on a hidden host', () => {
    const workspace = createWorkspace({
      windowId: 'window-1',
      backend: remoteBackend,
      terminalCount: 1,
    });

    expect(
      hasWorkspacesHiddenByHost([workspace], new Set(['ssh-devbox']), {
        currentWindowId: 'window-1',
        hideStopped: true,
        hiddenProjectIds: new Set(),
      })
    ).toBe(true);
  });
});

describe('getProjectIdsWithListedGroups', () => {
  const filters = {
    currentWindowId: 'window-1',
    hideStopped: false,
    hiddenProjectIds: new Set<string>(),
    hiddenWorkspaceHostIds: new Set<string>(),
  };

  it('lists the projects of listed workspaces, pinned ones included', () => {
    const workspaces = [
      createWorkspace({ windowId: 'window-1', projectId: 'project-1' }),
      createWorkspace({ windowId: 'window-1', projectId: 'project-2', pinned: true }),
    ];

    expect(getProjectIdsWithListedGroups(workspaces, filters)).toEqual(
      new Set(['project-1', 'project-2'])
    );
  });

  it('leaves out hidden projects, other windows and snoozed workspaces', () => {
    const workspaces = [
      createWorkspace({ windowId: 'window-1', projectId: 'project-1' }),
      createWorkspace({ windowId: 'window-2', projectId: 'project-2' }),
      createWorkspace({ windowId: 'window-1', projectId: 'project-3', snoozedUntil: Date.now() }),
    ];

    expect(
      getProjectIdsWithListedGroups(workspaces, {
        ...filters,
        hiddenProjectIds: new Set(['project-1']),
      })
    ).toEqual(new Set());
  });
});
