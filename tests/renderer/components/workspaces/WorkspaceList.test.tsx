/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceList } from '../../../../src/renderer/components/workspaces/WorkspaceList';
import { createTerminal, createWorktreeWorkspace } from '../../../factories';

import type { Workspace, WorkspaceAttention } from '../../../../src/renderer/types';

const workspacesState = {
  workspaces: [] as Workspace[],
  selectedWorkspaceId: null as string | null,
  collapsedWorkspaceGroupKeys: new Set<string>(),
  toggleWorkspaceGroupCollapsed: vi.fn(),
  setHideStopped: vi.fn(),
  unhideProjectGroups: vi.fn(),
  reorderWorkspace: vi.fn(),
  hideStopped: false,
  hideWorking: false,
  grouping: 'project' as 'project' | 'none',
  hiddenWorkspaceHostIds: new Set<string>(),
  hiddenWorkspaceTags: new Set<string>(),
  showAllWorkspaceHosts: vi.fn(),
  setDisplayOrderedWorkspaceIds: vi.fn(),
  hiddenProjectIds: new Set<string>(),
  selectionMode: false,
  selectedWorkspaceIds: new Set<string>(),
  deselectWorkspaces: vi.fn(),
  exitSelectionMode: vi.fn(),
  selectAllWorkspaces: vi.fn(),
  selectWorkspace: vi.fn(),
  deleteWorkspaces: vi.fn(),
};

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: <T,>(selector: (state: typeof workspacesState) => T) =>
    selector(workspacesState),
}));

const defaultProjects = [{ id: 'project-1', name: 'Komla', color: '#3b82f6', order: 0 }];

const projectsState = {
  projects: defaultProjects as Array<{ id: string; name: string; color: string; order: number }>,
  reorderProject: vi.fn(),
};

const { openNewWorkspaceDialog } = vi.hoisted(() => ({ openNewWorkspaceDialog: vi.fn() }));

vi.mock('../../../../src/renderer/stores/dialogs.store', () => ({ openNewWorkspaceDialog }));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: <T,>(selector: (state: typeof projectsState) => T) => selector(projectsState),
}));

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: <T,>(selector: (state: { windowId: string }) => T) =>
    selector({ windowId: 'window-1' }),
}));

vi.mock('../../../../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const projectMenuRenders = { count: 0 };

vi.mock('../../../../src/renderer/components/workspaces/ProjectGroupContextMenu', () => ({
  ProjectGroupContextMenu: ({ children }: { children: React.ReactNode }) => {
    projectMenuRenders.count++;
    return <>{children}</>;
  },
}));

vi.mock('../../../../src/renderer/components/workspaces/DirectoryGroupContextMenu', () => ({
  DirectoryGroupContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../../src/renderer/components/workspaces/BulkDeleteDialog', () => ({
  BulkDeleteDialog: ({
    open,
    workspaces,
    onConfirm,
  }: {
    open: boolean;
    workspaces: Workspace[];
    onConfirm: (deleteBranch: boolean, workspaces: Workspace[]) => void;
  }) =>
    open ? (
      <div role="dialog">
        {workspaces.map((workspace) => workspace.id).join(' ')}
        <button onClick={() => onConfirm(true, workspaces)}>Delete All</button>
      </div>
    ) : null,
}));

// Like the real card: draggable only when manual DnD is enabled, and its drag
// events bubble.
vi.mock('../../../../src/renderer/components/workspaces/WorkspaceCard', () => ({
  WorkspaceCard: ({
    workspace,
    projectInfo,
    dndEnabled,
    onDragStart,
    onDragOver,
    onDrop,
  }: {
    workspace: Workspace;
    projectInfo?: { name: string } | null;
    dndEnabled?: boolean;
    onDragStart?: (workspaceId: string) => void;
    onDragOver?: (workspaceId: string, position: 'before' | 'after') => void;
    onDrop?: () => void;
  }) => (
    <div
      data-testid={`card-${workspace.id}`}
      data-project={projectInfo?.name}
      draggable={dndEnabled}
      onDragStart={() => onDragStart?.(workspace.id)}
      onDragOver={
        dndEnabled
          ? (e) => {
              e.preventDefault();
              onDragOver?.(workspace.id, 'after');
            }
          : undefined
      }
      onDrop={dndEnabled ? () => onDrop?.() : undefined}
    >
      {workspace.name}
    </div>
  ),
}));

function dataTransfer() {
  return { setData: vi.fn(), effectAllowed: 'none', dropEffect: 'none' };
}

function getGroupHeader(): HTMLElement {
  const header = screen.getByText('Komla').closest('button');
  if (!header) throw new Error('group header not found');
  return header;
}

function getGroupContainer(): HTMLElement {
  // The group container is the element that wraps both the header and the cards.
  const header = getGroupHeader();
  let element: HTMLElement | null = header;
  while (element && !element.contains(screen.getByTestId('card-ws-1'))) {
    element = element.parentElement;
  }
  if (!element) throw new Error('group container not found');
  return element;
}

describe('WorkspaceList drag and drop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspacesState.selectionMode = false;
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', name: 'First', windowId: 'window-1', order: 0 }),
      createWorktreeWorkspace({ id: 'ws-2', name: 'Second', windowId: 'window-1', order: 1 }),
    ];
  });

  it('does not start a group drag when a workspace card is dragged', () => {
    render(<WorkspaceList />);

    fireEvent.dragStart(screen.getByTestId('card-ws-1'), { dataTransfer: dataTransfer() });

    expect(getGroupContainer()).not.toHaveClass('opacity-50');
  });

  it('does not make the whole group the drag source for cards that are not draggable', () => {
    workspacesState.selectionMode = true;
    render(<WorkspaceList />);

    expect(screen.getByTestId('card-ws-1').closest('[draggable="true"]')).toBeNull();
  });

  it('still drags the group from its header', () => {
    render(<WorkspaceList />);

    const header = getGroupHeader();
    const dragSource = header.closest('[draggable="true"]');
    expect(dragSource).not.toBeNull();
    fireEvent.dragStart(dragSource!, { dataTransfer: dataTransfer() });

    expect(getGroupContainer()).toHaveClass('opacity-50');
  });

  it('moves a project group next to its drop target when other projects are not shown', () => {
    projectsState.projects = [
      ...defaultProjects,
      { id: 'project-empty', name: 'Empty', color: '#22c55e', order: 1 },
      { id: 'project-2', name: 'Docs', color: '#ef4444', order: 2 },
      { id: 'project-3', name: 'Site', color: '#eab308', order: 3 },
    ];
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', projectId: 'project-1' }),
      createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1', projectId: 'project-2' }),
      createWorktreeWorkspace({ id: 'ws-3', windowId: 'window-1', projectId: 'project-3' }),
    ];
    render(<WorkspaceList />);
    const dragSourceFor = (name: string) => {
      const source = screen.getByText(name).closest<HTMLElement>('[draggable="true"]');
      if (!source?.parentElement) throw new Error(`${name} group not found`);
      return source;
    };

    // Drop Komla on the lower half of Docs: it belongs after Docs, and the
    // hidden Empty project must not shift it back to where it started.
    fireEvent.dragStart(dragSourceFor('Komla'), { dataTransfer: dataTransfer() });
    const docsGroup = dragSourceFor('Docs').parentElement!;
    fireEvent.dragOver(docsGroup, { dataTransfer: dataTransfer(), clientY: 1 });
    fireEvent.drop(docsGroup, { dataTransfer: dataTransfer() });

    expect(projectsState.reorderProject).toHaveBeenCalledWith('project-1', 2);
    projectsState.projects = defaultProjects;
  });

  it('moves the pinned workspaces of a group without a project along with it', () => {
    workspacesState.workspaces = [
      { id: 'ws-pinned', repoName: 'alpha', order: 0, pinned: true },
      { id: 'ws-a', repoName: 'alpha', order: 1 },
      { id: 'ws-b', repoName: 'beta', order: 2 },
    ].map((w) =>
      createWorktreeWorkspace({ ...w, name: `${w.id} card`, windowId: 'window-1', projectId: null })
    );
    render(<WorkspaceList />);
    const groupFor = (name: string) => {
      const source = screen.getByText(name).closest<HTMLElement>('[draggable="true"]');
      if (!source?.parentElement) throw new Error(`${name} group not found`);
      return source;
    };

    // Drop alpha after beta: beta takes the first slot, ahead of both alpha workspaces.
    fireEvent.dragStart(groupFor('alpha'), { dataTransfer: dataTransfer() });
    const betaGroup = groupFor('beta').parentElement!;
    fireEvent.dragOver(betaGroup, { dataTransfer: dataTransfer(), clientY: 1 });
    fireEvent.drop(betaGroup, { dataTransfer: dataTransfer() });

    expect(workspacesState.reorderWorkspace).toHaveBeenCalledTimes(1);
    expect(workspacesState.reorderWorkspace).toHaveBeenCalledWith('ws-b', 0);
  });

  it('counts snoozed workspaces when it moves a group without a project', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({
        id: 'ws-snoozed',
        name: 'Snoozed card',
        windowId: 'window-1',
        projectId: null,
        repoName: 'gamma',
        order: 0,
        snoozedUntil: Date.now() + 60_000,
      }),
      createWorktreeWorkspace({
        id: 'ws-a',
        name: 'A card',
        windowId: 'window-1',
        projectId: null,
        repoName: 'alpha',
        order: 1,
      }),
      createWorktreeWorkspace({
        id: 'ws-b',
        name: 'B card',
        windowId: 'window-1',
        projectId: null,
        repoName: 'beta',
        order: 2,
      }),
    ];
    render(<WorkspaceList />);
    const groupFor = (name: string) => {
      const source = screen.getByText(name).closest<HTMLElement>('[draggable="true"]');
      if (!source?.parentElement) throw new Error(`${name} group not found`);
      return source;
    };

    // Drop alpha after beta: beta takes order 1, after the snoozed workspace still at 0.
    fireEvent.dragStart(groupFor('alpha'), { dataTransfer: dataTransfer() });
    const betaGroup = groupFor('beta').parentElement!;
    fireEvent.dragOver(betaGroup, { dataTransfer: dataTransfer(), clientY: 1 });
    fireEvent.drop(betaGroup, { dataTransfer: dataTransfer() });

    expect(workspacesState.reorderWorkspace).toHaveBeenCalledWith('ws-b', 1);
  });
});

describe('WorkspaceList pins and snoozes', () => {
  beforeEach(() => {
    resetState();
  });

  const cardIds = () =>
    screen.getAllByTestId(/^card-/).map((card) => card.dataset.testid?.replace('card-', ''));

  const twoProjectWorkspaces = (pinned: string[] = []) => {
    projectsState.projects = [
      ...defaultProjects,
      { id: 'project-2', name: 'Docs', color: '#ef4444', order: 1 },
    ];
    workspacesState.workspaces = [
      { id: 'ws-1', order: 0 },
      { id: 'ws-2', order: 1, projectId: 'project-2' },
      { id: 'ws-3', order: 2 },
      { id: 'ws-4', order: 3, projectId: 'project-2' },
    ].map((w) =>
      createWorktreeWorkspace({ ...w, windowId: 'window-1', pinned: pinned.includes(w.id) })
    );
  };

  it('lists pinned workspaces from every project on a shelf above the groups', () => {
    twoProjectWorkspaces(['ws-3', 'ws-4']);
    render(<WorkspaceList />);

    expect(screen.getByRole('heading', { name: 'Pinned' })).toBeTruthy();
    expect(cardIds()).toEqual(['ws-3', 'ws-4', 'ws-1', 'ws-2']);
    expect(workspacesState.setDisplayOrderedWorkspaceIds).toHaveBeenLastCalledWith([
      'ws-3',
      'ws-4',
      'ws-1',
      'ws-2',
    ]);
    // Away from their groups, pinned cards name their project.
    expect(screen.getByTestId('card-ws-4').dataset.project).toBe('Docs');
    expect(screen.getByTestId('card-ws-1').dataset.project).toBeUndefined();
  });

  it('keeps the header of a project whose workspaces are all pinned', () => {
    twoProjectWorkspaces(['ws-2', 'ws-4']);
    render(<WorkspaceList />);

    expect(screen.getByRole('button', { name: 'New workspace in Docs' })).toBeTruthy();
    expect(cardIds()).toEqual(['ws-2', 'ws-4', 'ws-1', 'ws-3']);
  });

  it('drops the header of a project the tag filter emptied, even with a pinned workspace', () => {
    twoProjectWorkspaces(['ws-2']);
    workspacesState.hiddenWorkspaceTags = new Set(['blocked']);
    workspacesState.workspaces = workspacesState.workspaces.map((w) =>
      w.id === 'ws-4' ? { ...w, tag: 'Blocked' } : w
    );
    render(<WorkspaceList />);

    expect(screen.queryByRole('button', { name: 'New workspace in Docs' })).toBeNull();
    expect(cardIds()).toEqual(['ws-2', 'ws-1', 'ws-3']);
    expect(screen.getByRole('button', { name: /Filtered/ })).toHaveTextContent('1');
  });

  it('leaves out the Pinned shelf when nothing is pinned', () => {
    twoProjectWorkspaces();
    render(<WorkspaceList />);

    expect(screen.queryByRole('heading', { name: 'Pinned' })).toBeNull();
  });

  it('reorders pinned workspaces across projects', () => {
    twoProjectWorkspaces(['ws-3', 'ws-4']);
    render(<WorkspaceList />);

    // ws-3 is in Komla, ws-4 in Docs.
    fireEvent.dragStart(screen.getByTestId('card-ws-3'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(screen.getByTestId('card-ws-4'), { dataTransfer: dataTransfer() });
    fireEvent.drop(screen.getByTestId('card-ws-4'), { dataTransfer: dataTransfer() });

    expect(workspacesState.reorderWorkspace).toHaveBeenCalledWith('ws-3', 3);
  });

  it('keeps snoozed workspaces on a collapsed shelf, except the open one', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1' }),
      createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1', snoozedUntil: 9_000 }),
      createWorktreeWorkspace({ id: 'ws-3', windowId: 'window-1', snoozedUntil: 5_000 }),
    ];
    workspacesState.selectedWorkspaceId = 'ws-2';
    render(<WorkspaceList />);

    const shelf = screen.getByRole('button', { name: /Snoozed/ });
    expect(shelf).toHaveAttribute('aria-expanded', 'false');
    expect(shelf).toHaveTextContent('2');
    expect(cardIds()).toEqual(['ws-1', 'ws-2']);
    expect(workspacesState.setDisplayOrderedWorkspaceIds).toHaveBeenLastCalledWith([
      'ws-1',
      'ws-2',
    ]);

    fireEvent.click(shelf);

    expect(cardIds()).toEqual(['ws-1', 'ws-3', 'ws-2']);
    expect(workspacesState.setDisplayOrderedWorkspaceIds).toHaveBeenLastCalledWith([
      'ws-1',
      'ws-3',
      'ws-2',
    ]);
  });

  it('lists stopped workspaces on a shelf while stopped ones are hidden, last touched first', () => {
    workspacesState.hideStopped = true;
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', terminals: running() }),
      createWorktreeWorkspace({
        id: 'ws-2',
        windowId: 'window-1',
        terminals: [],
        lastActivityAt: 5_000,
      }),
      createWorktreeWorkspace({
        id: 'ws-3',
        windowId: 'window-1',
        terminals: [],
        lastActivityAt: 9_000,
      }),
      // Another window's workspaces aren't listed here, stopped or not.
      createWorktreeWorkspace({ id: 'ws-4', windowId: 'window-2', terminals: [] }),
    ];
    render(<WorkspaceList />);

    const shelf = screen.getByRole('button', { name: /Stopped/ });
    expect(shelf).toHaveAttribute('aria-expanded', 'false');
    expect(shelf).toHaveTextContent('2');
    expect(cardIds()).toEqual(['ws-1']);

    fireEvent.click(shelf);

    expect(cardIds()).toEqual(['ws-1', 'ws-3', 'ws-2']);
    expect(workspacesState.setDisplayOrderedWorkspaceIds).toHaveBeenLastCalledWith([
      'ws-1',
      'ws-3',
      'ws-2',
    ]);
  });

  it('leaves out the Stopped shelf while stopped workspaces are listed', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', terminals: [] }),
    ];
    render(<WorkspaceList />);

    expect(screen.queryByRole('button', { name: /Stopped/ })).toBeNull();
    expect(cardIds()).toEqual(['ws-1']);
  });

  it('lists trashed workspaces from every window on a shelf, outside keyboard navigation', () => {
    projectsState.projects = [
      ...defaultProjects,
      { id: 'project-2', name: 'Docs', color: '#ef4444', order: 1 },
    ];
    workspacesState.hiddenProjectIds = new Set(['project-2']);
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1' }),
      createWorktreeWorkspace({
        id: 'ws-2',
        windowId: null,
        status: 'trashed',
        lastActivityAt: 2_000,
      }),
      createWorktreeWorkspace({
        id: 'ws-3',
        windowId: 'window-2',
        status: 'trashed',
        lastActivityAt: 3_000,
      }),
      createWorktreeWorkspace({
        id: 'ws-4',
        windowId: null,
        status: 'trashed',
        projectId: 'project-2',
      }),
    ];
    render(<WorkspaceList />);

    const shelf = screen.getByRole('button', { name: /Trash/ });
    expect(shelf).toHaveTextContent('2');
    expect(cardIds()).toEqual(['ws-1']);

    fireEvent.click(shelf);

    expect(cardIds()).toEqual(['ws-1', 'ws-3', 'ws-2']);
    // Away from their groups, the cards name their project.
    expect(screen.getByTestId('card-ws-2').dataset.project).toBe('Komla');
    // Opening one restores it, so the arrow keys pass it by.
    expect(workspacesState.setDisplayOrderedWorkspaceIds).toHaveBeenLastCalledWith(['ws-1']);
  });

  it('keeps workspaces with a hidden tag on a collapsed Filtered shelf, the open one in sight', () => {
    workspacesState.hiddenWorkspaceTags = new Set(['waiting for merge']);
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', tag: 'Waiting for review' }),
      createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1', tag: 'Waiting for Merge' }),
      createWorktreeWorkspace({ id: 'ws-3', windowId: 'window-1', tag: 'Waiting for merge' }),
    ];
    workspacesState.selectedWorkspaceId = 'ws-3';
    render(<WorkspaceList />);

    const shelf = screen.getByRole('button', { name: /Filtered/ });
    expect(shelf).toHaveAttribute('aria-expanded', 'false');
    expect(shelf).toHaveTextContent('2');
    expect(cardIds()).toEqual(['ws-1', 'ws-3']);

    fireEvent.click(shelf);

    expect(cardIds()).toEqual(['ws-1', 'ws-2', 'ws-3']);
  });

  it('lists one tag alone once Untagged and the other tags are hidden', () => {
    workspacesState.hiddenWorkspaceTags = new Set(['', 'blocked']);
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', tag: 'In review' }),
      createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1' }),
      createWorktreeWorkspace({ id: 'ws-3', windowId: 'window-1', tag: 'Blocked' }),
    ];
    render(<WorkspaceList />);

    expect(cardIds()).toEqual(['ws-1']);
    expect(screen.getByRole('button', { name: /Filtered/ })).toHaveTextContent('2');
  });

  it('brings a workspace with a hidden tag back to the list once its agent needs the user', () => {
    workspacesState.hiddenWorkspaceTags = new Set(['blocked']);
    const terminal = (id: string, attention?: WorkspaceAttention) =>
      createTerminal({ id, status: 'running', ...(attention ? { attention } : {}) });
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', tag: 'Blocked' }),
      createWorktreeWorkspace({
        id: 'ws-2',
        windowId: 'window-1',
        tag: 'Blocked',
        terminals: [
          terminal('t-2', { kind: 'input-required', source: 'claude-code', updatedAt: 1 }),
        ],
      }),
      createWorktreeWorkspace({
        id: 'ws-3',
        windowId: 'window-1',
        tag: 'Blocked',
        terminals: [
          terminal('t-3', { kind: 'turn-complete', source: 'claude-code', updatedAt: 1 }),
        ],
      }),
      createWorktreeWorkspace({
        id: 'ws-4',
        windowId: 'window-1',
        tag: 'Blocked',
        unread: { reason: 'snooze-ended', at: 1 },
      }),
    ];
    render(<WorkspaceList />);

    expect(screen.getByRole('button', { name: /Filtered/ })).toHaveTextContent('1');
    expect(cardIds()).toEqual(['ws-2', 'ws-3', 'ws-4']);
  });

  it('keeps the open workspace in the list once its done is seen, though its tag is hidden', () => {
    workspacesState.hiddenWorkspaceTags = new Set(['blocked']);
    const done = (seen: boolean) =>
      createWorktreeWorkspace({
        id: 'ws-1',
        windowId: 'window-1',
        tag: 'Blocked',
        terminals: [
          createTerminal({
            id: 't-1',
            status: 'running',
            attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1, seen },
          }),
        ],
      });
    const other = createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1' });
    workspacesState.workspaces = [done(false), other];
    workspacesState.selectedWorkspaceId = 'ws-1';
    const { rerender } = render(<WorkspaceList />);
    expect(cardIds()).toEqual(['ws-1', 'ws-2']);

    workspacesState.workspaces = [done(true), other];
    rerender(<WorkspaceList />);
    expect(screen.queryByRole('button', { name: /Filtered/ })).toBeNull();
    expect(cardIds()).toEqual(['ws-1', 'ws-2']);

    workspacesState.selectedWorkspaceId = 'ws-2';
    rerender(<WorkspaceList />);
    expect(screen.getByRole('button', { name: /Filtered/ })).toHaveTextContent('1');
    expect(cardIds()).toEqual(['ws-2']);
  });

  it('empties the Trash shelf for good after the delete dialog confirms', () => {
    projectsState.projects = [
      ...defaultProjects,
      { id: 'project-2', name: 'Docs', color: '#ef4444', order: 1 },
    ];
    workspacesState.hiddenProjectIds = new Set(['project-2']);
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1' }),
      createWorktreeWorkspace({ id: 'ws-2', status: 'trashed', lastActivityAt: 2_000 }),
      createWorktreeWorkspace({ id: 'ws-3', status: 'trashed', lastActivityAt: 3_000 }),
      createWorktreeWorkspace({ id: 'ws-4', status: 'trashed', projectId: 'project-2' }),
    ];
    render(<WorkspaceList />);

    // Only an open Trash shelf offers it.
    expect(screen.queryByRole('button', { name: 'Empty Trash' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
    expect(screen.getByText('Deleted after 7 days')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Empty Trash' }));

    // The hidden project's workspace isn't on the shelf, so it stays.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('ws-3 ws-2');
    fireEvent.click(screen.getByRole('button', { name: 'Delete All' }));
    expect(workspacesState.deleteWorkspaces).toHaveBeenCalledWith(['ws-3', 'ws-2'], true, true);
  });

  describe('while working workspaces are hidden', () => {
    beforeEach(() => {
      workspacesState.hideWorking = true;
    });

    const working = (id: string, overrides: Partial<Workspace> = {}) =>
      createWorktreeWorkspace({
        id,
        windowId: 'window-1',
        terminals: [createTerminal({ id: `term-${id}`, status: 'running', agentActive: true })],
        ...overrides,
      });

    it('keeps working workspaces on a collapsed shelf', () => {
      workspacesState.workspaces = [
        createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1' }),
        working('ws-2'),
        working('ws-3'),
      ];
      render(<WorkspaceList />);

      const shelf = screen.getByRole('button', { name: /Working/ });
      expect(shelf).toHaveAttribute('aria-expanded', 'false');
      expect(shelf).toHaveTextContent('2');
      expect(cardIds()).toEqual(['ws-1']);

      fireEvent.click(shelf);

      expect(cardIds()).toEqual(['ws-1', 'ws-2', 'ws-3']);
      expect(workspacesState.setDisplayOrderedWorkspaceIds).toHaveBeenLastCalledWith([
        'ws-1',
        'ws-2',
        'ws-3',
      ]);
    });

    it('keeps the open workspace in the list while its agent starts working', () => {
      workspacesState.workspaces = [
        createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', terminals: running() }),
        createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1' }),
      ];
      workspacesState.selectedWorkspaceId = 'ws-1';
      const { rerender } = render(<WorkspaceList />);

      workspacesState.workspaces = [
        working('ws-1'),
        createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1' }),
      ];
      rerender(<WorkspaceList />);
      expect(screen.queryByRole('button', { name: /Working/ })).toBeNull();
      expect(cardIds()).toEqual(['ws-1', 'ws-2']);

      workspacesState.selectedWorkspaceId = 'ws-2';
      rerender(<WorkspaceList />);
      expect(screen.getByRole('button', { name: /Working/ })).toHaveTextContent('1');
      expect(cardIds()).toEqual(['ws-2']);
    });

    it('moves a workspace back into the list once its agent needs the user', () => {
      workspacesState.workspaces = [
        createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1' }),
        working('ws-2', {
          terminals: [
            createTerminal({
              id: 'term-ws-2',
              status: 'running',
              agentActive: true,
              attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
            }),
          ],
        }),
        working('ws-3', {
          terminals: [
            createTerminal({
              id: 'term-ws-3',
              status: 'running',
              attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1 },
            }),
          ],
        }),
        working('ws-4'),
      ];
      render(<WorkspaceList />);

      expect(screen.getByRole('button', { name: /Working/ })).toHaveTextContent('1');
      expect(cardIds()).toEqual(['ws-1', 'ws-2', 'ws-3']);
    });

    it('leaves a workspace whose own alert needs the user in the list', () => {
      workspacesState.workspaces = [
        working('ws-1', {
          attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
        }),
      ];
      render(<WorkspaceList />);

      expect(screen.queryByRole('button', { name: /Working/ })).toBeNull();
      expect(cardIds()).toEqual(['ws-1']);
    });

    it('keeps the open workspace in the list when working ones are hidden while it works', () => {
      workspacesState.hideWorking = false;
      workspacesState.workspaces = [working('ws-1'), working('ws-2')];
      workspacesState.selectedWorkspaceId = 'ws-1';
      const { rerender } = render(<WorkspaceList />);

      workspacesState.hideWorking = true;
      rerender(<WorkspaceList />);

      expect(screen.getByRole('button', { name: /Working/ })).toHaveTextContent('1');
      expect(cardIds()).toEqual(['ws-1']);
    });

    it('drops workspaces that move onto the closed shelf from the multi-selection', () => {
      workspacesState.selectionMode = true;
      workspacesState.selectedWorkspaceIds = new Set(['ws-1', 'ws-2', 'ws-3']);
      workspacesState.selectedWorkspaceId = 'ws-3';
      workspacesState.workspaces = [
        createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1' }),
        working('ws-2'),
        working('ws-3'),
      ];
      workspacesState.hideWorking = false;
      const { rerender } = render(<WorkspaceList />);
      workspacesState.hideWorking = true;
      rerender(<WorkspaceList />);

      // The open workspace stays in sight, so it stays selected.
      expect(workspacesState.deselectWorkspaces).toHaveBeenCalledWith(['ws-2']);
    });

    it('leaves commands and a spinner turned on by hand in the list, since no agent notifies', () => {
      workspacesState.workspaces = [
        working('ws-1', {
          terminals: [
            createTerminal({
              id: 'term-ws-1',
              status: 'running',
              agentActive: true,
              commandActive: true,
            }),
          ],
        }),
        createWorktreeWorkspace({
          id: 'ws-2',
          windowId: 'window-1',
          agentActive: true,
          terminals: running(),
        }),
      ];
      render(<WorkspaceList />);

      expect(screen.queryByRole('button', { name: /Working/ })).toBeNull();
      expect(cardIds()).toEqual(['ws-1', 'ws-2']);
    });

    it('keeps a workspace opened from the shelf on it while it is open', () => {
      workspacesState.collapsedWorkspaceGroupKeys = new Set(['project:project-1']);
      workspacesState.workspaces = [working('ws-1'), working('ws-2')];
      const { rerender } = render(<WorkspaceList />);
      fireEvent.click(screen.getByRole('button', { name: /Working/ }));

      workspacesState.selectedWorkspaceId = 'ws-2';
      rerender(<WorkspaceList />);

      expect(screen.getByRole('button', { name: /Working/ })).toHaveTextContent('2');
      expect(cardIds()).toEqual(['ws-1', 'ws-2']);

      // Its agent finishing while it's open doesn't move it either; leaving it does.
      workspacesState.workspaces = [working('ws-1'), working('ws-2', { terminals: running() })];
      rerender(<WorkspaceList />);
      expect(screen.getByRole('button', { name: /Working/ })).toHaveTextContent('2');

      workspacesState.selectedWorkspaceId = 'ws-1';
      rerender(<WorkspaceList />);
      expect(screen.getByRole('button', { name: /Working/ })).toHaveTextContent('1');
    });

    it('keeps pinned working workspaces pinned, and the header of a project that all works', () => {
      workspacesState.workspaces = [working('ws-1', { pinned: true }), working('ws-2')];
      render(<WorkspaceList />);

      expect(screen.getByRole('button', { name: /Working/ })).toHaveTextContent('1');
      expect(cardIds()).toEqual(['ws-1']);
      expect(screen.getByRole('button', { name: 'New workspace in Komla' })).toBeTruthy();
    });
  });

  it('leaves working workspaces in the list unless they are hidden', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({
        id: 'ws-1',
        windowId: 'window-1',
        agentActive: true,
        terminals: running(),
      }),
    ];
    render(<WorkspaceList />);

    expect(screen.queryByRole('button', { name: /Working/ })).toBeNull();
    expect(cardIds()).toEqual(['ws-1']);
  });

  it('opens one shelf at a time', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', snoozedUntil: 9_000 }),
      createWorktreeWorkspace({ id: 'ws-2', windowId: null, status: 'trashed' }),
    ];
    render(<WorkspaceList />);
    const snoozed = screen.getByRole('button', { name: /Snoozed/ });
    const trashed = screen.getByRole('button', { name: /Trash/ });

    fireEvent.click(snoozed);
    expect(cardIds()).toEqual(['ws-1']);

    fireEvent.click(trashed);
    expect(snoozed).toHaveAttribute('aria-expanded', 'false');
    expect(trashed).toHaveAttribute('aria-expanded', 'true');
    expect(cardIds()).toEqual(['ws-2']);
  });

  it('closes a shelf that empties, so it comes back closed', () => {
    const trashed = createWorktreeWorkspace({ id: 'ws-1', windowId: null, status: 'trashed' });
    workspacesState.workspaces = [trashed];
    const { rerender } = render(<WorkspaceList />);
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));

    workspacesState.workspaces = [{ ...trashed, status: 'active', windowId: 'window-1' }];
    rerender(<WorkspaceList />);
    expect(screen.queryByRole('button', { name: /Trash/ })).toBeNull();

    workspacesState.workspaces = [trashed];
    rerender(<WorkspaceList />);
    expect(screen.getByRole('button', { name: /Trash/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists the 50 most recent trashed workspaces and sends the rest to the Overview', () => {
    workspacesState.workspaces = Array.from({ length: 52 }, (_, n) =>
      createWorktreeWorkspace({
        id: `ws-${n}`,
        windowId: null,
        status: 'trashed',
        lastActivityAt: 1_000 + n,
      })
    );
    render(<WorkspaceList />);

    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));

    expect(cardIds()).toHaveLength(50);
    expect(cardIds()[0]).toBe('ws-51');
    fireEvent.click(screen.getByRole('button', { name: '2 more in Overview' }));
    expect(workspacesState.selectWorkspace).toHaveBeenCalledWith(null);
  });

  it('reorders a workspace only among the pinned or the unpinned ones', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', order: 0, pinned: true }),
      createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1', order: 1, pinned: true }),
      createWorktreeWorkspace({ id: 'ws-3', windowId: 'window-1', order: 2 }),
    ];
    render(<WorkspaceList />);

    fireEvent.dragStart(screen.getByTestId('card-ws-3'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(screen.getByTestId('card-ws-1'), { dataTransfer: dataTransfer() });
    fireEvent.drop(screen.getByTestId('card-ws-1'), { dataTransfer: dataTransfer() });
    expect(workspacesState.reorderWorkspace).not.toHaveBeenCalled();

    fireEvent.dragStart(screen.getByTestId('card-ws-1'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(screen.getByTestId('card-ws-2'), { dataTransfer: dataTransfer() });
    fireEvent.drop(screen.getByTestId('card-ws-2'), { dataTransfer: dataTransfer() });
    expect(workspacesState.reorderWorkspace).toHaveBeenCalledWith('ws-1', 1);
  });
});

function resetState() {
  vi.clearAllMocks();
  projectsState.projects = defaultProjects;
  Object.assign(workspacesState, {
    workspaces: [],
    selectedWorkspaceId: null,
    collapsedWorkspaceGroupKeys: new Set<string>(),
    hideStopped: false,
    hideWorking: false,
    grouping: 'project',
    hiddenProjectIds: new Set<string>(),
    hiddenWorkspaceHostIds: new Set<string>(),
    hiddenWorkspaceTags: new Set<string>(),
    selectionMode: false,
    selectedWorkspaceIds: new Set<string>(),
  });
}

const running = () => [createTerminal({ status: 'running' })];

describe('WorkspaceList without grouping', () => {
  beforeEach(() => {
    resetState();
    workspacesState.grouping = 'none';
    projectsState.projects = [
      ...defaultProjects,
      { id: 'project-2', name: 'Docs', color: '#ef4444', order: 1 },
    ];
    workspacesState.workspaces = [
      { id: 'ws-1', order: 0 },
      { id: 'ws-2', order: 1, projectId: 'project-2' },
      { id: 'ws-3', order: 2 },
    ].map((w) => createWorktreeWorkspace({ ...w, windowId: 'window-1' }));
  });

  const cardIds = () =>
    screen.getAllByTestId(/^card-/).map((card) => card.dataset.testid?.replace('card-', ''));

  it('lists every workspace in its own order, naming its project', () => {
    render(<WorkspaceList />);

    expect(screen.queryByRole('button', { name: /Komla|Docs/ })).toBeNull();
    expect(cardIds()).toEqual(['ws-1', 'ws-2', 'ws-3']);
    expect(workspacesState.setDisplayOrderedWorkspaceIds).toHaveBeenLastCalledWith([
      'ws-1',
      'ws-2',
      'ws-3',
    ]);
    expect(screen.getByTestId('card-ws-2').dataset.project).toBe('Docs');
    expect(screen.getByTestId('card-ws-1').dataset.project).toBe('Komla');
  });

  it('reorders a workspace past workspaces of other projects', () => {
    render(<WorkspaceList />);

    // ws-1 is in Komla, ws-2 in Docs.
    fireEvent.dragStart(screen.getByTestId('card-ws-1'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(screen.getByTestId('card-ws-2'), { dataTransfer: dataTransfer() });
    fireEvent.drop(screen.getByTestId('card-ws-2'), { dataTransfer: dataTransfer() });

    expect(workspacesState.reorderWorkspace).toHaveBeenCalledWith('ws-1', 1);
  });

  it('keeps hidden projects out of the list', () => {
    workspacesState.hiddenProjectIds = new Set(['project-2']);
    render(<WorkspaceList />);

    expect(cardIds()).toEqual(['ws-1', 'ws-3']);
  });
});

describe('WorkspaceList group headers', () => {
  beforeEach(() => {
    resetState();
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', name: 'First', windowId: 'window-1', order: 0 }),
      createWorktreeWorkspace({ id: 'ws-2', name: 'Second', windowId: 'window-1', order: 1 }),
    ];
  });

  it('toggles the group from a header that reports whether it is expanded', () => {
    render(<WorkspaceList />);

    const toggle = getGroupHeader();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);

    expect(workspacesState.toggleWorkspaceGroupCollapsed).toHaveBeenCalledWith('project:project-1');
  });

  it('leaves an expanded header alone when one of its workspaces changes', () => {
    const { rerender } = render(<WorkspaceList />);
    projectMenuRenders.count = 0;

    workspacesState.workspaces = [
      { ...workspacesState.workspaces[0], lastDynamicTitle: '◐ Fixing the test' },
      workspacesState.workspaces[1],
    ];
    rerender(<WorkspaceList />);

    expect(projectMenuRenders.count).toBe(0);
  });

  it('keeps a collapsed group collapsed from the persisted state', () => {
    workspacesState.collapsedWorkspaceGroupKeys = new Set(['project:project-1']);
    render(<WorkspaceList />);

    expect(getGroupHeader()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('card-ws-1')).not.toBeInTheDocument();
  });

  it('shows the workspace count only while the group is collapsed', () => {
    const { rerender } = render(<WorkspaceList />);
    expect(getGroupHeader()).not.toHaveTextContent('2 workspaces');

    workspacesState.collapsedWorkspaceGroupKeys = new Set(['project:project-1']);
    rerender(<WorkspaceList />);
    expect(getGroupHeader()).toHaveTextContent('2 workspaces');
  });

  it('offers to add the repository of SSH workspaces without a project here', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({
        id: 'ws-ssh',
        name: 'From laptop',
        windowId: 'window-1',
        projectId: null,
        repoName: 'app',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/.komla/worktrees/app/main',
          remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
          remoteProjectRoot: '/home/dev/.komla/worktrees/app',
          gitUrl: 'git@github.com:acme/app.git',
        },
      }),
    ];
    render(<WorkspaceList />);

    expect(screen.getByRole('button', { name: 'Add app as a project' })).toBeInTheDocument();
  });

  it('keeps the New workspace button outside the toggle', () => {
    render(<WorkspaceList />);

    const add = screen.getByRole('button', { name: 'New workspace in Komla' });
    expect(add.closest('button')).toBe(add);
    expect(add.parentElement?.closest('button')).toBeNull();
    fireEvent.click(add);
    expect(openNewWorkspaceDialog).toHaveBeenCalledWith({ prefill: { projectId: 'project-1' } });
    expect(workspacesState.toggleWorkspaceGroupCollapsed).not.toHaveBeenCalled();
  });

  it('surfaces input, errors and running agents on a collapsed group', () => {
    workspacesState.collapsedWorkspaceGroupKeys = new Set(['project:project-1']);
    workspacesState.workspaces = [
      createWorktreeWorkspace({
        id: 'ws-1',
        windowId: 'window-1',
        attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
      }),
      createWorktreeWorkspace({
        id: 'ws-2',
        windowId: 'window-1',
        attention: { kind: 'error', source: 'claude-code', updatedAt: 1 },
      }),
      createWorktreeWorkspace({
        id: 'ws-3',
        windowId: 'window-1',
        agentActive: true,
        terminals: running(),
      }),
      createWorktreeWorkspace({
        id: 'ws-4',
        windowId: 'window-1',
        agentActive: true,
        terminals: running(),
      }),
    ];
    render(<WorkspaceList />);

    const header = getGroupHeader();
    expect(header).toHaveTextContent('1 needs input');
    expect(header).toHaveTextContent('1 error');
    expect(header).toHaveTextContent('2 running');
  });

  it('keeps an expanded header quiet, since its cards show the status', () => {
    workspacesState.workspaces = [
      createWorktreeWorkspace({
        id: 'ws-1',
        windowId: 'window-1',
        attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
      }),
    ];
    render(<WorkspaceList />);

    expect(getGroupHeader()).not.toHaveTextContent('needs input');
  });

  it('highlights a collapsed group that holds the selected workspace', () => {
    workspacesState.collapsedWorkspaceGroupKeys = new Set(['project:project-1']);
    workspacesState.selectedWorkspaceId = 'ws-2';
    render(<WorkspaceList />);

    expect(getGroupHeader().closest('[data-group-header]')).toHaveAttribute(
      'data-contains-selection',
      'true'
    );
  });

  it('does not highlight an expanded group, whose card already shows the selection', () => {
    workspacesState.selectedWorkspaceId = 'ws-2';
    render(<WorkspaceList />);

    expect(getGroupHeader().closest('[data-group-header]')).not.toHaveAttribute(
      'data-contains-selection'
    );
  });
});

describe('WorkspaceList empty states', () => {
  beforeEach(resetState);

  it('leaves out projects without active workspaces', () => {
    projectsState.projects = [
      ...defaultProjects,
      { id: 'project-2', name: 'Docs', color: '#ef4444', order: 1 },
      { id: 'project-3', name: 'Shelved', color: '#22c55e', order: 2 },
    ];
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', projectId: 'project-1' }),
      createWorktreeWorkspace({
        id: 'ws-2',
        windowId: 'window-1',
        projectId: 'project-3',
        status: 'trashed',
      }),
    ];
    render(<WorkspaceList />);

    expect(screen.getByText('Komla')).toBeInTheDocument();
    expect(screen.queryByText('Docs')).not.toBeInTheDocument();
    expect(screen.queryByText('Shelved')).not.toBeInTheDocument();
  });

  it('keeps the shelves when every workspace on a visible host is stopped and hidden', () => {
    const remoteBackend = {
      kind: 'ssh' as const,
      hostId: 'ssh-devbox',
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
      projectName: 'Repo',
    };
    workspacesState.hideStopped = true;
    workspacesState.hiddenWorkspaceHostIds = new Set(['ssh-devbox']);
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', terminals: [] }),
      createWorktreeWorkspace({
        id: 'ws-2',
        windowId: 'window-1',
        terminals: running(),
        backend: remoteBackend,
      }),
    ];
    render(<WorkspaceList />);

    expect(screen.queryByText('No workspaces on visible hosts')).toBeNull();
    expect(screen.getByRole('button', { name: /Stopped/ })).toHaveTextContent('1');
  });

  it('keeps the Trash shelf below Get started', () => {
    projectsState.projects = [];
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: null, status: 'trashed' }),
    ];
    render(<WorkspaceList />);

    expect(screen.getByText('Get started')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Trash/ })).toBeInTheDocument();
  });

  it('leaves every workspace hidden as stopped to the Stopped shelf, without a message', () => {
    workspacesState.hideStopped = true;
    workspacesState.workspaces = [1, 2, 3].map((n) =>
      createWorktreeWorkspace({ id: `ws-${n}`, windowId: 'window-1', terminals: [] })
    );
    render(<WorkspaceList />);

    expect(screen.getByRole('button', { name: /Stopped/ })).toHaveTextContent('3');
    expect(screen.queryByText(/hidden|are stopped/)).toBeNull();
  });

  it('explains that projects are hidden and offers to show them', () => {
    projectsState.projects = [
      ...defaultProjects,
      { id: 'project-2', name: 'Docs', color: '#ef4444', order: 1 },
    ];
    workspacesState.hiddenProjectIds = new Set(['project-1', 'project-2']);
    workspacesState.workspaces = [
      createWorktreeWorkspace({ id: 'ws-1', windowId: 'window-1', projectId: 'project-1' }),
      createWorktreeWorkspace({ id: 'ws-2', windowId: 'window-1', projectId: 'project-2' }),
    ];
    render(<WorkspaceList />);

    expect(screen.getByText('2 projects hidden')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show projects' }));
    expect(workspacesState.unhideProjectGroups).toHaveBeenCalledWith(['project-1', 'project-2']);
  });

  it('leaves the list empty when there are no workspaces yet', () => {
    workspacesState.hiddenProjectIds = new Set(['project-1']);
    render(<WorkspaceList />);

    expect(screen.queryByText('No workspaces yet')).toBeNull();
    expect(screen.queryByText(/hidden|stopped/)).toBeNull();
  });
});
