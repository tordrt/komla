/**
 * @vitest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecentWorkspacesList } from '../../../../src/renderer/components/terminal/RecentWorkspacesList';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createProject, createWorkspace } from '../../../factories';

vi.mock('../../../../src/renderer/stores/window.store', () => {
  const state = { windowId: 'window-1' };
  return { useWindowStore: <T,>(selector: (s: typeof state) => T) => selector(state) };
});

const originalSelect = useWorkspacesStore.getState().selectWorkspace;

afterEach(() => {
  act(() => {
    useWorkspacesStore.setState({ workspaces: [], selectWorkspace: originalSelect });
    useProjectsStore.setState({ projects: [] });
  });
});

describe('RecentWorkspacesList', () => {
  it('lists the most recently active workspaces first, leaving out the Trash', () => {
    act(() =>
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'old', name: 'old-one', lastActivityAt: 1 }),
          createWorkspace({ id: 'new', name: 'new-one', lastActivityAt: 3 }),
          createWorkspace({ id: 'gone', name: 'gone-one', lastActivityAt: 5, status: 'trashed' }),
        ],
      })
    );

    render(<RecentWorkspacesList />);

    const rows = within(screen.getByRole('list', { name: 'Recent workspaces' })).getAllByRole(
      'button'
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('new-one'),
      expect.stringContaining('old-one'),
    ]);
  });

  it('opens a workspace when its row is clicked', async () => {
    const selectWorkspace = vi.fn(async () => {});
    act(() =>
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws', name: 'add-auth', lastActivityAt: 1, windowId: 'window-1' }),
        ],
        selectWorkspace,
      })
    );

    render(<RecentWorkspacesList />);
    await userEvent.click(screen.getByRole('button', { name: /add-auth/ }));

    expect(selectWorkspace).toHaveBeenCalledWith('ws');
  });

  it('brings forward the window that already shows a workspace', async () => {
    const selectWorkspace = vi.fn(async () => {});
    window.api = { focusWorkspaceWindow: vi.fn(async () => true) } as unknown as typeof window.api;
    act(() =>
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({
            id: 'elsewhere',
            name: 'add-auth',
            lastActivityAt: 1,
            windowId: 'window-2',
          }),
        ],
        selectWorkspace,
      })
    );

    render(<RecentWorkspacesList />);
    await userEvent.click(screen.getByRole('button', { name: /add-auth/ }));

    expect(window.api.focusWorkspaceWindow).toHaveBeenCalledWith('elsewhere', undefined);
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('leaves out the time of a workspace with no recorded activity', () => {
    act(() =>
      useWorkspacesStore.setState({
        workspaces: [createWorkspace({ id: 'ws', name: 'add-auth', lastActivityAt: 0 })],
      })
    );

    render(<RecentWorkspacesList />);

    const row = screen.getByRole('button', { name: /add-auth/ });
    expect(row.querySelector('.tabular-nums')).toBeNull();
    expect(row.textContent).not.toMatch(/^add-auth0/);
  });

  it("shows a workspace's details, as its sidebar card does, while the pointer rests on its row", async () => {
    act(() =>
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({
            id: 'ws',
            name: 'add-auth',
            lastActivityAt: 1,
            customDescription: 'Sign-in with passkeys',
          }),
        ],
      })
    );

    render(<RecentWorkspacesList />);
    await userEvent.hover(screen.getByRole('button', { name: /add-auth/ }));

    const details = await screen.findByRole('dialog', {}, { timeout: 2000 });
    expect(within(details).getByText('Sign-in with passkeys')).toBeInTheDocument();
  });

  it("shows a project's icon beside its name, as the sidebar does", () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    act(() => {
      useProjectsStore.setState({
        projects: [createProject({ id: 'p1', name: 'acme', icon })],
      });
      useWorkspacesStore.setState({
        workspaces: [createWorkspace({ id: 'a', name: 'a', projectId: 'p1', lastActivityAt: 1 })],
      });
    });

    const { container } = render(<RecentWorkspacesList />);

    expect(container.querySelector(`img[src="${icon}"]`)).not.toBeNull();
  });

  it('shows a folder for a directory project without an icon, as its sidebar header does', () => {
    act(() => {
      useProjectsStore.setState({
        projects: [createProject({ id: 'p1', name: 'notes', kind: 'directory' })],
      });
      useWorkspacesStore.setState({
        workspaces: [createWorkspace({ id: 'a', name: 'a', projectId: 'p1', lastActivityAt: 1 })],
      });
    });

    const { container } = render(<RecentWorkspacesList />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.rounded-full')).toBeNull();
  });

  it('renders nothing without workspaces', () => {
    const { container } = render(<RecentWorkspacesList />);
    expect(container).toBeEmptyDOMElement();
  });
});
