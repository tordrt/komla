/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DashboardRow } from '../../../../src/renderer/components/dashboard/DashboardRow';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { createSshWorkspace, createTerminal, createWorkspace } from '../../../factories';

import type { AppConfig } from '../../../../src/renderer/types';

vi.mock('@phosphor-icons/react', async () => {
  const actual =
    await vi.importActual<typeof import('@phosphor-icons/react')>('@phosphor-icons/react');
  return {
    ...actual,
    Cloud: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="cloud-icon" {...props} />,
    GitBranch: (props: React.SVGProps<SVGSVGElement>) => (
      <svg data-testid="branch-icon" {...props} />
    ),
  };
});

vi.mock('../../../../src/renderer/components/workspaces/GitStatusIndicator', () => ({
  GitStatusIndicator: () => null,
}));

vi.mock('../../../../src/renderer/stores/git-status.store', () => ({
  useGitStatusStore: Object.assign(
    (
      selector?: (state: {
        fetchStatusIfStale: () => Promise<void>;
        statusMap: Map<string, never>;
      }) => unknown
    ) => {
      const state = {
        fetchStatusIfStale: vi.fn().mockResolvedValue(undefined),
        statusMap: new Map<string, never>(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        fetchStatusIfStale: vi.fn().mockResolvedValue(undefined),
        statusMap: new Map<string, never>(),
      }),
    }
  ),
}));

function defaultWorkspace(terminals = [createTerminal({ status: 'running' })]) {
  return createWorkspace({
    id: 'ws-default',
    name: 'Default',
    isWorktree: false,
    terminals,
    projectId: null,
  });
}

function rowProps(
  overrides: Partial<React.ComponentProps<typeof DashboardRow>> = {}
): React.ComponentProps<typeof DashboardRow> {
  return {
    workspace: defaultWorkspace(),
    projectInfo: { name: 'Global', color: '#888888' },
    onOpen: vi.fn(),
    onToggleTrashed: vi.fn(),
    onStopWorkspace: vi.fn(),
    onSaveCustomName: vi.fn(),
    onRegenerateCustomName: vi.fn(),
    onDeleteWorkspace: vi.fn().mockResolvedValue(undefined),
    onOpenProjectSettings: vi.fn(),
    onTogglePinned: vi.fn(),
    onMarkUnread: vi.fn(),
    ...overrides,
  };
}

function renderDashboardRow(overrides: Partial<React.ComponentProps<typeof DashboardRow>> = {}) {
  const props = rowProps(overrides);
  render(
    <TooltipProvider>
      <DashboardRow {...props} />
    </TooltipProvider>
  );
  return { props };
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest<HTMLElement>('[data-dashboard-row]');
  if (!row) throw new Error(`Dashboard row for ${text} not found`);
  return row;
}

function setWidths(element: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
}

function runningIndicatorOf(text: string): HTMLElement {
  const indicator = rowOf(text).querySelector<HTMLElement>('[data-running-indicator]');
  if (!indicator) throw new Error(`Running indicator for ${text} not found`);
  return indicator;
}

describe('DashboardRow', () => {
  it('renders a custom notification title, body, and color', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-custom-notification',
        name: 'Feature Work',
        isWorktree: true,
        branchName: 'feature/test',
        terminals: [],
        projectId: 'project-1',
        attention: {
          kind: 'generic',
          source: 'custom-hook',
          updatedAt: 1,
          title: 'Review ready',
          body: 'Authentication changes are waiting.',
          color: '#8b5cf6',
        },
      }),
      projectInfo: { name: 'App', color: '#123456' },
    });

    const label = screen.getByText('Review ready');
    // A long title ends in an ellipsis instead of spilling out of the pill.
    expect(label).toHaveClass('truncate');
    expect(label.parentElement).toHaveStyle({ backgroundColor: '#8b5cf6' });
    expect(screen.getByText('Authentication changes are waiting.')).toBeVisible();
    expect(screen.getByText('feature/test')).toBeInTheDocument();
  });

  it('shows the full custom description in a hover tooltip', async () => {
    const user = userEvent.setup();
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-regular-description',
        name: 'Feature Work',
        isWorktree: true,
        branchName: 'feature/test',
        terminals: [],
        projectId: 'project-1',
        customDescription: 'Longer description for hover tooltip',
      }),
      projectInfo: { name: 'App', color: '#123456' },
    });

    await user.hover(screen.getByText('Feature Work'));

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Longer description for hover tooltip');
    });
  });

  it('opens the context menu for a workspace row', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-regular',
        name: 'Feature Work',
        isWorktree: true,
        branchName: 'feature/test',
        terminals: [createTerminal({ status: 'running' })],
        projectId: 'project-1',
      }),
      projectInfo: { name: 'App', color: '#123456' },
    });

    fireEvent.contextMenu(rowOf('Feature Work'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Stop Workspace')).toBeInTheDocument();
    expect(screen.getByText('Move to Trash')).toBeInTheDocument();
  });

  it('resets a workspace title when the title is cleared', async () => {
    const user = userEvent.setup();
    const onSaveCustomName = vi.fn();
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-reset-title',
        name: 'Feature Work',
        customName: 'Old Task',
        promptSubmits: [{ prompt: 'Old prompt', submittedAt: 1 }],
        isWorktree: true,
        branchName: 'feature/test',
        terminals: [],
        projectId: 'project-1',
      }),
      projectInfo: { name: 'App', color: '#123456' },
      onSaveCustomName,
    });

    fireEvent.contextMenu(rowOf('Old Task'));

    expect(screen.queryByText('reset')).not.toBeInTheDocument();
    await user.click(screen.getByText('edit'));
    await user.clear(screen.getByPlaceholderText('Custom workspace name'));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onSaveCustomName).toHaveBeenCalledWith(null);
  });

  it('keeps a faded project color on stopped rows', () => {
    renderDashboardRow({ workspace: defaultWorkspace([]) });

    expect(runningIndicatorOf('Default')).toHaveStyle({ backgroundColor: '#888888' });
    expect(runningIndicatorOf('Default')).toHaveClass('opacity-40');
  });

  it('gives rows without a project a neutral indicator', () => {
    renderDashboardRow({ workspace: defaultWorkspace([]), projectInfo: null });

    expect(runningIndicatorOf('Default').style.backgroundColor).toBe('oklch(var(--border))');
  });

  it('colors the running indicator with the full project color on running rows', () => {
    renderDashboardRow();

    expect(runningIndicatorOf('Default')).toHaveStyle({ backgroundColor: '#888888' });
    expect(runningIndicatorOf('Default')).not.toHaveClass('opacity-40');
  });

  it('shows the whole agent message on hover when the row cuts it off', async () => {
    const user = userEvent.setup();
    const message = 'Refactored the session store and moved the retry logic into the client';
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-long-message',
        name: 'Session work',
        terminals: [],
        attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1, message },
      }),
    });
    const text = screen.getByText(message);
    setWidths(text, 600, 300);

    await user.hover(text);

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent(message);
    });
  });

  it('shows the notification as a card when its badge is hovered', async () => {
    const user = userEvent.setup();
    const message = 'Refactored the session store.\n\nTests pass; the staging secret is missing.';
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-badge-card',
        name: 'Session work',
        terminals: [],
        attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: Date.now(), message },
      }),
    });

    await user.hover(screen.getByText('Done'));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe(`Agent finished a turnnow${message}`);
  });

  it('shows the whole last prompt on hover when the row cuts it off', async () => {
    const user = userEvent.setup();
    const prompt = 'Fix the login redirect.\nThen add a test for the expired session case.';
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-long-prompt',
        name: 'Login fix',
        terminals: [],
        promptSubmits: [{ prompt, submittedAt: 1 }],
      }),
    });
    const text = screen.getByText((_, element) => element?.textContent === prompt, {
      selector: 'span',
    });
    setWidths(text, 600, 300);

    await user.hover(text);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe(prompt);
  });

  it('shows a row whose tmux session runs on its host, e.g. on another device, as running', () => {
    const { props } = renderDashboardRow({
      workspace: createSshWorkspace({
        id: 'ws-default',
        name: 'Default',
        isWorktree: false,
        terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
        projectId: null,
      }),
    });
    const card = rowOf('Default');

    expect(runningIndicatorOf('Default')).toHaveStyle({ backgroundColor: '#888888' });
    fireEvent.keyDown(card, { key: 's' });
    expect(props.onStopWorkspace).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(card);
    expect(screen.getByText('Stop Workspace')).toBeInTheDocument();
  });

  it('trashes and stops with the plain t/s row hotkeys', () => {
    const { props } = renderDashboardRow();
    const card = rowOf('Default');

    fireEvent.keyDown(card, { key: 't' });
    fireEvent.keyDown(card, { key: 's' });

    expect(props.onToggleTrashed).toHaveBeenCalledTimes(1);
    expect(props.onStopWorkspace).toHaveBeenCalledTimes(1);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])(
    'ignores the t/s row hotkeys when a modifier is held (%o)',
    (modifier) => {
      const { props } = renderDashboardRow();
      const card = rowOf('Default');

      const trashNotPrevented = fireEvent.keyDown(card, { key: 't', ...modifier });
      const stopNotPrevented = fireEvent.keyDown(card, { key: 's', ...modifier });

      expect(props.onToggleTrashed).not.toHaveBeenCalled();
      expect(props.onStopWorkspace).not.toHaveBeenCalled();
      expect(trashNotPrevented).toBe(true);
      expect(stopNotPrevented).toBe(true);
    }
  );

  it('uses the cloud icon and shows host context for remote workspaces', async () => {
    const user = userEvent.setup();
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-remote',
        name: 'Remote Work',
        isWorktree: true,
        branchName: 'feature/remote',
        projectId: 'project-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-devbox',
          remoteDirectory: '/home/developer/project',
          remoteRepoPath: '/home/developer/project',
          remoteProjectRoot: '/home/developer/project',
          gitUrl: 'git@example.com:project.git',
        },
      }),
      projectInfo: { name: 'App', color: '#123456' },
      sshHost: {
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        user: 'developer',
        basePath: '/home/developer',
      },
    });

    expect(screen.getByTestId('cloud-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-icon')).not.toBeInTheDocument();

    await user.hover(screen.getByText('Remote Work'));
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Devbox');
    });
    expect(within(screen.getByRole('tooltip')).getByTitle('developer@devbox.example.com')).toBe(
      within(screen.getByRole('tooltip')).getByText('Devbox').parentElement
    );
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('/home/developer/project');
  });

  it('shows the same workspace details as the sidebar card on hover', async () => {
    const user = userEvent.setup();
    const copyToClipboard = vi.fn();
    window.api = { copyToClipboard } as unknown as typeof window.api;
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-details',
        name: 'tooltip-polish',
        customName: 'Tooltip polish',
        lastDynamicTitle: 'Fixing tab tooltips',
        isWorktree: true,
        branchName: 'feature/tooltips',
        branchedFrom: 'release/2.0',
        workingDirectory: '/Users/dev/.komla/worktrees/app/feature-tooltips',
        terminals: [],
        projectId: 'project-1',
      }),
    });

    await user.hover(screen.getByText('Tooltip polish'));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Fixing tab tooltips');
    expect(tooltip).toHaveTextContent('from release/2.0');
    // The row shows the branch, and the menu copies the path.
    expect(tooltip).not.toHaveTextContent('feature/tooltips');
    expect(tooltip).not.toHaveTextContent('/Users/dev/.komla/worktrees/app/feature-tooltips');
    expect(screen.queryByRole('button', { name: 'Copy workspace path' })).not.toBeInTheDocument();
    // The row's branch truncates, so pointing at it shows it whole.
    expect(screen.getByTitle('feature/tooltips')).toHaveTextContent('feature/tooltips');
  });

  it('copies the workspace path and branch name from the context menu', async () => {
    const user = userEvent.setup();
    const copyToClipboard = vi.fn();
    window.api = { copyToClipboard } as unknown as typeof window.api;
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-copy',
        name: 'Copy Work',
        isWorktree: true,
        branchName: 'feature/copy',
        workingDirectory: '/Users/dev/.komla/worktrees/app/feature-copy',
        terminals: [],
        projectId: 'project-1',
      }),
    });

    fireEvent.contextMenu(rowOf('Copy Work'));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Path' }));
    expect(copyToClipboard).toHaveBeenCalledWith('/Users/dev/.komla/worktrees/app/feature-copy');

    fireEvent.contextMenu(rowOf('Copy Work'));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Branch Name' }));
    expect(copyToClipboard).toHaveBeenCalledWith('feature/copy');
  });

  it('dims trashed rows', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-trashed',
        name: 'Default',
        status: 'trashed',
        terminals: [],
      }),
    });

    expect(rowOf('Default')).toHaveClass('opacity-60');
  });

  it('does not dim active rows, even when stopped', () => {
    renderDashboardRow({ workspace: defaultWorkspace([]) });

    expect(rowOf('Default')).not.toHaveClass('opacity-60');
  });

  it("shows the agent's question next to its status badge", () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-input',
        name: 'Default',
        terminals: [],
        attention: {
          kind: 'input-required',
          source: 'claude-code',
          updatedAt: 1,
          message: 'Allow Bash(npm test)?',
        },
      }),
    });

    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Allow Bash(npm test)?')).toBeVisible();
  });

  it('shows what a working agent is doing', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-working',
        name: 'Default',
        customName: 'Sync push',
        agentActive: true,
        terminals: [
          createTerminal({ status: 'running', dynamicTitle: '✳ Wiring the file watcher' }),
        ],
      }),
    });

    expect(screen.getByText('Wiring the file watcher')).toBeVisible();
  });

  it('shows a spinner while the agent works, leaving the text to say so', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-working',
        name: 'Default',
        agentActive: true,
        terminals: [createTerminal({ status: 'running', agentActive: true })],
      }),
    });

    expect(rowOf('Default').querySelector('[data-working-agents="1"]')).toBeInTheDocument();
    expect(screen.getByText('Working…')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('counts the agents still working beside the badge', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-mixed',
        name: 'Default',
        agentActive: true,
        terminals: [
          createTerminal({
            id: 'done-tab',
            status: 'running',
            attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1 },
          }),
          createTerminal({ status: 'running', agentActive: true }),
          createTerminal({ status: 'running', agentActive: true }),
        ],
        attention: {
          kind: 'turn-complete',
          source: 'claude-code',
          updatedAt: 1,
          terminalId: 'done-tab',
        },
      }),
    });

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '2 agents processing' })).toBeInTheDocument();
  });

  it('shows no spinner for an agent that waits on input', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-asking',
        name: 'Default',
        agentActive: true,
        terminals: [
          createTerminal({
            status: 'running',
            agentActive: true,
            attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
          }),
        ],
      }),
    });

    expect(rowOf('Default').querySelector('[data-working-agents]')).not.toBeInTheDocument();
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
  });

  it('hides the spinners when the activity spinner setting is off', () => {
    useConfigStore.setState({ config: { showAgentSpinner: false } as AppConfig });
    try {
      renderDashboardRow({
        workspace: createWorkspace({
          id: 'ws-mixed',
          name: 'Default',
          agentActive: true,
          terminals: [createTerminal({ status: 'running', agentActive: true })],
          attention: { kind: 'generic', source: 'claude-code', updatedAt: 1, title: 'Notice' },
        }),
      });

      expect(screen.getByText('Notice')).toBeInTheDocument();
      expect(rowOf('Default').querySelector('[data-working-agents]')).not.toBeInTheDocument();
    } finally {
      useConfigStore.setState({ config: null });
    }
  });

  it('otherwise shows the last prompt sent to the agent', () => {
    renderDashboardRow({
      workspace: createWorkspace({
        id: 'ws-prompted',
        name: 'Default',
        terminals: [],
        promptSubmits: [
          { prompt: 'first ask', submittedAt: 1 },
          { prompt: 'fix the overflow on small phones', submittedAt: 2 },
        ],
      }),
    });

    expect(screen.getByText('fix the overflow on small phones')).toBeVisible();
    expect(screen.queryByText('first ask')).not.toBeInTheDocument();
  });

  it('trashes and stops from the row buttons without opening the workspace', () => {
    const { props } = renderDashboardRow();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop workspace' }));

    expect(props.onToggleTrashed).toHaveBeenCalledTimes(1);
    expect(props.onStopWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('offers Restore and no Stop on a trashed row', () => {
    renderDashboardRow({
      workspace: createWorkspace({ id: 'ws-trashed', name: 'Default', status: 'trashed' }),
    });

    expect(screen.getByRole('button', { name: 'Restore workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop workspace' })).not.toBeInTheDocument();
  });

  it('leaves Enter on a row button to that button', () => {
    const { props } = renderDashboardRow();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Move to Trash' }), { key: 'Enter' });

    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('moves between rows with j/k and the arrow keys', () => {
    render(
      <TooltipProvider>
        <DashboardRow
          {...rowProps({
            workspace: createWorkspace({ id: 'ws-1', name: 'First', terminals: [] }),
          })}
        />
        <DashboardRow
          {...rowProps({
            workspace: createWorkspace({ id: 'ws-2', name: 'Second', terminals: [] }),
          })}
        />
      </TooltipProvider>
    );
    const first = rowOf('First');
    const second = rowOf('Second');

    first.focus();
    fireEvent.keyDown(first, { key: 'j' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'k' });
    expect(first).toHaveFocus();
  });
});
