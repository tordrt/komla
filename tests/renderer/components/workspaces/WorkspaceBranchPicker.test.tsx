/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceBranchPicker } from '../../../../src/renderer/components/workspaces/WorkspaceBranchPicker';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => {
  const OpenContext = React.createContext<((open: boolean) => void) | undefined>(undefined);
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
    }: React.PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => (
      <OpenContext.Provider value={onOpenChange}>{children}</OpenContext.Provider>
    ),
    DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => {
      const onOpenChange = React.useContext(OpenContext);
      return <div onClick={() => onOpenChange?.(true)}>{children}</div>;
    },
    DropdownMenuContent: ({
      children,
      onWheel,
    }: React.PropsWithChildren<{ onWheel?: React.WheelEventHandler<HTMLDivElement> }>) => (
      <div data-testid="branch-menu" onWheel={onWheel}>
        {children}
      </div>
    ),
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
      ...props
    }: React.PropsWithChildren<{
      onSelect?: () => void;
      disabled?: boolean;
      'aria-label'?: string;
    }>) => (
      <button
        type="button"
        role="menuitem"
        aria-label={props['aria-label']}
        disabled={disabled}
        onClick={() => onSelect?.()}
      >
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      onCheckedChange,
    }: React.PropsWithChildren<{
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
    }>) => (
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
  };
});

const listBranches = vi.fn();
const hasOriginRemote = vi.fn();
const fetchProject = vi.fn();
const listProjectHostBranches = vi.fn();
const updateConfig = vi.fn();

type PickerProps = Omit<
  React.ComponentProps<typeof WorkspaceBranchPicker>,
  'open' | 'onOpenChange'
>;

function ControlledPicker(props: PickerProps) {
  const [open, setOpen] = React.useState(false);
  return <WorkspaceBranchPicker {...props} open={open} onOpenChange={setOpen} />;
}

function renderPicker(overrides: Partial<PickerProps> = {}) {
  const props: PickerProps = {
    trigger: 'from main',
    projectId: 'project-1',
    repoPath: '/repo',
    baseBranch: '',
    usedBranches: [],
    findWorkspaceForBranch: () => undefined,
    onSelectBase: vi.fn(),
    onOpenBranch: vi.fn(),
    onGoToWorkspace: vi.fn(),
    ...overrides,
  };
  render(<ControlledPicker {...props} />);
  return props;
}

describe('WorkspaceBranchPicker', () => {
  beforeEach(() => {
    listBranches.mockResolvedValue([
      { name: 'main', isRemoteOnly: false },
      { name: 'feat/a', isRemoteOnly: false },
      { name: 'fix/remote', isRemoteOnly: true, remoteRef: 'origin/fix/remote' },
    ]);
    hasOriginRemote.mockResolvedValue(true);
    fetchProject.mockResolvedValue({ success: true, message: '' });
    updateConfig.mockImplementation(async (updates) => ({ ...updates }));
    useConfigStore.setState({ config: null });
    listProjectHostBranches.mockResolvedValue([]);
    (window as unknown as { api: unknown }).api = {
      listBranches,
      hasOriginRemote,
      fetchProject,
      listProjectHostBranches,
      updateConfig,
    };
  });

  it("lists the SSH host's branches that origin doesn't have", async () => {
    const user = userEvent.setup();
    listProjectHostBranches.mockResolvedValue(['host/only', 'feat/a', 'fix/remote']);
    const props = renderPicker({ sshHost: { id: 'ssh-dev', name: 'devbox' } });

    await user.click(screen.getByRole('button', { name: 'from main' }));
    expect(await screen.findByText('On devbox')).toBeInTheDocument();
    expect(listProjectHostBranches).toHaveBeenCalledWith('project-1', 'ssh-dev');

    // A branch this computer has too moves to the host's section; origin's stays origin's.
    await user.click(screen.getByRole('menuitem', { name: 'Start from feat/a' }));
    expect(props.onSelectBase).toHaveBeenCalledWith('feat/a', {
      isRemoteOnly: false,
      onHost: true,
    });
    expect(screen.getAllByRole('menuitem', { name: 'Start from feat/a' })).toHaveLength(1);
    await user.click(screen.getByRole('menuitem', { name: 'Open host/only' }));
    expect(props.onOpenBranch).toHaveBeenCalledWith('host/only', {
      isRemoteOnly: false,
      onHost: true,
    });

    await user.type(screen.getByRole('textbox', { name: 'Search branches' }), 'remote');
    expect(screen.queryByText('On devbox')).not.toBeInTheDocument();
  });

  it('marks branches neither origin nor the SSH host has', async () => {
    const user = userEvent.setup();
    listProjectHostBranches.mockResolvedValue(['feat/a']);
    renderPicker({ sshHost: { id: 'ssh-dev', name: 'devbox' } });

    await user.click(screen.getByRole('button', { name: 'from main' }));
    expect(await screen.findByRole('menuitem', { name: 'Start from main' })).toBeDisabled();
    expect(screen.getByText('not pushed')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Open main' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Start from feat/a' })).toBeEnabled();
  });

  it('marks a branch pushed only to a remote the host does not fetch', async () => {
    const user = userEvent.setup();
    listBranches.mockResolvedValue([
      { name: 'main', isRemoteOnly: false },
      { name: 'main', isRemoteOnly: true, remoteRef: 'origin/main' },
      { name: 'fork-only', isRemoteOnly: false },
      { name: 'fork-only', isRemoteOnly: true, remoteRef: 'upstream/fork-only' },
    ]);
    renderPicker({ sshHost: { id: 'ssh-dev', name: 'devbox' } });

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Start from fork-only' })).toBeDisabled()
    );
    expect(screen.getByRole('menuitem', { name: 'Start from main' })).toBeEnabled();
  });

  it('leaves local branches alone without an origin remote', async () => {
    const user = userEvent.setup();
    hasOriginRemote.mockResolvedValue(false);
    listBranches.mockResolvedValue([{ name: 'main', isRemoteOnly: false }]);
    renderPicker({ sshHost: { id: 'ssh-dev', name: 'devbox' } });

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await waitFor(() => expect(listProjectHostBranches).toHaveBeenCalled());
    expect(await screen.findByRole('menuitem', { name: 'Start from main' })).toBeEnabled();
    expect(screen.queryByText('not pushed')).not.toBeInTheDocument();
  });

  it('lists only local branches when the SSH host is unreachable', async () => {
    const user = userEvent.setup();
    listProjectHostBranches.mockRejectedValue(new Error('ssh: connect timed out'));
    renderPicker({ sshHost: { id: 'ssh-dev', name: 'devbox' } });

    await user.click(screen.getByRole('button', { name: 'from main' }));
    expect(await screen.findByRole('menuitem', { name: 'Start from feat/a' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('On devbox')).not.toBeInTheDocument());
    // Whether the host has them is unknown, so nothing is marked as not pushed.
    expect(screen.getByRole('menuitem', { name: 'Start from main' })).toBeEnabled();
    expect(screen.queryByText('not pushed')).not.toBeInTheDocument();
  });

  it('does not ask a host for branches on a local launch', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await screen.findByRole('menuitem', { name: 'Start from main' });
    expect(listProjectHostBranches).not.toHaveBeenCalled();
  });

  it('starts from a branch or opens it as an existing branch', async () => {
    const user = userEvent.setup();
    const props = renderPicker();

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await user.click(await screen.findByRole('button', { name: /Remote \(1\)/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Start from fix/remote' }));
    expect(props.onSelectBase).toHaveBeenCalledWith('fix/remote', { isRemoteOnly: true });

    await user.click(screen.getByRole('menuitem', { name: 'Open feat/a' }));
    expect(props.onOpenBranch).toHaveBeenCalledWith('feat/a', { isRemoteOnly: false });
  });

  it('lets a checked-out branch be a start point but not be opened again', async () => {
    const user = userEvent.setup();
    const props = renderPicker({
      usedBranches: ['main', 'feat/a'],
      findWorkspaceForBranch: (branch) =>
        branch === 'feat/a' ? { id: 'ws-a', name: 'Feature A' } : undefined,
    });

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Start from main' }));
    expect(props.onSelectBase).toHaveBeenCalledWith('main', { isRemoteOnly: false });

    expect(screen.queryByRole('menuitem', { name: 'Open main' })).not.toBeInTheDocument();
    expect(screen.getByText('in use')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Open feat/a' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Go to Feature A' }));
    expect(props.onGoToWorkspace).toHaveBeenCalledWith('ws-a');
  });

  it('keeps remote branches collapsed until the Remote section is expanded', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await screen.findByRole('menuitem', { name: 'Start from main' });
    expect(
      screen.queryByRole('menuitem', { name: 'Start from fix/remote' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Remote \(1\)/ }));
    expect(updateConfig).toHaveBeenCalledWith({ remoteBranchesExpanded: true });
    expect(
      await screen.findByRole('menuitem', { name: 'Start from fix/remote' })
    ).toBeInTheDocument();
  });

  it('shows matching remote branches while searching a collapsed section', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await screen.findByRole('menuitem', { name: 'Start from main' });
    await user.type(screen.getByRole('textbox', { name: 'Search branches' }), 'remote');

    expect(screen.getByRole('menuitem', { name: 'Start from fix/remote' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Start from main' })).not.toBeInTheDocument();
  });

  it('fetches the project and reloads branches', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('button', { name: 'from main' }));
    await screen.findByRole('menuitem', { name: 'Start from main' });
    listBranches.mockResolvedValue([
      { name: 'main', isRemoteOnly: false },
      { name: 'fix/remote', isRemoteOnly: true },
      { name: 'fix/new-remote', isRemoteOnly: true },
    ]);
    await user.click(screen.getByRole('button', { name: /Fetch/ }));

    expect(fetchProject).toHaveBeenCalledWith('project-1');
    expect(await screen.findByRole('button', { name: /Remote \(2\)/ })).toBeInTheDocument();
  });

  it('keeps wheel scrolling inside the menu instead of reaching the dialog scroll lock', async () => {
    const user = userEvent.setup();
    const documentWheel = vi.fn();
    document.addEventListener('wheel', documentWheel);
    try {
      renderPicker();
      await user.click(screen.getByRole('button', { name: 'from main' }));
      fireEvent.wheel(screen.getByTestId('branch-menu'), { deltaY: 40 });
      expect(documentWheel).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('wheel', documentWheel);
    }
  });
});
