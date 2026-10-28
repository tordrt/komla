import { describe, expect, it, vi } from 'vitest';

import {
  createDirectoryWorkspace,
  createProject,
  createTerminal,
  createWorktreeWorkspace,
} from '../../factories';
import { workspaceCwdResolutionService } from '../../../src/main/services/workspace-cwd-resolution.service';

const mockRealpathSync = vi.hoisted(() => {
  const realpath = vi.fn((path: string) => path);
  return Object.assign(realpath, { native: realpath });
});

vi.mock('fs', () => ({
  realpathSync: mockRealpathSync,
}));

describe('workspaceCwdResolutionService', () => {
  it('resolves a nested cwd to the deepest matching workspace', () => {
    const parent = createDirectoryWorkspace({
      id: 'ws-parent',
      workingDirectory: '/projects/app',
    });
    const child = createDirectoryWorkspace({
      id: 'ws-child',
      workingDirectory: '/projects/app/packages/web',
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/projects/app/packages/web/src',
      {
        workspaces: [parent, child],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      },
      { rejectAmbiguousMatches: true }
    );

    expect(result.workspace?.id).toBe('ws-child');
  });

  it('uses the only running workspace when cwd fallback is otherwise ambiguous', () => {
    const stopped = createDirectoryWorkspace({
      id: 'ws-stopped',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'stopped' })],
    });
    const running = createDirectoryWorkspace({
      id: 'ws-running',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'running' })],
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/projects/shared/src',
      {
        workspaces: [stopped, running],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      },
      { rejectAmbiguousMatches: true }
    );

    expect(result.workspace?.id).toBe('ws-running');
  });

  it('rejects ambiguous cwd fallback when no single running workspace is obvious', () => {
    const first = createDirectoryWorkspace({
      id: 'ws-1',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'stopped' })],
    });
    const second = createDirectoryWorkspace({
      id: 'ws-2',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'stopped' })],
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/projects/shared/src',
      {
        workspaces: [first, second],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      },
      { rejectAmbiguousMatches: true }
    );

    expect(result).toEqual({
      error:
        'Multiple workspaces match cwd: /projects/shared/src. This MCP tool cannot safely choose a workspace unless exactly one matching workspace is running.',
    });
  });

  it('derives a project from cwd matches without requiring a single source workspace', () => {
    const project = createProject({ id: 'proj-1', kind: 'directory' });
    const first = createDirectoryWorkspace({
      id: 'ws-1',
      projectId: 'proj-1',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'running' })],
      windowId: 'window-1',
    });
    const second = createDirectoryWorkspace({
      id: 'ws-2',
      projectId: 'proj-1',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'running' })],
      windowId: 'window-2',
    });

    const result = workspaceCwdResolutionService.findProjectByCwd('/projects/shared/src', {
      workspaces: [first, second],
      getProject: (id) => (id === project.id ? project : undefined),
      komlaBasePath: '/mock/home/.komla',
    });

    expect(result.project?.id).toBe('proj-1');
    expect(result.sourceWorkspace).toBeUndefined();
  });

  it('matches managed worktree paths by sanitized project segment and branch segment', () => {
    const workspace = createWorktreeWorkspace({
      id: 'ws-worktree',
      workingDirectory: '/missing/path',
      repoName: 'My Cool Project',
      branchName: 'agent/feature',
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/mock/home/.komla/worktrees/My-Cool-Project/agent-feature/src',
      {
        workspaces: [workspace],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      }
    );

    expect(result.workspace?.id).toBe('ws-worktree');
  });
});
