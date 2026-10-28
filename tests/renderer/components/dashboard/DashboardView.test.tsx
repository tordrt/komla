/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardView } from '../../../../src/renderer/components/dashboard/DashboardView';
import { registerShortcutAction } from '../../../../src/renderer/lib/shortcut-actions';
import { createSshWorkspace, createTerminal, createWorktreeWorkspace } from '../../../factories';

let mockProjectFilters: { name: string; color: string; count: number }[] = [];
let mockTagFilters: { key: string; name: string; tone: 'info' | 'error'; count: number }[] = [];
let mockUntaggedCount = 0;
let lastFilterTagKey: string | null | undefined;
// As the overview model offers them: a tag in use, or Untagged beside one.
const offersTag = (key: string | null | undefined): key is string =>
  key === ''
    ? mockTagFilters.length > 0 && mockUntaggedCount > 0
    : mockTagFilters.some((tag) => tag.key === key);
type MockWorkspace = ReturnType<typeof createWorktreeWorkspace>;
let mockSections:
  | ((workspaces: MockWorkspace[]) => { key: string; title: string; items: MockWorkspace[] }[])
  | null = null;

vi.mock('../../../../src/renderer/components/dashboard/dashboard-view-model', () => ({
  buildDashboardOverview: ({
    workspaces,
    filterTagKey,
  }: {
    workspaces: MockWorkspace[];
    filterTagKey?: string | null;
  }) => {
    lastFilterTagKey = filterTagKey;
    return {
      totalWindowCount: workspaces.length,
      visibleCount: workspaces.length,
      projectFilters: mockProjectFilters,
      tagFilters: mockTagFilters,
      untaggedCount: mockUntaggedCount,
      untaggedOffered: mockTagFilters.length > 0 && mockUntaggedCount > 0,
      tagFilterKey: offersTag(filterTagKey) ? filterTagKey : null,
      sections: (
        mockSections?.(workspaces) ?? [{ key: 'stopped', title: 'Stopped', items: workspaces }]
      ).map((section) => ({
        ...section,
        items: section.items.map((workspace) => ({ workspace, projectInfo: null })),
      })),
    };
  },
}));

let rowRenderIds: string[] = [];

vi.mock('../../../../src/renderer/components/dashboard/DashboardRow', () => ({
  DashboardRow: ({
    workspace,
    onSaveCustomName,
  }: {
    workspace: MockWorkspace;
    onSaveCustomName: (customName: string | null) => Promise<void> | void;
  }) => {
    rowRenderIds.push(workspace.id);
    return (
      <button type="button" data-dashboard-row onClick={() => void onSaveCustomName(null)}>
        Reset {workspace.id}
      </button>
    );
  },
}));

vi.mock('../../../../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/workspaces/QuickCreateMenu', () => ({
  QuickCreateMenu: () => null,
}));

vi.mock('../../../../src/renderer/components/workspaces/WorkspaceHostFilterMenu', () => ({
  WorkspaceHostFilterMenu: () => null,
}));

const workspace = createWorktreeWorkspace({
  id: 'dashboard-workspace',
  windowId: 'window-1',
  customName: 'Old Task',
  promptSubmits: [{ prompt: 'Old prompt', submittedAt: 1 }],
  autoNaming: true,
});

const workspacesState = {
  workspaces: [workspace],
  selectWorkspace: vi.fn(),
  stopWorkspace: vi.fn(),
  setWorkspaceTrashed: vi.fn(),
  trashWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  setPinned: vi.fn(),
  markUnread: vi.fn(),
  dashboardFilterProject: null,
  dashboardHiddenWorkspaceHostIds: new Set<string>(),
  showAllDashboardWorkspaceHosts: vi.fn(),
  setDashboardFilterProject: vi.fn(),
  selectionMode: false,
  selectedWorkspaceIds: new Set<string>(),
  enterSelectionMode: vi.fn(),
  exitSelectionMode: vi.fn(),
  toggleWorkspaceSelection: vi.fn(),
  shiftSelectWorkspaces: vi.fn(),
  stopSelectedWorkspaces: vi.fn(),
  trashSelectedWorkspaces: vi.fn(),
  deleteSelectedWorkspaces: vi.fn(),
  deleteWorkspaces: vi.fn(),
};

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(() => workspacesState, { setState: vi.fn() }),
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: <T,>(selector?: (state: { projects: never[] }) => T) =>
    selector ? selector({ projects: [] }) : { projects: [] },
}));

vi.mock('../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: <T,>(selector: (state: { hosts: never[] }) => T) => selector({ hosts: [] }),
}));

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: () => ({ windowId: 'window-1' }),
}));

vi.mock('../../../../src/renderer/stores/git-status.store', () => ({
  useGitStatusStore: <T,>(selector: (state: { statusMap: Map<string, never> }) => T) =>
    selector({ statusMap: new Map() }),
}));

vi.mock('../../../../src/renderer/stores/shortcuts.store', () => ({
  useShortcutsStore: <T,>(selector?: (state: { getDisplayShortcut: () => string }) => T) => {
    const state = { getDisplayShortcut: vi.fn(() => '') };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../../src/renderer/stores/file-list.store', () => ({
  useFileListStore: <T,>(selector: (state: { diffCache: Map<string, never> }) => T) =>
    selector({ diffCache: new Map() }),
}));

vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api = { updateWorkspace: vi.fn() } as any;
    mockProjectFilters = [];
    mockTagFilters = [];
    mockUntaggedCount = 0;
    mockSections = null;
    workspacesState.workspaces = [workspace];
    workspacesState.dashboardFilterProject = null;
    workspacesState.selectionMode = false;
    workspacesState.selectedWorkspaceIds = new Set<string>();
  });

  it('merges the authoritative workspace state after resetting its title', async () => {
    const resetWorkspace = {
      ...workspace,
      customName: undefined,
      promptSubmits: undefined,
      autoNaming: false,
      lastDynamicTitle: 'Stale persisted title',
      terminals: [],
    };
    vi.mocked(window.api.updateWorkspace).mockResolvedValue(resetWorkspace);

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: `Reset ${workspace.id}` }));

    await waitFor(() => {
      expect(window.api.updateWorkspace).toHaveBeenCalledWith(workspace.id, {
        customName: undefined,
      });
    });
    expect(workspacesState.updateWorkspace).toHaveBeenLastCalledWith(workspace.id, {
      customName: undefined,
      customNameSource: resetWorkspace.customNameSource,
      customNameGeneratedAt: resetWorkspace.customNameGeneratedAt,
      promptSubmitsSinceCustomNameGeneration: resetWorkspace.promptSubmitsSinceCustomNameGeneration,
      promptSubmits: undefined,
      autoNaming: false,
    });
  });

  it('shows every row of a long list', () => {
    workspacesState.workspaces = Array.from({ length: 120 }, (_, i) =>
      createWorktreeWorkspace({ id: `ws-${i}`, windowId: 'window-1' })
    );

    render(<DashboardView />);

    expect(screen.getAllByRole('button', { name: /^Reset ws-/ })).toHaveLength(120);
  });

  it('does not re-render its rows when its parent re-renders', () => {
    const onNewWorkspaceDialogChange = vi.fn();
    const { rerender } = render(
      <DashboardView onNewWorkspaceDialogChange={onNewWorkspaceDialogChange} />
    );
    const rendersBefore = rowRenderIds.length;

    rerender(<DashboardView onNewWorkspaceDialogChange={onNewWorkspaceDialogChange} />);

    expect(rowRenderIds).toHaveLength(rendersBefore);
  });

  // Agents update their workspaces several times a second while they work.
  it('re-renders only the row whose workspace changed', () => {
    const working = createWorktreeWorkspace({ id: 'ws-working', windowId: 'window-1' });
    const idle = createWorktreeWorkspace({ id: 'ws-idle', windowId: 'window-1' });
    workspacesState.workspaces = [working, idle];
    const { rerender } = render(<DashboardView />);
    rowRenderIds = [];

    workspacesState.workspaces = [{ ...working, lastDynamicTitle: '◑ Fixing tests' }, idle];
    rerender(<DashboardView onNewWorkspaceDialogChange={vi.fn()} />);

    expect(rowRenderIds).toEqual(['ws-working']);
  });

  it('shows project filters as toggle buttons', () => {
    mockProjectFilters = [
      { name: 'acme-api', color: '#ff0000', count: 3 },
      { name: 'acme-web', color: '#00ff00', count: 1 },
    ];
    (workspacesState as { dashboardFilterProject: string | null }).dashboardFilterProject =
      'acme-api';

    render(<DashboardView />);
    const selected = screen.getByRole('button', { name: /acme-api/ });
    const unselected = screen.getByRole('button', { name: /acme-web/ });

    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(unselected).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(selected);
    expect(workspacesState.setDashboardFilterProject).toHaveBeenLastCalledWith(null);
    fireEvent.click(unselected);
    expect(workspacesState.setDashboardFilterProject).toHaveBeenLastCalledWith('acme-web');
  });

  it('filters by one tag at a time, Untagged among them', () => {
    mockTagFilters = [
      { key: 'in review', name: 'In review', tone: 'info', count: 2 },
      { key: 'blocked', name: 'Blocked', tone: 'error', count: 1 },
    ];
    mockUntaggedCount = 4;

    render(<DashboardView />);
    expect(lastFilterTagKey).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /In review/ }));
    expect(lastFilterTagKey).toBe('in review');
    expect(screen.getByRole('button', { name: /In review/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: /Untagged/ }));
    expect(lastFilterTagKey).toBe('');
    expect(screen.getByRole('button', { name: /In review/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    fireEvent.click(screen.getByRole('button', { name: /Untagged/ }));
    expect(lastFilterTagKey).toBeNull();
  });

  it('drops a tag filter once no workspace has that tag', () => {
    mockTagFilters = [{ key: 'blocked', name: 'Blocked', tone: 'error', count: 1 }];
    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));
    expect(lastFilterTagKey).toBe('blocked');

    // Untagged by now; typing a search builds the overview again.
    mockTagFilters = [];
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter workspaces' }), {
      target: { value: 'task' },
    });

    expect(lastFilterTagKey).toBeNull();
  });

  it('trashes every workspace in a stale group after confirming', async () => {
    const old = createWorktreeWorkspace({ id: 'ws-old', windowId: 'window-1', customName: 'Old' });
    const older = createWorktreeWorkspace({ id: 'ws-older', windowId: 'window-1' });
    workspacesState.workspaces = [old, older];
    mockSections = (workspaces) => [
      { key: 'week', title: 'Not touched in a week', items: workspaces },
    ];

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: 'Move all to Trash' }));
    expect(workspacesState.trashWorkspaces).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Move 2 workspaces to the Trash?');
    expect(dialog).toHaveTextContent('Old');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move All to Trash' }));

    expect(workspacesState.trashWorkspaces).toHaveBeenCalledWith(['ws-old', 'ws-older']);
  });

  it('trashes a stale group of one without asking', () => {
    const old = createWorktreeWorkspace({ id: 'ws-old', windowId: 'window-1' });
    workspacesState.workspaces = [old];
    mockSections = (workspaces) => [
      { key: 'month', title: 'Not touched in a month', items: workspaces },
    ];

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: 'Move all to Trash' }));

    expect(workspacesState.trashWorkspaces).toHaveBeenCalledWith(['ws-old']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks before trashing several selected workspaces', async () => {
    const other = createWorktreeWorkspace({ id: 'ws-other', windowId: 'window-1' });
    const trashed = createWorktreeWorkspace({ id: 'ws-trashed', status: 'trashed' });
    workspacesState.workspaces = [workspace, other, trashed];
    workspacesState.selectionMode = true;
    workspacesState.selectedWorkspaceIds = new Set([workspace.id, other.id, trashed.id]);

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(workspacesState.trashSelectedWorkspaces).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    // Already trashed workspaces are left out.
    expect(dialog).toHaveTextContent('Move 2 workspaces to the Trash?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move All to Trash' }));

    expect(workspacesState.trashSelectedWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('deletes a stale group after confirming, keeping workspaces with unsaved work', async () => {
    const old = createWorktreeWorkspace({ id: 'ws-old', windowId: 'window-1', customName: 'Old' });
    const dirty = createWorktreeWorkspace({
      id: 'ws-dirty',
      windowId: 'window-1',
      customName: 'Dirty',
    });
    const recent = createWorktreeWorkspace({ id: 'ws-recent', windowId: 'window-1' });
    workspacesState.workspaces = [old, dirty, recent];
    mockSections = () => [
      { key: 'stopped', title: 'Stopped', items: [recent] },
      { key: 'month', title: 'Not touched in a month', items: [old, dirty] },
    ];
    window.api = {
      getWorkspaceDiff: vi.fn(async (id: string) => ({
        files: id === 'ws-dirty' ? [{ path: 'notes.md', status: 'untracked' }] : [],
      })),
      getWorkspaceGitBranchStatus: vi.fn(async () => ({
        hasRemote: true,
        unpushedCommits: 0,
        aheadTargetBranch: 0,
      })),
    } as any;

    render(<DashboardView />);
    expect(screen.getAllByRole('button', { name: 'Delete all' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    expect(workspacesState.deleteWorkspaces).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Delete 1 workspace?');
    expect(dialog).toHaveTextContent('Dirty: uncommitted changes in 1 file');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(workspacesState.deleteWorkspaces).toHaveBeenCalledWith(
      ['ws-old'],
      true,
      expect.any(Boolean)
    );
  });

  it('deletes everything in the Trash group, unsaved work too, once confirmed', async () => {
    const dirty = createWorktreeWorkspace({
      id: 'ws-dirty',
      status: 'trashed',
      customName: 'Dirty',
    });
    const clean = createWorktreeWorkspace({ id: 'ws-clean', status: 'trashed' });
    workspacesState.workspaces = [workspace, dirty, clean];
    mockSections = () => [
      { key: 'stopped', title: 'Stopped', items: [workspace] },
      { key: 'trash', title: 'Trash', items: [dirty, clean] },
    ];
    const getWorkspaceDiff = vi.fn(async () => ({
      files: [{ path: 'notes.md', status: 'untracked' }],
    }));
    window.api = { getWorkspaceDiff } as any;

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: /^Trash/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete 2 workspaces?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete All' }));

    expect(getWorkspaceDiff).not.toHaveBeenCalled();
    expect(workspacesState.deleteWorkspaces).toHaveBeenCalledWith(
      ['ws-dirty', 'ws-clean'],
      true,
      expect.any(Boolean)
    );
  });

  it('closes a confirmation on Escape without leaving the overview or the selection', async () => {
    const other = createWorktreeWorkspace({ id: 'ws-other', windowId: 'window-1' });
    workspacesState.workspaces = [workspace, other];
    workspacesState.selectionMode = true;
    workspacesState.selectedWorkspaceIds = new Set([workspace.id, other.id]);
    const windowEscapes: boolean[] = [];
    const windowEscape = (event: KeyboardEvent) => windowEscapes.push(event.defaultPrevented);
    window.addEventListener('keydown', windowEscape);

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Marked handled, so the overview's own Escape leaves it alone.
    expect(windowEscapes).toEqual([true]);
    expect(workspacesState.exitSelectionMode).not.toHaveBeenCalled();
    window.removeEventListener('keydown', windowEscape);
  });

  it('folds the trashed group until opened or searched', () => {
    const trashed = createWorktreeWorkspace({ id: 'ws-trashed', status: 'trashed' });
    workspacesState.workspaces = [workspace, trashed];
    mockSections = () => [
      { key: 'stopped', title: 'Stopped', items: [workspace] },
      { key: 'trash', title: 'Trash', items: [trashed] },
    ];

    render(<DashboardView />);
    expect(screen.getByRole('button', { name: `Reset ${workspace.id}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset ws-trashed' })).not.toBeInTheDocument();

    const trashHeader = screen.getByRole('button', { name: /^Trash/ });
    expect(trashHeader).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trashHeader);
    expect(screen.getByRole('button', { name: 'Reset ws-trashed' })).toBeInTheDocument();
    fireEvent.click(trashHeader);
    expect(screen.queryByRole('button', { name: 'Reset ws-trashed' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter workspaces' }), {
      target: { value: 'trashed' },
    });
    expect(screen.getByRole('button', { name: 'Reset ws-trashed' })).toBeInTheDocument();
  });

  it('focuses the filter when the overview opens', () => {
    render(<DashboardView />);

    expect(screen.getByRole('textbox', { name: 'Filter workspaces' })).toHaveFocus();
  });

  it('moves from the filter to the first row on ArrowDown', () => {
    render(<DashboardView />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter workspaces' }), {
      key: 'ArrowDown',
    });

    expect(screen.getByRole('button', { name: 'Reset dashboard-workspace' })).toHaveFocus();
  });

  it('clears the filter on Escape without leaving the overview', () => {
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);

    render(<DashboardView />);
    const filter = screen.getByRole('textbox', { name: 'Filter workspaces' });
    fireEvent.change(filter, { target: { value: 'auth' } });
    fireEvent.keyDown(filter, { key: 'Escape' });

    expect(filter).toHaveValue('');
    expect(windowEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(windowEscape).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', windowEscape);
  });

  it('returns to the workspace through the overview toggle', () => {
    const toggleOverview = vi.fn();
    const unregister = registerShortcutAction('workspace.overview', toggleOverview);

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: /back to workspace/i }));

    expect(toggleOverview).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('hides the back control when the window has no active workspace to return to', () => {
    workspacesState.workspaces = [{ ...workspace, status: 'trashed' }];

    render(<DashboardView />);

    expect(screen.queryByRole('button', { name: /back to workspace/i })).not.toBeInTheDocument();
  });

  it('offers bulk stop for a selected workspace whose tmux session runs on its host', () => {
    const elsewhere = createSshWorkspace({
      id: 'dashboard-ssh-workspace',
      windowId: 'window-1',
      terminals: [createTerminal({ status: 'stopped', remoteSessionOnHost: true })],
    });
    workspacesState.workspaces = [elsewhere];
    workspacesState.selectionMode = true;
    workspacesState.selectedWorkspaceIds = new Set([elsewhere.id]);

    render(<DashboardView />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('offers bulk stop, trash, and delete for the selection', async () => {
    workspacesState.workspaces = [
      { ...workspace, terminals: [createTerminal({ status: 'running' })] },
    ];
    workspacesState.selectionMode = true;
    workspacesState.selectedWorkspaceIds = new Set([workspace.id]);

    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(workspacesState.stopSelectedWorkspaces).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(workspacesState.trashSelectedWorkspaces).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(workspacesState.deleteSelectedWorkspaces).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(workspacesState.deleteSelectedWorkspaces).toHaveBeenCalledWith(
      true,
      expect.any(Boolean)
    );
  });

  it('disables bulk stop when no selected workspace is running', () => {
    workspacesState.workspaces = [{ ...workspace, terminals: [] }];
    workspacesState.selectionMode = true;
    workspacesState.selectedWorkspaceIds = new Set([workspace.id]);

    render(<DashboardView />);

    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeEnabled();
  });
});
