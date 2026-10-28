/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandCenterDialog } from '../../../../src/renderer/components/command-center/CommandCenterDialog';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { registerShortcutAction } from '../../../../src/renderer/lib/shortcut-actions';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { createProject, createTerminal, createWorkspace } from '../../../factories';

import {
  useCommandCenterStore,
  type CommandCenterMode,
} from '../../../../src/renderer/stores/command-center.store';
import type { AppConfig, Project, Workspace } from '../../../../src/renderer/types';

const workspacesState = {
  workspaces: [] as Workspace[],
  selectedWorkspaceId: null as string | null,
  selectWorkspace: vi.fn(async () => {}),
  setWorkspaceTrashed: vi.fn(async (workspaceId: string) => {
    workspacesState.workspaces = workspacesState.workspaces.map((workspace) =>
      workspace.id === workspaceId ? { ...workspace, status: 'active' as const } : workspace
    );
  }),
  moveWorkspaceToWindow: vi.fn(async () => {}),
};

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(
    <T,>(selector: (state: typeof workspacesState) => T) => selector(workspacesState),
    { getState: () => workspacesState }
  ),
}));

const projectsState = { projects: [] as Project[] };

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: <T,>(selector: (state: typeof projectsState) => T) => selector(projectsState),
}));

vi.mock('../../../../src/renderer/stores/window.store', () => {
  const state = { windowId: 'window-1', availableWindows: [{ id: 'window-2', displayNumber: 2 }] };
  return { useWindowStore: <T,>(selector: (s: typeof state) => T) => selector(state) };
});

const shortcutsState = vi.hoisted(() => ({
  getDisplayShortcut: () => '',
  matchesEvent: (_action: string, _event: KeyboardEvent) => false,
}));

const paneMocks = vi.hoisted(() => ({ openFilePane: vi.fn() }));
vi.mock('../../../../src/renderer/lib/pane-surfaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/renderer/lib/pane-surfaces')>()),
  openFilePane: paneMocks.openFilePane,
}));

vi.mock('../../../../src/renderer/stores/shortcuts.store', () => ({
  useShortcutsStore: <T,>(selector: (s: typeof shortcutsState) => T) => selector(shortcutsState),
  formatShortcutForDisplay: (shortcut: string) => shortcut,
}));

vi.mock('../../../../src/renderer/stores/settings-dialog.store', () => ({
  useSettingsDialogStore: { getState: () => ({ openSettings: vi.fn() }) },
}));

const searchMocks = vi.hoisted(() => ({
  fileState: {
    filteredFiles: [] as Array<{ path: string }>,
    loading: false,
    error: null as string | null,
    selectedIndex: 0,
    setSelectedIndex: (_index: number) => {},
  },
  contentState: {
    results: [] as Array<{
      path: string;
      lineNumber: number;
      lineContent: string;
      matches: Array<{ start: number; end: number }>;
    }>,
    loading: false,
    error: null as string | null,
    selectedIndex: 0,
    setSelectedIndex: (_index: number) => {},
  },
}));

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/useFileViewerState', () => ({
  useFileSearchState: () => searchMocks.fileState,
}));

vi.mock('../../../../src/renderer/hooks/useContentSearch', () => ({
  useContentSearch: () => searchMocks.contentState,
}));

function renderOpen(initialMode: CommandCenterMode = 'workspaces') {
  const onOpenChange = vi.fn();
  function Harness() {
    const [mode, setMode] = useState(initialMode);
    return (
      <TooltipProvider>
        <CommandCenterDialog
          open
          mode={mode}
          session={0}
          onOpenChange={onOpenChange}
          onModeChange={setMode}
        />
      </TooltipProvider>
    );
  }
  const { rerender } = render(<Harness />);
  return {
    onOpenChange,
    input: screen.getByRole('combobox'),
    // The mocked store has no subscribers, so re-render to show its new state.
    refresh: () => rerender(<Harness />),
  };
}

/** The dialog wired to the real store, as ShortcutProvider wires it. */
function renderWithStore() {
  function Harness() {
    const { open, mode, session, setMode, close } = useCommandCenterStore();
    return (
      <TooltipProvider>
        <CommandCenterDialog
          open={open}
          mode={mode}
          session={session}
          onOpenChange={(next) => {
            if (!next) close();
          }}
          onModeChange={setMode}
        />
      </TooltipProvider>
    );
  }
  return render(<Harness />);
}

function selectFolderWorkspace(overrides: Partial<Workspace> = {}) {
  workspacesState.selectedWorkspaceId = 'current';
  workspacesState.workspaces = [
    createWorkspace({
      id: 'current',
      windowId: 'window-1',
      workingDirectory: '/repo',
      ...overrides,
    }),
  ];
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

describe('CommandCenterDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api = { focusWorkspaceWindow: vi.fn(async () => true) } as unknown as typeof window.api;
    workspacesState.workspaces = [];
    workspacesState.selectedWorkspaceId = null;
    projectsState.projects = [];
    useConfigStore.setState({ config: null });
    shortcutsState.matchesEvent = () => false;
    searchMocks.fileState.filteredFiles = [];
    searchMocks.fileState.loading = false;
    searchMocks.fileState.selectedIndex = 0;
    searchMocks.contentState.results = [];
    searchMocks.contentState.loading = false;
    useFileViewerStore.setState({
      filePickerQueryByWorkspace: {},
      fileViewerWorkspaceId: null,
      inlineFilePreviewByWorkspace: {},
    });
  });

  it('brings forward the window showing a workspace instead of opening it here', async () => {
    workspacesState.workspaces = [
      createWorkspace({
        id: 'elsewhere',
        customName: 'Other window task',
        windowId: 'window-2',
        terminals: [createTerminal({ status: 'running' })],
      }),
    ];
    const { onOpenChange, input } = renderOpen();

    expect(screen.getByText('Window 2')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'other window' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(window.api.focusWorkspaceWindow).toHaveBeenCalledWith('elsewhere', undefined)
    );
    expect(workspacesState.moveWorkspaceToWindow).not.toHaveBeenCalled();
    expect(workspacesState.selectWorkspace).not.toHaveBeenCalled();
  });

  it('marks every workspace with its project color, not only running ones', () => {
    projectsState.projects = [createProject({ id: 'proj-red', name: 'red', color: '#ff0000' })];
    workspacesState.workspaces = [
      createWorkspace({ id: 'stopped', customName: 'Stopped task', projectId: 'proj-red' }),
      createWorkspace({
        id: 'trashed',
        customName: 'Trashed task',
        projectId: 'proj-red',
        status: 'trashed',
      }),
    ];
    const { input } = renderOpen();
    // Ones in the Trash only show when searched for.
    fireEvent.change(input, { target: { value: 'task' } });

    for (const name of [/Stopped task/, /Trashed task/]) {
      const dot = screen.getByRole('option', { name }).querySelector('[aria-hidden]');
      expect(dot).toHaveStyle({ backgroundColor: '#ff0000' });
    }
  });

  it('shows why a workspace is in the attention group', () => {
    workspacesState.workspaces = [
      createWorkspace({
        id: 'waiting',
        customName: 'Waiting task',
        windowId: 'window-1',
        terminals: [createTerminal({ status: 'running' })],
        attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
      }),
    ];
    renderOpen();

    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Waiting task/ })).toHaveTextContent('Input');
  });

  it('shows a spinner on a workspace whose agent is working', () => {
    workspacesState.workspaces = [
      createWorkspace({
        id: 'working',
        customName: 'Working task',
        windowId: 'window-1',
        agentActive: true,
        terminals: [createTerminal({ status: 'running', agentActive: true })],
      }),
      createWorkspace({
        id: 'idle',
        customName: 'Idle task',
        windowId: 'window-1',
        terminals: [createTerminal({ status: 'running' })],
      }),
    ];
    renderOpen();

    // A description rather than part of the name, which would change while the row is read.
    const working = screen.getByRole('option', { name: /Working task/ });
    expect(working.querySelector('[data-working-agents="1"]')).toBeInTheDocument();
    expect(working).toHaveAccessibleDescription('Agent processing');
    expect(working).not.toHaveAccessibleName(/processing/);
    const idle = screen.getByRole('option', { name: /Idle task/ });
    expect(idle.querySelector('[data-working-agents]')).not.toBeInTheDocument();
    expect(idle).not.toHaveAttribute('aria-describedby');
  });

  it('counts the working agents after an attention badge', () => {
    workspacesState.workspaces = [
      createWorkspace({
        id: 'mixed',
        customName: 'Mixed task',
        windowId: 'window-1',
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
    ];
    renderOpen();

    const row = screen.getByRole('option', { name: /Mixed task/ });
    expect(row).toHaveAccessibleDescription('2 agents processing');
    const glyph = row.querySelector('[data-working-agents="2"]');
    expect(glyph).toBeInTheDocument();
    // As in the sidebar and the Overview: the badge, then the spinner.
    expect(
      within(row).getByText('Done').compareDocumentPosition(glyph!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('hides the spinner when the activity spinner setting is off', () => {
    useConfigStore.setState({ config: { showAgentSpinner: false } as AppConfig });
    workspacesState.workspaces = [
      createWorkspace({
        id: 'working',
        customName: 'Working task',
        windowId: 'window-1',
        agentActive: true,
        terminals: [createTerminal({ status: 'running', agentActive: true })],
      }),
    ];
    renderOpen();

    const working = screen.getByRole('option', { name: /Working task/ });
    expect(working.querySelector('[data-working-agents]')).not.toBeInTheDocument();
    expect(working).not.toHaveAttribute('aria-describedby');
  });

  it('moves the workspace here when its window cannot be brought forward', async () => {
    vi.mocked(window.api.focusWorkspaceWindow).mockResolvedValue(false);
    workspacesState.workspaces = [
      createWorkspace({ id: 'orphan', customName: 'Orphan', windowId: 'window-2' }),
    ];
    const { input } = renderOpen();

    fireEvent.change(input, { target: { value: 'orphan' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(workspacesState.selectWorkspace).toHaveBeenCalledWith('orphan'));
    expect(workspacesState.moveWorkspaceToWindow).toHaveBeenCalledWith('orphan', 'window-1');
  });

  it('restores a trashed workspace, then opens it', async () => {
    workspacesState.workspaces = [
      createWorkspace({ id: 'running', windowId: 'window-1', terminals: [createTerminal()] }),
      createWorkspace({ id: 'trashed', customName: 'Old spike', status: 'trashed' }),
    ];
    const { input } = renderOpen();

    fireEvent.change(input, { target: { value: 'spike' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(workspacesState.selectWorkspace).toHaveBeenCalledWith('trashed'));
    expect(workspacesState.setWorkspaceTrashed).toHaveBeenCalledWith('trashed', false);
    expect(window.api.focusWorkspaceWindow).not.toHaveBeenCalled();
  });

  it('runs a command picked by name', () => {
    const newTerminal = vi.fn();
    const unregister = registerShortcutAction('terminal.new', newTerminal);
    workspacesState.selectedWorkspaceId = 'current';
    workspacesState.workspaces = [createWorkspace({ id: 'current', windowId: 'window-1' })];
    const { onOpenChange, input } = renderOpen();

    fireEvent.change(input, { target: { value: '>terminal tab' } });
    expect(screen.getByRole('option', { name: 'New terminal tab' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(newTerminal).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('keeps Escape from reaching the app behind the dialog', () => {
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    const { onOpenChange, input } = renderOpen();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(appEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appEscape);
  });
  it('keeps the highlighted workspace when the list re-sorts under it', async () => {
    workspacesState.workspaces = [
      createWorkspace({
        id: 'recent',
        customName: 'Task one',
        windowId: 'window-1',
        lastActivityAt: 900,
      }),
      createWorkspace({
        id: 'older',
        customName: 'Task two',
        windowId: 'window-1',
        lastActivityAt: 100,
      }),
    ];
    const { input, refresh } = renderOpen();
    fireEvent.change(input, { target: { value: 'task' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Another agent finishes its turn and moves to the top.
    workspacesState.workspaces = [
      ...workspacesState.workspaces,
      createWorkspace({
        id: 'finished',
        customName: 'Task three',
        windowId: 'window-1',
        attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1 },
      }),
    ];
    refresh();
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(workspacesState.selectWorkspace).toHaveBeenCalledWith('older'));
  });

  // Scrolling while the dialog opens forced an extra style pass over the whole app.
  it('opens at the top result without scrolling, then keeps the highlight in view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    workspacesState.workspaces = [
      createWorkspace({ id: 'first', windowId: 'window-1', lastActivityAt: 900 }),
      createWorkspace({ id: 'second', windowId: 'window-1', lastActivityAt: 100 }),
    ];
    const { input } = renderOpen();
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(scrollIntoView.mock.contexts.map((option) => (option as Element).id)).toEqual([
      input.getAttribute('aria-controls') + '-option-1',
      input.getAttribute('aria-controls') + '-option-0',
    ]);
  });

  it('runs a pick once even when Enter repeats while the dialog closes', () => {
    const newTerminal = vi.fn();
    const unregister = registerShortcutAction('terminal.new', newTerminal);
    workspacesState.selectedWorkspaceId = 'current';
    workspacesState.workspaces = [createWorkspace({ id: 'current', windowId: 'window-1' })];
    const { input } = renderOpen();

    fireEvent.change(input, { target: { value: '>terminal tab' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(newTerminal).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('leaves Enter and arrows to an input method while it composes text', () => {
    workspacesState.workspaces = [createWorkspace({ id: 'only', windowId: 'window-1' })];
    const { onOpenChange, input } = renderOpen();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(workspacesState.selectWorkspace).not.toHaveBeenCalled();
  });

  it('gives focus back when the picked workspace is the one already open', async () => {
    workspacesState.selectedWorkspaceId = 'current';
    workspacesState.workspaces = [
      createWorkspace({ id: 'current', customName: 'Current task', windowId: 'window-1' }),
    ];
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <textarea aria-label="Terminal input" />
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <CommandCenterDialog
            open={open}
            mode="workspaces"
            session={0}
            onOpenChange={setOpen}
            onModeChange={vi.fn()}
          />
        </>
      );
    }
    render(<Harness />);
    const terminal = screen.getByLabelText('Terminal input');
    terminal.focus();
    fireEvent.click(screen.getByText('Open'));

    // The open workspace is left out of Recent, so it's searched for.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'current' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    await waitFor(() => expect(terminal).toHaveFocus());
  });

  it('opens on workspaces needing attention, then actions, then recent workspaces', () => {
    workspacesState.selectedWorkspaceId = 'current';
    workspacesState.workspaces = [
      createWorkspace({ id: 'current', customName: 'Open task', windowId: 'window-1' }),
      createWorkspace({ id: 'recent', customName: 'Recent task', windowId: 'window-1' }),
      createWorkspace({
        id: 'waiting',
        customName: 'Waiting task',
        windowId: 'window-1',
        attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1 },
      }),
    ];
    const { input, onOpenChange } = renderOpen();

    const groups = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-labelledby'));
    expect(groups.map((id) => document.getElementById(id!)?.textContent)).toEqual([
      'Needs attention',
      'Actions',
      'Recent',
    ]);
    expect(screen.getByRole('option', { name: /^Settings/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Open task/ })).not.toBeInTheDocument();

    // Enter opens the workspace waiting on the user.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    return waitFor(() => expect(workspacesState.selectWorkspace).toHaveBeenCalledWith('waiting'));
  });

  it('lists the projects to start a workspace in, and goes back with Backspace', () => {
    projectsState.projects = [
      createProject({ id: 'proj-api', name: 'api' }),
      createProject({ id: 'proj-web', name: 'web' }),
    ];
    const newWorkspace = vi.fn();
    window.addEventListener('open-new-workspace-dialog', newWorkspace);
    const { input, onOpenChange } = renderOpen();

    fireEvent.click(screen.getByRole('option', { name: 'New workspace in...' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('placeholder', 'Search projects...');
    expect(optionNames()).toEqual(['api', 'web']);

    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(input).toHaveAttribute('placeholder', 'Search workspaces and commands');

    fireEvent.click(screen.getByRole('option', { name: 'New workspace in...' }));
    fireEvent.change(input, { target: { value: 'web' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((newWorkspace.mock.calls[0][0] as CustomEvent).detail).toEqual({
      projectId: 'proj-web',
    });
    window.removeEventListener('open-new-workspace-dialog', newWorkspace);
  });

  it('offers workspace commands only when they can act on the open workspace', () => {
    const unregister = [
      registerShortcutAction('workspace.new', vi.fn()),
      registerShortcutAction('workspace.stop', vi.fn()),
      registerShortcutAction('diff.toggle', vi.fn()),
    ];
    workspacesState.workspaces = [
      createWorkspace({ id: 'folder', windowId: 'window-1', isWorktree: false }),
    ];
    const { input, refresh } = renderOpen();
    fireEvent.change(input, { target: { value: '>' } });

    expect(optionNames()).toContain('New workspace');
    expect(optionNames()).not.toContain('Stop workspace');

    workspacesState.selectedWorkspaceId = 'folder';
    refresh();
    expect(optionNames()).toContain('Stop workspace');
    // A plain folder has no diff to show.
    expect(optionNames()).not.toContain('Toggle diff viewer');
    unregister.forEach((dispose) => dispose());
  });

  it('shows only No results when nothing matches and no workspace is open to search', () => {
    const { input } = renderOpen();
    fireEvent.change(input, { target: { value: 'zzqx' } });

    expect(screen.getByText('No results', { selector: 'p:not([aria-live])' })).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});

describe('CommandCenterDialog file search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCommandCenterStore.setState({
      open: false,
      mode: 'workspaces',
      fileMode: 'files',
      session: 0,
    });
    window.api = {
      focusWorkspaceWindow: vi.fn(async () => true),
      copyToClipboard: vi.fn(),
    } as unknown as typeof window.api;
    projectsState.projects = [];
    useConfigStore.setState({ config: null });
    shortcutsState.matchesEvent = () => false;
    searchMocks.fileState.filteredFiles = [];
    searchMocks.fileState.loading = false;
    searchMocks.fileState.selectedIndex = 0;
    searchMocks.contentState.results = [];
    searchMocks.contentState.loading = false;
    useFileViewerStore.setState({
      filePickerQueryByWorkspace: {},
      fileViewerWorkspaceId: null,
      inlineFilePreviewByWorkspace: {},
    });
    selectFolderWorkspace();
  });

  it('switches between workspaces, files and content with the mode toggle', () => {
    renderOpen();

    expect(screen.getByRole('radio', { name: 'Workspaces' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    expect(screen.getByRole('radio', { name: 'Files' })).toBeChecked();
    expect(screen.getByPlaceholderText('Search files...')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Content' }));
    expect(screen.getByPlaceholderText('Search in files...')).toBeInTheDocument();
  });

  it('cycles the modes with Tab and back with Shift+Tab', () => {
    const { input } = renderOpen();

    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('radio', { name: 'Files' })).toBeChecked();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('radio', { name: 'Content' })).toBeChecked();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('radio', { name: 'Workspaces' })).toBeChecked();
  });

  it('leaves Shift+Tab to move focus to the controls beside the input', () => {
    const { input } = renderOpen('files');
    input.focus();

    // The dialog's focus trap wraps it round to the mode control.
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });

    expect(screen.getByRole('radio', { name: 'Files' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Files' })).toHaveFocus();
  });

  it('keeps the query when the mode changes', () => {
    const { input } = renderOpen();

    fireEvent.change(input, { target: { value: 'helpers' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(screen.getByRole('combobox')).toHaveValue('helpers');
  });

  it('goes back to workspaces on the command center shortcut, then closes on the next', () => {
    shortcutsState.matchesEvent = (action, event) =>
      action === 'commandCenter.open' && event.key === 'p' && event.metaKey;
    const { onOpenChange, input } = renderOpen('files');

    fireEvent.keyDown(input, { key: 'p', metaKey: true });
    expect(screen.getByRole('radio', { name: 'Workspaces' })).toBeChecked();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'p', metaKey: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers file search only once a workspace is open', () => {
    workspacesState.selectedWorkspaceId = null;
    const { input } = renderOpen('files');

    expect(screen.getByRole('radio', { name: 'Workspaces' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Files' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Content' })).toBeDisabled();
    // With nothing to switch to, Tab moves focus as usual.
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(screen.getByRole('radio', { name: 'Workspaces' })).toBeChecked();
  });

  it('can open a file after the Search files command reopens it on file search', () => {
    registerShortcutAction('file.open', () => useCommandCenterStore.getState().toggle('files'));
    useFileViewerStore.setState({ filePickerQueryByWorkspace: { current: 'helpers' } });
    searchMocks.fileState.filteredFiles = [{ path: 'src/helpers.ts' }];
    useCommandCenterStore.getState().toggle('workspaces');
    renderWithStore();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '>search files' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(screen.getByRole('radio', { name: 'Files' })).toBeChecked();
    expect(screen.getByRole('combobox')).toHaveValue('helpers');

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.current).toMatchObject({
      filePath: 'src/helpers.ts',
    });
  });

  it('offers to search the open workspace for a query nothing else matches', () => {
    workspacesState.workspaces[0] = { ...workspacesState.workspaces[0], customName: 'Login fix' };
    const { onOpenChange, input } = renderOpen();
    fireEvent.change(input, { target: { value: 'zzqx' } });

    expect(screen.getByText('No results', { selector: 'p:not([aria-live])' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Search in Login fix' })).toBeInTheDocument();
    expect(optionNames()).toEqual(['Search files for "zzqx"Tab', 'Search contents for "zzqx"']);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Files' })).toBeChecked();
    expect(screen.getByRole('combobox')).toHaveValue('zzqx');
    expect(useFileViewerStore.getState().filePickerQueryByWorkspace.current).toBe('zzqx');
  });

  it('searches file contents for the query from its offer', () => {
    const { input } = renderOpen();
    fireEvent.change(input, { target: { value: 'zzqx' } });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByRole('radio', { name: 'Content' })).toBeChecked();
    expect(screen.getByRole('combobox')).toHaveValue('zzqx');
  });

  it('offers no file search for a commands-only query', () => {
    const { input } = renderOpen();
    fireEvent.change(input, { target: { value: '>zzqx' } });

    expect(screen.getByText('No results', { selector: 'p:not([aria-live])' })).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('switches to content search from its action, keeping the dialog open', () => {
    const { onOpenChange, input } = renderOpen();

    fireEvent.change(input, { target: { value: '>search in files' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Content' })).toBeChecked();
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('starts file search from the remembered query when its shortcut switches to it', () => {
    useFileViewerStore.setState({ filePickerQueryByWorkspace: { current: 'helpers' } });
    useCommandCenterStore.getState().toggle('workspaces');
    renderWithStore();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fix' } });

    act(() => useCommandCenterStore.getState().toggle('files'));

    expect(screen.getByRole('combobox')).toHaveValue('helpers');
  });

  it('scrolls back to the top result when the query changes', () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    searchMocks.fileState.filteredFiles = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }];
    const { input } = renderOpen('files');
    scrollTo.mockClear();

    fireEvent.change(input, { target: { value: 'b' } });

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('searches an SSH workspace by file contents too', () => {
    selectFolderWorkspace({
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      backend: { kind: 'ssh', hostId: 'ssh-dev' } as Workspace['backend'],
    });
    renderOpen('content');

    expect(screen.getByRole('radio', { name: 'Content' })).toBeChecked();
  });

  it('opens the picked file in the file viewer, or beside the terminals with Shift', () => {
    useConfigStore.setState({ config: { defaultSearchOpenMode: 'viewer' } as AppConfig });
    searchMocks.fileState.filteredFiles = [{ path: 'src/a.ts' }];
    const { onOpenChange, input } = renderOpen('files');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useFileViewerStore.getState()).toMatchObject({
      fileViewerWorkspaceId: 'current',
      fileViewerInitialFilePath: 'src/a.ts',
    });
  });

  it('opens a content match beside the terminals at its line with Shift+Enter', () => {
    useConfigStore.setState({ config: { defaultSearchOpenMode: 'viewer' } as AppConfig });
    searchMocks.contentState.results = [
      { path: 'src/app.ts', lineNumber: 3, lineContent: 'const app = 1;', matches: [] },
    ];
    const { input } = renderOpen('content');

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.current).toMatchObject({
      open: true,
      filePath: 'src/app.ts',
      lineNumber: 3,
    });
  });

  it('opens a content match in a tab of its own at its line with Cmd+Enter', () => {
    searchMocks.contentState.results = [
      { path: 'src/app.ts', lineNumber: 3, lineContent: 'const app = 1;', matches: [] },
    ];
    const { onOpenChange, input } = renderOpen('content');

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(paneMocks.openFilePane).toHaveBeenCalledWith(
      'current',
      'src/app.ts',
      { kind: 'tab' },
      3
    );
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.current).toBeUndefined();
  });

  it('copies the highlighted file as an @path', () => {
    searchMocks.fileState.filteredFiles = [{ path: 'src/a.ts' }];
    const { onOpenChange, input } = renderOpen('files');

    fireEvent.keyDown(input, { key: 'C', metaKey: true, shiftKey: true });

    expect(window.api.copyToClipboard).toHaveBeenCalledWith('@src/a.ts ');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('starts file search from the query last searched in the workspace', () => {
    useFileViewerStore.setState({ filePickerQueryByWorkspace: { current: 'helpers' } });
    const { input } = renderOpen('files');
    expect(input).toHaveValue('helpers');

    fireEvent.change(input, { target: { value: 'utils' } });

    expect(useFileViewerStore.getState().getFilePickerQuery('current')).toBe('utils');
  });

  it('keeps the previous results on screen while a new search runs', () => {
    searchMocks.contentState.results = [
      { path: 'src/app.ts', lineNumber: 3, lineContent: 'const app = 1;', matches: [] },
    ];
    searchMocks.contentState.loading = true;
    renderOpen('content');

    expect(screen.getByText('app.ts')).toBeInTheDocument();
    expect(screen.queryByText('Searching...')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Searching' })).toBeInTheDocument();
  });

  it('shows a loading message when there is nothing to show yet', () => {
    searchMocks.fileState.loading = true;
    renderOpen('files');

    expect(screen.getByText('Loading files...')).toBeInTheDocument();
  });

  it('marks the highlighted file as the active option', () => {
    searchMocks.fileState.filteredFiles = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }];
    searchMocks.fileState.selectedIndex = 1;
    const { input } = renderOpen('files');

    const selected = screen.getByRole('option', { name: /b\.ts/ });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(selected).toHaveClass('bg-accent');
    expect(screen.getByRole('option', { name: /a\.ts/ })).toHaveAttribute('aria-selected', 'false');
    expect(input).toHaveAttribute('aria-activedescendant', selected.id);
  });
});
