/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AddSshRepositoryAsProjectButton,
  SshRepositoryGroupContextMenu,
  sshWorkspacesWithoutProject,
} from '../../../../src/renderer/components/workspaces/SshRepositoryGroupContextMenu';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { createProject, createWorktreeWorkspace } from '../../../factories';

import type { Workspace } from '../../../../src/renderer/types';

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));
// Render the context menu inline so its items are plain buttons.
vi.mock('../../../../src/renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
  }: React.PropsWithChildren<{ disabled?: boolean; onSelect?: () => void }>) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuSub: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  ContextMenuSubContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

const backend = {
  kind: 'ssh' as const,
  hostId: 'ssh-dev',
  remoteDirectory: '/home/dev/.komla/worktrees/app/fix-login',
  remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
  remoteProjectRoot: '/home/dev/.komla/worktrees/app',
  gitUrl: 'git@github.com:acme/app.git',
};

function sshWorkspace(overrides: Partial<Workspace> = {}) {
  const workspace = createWorktreeWorkspace({
    id: 'ws-42',
    projectId: null,
    repoName: 'app',
    backend,
    ...overrides,
  });
  const [found] = sshWorkspacesWithoutProject({
    key: 'repo:app',
    projectId: null,
    projectInfo: { name: 'app', color: '#000' },
    workspaces: [workspace],
  });
  if (!found) throw new Error('expected an SSH workspace without a project');
  return found;
}

describe('SSH repository groups', () => {
  const createProjectFromRemote = vi.fn();
  const linkSshWorkspaceToProject = vi.fn();

  beforeEach(() => {
    createProjectFromRemote.mockReset();
    linkSshWorkspaceToProject.mockReset().mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
    useProjectsStore.setState({
      projects: [
        createProject({ id: 'project-1', name: 'Komla' }),
        createProject({ id: 'dir-1', name: 'Notes', kind: 'directory' }),
      ],
      createProjectFromRemote,
    });
    (window as unknown as { api: Record<string, unknown> }).api = { linkSshWorkspaceToProject };
  });

  it('only offers its actions for SSH workspaces without a project', () => {
    const group = {
      key: 'repo:app',
      projectId: null,
      projectInfo: { name: 'app', color: '#000' },
    };
    expect(
      sshWorkspacesWithoutProject({ ...group, workspaces: [createWorktreeWorkspace()] })
    ).toEqual([]);
    expect(
      sshWorkspacesWithoutProject({
        ...group,
        projectId: 'project-1',
        workspaces: [createWorktreeWorkspace({ backend })],
      })
    ).toEqual([]);
  });

  it('adds the repository as a project from the group header', async () => {
    let finish: (project: { name: string }) => void = () => undefined;
    createProjectFromRemote.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<AddSshRepositoryAsProjectButton workspace={sshWorkspace()} repoName="app" />);

    const button = screen.getByRole('button', { name: 'Add app as a project' });
    fireEvent.click(button);

    expect(createProjectFromRemote).toHaveBeenCalledWith({
      remoteUrl: 'git@github.com:acme/app.git',
    });
    expect(button).toBeDisabled();
    await act(async () => finish({ name: 'app' }));
    expect(button).not.toBeDisabled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: 'Added app as a project', type: 'success' }),
    ]);
  });

  it('links the group to a git project chosen from its menu', async () => {
    render(
      <SshRepositoryGroupContextMenu
        workspaces={[
          sshWorkspace(),
          sshWorkspace({ id: 'ws-43' }),
          sshWorkspace({ id: 'ws-44', backend: { ...backend, hostId: 'ssh-other' } }),
        ]}
      >
        <div>app</div>
      </SshRepositoryGroupContextMenu>
    );

    expect(screen.queryByRole('menuitem', { name: 'Notes' })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Komla' }));
    });

    // One call per clone moves that clone's workspaces; the group spans two hosts.
    expect(linkSshWorkspaceToProject.mock.calls).toEqual([
      ['ws-43', 'project-1'],
      ['ws-44', 'project-1'],
    ]);
  });
});
