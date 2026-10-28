/**
 * @vitest-environment jsdom
 *
 * Forking from, or launching actions on, a remote-only branch must go through
 * origin/<branch> with a fresh fetch, the same way QuickCreateMenu does it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectGroupContextMenu } from '../../../../src/renderer/components/workspaces/ProjectGroupContextMenu';

const { mockCreateWorkspace, mockAddTerminalCommand } = vi.hoisted(() => ({
  mockCreateWorkspace: vi.fn(),
  mockAddTerminalCommand: vi.fn(),
}));

vi.mock('../../../../src/shared/lib/random-names', () => ({
  generateBranchSuffix: vi.fn(() => 'swift-fox'),
  branchSuffixToName: vi.fn((s: string) => s),
}));

vi.mock('../../../../src/renderer/components/ui/context-menu', () => {
  const Passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  // Submenus report themselves open on mount so the branch picker loads.
  const Sub = ({
    children,
    onOpenChange,
  }: React.PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => {
    React.useEffect(() => onOpenChange?.(true), []); // eslint-disable-line react-hooks/exhaustive-deps
    return <>{children}</>;
  };
  const Item = ({
    children,
    onClick,
    ...props
  }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button type="button" role="menuitem" onClick={onClick} {...props}>
      {children}
    </button>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuLabel: Passthrough,
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: Sub,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough,
  };
});

vi.mock('../../../../src/renderer/components/workspaces/ActionInputDialog', () => ({
  ActionInputDialog: () => null,
}));

vi.mock('../../../../src/renderer/stores/workspaces.store', () => {
  const state = {
    createWorkspace: mockCreateWorkspace,
    addTerminalCommand: mockAddTerminalCommand,
    hideProjectGroup: vi.fn(),
    workspaces: [],
    moveWorkspacesToWindow: vi.fn(),
  };
  return {
    useWorkspacesStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state }
    ),
  };
});

vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      actions: [
        { id: 'action-cmd', title: 'Test Command', content: 'echo hi', type: 'command' },
        { id: 'action-prompt', title: 'Test Prompt', content: 'help me', type: 'prompt' },
      ],
      loadActions: vi.fn().mockResolvedValue(undefined),
      recordActionUsage: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('../../../../src/renderer/stores/config.store', () => {
  const state = {
    config: { remoteBranchesExpanded: true },
    updateConfig: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useConfigStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

vi.mock('../../../../src/renderer/stores/layout.store', () => {
  const state = { showTabInFullPane: vi.fn() };
  const useLayoutStore = (selector: (s: typeof state) => unknown) => selector(state);
  return { useLayoutStore: Object.assign(useLayoutStore, { getState: () => state }) };
});

vi.mock('../../../../src/renderer/stores/toast.store', () => {
  const state = { addToast: vi.fn() };
  return { useToastStore: Object.assign(() => state, { getState: () => state }) };
});

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ windowId: 'w1', availableWindows: [] }),
}));

vi.mock('../../../../src/renderer/utils/workspace-error', () => ({
  handleCreateError: vi.fn((err: unknown) => {
    throw err;
  }),
}));

vi.mock('../../../../src/renderer/lib/action-injection', () => ({
  injectActionContext: (content: string) => content,
  ACTION_TARGET_BRANCH_TOKEN: '{{target_branch}}',
  actionNeedsInjection: () => false,
}));

const project = {
  id: 'project-1',
  name: 'Test Project',
  color: '#f00',
  managed: false,
  repositoryPath: '/repos/test',
} as any;

async function renderAndFindRemoteBranchRow() {
  render(
    <ProjectGroupContextMenu project={project}>
      <div>trigger</div>
    </ProjectGroupContextMenu>
  );
  const branchItem = await screen.findByRole('menuitem', { name: 'feature/remote' });
  return within(branchItem.parentElement!);
}

describe('ProjectGroupContextMenu remote-only branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-new', name: 'Workspace', terminals: [] });
    mockAddTerminalCommand.mockResolvedValue({ id: 'term-new' });
    window.api = {
      listBranches: vi.fn().mockResolvedValue([{ name: 'feature/remote', isRemoteOnly: true }]),
      fetchFromRemote: vi.fn().mockResolvedValue(undefined),
      getMainBranch: vi.fn().mockResolvedValue('main'),
    } as any;
  });

  it('fetches and forks from origin/<branch> when creating a new branch from a remote-only branch', async () => {
    const user = userEvent.setup();
    const row = await renderAndFindRemoteBranchRow();

    await user.click(row.getByRole('menuitem', { name: /new branch/i }));

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalledOnce());
    expect(window.api.fetchFromRemote).toHaveBeenCalledWith('/repos/test');
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'swift-fox', baseBranch: 'origin/feature/remote' })
    );
  });

  it('fetches the remote branch when launching a command action on it', async () => {
    const user = userEvent.setup();
    const row = await renderAndFindRemoteBranchRow();

    await user.click(row.getByRole('menuitem', { name: /test command/i }));

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalledOnce());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'feature/remote',
        useExactBranchName: true,
        fetchRemote: true,
      })
    );
  });

  it('fetches the remote branch when launching a prompt action on it', async () => {
    const user = userEvent.setup();
    const row = await renderAndFindRemoteBranchRow();

    await user.click(row.getByRole('menuitem', { name: /test prompt/i }));

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalledOnce());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'feature/remote',
        useExactBranchName: true,
        fetchRemote: true,
      })
    );
  });
});
