/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BulkContextMenuContent } from '../../../../src/renderer/components/workspaces/BulkContextMenu';
import { createSshWorkspace, createTerminal, createWorkspace } from '../../../factories';

import type { Workspace } from '../../../../src/shared/types/workspace';

const workspacesState = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  selectedWorkspaceIds: new Set<string>(),
  stopSelectedWorkspaces: vi.fn(),
  trashSelectedWorkspaces: vi.fn(),
  deleteSelectedWorkspaces: vi.fn(),
  markSelectedUnread: vi.fn(),
  togglePinSelected: vi.fn(),
  snoozeSelected: vi.fn(),
  moveSelectedToWindow: vi.fn(),
  toggleLinkSelected: vi.fn(),
}));

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector?: (state: typeof workspacesState) => unknown) =>
    selector ? selector(workspacesState) : workspacesState,
}));

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: () => ({ availableWindows: [], windowId: 'window-1' }),
}));

vi.mock('../../../../src/renderer/components/workspaces/BulkDeleteDialog', () => ({
  BulkDeleteDialog: () => null,
}));

vi.mock(
  '../../../../src/renderer/components/workspaces/BulkTrashDialog',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../../src/renderer/components/workspaces/BulkTrashDialog')
    >()),
    BulkTrashDialog: ({
      open,
      workspaces,
      onConfirm,
    }: {
      open: boolean;
      workspaces: Workspace[];
      onConfirm: () => void;
    }) =>
      open ? (
        <button type="button" onClick={onConfirm}>
          Confirm trashing {workspaces.length}
        </button>
      ) : null,
  })
);

vi.mock('../../../../src/renderer/components/ui/context-menu', () => ({
  ContextMenuCheckboxItem: ({
    children,
    checked,
    onClick,
  }: {
    children: React.ReactNode;
    checked?: boolean;
    onClick?: () => void;
  }) => (
    <div role="menuitemcheckbox" aria-checked={checked} onClick={onClick}>
      {children}
    </div>
  ),
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <div role="menuitem" onClick={onClick}>
      {children}
    </div>
  ),
  ContextMenuSeparator: () => <div />,
  ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('BulkContextMenuContent', () => {
  it('offers snoozing until notified only while every selected workspace will notify', () => {
    const working = createWorkspace({ id: 'ws-working', agentActive: true, terminalCount: 1 });
    const idle = createWorkspace({ id: 'ws-idle' });
    workspacesState.workspaces = [working, idle];
    workspacesState.selectedWorkspaceIds = new Set([working.id, idle.id]);
    const { unmount } = render(<BulkContextMenuContent />);
    expect(screen.queryByRole('menuitem', { name: 'Until Notified' })).not.toBeInTheDocument();
    unmount();

    workspacesState.selectedWorkspaceIds = new Set([working.id]);
    workspacesState.snoozeSelected.mockClear();
    render(<BulkContextMenuContent />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Until Notified' }));
    expect(workspacesState.snoozeSelected).toHaveBeenCalledWith(undefined, true);
  });

  it('counts a selected workspace whose tmux session runs on its host as one to stop', () => {
    const elsewhere = createSshWorkspace({
      id: 'ws-elsewhere',
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
    });
    const stopped = createSshWorkspace({
      id: 'ws-stopped',
      terminals: [createTerminal({ status: 'stopped', remoteSessionActive: false })],
    });
    workspacesState.workspaces = [elsewhere, stopped];
    workspacesState.selectedWorkspaceIds = new Set([elsewhere.id, stopped.id]);

    render(<BulkContextMenuContent />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop (1)' }));

    expect(workspacesState.stopSelectedWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('asks before trashing several selected workspaces', () => {
    const first = createSshWorkspace({ id: 'ws-first' });
    const second = createSshWorkspace({ id: 'ws-second' });
    workspacesState.workspaces = [first, second];
    workspacesState.selectedWorkspaceIds = new Set([first.id, second.id]);
    workspacesState.trashSelectedWorkspaces.mockClear();

    render(<BulkContextMenuContent />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash (2)' }));
    expect(workspacesState.trashSelectedWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm trashing 2' }));
    expect(workspacesState.trashSelectedWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('trashes a single selected workspace without asking', () => {
    const only = createSshWorkspace({ id: 'ws-only' });
    workspacesState.workspaces = [only];
    workspacesState.selectedWorkspaceIds = new Set([only.id]);
    workspacesState.trashSelectedWorkspaces.mockClear();

    render(<BulkContextMenuContent />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash (1)' }));

    expect(workspacesState.trashSelectedWorkspaces).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Confirm trashing/ })).not.toBeInTheDocument();
  });

  it('counts only the workspaces that gain a link', () => {
    const a = createWorkspace({ id: 'ws-a', linkedWorkspaceIds: ['ws-b'] });
    const b = createWorkspace({ id: 'ws-b', linkedWorkspaceIds: ['ws-a'] });
    const c = createSshWorkspace({ id: 'ws-c' });
    const d = createSshWorkspace({ id: 'ws-d' });
    workspacesState.workspaces = [a, b, c, d];
    workspacesState.selectedWorkspaceIds = new Set([a.id, b.id, c.id, d.id]);
    workspacesState.toggleLinkSelected.mockClear();

    render(<BulkContextMenuContent />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link (2)' }));

    expect(workspacesState.toggleLinkSelected).toHaveBeenCalledTimes(1);
  });

  it('offers Unlink when every pair in the selection is already linked', () => {
    const a = createWorkspace({ id: 'ws-a', linkedWorkspaceIds: ['ws-b'] });
    const b = createWorkspace({ id: 'ws-b', linkedWorkspaceIds: ['ws-a'] });
    workspacesState.workspaces = [a, b];
    workspacesState.selectedWorkspaceIds = new Set([a.id, b.id]);

    render(<BulkContextMenuContent />);

    expect(screen.getByRole('menuitem', { name: 'Unlink (2)' })).toBeInTheDocument();
  });

  it('offers no link between workspaces that cannot be linked', () => {
    const local = createWorkspace({ id: 'ws-local' });
    const remote = createSshWorkspace({ id: 'ws-remote' });
    const trashed = createWorkspace({ id: 'ws-trashed', status: 'trashed' });
    workspacesState.workspaces = [local, remote, trashed];
    workspacesState.selectedWorkspaceIds = new Set([local.id, remote.id, trashed.id]);

    render(<BulkContextMenuContent />);

    expect(screen.queryByRole('menuitem', { name: /Link/ })).not.toBeInTheDocument();
  });
});
