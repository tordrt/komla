/**
 * @vitest-environment jsdom
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecentWorkspacesList } from '../../../../src/renderer/components/terminal/RecentWorkspacesList';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createProject, createTerminal, createWorkspace } from '../../../factories';

import type { AppConfig, Workspace } from '../../../../src/renderer/types';

vi.mock('../../../../src/renderer/stores/window.store', () => {
  const state = { windowId: 'window-1' };
  return { useWindowStore: <T,>(selector: (s: typeof state) => T) => selector(state) };
});

const originalSelect = useWorkspacesStore.getState().selectWorkspace;

afterEach(() => {
  act(() => {
    useWorkspacesStore.setState({ workspaces: [], selectWorkspace: originalSelect });
    useProjectsStore.setState({ projects: [] });
    useConfigStore.setState({ config: null });
  });
});

function renderList(workspaces: Workspace[]) {
  act(() => useWorkspacesStore.setState({ workspaces }));
  return render(<RecentWorkspacesList />);
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(name) });
}

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

  it('shows a spinner on a workspace whose agent works, as the sidebar does', () => {
    renderList([
      createWorkspace({
        id: 'ws-working',
        customName: 'Working one',
        agentActive: true,
        lastActivityAt: 2,
        terminals: [createTerminal({ status: 'running', agentActive: true })],
      }),
      createWorkspace({ id: 'ws-quiet', customName: 'Quiet one', lastActivityAt: 1 }),
    ]);

    expect(rowOf('Working one').querySelector('[data-working-agents="1"]')).toBeInTheDocument();
    expect(
      within(rowOf('Working one')).getByRole('status', { name: 'Agent processing' })
    ).toBeInTheDocument();
    expect(rowOf('Quiet one').querySelector('[data-working-agents]')).not.toBeInTheDocument();
  });

  it('counts the agents working in one workspace', () => {
    renderList([
      createWorkspace({
        id: 'ws-busy',
        customName: 'Busy one',
        agentActive: true,
        terminals: [
          createTerminal({ status: 'running', agentActive: true }),
          createTerminal({ status: 'running', agentActive: true }),
        ],
      }),
    ]);

    expect(rowOf('Busy one').querySelector('[data-working-agents="2"]')).toBeInTheDocument();
    expect(
      within(rowOf('Busy one')).getByRole('status', { name: '2 agents processing' })
    ).toBeInTheDocument();
  });

  it('shows the badge of a workspace waiting on you, without a spinner for that agent', () => {
    renderList([
      createWorkspace({
        id: 'ws-asking',
        customName: 'Asking one',
        agentActive: true,
        terminals: [
          createTerminal({
            id: 'asking-tab',
            status: 'running',
            agentActive: true,
            attention: {
              kind: 'input-required',
              source: 'claude-code',
              updatedAt: 1,
              terminalId: 'asking-tab',
            },
          }),
        ],
        attention: {
          kind: 'input-required',
          source: 'claude-code',
          updatedAt: 1,
          terminalId: 'asking-tab',
        },
      }),
    ]);

    expect(rowOf('Asking one')).toHaveTextContent('Input');
    expect(rowOf('Asking one').querySelector('[data-working-agents]')).not.toBeInTheDocument();
  });

  it("shows the badge of an agent's tab that is still unseen, as the sidebar does", () => {
    renderList([
      createWorkspace({
        id: 'ws-tab-done',
        customName: 'Tab done',
        terminals: [
          createTerminal({
            id: 'done-tab',
            status: 'running',
            attention: {
              kind: 'turn-complete',
              source: 'claude-code',
              updatedAt: 1,
              terminalId: 'done-tab',
            },
          }),
        ],
      }),
    ]);

    expect(rowOf('Tab done')).toHaveTextContent('Done');
  });

  it("marks the workspace's other agents beside its badge, as the sidebar does", () => {
    renderList([
      createWorkspace({
        id: 'ws-mixed',
        customName: 'Mixed one',
        terminals: [
          createTerminal({
            id: 'asking-tab',
            status: 'running',
            attention: {
              kind: 'input-required',
              source: 'claude-code',
              updatedAt: 2,
              terminalId: 'asking-tab',
            },
          }),
          createTerminal({
            id: 'failed-tab',
            status: 'running',
            attention: {
              kind: 'error',
              source: 'claude-code',
              updatedAt: 1,
              terminalId: 'failed-tab',
            },
          }),
        ],
      }),
    ]);

    expect(within(rowOf('Mixed one')).getByText('1 needs input')).toBeInTheDocument();
    expect(within(rowOf('Mixed one')).getByText('1 error')).toBeInTheDocument();
  });

  it('counts the agents that share the badge, as the sidebar does', () => {
    renderList([
      createWorkspace({
        id: 'ws-two-asking',
        customName: 'Two asking',
        terminals: ['a', 'b'].map((id, index) =>
          createTerminal({
            id,
            status: 'running',
            attention: {
              kind: 'input-required',
              source: 'claude-code',
              updatedAt: index + 1,
              terminalId: id,
            },
          })
        ),
      }),
    ]);

    expect(rowOf('Two asking')).toHaveTextContent('2 need input');
  });

  it('shows a workspace marked unread as done', () => {
    renderList([
      createWorkspace({
        id: 'ws-unread',
        customName: 'Unread one',
        unread: { reason: 'marked', at: 1 },
      }),
    ]);

    expect(rowOf('Unread one')).toHaveTextContent('Done');
  });

  it('hides the spinners when the activity spinner setting is off', () => {
    useConfigStore.setState({ config: { showAgentSpinner: false } as AppConfig });
    renderList([
      createWorkspace({
        id: 'ws-working',
        customName: 'Working one',
        agentActive: true,
        terminals: [createTerminal({ status: 'running', agentActive: true })],
      }),
    ]);

    expect(rowOf('Working one').querySelector('[data-working-agents]')).not.toBeInTheDocument();
    expect(within(rowOf('Working one')).queryByRole('status')).not.toBeInTheDocument();
  });
});
