/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPane } from '../../../../src/renderer/components/terminal/TerminalPane';
import { SplitPaneMenuItems } from '../../../../src/renderer/components/terminal/surfaces/SplitPaneMenuItems';
import { PANE_DRAG_MIME, TAB_PANE_DRAG_MIME } from '../../../../src/renderer/lib/pane-drag';
import {
  openBrowserPane,
  openInBrowserPane,
  splitAgentBesidePane,
} from '../../../../src/renderer/lib/pane-surfaces';
import { replaceTerminalWithPaneSurface } from '../../../../src/renderer/lib/replace-terminal';
import {
  focusTerminalRenderer,
  pasteIntoTerminalRenderer,
} from '../../../../src/renderer/lib/terminal-renderer-runtime';
import { useActionEditorStore } from '../../../../src/renderer/stores/action-editor.store';
import { useDevServerPreviewStore } from '../../../../src/renderer/stores/dev-server-preview.store';
import {
  setLocalMirrorSyncStatus,
  useLocalMirrorSyncStore,
} from '../../../../src/renderer/stores/local-mirror-sync.store';
import {
  claimTerminal,
  useTerminalBusyStore,
} from '../../../../src/renderer/stores/terminal-busy.store';
import { flashPanes } from '../../../../src/renderer/stores/pane-flash.store';
import { useTerminalCloseStore } from '../../../../src/renderer/stores/terminal-close.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';

const mocks = vi.hoisted(() => ({
  launchAction: vi.fn(),
  addTerminal: vi.fn(),
  addTerminalCommand: vi.fn(),
  requestExecutionLocation: vi.fn(),
  restartTerminal: vi.fn(),
  reconnectSshTerminal: vi.fn(),
  reconnectAllSshTerminals: vi.fn(),
  setPaneDefaultAction: vi.fn(),
  reconnectingSshWorkspaceIds: new Set<string>(),
  setFocusedPane: vi.fn(),
  splitPane: vi.fn(),
  addTab: vi.fn(),
  setActiveTab: vi.fn(),
  executeShortcutAction: vi.fn(),
  refreshTerminalRenderer: vi.fn(),
  pasteClipboardIntoTerminal: vi.fn(),
  showItemInFolder: vi.fn(),
  retryLocalMirrorSync: vi.fn(() => Promise.resolve()),
  copyToClipboard: vi.fn(),
  submenuKeyDown: vi.fn(),
  terminalHost: null as { hostname: string; isLocal: boolean } | null,
  supportsLocalCopy: false,
  sshHosts: [] as Array<{ id: string; name: string; hostname: string; user?: string }>,
  terminalViewProps: null as Record<string, unknown> | null,
  actions: [] as Array<{
    id: string;
    title: string;
    type: 'command' | 'prompt';
    content: string;
    lastUsedAt?: number;
  }>,
  presets: [] as Array<{
    id: string;
    name: string;
    openCommand: string;
    continueCommand: string;
    promptCommand: string;
    launchModes: never[];
    isBuiltin: boolean;
  }>,
  activePresets: [] as Array<{ presetId: string; lastUsedAt: number }>,
  terminalConfig: null as { colors: { background: string }; showPaneHeaders?: boolean } | null,
  tabIds: ['tab-1'],
  moveTabToEdge: vi.fn(),
  layoutsByTab: {} as Record<string, Record<string, unknown>>,
}));

const workspace = {
  id: 'workspace-1',
  name: 'Remote workspace',
  workingDirectory: 'ssh://host-1/home/user/workspace',
  backend: {
    kind: 'ssh',
    hostId: 'host-1',
    remoteDirectory: '/home/user/workspace',
  },
  terminals: [
    {
      id: 'terminal-1',
      name: 'Terminal',
      status: 'stopped',
      executionLocation: 'workspace',
      remoteSessionActive: false,
    },
  ],
};

const workspaceStoreState = {
  selectedWorkspaceId: 'workspace-1',
  workspaces: [workspace],
};

vi.mock('../../../../src/renderer/components/terminal/TerminalView', () => ({
  pasteClipboardIntoTerminal: mocks.pasteClipboardIntoTerminal,
  TerminalView: (props: Record<string, unknown>) => {
    mocks.terminalViewProps = props;
    return <div data-testid="terminal-view" />;
  },
}));

vi.mock('../../../../src/renderer/components/ui/context-menu', () => ({
  ContextMenu: ({
    children,
    open,
    onOpenChange,
  }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) => (
    <div
      data-testid="context-menu"
      data-open={String(!!open)}
      onContextMenu={() => onOpenChange?.(true)}
    >
      {children}
    </div>
  ),
  ContextMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
  }: React.PropsWithChildren<{ disabled?: boolean; onSelect?: () => void }>) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuLabel: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuSub: ({ children }: React.PropsWithChildren) => <>{children}</>,
  // Stands in for Radix's own handler, which closes the submenu on ArrowLeft.
  ContextMenuSubContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="context-submenu" onKeyDown={(event) => mocks.submenuKeyDown(event.key)}>
      {children}
    </div>
  ),
  ContextMenuSubTrigger: ({
    children,
    disabled,
  }: React.PropsWithChildren<{ disabled?: boolean }>) =>
    children ? <span aria-disabled={disabled}>{children}</span> : null,
  ContextMenuSeparator: () => null,
  ContextMenuShortcut: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

// The mocked menu renders each submenu right after its trigger, or after a split row's trigger row.
function submenuOf(trigger: HTMLElement): HTMLElement {
  const row = trigger.tagName === 'BUTTON' ? trigger.parentElement! : trigger.closest('span')!;
  return row.nextElementSibling as HTMLElement;
}

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock('../../../../src/renderer/hooks/useShortcuts', () => ({
  useShortcutDisplay: () => '',
}));

vi.mock('../../../../src/renderer/lib/terminal-host-tracker', () => ({
  useTerminalHost: () => mocks.terminalHost,
}));

vi.mock('../../../../src/renderer/lib/pane-surfaces', () => ({
  openBrowserPane: vi.fn(),
  openInBrowserPane: vi.fn(),
  openNewNotePane: vi.fn(),
  splitAgentBesidePane: vi.fn(),
}));
vi.mock('../../../../src/renderer/lib/action-launch', () => ({
  launchAction: mocks.launchAction,
}));
vi.mock('../../../../src/renderer/lib/replace-terminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/renderer/lib/replace-terminal')>()),
  replaceTerminalWithPaneSurface: vi.fn(),
}));
vi.mock('../../../../src/renderer/lib/shortcut-actions', () => ({
  executeShortcutAction: mocks.executeShortcutAction,
}));

vi.mock('../../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  getTerminalRendererDimensions: () => ({ cols: 120, rows: 30 }),
  getTerminalRendererSelection: () => '',
  pasteIntoTerminalRenderer: vi.fn(),
  focusTerminalRenderer: vi.fn(),
  refreshTerminalRenderer: mocks.refreshTerminalRenderer,
}));

vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (
    selector: (state: {
      actions: typeof mocks.actions;
      loadActions: () => void;
      recordActionUsage: () => void;
    }) => unknown
  ) =>
    selector({
      actions: mocks.actions,
      loadActions: vi.fn(),
      recordActionUsage: vi.fn(),
    }),
}));

vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: Object.assign(
    (
      selector: (state: {
        presets: typeof mocks.presets;
        activePresets: typeof mocks.activePresets;
        loadPresets: () => void;
      }) => unknown
    ) =>
      selector({
        presets: mocks.presets,
        activePresets: mocks.activePresets,
        loadPresets: vi.fn(),
      }),
    { getState: () => ({ setActivePreset: vi.fn() }) }
  ),
}));

vi.mock('../../../../src/renderer/stores/config.store', () => {
  const state = { config: null };
  const useConfigStore = (selector: (state: typeof state) => unknown) => selector(state);
  useConfigStore.getState = () => state;
  return { useConfigStore };
});

vi.mock('../../../../src/renderer/stores/customization.store', () => ({
  useCustomizationStore: (selector: (state: { terminalConfig: unknown }) => unknown) =>
    selector({ terminalConfig: mocks.terminalConfig }),
}));

vi.mock('../../../../src/renderer/stores/git-status.store', () => ({
  useGitStatusStore: (selector: (state: { getStatus: () => undefined }) => unknown) =>
    selector({ getStatus: () => undefined }),
}));

vi.mock('../../../../src/renderer/stores/layout.store', () => {
  const getState = () => ({
    currentWorkspaceId: 'workspace-1',
    activeTabByWorkspace: { 'workspace-1': 'tab-1' },
    tabsByWorkspace: { 'workspace-1': mocks.tabIds },
    focusedPaneByTab: { 'workspace-1': { 'tab-1': 'pane-1' } },
    setFocusedPane: mocks.setFocusedPane,
    splitPane: mocks.splitPane,
    addTab: mocks.addTab,
    setActiveTab: mocks.setActiveTab,
    swapPanes: vi.fn(),
    movePaneToEdge: vi.fn(),
    moveTabToEdge: mocks.moveTabToEdge,
    layoutsByTab: mocks.layoutsByTab,
  });
  const useLayoutStore = (
    selector: (state: {
      currentWorkspaceId: string;
      activeTabByWorkspace: Record<string, string>;
      tabsByWorkspace: Record<string, string[]>;
      focusedPaneByTab: Record<string, Record<string, string>>;
      setFocusedPane: () => void;
      splitPane: () => void;
      swapPanes: () => void;
      movePaneToEdge: () => void;
      moveTabToEdge: () => void;
    }) => unknown
  ) => selector(getState());
  useLayoutStore.getState = getState;
  return { useLayoutStore };
});

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: { projects: never[] }) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock('../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: (selector: (state: { hosts: typeof mocks.sshHosts }) => unknown) =>
    selector({ hosts: mocks.sshHosts }),
}));

vi.mock('../../../../src/renderer/stores/ssh-command-execution-location.store', () => ({
  useSshCommandExecutionLocationStore: {
    getState: () => ({ requestExecutionLocation: mocks.requestExecutionLocation }),
  },
  supportsLocalCopy: () => mocks.supportsLocalCopy,
}));

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(
    (
      selector: (state: {
        selectedWorkspaceId: string;
        workspaces: (typeof workspace)[];
        addTerminal: () => void;
        addTerminalCommand: () => void;
        setTerminalDynamicTitle: () => void;
        setPrimaryTerminal: () => void;
        restartTerminal: typeof mocks.restartTerminal;
        reconnectSshTerminal: typeof mocks.reconnectSshTerminal;
        reconnectAllSshTerminals: typeof mocks.reconnectAllSshTerminals;
        setPaneDefaultAction: typeof mocks.setPaneDefaultAction;
        reconnectingSshWorkspaceIds: Set<string>;
      }) => unknown
    ) =>
      selector({
        selectedWorkspaceId: workspaceStoreState.selectedWorkspaceId,
        workspaces: workspaceStoreState.workspaces,
        addTerminal: mocks.addTerminal,
        addTerminalCommand: mocks.addTerminalCommand,
        setTerminalDynamicTitle: vi.fn(),
        setPrimaryTerminal: vi.fn(),
        restartTerminal: mocks.restartTerminal,
        reconnectSshTerminal: mocks.reconnectSshTerminal,
        reconnectAllSshTerminals: mocks.reconnectAllSshTerminals,
        setPaneDefaultAction: mocks.setPaneDefaultAction,
        reconnectingSshWorkspaceIds: mocks.reconnectingSshWorkspaceIds,
      }),
    { getState: () => ({ ...workspaceStoreState, restartTerminal: mocks.restartTerminal }) }
  ),
}));

describe('TerminalPane SSH reconnect', () => {
  beforeEach(() => {
    workspaceStoreState.selectedWorkspaceId = 'workspace-1';
    workspaceStoreState.workspaces = [workspace];
    workspace.backend.kind = 'ssh';
    workspace.workingDirectory = 'ssh://host-1/home/user/workspace';
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: false,
      },
    ];
    mocks.launchAction.mockReset().mockResolvedValue('launched');
    mocks.addTerminal.mockReset();
    mocks.addTerminalCommand.mockReset();
    mocks.addTab.mockReset();
    mocks.setActiveTab.mockReset();
    mocks.splitPane.mockReset();
    mocks.requestExecutionLocation.mockReset().mockResolvedValue('remote');
    mocks.restartTerminal.mockReset();
    mocks.reconnectSshTerminal.mockReset();
    mocks.reconnectAllSshTerminals.mockReset();
    mocks.setPaneDefaultAction.mockReset();
    mocks.reconnectingSshWorkspaceIds.clear();
    mocks.setFocusedPane.mockReset();
    mocks.moveTabToEdge.mockReset();
    mocks.layoutsByTab = {};
    mocks.executeShortcutAction.mockReset();
    mocks.refreshTerminalRenderer.mockReset();
    mocks.pasteClipboardIntoTerminal.mockReset();
    mocks.showItemInFolder.mockReset();
    mocks.copyToClipboard.mockReset();
    mocks.terminalHost = null;
    mocks.terminalConfig = null;
    mocks.tabIds = ['tab-1'];
    mocks.supportsLocalCopy = false;
    mocks.sshHosts = [];
    mocks.terminalViewProps = null;
    mocks.actions.length = 0;
    mocks.presets.length = 0;
    mocks.activePresets.length = 0;
    useTerminalCloseStore.setState(useTerminalCloseStore.getInitialState(), true);
    useTerminalBusyStore.setState(useTerminalBusyStore.getInitialState(), true);
    useToastStore.setState(useToastStore.getInitialState(), true);
    useLocalMirrorSyncStore.setState(useLocalMirrorSyncStore.getInitialState(), true);
    useDevServerPreviewStore.setState(useDevServerPreviewStore.getInitialState(), true);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: 'linux',
        showItemInFolder: mocks.showItemInFolder,
        retryLocalMirrorSync: mocks.retryLocalMirrorSync,
        copyToClipboard: mocks.copyToClipboard,
      },
    });
  });

  it('shows local copy sync progress in the pane header without covering the terminal', () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Local copy',
        status: 'running',
        executionLocation: 'local-mirror',
        remoteSessionActive: false,
      },
    ];
    setLocalMirrorSyncStatus({ workspaceId: 'workspace-1', state: 'syncing' });

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByRole('status', { name: 'Syncing local copy' })).toBeInTheDocument();
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
    expect(screen.queryByText('Updating local copy…')).not.toBeInTheDocument();
  });

  it('labels SSH local-copy terminals as read-only without crowding narrow pane controls', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: true };
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Local copy',
        status: 'running',
        executionLocation: 'local-mirror',
        remoteSessionActive: false,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const badgeLabel = screen.getByText('Local copy · Read-only');
    const badge = badgeLabel.parentElement;

    expect(badgeLabel).toHaveClass('truncate');
    expect(badge).toHaveClass('min-w-0', 'overflow-hidden');
    expect(badge?.parentElement).toHaveClass('min-w-0', 'flex-1', 'overflow-hidden');
    expect(screen.getByRole('button', { name: 'Close terminal pane' }).parentElement).toHaveClass(
      'shrink-0'
    );
  });

  it('drops the header of a lone pane and shows its status in the corner tab instead', () => {
    // Even with pane headers on: a lone pane's split and close live in the tab's menu.
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: true };
    const { unmount } = render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
        isOnlyPane
      />
    );
    expect(screen.queryByRole('button', { name: 'Split terminal right' })).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();

    unmount();
    mocks.terminalHost = { hostname: 'devbox', isLocal: false };
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
        isOnlyPane
      />
    );
    expect(screen.queryByRole('button', { name: 'Split terminal right' })).not.toBeInTheDocument();
    expect(screen.getByTestId('pane-status-strip')).toBeInTheDocument();
    // The workspace's only tab, so the pane has nowhere to be dragged.
    expect(screen.queryByTestId('pane-drag-grip')).not.toBeInTheDocument();
  });

  it('draws the pane header on the terminal background so it does not band the pane', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: true };

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByTitle('Drag to move this pane')).toHaveStyle({
      backgroundColor: 'rgb(40, 44, 52)',
    });
    expect(screen.queryByTestId('pane-drag-grip')).not.toBeInTheDocument();
  });

  it('flashes once when a jump lands on its agent', () => {
    const { container } = render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );
    expect(container.querySelector('.pane-flash')).toBeNull();

    act(() => flashPanes(['terminal-2']));
    expect(container.querySelector('.pane-flash')).toBeNull();

    act(() => flashPanes(['terminal-1']));
    expect(container.querySelector('.pane-flash')).toHaveAttribute('aria-hidden', 'true');
  });

  it('hides split pane headers when pane headers are turned off', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.queryByRole('button', { name: 'Split terminal right' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pane-status-strip')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
  });

  it('moves a split pane by its grip when pane headers are turned off', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const grip = screen.getByTestId('pane-drag-grip');
    expect(grip).toHaveAttribute('title', 'Drag to move this pane');
    const setData = vi.fn();
    fireEvent.dragStart(grip, { dataTransfer: { setData } });
    fireEvent.dragEnd(grip);
    expect(setData).toHaveBeenCalledWith(PANE_DRAG_MIME, 'pane-1');
  });

  it('moves a lone pane by its grip, so it can be dragged into another tab', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };
    mocks.tabIds = ['tab-1', 'tab-2'];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
        isOnlyPane
      />
    );

    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId('pane-drag-grip'), { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(PANE_DRAG_MIME, 'pane-1');
  });

  it('shows the grip only once the pointer nears the top of the pane', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const grip = screen.getByTestId('pane-drag-grip');
    const terminalView = screen.getByTestId('terminal-view');
    fireEvent.mouseMove(terminalView, { clientY: 200 });
    expect(grip).toHaveClass('opacity-0', 'pointer-events-none');

    // A couple of rows down already counts, so the grip shows before the pointer reaches the edge.
    fireEvent.mouseMove(terminalView, { clientY: 40 });
    expect(grip).not.toHaveClass('opacity-0');
    expect(grip).not.toHaveClass('pointer-events-none');

    fireEvent.mouseMove(terminalView, { clientY: 200 });
    expect(grip).toHaveClass('opacity-0', 'pointer-events-none');

    fireEvent.mouseMove(terminalView, { clientY: 10 });
    expect(grip).not.toHaveClass('opacity-0');
    expect(grip).not.toHaveClass('pointer-events-none');

    fireEvent.mouseLeave(grip.parentElement!);
    expect(grip).toHaveClass('opacity-0', 'pointer-events-none');

    // A drag sends no mouse events, so the grip it started from hides once the drag ends.
    fireEvent.mouseMove(terminalView, { clientY: 10 });
    fireEvent.dragStart(grip, { dataTransfer: { setData: vi.fn() } });
    fireEvent.dragEnd(grip);
    expect(grip).toHaveClass('opacity-0', 'pointer-events-none');
  });

  describe('dropping a single-pane tab', () => {
    function dropTab() {
      mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };
      mocks.layoutsByTab = {
        'workspace-1': { 'tab-2': { type: 'leaf', id: 'pane-2', terminalId: 'terminal-2' } },
      };
      render(
        <TerminalPane
          paneId="pane-1"
          terminalId="terminal-1"
          workspaceId="workspace-1"
          isTabActive={true}
        />
      );
      const pane = screen.getByTestId('terminal-view').closest('.isolate')!;
      vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 })
      );
      const data: Record<string, string> = {
        [PANE_DRAG_MIME]: 'pane-2',
        [TAB_PANE_DRAG_MIME]: 'tab-2',
      };
      fireEvent.drop(pane, {
        clientX: 40,
        clientY: 50,
        dataTransfer: { types: Object.keys(data), getData: (type: string) => data[type] ?? '' },
      });
    }

    it("moves the tab beside this pane, on the side nearest the pointer", () => {
      dropTab();
      expect(mocks.moveTabToEdge).toHaveBeenCalledWith('tab-2', 'pane-1', 'left');
    });

    it('leaves a tab alone whose terminal began closing during the drag', () => {
      useTerminalCloseStore.setState({ closingTerminalIds: new Set(['terminal-2']) });
      dropTab();
      expect(mocks.moveTabToEdge).not.toHaveBeenCalled();
    });
  });

  it('keeps the grip shown while it is pressed, so the drag still starts once the pointer leaves the top', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const grip = screen.getByTestId('pane-drag-grip');
    const terminalView = screen.getByTestId('terminal-view');
    fireEvent.mouseMove(terminalView, { clientY: 10 });
    // The browser only starts the drag after the pointer has moved, and drops it if the grip is
    // gone from under the press by then.
    fireEvent.mouseMove(terminalView, { clientY: 200, buttons: 1 });
    expect(grip).not.toHaveClass('opacity-0');
    expect(grip).not.toHaveClass('pointer-events-none');
    fireEvent.mouseLeave(grip.parentElement!, { buttons: 1 });
    expect(grip).not.toHaveClass('pointer-events-none');

    // A press that left the pane without dragging, such as a text selection, hides it on release.
    fireEvent.mouseUp(window);
    expect(grip).toHaveClass('opacity-0', 'pointer-events-none');
  });

  it('keeps the grip above the pane content overlays whether or not the pane is focused', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: false,
        startupError: 'host unreachable',
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    // Dimming gives an unfocused pane's content a stacking context of its own, which puts the
    // grip above the content's overlays. A focused pane's content needs one too, or its overlays
    // would cover the grip instead.
    const overlay = screen.getByText('Couldn’t connect to the remote workspace');
    expect(overlay.closest('.isolate')).not.toContainElement(screen.getByTestId('pane-drag-grip'));
  });

  it('shows no corner tab for a local copy terminal with no status to show', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };
    workspace.backend.kind = 'local';
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Local copy',
        status: 'running',
        executionLocation: 'local-mirror',
        remoteSessionActive: false,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.queryByTestId('pane-status-strip')).not.toBeInTheDocument();
  });

  it('shows status in a slim strip on the terminal background when pane headers are turned off', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };
    mocks.terminalHost = { hostname: 'hetzner-box', isLocal: false };
    mocks.sshHosts = [{ id: 'host-1', name: 'Hetzner', hostname: '203.0.113.10', user: 'user' }];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const strip = screen.getByTestId('pane-status-strip');
    expect(strip).toHaveStyle({ backgroundColor: 'rgb(40, 44, 52)' });
    // Above the drag grip, which shares its row and could cover it in a narrow pane.
    expect(within(strip).getByText('Hetzner').closest('.rounded-bl-md')).toHaveClass('z-30');
    // A label in the project color in the corner tab, not the header's outlined pill.
    const label = within(strip).getByText('Hetzner').parentElement;
    expect(label).toHaveClass('text-primary');
    expect(label).not.toHaveClass('ring-1');
    expect(screen.queryByRole('button', { name: 'Close terminal pane' })).not.toBeInTheDocument();
  });

  it('retries a failed local copy sync from the slim strip when pane headers are turned off', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: false };
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Local copy',
        status: 'running',
        executionLocation: 'local-mirror',
        remoteSessionActive: false,
      },
    ];
    setLocalMirrorSyncStatus({
      workspaceId: 'workspace-1',
      state: 'error',
      message: 'Failed to update local copy: connection lost',
    });

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const strip = screen.getByTestId('pane-status-strip');
    expect(within(strip).getByText('Local copy · Read-only')).toBeInTheDocument();
    fireEvent.click(within(strip).getByRole('button', { name: 'Retry local copy sync' }));
    expect(mocks.retryLocalMirrorSync).toHaveBeenCalledWith('workspace-1');
  });

  it('describes the SSH target and copies the tmux attach command from the host tooltip', () => {
    mocks.terminalHost = { hostname: 'hetzner-box', isLocal: false };
    mocks.sshHosts = [{ id: 'host-1', name: 'Hetzner', hostname: '203.0.113.10', user: 'user' }];
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'running',
        executionLocation: 'workspace',
        remoteSessionActive: true,
        remoteSessionResumable: true,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByText('user@203.0.113.10')).toBeInTheDocument();
    const path = screen.getByTestId('remote-path');
    expect(path).toHaveTextContent(/^~\/workspace$/);
    // Breaks between segments, so `~/` and `workspace` wrap as whole names.
    expect(path.querySelectorAll('wbr')).toHaveLength(1);
    expect(screen.queryByText(/SSH workspace on/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Click to copy/)).not.toBeInTheDocument();
    // The header's drag hint must not stack on top of the pill tooltip.
    expect(screen.getByText('Hetzner').parentElement).toHaveAttribute('title', '');

    fireEvent.click(screen.getByRole('button', { name: 'Copy tmux attach command' }));

    expect(mocks.copyToClipboard).toHaveBeenCalledWith(
      'ssh -t user@203.0.113.10 tmux -L komla-v1 attach-session -t komla-terminal-1'
    );
  });

  it('keeps the full remote path and offers no attach command once the tmux session has ended', () => {
    mocks.terminalHost = { hostname: 'hetzner-box', isLocal: false };
    mocks.sshHosts = [{ id: 'host-1', name: 'Hetzner', hostname: '203.0.113.10' }];
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: false,
        remoteSessionResumable: false,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
    expect(screen.getByTestId('remote-path')).toHaveTextContent(/^\/home\/user\/workspace$/);
    expect(
      screen.queryByRole('button', { name: /Copy tmux attach command/ })
    ).not.toBeInTheDocument();
  });

  it('does not show the local-copy badge on remote SSH terminals', () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.queryByText('Local copy · Read-only')).not.toBeInTheDocument();
  });

  it('shows local copy sync failures in the pane header and retries without covering the terminal', () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Local copy',
        status: 'running',
        executionLocation: 'local-mirror',
        remoteSessionActive: false,
      },
    ];
    setLocalMirrorSyncStatus({
      workspaceId: 'workspace-1',
      state: 'error',
      message: 'Failed to update local copy: connection lost',
    });

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const retry = screen.getByRole('button', { name: 'Retry local copy sync' });
    expect(retry).toHaveAttribute('title', expect.stringContaining('connection lost'));
    fireEvent.click(retry);
    expect(mocks.retryLocalMirrorSync).toHaveBeenCalledWith('workspace-1');
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
  });

  it('opens a file link from its menu where a click opens it', () => {
    const open = vi.fn();
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    act(() => {
      const onLinkContextMenu = mocks.terminalViewProps?.onLinkContextMenu as
        | ((link: unknown) => void)
        | undefined;
      onLinkContextMenu?.({
        type: 'file',
        target: 'external',
        filePath: '/tmp/report.html',
        rawPath: '/tmp/report.html',
        open,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open File' }));

    expect(open).toHaveBeenCalledOnce();
  });

  it('lists the split items right after Copy, Paste and Find, with Close Pane still last', () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const items = screen.getAllByRole('button').map((item) => item.textContent ?? '');
    const at = (label: string) => items.findIndex((text) => text.startsWith(label));
    // Split Right, then Split Down, each a terminal with a browser, a note, an agent or a quick
    // command in its submenu; with no agent or quick command set up, their rows set one up.
    expect(items.slice(at('Find...') + 1, at('Find...') + 11)).toEqual([
      'Split Right',
      'Browser',
      'Note',
      'AI AgentConfigure...',
      'New quick command',
      'Split Down',
      'Browser',
      'Note',
      'AI AgentConfigure...',
      'New quick command',
    ]);
    expect(at('Close Pane')).toBeGreaterThan(at('Refresh Terminal'));
    // Replace With sits above Paste Prompt, near the other items that change what the pane holds.
    // With no Saved Prompt yet, Paste Prompt has nothing to paste.
    const pastePrompt = screen.getByRole('button', { name: 'Paste Prompt' });
    expect(pastePrompt).toBeDisabled();
    expect(screen.getByText('Replace With').compareDocumentPosition(pastePrompt)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('opens a browser below the pane from Split Down', () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Browser' })[1]);

    expect(openBrowserPane).toHaveBeenCalledWith('workspace-1', {
      kind: 'split',
      direction: 'horizontal',
      paneId: 'pane-1',
    });
  });

  it('opens a terminal below the pane from the Split Down row', async () => {
    mocks.addTerminal.mockResolvedValue({ id: 'terminal-2' });
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Split Down' }));
    });

    expect(mocks.setFocusedPane).toHaveBeenCalledWith('pane-1');
    expect(mocks.splitPane).toHaveBeenCalledWith('horizontal', 'terminal-2');
  });

  it('replaces the pane with a browser or a note', () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByText('Replace With')).not.toHaveAttribute('aria-disabled', 'true');
    // The split submenus' Note items come first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Note' }).at(-1)!);

    expect(replaceTerminalWithPaneSurface).toHaveBeenCalledWith(
      'workspace-1',
      'terminal-1',
      'pane-1',
      'note',
      expect.any(Function)
    );
  });

  it("replaces the workspace's last terminal, whose browser or note keeps the workspace open", () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByText('Replace With')).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByRole('button', { name: 'Browser' }).at(-1)).toBeEnabled();
  });

  it('refreshes its own terminal from the context menu', () => {
    render(
      <TerminalPane
        paneId="pane-2"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    fireEvent.contextMenu(screen.getByTestId('terminal-view'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Terminal' }));

    expect(mocks.refreshTerminalRenderer).toHaveBeenCalledWith('terminal-1');
  });

  it('reveals terminal file links launched directly on the local host', () => {
    workspace.backend.kind = 'local';
    workspace.workingDirectory = '/repo';

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    act(() => {
      const onLinkContextMenu = mocks.terminalViewProps?.onLinkContextMenu as
        | ((link: unknown) => void)
        | undefined;
      onLinkContextMenu?.({
        type: 'file',
        target: 'external',
        filePath: '/tmp/report.html',
        rawPath: '/tmp/report.html',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show in File Manager' }));

    expect(mocks.showItemInFolder).toHaveBeenCalledWith('/tmp/report.html');
  });

  it("opens a web link in the workspace's Komla browser or the default browser", async () => {
    const openExternal = vi.fn();
    const startSshLinkForward = vi.fn().mockResolvedValue({
      id: 'forward-1',
      workspaceId: 'workspace-1',
      localUrl: 'http://127.0.0.1:3001',
      localPort: 3001,
      remotePort: 3000,
    });
    Object.assign(window.api, { openExternal, startSshLinkForward });
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );
    const showLinkMenu = (url: string) =>
      act(() => {
        const onLinkContextMenu = mocks.terminalViewProps?.onLinkContextMenu as
          | ((link: unknown) => void)
          | undefined;
        onLinkContextMenu?.({ type: 'url', url });
      });

    showLinkMenu('http://0.0.0.0:3000/report');
    fireEvent.click(screen.getByRole('button', { name: 'Open in Komla Browser' }));
    expect(openInBrowserPane).toHaveBeenCalledWith(
      'workspace-1',
      'http://localhost:3000/report',
      'workspace'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open in Default Browser' }));
    // Through a tunnel to the SSH host, as a Shift+click opens it.
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('http://localhost:3001/report')
    );

    // Komla's browser shows only web pages.
    showLinkMenu('mailto:dev@example.com');
    expect(screen.queryByRole('button', { name: 'Open in Komla Browser' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open URL' }));
    expect(openExternal).toHaveBeenLastCalledWith('mailto:dev@example.com');
  });

  it('resolves local workspace links before revealing them', () => {
    workspace.backend.kind = 'local';
    workspace.workingDirectory = '/repo';

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    act(() => {
      const onLinkContextMenu = mocks.terminalViewProps?.onLinkContextMenu as
        | ((link: unknown) => void)
        | undefined;
      onLinkContextMenu?.({
        type: 'file',
        target: 'workspace',
        filePath: 'src/report.html',
        rawPath: 'src/report.html',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show in File Manager' }));

    expect(mocks.showItemInFolder).toHaveBeenCalledWith('/repo/src/report.html');
  });

  it('does not offer host reveal for SSH terminal file links', () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    act(() => {
      const onLinkContextMenu = mocks.terminalViewProps?.onLinkContextMenu as
        | ((link: unknown) => void)
        | undefined;
      onLinkContextMenu?.({
        type: 'file',
        target: 'external',
        filePath: '/tmp/report.html',
        rawPath: '/tmp/report.html',
      });
    });

    expect(screen.queryByRole('button', { name: 'Show in File Manager' })).not.toBeInTheDocument();
  });

  it('reveals absolute snapshot links from SSH local-copy terminals', () => {
    workspace.terminals[0].executionLocation = 'local-mirror';

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    act(() => {
      const onLinkContextMenu = mocks.terminalViewProps?.onLinkContextMenu as
        | ((link: unknown) => void)
        | undefined;
      onLinkContextMenu?.({
        type: 'file',
        target: 'external',
        filePath: '/tmp/report.html',
        rawPath: '/tmp/report.html',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show in File Manager' }));

    expect(mocks.showItemInFolder).toHaveBeenCalledWith('/tmp/report.html');
  });

  it('inherits the local-copy location when splitting from the pane header', async () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: true };
    workspace.terminals[0].executionLocation = 'local-mirror';
    mocks.addTerminal.mockResolvedValue({ id: 'terminal-2' });

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Split terminal right' }));
    });

    expect(mocks.addTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'Local terminal',
      null,
      undefined,
      'host-shell',
      'local-mirror'
    );
  });

  it('passes the resolved workspace backend kind to the terminal view', () => {
    workspace.backend.kind = 'local';

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(mocks.terminalViewProps?.workspaceBackendKind).toBe('local');
  });

  it('passes the SSH workspace root to the terminal view', () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(mocks.terminalViewProps?.fileLinkWorkspaceRoot).toBe('/home/user/workspace');
  });

  it('shows a non-interactive closing state while terminal cleanup is pending', () => {
    mocks.terminalConfig = { colors: { background: '#282c34' }, showPaneHeaders: true };
    useTerminalCloseStore.setState({ closingTerminalIds: new Set(['terminal-1']) });

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByText('Closing terminal…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Closing terminal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Split terminal right' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Split terminal down' })).toBeDisabled();
    expect(mocks.terminalViewProps?.isActive).toBe(false);
  });

  it('passes workspace-aware image import options when pasting from the context menu', () => {
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Paste(?! Prompt)/ }));

    expect(mocks.pasteClipboardIntoTerminal).toHaveBeenCalledWith('terminal-1', {
      workspaceId: 'workspace-1',
      executionLocation: 'workspace',
      canImportClipboardImage: true,
    });
  });

  it('runs a quick command in place of the pane from Replace With, and closes the menu', async () => {
    mocks.actions.push(
      { id: 'command', title: 'Run tests', type: 'command', content: 'npm test' },
      { id: 'prompt', title: 'Review', type: 'prompt', content: 'Review this branch' }
    );

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );
    fireEvent.contextMenu(screen.getByTestId('terminal-view'));
    expect(screen.getByTestId('context-menu')).toHaveAttribute('data-open', 'true');

    const replaceWith = submenuOf(screen.getByText('Replace With'));
    await act(async () => {
      fireEvent.click(within(replaceWith).getByRole('option', { name: /Run tests/ }));
    });

    expect(mocks.launchAction).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      action: expect.objectContaining({ id: 'command' }),
      place: { kind: 'replace', terminalId: 'terminal-1', confirm: expect.any(Function) },
    });
    expect(screen.getByTestId('context-menu')).toHaveAttribute('data-open', 'false');
  });

  it('runs a quick command beside its own pane from a split submenu', async () => {
    mocks.actions.push({ id: 'command', title: 'Run tests', type: 'command', content: 'npm test' });
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    await act(async () => {
      fireEvent.click(
        within(submenuOf(screen.getByRole('button', { name: 'Split Down' }))).getByRole('button', {
          name: 'Run tests',
        })
      );
    });

    expect(mocks.launchAction).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      action: expect.objectContaining({ id: 'command' }),
      place: {
        kind: 'split',
        paneId: 'pane-1',
        terminalId: 'terminal-1',
        tabId: 'tab-1',
        direction: 'horizontal',
      },
    });
  });

  it('splits nothing off a pane that started closing while its submenu was open', async () => {
    mocks.actions.push({ id: 'command', title: 'Run tests', type: 'command', content: 'npm test' });
    useTerminalCloseStore.setState({ closingTerminalIds: new Set(['terminal-1']) });
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    await act(async () => {
      fireEvent.click(
        within(submenuOf(screen.getByRole('button', { name: 'Split Down' }))).getByRole('option', {
          name: /Run tests/,
        })
      );
    });

    expect(mocks.launchAction).not.toHaveBeenCalled();
  });

  it('reruns the last used quick command from the row, with the list behind its arrow', async () => {
    mocks.actions.push(
      { id: 'command', title: 'Run tests', type: 'command', content: 'npm test' },
      { id: 'lint', title: 'Lint', type: 'command', content: 'npm run lint', lastUsedAt: 2 }
    );
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'running',
        executionLocation: 'workspace',
        remoteSessionActive: undefined,
        remoteSessionResumable: true,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );
    fireEvent.contextMenu(screen.getByTestId('terminal-view'));

    const replaceWith = submenuOf(screen.getByText('Replace With'));
    expect(within(replaceWith).getByRole('option', { name: /Run tests/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(replaceWith).getByRole('button', { name: 'Lint' }));
    });

    expect(mocks.launchAction).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      action: expect.objectContaining({ id: 'lint' }),
      place: { kind: 'replace', terminalId: 'terminal-1', confirm: expect.any(Function) },
    });
  });

  it("reruns the run button's default from Replace With, and Paste Prompt's own", async () => {
    mocks.actions.push(
      { id: 'command', title: 'Run tests', type: 'command', content: 'npm test' },
      { id: 'lint', title: 'Lint', type: 'command', content: 'npm run lint', lastUsedAt: 2 },
      { id: 'review', title: 'Review', type: 'prompt', content: 'Review this branch' },
      { id: 'explain', title: 'Explain', type: 'prompt', content: 'Explain', lastUsedAt: 3 }
    );
    workspaceStoreState.workspaces = [
      Object.assign({}, workspace, { defaultActionId: 'command', paneDefaultActionId: 'review' }),
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );
    fireEvent.contextMenu(screen.getByTestId('terminal-view'));

    const replaceWith = submenuOf(screen.getByText('Replace With'));
    expect(within(replaceWith).getByRole('button', { name: 'Run tests' })).toBeInTheDocument();
    expect(within(replaceWith).queryByRole('button', { name: 'Lint' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Paste$/ })).toHaveTextContent('Review');
  });

  it('keeps Cmd and Ctrl+ArrowLeft in the quick command search, where they move the caret', () => {
    mocks.actions.push(
      { id: 'command', title: 'Run tests', type: 'command', content: 'npm test' },
      { id: 'prompt', title: 'Review', type: 'prompt', content: 'Review this branch' }
    );
    mocks.submenuKeyDown.mockClear();
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const [search] = screen.getAllByRole('combobox', { name: 'Search quick commands' });
    fireEvent.keyDown(search, { key: 'ArrowLeft', ctrlKey: true });
    fireEvent.keyDown(search, { key: 'ArrowLeft', metaKey: true });
    expect(mocks.submenuKeyDown).not.toHaveBeenCalled();

    // Other shortcuts still reach the menu and the app.
    fireEvent.keyDown(search, { key: 'k', metaKey: true });
    expect(mocks.submenuKeyDown).toHaveBeenCalledWith('k');
  });

  it('forgets the right-clicked link once an Action from the menu runs', async () => {
    workspace.terminals[0].status = 'running';
    mocks.actions.push({
      id: 'prompt',
      title: 'Review',
      type: 'prompt',
      content: 'Review this branch',
    });
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );
    act(() => {
      const onLinkContextMenu = mocks.terminalViewProps?.onLinkContextMenu as (
        link: unknown
      ) => void;
      onLinkContextMenu({ type: 'url', url: 'http://localhost:3000/' });
    });
    expect(screen.getByRole('button', { name: 'Open in Komla Browser' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        within(submenuOf(screen.getByRole('button', { name: /Paste$/ }))).getByRole('option', {
          name: /Review/,
        })
      );
    });

    expect(screen.queryByRole('button', { name: 'Open in Komla Browser' })).toBeNull();
  });

  it('returns focus to the terminal when an editor opened from its menu closes', () => {
    mocks.actions.push({ id: 'command', title: 'Run tests', type: 'command', content: 'npm test' });
    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'New quick command' })[0]);
    useActionEditorStore.getState().request?.returnFocus?.();

    expect(focusTerminalRenderer).toHaveBeenCalledWith('terminal-1');
    act(() => useActionEditorStore.getState().closeActionEditor());
  });

  it('disables context-menu image imports for local mirror terminals', () => {
    workspace.terminals[0].executionLocation = 'local-mirror';

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Paste(?! Prompt)/ }));

    expect(mocks.pasteClipboardIntoTerminal).toHaveBeenCalledWith('terminal-1', {
      workspaceId: 'workspace-1',
      executionLocation: 'local-mirror',
      canImportClipboardImage: false,
    });
  });

  it('resolves terminal data from the pane workspace when another workspace is selected', () => {
    workspace.terminals[0].executionLocation = 'local-mirror';
    workspaceStoreState.selectedWorkspaceId = 'workspace-2';
    workspaceStoreState.workspaces = [
      workspace,
      {
        ...workspace,
        id: 'workspace-2',
        terminals: [],
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(mocks.terminalViewProps?.executionLocation).toBe('local-mirror');
    fireEvent.click(screen.getByRole('button', { name: /^Paste(?! Prompt)/ }));
    expect(mocks.pasteClipboardIntoTerminal).toHaveBeenCalledWith('terminal-1', {
      workspaceId: 'workspace-1',
      executionLocation: 'local-mirror',
      canImportClipboardImage: false,
    });
  });

  it('offers separate agent retry and remote shell actions', async () => {
    let finishRestart!: () => void;
    mocks.restartTerminal.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRestart = resolve;
      })
    );

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByRole('button', { name: 'Retry agent' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open shell' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry agent' }));

    expect(screen.getByRole('button', { name: 'Retrying agent…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open shell' })).toBeDisabled();
    expect(mocks.restartTerminal).toHaveBeenCalledWith(
      'terminal-1',
      undefined,
      undefined,
      120,
      30,
      { replaceSession: true }
    );

    await act(async () => {
      finishRestart();
    });

    mocks.restartTerminal.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open shell' }));
    await act(async () => Promise.resolve());

    expect(mocks.restartTerminal).toHaveBeenLastCalledWith(
      'terminal-1',
      undefined,
      undefined,
      120,
      30,
      { plainShell: true, replaceSession: true }
    );
  });

  it('does not enable OSC 52 before managed tmux support is confirmed', () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'starting',
        executionLocation: 'workspace',
        remoteSessionActive: false,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
    const connectingMessage = screen.getByText('Connecting to remote workspace…');
    expect(connectingMessage).toBeInTheDocument();
    const cover = connectingMessage.parentElement?.parentElement;
    expect(cover).toHaveClass('pointer-events-none');
    // The terminal's color (the default #13171b here), not the darker window background.
    expect(cover?.getAttribute('style')).toContain('color-mix(in srgb, rgb(19, 23, 27) 70%');
    expect(mocks.terminalViewProps?.allowOsc52Clipboard).toBe(false);
    expect(mocks.terminalViewProps?.copyOnSelect).toBe(false);
  });

  it("keeps the theme's background behind the connecting screen over a light terminal", () => {
    mocks.terminalConfig = { colors: { background: '#fafafa' } };
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'starting',
        executionLocation: 'workspace',
        remoteSessionActive: false,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const cover = screen.getByText('Connecting to remote workspace…').parentElement?.parentElement;
    // Its text is drawn for the theme's background, not for a light terminal.
    expect(cover?.getAttribute('style')).toContain('oklch(var(--background)) 70%');
  });

  it('enables OSC 52 and explains automatic copying for a managed tmux pane', () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'running',
        executionLocation: 'workspace',
        remoteSessionActive: true,
        remoteSessionResumable: true,
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(mocks.terminalViewProps?.allowOsc52Clipboard).toBe(true);
    expect(mocks.terminalViewProps?.copyOnSelect).toBe(true);
    expect(document.body).toHaveTextContent('Selection copies automatically');
  });

  it('shows remote startup failures instead of a reconnect action', () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: false,
        startupError: 'host unreachable',
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByText('Couldn’t connect to the remote workspace')).toBeInTheDocument();
    expect(screen.getByText('host unreachable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('retries only the selected stopped agent pane', async () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: false,
        remoteSessionResumable: true,
      },
      {
        id: 'terminal-2',
        name: 'Terminal 2',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionResumable: true,
      },
    ];
    mocks.restartTerminal.mockResolvedValue(true);

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry agent' }));
    });

    expect(mocks.restartTerminal).toHaveBeenCalledWith(
      'terminal-1',
      undefined,
      undefined,
      120,
      30,
      { replaceSession: true }
    );
    expect(mocks.reconnectAllSshTerminals).not.toHaveBeenCalled();
    expect(mocks.reconnectSshTerminal).not.toHaveBeenCalled();
  });

  it('reconnects a detached managed session without replacing its agent', async () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: true,
        remoteSessionResumable: true,
      },
    ];
    mocks.reconnectAllSshTerminals.mockResolvedValue(undefined);

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect session' }));
    });

    expect(mocks.reconnectAllSshTerminals).toHaveBeenCalledWith('workspace-1');
    expect(mocks.restartTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open shell' })).not.toBeInTheDocument();
  });

  it('says why a detached session lost its connection above Reconnect session', () => {
    mocks.sshHosts = [{ id: 'host-1', name: 'Hetzner', hostname: '203.0.113.10' }];
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: true,
        remoteSessionResumable: true,
        connectionError: 'ssh: connect to host 203.0.113.10 port 22: Network is unreachable',
      },
    ];

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Lost connection to Hetzner');
    expect(alert).toHaveTextContent('Network is unreachable');
    expect(screen.getByRole('button', { name: 'Reconnect session' })).toBeEnabled();
  });

  it('leaves an agent that ended on its own alone while offline', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: false,
        remoteSessionResumable: true,
      },
    ];

    try {
      render(
        <TerminalPane
          paneId="pane-1"
          terminalId="terminal-1"
          workspaceId="workspace-1"
          isTabActive={true}
        />
      );

      expect(screen.getByRole('button', { name: 'Retry agent' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      onLine.mockRestore();
    }
  });

  it('says the computer is offline above Reconnect session', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: true,
        remoteSessionResumable: true,
      },
    ];

    try {
      render(
        <TerminalPane
          paneId="pane-1"
          terminalId="terminal-1"
          workspaceId="workspace-1"
          isTabActive={true}
        />
      );

      expect(screen.getByRole('alert')).toHaveTextContent('You’re offline');
      expect(screen.getByRole('button', { name: 'Reconnect session' })).toBeEnabled();
    } finally {
      onLine.mockRestore();
    }
  });

  it('replaces Refresh Terminal with a reconnect-and-refresh for a running managed terminal', async () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'running',
        executionLocation: 'workspace',
        remoteSessionActive: true,
        remoteSessionResumable: true,
      },
    ];
    mocks.reconnectSshTerminal.mockResolvedValue(undefined);

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.queryByRole('button', { name: 'Reconnect terminal' })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId('terminal-view'));
    // In Refresh Terminal's place rather than under More, since it does both.
    expect(screen.queryByRole('button', { name: 'Refresh Terminal' })).not.toBeInTheDocument();
    expect(
      screen
        .getByRole('button', { name: 'Refresh SSH Session' })
        .closest('[data-testid="context-submenu"]')
    ).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh SSH Session' }));
    });

    expect(mocks.reconnectSshTerminal).toHaveBeenCalledWith('terminal-1', 120, 30);
    expect(mocks.reconnectAllSshTerminals).not.toHaveBeenCalled();
    expect(mocks.refreshTerminalRenderer).toHaveBeenCalledWith('terminal-1');
    expect(mocks.reconnectSshTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.refreshTerminalRenderer.mock.invocationCallOrder[0]
    );
  });

  describe('in an SSH workspace', () => {
    beforeEach(() => {
      mocks.supportsLocalCopy = true;
      mocks.sshHosts = [{ id: 'host-1', name: 'Hetzner', hostname: '203.0.113.10', user: 'user' }];
      workspace.terminals = [
        {
          id: 'terminal-1',
          name: 'Terminal',
          status: 'running',
          executionLocation: 'workspace',
          remoteSessionActive: false,
        },
      ];
    });

    const renderRemotePane = () =>
      render(
        <TerminalPane
          paneId="pane-1"
          terminalId="terminal-1"
          workspaceId="workspace-1"
          isTabActive={true}
        />
      );

    it('offers a local terminal first in each split submenu and in Replace With', () => {
      renderRemotePane();

      const items = screen.getAllByRole('button').map((item) => item.textContent ?? '');
      const after = (label: string) => items[items.findIndex((text) => text.startsWith(label)) + 1];
      expect(after('Split Right')).toBe('Local Terminal');
      expect(after('Split Down')).toBe('Local Terminal');
      expect(screen.getAllByRole('button', { name: 'Local Terminal' })).toHaveLength(3);
    });

    it('opens a local terminal below the pane from Split Down', async () => {
      mocks.addTerminal.mockResolvedValue({ id: 'terminal-2' });
      renderRemotePane();

      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Local Terminal' })[1]);
      });

      expect(mocks.addTerminal).toHaveBeenCalledWith(
        'workspace-1',
        'Local terminal',
        null,
        undefined,
        'host-shell',
        'local-mirror'
      );
      expect(mocks.splitPane).toHaveBeenCalledWith('horizontal', 'terminal-2');
    });

    it("replaces even the workspace's last terminal with a local one, in place", async () => {
      mocks.restartTerminal.mockResolvedValue(true);
      renderRemotePane();

      // A local terminal takes the same terminal's place.
      expect(screen.getByText('Replace With')).not.toHaveAttribute('aria-disabled', 'true');
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Local Terminal' }).at(-1)!);
      });

      expect(mocks.restartTerminal).toHaveBeenCalledWith(
        'terminal-1',
        undefined,
        undefined,
        120,
        30,
        { executionLocation: 'local-mirror' }
      );
      expect(mocks.splitPane).not.toHaveBeenCalled();
    });
  });

  it('uses the connection overlay while the SSH workspace is automatically reconnecting', () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: true,
        remoteSessionResumable: true,
      },
    ];
    mocks.reconnectingSshWorkspaceIds.add('workspace-1');

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    expect(screen.getByText('Connecting to remote workspace…')).toBeInTheDocument();
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect session' })).not.toBeInTheDocument();
    expect(mocks.reconnectAllSshTerminals).not.toHaveBeenCalled();
  });

  it('opens a fresh shell for an ended pane even when another tmux pane is resumable', async () => {
    workspace.terminals = [
      {
        id: 'terminal-1',
        name: 'Terminal',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: false,
      },
      {
        id: 'terminal-2',
        name: 'Terminal 2',
        status: 'stopped',
        executionLocation: 'workspace',
        remoteSessionActive: true,
      },
    ];
    mocks.restartTerminal.mockResolvedValue(true);

    render(
      <TerminalPane
        paneId="pane-1"
        terminalId="terminal-1"
        workspaceId="workspace-1"
        isTabActive={true}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open shell' }));
    });

    expect(mocks.restartTerminal).toHaveBeenCalledWith(
      'terminal-1',
      undefined,
      undefined,
      120,
      30,
      { plainShell: true, replaceSession: true }
    );
    expect(mocks.reconnectSshTerminal).not.toHaveBeenCalled();
    expect(mocks.reconnectAllSshTerminals).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reconnect session' })).not.toBeInTheDocument();
  });

  describe('replacing the pane with an agent from the context menu', () => {
    beforeEach(() => {
      workspace.backend.kind = 'local';
      workspace.workingDirectory = '/repo';
      mocks.presets.push({
        id: 'claude',
        name: 'Claude Code',
        openCommand: 'claude',
        continueCommand: 'claude --continue',
        promptCommand: 'claude',
        launchModes: [],
        isBuiltin: true,
      });
      mocks.activePresets.push({ presetId: 'claude', lastUsedAt: 1 });
    });

    function renderPane() {
      render(
        <TerminalPane
          paneId="pane-1"
          terminalId="terminal-1"
          workspaceId="workspace-1"
          isTabActive={true}
        />
      );
    }

    it('lists the agent by name after the browser and note in each split submenu and in Replace With', () => {
      renderPane();

      const items = screen.getAllByRole('button').map((item) => item.textContent ?? '');
      const agentAfter = (label: string) =>
        items.indexOf('Claude Code', items.indexOf(label)) - items.indexOf(label);
      expect(agentAfter('Split Right')).toBe(3);
      expect(agentAfter('Split Down')).toBe(3);
      expect(items.indexOf('Claude Code', items.indexOf('Replace With'))).toBeLessThan(
        items.indexOf('New quick command')
      );
      expect(screen.getAllByRole('button', { name: 'Claude Code' })).toHaveLength(3);
    });

    it('opens the agent beside the pane from a split submenu', () => {
      renderPane();

      fireEvent.click(screen.getAllByRole('button', { name: 'Claude Code' })[1]);

      expect(splitAgentBesidePane).toHaveBeenCalledWith(
        'workspace-1',
        'pane-1',
        'horizontal',
        'claude',
        null
      );
      expect(mocks.restartTerminal).not.toHaveBeenCalled();
    });

    it("greys out the split submenus' agents without a workspace, like their browser and note", () => {
      render(
        <SplitPaneMenuItems
          workspaceId={null}
          paneId="pane-1"
          disabled={false}
          onSplitTerminal={vi.fn()}
        />
      );

      expect(screen.getAllByRole('button', { name: 'Claude Code' })).toHaveLength(2);
      for (const row of screen.getAllByRole('button', { name: 'Claude Code' })) {
        expect(row).toBeDisabled();
      }
    });

    it('greys out Paste Prompt once the terminal has stopped', () => {
      mocks.actions.push({
        id: 'prompt',
        title: 'Review',
        type: 'prompt',
        content: 'Review this branch',
      });
      renderPane();

      expect(screen.getByRole('button', { name: /Paste$/ })).toBeDisabled();
    });

    it('replaces a running terminal without asking', async () => {
      workspace.terminals[0].status = 'running';
      renderPane();

      await act(async () => {
        // Replace With's comes after the split submenus'.
        fireEvent.click(screen.getAllByRole('button', { name: 'Claude Code' }).at(-1)!);
      });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mocks.restartTerminal).toHaveBeenCalledWith('terminal-1', 'claude', null, 120, 30, {
        replaceSession: true,
      });
    });

    describe('with the terminal running', () => {
      beforeEach(() => {
        workspace.terminals[0].status = 'running';
        mocks.actions.push({
          id: 'prompt',
          title: 'Review',
          type: 'prompt',
          content: 'Review this branch',
        });
      });

      it('pastes a Saved Prompt into it from Paste Prompt, which lists no commands', async () => {
        mocks.actions.push({
          id: 'command',
          title: 'Run tests',
          type: 'command',
          content: 'npm test',
        });
        renderPane();

        const pastePrompt = submenuOf(screen.getByRole('button', { name: /Paste$/ }));
        expect(within(pastePrompt).queryByRole('option', { name: /Run tests/ })).toBeNull();
        await act(async () => {
          fireEvent.click(within(pastePrompt).getByRole('option', { name: /Review/ }));
        });

        expect(mocks.launchAction).toHaveBeenCalledWith(
          expect.objectContaining({ place: { kind: 'type', terminalId: 'terminal-1' } })
        );
      });

      it('starts a Saved Prompt in place of it from Replace With', async () => {
        renderPane();

        await act(async () => {
          fireEvent.click(
            within(submenuOf(screen.getByText('Replace With'))).getByRole('button', {
              name: 'Review',
            })
          );
        });

        expect(mocks.launchAction).toHaveBeenCalledWith(
          expect.objectContaining({
            place: { kind: 'replace', terminalId: 'terminal-1', confirm: expect.any(Function) },
          })
        );
      });
    });
  });
});
