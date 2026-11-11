/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalTabs } from '../../../../src/renderer/components/terminal/TerminalTabs';
import { awaitUserReturn } from '../../../../src/renderer/hooks/useAwaitingUserReturn';
import { createLeaf, getAllLeaves, splitLeaf } from '../../../../src/renderer/lib/layout-utils';
import {
  registerPaneCloseConfirm,
  setFilePaneDraft,
} from '../../../../src/renderer/lib/pane-surfaces';
import { useFileListStore } from '../../../../src/renderer/stores/file-list.store';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { useLayoutStore } from '../../../../src/renderer/stores/layout.store';
import { usePaneSurfacesStore } from '../../../../src/renderer/stores/pane-surfaces.store';
import { useShortcutsStore } from '../../../../src/renderer/stores/shortcuts.store';
import { useTerminalCloseStore } from '../../../../src/renderer/stores/terminal-close.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { useWindowStore } from '../../../../src/renderer/stores/window.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createTerminal, createWorkspace } from '../../../factories';

import type { WorkspaceAttention } from '../../../../src/shared/types';

const mocks = vi.hoisted(() => ({
  closeTerminalPane: vi.fn(),
}));

vi.mock('../../../../src/renderer/lib/close-terminal-pane', () => ({
  closeTerminalPane: mocks.closeTerminalPane,
}));
vi.mock('../../../../src/renderer/components/dashboard', () => ({ DashboardView: () => null }));
vi.mock('../../../../src/renderer/components/workspaces/SetupActivityPanel', () => ({
  SetupActivityNotificationCenter: () => null,
  WorkspaceSetupActivity: () => null,
}));
vi.mock('../../../../src/renderer/components/terminal/SplitContainer', () => ({
  SplitContainer: ({ tabId, isActive }: { tabId: string; isActive: boolean }) => (
    <div data-testid={`split-${tabId}`} data-active={isActive} />
  ),
}));
vi.mock('../../../../src/renderer/components/terminal/InlineFilePreviewPanel', () => ({
  InlineFilePreviewPanel: () => null,
}));
vi.mock('../../../../src/renderer/components/terminal/InlineDevServerPreviewPanel', () => ({
  InlineDevServerPreviewPanel: () => null,
}));
vi.mock('../../../../src/renderer/components/terminal/InlineFileTreePanel', () => ({
  InlineFileTreePanel: () => null,
}));
vi.mock('../../../../src/renderer/components/terminal/ActionTabButton', () => ({
  ActionTabButton: () => <button type="button">More quick commands</button>,
}));
const newTabButtonRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../../src/renderer/components/terminal/NewTabButton', () => ({
  NewTabButton: ({ onNewTerminal }: { onNewTerminal: () => void }) => {
    newTabButtonRenders.count++;
    return (
      <button type="button" onClick={onNewTerminal}>
        New tab
      </button>
    );
  },
}));
vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip" hidden>
      {children}
    </div>
  ),
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
// Render each tab's context menu inline so its items are plain buttons.
vi.mock('../../../../src/renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
  }: React.PropsWithChildren<{ disabled?: boolean; onSelect?: () => void }>) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuCheckboxItem: ({
    children,
    checked,
  }: React.PropsWithChildren<{ checked?: boolean }>) => (
    <button type="button" role="menuitemcheckbox" aria-checked={checked}>
      {children}
    </button>
  ),
  ContextMenuSub: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ContextMenuSubTrigger: ({
    children,
    disabled,
  }: React.PropsWithChildren<{ disabled?: boolean }>) => (
    <span aria-disabled={disabled || undefined}>{children}</span>
  ),
  ContextMenuSubContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ContextMenuSeparator: () => null,
}));

const WORKSPACE_ID = 'ws-1';

function setUpWorkspace(
  tabIds: string[],
  {
    activeTabId = tabIds[0],
    attention,
    fileTreeOpen,
    fileTreeMode,
    sidebarPanelId,
  }: {
    activeTabId?: string;
    attention?: Record<string, WorkspaceAttention>;
    fileTreeOpen?: boolean;
    fileTreeMode?: 'diff' | 'browse';
    sidebarPanelId?: string;
  } = {}
) {
  useWorkspacesStore.setState({
    workspaces: [
      createWorkspace({
        id: WORKSPACE_ID,
        workingDirectory: '/repo',
        isWorktree: true,
        fileTreeOpen,
        fileTreeMode,
        sidebarPanelId,
        terminals: tabIds.map((id) =>
          createTerminal({ id, name: `Tab ${id}`, attention: attention?.[id] })
        ),
      }),
    ],
    selectedWorkspaceId: WORKSPACE_ID,
    hasLoaded: true,
  });
  const leaves = Object.fromEntries(tabIds.map((id) => [id, createLeaf(id)]));
  useLayoutStore.setState({
    currentWorkspaceId: WORKSPACE_ID,
    tabsByWorkspace: { [WORKSPACE_ID]: tabIds },
    layoutsByTab: { [WORKSPACE_ID]: leaves },
    focusedPaneByTab: {
      [WORKSPACE_ID]: Object.fromEntries(tabIds.map((id) => [id, leaves[id].id])),
    },
    activeTabByWorkspace: { [WORKSPACE_ID]: activeTabId },
  });
}

function getTab(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

// The mocked context menu renders each tab's menu right after the tab.
function getTabMenu(name: string) {
  const tab = getTab(name).closest('[data-tab-id]') as HTMLElement;
  return tab.nextElementSibling as HTMLElement;
}

describe('TerminalTabs', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    mocks.closeTerminalPane.mockReset().mockResolvedValue(undefined);
    useFileListStore.setState(useFileListStore.getInitialState(), true);
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useTerminalCloseStore.setState(useTerminalCloseStore.getInitialState(), true);
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        clearTerminalAttention: vi.fn().mockResolvedValue(undefined),
        markTerminalAttentionSeen: vi.fn().mockResolvedValue(undefined),
        // The tab row is the top of the window: Open in editor and the Linux window controls.
        getAvailableEditors: vi.fn().mockResolvedValue([]),
        isWindowMaximized: vi.fn().mockResolvedValue(false),
        onWindowMaximizedChange: vi.fn(() => () => {}),
        // The window without workspaces lists the recent folders.
        getRecentFolders: vi.fn().mockResolvedValue([]),
        // The file panel's tabs list its sidebar panels.
        listSidebarPanels: vi.fn().mockResolvedValue({ panels: [] }),
        onSidebarPanelsChange: vi.fn(() => () => {}),
        listSidebarPanelStates: vi.fn().mockResolvedValue([]),
        onSidebarPanelStateChange: vi.fn(() => () => {}),
        platform: 'linux',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // An agent changes its terminal's title with every frame of its spinner.
  it("does not re-render for the title of another workspace's terminal", () => {
    setUpWorkspace(['t1']);
    useWorkspacesStore.setState((state) => ({
      workspaces: [
        ...state.workspaces,
        createWorkspace({
          id: 'ws-background',
          terminals: [createTerminal({ id: 'agent', name: 'Agent', dynamicTitle: '⠋ Working' })],
        }),
      ],
    }));
    render(<TerminalTabs />);
    const rendersBefore = newTabButtonRenders.count;

    act(() => useWorkspacesStore.getState().setTerminalDynamicTitle('agent', '⠙ Working'));

    expect(newTabButtonRenders.count).toBe(rendersBefore);
  });

  it("shows a new title of the open workspace's terminal", () => {
    setUpWorkspace(['t1']);
    render(<TerminalTabs />);

    act(() => useWorkspacesStore.getState().setTerminalDynamicTitle('t1', 'Fixing tests'));

    expect(getTab('Fixing tests')).toBeInTheDocument();
  });

  it('removes a workspace whose files are gone from its host in one click', () => {
    const removeMissingSshWorkspace = vi.fn().mockResolvedValue(undefined);
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: WORKSPACE_ID,
          provisionError: 'This workspace’s files are no longer on its SSH host.',
          provisionErrorReason: 'missing-from-host',
        }),
      ],
      selectedWorkspaceId: WORKSPACE_ID,
      hasLoaded: true,
      removeMissingSshWorkspace,
    });

    render(<TerminalTabs />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this device' }));

    expect(removeMissingSshWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  // A workspace's status page paints nothing, so it shows the work column's chrome, the sidebar's
  // color, rather than the card.
  it.each([
    {
      page: 'restarting',
      text: 'Restarting workspace...',
      workspace: {},
      restarting: true,
    },
    {
      page: 'setting up',
      text: 'Setting up workspace...',
      workspace: { provisioning: true },
      restarting: false,
    },
    {
      page: 'setup failed',
      text: 'Workspace setup failed',
      workspace: { provisionError: 'git worktree add failed' },
      restarting: false,
    },
  ])('shows a workspace that is $page on the chrome', ({ text, workspace, restarting }) => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: WORKSPACE_ID, ...workspace })],
      selectedWorkspaceId: WORKSPACE_ID,
      restartingWorkspaceIds: new Set(restarting ? [WORKSPACE_ID] : []),
      hasLoaded: true,
    });

    const { container } = render(<TerminalTabs />);

    const painted: Element[] = [];
    for (let el = screen.getByText(text).parentElement; el && el !== container;) {
      if ([...el.classList].some((name) => name.startsWith('bg-'))) painted.push(el);
      el = el.parentElement;
    }
    expect(painted).toEqual([]);
  });

  // zustand 5 re-renders forever if a selector returns a fresh [] each call.
  it('renders with no selected workspace', () => {
    expect(() => render(<TerminalTabs />)).not.toThrow();
  });

  it('points to the sidebar alone while Jump to has no shortcut', () => {
    const original = useShortcutsStore.getState().getDisplayShortcut;
    useShortcutsStore.setState({ getDisplayShortcut: () => '' });
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ windowId: useWindowStore.getState().windowId })],
      hasLoaded: true,
    });
    try {
      render(<TerminalTabs />);
      expect(screen.getByText('Pick one in the sidebar.')).toBeInTheDocument();
    } finally {
      useShortcutsStore.setState({ getDisplayShortcut: original });
    }
  });

  it('offers New Workspace when there are no workspaces yet', () => {
    const onNewWorkspaceDialogChange = vi.fn();
    useWorkspacesStore.setState({ workspaces: [], hasLoaded: true });

    render(<TerminalTabs onNewWorkspaceDialogChange={onNewWorkspaceDialogChange} />);
    expect(screen.getByText('No workspaces yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New Workspace' }));

    expect(onNewWorkspaceDialogChange).toHaveBeenCalledWith(true);
  });

  // A tab sees its panes' notifications after a second on screen.
  const settle = () =>
    act(() => {
      vi.advanceTimersByTime(1000);
    });

  describe('attention on the focused pane', () => {
    const done: WorkspaceAttention = {
      kind: 'turn-complete',
      source: 'claude-code',
      updatedAt: 1,
      terminalId: 't1',
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears once the tab has been in view for a second while the user is at the computer', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      setUpWorkspace(['t1'], { attention: { t1: done } });
      render(<TerminalTabs />);
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(window.api.clearTerminalAttention).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(window.api.clearTerminalAttention).toHaveBeenCalledWith('t1');
    });

    it('stays on a tab the user passed over in under a second', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      setUpWorkspace(['t1', 't2'], { attention: { t1: done } });
      render(<TerminalTabs />);
      act(() => {
        vi.advanceTimersByTime(500);
        useLayoutStore.setState({ activeTabByWorkspace: { [WORKSPACE_ID]: 't2' } });
      });
      settle();

      expect(window.api.clearTerminalAttention).not.toHaveBeenCalled();
    });

    it('clears at once when it arrives on a tab the user has been looking at', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      setUpWorkspace(['t1']);
      render(<TerminalTabs />);
      settle();

      act(() => {
        useWorkspacesStore.getState().updateWorkspace(WORKSPACE_ID, {
          terminals: [createTerminal({ id: 't1', name: 'Tab t1', attention: done })],
        });
      });
      expect(window.api.clearTerminalAttention).toHaveBeenCalledWith('t1');
    });

    it('stays until the user is back when it arrived while they were away', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      act(() => awaitUserReturn());
      setUpWorkspace(['t1'], { attention: { t1: done } });
      render(<TerminalTabs />);
      expect(window.api.clearTerminalAttention).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      });
      settle();
      expect(window.api.clearTerminalAttention).toHaveBeenCalledWith('t1');
    });
  });

  describe('layouts of hidden workspaces', () => {
    it('keeps panes mounted only for workspaces running in this window', () => {
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws-shown', terminals: [createTerminal({ id: 't-shown' })] }),
          createWorkspace({ id: 'ws-running', terminals: [createTerminal({ id: 't-running' })] }),
          createWorkspace({
            id: 'ws-stopped',
            terminals: [createTerminal({ id: 't-stopped', status: 'stopped' })],
          }),
          createWorkspace({
            id: 'ws-elsewhere',
            windowId: 'another-window',
            terminals: [createTerminal({ id: 't-elsewhere' })],
          }),
        ],
        selectedWorkspaceId: 'ws-shown',
        hasLoaded: true,
      });

      render(<TerminalTabs />);

      expect(Object.keys(useLayoutStore.getState().tabsByWorkspace).sort()).toEqual([
        'ws-running',
        'ws-shown',
      ]);
    });

    it('keeps the panes mounted, hidden, while the Overview is open', () => {
      setUpWorkspace(['t1']);
      render(<TerminalTabs />);
      const pane = screen.getByTestId('split-t1');

      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: null, showDashboard: true }));
      expect(screen.getByTestId('split-t1')).toBe(pane);
      expect(pane).not.toBeVisible();

      act(() =>
        useWorkspacesStore.setState({ selectedWorkspaceId: WORKSPACE_ID, showDashboard: false })
      );
      expect(screen.getByTestId('split-t1')).toBe(pane);
      expect(pane).toBeVisible();
    });

    // A page in the work area used to replace the layers: every workspace's terminals were
    // parked and attached again, and its panels rebuilt, each time one came and went.
    it.each([
      {
        page: 'no workspace is selected',
        text: 'No active workspaces',
        show: () => useWorkspacesStore.setState({ selectedWorkspaceId: null }),
      },
      {
        page: 'a workspace still being set up is selected',
        text: 'Setting up workspace...',
        show: () =>
          useWorkspacesStore.setState((state) => ({
            workspaces: [
              ...state.workspaces,
              createWorkspace({ id: 'ws-new', provisioning: true }),
            ],
            selectedWorkspaceId: 'ws-new',
          })),
      },
      {
        page: 'its workspace restarts',
        text: 'Restarting workspace...',
        show: () =>
          useWorkspacesStore.setState({ restartingWorkspaceIds: new Set([WORKSPACE_ID]) }),
      },
    ])('keeps the panes mounted, hidden, while $page', ({ text, show }) => {
      setUpWorkspace(['t1']);
      render(<TerminalTabs />);
      const pane = screen.getByTestId('split-t1');

      act(show);
      expect(screen.getByText(text)).toBeVisible();
      expect(screen.getByTestId('split-t1')).toBe(pane);
      expect(pane).not.toBeVisible();
      // Out of sight like any other workspace's: its terminals stop drawing and its pane
      // shortcuts are off, as when the page had replaced it.
      expect(pane).toHaveAttribute('data-active', 'false');

      act(() =>
        useWorkspacesStore.setState({
          selectedWorkspaceId: WORKSPACE_ID,
          restartingWorkspaceIds: new Set(),
        })
      );
      expect(screen.queryByText(text)).not.toBeInTheDocument();
      expect(screen.getByTestId('split-t1')).toBe(pane);
      expect(pane).toBeVisible();
      expect(pane).toHaveAttribute('data-active', 'true');
    });

    // The sidebar draws a line along its edge over the work area, which a positioned page hid.
    it('keeps a page in the flow, where the sidebar draws its edge line over it', () => {
      setUpWorkspace(['t1']);
      const { container } = render(<TerminalTabs />);

      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: null }));

      const positioned: Element[] = [];
      for (
        let el = screen.getByText('No active workspaces').parentElement;
        el && el !== container.firstElementChild;
        el = el.parentElement
      ) {
        if (el.classList.contains('absolute')) positioned.push(el);
      }
      expect(positioned).toEqual([]);
      // The panes leave the flow instead, at the size they had.
      const panes = screen.getByTestId('split-t1').closest('.flex-col');
      expect(panes).toHaveClass('absolute', 'inset-0');
      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: WORKSPACE_ID }));
      expect(panes).not.toHaveClass('absolute');
    });

    it("keeps a page's top from dragging the window through the hidden tab bar over it", () => {
      setUpWorkspace(['t1']);
      render(<TerminalTabs />);
      const tabBar = screen.getByTestId('workspace-top-row');
      expect(tabBar).toHaveClass('drag-region');

      act(() =>
        useWorkspacesStore.setState({ restartingWorkspaceIds: new Set([WORKSPACE_ID]) })
      );
      expect(screen.getByText('Restarting workspace...')).toBeInTheDocument();

      expect(screen.getByTestId('workspace-top-row')).toBe(tabBar);
      expect(tabBar).not.toHaveClass('drag-region');
    });

    it('does not mount the panes of a workspace again after it stops', () => {
      const running = createWorkspace({
        id: 'ws-running',
        terminals: [createTerminal({ id: 't-running' })],
      });
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws-shown', terminals: [createTerminal({ id: 't-shown' })] }),
          running,
        ],
        selectedWorkspaceId: 'ws-shown',
        hasLoaded: true,
      });
      render(<TerminalTabs />);
      expect(useLayoutStore.getState().tabsByWorkspace['ws-running']).toEqual(['t-running']);

      // Stopping keeps its terminal records, and clears its layout.
      act(() => {
        useLayoutStore.getState().clearWorkspaceLayout('ws-running');
        useWorkspacesStore.getState().updateWorkspace('ws-running', {
          terminals: [createTerminal({ id: 't-running', status: 'stopped' })],
        });
      });

      expect(useLayoutStore.getState().tabsByWorkspace['ws-running']).toBeUndefined();
    });
  });

  it('shows a tab notification as a card under the tab name', () => {
    const message = 'Refactored the session store.\n\nTests pass; the staging secret is missing.';
    setUpWorkspace(['t1', 't2'], {
      attention: {
        t2: {
          kind: 'turn-complete',
          source: 'claude-code',
          updatedAt: Date.now(),
          terminalId: 't2',
          message,
        },
      },
    });
    render(<TerminalTabs />);

    const tooltip = within(getTab('Tab t2')).getByTestId('tooltip');
    expect(tooltip.textContent).toBe(`Tab t2Agent finished a turnnow${message}`);
  });

  describe('attention on a pane the user can see but has not focused', () => {
    const doneOn = (terminalId: string): WorkspaceAttention => ({
      kind: 'turn-complete',
      source: 'codex',
      updatedAt: 1,
      terminalId,
    });

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Tab t1 shows t1 (focused) and t2 side by side; t3 is a tab of its own.
    function setUpSplitTab(attention: Record<string, WorkspaceAttention>) {
      setUpWorkspace(['t1', 't2', 't3'], { attention });
      const root = createLeaf('t1');
      const layout = splitLeaf(root, root.id, 'horizontal', 't2');
      useLayoutStore.setState({
        tabsByWorkspace: { [WORKSPACE_ID]: ['t1', 't3'] },
        layoutsByTab: { [WORKSPACE_ID]: { t1: layout, t3: createLeaf('t3') } },
        focusedPaneByTab: { [WORKSPACE_ID]: { t1: root.id } },
      });
    }

    it('marks a done seen on a pane beside the focused one, not on a tab out of view', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      setUpSplitTab({ t2: doneOn('t2'), t3: doneOn('t3') });
      render(<TerminalTabs />);
      settle();

      expect(window.api.markTerminalAttentionSeen).toHaveBeenCalledWith('t2');
      expect(window.api.markTerminalAttentionSeen).not.toHaveBeenCalledWith('t3');
      expect(window.api.clearTerminalAttention).not.toHaveBeenCalledWith('t2');
    });

    it('leaves a prompt for the user to focus', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      setUpSplitTab({
        t2: { kind: 'input-required', source: 'claude-code', updatedAt: 1, terminalId: 't2' },
      });
      render(<TerminalTabs />);
      settle();

      expect(window.api.markTerminalAttentionSeen).not.toHaveBeenCalled();
    });

    it('waits for the window to be focused', () => {
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      setUpSplitTab({ t2: doneOn('t2') });
      render(<TerminalTabs />);
      settle();
      expect(window.api.markTerminalAttentionSeen).not.toHaveBeenCalled();

      hasFocus.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(window.api.markTerminalAttentionSeen).not.toHaveBeenCalled();
      settle();
      expect(window.api.markTerminalAttentionSeen).toHaveBeenCalledWith('t2');
    });

    it('does not mark a done seen again', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      setUpSplitTab({ t2: { ...doneOn('t2'), seen: true } });
      render(<TerminalTabs />);
      settle();

      expect(window.api.markTerminalAttentionSeen).not.toHaveBeenCalled();
      expect(getTab('Tab t1')).toHaveAccessibleName('Tab t1');
    });
  });

  it('renders a tab per terminal', () => {
    setUpWorkspace(['t1', 't2']);
    render(<TerminalTabs />);

    expect(getTab('Tab t1')).toBeInTheDocument();
    expect(getTab('Tab t2')).toBeInTheDocument();
  });

  describe('tab overflow', () => {
    it('keeps the new-tab and launch buttons outside the scrolling tab strip', () => {
      setUpWorkspace(['t1', 't2']);
      render(<TerminalTabs />);

      const strip = getTab('Tab t1').closest('[data-tab-id]')?.parentElement as HTMLElement;
      expect(strip).toHaveClass('overflow-x-auto');
      expect(strip).not.toContainElement(screen.getByRole('button', { name: 'New tab' }));
      expect(strip).not.toContainElement(
        screen.getByRole('button', { name: 'More quick commands' })
      );
    });

    it('scrolls a tab activated by shortcut into view', () => {
      setUpWorkspace(['t1', 't2', 't3', 't4']);
      render(<TerminalTabs />);
      const strip = getTab('Tab t1').closest('[data-tab-id]')?.parentElement as HTMLElement;
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'));
      let scrollLeft = 0;
      Object.defineProperties(strip, {
        clientWidth: { configurable: true, get: () => 200 },
        scrollWidth: { configurable: true, get: () => 400 },
        scrollLeft: {
          configurable: true,
          get: () => scrollLeft,
          set: (value: number) => {
            scrollLeft = Math.min(200, Math.max(0, value));
          },
        },
      });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this === strip) return new DOMRect(0, 0, 200, 28);
        return new DOMRect(tabs.indexOf(this) * 100 - scrollLeft, 0, 100, 28);
      });

      act(() => {
        useLayoutStore.getState().selectNextTab();
        useLayoutStore.getState().selectNextTab();
      });

      expect(scrollLeft).toBeGreaterThan(0);
    });
  });

  describe('closing tabs', () => {
    it('closes a tab on middle-click', () => {
      setUpWorkspace(['t1', 't2', 't3']);
      render(<TerminalTabs />);

      fireEvent(getTab('Tab t2'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));

      expect(mocks.closeTerminalPane.mock.calls.map(([id]) => id)).toEqual(['t2']);
    });

    it('asks before closing the only tab stops the workspace, and keeps it when cancelled', async () => {
      setUpWorkspace(['t1']);
      const confirm = vi.fn().mockResolvedValue(false);
      const unregister = registerPaneCloseConfirm(confirm);
      render(<TerminalTabs />);

      fireEvent(getTab('Tab t1'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
      await act(async () => {});

      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stop Workspace?' }));
      expect(mocks.closeTerminalPane).not.toHaveBeenCalled();

      confirm.mockResolvedValue(true);
      fireEvent(getTab('Tab t1'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
      await act(async () => {});

      expect(mocks.closeTerminalPane.mock.calls.map(([id]) => id)).toEqual(['t1']);
      unregister();
    });

    it('ignores other auxiliary buttons', () => {
      setUpWorkspace(['t1', 't2']);
      render(<TerminalTabs />);

      fireEvent(getTab('Tab t2'), new MouseEvent('auxclick', { bubbles: true, button: 2 }));

      expect(mocks.closeTerminalPane).not.toHaveBeenCalled();
    });

    it('closes the other tabs and keeps the chosen one active', () => {
      setUpWorkspace(['t1', 't2', 't3'], { activeTabId: 't1' });
      render(<TerminalTabs />);

      fireEvent.click(
        within(getTabMenu('Tab t2')).getByRole('menuitem', { name: 'Close Other Tabs' })
      );

      expect(useLayoutStore.getState().activeTabByWorkspace[WORKSPACE_ID]).toBe('t2');
      expect(mocks.closeTerminalPane.mock.calls.map(([id]) => id)).toEqual(['t1', 't3']);
    });

    it('closes the tabs to the right', () => {
      setUpWorkspace(['t1', 't2', 't3', 't4'], { activeTabId: 't4' });
      render(<TerminalTabs />);

      fireEvent.click(
        within(getTabMenu('Tab t2')).getByRole('menuitem', { name: 'Close Tabs to the Right' })
      );

      expect(useLayoutStore.getState().activeTabByWorkspace[WORKSPACE_ID]).toBe('t2');
      expect(mocks.closeTerminalPane.mock.calls.map(([id]) => id)).toEqual(['t3', 't4']);
    });

    it('keeps a tab open while a file pane in it has unsaved edits that stay', async () => {
      setUpWorkspace(['t1', 't2']);
      const fileId = 'surface:file:f1';
      const t2 = createLeaf('t2');
      useLayoutStore.setState({
        layoutsByTab: {
          [WORKSPACE_ID]: { t1: createLeaf('t1'), t2: splitLeaf(t2, t2.id, 'vertical', fileId) },
        },
      });
      usePaneSurfacesStore.setState({
        surfaces: { [fileId]: { kind: 'file', workspaceId: WORKSPACE_ID, path: 'a.ts' } },
      });
      setFilePaneDraft(fileId, 'edited');
      const confirm = vi.fn().mockResolvedValue(false);
      const unregister = registerPaneCloseConfirm(confirm);
      render(<TerminalTabs />);

      fireEvent(getTab('Tab t2'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
      await act(async () => {});

      expect(confirm).toHaveBeenCalled();
      expect(mocks.closeTerminalPane).not.toHaveBeenCalled();
      expect(usePaneSurfacesStore.getState().surfaces[fileId]).toBeDefined();

      confirm.mockResolvedValue(true);
      fireEvent(getTab('Tab t2'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
      await act(async () => {});

      expect(mocks.closeTerminalPane.mock.calls.map(([id]) => id)).toEqual(['t2']);
      expect(usePaneSurfacesStore.getState().surfaces[fileId]).toBeUndefined();
      unregister();
    });

    it('asks once before closing several tabs with unsaved edits in file panes', async () => {
      setUpWorkspace(['t1', 't2', 't3'], { activeTabId: 't1' });
      const fileIds = { t2: 'surface:file:f2', t3: 'surface:file:f3' };
      const t2 = createLeaf('t2');
      const t3 = createLeaf('t3');
      useLayoutStore.setState({
        layoutsByTab: {
          [WORKSPACE_ID]: {
            t1: createLeaf('t1'),
            t2: splitLeaf(t2, t2.id, 'vertical', fileIds.t2),
            t3: splitLeaf(t3, t3.id, 'vertical', fileIds.t3),
          },
        },
      });
      usePaneSurfacesStore.setState({
        surfaces: {
          [fileIds.t2]: { kind: 'file', workspaceId: WORKSPACE_ID, path: 'a.ts' },
          [fileIds.t3]: { kind: 'file', workspaceId: WORKSPACE_ID, path: 'b.ts' },
        },
      });
      setFilePaneDraft(fileIds.t2, 'edited');
      setFilePaneDraft(fileIds.t3, 'edited');
      const confirm = vi.fn().mockResolvedValue(true);
      const unregister = registerPaneCloseConfirm(confirm);
      render(<TerminalTabs />);

      fireEvent.click(
        within(getTabMenu('Tab t1')).getByRole('menuitem', { name: 'Close Other Tabs' })
      );
      await act(async () => {});

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0].description).toBe(
        'a.ts, b.ts have unsaved changes. Discard them?'
      );
      expect(mocks.closeTerminalPane.mock.calls.map(([id]) => id)).toEqual(['t2', 't3']);
      expect(usePaneSurfacesStore.getState().surfaces).toEqual({});
      unregister();
    });

    it('disables bulk close items that have nothing to close', () => {
      setUpWorkspace(['t1', 't2']);
      render(<TerminalTabs />);

      expect(
        within(getTabMenu('Tab t2')).getByRole('menuitem', { name: 'Close Tabs to the Right' })
      ).toBeDisabled();
      expect(
        within(getTabMenu('Tab t2')).getByRole('menuitem', { name: 'Close Other Tabs' })
      ).toBeEnabled();
    });

    it('disables Close Other Tabs when there is only one tab', () => {
      setUpWorkspace(['t1']);
      render(<TerminalTabs />);

      expect(
        within(getTabMenu('Tab t1')).getByRole('menuitem', { name: 'Close Other Tabs' })
      ).toBeDisabled();
    });
  });

  it('opens a new terminal tab from the New tab menu', async () => {
    setUpWorkspace(['t1']);
    const addTerminal = vi.fn().mockResolvedValue(createTerminal({ id: 't-new' }));
    useWorkspacesStore.setState({ addTerminal });
    render(<TerminalTabs />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    });

    expect(addTerminal).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(useLayoutStore.getState().tabsByWorkspace[WORKSPACE_ID]).toEqual(['t1', 't-new']);
  });

  it('says why the New tab menu could not open a terminal', async () => {
    setUpWorkspace(['t1']);
    useToastStore.setState({ toasts: [] });
    useWorkspacesStore.setState({
      addTerminal: vi
        .fn()
        .mockRejectedValue(
          new Error("Error invoking remote method 'terminal:add': Error: spawn zsh ENOENT")
        ),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<TerminalTabs />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    });

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Failed to open a terminal: spawn zsh ENOENT',
    ]);
  });

  it('says why splitting from the tab menu failed', async () => {
    setUpWorkspace(['t1']);
    useToastStore.setState({ toasts: [] });
    useWorkspacesStore.setState({
      addTerminal: vi.fn().mockRejectedValue(new Error('workspace limit')),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<TerminalTabs />);

    await act(async () => {
      fireEvent.click(within(getTabMenu('Tab t1')).getByRole('menuitem', { name: 'Split Right' }));
    });

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Failed to split the pane: workspace limit',
    ]);
  });

  describe('splitting from the tab menu', () => {
    it.each([
      ['Split Right', 'vertical'],
      ['Split Down', 'horizontal'],
    ] as const)('%s splits the pane %s', async (item, direction) => {
      setUpWorkspace(['t1']);
      const splitPane = vi.fn();
      useLayoutStore.setState({ splitPane });
      useWorkspacesStore.setState({
        addTerminal: vi.fn().mockResolvedValue(createTerminal({ id: 't-new' })),
      });
      render(<TerminalTabs />);

      await act(async () => {
        fireEvent.click(within(getTabMenu('Tab t1')).getByRole('menuitem', { name: item }));
      });

      expect(splitPane).toHaveBeenCalledWith(direction, 't-new');
    });
  });

  describe('titling a split tab', () => {
    // Tab t1 holds panes for terminals t1 (the workspace's primary terminal) and t2.
    function setUpSplitTab() {
      setUpWorkspace(['t1', 't2']);
      const root = createLeaf('t1');
      const layout = splitLeaf(root, root.id, 'horizontal', 't2');
      const [left, right] = getAllLeaves(layout);
      useLayoutStore.setState({
        tabsByWorkspace: { [WORKSPACE_ID]: ['t1'] },
        layoutsByTab: { [WORKSPACE_ID]: { t1: layout } },
        focusedPaneByTab: { [WORKSPACE_ID]: { t1: right.id } },
      });
      return { left, right };
    }

    it('titles the tab after its last focused pane, over the primary terminal', () => {
      const { left } = setUpSplitTab();
      render(<TerminalTabs />);

      expect(getTab('Tab t2')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Tab t1/ })).not.toBeInTheDocument();

      act(() => useLayoutStore.getState().setFocusedPane(left.id));
      expect(getTab('Tab t1')).toBeInTheDocument();
    });
  });

  it('marks a tab with an icon for each kind of browser or note pane in it', () => {
    setUpWorkspace(['t1', 't2', 't3']);
    // t1 holds a terminal, a note and a browser; t2 only a terminal; t3 a terminal and a note.
    const t1 = createLeaf('t1');
    const t1WithNote = splitLeaf(t1, t1.id, 'vertical', 'surface:note:n1');
    const t1Layout = splitLeaf(t1WithNote, t1.id, 'horizontal', 'surface:browser:b1');
    const t3 = createLeaf('t3');
    useLayoutStore.setState({
      layoutsByTab: {
        [WORKSPACE_ID]: {
          t1: t1Layout,
          t2: createLeaf('t2'),
          t3: splitLeaf(t3, t3.id, 'vertical', 'surface:note:n2'),
        },
      },
      focusedPaneByTab: { [WORKSPACE_ID]: { t1: t1.id, t3: t3.id } },
    });
    render(<TerminalTabs />);

    const kindsOf = (name: string) =>
      Array.from(getTab(name).querySelectorAll('[data-tab-surface]')).map((icon) =>
        icon.getAttribute('data-tab-surface')
      );
    expect(kindsOf('Tab t1')).toEqual(['browser', 'note']);
    expect(kindsOf('Tab t2')).toEqual([]);
    expect(kindsOf('Tab t3')).toEqual(['note']);
  });

  it('marks the active tab as a pill on the chrome, apart from the panes below', () => {
    setUpWorkspace(['t1', 't2'], { activeTabId: 't2' });
    const { rerender } = render(<TerminalTabs />);

    expect(getTab('Tab t2')).toHaveAttribute('data-active', 'true');
    expect(getTab('Tab t2')).toHaveClass('rounded-md', 'bg-foreground/[0.075]');
    expect(getTab('Tab t1')).not.toHaveAttribute('data-active');
    expect(getTab('Tab t1')).not.toHaveClass('bg-foreground/[0.075]');

    act(() => useLayoutStore.setState({ activeTabByWorkspace: { [WORKSPACE_ID]: 't1' } }));
    rerender(<TerminalTabs />);
    expect(getTab('Tab t1')).toHaveAttribute('data-active', 'true');
    // Not joined to the panes any more: no outline open at its bottom.
    expect(getTab('Tab t1')).not.toHaveClass('joined-tab');
  });

  describe('moving a single-pane tab', () => {
    it('moves the pane into another tab from the tab menu', () => {
      setUpWorkspace(['t1', 't2', 't3'], { activeTabId: 't3' });
      render(<TerminalTabs />);

      fireEvent.click(within(getTabMenu('Tab t1')).getByRole('menuitem', { name: 'Tab t2' }));

      const layout = useLayoutStore.getState();
      expect(layout.tabsByWorkspace[WORKSPACE_ID]).toEqual(['t2', 't3']);
      expect(layout.activeTabByWorkspace[WORKSPACE_ID]).toBe('t2');
      expect(layout.layoutsByTab[WORKSPACE_ID].t2.type).toBe('split');
    });

    it('lists only the other tabs as destinations', () => {
      setUpWorkspace(['t1', 't2']);
      render(<TerminalTabs />);

      const menu = getTabMenu('Tab t1');
      expect(within(menu).getByText('Move to Tab')).toBeInTheDocument();
      expect(within(menu).queryByRole('menuitem', { name: 'Tab t1' })).not.toBeInTheDocument();
    });
  });

  describe('full-screen preview', () => {
    function openFullscreenPreview() {
      useFileViewerStore.setState({
        inlineFilePreviewByWorkspace: {
          [WORKSPACE_ID]: { open: true, mode: 'browse', filePath: 'src/a.ts', layout: 'full' },
        },
      });
    }

    it('marks Split when a hidden tab needs input', () => {
      setUpWorkspace(['t1', 't2'], {
        attention: { t2: { kind: 'input-required' } as WorkspaceAttention },
      });
      openFullscreenPreview();
      render(<TerminalTabs />);

      expect(screen.queryByRole('button', { name: /^Tab t2/ })).not.toBeInTheDocument();
      expect(
        screen.getByRole('radio', { name: 'Beside — Agent needs your input' })
      ).toBeInTheDocument();
    });

    it('leaves Beside unmarked without pending input', () => {
      setUpWorkspace(['t1', 't2'], {
        attention: { t2: { kind: 'turn-complete' } as WorkspaceAttention },
      });
      openFullscreenPreview();
      render(<TerminalTabs />);

      expect(screen.getByRole('radio', { name: 'Beside' })).toBeInTheDocument();
    });

    it.each([
      { comparison: 'no branch', branch: null, useMergeBase: false },
      { comparison: 'a branch', branch: 'main', useMergeBase: false },
      { comparison: 'a branch’s merge base', branch: 'main', useMergeBase: true },
    ])(
      'shows the open diff file’s line stats when the file tree compares to $comparison',
      async ({ branch, useMergeBase }) => {
        setUpWorkspace(['t1']);
        useFileViewerStore.setState({
          inlineFilePreviewByWorkspace: {
            [WORKSPACE_ID]: { open: true, mode: 'diff', filePath: 'src/a.ts', layout: 'full' },
          },
        });
        useFileViewerStore
          .getState()
          .setInlineFileTreeComparisonBranch(WORKSPACE_ID, branch, useMergeBase);
        const diff = {
          files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }],
          summary: { additions: 3, deletions: 1, filesChanged: 1 },
        };
        window.api.getWorkspaceDiff = vi.fn().mockResolvedValue(diff);
        window.api.getWorkspaceDiffAgainstBranch = vi.fn().mockResolvedValue(diff);
        // Load the diff the way the inline file tree does.
        await useFileListStore.getState().fetchDiff('/repo', branch, useMergeBase, WORKSPACE_ID);
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
        render(<TerminalTabs />);

        const stats = screen
          .getAllByLabelText('3 additions, 1 deletions')
          .filter((el) => !el.closest('[aria-hidden]'));
        expect(stats).toHaveLength(1);
      }
    );
  });

  describe('file panel open state', () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    });

    it('stays closed for a workspace with no saved state, as new workspaces start', () => {
      setUpWorkspace(['t1']);
      render(<TerminalTabs />);

      expect(
        screen.queryByRole('separator', { name: 'Resize file tree panel' })
      ).not.toBeInTheDocument();
    });

    it('shows the sidebar panel a workspace was saved showing', () => {
      setUpWorkspace(['t1'], { fileTreeOpen: true, sidebarPanelId: 'checks' });
      render(<TerminalTabs />);

      expect(useFileViewerStore.getState().inlineSidebarPanelByWorkspace[WORKSPACE_ID]).toEqual({
        id: 'checks',
        shown: true,
      });
    });

    it('restores the saved view without saving it again', () => {
      const updateWorkspace = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('api', { ...window.api, updateWorkspace });
      setUpWorkspace(['t1'], { fileTreeOpen: true, fileTreeMode: 'browse' });
      render(<TerminalTabs />);

      expect(useFileViewerStore.getState().inlineFileTreeByWorkspace[WORKSPACE_ID]?.mode).toBe(
        'browse'
      );
      expect(updateWorkspace).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('restores a workspace saved with only its panel once, closed', () => {
      setUpWorkspace(['t1'], { sidebarPanelId: 'checks' });
      render(<TerminalTabs />);

      expect(useFileViewerStore.getState().inlineFileTreeByWorkspace[WORKSPACE_ID]?.open).toBe(
        false
      );
    });

    it('opens for a workspace saved with it open', () => {
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      expect(screen.getByRole('separator', { name: 'Resize file tree panel' })).toBeInTheDocument();
    });
  });

  describe('file panel tabs', () => {
    afterEach(() => {
      (window.api as { platform: string }).platform = 'linux';
      vi.unstubAllGlobals();
    });

    it("on darwin, sits in the panel's header in the top row", () => {
      (window.api as { platform: string }).platform = 'darwin';
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      const header = screen.getByTestId('file-panel-header');
      expect(screen.getByTestId('workspace-top-row')).toContainElement(header);
      expect(header).toContainElement(screen.getByTitle('Show all files'));
    });

    // The window controls share the top row's corner there, so the tabs get the panel's width.
    it.each(['linux', 'win32'] as const)(
      'on %s, sits at the top of the panel, below the top row',
      (platform) => {
        (window.api as { platform: string }).platform = platform;
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
        setUpWorkspace(['t1'], { fileTreeOpen: true });
        render(<TerminalTabs />);

        const tabs = screen.getByTestId('file-panel-tabs');
        expect(tabs).toContainElement(screen.getByTitle('Show all files'));
        expect(screen.getByTestId('workspace-top-row')).not.toContainElement(tabs);
        expect(screen.queryByTestId('file-panel-header')).not.toBeInTheDocument();
      }
    );

    it('puts the browser button beside the panel toggle, in the panel header', () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      const browser = screen.getByRole('button', { name: 'Open in default browser' });
      expect(screen.getByTestId('terminal-tab-row')).not.toContainElement(browser);
      expect(browser.parentElement).toContainElement(
        screen.getByRole('button', { name: 'Toggle file panel' })
      );
    });

    it.each(['darwin', 'linux'] as const)('on %s, underlines the view that shows', (platform) => {
      (window.api as { platform: string }).platform = platform;
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      const view = screen.getByLabelText('File panel view');
      const underline = 'shadow-[inset_0_-2px_0_oklch(var(--foreground)/0.75)]';
      expect(within(view).getByRole('button', { name: 'Diff' })).toHaveClass(underline);
      expect(within(view).getByRole('button', { name: 'Files' })).not.toHaveClass(underline);
    });

    it.each([
      // The tabs share the panel's header with the corner buttons: 90 + 24 + 100 + 8.
      ['darwin', '222'],
      // The tabs, 90 + 24 + 8, are narrower than the panel's own minimum.
      ['linux', '150'],
      ['win32', '150'],
    ] as const)('on %s, keeps the file panel wide enough for its tabs', (platform, minWidth) => {
      (window.api as { platform: string }).platform = platform;
      // The Diff/Files tabs measure 90px, the caret 24px, the corner buttons 100px, and the header
      // keeps 8px of padding and sliver.
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ) {
        const inMeasureRow = this.parentElement?.getAttribute('aria-hidden') === 'true';
        const width = (this as HTMLElement).dataset.measureView ? 45 : inMeasureRow ? 24 : 0;
        return {
          width,
          height: 0,
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: width,
          bottom: 0,
        } as DOMRect;
      });
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(private readonly callback: ResizeObserverCallback) {}
          observe(element: Element) {
            const width = element.querySelector(':scope > [aria-label="Toggle file panel"]')
              ? 100
              : 0;
            this.callback(
              [{ contentRect: { width } } as ResizeObserverEntry],
              this as unknown as ResizeObserver
            );
          }
          disconnect() {}
        }
      );
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      const handle = screen.getByRole('separator', { name: 'Resize file tree panel' });
      expect(handle).toHaveAttribute('aria-valuemin', minWidth);
    });

    it("collapses the file panel's header to nothing until the work area is measured", () => {
      (window.api as { platform: string }).platform = 'darwin';
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0);
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      // Its padding and line would otherwise keep a sliver with a line at its end.
      const header = screen.getByTestId('file-panel-header');
      expect(header.style.width).toBe('0px');
      expect(header).not.toHaveClass('border-l');
      expect(header).not.toHaveClass('pl-1.5');
    });

    it.each([
      // The corner buttons sit in the panel's header, so the tab row keeps no room for them.
      ['darwin', '0px'],
      // The tab row runs on over the panel, and keeps room for the corner buttons: 100 + 8.
      ['linux', '108px'],
    ] as const)(
      'on %s, keeps room at the end of the terminal tab row for the corner buttons where needed',
      (platform, paddingRight) => {
        (window.api as { platform: string }).platform = platform;
        // The corner buttons measure 100px.
        vi.stubGlobal(
          'ResizeObserver',
          class {
            constructor(private readonly callback: ResizeObserverCallback) {}
            observe(element: Element) {
              const width = element.querySelector(':scope > [aria-label="Toggle file panel"]')
                ? 100
                : 0;
              this.callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver
              );
            }
            disconnect() {}
          }
        );
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
        setUpWorkspace(['t1'], { fileTreeOpen: true });
        render(<TerminalTabs />);

        expect(screen.getByTestId('terminal-tab-row')).toHaveStyle({ paddingRight });
      }
    );
  });

  describe('inline panel resize handles', () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    });

    it('resizes the file tree from the keyboard and resets it on double-click', () => {
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      const handle = screen.getByRole('separator', { name: 'Resize file tree panel' });
      expect(handle).toHaveAttribute('aria-valuenow', '220');

      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(useFileViewerStore.getState().inlineFileTreeWidthByWorkspace[WORKSPACE_ID]).toBe(
        0.236
      );
      expect(handle).toHaveAttribute('aria-valuenow', '236');

      fireEvent.doubleClick(handle);
      expect(useFileViewerStore.getState().inlineFileTreeWidthByWorkspace[WORKSPACE_ID]).toBe(0.22);
    });

    it("lets a drag's mouse events past frames while it lasts, so letting go over a panel's page ends it", () => {
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      render(<TerminalTabs />);

      const handle = screen.getByRole('separator', { name: 'Resize file tree panel' });
      fireEvent.mouseDown(handle, { clientX: 780 });
      expect(document.body).toHaveAttribute('data-panel-resizing');
      fireEvent.mouseUp(window);
      expect(document.body).not.toHaveAttribute('data-panel-resizing');
    });

    it('resizes a side-by-side preview from the keyboard', () => {
      setUpWorkspace(['t1'], { fileTreeOpen: true });
      useFileViewerStore.setState({
        inlineFilePreviewByWorkspace: {
          [WORKSPACE_ID]: {
            open: true,
            mode: 'browse',
            filePath: 'src/a.ts',
            layout: 'side-by-side',
          },
        },
      });
      render(<TerminalTabs />);

      // 1000px minus the 220px tree leaves 780px; half of it is the default.
      const handle = screen.getByRole('separator', { name: 'Resize inline file preview' });
      expect(handle).toHaveAttribute('aria-valuenow', '390');

      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(
        useFileViewerStore.getState().inlineFilePreviewWidthByWorkspace[WORKSPACE_ID]
      ).toBeCloseTo(374 / 780);

      fireEvent.keyDown(handle, { key: 'Home' });
      expect(useFileViewerStore.getState().inlineFilePreviewWidthByWorkspace[WORKSPACE_ID]).toBe(
        0.5
      );
    });
  });
});
