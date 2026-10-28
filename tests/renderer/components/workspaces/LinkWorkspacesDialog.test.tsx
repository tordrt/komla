/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkWorkspacesDialog } from '../../../../src/renderer/components/workspaces/LinkWorkspacesDialog';
import { getLinkWorkspacePeers } from '../../../../src/renderer/components/workspaces/link-workspaces-dialog-utils';
import {
  createDirectoryWorkspace,
  createProject,
  createTerminal,
  createWorkspace,
  createWorktreeWorkspace,
} from '../../../factories';

import type { Terminal } from '../../../../src/shared/types/terminal';

const mockWorkspaces = vi.hoisted(() => [] as any[]);
const mockProjects = vi.hoisted(() => [] as any[]);
const mockLinkWorkspaces = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUnlinkWorkspace = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type = 'button',
    ...props
  }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button type={type} onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: any) => selector({ projects: mockProjects }),
}));

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: any) =>
    selector({
      workspaces: mockWorkspaces,
      linkWorkspaces: mockLinkWorkspaces,
      unlinkWorkspace: mockUnlinkWorkspace,
    }),
}));

describe('LinkWorkspacesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaces.splice(0, mockWorkspaces.length);
    mockProjects.splice(0, mockProjects.length);
    global.window.api = {
      getWorkspaces: vi.fn().mockResolvedValue([]),
    } as any;
  });

  it('keeps linked inactive workspaces visible so they can be unlinked', () => {
    const origin = createWorktreeWorkspace({
      id: 'origin',
      name: 'Origin',
      linkedWorkspaceIds: ['trashed-linked'],
      order: 0,
    });
    const trashedLinked = createWorktreeWorkspace({
      id: 'trashed-linked',
      name: 'Trashed Linked',
      status: 'trashed',
      order: 1,
    });
    const trashedUnlinked = createWorktreeWorkspace({
      id: 'trashed-unlinked',
      name: 'Trashed Unlinked',
      status: 'trashed',
      order: 2,
    });
    const activeCandidate = createWorktreeWorkspace({
      id: 'active-candidate',
      name: 'Active Candidate',
      status: 'active',
      order: 3,
    });

    const peers = getLinkWorkspacePeers(
      [origin, trashedLinked, trashedUnlinked, activeCandidate],
      origin.id,
      new Set(origin.linkedWorkspaceIds)
    );

    expect(peers.map((peer) => peer.id)).toEqual(['trashed-linked', 'active-candidate']);
  });

  it('hides unlinked provisioning workspaces but keeps linked ones visible', () => {
    const origin = createWorktreeWorkspace({
      id: 'origin',
      name: 'Origin',
      linkedWorkspaceIds: ['linked-provisioning'],
      order: 0,
    });
    const linkedProvisioning = createWorktreeWorkspace({
      id: 'linked-provisioning',
      name: 'Linked Provisioning',
      status: 'active',
      provisioning: true,
      workingDirectory: '',
      order: 1,
    });
    const unlinkedProvisioning = createWorktreeWorkspace({
      id: 'unlinked-provisioning',
      name: 'Unlinked Provisioning',
      status: 'active',
      provisioning: true,
      workingDirectory: '',
      order: 2,
    });
    const missingDirectory = createWorktreeWorkspace({
      id: 'missing-directory',
      name: 'Missing Directory',
      status: 'active',
      workingDirectory: '',
      order: 3,
    });
    const readyCandidate = createWorktreeWorkspace({
      id: 'ready-candidate',
      name: 'Ready Candidate',
      status: 'active',
      order: 4,
    });

    const peers = getLinkWorkspacePeers(
      [origin, linkedProvisioning, unlinkedProvisioning, missingDirectory, readyCandidate],
      origin.id,
      new Set(origin.linkedWorkspaceIds)
    );

    expect(peers.map((peer) => peer.id)).toEqual(['linked-provisioning', 'ready-candidate']);
  });

  it('only offers local peers to local workspaces', () => {
    const origin = createWorktreeWorkspace({ id: 'local-origin' });
    const localPeer = createWorktreeWorkspace({ id: 'local-peer' });
    const sshPeer = createWorkspace({
      id: 'ssh-peer',
      backend: {
        kind: 'ssh',
        hostId: 'host-1',
        remoteDirectory: '/work/ssh-peer',
        remoteRepoPath: '/repos/project.git',
        remoteProjectRoot: '/work',
        gitUrl: 'git@example.com:project.git',
      },
      workingDirectory: 'ssh://host-1/work/ssh-peer',
    });

    const peers = getLinkWorkspacePeers([origin, localPeer, sshPeer], origin.id, new Set());

    expect(peers.map((peer) => peer.id)).toEqual(['local-peer']);
  });

  it('only offers SSH peers on the same host to SSH workspaces', () => {
    const createSshWorkspace = (id: string, hostId: string) =>
      createWorkspace({
        id,
        backend: {
          kind: 'ssh',
          hostId,
          remoteDirectory: `/work/${id}`,
          remoteRepoPath: '/repos/project.git',
          remoteProjectRoot: '/work',
          gitUrl: 'git@example.com:project.git',
        },
        workingDirectory: `ssh://${hostId}/work/${id}`,
      });
    const origin = createSshWorkspace('ssh-origin', 'host-1');
    const sameHostPeer = createSshWorkspace('ssh-same-host', 'host-1');
    const otherHostPeer = createSshWorkspace('ssh-other-host', 'host-2');
    const localPeer = createWorktreeWorkspace({ id: 'local-peer' });

    const peers = getLinkWorkspacePeers(
      [origin, sameHostPeer, otherHostPeer, localPeer],
      origin.id,
      new Set()
    );

    expect(peers.map((peer) => peer.id)).toEqual(['ssh-same-host']);
  });

  it('marks a peer running while its agent runs on the host from another device', () => {
    const createSshWorkspace = (id: string, terminals: Terminal[]) =>
      createWorkspace({
        id,
        name: id,
        backend: {
          kind: 'ssh',
          hostId: 'host-1',
          remoteDirectory: `/work/${id}`,
          remoteRepoPath: '/repos/project.git',
          remoteProjectRoot: '/work',
          gitUrl: 'git@example.com:project.git',
        },
        workingDirectory: `ssh://host-1/work/${id}`,
        terminals,
      });
    const origin = createSshWorkspace('ssh-origin', []);
    const peer = createSshWorkspace('ssh-peer', [
      createTerminal({ status: 'stopped', remoteSessionOnHost: true }),
    ]);
    mockWorkspaces.push(origin, peer);

    render(<LinkWorkspacesDialog open={true} onOpenChange={vi.fn()} workspace={origin} />);

    expect(screen.getByLabelText('Running')).toBeInTheDocument();
  });

  it('offers no peers while the SSH origin is still provisioning', () => {
    const createSshWorkspace = (id: string, provisioning = false) =>
      createWorkspace({
        id,
        provisioning,
        backend: {
          kind: 'ssh',
          hostId: 'host-1',
          remoteDirectory: `/work/${id}`,
          remoteRepoPath: '/repos/project.git',
          remoteProjectRoot: '/work',
          gitUrl: 'git@example.com:project.git',
        },
        workingDirectory: provisioning ? '' : `ssh://host-1/work/${id}`,
      });
    const origin = createSshWorkspace('ssh-origin', true);
    const readyPeer = createSshWorkspace('ssh-ready');

    const peers = getLinkWorkspacePeers([origin, readyPeer], origin.id, new Set());

    expect(peers).toEqual([]);
  });

  it('shows a directory project group as one selectable entry', async () => {
    const user = userEvent.setup();
    const origin = createWorktreeWorkspace({
      id: 'origin',
      name: 'Origin',
      linkedWorkspaceIds: [],
      order: 0,
    });
    const directoryProject = createProject({
      id: 'dir-project',
      kind: 'directory',
      name: 'Directory Project',
      repositoryPath: '/plain/folder',
      order: 1,
    });
    const firstDirWorkspace = createDirectoryWorkspace({
      id: 'dir-ws-1',
      name: 'Directory Workspace 1',
      projectId: 'dir-project',
      workingDirectory: '/plain/folder',
      order: 1,
    });
    const secondDirWorkspace = createDirectoryWorkspace({
      id: 'dir-ws-2',
      name: 'Directory Workspace 2',
      projectId: 'dir-project',
      workingDirectory: '/plain/folder',
      order: 2,
    });
    mockProjects.push(directoryProject);
    mockWorkspaces.push(origin, firstDirWorkspace, secondDirWorkspace);

    render(<LinkWorkspacesDialog open={true} onOpenChange={vi.fn()} workspace={origin} />);

    expect(screen.getAllByText('Directory Project')).toHaveLength(1);
    expect(screen.queryByText('Directory Workspace 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Directory Workspace 2')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /directory project/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(mockLinkWorkspaces).toHaveBeenCalledWith('origin', ['dir-ws-1', 'dir-ws-2']);
  });

  it('keeps the pending selection when workspaces reload with the same links', async () => {
    const user = userEvent.setup();
    const origin = createWorktreeWorkspace({
      id: 'origin',
      name: 'Origin',
      linkedWorkspaceIds: ['linked'],
      order: 0,
    });
    const linked = createWorktreeWorkspace({ id: 'linked', name: 'Linked', order: 1 });
    const unlinked = createWorktreeWorkspace({ id: 'unlinked', name: 'Unlinked', order: 2 });
    mockWorkspaces.push(origin, linked, unlinked);

    const { rerender } = render(
      <LinkWorkspacesDialog open={true} onOpenChange={vi.fn()} workspace={origin} />
    );
    await user.click(screen.getByText('Unlinked'));
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();

    // A workspaces reload hands every workspace new objects and arrays.
    const reloaded = { ...origin, linkedWorkspaceIds: ['linked'] };
    rerender(<LinkWorkspacesDialog open={true} onOpenChange={vi.fn()} workspace={reloaded} />);

    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
  });
});
