/**
 * @vitest-environment jsdom
 */
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { Sidebar } from '../../../../src/renderer/components/layout/Sidebar';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';

import type { AppConfig } from '../../../../src/renderer/types';

const RadioContext = React.createContext<{
  value: string;
  onValueChange: (value: string) => void;
} | null>(null);

const workspaceState = {
  workspaces: [] as Array<{
    id: string;
    projectId?: string;
    tag?: string;
    windowId: string;
    status: 'active';
    provisioning: boolean;
    terminals: [];
  }>,
  hasLoaded: true as boolean,
  selectWorkspace: vi.fn(),
  hideStopped: false,
  setHideStopped: vi.fn(),
  hideWorking: false,
  setHideWorking: vi.fn(),
  grouping: 'project' as 'project' | 'none',
  setGrouping: vi.fn(),
  hiddenWorkspaceHostIds: new Set<string>(),
  dashboardHiddenWorkspaceHostIds: new Set<string>(),
  toggleWorkspaceHostVisibility: vi.fn(),
  toggleDashboardWorkspaceHostVisibility: vi.fn(),
  showAllWorkspaceHosts: vi.fn(),
  showAllDashboardWorkspaceHosts: vi.fn(),
  hiddenProjectIds: new Set(['project-1']),
  hideProjectGroup: vi.fn(),
  hideProjectGroups: vi.fn(),
  unhideProjectGroup: vi.fn(),
  unhideProjectGroups: vi.fn(),
  hiddenWorkspaceTags: new Set<string>(),
  toggleWorkspaceTagShown: vi.fn(),
  setHiddenWorkspaceTags: vi.fn(),
  selectionMode: false,
  selectedWorkspaceIds: new Set<string>(),
  exitSelectionMode: vi.fn(),
};
const sshHostsState = {
  hasLoaded: true as boolean,
  hosts: [] as Array<{
    id: string;
    name: string;
    hostname: string;
    user: string;
    basePath: string;
  }>,
};

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector?: (state: typeof workspaceState) => unknown) =>
    selector ? selector(workspaceState) : workspaceState,
}));

vi.mock('../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: (selector: (state: typeof sshHostsState) => unknown) => selector(sshHostsState),
}));

const defaultProjects = [
  { id: 'project-2', name: 'Project Two', order: 1 },
  { id: 'project-1', name: 'Project One', order: 0 },
];
const projectsState = {
  projects: defaultProjects,
  reorderProject: vi.fn(),
};

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector?: (state: typeof projectsState) => unknown) =>
    selector ? selector(projectsState) : projectsState,
}));

const windowState = { windowId: 'window-1', isFullscreen: false };

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector?: (state: typeof windowState) => unknown) =>
    selector ? selector(windowState) : windowState,
}));

vi.mock('../../../../src/renderer/stores/shortcuts.store', () => {
  const state = {
    getDisplayShortcut: (action: string) =>
      ({
        'workspace.overview': 'Ctrl+Shift+O',
        'commandCenter.open': window.api.platform === 'darwin' ? '⌘K' : 'Ctrl+Shift+P',
      })[action] ?? '',
    getDisplayKeys: (action: string) =>
      action !== 'commandCenter.open'
        ? null
        : window.api.platform === 'darwin'
          ? { keys: ['⌘', 'K'], separator: '' }
          : { keys: ['Ctrl', 'Shift', 'P'], separator: '+' },
  };
  return {
    useShortcutsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('../../../../src/renderer/components/workspaces/WorkspaceList', () => ({
  WorkspaceList: () => null,
}));

vi.mock('../../../../src/renderer/components/workspaces/QuickCreateMenu', () => ({
  QuickCreateMenu: () => null,
}));

vi.mock('../../../../src/renderer/components/layout/WorkspaceQuota', () => ({
  WorkspaceQuota: () => null,
}));

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
    'aria-label': ariaLabel,
  }: React.PropsWithChildren<{ onSelect?: () => void; 'aria-label'?: string }>) => (
    <button role="menuitem" aria-label={ariaLabel} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
    onKeyDown,
    onDragOver,
    onDragLeave,
    onDrop,
    'aria-label': ariaLabel,
  }: React.PropsWithChildren<{
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    onKeyDown?: React.KeyboardEventHandler;
    onDragOver?: React.DragEventHandler;
    onDragLeave?: React.DragEventHandler;
    onDrop?: React.DragEventHandler;
    'aria-label'?: string;
  }>) => (
    // A div, since project rows hold their own drag handles.
    <div
      role="menuitemcheckbox"
      tabIndex={-1}
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange?.(!checked)}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuSubTrigger: ({
    'aria-label': ariaLabel,
  }: React.PropsWithChildren<{ 'aria-label'?: string }>) => (
    <button type="button" role="menuitem" aria-label={ariaLabel} />
  ),
  DropdownMenuSubContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="submenu">{children}</div>
  ),
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) => (
    <RadioContext.Provider value={{ value, onValueChange }}>{children}</RadioContext.Provider>
  ),
  DropdownMenuSegmentItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => {
    const group = React.useContext(RadioContext);
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={group?.value === value}
        onClick={() => group?.onValueChange(value)}
      >
        {children}
      </button>
    );
  },
  DropdownMenuSwitchItem: ({
    children,
    checked,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: React.PropsWithChildren<{
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    'aria-label'?: string;
  }>) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {children}
    </button>
  ),
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

describe('Sidebar', () => {
  beforeEach(() => {
    window.api = { platform: 'linux' } as typeof window.api;
    windowState.isFullscreen = false;
    workspaceState.workspaces = [];
    workspaceState.hiddenWorkspaceHostIds = new Set();
    workspaceState.hiddenProjectIds = new Set(['project-1']);
    workspaceState.hideStopped = false;
    workspaceState.hideWorking = false;
    workspaceState.setHideWorking.mockReset();
    workspaceState.grouping = 'project';
    workspaceState.setHideStopped.mockReset();
    workspaceState.toggleWorkspaceHostVisibility.mockReset();
    workspaceState.showAllWorkspaceHosts.mockReset();
    workspaceState.hideProjectGroup.mockReset();
    workspaceState.unhideProjectGroup.mockReset();
    workspaceState.unhideProjectGroups.mockReset();
    workspaceState.hiddenWorkspaceTags = new Set();
    workspaceState.toggleWorkspaceTagShown.mockReset();
    workspaceState.setHiddenWorkspaceTags.mockReset();
    workspaceState.hideProjectGroups.mockReset();
    workspaceState.hasLoaded = true;
    projectsState.projects = defaultProjects;
    projectsState.reorderProject.mockReset();
    sshHostsState.hosts = [];
    sshHostsState.hasLoaded = true;
  });

  function renderSidebar(onOpenCommandCenter?: () => void) {
    return render(
      <Sidebar
        width={240}
        onResize={vi.fn()}
        onNewWorkspaceDialogChange={vi.fn()}
        onUpgradeNeeded={vi.fn()}
        onOpenCommandCenter={onOpenCommandCenter}
      />
    );
  }

  function activeWorkspace(id: string, projectId?: string, windowId = 'window-1') {
    return {
      id,
      projectId,
      windowId,
      status: 'active' as const,
      provisioning: false,
      terminals: [] as [],
    };
  }

  const filterButton = () => screen.getByRole('button', { name: /^Filter workspaces/ });

  it('keeps how workspace cards look in a submenu of the filter menu', () => {
    renderSidebar();

    expect(screen.getByRole('menuitem', { name: 'Workspace card options' })).toBeTruthy();
    const submenu = within(screen.getByTestId('submenu'));
    expect(submenu.getByRole('menuitemcheckbox', { name: 'Always show branch names' })).toBeTruthy();
    expect(submenu.getByRole('menuitemcheckbox', { name: 'Compact list' })).toBeTruthy();
  });

  it('sets how workspace cards look from the filter menu', async () => {
    let stored = {} as AppConfig;
    const updateConfig = vi.fn(async (updates: Partial<AppConfig>) => {
      stored = { ...stored, ...updates };
      return stored;
    });
    window.api = { platform: 'linux', updateConfig } as unknown as typeof window.api;
    useConfigStore.setState({ config: {} as AppConfig });
    onTestFinished(() => useConfigStore.setState({ config: null }));

    renderSidebar();

    const alwaysShow = screen.getByRole('menuitemcheckbox', { name: 'Always show branch names' });
    expect(alwaysShow).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(alwaysShow);
    expect(updateConfig).toHaveBeenLastCalledWith({ alwaysShowBranchNameInWorkspaceCards: false });

    const compact = screen.getByRole('menuitemcheckbox', { name: 'Compact list' });
    expect(compact).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(compact);
    expect(updateConfig).toHaveBeenLastCalledWith({ compactWorkspaceList: true });

    await waitFor(() => {
      expect(compact).toHaveAttribute('aria-checked', 'true');
      expect(alwaysShow).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('lists only projects with workspaces in the current window, in project order', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-2'),
      activeWorkspace('workspace-2', 'project-1'),
      activeWorkspace('workspace-3', 'project-1'),
      activeWorkspace('workspace-4', 'project-3', 'window-2'),
    ];

    renderSidebar();

    expect(screen.getByText('Projects')).toBeTruthy();
    const rows = screen.getAllByRole('menuitemcheckbox', { name: /^Project/ });
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Project One (2)',
      'Project Two (1)',
    ]);
    expect(rows.every((row) => row.getAttribute('aria-checked') === 'true')).toBe(true);
  });

  it('lists only one project from its Only button', () => {
    workspaceState.hiddenProjectIds = new Set(['project-1']);
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
    ];

    renderSidebar();

    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show only Project One' }));
    expect(workspaceState.unhideProjectGroup).toHaveBeenCalledWith('project-1');
    expect(workspaceState.hideProjectGroups).toHaveBeenCalledWith(['project-2']);
    expect(workspaceState.hideProjectGroup).not.toHaveBeenCalled();
  });

  it('offers Untagged beside the tags in use, so the list can hold one tag alone', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      { ...activeWorkspace('workspace-1', 'project-1'), tag: 'Blocked' },
      activeWorkspace('workspace-2', 'project-1'),
      activeWorkspace('workspace-3', 'project-1'),
    ];

    renderSidebar();

    expect(screen.getByRole('menuitemcheckbox', { name: 'Blocked (1)' })).toBeTruthy();
    // Tags in the list that no workspace has would filter nothing.
    expect(screen.queryByRole('menuitemcheckbox', { name: /In review/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Untagged (2)' }));
    expect(workspaceState.toggleWorkspaceTagShown).toHaveBeenCalledWith('');
  });

  it('lists only one tag, or only untagged workspaces, from its Only button', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.hiddenWorkspaceTags = new Set(['elsewhere']);
    workspaceState.workspaces = [
      { ...activeWorkspace('workspace-1', 'project-1'), tag: 'Blocked' },
      { ...activeWorkspace('workspace-2', 'project-1'), tag: 'In review' },
      activeWorkspace('workspace-3', 'project-1'),
    ];

    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Show only Blocked' }));
    expect(workspaceState.setHiddenWorkspaceTags).toHaveBeenLastCalledWith([
      'elsewhere',
      'in review',
      '',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show only untagged workspaces' }));
    expect(workspaceState.setHiddenWorkspaceTags).toHaveBeenLastCalledWith([
      'elsewhere',
      'in review',
      'blocked',
    ]);
    // The row's own checkbox stays as it was.
    expect(workspaceState.toggleWorkspaceTagShown).not.toHaveBeenCalled();
  });

  it('says how many tags show while some are filtered, and shows all again', () => {
    workspaceState.hiddenProjectIds = new Set();
    // A tag hidden for another window's workspaces stays hidden.
    workspaceState.hiddenWorkspaceTags = new Set(['', 'elsewhere']);
    workspaceState.workspaces = [
      { ...activeWorkspace('workspace-1', 'project-1'), tag: 'Blocked' },
      activeWorkspace('workspace-2', 'project-1'),
    ];

    renderSidebar();

    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(filterButton()).toHaveAccessibleName('Filter workspaces (filtered by tag)');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show all workspaces' }));
    expect(workspaceState.setHiddenWorkspaceTags).toHaveBeenCalledWith(['elsewhere']);
  });

  it('unfolds working and stopped workspaces from Show all workspaces', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [activeWorkspace('workspace-1', 'project-1')];
    workspaceState.hideWorking = true;
    workspaceState.hideStopped = true;

    renderSidebar();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Show all workspaces' }));
    expect(workspaceState.setHideWorking).toHaveBeenCalledWith(false);
    expect(workspaceState.setHideStopped).toHaveBeenCalledWith(false);
    expect(workspaceState.setHiddenWorkspaceTags).not.toHaveBeenCalled();
  });

  it('keeps hidden Untagged in the menu once no workspace has a tag', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.hiddenWorkspaceTags = new Set(['']);
    workspaceState.workspaces = [activeWorkspace('workspace-1', 'project-1')];

    renderSidebar();

    expect(screen.getByRole('menuitemcheckbox', { name: 'Untagged (1)' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('leaves out the tag filter while no workspace has a tag', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [activeWorkspace('workspace-1', 'project-1')];

    renderSidebar();

    expect(screen.queryByText('Tags')).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: /Untagged/ })).toBeNull();
  });

  it('leaves out the project filter for a single visible project', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [activeWorkspace('workspace-1', 'project-1')];

    renderSidebar();

    expect(screen.queryByText('Projects')).toBeNull();
  });

  it('offers the project filter for one project beside workspaces outside any project', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('folder-1'),
    ];

    renderSidebar();

    expect(screen.getByRole('menuitemcheckbox', { name: 'Project One (1)' })).toBeTruthy();
  });

  it('hides and shows projects from their checkboxes', () => {
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
    ];

    renderSidebar();

    const projectOne = screen.getByRole('menuitemcheckbox', { name: /Project One/ });
    expect(projectOne).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(projectOne);
    expect(workspaceState.unhideProjectGroup).toHaveBeenCalledWith('project-1');

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Project Two/ }));
    expect(workspaceState.hideProjectGroup).toHaveBeenCalledWith('project-2');
  });

  function dragProject(projectId: string, onto: HTMLElement, half: 'top' | 'bottom') {
    const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(screen.getByTestId(`drag-project-${projectId}`), { dataTransfer });
    // jsdom has no DragEvent clientY, and rows measure 0px tall, so -1 is their top half.
    const clientY = half === 'top' ? -1 : 1;
    const dragOver = createEvent.dragOver(onto);
    Object.defineProperty(dragOver, 'clientY', { value: clientY });
    fireEvent(onto, dragOver);
    const drop = createEvent.drop(onto);
    Object.defineProperty(drop, 'clientY', { value: clientY });
    fireEvent(onto, drop);
  }

  it('moves projects by dragging their handles onto other rows', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
    ];

    renderSidebar();

    expect(screen.getByText('Drag to reorder')).toBeTruthy();
    const projectTwo = screen.getByRole('menuitemcheckbox', { name: 'Project Two (1)' });
    dragProject('project-1', projectTwo, 'bottom');
    expect(projectsState.reorderProject).toHaveBeenCalledWith('project-1', 1);

    // Dropping a project onto its own place moves nothing.
    dragProject('project-1', projectTwo, 'top');
    expect(projectsState.reorderProject).toHaveBeenCalledTimes(1);
  });

  it('offers no project reordering while workspaces are not grouped by project', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.grouping = 'none';
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
    ];

    renderSidebar();

    expect(screen.getByRole('menuitemcheckbox', { name: 'Project Two (1)' })).toBeTruthy();
    expect(screen.queryByText('Drag to reorder')).toBeNull();
    expect(screen.queryByTestId('drag-project-project-1')).toBeNull();
  });

  it('leaves the checkbox alone when the drag handle is clicked', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
    ];

    renderSidebar();

    fireEvent.click(screen.getByTestId('drag-project-project-1'));
    expect(workspaceState.hideProjectGroup).not.toHaveBeenCalled();
  });

  it('moves the focused project with Alt+Arrow keys', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
    ];

    renderSidebar();

    const projectTwo = screen.getByRole('menuitemcheckbox', { name: 'Project Two (1)' });
    fireEvent.keyDown(projectTwo, { key: 'ArrowUp' });
    expect(projectsState.reorderProject).not.toHaveBeenCalled();
    fireEvent.keyDown(projectTwo, { key: 'ArrowUp', altKey: true });
    expect(projectsState.reorderProject).toHaveBeenCalledWith('project-2', 0);
  });

  it('moves a project past its neighbour here over projects listed only in other windows', () => {
    workspaceState.hiddenProjectIds = new Set();
    projectsState.projects = [
      { id: 'project-1', name: 'Project One', order: 0 },
      { id: 'project-3', name: 'Project Three', order: 1 },
      { id: 'project-2', name: 'Project Two', order: 2 },
    ];
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
      activeWorkspace('workspace-3', 'project-3', 'window-2'),
    ];

    renderSidebar();

    dragProject('project-2', screen.getByRole('menuitemcheckbox', { name: /^Project One/ }), 'top');
    expect(projectsState.reorderProject).toHaveBeenCalledWith('project-2', 0);
    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /^Project One/ }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(projectsState.reorderProject).toHaveBeenCalledWith('project-1', 2);
  });

  it('ignores held Alt+Arrow keys, which would start overlapping saves', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
    ];

    renderSidebar();

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: /^Project One/ }), {
      key: 'ArrowDown',
      altKey: true,
      repeat: true,
    });
    expect(projectsState.reorderProject).not.toHaveBeenCalled();
  });

  it('offers no reordering for a single project beside workspaces outside any project', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('folder-1'),
    ];

    renderSidebar();

    expect(screen.queryByText('Drag to reorder')).toBeNull();
    expect(screen.queryByTestId('drag-project-project-1')).toBeNull();
  });

  it('counts hidden workspaces on the filter button and shows them all again', () => {
    workspaceState.workspaces = [
      activeWorkspace('workspace-1', 'project-1'),
      activeWorkspace('workspace-2', 'project-2'),
      activeWorkspace('workspace-3', 'project-1', 'window-2'),
    ];
    // project-3 and the SSH host hide nothing in this window, so Show all leaves them hidden.
    workspaceState.hiddenProjectIds = new Set(['project-1', 'project-3']);
    workspaceState.hiddenWorkspaceHostIds = new Set(['ssh-devbox']);
    // Stopped workspaces aren't hidden: they're on the Stopped shelf, so they aren't counted.
    workspaceState.hideStopped = true;

    renderSidebar();

    expect(filterButton()).toHaveAccessibleName('Filter workspaces (1 hidden)');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Show all workspaces (1 hidden)' }));
    expect(workspaceState.unhideProjectGroups).toHaveBeenCalledWith(new Set(['project-1']));
    expect(workspaceState.toggleWorkspaceHostVisibility).not.toHaveBeenCalled();
    // Show all unfolds them too.
    expect(workspaceState.setHideStopped).toHaveBeenCalledWith(false);
  });

  it('shows hosts that hide workspaces here again', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [activeWorkspace('workspace-1', 'project-1')];
    workspaceState.hiddenWorkspaceHostIds = new Set(['local', 'ssh-devbox']);

    renderSidebar();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Show all workspaces (1 hidden)' }));
    expect(workspaceState.toggleWorkspaceHostVisibility).toHaveBeenCalledTimes(1);
    expect(workspaceState.toggleWorkspaceHostVisibility).toHaveBeenCalledWith('local');
    expect(workspaceState.unhideProjectGroups).not.toHaveBeenCalled();
    expect(workspaceState.setHideStopped).not.toHaveBeenCalled();
  });

  it('offers no reset while nothing is hidden', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [activeWorkspace('workspace-1', 'project-1')];

    renderSidebar();

    expect(filterButton()).toHaveAccessibleName('Filter workspaces');
    expect(screen.queryByRole('menuitem', { name: /Show all workspaces/ })).toBeNull();
  });

  it('hides host options when only Local exists', () => {
    renderSidebar();

    expect(screen.queryByText('Hosts')).toBeNull();
    expect(screen.getByText('Group')).toBeTruthy();
  });

  it('groups by project, or lists every workspace together', () => {
    renderSidebar();

    expect(screen.getByRole('menuitemradio', { name: 'By project' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'One list' }));
    expect(workspaceState.setGrouping).toHaveBeenCalledWith('none');
  });

  it('shows host filters when an SSH host exists', () => {
    sshHostsState.hosts = [
      {
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        user: 'developer',
        basePath: '/home/developer',
      },
    ];

    renderSidebar();

    expect(screen.getByText('Hosts')).toBeTruthy();
  });

  it('folds stopped workspaces away at the bottom with a switch', () => {
    workspaceState.hiddenProjectIds = new Set();
    workspaceState.workspaces = [activeWorkspace('workspace-1', 'project-1')];

    const { rerender } = renderSidebar();

    expect(screen.getByText('Fold away at the bottom')).toBeTruthy();
    const stopped = screen.getByRole('menuitemcheckbox', { name: 'Stopped workspaces (1)' });
    expect(stopped).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(stopped);
    expect(workspaceState.setHideStopped).toHaveBeenCalledWith(true);

    workspaceState.hideStopped = true;
    rerender(
      <Sidebar
        width={240}
        onResize={vi.fn()}
        onNewWorkspaceDialogChange={vi.fn()}
        onUpgradeNeeded={vi.fn()}
      />
    );

    // The Stopped shelf lists them, so the filter button counts nothing hidden.
    expect(filterButton()).toHaveAccessibleName('Filter workspaces');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Stopped workspaces (1)' }));
    expect(workspaceState.setHideStopped).toHaveBeenLastCalledWith(false);
  });

  it('offers to fold working workspaces away, whether or not any work', () => {
    const { rerender } = renderSidebar();

    const working = screen.getByRole('menuitemcheckbox', {
      name: 'Workspaces with a working agent',
    });
    expect(working).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(working);
    expect(workspaceState.setHideWorking).toHaveBeenCalledWith(true);

    workspaceState.hideWorking = true;
    rerender(
      <Sidebar
        width={240}
        onResize={vi.fn()}
        onNewWorkspaceDialogChange={vi.fn()}
        onUpgradeNeeded={vi.fn()}
      />
    );

    // The Working shelf lists them, so the filter button counts nothing hidden.
    expect(filterButton()).toHaveAccessibleName('Filter workspaces');
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Workspaces with a working agent' })
    );
    expect(workspaceState.setHideWorking).toHaveBeenLastCalledWith(false);
  });

  it('always labels the Overview button with a tooltip that includes its shortcut', () => {
    renderSidebar();

    expect(screen.getByText('Ctrl+Shift+O').tagName).toBe('KBD');
  });

  it('collapses from its top row, staying mounted, and leaves selection mode', async () => {
    window.localStorage.removeItem('komla.sidebarCollapsed');
    workspaceState.selectionMode = true;
    workspaceState.exitSelectionMode.mockReset();
    vi.resetModules();
    const { setSidebarCollapsed } = await import('../../../../src/renderer/lib/sidebar-collapsed');
    const { Sidebar: FreshSidebar } =
      await import('../../../../src/renderer/components/layout/Sidebar');
    try {
      render(
        <FreshSidebar
          width={240}
          onResize={vi.fn()}
          onNewWorkspaceDialogChange={vi.fn()}
          onUpgradeNeeded={vi.fn()}
        />
      );
      const topRow = screen.getByTestId('sidebar-top-row');

      fireEvent.click(within(topRow).getByRole('button', { name: 'Collapse sidebar' }));

      // Hidden rather than unmounted, so its cards still answer the delete shortcut.
      expect(topRow.parentElement).toHaveClass('hidden');
      expect(window.localStorage.getItem('komla.sidebarCollapsed')).toBe('true');
      expect(workspaceState.exitSelectionMode).toHaveBeenCalled();
      setSidebarCollapsed(false);
    } finally {
      workspaceState.selectionMode = false;
      window.localStorage.removeItem('komla.sidebarCollapsed');
    }
  });

  describe('footer', () => {
    afterEach(() => useConfigStore.setState({ config: null }));

    function renderWithAppMenu() {
      return render(
        <Sidebar
          width={240}
          onResize={vi.fn()}
          onNewWorkspaceDialogChange={vi.fn()}
          onUpgradeNeeded={vi.fn()}
          renderAppMenu={() => <button type="button">Settings</button>}
        />
      );
    }

    it('always shows Overview and the settings menu, even where an older version hid them', () => {
      useConfigStore.setState({
        config: { statusBarHiddenItems: ['overview', 'settings-menu'] } as AppConfig,
      });
      renderWithAppMenu();

      expect(screen.getByRole('button', { name: /Overview/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    });

    it("shows Komla's name in the corner on macOS, which opens Overview", () => {
      window.api = { platform: 'darwin' } as typeof window.api;
      workspaceState.selectWorkspace.mockReset();
      renderWithAppMenu();

      const button = screen.getByRole('button', { name: 'Komla Overview' });
      expect(
        within(screen.getByTestId('sidebar-top-row')).queryByRole('button', {
          name: 'Komla Overview',
        })
      ).toBeNull();
      expect(button).toHaveTextContent('Komla');
      fireEvent.click(button);

      expect(workspaceState.selectWorkspace).toHaveBeenCalledWith(null);
    });

    it("opens the status bar's menu on right-click, since the footer continues the bar", () => {
      window.api = { platform: 'darwin' } as typeof window.api;
      useConfigStore.setState({ config: {} as AppConfig });
      renderWithAppMenu();

      fireEvent.contextMenu(screen.getByRole('button', { name: /Overview/ }));

      expect(screen.queryByRole('menuitem', { name: /^Hide Overview/ })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Customize status bar…' })).toBeTruthy();
    });

    it("opens the status bar's menu from the footer's empty left on Windows and Linux", () => {
      useConfigStore.setState({ config: {} as AppConfig });
      renderWithAppMenu();

      fireEvent.contextMenu(screen.getByTestId('sidebar-footer-start'));

      expect(screen.getByRole('menuitem', { name: 'Customize status bar…' })).toBeTruthy();
    });
  });

  it('resets to the default width when the resize handle is double-clicked', () => {
    const onResize = vi.fn();
    render(
      <Sidebar
        width={320}
        onResize={onResize}
        onNewWorkspaceDialogChange={vi.fn()}
        onUpgradeNeeded={vi.fn()}
      />
    );

    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize sidebar' }));

    expect(onResize).toHaveBeenCalledWith(200);
  });

  it('resizes from the keyboard with the arrow keys', () => {
    const onResize = vi.fn();
    render(
      <Sidebar
        width={320}
        onResize={onResize}
        onNewWorkspaceDialogChange={vi.fn()}
        onUpgradeNeeded={vi.fn()}
      />
    );

    const handle = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-valuenow', '320');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(336);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(304);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onResize).toHaveBeenLastCalledWith(200);
  });
  it('opens Command center from the top row, beside the macOS traffic lights', () => {
    window.api = { platform: 'darwin' } as typeof window.api;
    const onOpenCommandCenter = vi.fn();

    renderSidebar(onOpenCommandCenter);
    const topRow = screen.getByTestId('sidebar-top-row');
    fireEvent.click(within(topRow).getByRole('button', { name: /Jump to/ }));

    expect(topRow).toHaveStyle({ paddingLeft: '80px' });
    expect(onOpenCommandCenter).toHaveBeenCalledTimes(1);
    expect(within(topRow).queryByText('Workspace')).toBeNull();
  });

  it('keeps the Jump to shortcut at the narrowest sidebar, truncating the placeholder instead', () => {
    window.api = { platform: 'darwin' } as typeof window.api;
    render(
      <Sidebar
        width={150}
        onResize={vi.fn()}
        onNewWorkspaceDialogChange={vi.fn()}
        onUpgradeNeeded={vi.fn()}
        onOpenCommandCenter={vi.fn()}
      />
    );

    const jumpButton = screen.getByRole('button', { name: /Jump to/ });
    expect(within(jumpButton).getByText('⌘K')).toBeTruthy();
    expect(within(jumpButton).getByText('Jump to…')).toHaveClass('truncate');
  });

  it('on linux, keeps Ctrl+Shift+P in the Jump to field as Ctrl⇧P, truncating the placeholder', () => {
    window.api = { platform: 'linux' } as typeof window.api;
    render(
      <Sidebar
        width={150}
        onResize={vi.fn()}
        onNewWorkspaceDialogChange={vi.fn()}
        onUpgradeNeeded={vi.fn()}
        onOpenCommandCenter={vi.fn()}
      />
    );

    const jumpButton = screen.getByRole('button', { name: /Jump to/ });
    expect(within(jumpButton).getByText('Ctrl⇧P').tagName).toBe('KBD');
    expect(within(jumpButton).getByText('Jump to…')).toHaveClass('truncate');
  });

  it('leaves no traffic-light room in full screen', () => {
    window.api = { platform: 'darwin' } as typeof window.api;
    windowState.isFullscreen = true;
    renderSidebar(vi.fn());
    expect(screen.getByTestId('sidebar-top-row').style.paddingLeft).toBe('');
  });

  it.each(['win32', 'linux'] as const)(
    "lays out the sidebar as on macOS on %s: Jump to on top, New Workspace below, Komla's name in the footer",
    (platform) => {
      window.api = { platform } as typeof window.api;
      workspaceState.selectWorkspace.mockReset();
      const onOpenCommandCenter = vi.fn();
      const onNewWorkspaceDialogChange = vi.fn();
      render(
        <Sidebar
          width={240}
          onResize={vi.fn()}
          onNewWorkspaceDialogChange={onNewWorkspaceDialogChange}
          onUpgradeNeeded={vi.fn()}
          onOpenCommandCenter={onOpenCommandCenter}
        />
      );

      const topRow = screen.getByTestId('sidebar-top-row');
      fireEvent.click(within(topRow).getByRole('button', { name: /Jump to/ }));
      expect(within(topRow).queryByRole('button', { name: 'Komla Overview' })).toBeNull();
      expect(within(topRow).queryByRole('button', { name: 'Command center' })).toBeNull();
      expect(within(topRow).queryByText('Workspace')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'New Workspace' }));
      const footer = screen.getByTestId('sidebar-footer-start');
      fireEvent.click(within(footer).getByRole('button', { name: 'Komla Overview' }));

      expect(workspaceState.selectWorkspace).toHaveBeenCalledWith(null);
      expect(onOpenCommandCenter).toHaveBeenCalledTimes(1);
      expect(within(footer).getByRole('button', { name: 'Komla Overview' })).toHaveTextContent(
        'Komla'
      );
      expect(onNewWorkspaceDialogChange).toHaveBeenCalledWith(true);
      expect(topRow.style.paddingLeft).toBe('');
    }
  );
});
